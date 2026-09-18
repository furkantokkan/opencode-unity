// `delegate health` (spec 12.2): can this machine take delegated work right now, and at what cost?
//
// It reads only `/api/version`, `/api/tags` and `/api/show`, evaluates the guard, and reports the GPU
// lock. Nothing here loads a model, so an orchestrator may call it before every job.
import { EXIT } from '../cli/exit-codes.js';
import { describeGpuLock, readGpuLock } from '../core/lock.js';
import { createOllamaClient, findModel } from '../ollama/client.js';
import { formatVerdictSummary } from '../../plugin/opencode-unity-lib/guard/messages.js';
import { checkGuard } from './model.js';
import { getDelegatePromptBudget } from './prompts.js';
import { getOrchestratorAction } from './results.js';

const FLOAT_TOLERANCE = 1e-6;
const HEALTH_TIMEOUT_MS = 10_000;

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function runHealth(context) {
  const client = createOllamaClient({
    baseUrl: context.target.baseUrl,
    fetch: context.fetchImpl,
    timeoutMs: Math.min(context.timeouts.requestMs, HEALTH_TIMEOUT_MS),
  });
  /** @type {Record<string, unknown>} */
  const data = {
    baseUrl: context.target.baseUrl,
    model: context.target.modelTag,
    numCtx: context.target.numCtx,
    maxOutputTokens: context.budget.maxOutputTokens,
    promptBudgetTokens: getDelegatePromptBudget(context.budget),
    ollamaVersion: null,
    modelInstalled: false,
    modelLoaded: false,
    loadedNumCtx: null,
    parameterMismatches: [],
    lock: describeGpuLock(readGpuLock(context.lock.lockPath)),
    guard: null,
    delegation: 'on',
  };
  /** @type {string[]} */
  const warnings = [];

  try {
    data.ollamaVersion = await client.getVersion({ signal: context.signal });
    const installed = findModel(await client.listModels({ signal: context.signal }), context.target.modelTag);
    data.modelInstalled = Boolean(installed);
    if (installed) {
      const show = await client.showModel(context.target.modelTag, { signal: context.signal });
      if (show) data.parameterMismatches = compareShowParameters(show, context.profile);
    }
    const running = findModel(await client.listRunning({ signal: context.signal }), context.target.modelTag);
    data.modelLoaded = Boolean(running);
    data.loadedNumCtx = running?.contextLength ?? null;
  } catch (error) {
    return failure(data, warnings, error);
  }

  if (!data.modelInstalled) {
    // Amendment 36.6's refusal table gives "Ollama unreachable, or preset tag missing" one code, so
    // the lane that checks up front and the lane that finds out from the POST answer the same thing.
    return refusal(data, warnings, EXIT.BLOCKED, 'ollama_unreachable', `The model '${context.target.modelTag}' is not installed`, "Run 'opencode-unity setup' to create it.");
  }
  if (typeof data.loadedNumCtx === 'number' && data.loadedNumCtx !== context.target.numCtx) {
    warnings.push(`The model is loaded at context ${data.loadedNumCtx} but the profile says ${context.target.numCtx}; the next request reloads it.`);
  }
  if (/** @type {unknown[]} */ (data.parameterMismatches).length > 0) {
    warnings.push(`The installed model does not match the profile: ${/** @type {Array<{id: string, expected: string, actual: string}>} */ (data.parameterMismatches).map((item) => `${item.id} is ${item.actual}, expected ${item.expected}`).join('; ')}.`);
  }

  const verdict = await checkGuard({ target: context.target, probes: context.probes, signal: context.signal });
  data.guard = { verdict: verdict.verdict, path: verdict.path, reasons: verdict.reasons.map((reason) => reason.id), summary: formatVerdictSummary(verdict) };
  if (!verdict.pass) {
    return refusal(
      data,
      warnings,
      EXIT.BLOCKED,
      verdict.reasons.every((reason) => reason.id === 'ollama_unreachable') ? 'ollama_unreachable' : 'gpu_guard_blocked',
      `The GPU guard ${formatVerdictSummary(verdict)}`,
      'Do the work yourself; do not retry automatically.',
    );
  }
  return {
    data,
    warnings,
    message: `Ready: ${context.target.modelTag} at ${context.target.numCtx} tokens, prompt budget ${data.promptBudgetTokens}, GPU lock ${data.lock}`,
  };
}

/**
 * Spec 12.2: the installed model has to match the profile. The values compared are the ones the
 * Modelfile baked in, not the temperature the delegate lane overrides per request.
 * @param {import('../ollama/client.js').ShowResult} show
 * @param {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} profile
 * @returns {Array<{ id: string, expected: string, actual: string }>}
 */
export function compareShowParameters(show, profile) {
  const expected = {
    num_ctx: profile.provider.numCtx,
    temperature: profile.provider.sampling.temperature,
    top_p: profile.provider.sampling.topP,
    top_k: profile.provider.sampling.topK,
    repeat_penalty: profile.provider.sampling.repeatPenalty,
  };
  /** @type {Array<{ id: string, expected: string, actual: string }>} */
  const mismatches = [];
  for (const [name, value] of Object.entries(expected)) {
    const values = show.parameters[name] ?? [];
    const actual = values.length === 1 ? values[0] : undefined;
    if (typeof actual !== 'number' || Math.abs(actual - value) > FLOAT_TOLERANCE) {
      mismatches.push({ id: name, expected: String(value), actual: values.length === 0 ? '(missing)' : values.map(String).join(', ') });
    }
  }
  return mismatches;
}

/**
 * @param {Record<string, unknown>} data
 * @param {string[]} warnings
 * @param {number} exitCode
 * @param {string} code
 * @param {string} message
 * @param {string} [hint]
 * @returns {import('../cli/main.js').CommandResult}
 */
function refusal(data, warnings, exitCode, code, message, hint) {
  const action = getOrchestratorAction(code);
  return { exitCode, code, message: hint ? `${message}. ${hint}` : message, warnings, data: { ...data, ...(action ? { orchestratorAction: action } : {}) } };
}

/**
 * @param {Record<string, unknown>} data
 * @param {string[]} warnings
 * @param {unknown} error
 * @returns {import('../cli/main.js').CommandResult}
 */
function failure(data, warnings, error) {
  const cliError = /** @type {{ exitCode?: number, code?: string, message: string }} */ (error);
  const code = cliError.code ?? 'ollama_unreachable';
  return refusal(data, warnings, cliError.exitCode ?? EXIT.BLOCKED, code, cliError.message);
}
