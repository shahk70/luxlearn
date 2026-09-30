// cachedFn.js

function cachedFn(fn, ttlMs, opts = {}) {
  let value;
  let lastWriteAt = 0;
  let inflight = null;

  const cached = function cached() {
    const now = Date.now();

    if (value !== undefined && now - lastWriteAt < ttlMs) {
      if (!opts.stale || !opts.stale(value)) return Promise.resolve(value);
    }

    if (inflight) return inflight;

    inflight = (async () => {
      try {
        return await fn();
      } finally {
        inflight = null;
      }
    })();

    const resultPromise = inflight.then(
      (result) => { value = result; lastWriteAt = Date.now(); return result; },
      (err) => { throw err; },
    );

    return resultPromise;
  };

  cached.invalidate = () => {
    value = undefined;
    lastWriteAt = 0;
  };

  return cached;
}

module.exports = { cachedFn };
