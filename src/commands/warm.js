// `opencode-unity warm` (spec 5.5, 7.5): load the model on purpose, after the guard passes.
//
// This is the only command whose job is to put a model in video memory, and it does it the honest way:
// an empty-message request, which Ollama answers by loading and returning without generating (OL
// `server/routes.go` L2629-2648). It goes through `guardedWarm`, so the order is the same as every
// other load path - budget, lock, guard, then one request - and the guard judges the cold path even
// when the model is already loaded.
//
// Exit 0 loaded, 2 blocked or unreachable, 6 the GPU lock stayed busy, 7 anything else.
import { usageError } from '../cli/exit-codes.js';
import { guardedWarm } from '../ollama/guarded-chat.js';
import { loadSession } from '../project/session.js';
import { formatDuration } from '../terminal/format.js';

/** Ollama's own duration grammar plus a bare number of seconds (`5m`, `1h30m`, `0`, `-1`). */
const KEEP_ALIVE_PATTERN = /^-?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$|^-?\d+(?:\.\d+)?$/;

/**
 * @typedef {object} WarmDependencies
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {WarmDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const keepAlive = readKeepAlive(cliContext.options.keepAlive) ?? session.profile.provider.keepAlive;
  const { modelTag, numCtx } = session.profile.provider;
  // `--dry-run` (spec 5.1): loading the model is the whole side effect, so a dry run sends nothing.
  if (cliContext.global.dryRun === true) {
    cliContext.output.text(`Dry run: a real warm checks the GPU guard, takes the GPU lock and asks Ollama to load ${modelTag} at ${numCtx} context for ${keepAlive}.`);
    return {
      message: `${modelTag} would be loaded at ${numCtx} context for ${keepAlive}; dry run, nothing was loaded`,
      data: { dryRun: true, model: modelTag, numCtx, keepAlive },
      warnings: session.warnings,
    };
  }
  const result = await guardedWarm({
    profile: session.profile,
    command: 'warm',
    keepAlive,
    lockPath: session.paths.gpuLock,
    platform: session.platform,
    addCleanup: (cleanup) => cliContext.interrupts.addCleanup(cleanup),
    signal: cliContext.signal,
    ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}),
    ...(dependencies.probes ? { probes: dependencies.probes } : {}),
  });
  const seconds = result.durationMs / 1000;
  return {
    message: `${session.profile.provider.modelTag} is loaded at ${session.profile.provider.numCtx} context in ${formatDuration(seconds)}; it stays for ${keepAlive}`,
    data: {
      model: session.profile.provider.modelTag,
      numCtx: session.profile.provider.numCtx,
      keepAlive,
      durationMs: result.durationMs,
      guard: result.guard,
    },
    warnings: [...session.warnings, ...result.warnings],
  };
}

/**
 * The value is forwarded to Ollama, so it is checked here rather than sent and hoped for: a typo would
 * otherwise become an unexplained request failure with a model half loaded.
 * @param {import('../cli/args.js').OptionValue} value
 * @returns {string | undefined}
 */
export function readKeepAlive(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!KEEP_ALIVE_PATTERN.test(text)) {
    throw usageError(`--keep-alive '${text}' is not a duration; use a form Ollama accepts such as 15m, 1h or 0`, { code: 'invalid_keep_alive' });
  }
  return text;
}
