// The only path on the CLI side that may make Ollama load or run a model (spec 7.5, 7.8, 12.3, S1).
// `warm`, `bench`, `delegate` and shaping all come through here, so the order is fixed and the failure
// direction is always closed:
//   1. validate the request and run the budget preflight (exit 3 before anything is measured or locked);
//   2. take the GPU lock, so one product process at a time can cause a load (spec 7.8);
//   3. evaluate the guard while the lock is held, because a verdict measured before the wait would be
//      stale by the time the request goes out;
//   4. send exactly one native /api/chat request, at the profile's model tag and num_ctx.
// A block, a probe failure, an unreachable server or an invalid profile never reaches step 4. The
// context size is taken from the runtime profile and is not an option: another `num_ctx` would reload
// the shared model, so there is no way to ask for one. `truncate` and `shift` are never sent; the
// preflight owns the prompt size and the answer's token count is checked for Ollama's truncation
// signature afterwards (spec 8.7, 8.8).
import { createDefaultProbes } from '../../plugin/opencode-unity-lib/guard/collect.js';
import { evaluateGuard } from '../../plugin/opencode-unity-lib/guard/evaluate.js';
import { checkPromptBudget, getPromptBudget, isTruncationSignature } from '../../plugin/opencode-unity-lib/tokens.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { acquireGpuLock } from '../core/lock.js';
import { getHomePaths } from '../core/paths.js';
import { buildChatBody, buildWarmBody, readChatStream } from './client.js';

export const CHAT_ROUTE = '/api/chat';
// A generation may run for minutes on a 30B model; delegate.requestTimeoutSec (600) is the documented
// budget for one request, and a load is bounded by the 10-17 s cold path plus a wide margin.
export const DEFAULT_CHAT_TIMEOUT_MS = 600_000;
export const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
// How long a caller waits for another holder before exit 6. Commands with long jobs raise it.
export const DEFAULT_LOCK_WAIT_SEC = 20;

const MAX_ERROR_BODY_CHARS = 300;
// HTTP 413, and any error text naming the context length, count as overflow rather than a transport
// failure (OC provider/error.ts L172-181 treats both as ContextOverflowError).
const OVERFLOW_PATTERN = /context[_ -]?length[_ -]?exceeded|context (?:window|length) |prompt is too long/i;
// Ollama answers a request for a tag it does not hold with `model "<tag>" not found, try pulling it
// first` (OL server/routes.go). Amendment 36.6 puts that in the same row as an unreachable server.
const MODEL_NOT_FOUND_PATTERN = /\bmodel\b[^\n]*\bnot found\b|\btry pulling it first\b/i;

/**
 * Guard reason ids that amendment 36.6 gives an envelope code of their own. Every other reason is a
 * `gpu_guard_blocked`, which is the code spec 5.3 prints for a blocked guard.
 * @type {Readonly<Record<string, string>>}
 */
const GUARD_REASON_CODES = Object.freeze({ ollama_unreachable: 'ollama_unreachable' });

/**
 * @typedef {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} RuntimeProfile
 * @typedef {import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} GuardVerdict
 * @typedef {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} GuardProbes
 * @typedef {import('../core/lock.js').GpuLock} GpuLock
 * @typedef {import('./client.js').ChatResult} ChatResult
 */

/**
 * The guard verdict as it goes into the JSON envelope. Raw probe measurements stay out: they carry
 * process command lines and file paths from the user's machine, which no envelope should print.
 * @typedef {object} GuardSummary
 * @property {string} verdict
 * @property {'remote' | 'loaded' | 'cold'} path
 * @property {'stop' | 'retry' | null} mode
 * @property {Array<{ id: string, detail: string }>} reasons
 * @property {string[]} notes
 * @property {string} checkedAt
 * @property {boolean} degraded
 * @property {string[]} notMeasured  Advisory checks the platform could not run.
 */

/**
 * @typedef {object} GuardedCommon
 * @property {RuntimeProfile} profile
 * @property {string} command                Label for the lock record and the messages, e.g. `warm`.
 * @property {string} [keepAlive]            Defaults to the profile value.
 * @property {number} [timeoutMs]
 * @property {GpuLock} [lock]                An already held lock; a second guarded call in one job
 *                                           (shaping, then the request) reuses one acquisition.
 * @property {string} [lockPath]             Defaults to `<home>/state/gpu.lock`.
 * @property {number} [lockWaitSec]
 * @property {(cleanup: () => string | void) => () => void} [addCleanup]  Releases the lock on Ctrl+C.
 * @property {(previous: unknown, reason: string) => void} [onLockTakeover]
 * @property {GuardProbes} [probes]
 * @property {typeof fetch} [fetch]
 * @property {AbortSignal} [signal]
 * @property {NodeJS.Platform} [platform]    Only for resolving the lock path.
 */

