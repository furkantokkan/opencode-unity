// How the delegate lane reaches the local model: through `guardedChat()` and nothing else (spec S1).
//
// This module holds only what is specific to delegated labour - the temperature override of spec 12.3,
// the per-job lock, and folding the guarded path's warnings into the job - so the guard, the lock
// order, the budget preflight and the wire format stay in one place for every caller.
import { evaluateGuard } from '../../plugin/opencode-unity-lib/guard/evaluate.js';
import { guardedChat, withGpuLock } from '../ollama/guarded-chat.js';

/**
 * @typedef {object} ModelTarget
 * @property {string} baseUrl
 * @property {string} modelTag
 * @property {number} numCtx
 * @property {string} keepAlive
 * @property {{ temperature: number, topP: number, topK: number, repeatPenalty: number }} sampling
 * @property {Record<string, unknown>} guard   Guard settings from the runtime profile.
 */

/**
 * One guarded request for a job that already holds the GPU lock.
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @param {readonly import('./prompts.js').ChatMessage[]} messages
 * @param {import('../core/lock.js').GpuLock} lock
 * @returns {Promise<import('../ollama/client.js').ChatResult>}
 */
export async function requestChat(context, job, messages, lock) {
  const result = await guardedChat({
    profile: context.profile,
    command: context.lock.command,
    messages: /** @type {Array<{ role: string, content: string }>} */ ([...messages]),
    maxOutputTokens: context.budget.maxOutputTokens,
    // Delegated labour wants less variety than an interactive session; everything else stays the
    // model's own sampling, because another value would describe a different model (spec 12.3).
    sampling: { temperature: context.config.delegate.temperature },
    timeoutMs: context.timeouts.requestMs,
    lock,
    probes: context.probes,
    fetch: context.fetchImpl,
    signal: context.signal,
  });
  job.warnings.push(...result.warnings);
  return result.response;
}

/**
 * Holds the GPU lock for one job (spec 7.8), not for one request: a map job keeps the model loaded for
 * its whole run instead of racing another command between files.
 * @template T
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {(lock: import('../core/lock.js').GpuLock) => Promise<T>} work
 * @returns {Promise<T>}
 */
export function withDelegateLock(context, work) {
  return withGpuLock(
    {
      profile: context.profile,
      command: context.lock.command,
      timeoutSec: context.lock.timeoutSec,
      lockPath: context.lock.lockPath,
      lockWaitSec: context.lock.waitSec,
      addCleanup: context.addCleanup,
      signal: context.signal,
      platform: context.platform,
    },
    work,
  );
}

/**
 * The guard verdict for this target, without loading anything. `delegate health` reports it; every
 * request path gets its own verdict from the guarded call itself.
 * @param {{ target: ModelTarget, probes?: import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes, signal?: AbortSignal, cold?: boolean }} input
 * @returns {Promise<import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict>}
 */
export function checkGuard({ target, probes, signal, cold = false }) {
  return evaluateGuard({
    target: { baseUrl: target.baseUrl, modelTag: target.modelTag, numCtx: target.numCtx },
    config: target.guard,
    ...(probes ? { probes } : {}),
    cold,
    signal,
  });
}

/**
 * @param {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} profile
 * @param {number} temperature
 * @returns {ModelTarget}
 */
export function createModelTarget(profile, temperature) {
  return {
    baseUrl: profile.ollama.baseUrl,
    modelTag: profile.provider.modelTag,
    numCtx: profile.provider.numCtx,
    keepAlive: profile.provider.keepAlive,
    sampling: { ...profile.provider.sampling, temperature },
    guard: profile.guard,
  };
}
