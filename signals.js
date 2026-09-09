// signals.js

const { execAsync, execPowerShell, PLATFORM, commandExists } = require('./core');
const fs = require('fs/promises');
const path = require('path');

const WIN_BATTERY_COMMAND = `
$ErrorActionPreference='Stop';
try{
  $b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1;
  if ($b -eq $null) { Write-Output "{}" }
  else {
    @{status=$b.BatteryStatus; charge=$b.EstimatedChargeRemaining} | ConvertTo-Json -Compress
  }
}catch{ Write-Output "{}" }
`.replace(/[\r\n]+/g, ' ');

const BATTERY_STATUS_ON_AC = 2;

async function winGetPowerStatus() {
  try {
    const output = await execPowerShell(WIN_BATTERY_COMMAND);
    const data = JSON.parse(output || '{}');
    const status = Number(data.status);
    const charge = Number(data.charge);
    return {
      onBattery: Number.isFinite(status) ? status !== BATTERY_STATUS_ON_AC : null,
      batteryPercent: Number.isFinite(charge) ? Math.min(100, Math.max(0, charge)) : null,
      hasBattery: Number.isFinite(status),
    };
  } catch {
    return null;
  }
}

async function macGetPowerStatus() {
  try {
    const { stdout } = await execAsync('pmset -g batt');
    const onBattery = /drawing from 'Battery Power'/i.test(stdout) ? true
      : /drawing from 'AC Power'/i.test(stdout) ? false : null;
    const percentMatch = stdout.match(/(\d{1,3})%/);
    const batteryPercent = percentMatch ? Math.min(100, Math.max(0, parseInt(percentMatch[1], 10))) : null;
    return { onBattery, batteryPercent, hasBattery: onBattery !== null || batteryPercent !== null };
  } catch {
    return null;
  }
}

const POWER_SUPPLY_BASE = '/sys/class/power_supply';

async function linuxGetPowerStatus() {
  try {
    const entries = await fs.readdir(POWER_SUPPLY_BASE).catch(() => []);
    let onBattery = null;
    let batteryPercent = null;
    for (const entry of entries) {
      const isAc = entry.startsWith('A');
      const isBat = entry.startsWith('BAT') || entry.startsWith('bat');
      if (!isAc && !isBat) continue;
      const devicePath = path.join(POWER_SUPPLY_BASE, entry);
      if (isAc && onBattery === null) {
        const onlineRaw = await fs.readFile(path.join(devicePath, 'online'), 'utf8').catch(() => null);
        if (onlineRaw !== null) onBattery = onlineRaw.trim() === '0';
      }
      if (isBat && batteryPercent === null) {
        const capacityRaw = await fs.readFile(path.join(devicePath, 'capacity'), 'utf8').catch(() => null);
        if (capacityRaw !== null) {
          const value = parseFloat(capacityRaw.trim());
          if (Number.isFinite(value)) batteryPercent = Math.min(100, Math.max(0, value));
        }
      }
      if (onBattery !== null && batteryPercent !== null) break;
    }
    if (onBattery === null && batteryPercent !== null) {
      onBattery = true;
    }
    if (onBattery === null && batteryPercent === null) return null;
    return { onBattery, batteryPercent, hasBattery: batteryPercent !== null };
  } catch {
    return null;
  }
}

const POWER_CACHE_TTL_MS = 60 * 1000;
let cachedPowerStatus = null;
let cachedPowerStatusAt = 0;
let cachedPowerStatusReady = false;
let powerStatusInFlight = null;

async function getPowerStatus() {
  const now = Date.now();
  if (cachedPowerStatusReady && (now - cachedPowerStatusAt) < POWER_CACHE_TTL_MS) {
    return cachedPowerStatus;
  }
  if (powerStatusInFlight) return powerStatusInFlight;
  powerStatusInFlight = (async () => {
    try {
      switch (PLATFORM) {
        case 'win32': return await winGetPowerStatus();
        case 'darwin': return await macGetPowerStatus();
        case 'linux': return await linuxGetPowerStatus();
        default: return null;
      }
    } catch {
      return null;
    }
  })();
  try {
    const result = await powerStatusInFlight;
    cachedPowerStatus = result;
    cachedPowerStatusAt = Date.now();
    cachedPowerStatusReady = true;
    return result;
  } finally {
    powerStatusInFlight = null;
  }
}



const WIN_NIGHT_LIGHT_KEY =
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current' +
  '\\default$windows.data.bluelightreduction.bluelightreductionstate\\windows.data.bluelightreduction.bluelightreductionstate';

const WIN_READ_COMMAND = `
$ErrorActionPreference='Stop';
try{
  $v = Get-ItemProperty -Path '${WIN_NIGHT_LIGHT_KEY}' -Name Data -ErrorAction Stop;
  $bytes = $v.Data -as [byte[]];
  Write-Output ($bytes[18].ToString());
}catch{ Write-Output "missing" }
`.replace(/[\r\n]+/g, ' ');