/**
 * @typedef {object} GuardedResult
 * @property {ChatResult} response
 * @property {GuardVerdict} verdict          Full verdict, including measurements, for the caller's view.
 * @property {GuardSummary} guard            The envelope-safe summary.
 * @property {number} durationMs             Request time, without the guard and the lock wait.
 * @property {boolean} truncated             The answer carries Ollama's truncation signature.
 * @property {{ estimate: number, promptBudget: number } | null} budget
 * @property {string[]} warnings
 */

/**
 * One guarded chat request. Throws CliError: exit 3 `context_budget_exceeded` when the prompt does not
 * fit and `context_overflow` when the server reports one, exit 2 `gpu_guard_blocked` when the guard
 * blocks (the deciding reason id is `data.guard.reason`) or `ollama_unreachable` when the server cannot
 * be reached, exit 6 when the lock stays busy, exit 7 for anything else.
 * @param {GuardedCommon & {
 *   messages: Array<{ role: string, content: string }>,
 *   maxOutputTokens?: number,
 *   sampling?: Partial<RuntimeProfile['provider']['sampling']>,
 *   format?: unknown,
 *   budget?: { systemChars?: number, historyChars?: number, toolsTokens?: number, calibration?: number } | null,
 * }} options
 * @returns {Promise<GuardedResult>}
 */
export async function guardedChat(options) {
  const { profile, messages, sampling, format, maxOutputTokens, budget } = options;
  assertProfile(profile);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('guardedChat needs at least one message; use guardedWarm() to load the model on purpose');
  }
  const maxOutput = resolveMaxOutput(profile, maxOutputTokens);
  const check = runBudgetPreflight(profile, messages, maxOutput, budget);
  const body = buildChatBody({
    model: profile.provider.modelTag,
    messages,
    numCtx: profile.provider.numCtx,
    keepAlive: options.keepAlive ?? profile.provider.keepAlive,
    sampling: { ...profile.provider.sampling, ...sampling },
    maxOutputTokens: maxOutput,
  });
  // A JSON schema constrains sampling only; it cannot change how the model is loaded (spec D-SH7).
  if (format !== undefined) Object.assign(body, { format });
  const result = await sendGuardedRequest(options, { body, cold: false, timeoutMs: options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS });
  const truncated = isTruncationSignature({ inputTokens: result.response.promptTokens, numCtx: profile.provider.numCtx, numKeep: profile.provider.numKeep });
  if (truncated) {
    result.warnings.push(`Ollama cut the prompt to ${result.response.promptTokens} tokens; the answer was written without the start of the request`);
  }
  return { ...result, truncated, budget: { estimate: check.estimate, promptBudget: check.promptBudget } };
}

/**
 * Loads the model at the profile context and returns without generating: `messages: []` is a load-only
 * request (OL server/routes.go L2629-2648). This is the only way to warm the model, so no other call
 * can do it as a side effect. The guard judges the cold path even when the model is already loaded.
 * @param {GuardedCommon} options
 * @returns {Promise<GuardedResult>}
 */
export async function guardedWarm(options) {
  const { profile } = options;
  assertProfile(profile);
  const body = buildWarmBody({
    model: profile.provider.modelTag,
    numCtx: profile.provider.numCtx,
    keepAlive: options.keepAlive ?? profile.provider.keepAlive,
  });
  const result = await sendGuardedRequest(options, { body, cold: true, timeoutMs: options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS });
  return { ...result, truncated: false, budget: null };
}

/**
 * Runs `use` while the GPU lock is held, releasing it on every exit including Ctrl+C. Callers that make
 * two guarded calls for one job (shaping, then the request) acquire once here and pass `lock` on.
 * @template T
 * @param {{ profile: RuntimeProfile, command: string, timeoutSec: number } & Pick<GuardedCommon, 'lockPath' | 'lockWaitSec' | 'addCleanup' | 'onLockTakeover' | 'signal' | 'platform'>} options
 * @param {(lock: GpuLock) => Promise<T>} use
 * @returns {Promise<T>}
 */
