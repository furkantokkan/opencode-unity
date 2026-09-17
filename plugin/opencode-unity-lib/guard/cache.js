// Reusing a guard pass (spec 7.5). The plugin evaluates in `experimental.chat.system.transform` and
// reuses that verdict in `chat.params`, so one request costs one evaluation. A pass is reused for
// `coldPassCacheSec` or `loadedPassCacheSec`, counted from when the evaluation finished. A block is
// never reused: it also drops the stored pass, so the next request measures again.
// Requests that arrive while an evaluation runs share it instead of starting a second one.

/**
 * @typedef {import('./decide.js').GuardVerdict} GuardVerdict
 * @typedef {{ verdict: GuardVerdict, source: 'evaluated' | 'cache' | 'shared' }} GuardCacheResult
 */

/**
 * @param {object} options
 * @param {(key: string) => Promise<GuardVerdict>} options.evaluate
 * @param {() => number} [options.now]
 * @returns {{ check: (key?: string) => Promise<GuardCacheResult>, peek: (key?: string) => GuardVerdict | null, clear: () => void }}
 */
export function createGuardCache({ evaluate, now = Date.now }) {
  /** @type {{ key: string, verdict: GuardVerdict, atMs: number } | null} */
  let lastPass = null;
  /** @type {{ key: string, promise: Promise<GuardVerdict> } | null} */
  let running = null;

  /**
   * @param {string} key
   * @returns {GuardVerdict | null}
   */
  const readFresh = (key) => {
    if (!lastPass || lastPass.key !== key) return null;
    return now() - lastPass.atMs < lastPass.verdict.cacheSec * 1000 ? lastPass.verdict : null;
  };

  return {
    async check(key = '') {
      const fresh = readFresh(key);
      if (fresh) return { verdict: fresh, source: 'cache' };
      if (running && running.key === key) return { verdict: await running.promise, source: 'shared' };
      const promise = evaluate(key);
      running = { key, promise };
      let verdict;
      try {
        verdict = await promise;
      } finally {
        if (running && running.promise === promise) running = null;
      }
      if (verdict.pass && verdict.cacheSec > 0) lastPass = { key, verdict, atMs: now() };
      else if (!verdict.pass) lastPass = null;
      return { verdict, source: 'evaluated' };
    },
    peek: (key = '') => readFresh(key),
    clear() {
      lastPass = null;
    },
  };
}