async function winGetNightLight() {
  try {
    const output = await execPowerShell(WIN_READ_COMMAND);
    const trimmed = String(output || '').trim();
    if (trimmed === 'missing') return false;
    const byteValue = parseInt(trimmed, 10);
    if (!Number.isFinite(byteValue)) return null;
    return (byteValue & 0x0F) !== 0;
  } catch {
    return null;
  }
}

async function macGetNightLight() {
  try {
    const { stdout } = await execAsync('nightlight status 2>/dev/null || nightlight');
    const normalized = String(stdout || '').toLowerCase();
    if (/on:\s*true|night shift on/.test(normalized)) return true;
    if (/on:\s*false|night shift off/.test(normalized)) return false;
    return null;
  } catch {
    return null;
  }
}

async function linuxGetNightLight() {
  try {
    const { stdout } = await execAsync(
      'gsettings get org.gnome.settings-daemon.plugins.color night-light-enabled 2>/dev/null'
    );
    if (/true/i.test(stdout)) return true;
    if (/false/i.test(stdout)) {
      return await isRedshiftishRunning();
    }
  } catch { /* no gsettings; fall through */ }
  return isRedshiftishRunning();
}

async function isRedshiftishRunning() {
  try {
    const { stdout } = await execAsync('pgrep -x "redshift|gammastep" || pgrep -f "redshift|gammastep" 2>/dev/null');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const NIGHT_LIGHT_CACHE_TTL_MS = 60 * 1000;
let cachedNightLight = null;
let cachedNightLightAt = 0;
let cachedNightLightReady = false;
let nightLightInFlight = null;

async function getNightLightState() {
  const now = Date.now();
  if (cachedNightLightReady && (now - cachedNightLightAt) < NIGHT_LIGHT_CACHE_TTL_MS) {
    return cachedNightLight;
  }
  if (nightLightInFlight) return nightLightInFlight;
  nightLightInFlight = (async () => {
    try {
      switch (PLATFORM) {
        case 'win32': return await winGetNightLight();
        case 'darwin': return await macGetNightLight();
        case 'linux': return await linuxGetNightLight();
        default: return null;
      }
    } catch {
      return null;
    }
  })();
  try {
    const result = await nightLightInFlight;
    cachedNightLight = result;
    cachedNightLightAt = Date.now();
    cachedNightLightReady = true;
    return result;
  } finally {
    nightLightInFlight = null;
  }
}



let resolvedAvailability;
let cachedIioDevicePath;

const WIN_READ_LUX_COMMAND = `
$ErrorActionPreference='Stop';
try{
  [Windows.Devices.Sensors.LightSensor,Windows.Devices.Sensors,ContentType=WindowsRuntime] | Out-Null;
  $s = [Windows.Devices.Sensors.LightSensor]::GetDefault();
  if ($s -eq $null) { Write-Output "{}" }
  else {
    $r = $s.GetCurrentReading();
    if ($r -eq $null) { Write-Output "{}" }
    else { @{lux=$r.IlluminanceInLux} | ConvertTo-Json -Compress }
  }
}catch{ Write-Output "{}" }
`.replace(/[\r\n]+/g, ' ');

async function winReadLux() {
  const output = await execPowerShell(WIN_READ_LUX_COMMAND);
  const data = JSON.parse(output || '{}');
  return Number.isFinite(data.lux) ? data.lux : null;
}

const IIO_BASE = '/sys/bus/iio/devices';
const IIO_CHANNEL_CANDIDATES = [
  { file: 'in_illuminance_input', kind: 'input' },
  { file: 'in_illuminance_raw', kind: 'raw' },
  { file: 'in_illuminance0_input', kind: 'input' },
  { file: 'in_illuminance0_raw', kind: 'raw' },
  { file: 'in_illuminance_mean', kind: 'raw' },
  { file: 'in_illuminance_mean_raw', kind: 'raw' },
];

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findIioLightDevice() {
  if (cachedIioDevicePath && await fileExists(cachedIioDevicePath)) return cachedIioDevicePath;
  try {
    const entries = await fs.readdir(IIO_BASE);
    for (const entry of entries) {
      const devicePath = path.join(IIO_BASE, entry);
      for (const channel of IIO_CHANNEL_CANDIDATES) {
        if (await fileExists(path.join(devicePath, channel.file))) {
          cachedIioDevicePath = devicePath;
          return devicePath;
        }
      }
    }
  } catch {
  }
  cachedIioDevicePath = null;
  return null;
}

async function linuxReadLux() {
  const devicePath = await findIioLightDevice();
  if (!devicePath) return null;

  try {
    for (const channel of IIO_CHANNEL_CANDIDATES) {
      const channelPath = path.join(devicePath, channel.file);
      if (!(await fileExists(channelPath))) continue;
      const rawValue = parseFloat((await fs.readFile(channelPath, 'utf8')).trim());
      if (!Number.isFinite(rawValue)) continue;

      if (channel.kind === 'input') return rawValue;

      let scale = 1;
      const scaleFile = channel.file.replace(/_raw$/, '_scale');
      if (scaleFile !== channel.file && await fileExists(path.join(devicePath, scaleFile))) {
        const scaleRaw = parseFloat((await fs.readFile(path.join(devicePath, scaleFile), 'utf8')).trim());
        if (Number.isFinite(scaleRaw)) scale = scaleRaw;
      } else {
        const legacyScalePath = path.join(devicePath, 'in_illuminance_scale');
        if (await fileExists(legacyScalePath)) {
          const scaleRaw = parseFloat((await fs.readFile(legacyScalePath, 'utf8')).trim());
          if (Number.isFinite(scaleRaw)) scale = scaleRaw;
        }
      }
      return rawValue * scale;
    }
    cachedIioDevicePath = null;
    return null;
  } catch {
    return null;
  }
}

async function macReadLux() {
  try {
    const { stdout } = await execAsync('ioreg -r -k AppleALSSensorValue -d1 -c AppleLMUController');
    const match = stdout.match(/AppleALSSensorValue"\s*=\s*\(?\s*(\d+)/);
    if (match) return parseFloat(match[1]);
  } catch { /* fall through to non-LMU sensor probe */ }
  try {
    const { stdout } = await execAsync('ioreg -r -k ALSBoolValue1 -d1');
    const match = stdout.match(/AppleALSSensorValue"\s*=\s*\(?\s*(\d+)/);
    if (match) return parseFloat(match[1]);
    const ambient = stdout.match(/"ALS[A-Za-z]*Ambient[A-Za-z]*"\s*=\s*\(?\s*(\d+)/);
    if (ambient) return parseFloat(ambient[1]);
  } catch { /* no ALS */ }
  return null;
}

async function readAmbientLightLux() {
  try {
    switch (PLATFORM) {
      case 'win32': return await winReadLux();
      case 'linux': return await linuxReadLux();
      case 'darwin': return await macReadLux();
      default: return null;
    }
  } catch {
    return null;
  }
}

let resolvedAvailabilityCheckedAt = 0;
const ALS_AVAILABILITY_TTL_MS = 10 * 60 * 1000;

async function hasAmbientLightSensor() {
  const now = Date.now();
  if (resolvedAvailability !== undefined && (now - resolvedAvailabilityCheckedAt) < ALS_AVAILABILITY_TTL_MS) {
    return resolvedAvailability;
  }
  const lux = await readAmbientLightLux();
  resolvedAvailability = lux !== null;
  resolvedAvailabilityCheckedAt = now;
  return resolvedAvailability;
}


const os = require('os');

let cachedProfile = null;

function detectDeviceProfile() {
  if (cachedProfile) return cachedProfile;

  let cores = 0;
  let speedMHz = 0;
  try {
    const cpus = os.cpus();
    cores = cpus.length;
    for (const cpu of cpus) {
      if (cpu.speed > speedMHz) speedMHz = cpu.speed;
    }
  } catch { /* keep zeros */ }

  let totalMemGB = 0;
  try {
    totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
  } catch { /* keep 0 */ }

  let arch = '';
  try {
    arch = os.arch();
  } catch { /* keep empty */ }
  const isArm = arch === 'arm64';

  const weak = isArm
    ? (cores > 0 && cores <= 2 && totalMemGB > 0 && totalMemGB <= 4)
    : (cores > 0 && cores <= 2) ||
      (speedMHz > 0 && speedMHz < 2000) ||
      (totalMemGB > 0 && totalMemGB <= 4);

  cachedProfile = {
    weak,
    cores,
    speedMHz,
    totalMemGB: Math.round(totalMemGB * 10) / 10,
    arch,
    isArm,
  };
  return cachedProfile;
}


const activeWindow = require('active-win');

const CACHE_TTL_MS = 2000;
let cachedInfo = null;
let cachedAt = 0;

async function getActiveWindowInfo() {
  const now = Date.now();
  if (cachedInfo && now - cachedAt < CACHE_TTL_MS) return cachedInfo;
  try {
    const window = await activeWindow({
        accessibilityPermission: false
    });
    if (!window) return null;
    cachedInfo = {
      name: window.owner?.name ?? null,
      path: window.owner?.path ?? null,
      title: typeof window.title === 'string' ? window.title.slice(0, 120) : null,
      bounds: window.bounds ?? null,
    };
    cachedAt = now;
    return cachedInfo;
  } catch (error) {
    console.error('Failed to get active window:', error.message);
    return null;
  }
}

async function getCurrentWindow() {
  const info = await getActiveWindowInfo();
  return info ? info.name : null;
}


const { desktopCapturer, screen } = require('electron');
const sharp = require('sharp');

const RESIZE_WIDTH = Number(process.env.SCREENSHOT_RESIZE_WIDTH) || 200;

function pickPrimarySource(sources) {
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  try {
    const primaryDisplayId = String(screen.getPrimaryDisplay().id);
    const match = sources.find(source => String(source.display_id) === primaryDisplayId);
    if (match) return match;
  } catch (err) {
  }

  return sources.find(source => source.display_id) || sources[0];
}

async function screenAvgBrightness() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: RESIZE_WIDTH, height: RESIZE_WIDTH } 
    });

    const primaryScreenSource = pickPrimarySource(sources);

    if (!primaryScreenSource) {
      console.warn('No screen sources found.');
      return null;
    }

    const image = primaryScreenSource.thumbnail;
    const size = image.getSize();
    const rawBuffer = image.toBitmap();

    if (!rawBuffer || rawBuffer.length === 0) {
      console.error('Empty thumbnail buffer.');
      return null;
    }

    const fullStats = await sharp(rawBuffer, {
        raw: { width: size.width, height: size.height, channels: 4 }
    }).stats();

    const bMean = fullStats.channels[0].mean;
    const gMean = fullStats.channels[1].mean;
    const rMean = fullStats.channels[2].mean;

    const avg = (rMean + gMean + bMean) / 3;

    return Math.round((avg / 255 * 100) * 100) / 100;

  } catch (err) {
    console.error('Error processing screenshot:', err);
    return null;
  }
}


