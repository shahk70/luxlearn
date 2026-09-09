// webcam.js

const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { PLATFORM, commandExists } = require('./core');

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 50 * 1024 * 1024;
const CAMERA_DELAY_MS = 2000;
const WORKER_ANALYSIS_TIMEOUT_MS = 15000;

async function pathExecutable(candidate) {
  if (path.isAbsolute(candidate)) {
    return fs.existsSync(candidate) ? candidate : null;
  }
  return (await commandExists(candidate)) ? candidate : null;
}

function resolveCommandCamPath() {
  const possiblePaths = [
    path.join(__dirname, 'node_modules', 'node-webcam', 'src', 'bindings', 'CommandCam', 'CommandCam.exe'),
    (() => {
      try { return path.join(path.dirname(require.resolve('node-webcam/package.json')), 'src', 'bindings', 'CommandCam', 'CommandCam.exe'); }
      catch { return null; }
    })(),
    path.resolve(__dirname, 'bin', 'CommandCam.exe'),
    path.join(process.cwd(), 'CommandCam.exe')
  ].filter(Boolean);
  return possiblePaths.find(p => fs.existsSync(p)) || null;
}

async function resolveFfmpeg() {
  const candidates = ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) {
    const bin = await pathExecutable(c);
    if (bin) return bin;
  }
  return null;
}

const FFMPEG_DSHOW_SIZE = '640x480';

function commandCamDeviceArg(device) {
  if (!device) return [];
  if (/^\d+$/.test(device)) return ['/devnum', device];
  return ['/devname', device];
}

function ffmpegDeviceInput(device) {
  if (PLATFORM === 'win32') {
    return device ? ['-f', 'dshow', '-video_size', FFMPEG_DSHOW_SIZE, '-i', `video=${device}`]
      : ['-f', 'dshow', '-video_size', FFMPEG_DSHOW_SIZE, '-i', 'video=0'];
  }
  if (PLATFORM === 'darwin') {
    return device ? ['-f', 'avfoundation', '-i', device] : ['-f', 'avfoundation', '-i', '0'];
  }
  return device ? ['-f', 'v4l2', '-video_size', FFMPEG_DSHOW_SIZE, '-i', device] : ['-f', 'v4l2', '-video_size', FFMPEG_DSHOW_SIZE, '-i', '/dev/video0'];
}

function buildCandidateList() {
  switch (PLATFORM) {
    case 'win32': {
      const commandCam = resolveCommandCamPath();
      const candidates = [];
      if (commandCam) {
        candidates.push({
          id: 'commandcam',
          bin: commandCam,
          ext: 'bmp',
          args: (outFile, delayMs, device) => [
            ...commandCamDeviceArg(device), '/delay', String(delayMs), '/filename', outFile,
          ],
          listCameras: () => commandCamListDevices(commandCam),
        });
      }
      candidates.push({
        id: 'ffmpeg',
        bin: 'ffmpeg',
        ext: 'bmp',
        needsProbe: true,
        args: (outFile, delayMs, device) => [
          '-hide_banner', '-loglevel', 'error',
          ...ffmpegDeviceInput(device),
          '-frames:v', '1', '-y', outFile,
        ],
        listCameras: () => ffmpegListCameras('dshow'),
      });
      return candidates;
    }
    case 'darwin': {
      return [
        {
          id: 'imagesnap',
          bin: 'imagesnap',
          ext: 'png',
          args: (outFile, delayMs, device) => [
            ...(device ? ['-d', device] : []), '-w', String(delayMs / 1000), outFile,
          ],
          listCameras: () => imagesnapListDevices(),
        },
        {
          id: 'ffmpeg',
          bin: 'ffmpeg',
          ext: 'bmp',
          needsProbe: true,
          args: (outFile, delayMs, device) => [
            '-hide_banner', '-loglevel', 'error',
            ...ffmpegDeviceInput(device),
            '-frames:v', '1', '-y', outFile,
          ],
          listCameras: () => ffmpegListCameras('avfoundation'),
        },
      ];
    }
    case 'linux': {
      return [
        {
          id: 'fswebcam',
          bin: 'fswebcam',
          ext: 'png',
          args: (outFile, delayMs, device) => [
            ...(device ? ['-d', device] : []), '-D', String(delayMs / 1000), '-q', '--no-banner', '--png', '0', outFile,
          ],
          listCameras: () => v4l2ListDevices(),
        },
        {
          id: 'ffmpeg',
          bin: 'ffmpeg',
          ext: 'bmp',
          needsProbe: true,
          args: (outFile, delayMs, device) => [
            '-hide_banner', '-loglevel', 'error',
            ...ffmpegDeviceInput(device),
            '-frames:v', '1', '-y', outFile,
          ],
          listCameras: () => v4l2ListDevices(),
        },
      ];
    }
    default:
      return [];
  }
}

function commandCamListDevices(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['/devlist'], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = String(stdout || '').split(/\r?\n/);
      const cams = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^available capture devices:/i.test(trimmed)) continue;
        if (/^no video devices found/i.test(trimmed)) continue;
        cams.push({ id: String(cams.length + 1), name: trimmed });
      }
      resolve(cams);
    });
  });
}