export async function withGpuLock(options, use) {
  const { profile, command, timeoutSec } = options;
  assertCommandLabel(command);
  const lock = await acquireGpuLock({
    lockPath: options.lockPath ?? getHomePaths(profile.home, { platform: options.platform ?? process.platform }).gpuLock,
    command,
    timeoutSec,
    waitSec: options.lockWaitSec ?? DEFAULT_LOCK_WAIT_SEC,
    signal: options.signal,
    onTakeover: options.onLockTakeover,
  });
  const removeCleanup = options.addCleanup?.(() => {
    lock.release();
    return 'released the GPU lock';
  });
  try {
    return await use(lock);
  } finally {
    lock.release();
    removeCleanup?.();
  }
}

/**
 * Turns a verdict into the fields an envelope may carry.
 * @param {GuardVerdict} verdict
 * @returns {GuardSummary}
 */
export function summarizeVerdict(verdict) {
  const notMeasured = readNotMeasured(verdict);
  return {
    verdict: verdict.verdict,
    path: verdict.path,
    mode: verdict.mode,
    reasons: verdict.reasons.map((reason) => ({ id: reason.id, detail: reason.detail })),
    notes: [...verdict.notes],
    checkedAt: verdict.checkedAt,
    degraded: isDegradedVerdict(verdict),
    notMeasured,
  };
}

/**
 * A pass the platform could not measure in full. The guard core gains the `pass-degraded` verdict and
 * `notMeasured[]` later (amendment CP-D3); until then no verdict is degraded and this reads false.
 * @param {GuardVerdict} verdict
 * @returns {boolean}
 */
export function isDegradedVerdict(verdict) {
  return /** @type {string} */ (verdict.verdict) === 'pass-degraded' || readNotMeasured(verdict).length > 0;
}

/**
 * @param {GuardedCommon} options
 * @param {{ body: Record<string, unknown>, cold: boolean, timeoutMs: number }} request
 * @returns {Promise<Omit<GuardedResult, 'truncated' | 'budget'>>}
 */
async function sendGuardedRequest(options, { body, cold, timeoutMs }) {
  const { profile, command } = options;
  assertCommandLabel(command);
  assertTimeout(timeoutMs);
  // Null when the caller already holds the lock: a takeover it has already reported is not ours to
  // report a second time for every request in the job.
  const run = async (/** @type {GpuLock | null} */ acquired) => {
    const verdict = await evaluateGuard({
      target: { baseUrl: profile.ollama.baseUrl, modelTag: profile.provider.modelTag, numCtx: profile.provider.numCtx },
      config: profile.guard,
      probes: options.probes ?? createDefaultProbes(),
      cold,
      signal: options.signal,
    });
    const guard = summarizeVerdict(verdict);
    if (!verdict.pass) throw createGuardBlockError(verdict, guard, command);
    const warnings = [];
    if (guard.degraded) {
      warnings.push(`The GPU guard passed without checking ${guard.notMeasured.join(', ') || 'every rule'} on this platform`);
    }
    if (acquired?.takeover) warnings.push(`Took over a stale GPU lock: ${acquired.takeover.reason}`);
    const startedMs = Date.now();
    const response = await sendModelRequest({
      baseUrl: profile.ollama.baseUrl,
      body,
      fetchImpl: options.fetch ?? globalThis.fetch,
      timeoutMs,
      signal: options.signal,
    });
    return { response, verdict, guard, durationMs: Date.now() - startedMs, warnings };
  };
  if (options.lock) return run(null);
  return withGpuLock({ ...options, timeoutSec: Math.ceil(timeoutMs / 1000) }, run);
}

/**
 * The single outgoing model call. Everything that can go wrong on the wire is mapped to a stable exit
 * code here, so callers never have to read an HTTP status.
 * @param {{ baseUrl: string, body: unknown, fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<ChatResult>}
 */