const winCandidateStatus = new Map();

const WIN_GET_CMD_WMI = 'powershell.exe -NoProfile -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness"';
const WIN_SET_CMD_WMI = (val) => `powershell.exe -NoProfile -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${val})"`;

function winUnsupportedError() {
  return new Error(
    'No brightness backend available on Windows: WMI/CIM require an internal laptop display ' +
    '(not available on external/desktop monitors), and DDC/CI reported no controllable monitor. ' +
    'On desktop PCs use the monitor OSD buttons, or install a DDC/CI-capable monitor.'
  );
}

async function winGetWmi() {
  const { stdout } = await execAsync(WIN_GET_CMD_WMI);
  const value = parseInt(stdout.trim(), 10);
  if (!Number.isInteger(value)) {
    throw new Error('WMI returned no brightness value (this display may not support WMI brightness control - common on external/desktop monitors).');
  }
  return value;
}

async function winGetCim(instance) {
  let cmd = 'powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness"';
  if (instance) {
    const escaped = instance.replace(/'/g, "''");
    cmd = `powershell.exe -NoProfile -Command "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Where-Object { $_.InstanceName -like '*${escaped}*' } | Select-Object -First 1 -ExpandProperty CurrentBrightness"`;
  }
  const { stdout } = await execAsync(cmd);
  const lines = String(stdout || '').trim().split(/\s+/).map(Number).filter(Number.isInteger);
  const value = lines.length > 0 ? lines[0] : NaN;
  if (!Number.isInteger(value)) {
    throw new Error('CIM returned no brightness value (this display may not support WMI brightness control - common on external/desktop monitors).');
  }
  return value;
}

async function winSetCimInstance(clamped, instance) {
  if (!instance) {
    await execAsync(`powershell.exe -NoProfile -Command "Invoke-CimMethod -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=${clamped}}"`);
    return;
  }
  const escaped = instance.replace(/'/g, "''");
  await execAsync(
    `powershell.exe -NoProfile -Command "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Where-Object { $_.InstanceName -like '*${escaped}*' } | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=${clamped}}"`
  );
}

const WIN_DDC_LIST_COMMAND = `
$ErrorActionPreference='Stop';
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ABMon {
  public delegate bool EnumProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr d);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr a, IntPtr b, EnumProc c, IntPtr d);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, ref uint n);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] ms);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool GetMonitorBrightness(IntPtr h, ref uint min, ref uint cur, ref uint max);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string desc; }
}
"@;
$cb = [ABMon+EnumProc]{
  param($h, $dc, $r, $d)
  $n = [uint32]0
  if (([ABMon]::GetNumberOfPhysicalMonitorsFromHMONITOR($h, [ref]$n)) -and ($n -gt 0)) {
    $arr = New-Object 'ABMon+PHYSICAL_MONITOR[]' $n
    if ([ABMon]::GetPhysicalMonitorsFromHMONITOR($h, $n, $arr)) {
      foreach ($m in $arr) {
        $mn=[uint32]0; $mc=[uint32]0; $mx=[uint32]0
        $ok = [ABMon]::GetMonitorBrightness($m.hPhysicalMonitor, [ref]$mn, [ref]$mc, [ref]$mx)
        [Console]::WriteLine("ABMON|$($m.desc)|$ok|$mn|$mc|$mx")
      }
    }
  }
  return $true
};
[void][ABMon]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $cb, [IntPtr]::Zero);
[Console]::WriteLine("ABDONE")
`.replace(/[\r\n]+/g, ' ');

function winDdcSetCommand(index, value) {
  return `
$ErrorActionPreference='Stop';
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ABMonSet {
  public delegate bool EnumProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr d);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr a, IntPtr b, EnumProc c, IntPtr d);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, ref uint n);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] ms);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] ms);
  [DllImport("dxva2.dll", SetLastError=true)] public static extern bool SetMonitorBrightness(IntPtr h, uint v);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string desc; }
}
"@;
$script:abIdx = 0; $script:abTarget = ${index}; $script:abValue = [uint32]${value};
$cb = [ABMonSet+EnumProc]{
  param($h, $dc, $r, $d)
  $n = [uint32]0
  if (([ABMonSet]::GetNumberOfPhysicalMonitorsFromHMONITOR($h, [ref]$n)) -and ($n -gt 0)) {
    $arr = New-Object 'ABMonSet+PHYSICAL_MONITOR[]' $n
    if ([ABMonSet]::GetPhysicalMonitorsFromHMONITOR($h, $n, $arr)) {
      for ($i = 0; $i -lt $n; $i++) {
        if ($script:abIdx -eq $script:abTarget) {
          if (-not [ABMonSet]::SetMonitorBrightness($arr[$i].hPhysicalMonitor, $script:abValue)) { throw "SetMonitorBrightness failed" }
        }
        $script:abIdx++
      }
      $one = New-Object 'ABMonSet+PHYSICAL_MONITOR[]' 1
      $one[0] = $arr[0]
      [void][ABMonSet]::DestroyPhysicalMonitors(1, $one)
    }
  }
  return $true
};
[void][ABMonSet]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $cb, [IntPtr]::Zero)
`.replace(/[\r\n]+/g, ' ');
}

let cachedWinDdcMonitors = null;
let cachedWinDdcAt = 0;
const WIN_DDC_CACHE_TTL_MS = 5 * 60 * 1000;

async function winListDdcMonitors() {
  const now = Date.now();
  if (cachedWinDdcMonitors && (now - cachedWinDdcAt) < WIN_DDC_CACHE_TTL_MS) return cachedWinDdcMonitors;
  try {
    const output = await execPowerShell(WIN_DDC_LIST_COMMAND, 15000);
    const monitors = [];
    for (const line of String(output || '').split(/\r?\n/)) {
      const m = line.match(/^ABMON\|([^|]*)\|(True|False)\|(\d+)\|(\d+)\|(\d+)\s*$/);
      if (!m) continue;
      const [, desc, ok, min, cur, max] = m;
      monitors.push({
        id: String(monitors.length),
        name: (desc || 'External monitor').trim() || 'External monitor',
        controllable: ok === 'True',
        min: Number(min), current: Number(cur), max: Number(max),
      });
    }
    cachedWinDdcMonitors = monitors;
    cachedWinDdcAt = Date.now();
    return monitors;
  } catch {
    return [];
  }
}

async function winGetDdc() {
  const monitors = await winListDdcMonitors();
  const controllable = monitors.find(m => m.controllable);
  if (!controllable) throw new Error('DDC/CI: no controllable monitor found (monitor may not support DDC/CI brightness).');
  const range = controllable.max - controllable.min;
  if (range <= 0) return Math.min(100, Math.max(0, controllable.current));
  return Math.round(((controllable.current - controllable.min) / range) * 100);
}

async function winSetDdc(clamped, display) {
  const monitors = await winListDdcMonitors();
  const targets = display === 'all' || display == null
    ? monitors.map((_, i) => i)
    : [Number(display)].filter(i => Number.isInteger(i) && i >= 0 && i < monitors.length);
  if (targets.length === 0) throw new Error('DDC/CI: requested display not found.');
  for (const index of targets) {
    const m = monitors[index];
    const range = m.max - m.min;
    const raw = range > 0 ? Math.round(m.min + (clamped / 100) * range) : clamped;
    await execPowerShell(winDdcSetCommand(index, Math.min(m.max || 100, Math.max(m.min || 0, raw))), 15000);
  }
}

async function winListWmiInstances() {
  try {
    const { stdout } = await execAsync(
      'powershell.exe -NoProfile -Command "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -ExpandProperty InstanceName"'
    );
    return String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function winGet() {
  if (winCandidateStatus.get('wmi') === 'ok') return winGetWmi();
  if (winCandidateStatus.get('cim') === 'ok') return winGetCim();
  if (winCandidateStatus.get('ddc') === 'ok') return winGetDdc();
  const unprobed = ['wmi', 'cim', 'ddc'].filter(id => !winCandidateStatus.has(id));
  if (unprobed.length === 0) throw winUnsupportedError();
  const fns = { wmi: () => winGetWmi(), cim: () => winGetCim(), ddc: () => winGetDdc() };
  for (const id of unprobed) {
    try {
      const value = await fns[id]();
      winCandidateStatus.set(id, 'ok');
      return value;
    } catch {
      winCandidateStatus.set(id, 'fail');
    }
  }
  throw winUnsupportedError();
}

async function winSet(value, opts = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid brightness value: ${value}`);
  }
  const clamped = Math.min(100, Math.max(0, Math.round(numeric)));
  const display = opts.display ?? 'all';
  if (winCandidateStatus.get('wmi') === 'ok') {
    await execAsync(WIN_SET_CMD_WMI(clamped));
    return;
  }
  if (winCandidateStatus.get('cim') === 'ok') {
    await winSetCimInstance(clamped, display === 'all' ? null : display);
    return;
  }
  if (winCandidateStatus.get('ddc') === 'ok') {
    await winSetDdc(clamped, display);
    return;
  }
  const unprobed = ['wmi', 'cim', 'ddc'].filter(id => !winCandidateStatus.has(id));
  if (unprobed.length === 0) throw winUnsupportedError();
  for (const id of unprobed) {
    try {
      if (id === 'wmi') await execAsync(WIN_SET_CMD_WMI(clamped));
      else if (id === 'cim') await winSetCimInstance(clamped, display === 'all' ? null : display);
      else await winSetDdc(clamped, display);
      winCandidateStatus.set(id, 'ok');
      return;
    } catch {
      winCandidateStatus.set(id, 'fail');
    }
  }
  throw winUnsupportedError();
}

async function winSetWmi(clamped) {
  await execAsync(WIN_SET_CMD_WMI(clamped));
}

async function winSetCim(clamped) {
  await execAsync(WIN_SET_CMD_CIM(clamped));
}

const macCandidateStatus = new Map();

async function resolveMacBackend(preferred) {
  const chain = [
    {
      type: 'brightness',
      probe: async () => {
        for (const bin of ['/opt/homebrew/bin/brightness', '/usr/local/bin/brightness', 'brightness']) {
          try { await execAsync(`${bin} -l`); return { type: 'brightness', bin }; } catch { /* next */ }
        }
        return null;
      },
    },
    {
      type: 'm1ddc',
      probe: async () => {
        for (const bin of ['/opt/homebrew/bin/m1ddc', '/usr/local/bin/m1ddc', 'm1ddc']) {
          try { await execAsync(`${bin} get luminance`); return { type: 'm1ddc', bin }; } catch { /* next */ }
        }
        return null;
      },
    },
    {
      type: 'ddcctl',
      probe: async () => {
        for (const bin of ['/opt/homebrew/bin/ddcctl', '/usr/local/bin/ddcctl', 'ddcctl']) {
          try { await execAsync(`${bin} -d 1 -b ?`); return { type: 'ddcctl', bin }; } catch { /* next */ }
        }
        return null;
      },
    },
  ];
  const ordered = preferred ? [...chain.filter(c => c.type === preferred), ...chain.filter(c => c.type !== preferred)] : chain;
  for (const entry of ordered) {
    const status = macCandidateStatus.get(entry.type);
    if (status === 'fail') continue;
    if (status && status.bin) return status;
    const backend = await entry.probe();
    if (backend) {
      macCandidateStatus.set(entry.type, backend);
      return backend;
    }
    macCandidateStatus.set(entry.type, 'fail');
  }
  return null;
}

function macMissingError() {
  return new Error(
    "macOS brightness control requires one of: the 'brightness' CLI (built-in display), 'm1ddc' " +
    "(external displays, Apple Silicon), or 'ddcctl' (external displays, Intel). " +
    'Install with: brew install brightness  /  brew install m1ddc  /  brew install ddcctl'
  );
}

async function macGetDisplayTarget(backend, display) {
  if (backend.type === 'ddcctl' && display && display !== 'all') {
    const n = Number(display);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 1;
}

async function macGet(preferred, display) {
  const backend = await resolveMacBackend(preferred);
  if (!backend) throw macMissingError();
  try {
    if (backend.type === 'm1ddc') {
      const { stdout } = await execAsync(`${backend.bin} get luminance`);
      const value = parseInt(stdout.trim(), 10);
      if (!Number.isInteger(value)) throw new Error('m1ddc returned no luminance value.');
      return Math.min(100, Math.max(0, value));
    }
    if (backend.type === 'ddcctl') {
      const d = await macGetDisplayTarget(backend, display);
      const { stdout } = await execAsync(`${backend.bin} -d ${d} -b ?`);
      const match = stdout.match(/brightness[:\s]+(\d+)/i);
      if (!match) throw new Error('ddcctl returned no brightness value.');
      return Math.min(100, Math.max(0, parseInt(match[1], 10)));
    }
    const { stdout } = await execAsync(`${backend.bin} -l`);
    const match = stdout.match(/brightness\s+([\d.]+)/i);
    if (!match) throw new Error('Unable to parse `brightness -l` output.');
    return Math.round(parseFloat(match[1]) * 100);
  } catch (err) {
    if (err.message.includes('returned no') || err.message.includes('Unable to parse')) {
      macCandidateStatus.set(backend.type, 'fail');
    }
    throw err;
  }
}

async function macSet(value, opts = {}) {
  const backend = await resolveMacBackend(opts.preferred);
  if (!backend) throw macMissingError();
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  try {
    if (backend.type === 'm1ddc') {
      await execAsync(`${backend.bin} set luminance ${clamped}`);
      return;
    }
    if (backend.type === 'ddcctl') {
      const displays = opts.display === 'all' || opts.display == null ? [1]
        : [Number(opts.display)].filter(n => Number.isInteger(n) && n > 0);
      if (displays.length === 0) throw new Error(`ddcctl: invalid display "${opts.display}".`);
      for (const d of displays) {
        await execAsync(`${backend.bin} -d ${d} -b ${clamped}`);
      }
      return;
    }
    const normalized = clamped / 100;
    await execAsync(`${backend.bin} ${normalized.toFixed(2)}`);
  } catch (err) {
    macCandidateStatus.set(backend.type, 'fail');
    throw err;
  }
}

const linuxCandidateStatus = new Map();
const LINUX_BACKEND_ORDER = ['brightnessctl', 'light', 'ddcutil', 'xrandr'];

function isWaylandSession() {
  return (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
}

async function resolveLinuxBackend() {
  for (const name of LINUX_BACKEND_ORDER) {
    if (linuxCandidateStatus.get(name) === 'fail') continue;
    if (linuxCandidateStatus.get(name) === 'ok') return name;
    const exists = await commandExists(name);
    linuxCandidateStatus.set(name, exists ? 'ok' : 'absent');
    if (exists) return name;
  }
  return false;
}

function linuxMissingError() {
  return new Error(
    "Linux brightness control requires one of: 'brightnessctl' (recommended, backlight, works on Wayland), " +
    "'light', 'ddcutil' (external/DDC-CI monitors), or 'xrandr' (X11 software fallback)." +
    (isWaylandSession() ? ' Note: xrandr does not work on Wayland sessions.' : '')
  );
}

async function getXrandrOutputs() {
  const { stdout } = await execAsync('xrandr --current');
  const outputs = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+connected/i);
    if (match) outputs.push(match[1]);
  }
  if (outputs.length === 0) throw new Error('xrandr: no connected display output found.');
  return outputs;
}

function parseXrandrTargetDisplay(display) {
  if (display == null || display === 'all' || display === '') return null;
  return String(display);
}

async function readXrandrBrightness(output) {
  try {
    const { stdout } = await execAsync('xrandr --verbose');
    const escaped = output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped}\\s+connected[\\s\\S]*?Brightness:\\s*([\\d.]+)`, 'm');
    const match = stdout.match(regex);
    if (match) {
      const parsed = Math.round(parseFloat(match[1]) * 100);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch { /* fall through to cached/default value below */ }
  return xrandrLastValue ?? 100;
}

function markLinuxBackendUsed(name) {
  linuxCandidateStatus.set(name, 'ok');
}

function markLinuxBackendFailed(name) {
  linuxCandidateStatus.set(name, 'fail');
}

async function linuxGet() {
  const backend = await resolveLinuxBackend();
  if (!backend) throw linuxMissingError();

  try {
    if (backend === 'brightnessctl') {
      const { stdout } = await execAsync('brightnessctl -m get');
      const parts = stdout.trim().split(',');
      const percentStr = parts[parts.length - 1];
      if (percentStr && percentStr.includes('%')) return parseInt(percentStr, 10);
      const [{ stdout: cur }, { stdout: max }] = await Promise.all([
        execAsync('brightnessctl get'),
        execAsync('brightnessctl max')
      ]);
      return Math.round((parseInt(cur, 10) / parseInt(max, 10)) * 100);
    }

    if (backend === 'light') {
      const { stdout } = await execAsync('light -G');
      return Math.round(parseFloat(stdout.trim()));
    }

    if (backend === 'ddcutil') {
      const { stdout } = await execAsync('ddcutil getvcp 10 --brief');
      const nums = stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      const max = nums[nums.length - 1] || 100;
      const current = nums[nums.length - 2] || 0;
      return Math.round((current / max) * 100);
    }

    const output = await getXrandrOutputs();
    return readXrandrBrightness(parseXrandrTargetDisplay(xrandrTargetRef.value) ?? output[0]);
  } catch (err) {
    markLinuxBackendFailed(backend);
    throw err;
  }
}

const xrandrTargetRef = { value: null };

async function linuxSet(value, opts = {}) {
  xrandrTargetRef.value = opts.display ?? null;
  const backend = await resolveLinuxBackend();
  if (!backend) throw linuxMissingError();

  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  const target = parseXrandrTargetDisplay(opts.display);

  try {
    if (backend === 'brightnessctl') {
      if (target && target !== 'all') {
        await execAsync(`brightnessctl --device='${target.replace(/'/g, "'\\''")}' set ${clamped}%`);
      } else {
        await execAsync(`brightnessctl set ${clamped}%`);
      }
      markLinuxBackendUsed(backend);
      return;
    }
    if (backend === 'light') {
      await execAsync(`light -S ${clamped}`);
      markLinuxBackendUsed(backend);
      return;
    }
    if (backend === 'ddcutil') {
      if (target && target !== 'all' && /^\d+$/.test(target)) {
        await execAsync(`ddcutil setvcp 10 ${clamped} --display ${target}`);
      } else {
        await execAsync(`ddcutil setvcp 10 ${clamped}`);
      }
      markLinuxBackendUsed(backend);
      return;
    }

    const outputs = await getXrandrOutputs();
    const targets = target && target !== 'all' ? outputs.filter(o => o === target) : outputs;
    const list = targets.length > 0 ? targets : outputs;
    const normalized = Math.max(0.1, clamped / 100);
    for (const output of list) {
      await execAsync(`xrandr --output ${output} --brightness ${normalized.toFixed(2)}`);
    }
    xrandrLastValue = clamped;
    markLinuxBackendUsed(backend);
  } catch (err) {
    markLinuxBackendFailed(backend);
    throw err;
  }
}

async function listDisplays() {
  switch (PLATFORM) {
    case 'win32': {
      const displays = [];
      try {
        const { stdout } = await execAsync(
          'powershell.exe -NoProfile -Command "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorID | ForEach-Object { $_.InstanceName }"'
        );
        const instances = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        instances.forEach((instance, index) => {
          const raw = instance.replace(/\\/g, '/').replace(/_0$/, '');
          displays.push({ id: instance, name: raw.split('/').pop() || `Display ${index + 1}`, kind: 'wmi' });
        });
      } catch { /* WMI unavailable */ }
      const ddc = await winListDdcMonitors();
      for (const m of ddc) {
        displays.push({ id: m.id, name: m.name, kind: m.controllable ? 'ddc' : 'ddc-readonly' });
      }
      return displays;
    }
    case 'darwin': {
      const displays = [];
      const backend = await resolveMacBackend();
      if (backend && backend.type === 'brightness') {
        try {
          const { stdout } = await execAsync(`${backend.bin} -l`);
          let index = 1;
          for (const line of String(stdout || '').split(/\r?\n/)) {
            const m = line.match(/^display\s*\d*:\s*(.*)$/i) || line.match(/^(.*)$/);
            if (m && m[1]) {
              displays.push({ id: String(index), name: m[1].trim() || `Display ${index}`, kind: 'internal' });
              index++;
            }
          }
        } catch { /* fall through */ }
      }
      if (displays.length === 0) {
        displays.push({ id: '1', name: 'Main display', kind: backend ? backend.type : 'unknown' });
      }
      return displays;
    }
    case 'linux': {
      const displays = [];
      try {
        const { stdout } = await execAsync('brightnessctl -l');
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = line.match(/Device '([^']+)'.*?class\s*=\s*backlight/i);
          if (m) displays.push({ id: m[1], name: m[1], kind: 'backlight' });
        }
      } catch { /* brightnessctl unavailable */ }
      try {
        const { stdout } = await execAsync('xrandr --current');
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = line.match(/^(\S+)\s+connected/i);
          if (m && !displays.some(d => d.name === m[1])) {
            displays.push({ id: m[1], name: m[1], kind: 'xrandr' });
          }
        }
      } catch { /* xrandr unavailable */ }
      return displays;
    }
    default:
      return [];
  }
}

async function getSystemBrightness(opts = {}) {
  switch (PLATFORM) {
    case 'win32': return winGet();
    case 'darwin': return macGet(opts.display);
    case 'linux': return linuxGet();
    default: throw new Error(`Brightness control is not supported on platform "${PLATFORM}".`);
  }
}

async function setSystemBrightness(value, opts = {}) {
  switch (PLATFORM) {
    case 'win32': return winSet(value, opts);
    case 'darwin': return macSet(value, opts);
    case 'linux': return linuxSet(value, opts);
    default: throw new Error(`Brightness control is not supported on platform "${PLATFORM}".`);
  }
}

async function getBrightnessBackendName() {
  try {
    switch (PLATFORM) {
      case 'win32': {
        try {
          await winGet();
        } catch { /* all fail; fall through to name report */ }
        if (winCandidateStatus.get('wmi') === 'ok') return 'WMI';
        if (winCandidateStatus.get('cim') === 'ok') return 'CIM';
        if (winCandidateStatus.get('ddc') === 'ok') return 'DDC/CI';
        return null;
      }
      case 'darwin': {
        const backend = await resolveMacBackend();
        if (!backend) return null;
        return backend.type === 'm1ddc' ? 'm1ddc' : backend.type === 'ddcctl' ? 'ddcctl' : 'brightness';
      }
      case 'linux': return (await resolveLinuxBackend()) || null;
      default: return null;
    }
  } catch {
    return null;
  }
}

module.exports = {
  getSystemBrightness, setSystemBrightness, getBrightnessBackendName, listDisplays,
  hasAmbientLightSensor, readAmbientLightLux, getPowerStatus, getNightLightState,
  detectDeviceProfile, getCurrentWindow, getActiveWindowInfo, getActiveWindowSafe: getActiveWindowInfo,
  screenAvgBrightness,
};