async function imagesnapListDevices() {
  const candidates = ['/opt/homebrew/bin/imagesnap', '/usr/local/bin/imagesnap', 'imagesnap'];
  for (const c of candidates) {
    const bin = await pathExecutable(c);
    if (!bin) continue;
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(bin, ['-l'], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER }, (err, so) => err ? reject(err) : resolve({ stdout: so }));
      });
      const cams = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.match(/"([^"]+)"/);
        if (m) cams.push({ id: m[1], name: m[1] });
      }
      return cams;
    } catch { /* try next */ }
  }
  return [];
}

async function v4l2ListDevices() {
  const cams = [];
  try {
    const entries = await fs.promises.readdir('/dev');
    for (const entry of entries) {
      const m = entry.match(/^video(\d+)$/);
      if (m) cams.push({ id: `/dev/video${m[1]}`, name: `/dev/video${m[1]}` });
    }
  } catch { /* no /dev access */ }
  cams.sort((a, b) => parseInt(a.id.slice(10), 10) - parseInt(b.id.slice(10), 10));
  return cams;
}

async function ffmpegListCameras(format) {
  const bin = await resolveFfmpeg();
  if (!bin) return [];
  return new Promise((resolve) => {
    const args = format === 'dshow' ? ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
      : ['-hide_banner', '-list_devices', 'true', '-f', 'avfoundation', '-i', ''];
    execFile(bin, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const text = String(stderr || stdout || '');
      const cams = [];
      for (const line of text.split(/\r?\n/)) {
        const dshow = line.match(/\]\s*"([^"]+)"\s*\((?:video|both)\)/i);
        const avf = line.match(/\[\d+\]\s+(.+)$/);
        if (format === 'dshow' && dshow) {
          cams.push({ id: dshow[1], name: dshow[1] });
        } else if (format === 'avfoundation' && /\(video\)/i.test(line)) {
          const m = line.match(/\[\d+\]\s+(.+?)\s*\(video\)/i);
          if (m) cams.push({ id: String(cams.length), name: m[1].trim() });
        } else if (format === 'avfoundation' && avf && /\[[\d,]+\]/.test(avf[1]) === false && cams.length === 0 && line.includes('@')) {
        }
      }
      resolve(cams);
    });
  });
}

const PROBE_TTL_MS = 5 * 60 * 1000;
let probedCandidates = null;
let probedAt = 0;
let probeInFlight = null;