async function sendModelRequest({ baseUrl, body, fetchImpl, timeoutMs, signal }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${CHAT_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    throw describeTransportFailure(error, { signal, timeoutSignal, baseUrl, timeoutMs });
  }
  if (!response.ok) throw describeHttpFailure(response.status, await readBodyText(response), modelOf(body));
  try {
    return await readChatStream(toChunks(response));
  } catch (error) {
    if (signal?.aborted || timeoutSignal.aborted) throw describeTransportFailure(error, { signal, timeoutSignal, baseUrl, timeoutMs });
    throw error;
  }
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
function modelOf(body) {
  const model = /** @type {{ model?: unknown }} */ (body)?.model;
  return typeof model === 'string' ? model : null;
}

/**
 * @param {Response} response
 * @returns {AsyncIterable<Uint8Array | string>}
 */
function toChunks(response) {
  const stream = /** @type {any} */ (response.body);
  return stream && typeof stream[Symbol.asyncIterator] === 'function' ? stream : streamFromText(response);
}

/**
 * A fetch implementation without a streaming body still has to be readable.
 * @param {Response} response
 * @returns {AsyncIterable<string>}
 */
async function* streamFromText(response) {
  yield await response.text();
}

/**
 * @param {GuardVerdict} verdict
 * @param {GuardSummary} guard
 * @param {string} command
 * @returns {CliError}
 */
function createGuardBlockError(verdict, guard, command) {
  // One envelope code per situation (spec 5.3, amendment 36.6): a guard block is `gpu_guard_blocked`
  // and an unreachable or incomplete server is `ollama_unreachable`. The reason that stopped the
  // request stays machine-readable as `data.guard.reason`, beside the full `data.guard.reasons` list,
  // so an orchestrator can branch on `gpu_busy` without the code itself becoming unpredictable.
  const deciding = verdict.reasons.find((reason) => reason.mode === 'stop') ?? verdict.reasons[0];
  const details = verdict.reasons.map((reason) => reason.detail).join('; ');
  return new CliError(`The GPU guard blocked ${command}: ${details}`, {
    exitCode: EXIT.BLOCKED,
    code: GUARD_REASON_CODES[deciding?.id ?? ''] ?? 'gpu_guard_blocked',
    data: { guard: { ...guard, reason: deciding?.id ?? null } },
    hint: 'Run opencode-unity guard to see every check, or opencode-unity status for the current load.',
  });
}

/**
 * @param {unknown} error
 * @param {{ signal?: AbortSignal, timeoutSignal: AbortSignal, baseUrl: string, timeoutMs: number }} context
 * @returns {unknown}
 */
function describeTransportFailure(error, { signal, timeoutSignal, baseUrl, timeoutMs }) {
  // An interrupt is not a failure of ours: it keeps its own reason, and `main` turns it into exit 130.
  if (signal?.aborted) return signal.reason ?? error;
  if (timeoutSignal.aborted) {
    return new CliError(`The local model did not answer within ${formatSeconds(timeoutMs)}`, {
      exitCode: EXIT.RUNTIME,
      code: 'chat_timeout',
      data: { timeoutMs },
      cause: error,
      hint: 'Check opencode-unity status; a cold load plus a long answer can need more time than the limit allows.',
    });
  }
  return new CliError(`Ollama is not reachable at ${baseUrl}: ${describeNetworkError(error)}`, {
    exitCode: EXIT.BLOCKED,
    code: 'ollama_unreachable',
    cause: error,
    hint: 'Start the Ollama app, or set ollama.baseUrl in config.json.',
  });
}

/**
 * @param {number} status
 * @param {string} text
 * @param {string | null} [model]
 * @returns {CliError}
 */
function describeHttpFailure(status, text, model = null) {
  const detail = describeErrorBody(text);
  if (status === 413 || OVERFLOW_PATTERN.test(text)) {
    return new CliError(`The local model refused the prompt as too large for its context: ${detail}`, {
      exitCode: EXIT.BUDGET,
      code: 'context_overflow',
      data: { status },
      hint: 'Send fewer or smaller files, or split the work with delegate map.',
    });
  }
  // Amendment 36.6 puts a missing preset tag in the same row as an unreachable server: exit 2,
  // `ollama_unreachable`, `do_it_yourself`. It is the most likely first-run failure after an
  // incomplete `setup`, and exit 7 is the one class an orchestrator has no rule for, so a bare
  // `ollama_http_error` leaves the host core's "do it yourself and do not loop" unable to fire.
  // The body signature identifies it: a bare 404 may come from something that is not Ollama at all.
  if (MODEL_NOT_FOUND_PATTERN.test(text)) {
    return new CliError(`The model ${model ? `'${model}' ` : ''}is not installed: ${detail}`, {
      exitCode: EXIT.BLOCKED,
      code: 'ollama_unreachable',
      data: { status, model },
      hint: "Run 'opencode-unity setup' to create the model.",
    });
  }
  return new CliError(`Ollama POST ${CHAT_ROUTE} returned HTTP ${status}: ${detail}`, {
    exitCode: EXIT.RUNTIME,
    code: 'ollama_http_error',
    data: { status },
  });
}

/**
 * Spec 8.8 and 12.3: the prompt must fit in `limit.context - maxOutput - reserve`, checked before the
 * lock and the probes, because a request that cannot fit should not make anyone else wait.
 * @param {RuntimeProfile} profile
 * @param {Array<{ role: string, content: string }>} messages
 * @param {number} maxOutput
 * @param {{ systemChars?: number, historyChars?: number, toolsTokens?: number, calibration?: number } | null | undefined} budget
 * @returns {import('../../plugin/opencode-unity-lib/tokens.js').BudgetCheck}
 */
function runBudgetPreflight(profile, messages, maxOutput, budget) {
  const promptBudget = maxOutput === profile.provider.limit.output
    ? profile.budget.promptBudget
    : getPromptBudget({ context: profile.provider.limit.context, output: maxOutput, reserveTokens: profile.budget.reserveTokens });
  const check = checkPromptBudget({
    promptBudget,
    systemChars: budget?.systemChars ?? 0,
    historyChars: budget?.historyChars ?? countMessageChars(messages),
    toolsTokens: budget?.toolsTokens ?? 0,
    calibration: budget?.calibration ?? 1,
    charsPerToken: profile.budget.charsPerToken,
    safetyMargin: profile.budget.safetyMargin,
  });
  if (!check.overBudget) return check;
  throw new CliError(`The request needs about ${check.estimate} tokens but only ${check.promptBudget} fit before the answer`, {
    exitCode: EXIT.BUDGET,
    code: 'context_budget_exceeded',
    data: { estimate: check.estimate, promptBudget: check.promptBudget, overBy: check.overBy },
    hint: 'Send fewer or smaller files, or split the work with delegate map.',
  });
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {number}
 */
function countMessageChars(messages) {
  let chars = 0;
  for (const message of messages) {
    if (typeof message?.content !== 'string' || typeof message?.role !== 'string') {
      throw new TypeError('every message needs a role and string content');
    }
    // The role and the chat template around each turn cost a few tokens the estimator cannot see.
    chars += message.content.length + message.role.length + 8;
  }
  return chars;
}

/**
 * @param {RuntimeProfile} profile
 * @param {number | undefined} requested
 * @returns {number}
 */
function resolveMaxOutput(profile, requested) {
  const limit = profile.provider.limit.output;
  if (requested === undefined) return limit;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new TypeError(`maxOutputTokens must be a positive integer, got ${requested}`);
  return Math.min(requested, limit);
}

/**
 * @param {GuardVerdict} verdict
 * @returns {string[]}
 */
function readNotMeasured(verdict) {
  const value = /** @type {{ notMeasured?: unknown }} */ (verdict).notMeasured;
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/**
 * @param {unknown} profile
 * @returns {asserts profile is RuntimeProfile}
 */
function assertProfile(profile) {
  const value = /** @type {any} */ (profile);
  const usable =
    value !== null &&
    typeof value === 'object' &&
    typeof value.home === 'string' &&
    typeof value.ollama?.baseUrl === 'string' &&
    typeof value.provider?.modelTag === 'string' &&
    Number.isSafeInteger(value.provider?.numCtx) &&
    Number.isSafeInteger(value.provider?.limit?.output) &&
    Number.isSafeInteger(value.provider?.limit?.context) &&
    typeof value.provider?.keepAlive === 'string' &&
    value.provider?.sampling !== undefined &&
    value.guard !== undefined &&
    value.budget !== undefined;
  if (!usable) throw new TypeError('a complete runtime profile is required (provider, ollama, guard, budget, home)');
}

/**
 * @param {unknown} command
 */
function assertCommandLabel(command) {
  if (typeof command !== 'string' || command.trim() === '') throw new TypeError('command must be a non-empty label, for example "warm"');
}

/**
 * @param {unknown} timeoutMs
 */
function assertTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || /** @type {number} */ (timeoutMs) <= 0) throw new TypeError(`timeoutMs must be a positive number, got ${timeoutMs}`);
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBodyText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeNetworkError(error) {
  const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (error)?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

/**
 * @param {string} text
 * @returns {string}
 */
function describeErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof (/** @type {any} */ (parsed).error) === 'string') {
      return truncate(/** @type {any} */ (parsed).error, MAX_ERROR_BODY_CHARS);
    }
  } catch {
    // Not JSON: show the text.
  }
  return truncate(text.trim() || '(empty body)', MAX_ERROR_BODY_CHARS);
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} s`;
}
