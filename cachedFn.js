// cachedFn.js — factory for deduplicating and caching async calls.
// Eliminates the repetitive cache + in-flight pattern repeated across
// signals.js, webcam.js, and weather.js.

/**
 * Create an async function that deduplicates concurrent calls, caches the
 * result for `ttlMs`, and never leaks in-flight promises.
 *
 * @param {() => Promise<T>} fn   – the real async work
 * @param {number} ttlMs          – cache TTL (ms); 0 = no cache, dedup only
 * @param {object}  [opts]
 * @param {(result: T) => boolean} [opts.stale] – return true to force refresh
 *                                                 even within TTL
 * @returns {() => Promise<T>}
 */
function cachedFn(fn, ttlMs, opts = {}) {
  let value;
  let lastWriteAt = 0;
  let inflight = null;

  return function cached() {
    const now = Date.now();

    // Fast path: cache hit (skip when caller declared it stale).
    if (value !== undefined && now - lastWriteAt < ttlMs) {
      if (!opts.stale || !opts.stale(value)) return Promise.resolve(value);
    }

    // Deduplicate concurrent calls — all callers share the same promise.
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        return await fn();
      } finally {
        inflight = null;
      }
    })();

    // Write-through cache: update on every successful settle so the next
    // fast-path read hits.  Setting `lastWriteAt` inside the finally keeps
    // the write atomic with the inflight clear (no stale-skip race).
    const resultPromise = inflight.then(
      (result) => { value = result; lastWriteAt = Date.now(); return result; },
      (err) => { throw err; },
    );

    return resultPromise;
  };
}

module.exports = { cachedFn };
