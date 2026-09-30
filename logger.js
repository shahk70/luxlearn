// logger.js

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
    }
  }
  try {
    const mirror =
      lvl === 'error' ? console.error
      : lvl === 'warn' ? console.warn
      : lvl === 'debug' ? console.debug
      : console.log;
    mirror(`[${lvl}] ${entry.message}`);
  } catch {
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
