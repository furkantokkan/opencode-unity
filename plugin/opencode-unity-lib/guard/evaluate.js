// One guard evaluation: validate the settings, collect the facts, decide (spec 7.3). Callers are the
// plugin hooks, `guard`, `status`, `doctor`, `warm`, `bench` and `delegate`. It never throws and
// never loads a model; every failure comes back as a blocked verdict.
import { collectGuardFacts, createDefaultProbes } from './collect.js';
import { resolveGuardConfig, validateGuardTarget } from './config.js';
import { createFailureVerdict, decideGuard } from './decide.js';

/**
 * @param {object} options
 * @param {import('./config.js').GuardTarget} options.target
 * @param {unknown} options.config                            Guard keys from the runtime profile or config.json.
 * @param {import('./collect.js').GuardProbes} [options.probes]
 * @param {boolean} [options.cold]                            Judge a new load even when the model is loaded.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('./decide.js').GuardVerdict>}
 */
export async function evaluateGuard({ target, config, probes = createDefaultProbes(), cold = false, signal }) {
  const resolved = resolveGuardConfig(config);
  const targetProblems = validateGuardTarget(target);
  if (!resolved.ok || targetProblems.length > 0) {
    const problems = [...(resolved.ok ? [] : resolved.errors), ...targetProblems];
    return createFailureVerdict({ probe: 'settings', error: problems.join('; '), target, nowMs: probes.now() });
  }
  try {
    const facts = await collectGuardFacts({ target, config: resolved.config, probes, cold, signal });
    return decideGuard(facts, target, resolved.config);
  } catch (error) {
    return createFailureVerdict({ probe: 'guard', error: describeError(error), target, nowMs: probes.now() });
  }
}

/**
 * The key a guard cache uses: a pass may only be reused for the same target and settings.
 * @param {import('./config.js').GuardTarget} target
 * @param {unknown} config
 * @returns {string}
 */
export function createGuardKey(target, config) {
  return stableStringify({ target, config });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
