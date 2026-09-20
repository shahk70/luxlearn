// logger.js — central event log for the main process.
//
// Every module (app lifecycle, weather/GPS, webcam, signals, learning engine)
// reports here. Entries are kept in a bounded ring buffer, fanned out to live
// subscribers, mirrored to stdout for dev runs, and served to the Status page
// ("Recent Changes" list) where the log-level filter applies.
//
// Entry shape matches what the renderer already consumes:
//   { level: 'debug'|'info'|'success'|'warn'|'error', message, timestamp }

const LEVELS = new Set(['debug', 'info', 'success', 'warn', 'error']);
const MAX_BUFFER = 200;

const listeners = new Set();
const buffer = [];

function emit(level, message) {
  const lvl = LEVELS.has(level) ? level : 'info';
  const entry = {
    level: lvl,
    message: String(message ?? ''),
    timestamp: new Date().toISOString(),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const fn of [...listeners]) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must never break logging.
    }
  }
  // Keep stdout useful for `npm start` dev runs; the packaged app's stdout
  // is invisible, which is why this module exists.
  try {
    const mirror =
      lvl === 'error' ? console.error
      : lvl === 'warn' ? console.warn
      : lvl === 'debug' ? console.debug
      : console.log;
    mirror(`[${lvl}] ${entry.message}`);
  } catch {
    // Console unavailable — the buffer still holds the entry.
  }
  return entry;
}

module.exports = {
  log: emit,
  debug: (message) => emit('debug', message),
  info: (message) => emit('info', message),
  success: (message) => emit('success', message),
  warn: (message) => emit('warn', message),
  error: (message) => emit('error', message),
  onLog: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getHistory: () => buffer.slice(),
};
