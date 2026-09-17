// Shared scaffolding for one spike module: a check list, resources closed in reverse order, and a
// result object that run-all.mjs turns into redacted evidence.
import { CheckList } from './evidence.mjs';
import { parseJsonEvents } from './opencode.mjs';

/**
 * @typedef {object} SpikeMeta
 * @property {string} id           Letter, for example "A".
 * @property {string} title
 * @property {string} question     Spec 24.3 wording.
 * @property {string} contractTest Contract test that keeps the answer true.
 * @property {string} fallback     Spec 24.3 fallback when the spike fails.
 */

/**
 * @typedef {object} SpikeResult
 * @property {import('./evidence.mjs').Outcome} outcome
 * @property {string} summary
 * @property {import('./evidence.mjs').Check[]} checks
 * @property {Record<string, unknown>} evidence
 * @property {string[]} findings   Facts learned that later steps must use.
 * @property {string} decision     Which path the product takes because of this spike.
 */

export class SpikeContext {
  constructor() {
    this.checks = new CheckList();
    /** @type {Record<string, unknown>} */
    this.evidence = {};
    /** @type {string[]} */
    this.findings = [];
    /** @type {Array<() => unknown>} */
    this.closers = [];
    /** @type {import('./evidence.mjs').Outcome | undefined} Set only to override the check-derived outcome. */
    this.outcome = undefined;
    /** @type {string | null} */
    this.decision = null;
  }

  /**
   * @template T
   * @param {T & ({ close: () => unknown } | { cleanup: () => unknown } | { stop: () => unknown })} resource
   * @returns {T}
   */
  track(resource) {
    const anyResource = /** @type {any} */ (resource);
    this.closers.push(() => (anyResource.close ?? anyResource.cleanup ?? anyResource.stop).call(anyResource));
    return resource;
  }

  async closeAll() {
    for (const close of this.closers.reverse()) {
      try {
        await close();
      } catch {
        // Best effort.
      }
    }
    this.closers = [];
  }
}

/**
 * Counts hook log entries.
 * @param {any[]} hooks
 * @param {string} name
 * @param {(entry: any) => boolean} [filter]
 */
export function countHooks(hooks, name, filter = () => true) {
  return hooks.filter((entry) => entry.hook === name && filter(entry)).length;
}

/**
 * Everything a run printed that can carry an error: JSON error events on stdout plus stderr.
 * @param {{ stdout: string, stderr: string }} result
 */
export function runOutputText(result) {
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Compact, evidence-friendly view of one `opencode run`.
 * @param {import('./opencode.mjs').RunResult} result
 * @param {{ chatRequests: unknown[] }} llm
 * @param {any[]} hooks
 */
export function summarizeRun(result, llm, hooks) {
  const events = parseJsonEvents(result.stdout);
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    attempts: result.attempts,
    chatRequests: llm.chatRequests.length,
    hookCounts: countByHook(hooks),
    chatParamsAgents: hooks.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent),
    runErrorEvents: events.filter((event) => event.type === 'error').map((event) => event.error ?? event),
    stdoutEventTypes: events.map((event) => event.type),
    stderrTail: result.stderr.length > 1200 ? `...${result.stderr.slice(-1200)}` : result.stderr,
  };
}

/**
 * @param {any[]} hooks
 * @returns {Record<string, number>}
 */
function countByHook(hooks) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of hooks) counts[entry.hook] = (counts[entry.hook] ?? 0) + 1;
  return counts;
}
