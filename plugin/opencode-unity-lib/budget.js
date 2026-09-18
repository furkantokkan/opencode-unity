// The prompt budget preflight (spec 8.8) and the overflow path (8.7).
//
// Ollama does not refuse an oversized prompt: it cuts it and answers anyway, so the model loses the
// start of the conversation without anyone being told. The only way to keep that from happening is to
// measure the prompt before the request is built and to hand OpenCode its own overflow error, which
// it answers with a compaction.
//
// Two hooks feed the measurement (both read-only): the message transform records how many characters
// the serialized history has, and the system transform records the system prompt. `chat.params` then
// estimates and decides. The estimate is corrected per session from the real prompt token counts the
// responses report, so a session converges on its own text rather than on the calibration constant.
import { checkPromptBudget, updateCalibration } from './tokens.js';

export const OVERFLOW_ERROR_CODE = 'context_length_exceeded';

/** OpenCode's own agent for summarizing a session that ran out of context. */
export const COMPACTION_AGENT = 'compaction';

/** A session that is over budget inside its own compaction cannot be rescued by compacting again. */
export const SESSION_TOO_LARGE_MESSAGE =
  'opencode-unity budget: this session is too large for the local context; start a new session and point it at the files you need.';

/** How many sessions keep state; OpenCode reuses one process for many. */
const MAX_SESSIONS = 64;

/**
 * @typedef {'pass' | 'overflow' | 'stop'} BudgetAction
 */

/**
 * @typedef {object} BudgetSession
 * @property {number} systemChars
 * @property {number} historyChars
 * @property {number} calibration       Real prompt tokens per estimated token, clamped.
 * @property {number} overflows         Every overflow this session had, for the summary.
 * @property {number} overflowsSinceProgress  Reset by an assistant step that was not a compaction.
 * @property {number} lastEstimate      The estimate of the most recent preflight, for calibration.
 */

/**
 * @typedef {object} BudgetDecision
 * @property {BudgetAction} action
 * @property {number} estimate
 * @property {number} promptBudget
 * @property {number} overBy
 * @property {number} toolsTokens
 * @property {number} calibration
 */

/**
 * @typedef {object} BudgetTracker
 * @property {(sessionId: string, chars: number) => void} recordSystemChars
 * @property {(sessionId: string, chars: number) => void} recordHistoryChars
 * @property {(input: { sessionId: string, agent: string }) => BudgetDecision} preflight
 * @property {(input: { sessionId: string, inputTokens: number, agent?: string }) => number} recordUsage
 * @property {(sessionId: string) => BudgetSession} get
 * @property {() => number} size
 */

/**
 * @param {{ profile: import('./runtime-profile.js').RuntimeProfile }} options
 * @returns {BudgetTracker}
 */
export function createBudgetTracker({ profile }) {
  const { budget } = profile;
  /** @type {Map<string, BudgetSession>} */
  const sessions = new Map();

  /**
   * @param {string} sessionId
   * @returns {BudgetSession}
   */
  const get = (sessionId) => {
    const key = sessionId || '(unknown)';
    let session = sessions.get(key);
    if (!session) {
      session = { systemChars: 0, historyChars: 0, calibration: 1, overflows: 0, overflowsSinceProgress: 0, lastEstimate: 0 };
      sessions.set(key, session);
      if (sessions.size > MAX_SESSIONS) sessions.delete(/** @type {string} */ (sessions.keys().next().value));
    }
    return session;
  };

  return {
    get,
    size: () => sessions.size,
    recordSystemChars(sessionId, chars) {
      if (Number.isFinite(chars) && chars >= 0) get(sessionId).systemChars = chars;
    },
    recordHistoryChars(sessionId, chars) {
      if (Number.isFinite(chars) && chars >= 0) get(sessionId).historyChars = chars;
    },
    preflight({ sessionId, agent }) {
      const session = get(sessionId);
      const toolsTokens = resolveToolsTokens(budget.toolsTokens, agent);
      const check = checkPromptBudget({
        systemChars: session.systemChars,
        historyChars: session.historyChars,
        toolsTokens,
        charsPerToken: budget.charsPerToken,
        calibration: session.calibration,
        safetyMargin: budget.safetyMargin,
        promptBudget: budget.promptBudget,
      });
      session.lastEstimate = check.estimate;
      if (!check.overBudget) return decision('pass', check, toolsTokens, session.calibration);
      // The compaction summary itself is over budget, or the session overflowed again with no step in
      // between: both mean another compaction would only repeat the failure.
      const looping = agent === COMPACTION_AGENT || session.overflowsSinceProgress > 0;
      session.overflows += 1;
      session.overflowsSinceProgress += 1;
      return decision(looping ? 'stop' : 'overflow', check, toolsTokens, session.calibration);
    },
    recordUsage({ sessionId, inputTokens, agent }) {
      const session = get(sessionId);
      // A real step means the session made progress; a compaction summary alone does not.
      if (agent !== COMPACTION_AGENT) session.overflowsSinceProgress = 0;
      session.calibration = updateCalibration({
        estimatedTokens: session.lastEstimate,
        actualTokens: inputTokens,
        previous: session.calibration,
        clamp: budget.calibrationClamp,
      });
      return session.calibration;
    },
  };
}

