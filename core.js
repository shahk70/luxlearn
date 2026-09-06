// core.js — shared foundation: paths, JSON persistence, settings schema, exec helpers.


const path = require('path');

let userDataPath;
try {
  const { app } = require('electron');
  userDataPath = app.getPath('userData');
} catch (err) {
  userDataPath = path.join(__dirname, 'data');
}

const learningConfigPath = path.join(userDataPath, 'jsons', 'learningConfig.json');
const brightnessLogsPath = path.join(userDataPath, 'jsons', 'brightnessLogs.json');
const settingsPath = path.join(userDataPath, 'jsons', 'settings.json');
const WEATHER_JSON_PATH = path.join(userDataPath, 'jsons', 'dailyWeather.json');

const ICON_PATH = path.join(__dirname, './app/images/icon.ico');
const ICON_PNG_PATH = path.join(__dirname, './app/images/icon.png');


const fs = require('fs/promises');

// --- Settings & Constants ---
const DEFAULT_SUNRISE = { h: 7, m: 0 };
const DEFAULT_SUNSET = { h: 19, m: 0 };

function deepFreeze(obj) {
  Object.getOwnPropertyNames(obj).forEach((key) => {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });
  return Object.freeze(obj);
}

const defaultSettings = deepFreeze({
  "autoEnabled": true,
  "learningDays": 3,
  "logLimit": 240,
  "method": "location",
  "custom": {
    "sunrise": { ...DEFAULT_SUNRISE },
    "sunset": { ...DEFAULT_SUNSET }
  },
  "pollIntervalSec": 20,
  "logSyncMin": 1,
  "autoBrightMin": 5,
  "manualOverrideMinutes": 5,
  "hysteresisPercent": 2,
  "adjustDuringLearning": true,
  "language": "en",
  "activities": { "gaming": { "enabled": false }, "video": { "enabled": false }, "custom": [] },
  "startWithSystem": true,
  "cameraDevice": "",
  "cameraBackend": "auto",
  "targetDisplay": "all",
  "applyToAllDisplays": true
});

const SETTINGS_SCHEMA = {
  autoEnabled: { type: 'boolean' },
  startWithSystem: { type: 'boolean' },
  method: { type: 'enum', values: ['location', 'custom'] },
  learningDays: { type: 'number', min: 1, max: 31, integer: true },
  logLimit: { type: 'number', min: 50, max: 2000, integer: true },
  pollIntervalSec: { type: 'number', min: 3, max: 600 },
  logSyncMin: { type: 'number', min: 0.5, max: 600 },
  autoBrightMin: { type: 'number', min: 0.1, max: 60 },
  manualOverrideMinutes: { type: 'number', min: 1, max: 60 },
  hysteresisPercent: { type: 'number', min: 0, max: 25 },
  language: { type: 'enum', values: ['en', 'de', 'fa', 'tr', 'es', 'fr', 'ru', 'zh'] },
  activities: { type: 'object' },
  adjustDuringLearning: { type: 'boolean' },
  cameraDevice: { type: 'string', maxLength: 256 },
  cameraBackend: { type: 'enum', values: ['auto', 'builtin', 'ffmpeg'] },
  targetDisplay: { type: 'string', maxLength: 256 },
  applyToAllDisplays: { type: 'boolean' },
};

const clampNumber = (value, { min, max, integer }, fallback) => {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  if (integer) n = Math.round(n);
  if (typeof min === 'number') n = Math.max(min, n);
  if (typeof max === 'number') n = Math.min(max, n);
  return n;
};

const clampHourMinute = (value, fallback) => {
  const h = Number(value?.h);
  const m = Number(value?.m);
  return {
    h: Number.isFinite(h) ? Math.min(23, Math.max(0, Math.round(h))) : fallback.h,
    m: Number.isFinite(m) ? Math.min(59, Math.max(0, Math.round(m))) : fallback.m,
  };
};

function sanitizeSettings(input, base = defaultSettings) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};

  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    const fallback = base[key] ?? defaultSettings[key];
    if (rule.type === 'boolean') {
      out[key] = typeof src[key] === 'boolean' ? src[key] : !!fallback;
    } else if (rule.type === 'enum') {
      out[key] = rule.values.includes(src[key]) ? src[key] : fallback;
    } else if (rule.type === 'number') {
      out[key] = clampNumber(src[key], rule, fallback);
    } else if (rule.type === 'string') {
      const raw = typeof src[key] === 'string' ? src[key] : (typeof fallback === 'string' ? fallback : '');
      out[key] = typeof rule.maxLength === 'number' ? raw.slice(0, rule.maxLength) : raw;
    }
  }

  const baseCustom = base.custom ?? defaultSettings.custom;
  out.custom = {
    sunrise: clampHourMinute(src.custom?.sunrise, baseCustom.sunrise ?? DEFAULT_SUNRISE),
    sunset: clampHourMinute(src.custom?.sunset, baseCustom.sunset ?? DEFAULT_SUNSET),
  };

  // Activities pass through shape-normalized (deep-validated in app.js).
  const fallbackActivities = base.activities ?? defaultSettings.activities;
  out.activities = (src.activities && typeof src.activities === 'object')
    ? src.activities
    : fallbackActivities;

  return out;
}

// --- File System Utilities ---

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const loadJSON = async (filePath, defaultValue) => {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
      return deepClone(defaultValue);
    }
    if (err instanceof SyntaxError) {
      console.error(`Corrupt JSON at ${filePath}, restoring default.`);
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
      } catch (writeErr) {
        console.error(`Failed to heal corrupt JSON at ${filePath}:`, writeErr.message);
      }
      return deepClone(defaultValue);
    }
    throw err;
  }
};

const saveJSON = async (filePath, data) => {
  try {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    console.error(`Error saving JSON to ${filePath}:`, err.message);
  }
};

// --- Control Flow Utilities ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retry(fn, retries = 3, initialDelay = 300) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= retries) throw error;
      await sleep(initialDelay * (2 ** (attempt - 1)));
    }
  }
}


const { exec } = require('child_process');
const util = require('util');
const os = require('os');

const PLATFORM = os.platform();
const execAsync = util.promisify(exec);

const DEFAULT_PS_TIMEOUT_MS = 5000;
const PS_EXE = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell';

function execPowerShell(command, timeoutMs = DEFAULT_PS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error('PS Timeout'));
    }, timeoutMs);

    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    exec(`"${PS_EXE}" -NoProfile -EncodedCommand ${encoded}`, { signal: controller.signal, windowsHide: true }, (err, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

async function commandExists(cmd) {
  try {
    if (PLATFORM === 'win32') await execAsync(`where ${cmd}`);
    else await execAsync(`command -v ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  // paths
  learningConfigPath, brightnessLogsPath, settingsPath, ICON_PATH, ICON_PNG_PATH, WEATHER_JSON_PATH,
  // settings
  defaultSettings, DEFAULT_SUNRISE, DEFAULT_SUNSET, sanitizeSettings,
  // persistence / flow
  loadJSON, saveJSON, retry,
  // exec helpers
  PLATFORM, execAsync, execPowerShell, commandExists,
};
