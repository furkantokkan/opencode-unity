// `opencode-unity stop` (spec 5.5, 13.1 step 10): give the video memory back.
//
// Ollama frees a model when a chat request arrives with no messages and `keep_alive: 0`; it handles
// that body before scheduling, so nothing is loaded and nothing is generated (OL `server/routes.go`
// L2500-2511). That makes `stop` the one command a user runs between an agent session and a Unity
// build, and the reason the banner and the session summary both name it.
//
// It takes no GPU lock: unloading cannot fail another process's guard, and a user who wants their
// memory back should not wait behind a running job.
//
// Exit 0 whether or not anything was loaded, 2 when Ollama cannot be reached, 7 for anything else.
import { createOllamaClient, findModel } from '../ollama/client.js';
import { loadSession } from '../project/session.js';
import { formatGiBOrUnknown } from '../terminal/format.js';

/**
 * @typedef {object} StopDependencies
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {StopDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const modelTag = session.profile.provider.modelTag;
  const client = createOllamaClient({
    baseUrl: session.profile.ollama.baseUrl,
    ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}),
  });

  const running = await client.listRunning({ signal: cliContext.signal });
  // `ocu-...` and `ocu-...:latest` are the same tag; the shared matcher owns that rule.
  const entry = findModel(running, modelTag) ?? null;
  if (entry === null) {
    return {
      message: `${modelTag} is not loaded; no video memory to free`,
      data: { model: modelTag, wasLoaded: false, freedMiB: 0 },
      warnings: session.warnings,
    };
  }

  const freedMiB = entry.sizeVramBytes === null ? null : Math.round(entry.sizeVramBytes / 1048576);
  // `--dry-run` (spec 5.1): the read above says what would be freed; the unload itself is not sent.
  if (cliContext.global.dryRun === true) {
    return {
      message: `${modelTag} is loaded and would be unloaded, freeing ${formatGiBOrUnknown(freedMiB)}; dry run, nothing was unloaded`,
      data: { dryRun: true, model: modelTag, wasLoaded: true, unloaded: false, freedMiB },
      warnings: session.warnings,
    };
  }
  const { unloaded } = await client.unload(modelTag, { signal: cliContext.signal });
  return {
    message: unloaded
      ? `${modelTag} is unloaded; ${formatGiBOrUnknown(freedMiB)} of video memory is free again`
      : `Ollama does not know ${modelTag}; nothing was unloaded`,
    data: { model: modelTag, wasLoaded: true, unloaded, freedMiB },
    warnings: session.warnings,
  };
}