/**
 * The value `chat.params` throws when the prompt is over budget outside compaction. OpenCode's
 * `parseStreamError` turns this exact shape into a ContextOverflowError, which it never retries and
 * which makes it compact the session (OC message-v2.ts L707-719, processor.ts L621-631).
 * @param {BudgetDecision} decision
 * @returns {{ type: 'error', error: { code: string, message: string } }}
 */
export function createOverflowError(decision) {
  return {
    type: 'error',
    error: {
      code: OVERFLOW_ERROR_CODE,
      message: `opencode-unity budget: the prompt is about ${decision.estimate} tokens and the budget for this context is ${decision.promptBudget}.`,
    },
  };
}

/**
 * The value thrown when compacting cannot help any more. It is a plain Error, so OpenCode halts the
 * session instead of retrying, and it carries no digits that its retry patterns could read as an
 * HTTP status (spec 7.6).
 * @returns {Error}
 */
export function createSessionTooLargeError() {
  return new Error(SESSION_TOO_LARGE_MESSAGE);
}

/**
 * The serialized size of the history OpenCode is about to send, and the session it belongs to.
 * @param {Array<{ info?: { sessionID?: unknown } }>} messages
 * @returns {{ sessionId: string | null, chars: number }}
 */
export function measureHistory(messages) {
  if (!Array.isArray(messages)) return { sessionId: null, chars: 0 };
  const first = messages[0]?.info;
  const sessionId = typeof (/** @type {{ sessionID?: unknown }} */ (first)?.sessionID) === 'string' ? String(/** @type {any} */ (first).sessionID) : null;
  let chars = 0;
  try {
    chars = JSON.stringify(messages)?.length ?? 0;
  } catch {
    chars = 0;
  }
  return { sessionId, chars };
}

/**
 * @param {string[]} system
 * @returns {number}
 */
export function measureSystem(system) {
  if (!Array.isArray(system)) return 0;
  return system.reduce((total, part) => total + (typeof part === 'string' ? part.length : 0), 0);
}

/**
 * Agents without a measured allowance pay the largest measured one, because guessing low here means
 * a truncated prompt rather than a compaction.
 * @param {Record<string, number>} toolsTokens
 * @param {string} agent
 * @returns {number}
 */
export function resolveToolsTokens(toolsTokens, agent) {
  const measured = toolsTokens[agent];
  if (typeof measured === 'number' && Number.isFinite(measured)) return measured;
  const values = Object.values(toolsTokens).filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : 0;
}

/**
 * @param {BudgetAction} action
 * @param {import('./tokens.js').BudgetCheck} check
 * @param {number} toolsTokens
 * @param {number} calibration
 * @returns {BudgetDecision}
 */
function decision(action, check, toolsTokens, calibration) {
  return { action, estimate: check.estimate, promptBudget: check.promptBudget, overBy: check.overBy, toolsTokens, calibration };
}
