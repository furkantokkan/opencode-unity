// Toasts (spec 8.7). The plugin has no terminal of its own: the only way to tell the human something
// while a session runs is the TUI toast endpoint, and `opencode run` has no TUI at all. So every
// toast is best-effort — it is sent, never awaited for correctness, and a failure is swallowed — and
// the same fact is always written to the session log, which `status` and the session summary read.
//
// Toast text is metadata only: model tag, counts and verdict names, never prompt or file content (P5).

/**
 * @typedef {'info' | 'success' | 'warning' | 'error'} ToastVariant
 * @typedef {{ title?: string, message: string, variant: ToastVariant, duration?: number }} Toast
 */

/**
 * @typedef {object} Toaster
 * @property {(toast: Toast) => void} show
 * @property {(key: string, toast: Toast) => void} showOnce  At most one toast per key per session.
 */

/**
 * @param {object} options
 * @param {unknown} [options.client]                        The OpenCode plugin client.
 * @param {(error: unknown) => void} [options.onError]      Called instead of throwing.
 * @returns {Toaster}
 */
export function createToaster({ client, onError = () => {} } = {}) {
  /** @type {Set<string>} */
  const shown = new Set();
  const send = /** @type {{ tui?: { showToast?: (input: { body: Toast }) => unknown } }} */ (client)?.tui?.showToast;
  return {
    show(toast) {
      if (typeof send !== 'function') return;
      try {
        const result = send.call(/** @type {any} */ (client).tui, { body: toast });
        if (isPromise(result)) result.catch(onError);
      } catch (error) {
        onError(error);
      }
    },
    showOnce(key, toast) {
      if (shown.has(key)) return;
      shown.add(key);
      this.show(toast);
    },
  };
}

/**
 * The toast shown once when the plugin loads: which model answers, at which context, and any line a
 * later check wants to add (the degraded-guard line of the platform tiers).
 * @param {object} input
 * @param {string} input.modelTag
 * @param {number} input.numCtx
 * @param {string} [input.presetStatus]
 * @param {string[]} [input.extraLines]
 * @returns {Toast}
 */
export function buildFirstLoadToast({ modelTag, numCtx, presetStatus, extraLines = [] }) {
  const status = presetStatus && presetStatus !== 'verified' ? ` (${presetStatus} preset)` : '';
  const lines = [`${modelTag} at ${formatContext(numCtx)} context${status}`, ...extraLines];
  return { title: 'opencode-unity', message: lines.join(' - '), variant: 'info' };
}

/**
 * Ollama silently cut the prompt, so the model answered without part of the conversation.
 * @param {{ inputTokens: number, numCtx: number }} input
 * @returns {Toast}
 */
export function buildTruncationToast({ inputTokens, numCtx }) {
  return {
    title: 'opencode-unity',
    message: `The prompt was cut to fit the ${formatContext(numCtx)} context (${inputTokens} tokens arrived). Start a new session for reliable answers.`,
    variant: 'warning',
  };
}

/**
 * The model wrote a tool call as text instead of calling the tool (spec 8.7).
 * @returns {Toast}
 */
export function buildTextToolCallToast() {
  return {
    title: 'opencode-unity',
    message: 'The model wrote a tool call as text instead of calling the tool. Ask it to try the step again.',
    variant: 'warning',
  };
}

/**
 * @param {number} numCtx
 * @returns {string}
 */
function formatContext(numCtx) {
  return numCtx % 1024 === 0 ? `${numCtx / 1024}K` : String(numCtx);
}

/**
 * @param {unknown} value
 * @returns {value is Promise<unknown>}
 */
function isPromise(value) {
  return typeof (/** @type {{ then?: unknown, catch?: unknown }} */ (value)?.catch) === 'function';
}