async function probeCandidate(candidate) {
  if (!candidate.needsProbe) return true;
  try {
    const bin = await pathExecutable(candidate.bin);
    if (!bin) return false;
    const format = PLATFORM === 'win32' ? 'dshow' : PLATFORM === 'darwin' ? 'avfoundation' : null;
    if (format) {
      const cams = await ffmpegListCameras(format);
      if (cams.length === 0 && PLATFORM !== 'darwin') return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableCandidates() {
  const now = Date.now();
  if (probedCandidates && (now - probedAt) < PROBE_TTL_MS) {
    return probedCandidates.filter(entry => entry.available).map(entry => entry.candidate);
  }
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async () => {
    const list = buildCandidateList();
    const results = await Promise.all(list.map(async (candidate) => {
      const available = await probeCandidate(candidate);
      return { candidate, available };
    }));
    probedCandidates = results;
    probedAt = Date.now();
    return results.filter(entry => entry.available).map(entry => entry.candidate);
  })();

  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
}

function invalidateProbeCache() {
  probedCandidates = null;
  probedAt = 0;
}

function installHint() {
  switch (PLATFORM) {
    case 'win32': return 'Expected CommandCam.exe bundled alongside node-webcam, or install ffmpeg for DirectShow capture.';
    case 'darwin': return 'Install with: brew install imagesnap  (or install ffmpeg)';
    case 'linux': return 'Install with your package manager, e.g.: sudo apt install fswebcam  (or install ffmpeg)';
    default: return `Camera capture is not implemented for platform "${PLATFORM}".`;
  }
}

async function resolveCaptureBackend() {
  const candidates = await resolveAvailableCandidates();
  return candidates.length > 0 ? candidates[0] : null;
}

let captureChainError = null;

async function captureWithCandidate(candidate, device) {
  const unique = crypto.randomBytes(4).toString('hex');
  const outFile = path.join(os.tmpdir(), `wc_${unique}.${candidate.ext}`);

  try {
    await new Promise((resolve, reject) => {
      const args = candidate.args(outFile, CAMERA_DELAY_MS, device);
      execFile(candidate.bin, args, {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }, (error) => {
        if (error) {
          if (fs.existsSync(outFile)) resolve();
          else reject(error);
        } else {
          resolve();
        }
      });
    });
    if (!fs.existsSync(outFile)) throw new Error('Image file was not created');
    const stats = await fs.promises.stat(outFile);
    if (stats.size === 0) throw new Error('Captured image file is empty');

    const isValid = await validateCapturedFile(outFile, candidate.ext);
    if (!isValid) {
      console.warn('[webcam] captured file failed strict validation; using it anyway');
    }

    return await fs.promises.readFile(outFile);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('Camera device not found or inaccessible.');
    throw e;
  } finally {
    fs.promises.unlink(outFile).catch(() => { });
  }
}

async function validateBmpFile(bmpFile) {
  const fh = await fs.promises.open(bmpFile, 'r');
  try {
    const header = Buffer.alloc(14);
    const { bytesRead } = await fh.read(header, 0, 14, 0);
    if (bytesRead < 14) return false;
    if (header[0] !== 0x42 || header[1] !== 0x4d) return false;

    const declaredSize = header.readUInt32LE(2);
    const stats = await fh.stat();
    if (declaredSize === 0) return false;
    return stats.size >= declaredSize;
  } catch (err) {
    return false;
  } finally {
    await fh.close().catch(() => { });
  }
}

async function validateCapturedFile(filePath, ext) {
  if (!fs.existsSync(filePath)) return false;
  const stats = await fs.promises.stat(filePath);
  if (stats.size === 0) return false;
  if (ext === 'bmp') return validateBmpFile(filePath);
  return true;
}

let lastCapturePromise = Promise.resolve();

function captureImageBuffer(device) {
  const captureTask = async () => {
    const candidates = await resolveAvailableCandidates();
    if (candidates.length === 0) {
      throw new Error(`No camera capture tool available for platform "${PLATFORM}". ${installHint()}`);
    }

    const errors = [];
    for (const candidate of candidates) {
      try {
        return await captureWithCandidate(candidate, device);
      } catch (e) {
        errors.push(`${candidate.id}: ${e.message}`);
        if (candidate.needsProbe) {
          invalidateProbeCache();
        }
      }
    }
    const err = new Error(`All camera capture backends failed. ${errors.join(' | ')}`);
    err.candidateErrors = errors;
    throw err;
  };

  const execPromise = lastCapturePromise.then(captureTask, captureTask);
  lastCapturePromise = execPromise.catch(() => { });
  return execPromise;
}

let worker = null;
let nextRequestId = 1;
const pending = new Map();

function createWorker() {
  const w = new Worker(path.join(__dirname, 'webcamAnalysis_worker.js'));

  w.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timeout);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });

  const failAllPending = (err) => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    pending.clear();
  };

  w.on('error', (err) => {
    console.error('[webcam] Analysis worker error:', err.message);
    failAllPending(err);
    worker = null;
  });

  w.on('exit', (code) => {
    if (code !== 0) {
      failAllPending(new Error(`Analysis worker exited with code ${code}`));
    }
    worker = null;
  });

  return w;
}

function getWorker() {
  if (!worker) worker = createWorker();
  return worker;
}

function analyzeInWorker(payload) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Analysis worker timed out'));
    }, WORKER_ANALYSIS_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timeout });

    try {
      const transferList = ArrayBuffer.isView(payload.bmpBuffer) ? [payload.bmpBuffer.buffer] : [];
      getWorker().postMessage({ id, ...payload }, transferList);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timeout);
      reject(err);
    }
  });
}

async function shutdownWebcamWorker() {
  if (worker) {
    await worker.terminate().catch(() => { });
    worker = null;
  }
}

async function coreGetWebCamBrightness(opts = {}, imageBuffer) {
  return analyzeInWorker({
    bmpBuffer: imageBuffer,
    detectFaces: opts.detectFaces !== false,
  });
}

let inFlightCapture = null;

function getWebCamBrightness(opts = {}) {
  if (inFlightCapture) return inFlightCapture;

  inFlightCapture = (async () => {
    try {
      const candidates = await resolveAvailableCandidates();
      if (candidates.length === 0) {
        return {
          score: 0,
          diagnosis: `Configuration Error: no camera capture tool found for platform. ${installHint()}`,
          error: true
        };
      }
      const imageBuffer = await captureImageBuffer(opts.device);
      return await coreGetWebCamBrightness(opts, imageBuffer);
    } catch (err) {
      return {
        score: 0,
        diagnosis: `Camera Error: ${err.message}`,
        error: true
      };
    } finally {
      inFlightCapture = null;
    }
  })();
  return inFlightCapture;
}

async function listCameras() {
  try {
    const candidates = await resolveAvailableCandidates();
    for (const candidate of candidates) {
      if (typeof candidate.listCameras !== 'function') continue;
      try {
        const cams = await candidate.listCameras();
        if (cams && cams.length > 0) return cams;
      } catch { /* try next candidate */ }
    }
  } catch { /* fall through */ }
  return [];
}

async function resolveCaptureBackendInfo() {
  const backend = await resolveCaptureBackend();
  return backend ? `${backend.id}:${backend.bin}` : null;
}

module.exports = {
  getWebCamBrightness, shutdownWebcamWorker, resolveCaptureBackendInfo,
  listCameras, invalidateProbeCache,
};
