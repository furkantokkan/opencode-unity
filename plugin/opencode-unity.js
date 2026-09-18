// The opencode-unity plugin (spec 8.7). OpenCode loads only top-level `plugins/*.js` as plugins, so
// everything under `plugins/opencode-unity-lib/` is imported by relative path and never loaded twice.
// Only `node:` builtins and relative modules are imported, so a session starts with no network.
//
// What it does, in the order OpenCode calls it:
//   config                  inject the local provider from the runtime profile, and nothing else
//   messages.transform      measure the history (read-only)
//   system.transform        run the GPU guard, measure the system prompt (read-only)
//   chat.params             reuse the guard verdict, fill sampling, cap output, run the budget preflight
//   tool.execute.before     clamp `read`, classify every shell command, hold `unityMCP_*` to the editor policy
//   shell.env               restore XDG_CONFIG_HOME for agent commands, opt out of .NET telemetry
//   event                   calibrate from real usage, detect a silently truncated prompt
//   text.complete           detect a tool call the model wrote as text
//
// Failure rule (D3, S2): if the runtime profile is missing or invalid, the provider is not injected.
// OpenCode then cannot resolve the model configured in `opencode.jsonc`, and the session stops before
// a request exists. A lib module that cannot be imported fails the same way without reaching this
// file at all, which M0 spike B measured. Every other hook is defensive: a bug in a measurement must
// never fail a request.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBudgetTracker, createOverflowError, createSessionTooLargeError, measureHistory, measureSystem } from './opencode-unity-lib/budget.js';
import { findTextToolCallMarker, isTruncated, readAssistantUsage } from './opencode-unity-lib/detect.js';
import { createGuardCache } from './opencode-unity-lib/guard/cache.js';
import { createGuardKey, evaluateGuard } from './opencode-unity-lib/guard/evaluate.js';
import { createGuardError } from './opencode-unity-lib/guard/messages.js';
import { createMcpArgsPolicy, isMcpTool, readEditorPolicyOptions } from './opencode-unity-lib/mcp-args.js';
import { applyProvider, applySampling } from './opencode-unity-lib/provider.js';
import { clampReadArgs, isReadTool } from './opencode-unity-lib/read-limit.js';
import { createSessionLog } from './opencode-unity-lib/session-log.js';
import { applyShellEnv } from './opencode-unity-lib/shell-env.js';
import { createShellGuard, isShellTool } from './opencode-unity-lib/shell-guard.js';
import { loadRuntimeProfile } from './opencode-unity-lib/runtime-profile.js';
import { buildFirstLoadToast, buildTextToolCallToast, buildTruncationToast, createToaster } from './opencode-unity-lib/toast.js';

export const PLUGIN_ID = 'opencode-unity';

/**
 * Everything the hooks share. Built once per OpenCode process by `createPluginRuntime`, which is
 * exported so the tests can drive the hooks with fake file systems, clients and guards.
 * @typedef {object} PluginRuntime
 * @property {import('./opencode-unity-lib/runtime-profile.js').RuntimeProfile | null} profile
 * @property {string | null} skipReason
 * @property {import('./opencode-unity-lib/session-log.js').SessionLog} log
 * @property {import('./opencode-unity-lib/toast.js').Toaster} toaster
 * @property {import('./opencode-unity-lib/budget.js').BudgetTracker | null} budget
 * @property {import('./opencode-unity-lib/shell-guard.js').ShellGuard} shell
 * @property {import('./opencode-unity-lib/mcp-args.js').McpArgsPolicy} mcpArgs
 * @property {() => Promise<import('./opencode-unity-lib/guard/decide.js').GuardVerdict>} checkGuard  Throws on a block.
 */

/**
 * @param {object} [options]
 * @param {unknown} [options.client]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.profilePath]
 * @param {typeof import('./opencode-unity-lib/guard/evaluate.js').evaluateGuard} [options.evaluate]
 * @param {Pick<typeof fs, 'readFile' | 'mkdir' | 'appendFile' | 'readdir' | 'rm'>} [options.fsImpl]
 * @returns {Promise<PluginRuntime>}
 */
export async function createPluginRuntime({ client, env = process.env, platform = process.platform, profilePath, evaluate = evaluateGuard, fsImpl = fs } = {}) {
  const home = env.OPENCODE_UNITY_HOME ?? null;
  // Without a home there is nowhere the product owns to write to, and a diagnostic log is never worth
  // creating a directory somewhere else.
  const log = home ? createSessionLog({ home, fs: fsImpl }) : createNullLog();
  const toaster = createToaster({ client });
  const loaded = await loadRuntimeProfile({ ...(profilePath ? { path: profilePath } : {}), readFile: (target) => fsImpl.readFile(target, 'utf8') });
  const project = await readProjectContext({ home, projectId: env.OPENCODE_UNITY_PROJECT ?? null, fsImpl });

  if (!loaded.ok) {
    log.append({ event: 'providerSkipped', reason: loaded.reason });
    return {
      profile: null,
      skipReason: loaded.reason,
      log,
      toaster,
      budget: null,
      shell: createShellGuard({ vcsKind: project.vcsKind, mcpHubUrl: project.hubUrl, platform, shell: env.SHELL ?? null }),
      // The editor policy holds even when the provider is not injected.
      mcpArgs: createMcpArgsPolicy(project.editor),
      checkGuard: async () => {
        throw new Error('opencode-unity: the runtime profile is missing, so no request is prepared.');
      },
    };
  }

  const profile = loaded.profile;
  const target = { baseUrl: profile.ollama.baseUrl, modelTag: profile.provider.modelTag, numCtx: profile.provider.numCtx };
  const key = createGuardKey(target, profile.guard);
  const cache = createGuardCache({ evaluate: () => evaluate({ target, config: profile.guard }) });

  return {
    profile,
    skipReason: null,
    log,
    toaster,
    budget: createBudgetTracker({ profile }),
    shell: createShellGuard({
      vcsKind: project.vcsKind,
      mcpHubUrl: project.hubUrl,
      extraProtectedEditGlobs: profile.safety.extraProtectedEditGlobs,
      platform,
      shell: env.SHELL ?? null,
    }),
    mcpArgs: createMcpArgsPolicy(project.editor),
    async checkGuard() {
      // One evaluation per request: `system.transform` measures and `chat.params` reuses the pass.
      const { verdict } = await cache.check(key);
      if (!verdict.pass) {
        log.append({ event: 'guardBlock', reason: verdict.reasons[0]?.id ?? 'unknown', mode: verdict.mode ?? 'stop', verdict: verdict.verdict });
        throw /** @type {Error} */ (createGuardError(verdict));
      }
      return verdict;
    },
  };
}

/**
 * The hook map. Split from the module default export so a test can build it over a fake runtime.
 * @param {PluginRuntime} runtime
 * @param {{ env?: Record<string, string | undefined>, userHome?: string | null }} [options]
 * @returns {Record<string, Function>}
 */
export function createHooks(runtime, { env = process.env, userHome = os.homedir() } = {}) {
  // A fake runtime in a test that carries no policy still gets the strictest one.
  const { log, toaster, shell, mcpArgs = createMcpArgsPolicy() } = runtime;

  return {
    /** @param {{ provider?: Record<string, unknown>, enabled_providers?: string[] }} config */
    config: async (config) => {
      if (!runtime.profile) return;
      try {
        applyProvider(config, runtime.profile);
        log.append({ event: 'providerInjected', model: runtime.profile.provider.modelTag });
      } catch (error) {
        // Never leave a half-written provider behind: without one the model does not resolve, which
        // is the failure this product prefers.
        delete config.provider?.[runtime.profile.provider.id];
        log.append({ event: 'providerSkipped', reason: describeError(error) });
      }
    },

    'experimental.chat.messages.transform': async (/** @type {unknown} */ _input, /** @type {{ messages?: any[] }} */ output) => {
      if (!runtime.budget) return;
      try {
        const measured = measureHistory(output?.messages ?? []);
        runtime.budget.recordHistoryChars(measured.sessionId ?? '', measured.chars);
      } catch (error) {
        log.append({ event: 'measureFailed', source: 'history', reason: describeError(error) });
      }
    },

    'experimental.chat.system.transform': async (/** @type {{ sessionID?: string }} */ input, /** @type {{ system: string[] }} */ output) => {
      const before = output?.system?.length ?? 0;
      await runtime.checkGuard();
      if (runtime.budget) runtime.budget.recordSystemChars(input?.sessionID ?? '', measureSystem(output?.system ?? []));
      // S9: exactly one system message. This hook reads; it must never add or drop a part.
      if ((output?.system?.length ?? 0) !== before) throw new Error('opencode-unity: the system prompt changed while it was being measured.');
    },

    'chat.params': async (/** @type {{ sessionID?: string, agent?: string }} */ input, /** @type {{ temperature?: number, topP?: number, maxOutputTokens?: number }} */ output) => {
      await runtime.checkGuard();
      if (!runtime.profile || !runtime.budget) return;
      applySampling(output, runtime.profile);
      const agent = input?.agent ?? '';
      const decision = runtime.budget.preflight({ sessionId: input?.sessionID ?? '', agent });
      if (decision.action === 'pass') {
        log.append({ event: 'request', agent, estimate: decision.estimate, budget: decision.promptBudget, calibration: decision.calibration });
        return;
      }
      log.append({ event: 'overflow', agent, estimate: decision.estimate, budget: decision.promptBudget, overBy: decision.overBy, mode: decision.action });
      if (decision.action === 'stop') throw createSessionTooLargeError();
      throw createOverflowError(decision);
    },

    'tool.execute.before': async (/** @type {{ tool?: string }} */ input, /** @type {{ args?: any }} */ output) => {
      const tool = input?.tool ?? '';
      if (isReadTool(tool)) {
        const clamped = clampReadArgs(output.args, runtime.profile?.safety.readLimitLines);
        if (clamped.changed) log.append({ event: 'readClamped', tool, limit: clamped.limit });
        return;
      }
      if (isShellTool(tool)) {
        try {
          shell.check(output.args);
        } catch (error) {
          // Only the deny code is logged. The message names the model's own arguments (a path, a URL),
          // and the session log holds metadata only (P5); the model still reads the full reason.
          log.append({ event: 'shellBlocked', tool, family: shell.family, code: readErrorCode(error) });
          throw error;
        }
      }
      if (isMcpTool(tool)) {
        try {
          const applied = mcpArgs.check(tool, output.args);
          if (applied?.changes.length) log.append({ event: 'mcpArgs', tool, changes: applied.changes.join(',') });
        } catch (error) {
          log.append({ event: 'mcpBlocked', tool, code: readErrorCode(error) });
          throw error;
        }
      }
    },

    'shell.env': async (/** @type {unknown} */ _input, /** @type {{ env: Record<string, string> }} */ output) => {
      try {
        applyShellEnv(output.env, { env, userHome });
      } catch (error) {
        log.append({ event: 'shellEnvFailed', reason: describeError(error) });
      }
    },

    event: async (/** @type {{ event?: unknown }} */ input) => {
      if (!runtime.profile || !runtime.budget) return;
      try {
        const usage = readAssistantUsage(input?.event);
        if (!usage) return;
        const agent = readEventAgent(input?.event);
        runtime.budget.recordUsage({ sessionId: usage.sessionId ?? '', inputTokens: usage.inputTokens, agent });
        const { numCtx, numKeep } = runtime.profile.provider;
        if (!isTruncated({ inputTokens: usage.inputTokens, numCtx, numKeep })) return;
        log.append({ event: 'truncation', inputTokens: usage.inputTokens, numCtx });
        toaster.show(buildTruncationToast({ inputTokens: usage.inputTokens, numCtx }));
      } catch (error) {
        log.append({ event: 'eventFailed', reason: describeError(error) });
      }
    },

    'experimental.text.complete': async (/** @type {unknown} */ _input, /** @type {{ text?: string }} */ output) => {
      try {
        const marker = findTextToolCallMarker(output?.text ?? '');
        if (!marker) return;
        log.append({ event: 'textToolCall', code: marker });
        toaster.show(buildTextToolCallToast());
      } catch (error) {
        log.append({ event: 'eventFailed', reason: describeError(error) });
      }
    },
  };
}

/**
 * Reads the two per-project files the shell guard and the editor policy need. Both are optional: a
 * missing or unreadable file leaves both in their strictest state (no VCS client allowed, hub calls
 * blocked by default, EditMode tests only).
 * @param {{ home: string | null, projectId: string | null, fsImpl: Pick<typeof fs, 'readFile'> }} options
 * @returns {Promise<{ vcsKind: string | null, hubUrl: string | null, editor: import('./opencode-unity-lib/mcp-args.js').McpArgsOptions }>}
 */
export async function readProjectContext({ home, projectId, fsImpl }) {
  if (!home || !projectId) return { vcsKind: null, hubUrl: null, editor: readEditorPolicyOptions(null) };
  const directory = path.join(home, 'projects', projectId);
  const project = await readJsonFile(fsImpl, path.join(directory, 'project.json'));
  const local = await readJsonFile(fsImpl, path.join(directory, 'local.json'));
  const kind = /** @type {{ vcs?: { kind?: unknown } }} */ (project)?.vcs?.kind;
  return {
    vcsKind: typeof kind === 'string' && kind !== 'none' ? kind : null,
    hubUrl: readHubUrl(local),
    editor: readEditorPolicyOptions(local),
  };
}

/**
 * The hub URL is machine data, so it lives in `local.json` and never in the committed project file
 * (P6). Two spellings are accepted because the file is written by another part of the product.
 * @param {unknown} local
 * @returns {string | null}
 */
function readHubUrl(local) {
  const value = /** @type {{ hubUrl?: unknown, mcpForUnity?: { hubUrl?: unknown } }} */ (local);
  const candidate = typeof value?.hubUrl === 'string' ? value.hubUrl : value?.mcpForUnity?.hubUrl;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * @param {Pick<typeof fs, 'readFile'>} fsImpl
 * @param {string} file
 * @returns {Promise<unknown>}
 */
async function readJsonFile(fsImpl, file) {
  try {
    const text = await fsImpl.readFile(file, 'utf8');
    return JSON.parse(typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : String(text));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function readEventAgent(event) {
  const info = /** @type {{ properties?: { info?: { agent?: unknown, mode?: unknown } } } | null} */ (event)?.properties?.info;
  const agent = info?.agent ?? info?.mode;
  return typeof agent === 'string' ? agent : '';
}

/**
 * @returns {import('./opencode-unity-lib/session-log.js').SessionLog}
 */
function createNullLog() {
  return { directory: '', append: () => {}, flush: async () => {} };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The stable deny code a guard attached to its Error, or `unknown`.
 * @param {unknown} error
 * @returns {string}
 */
function readErrorCode(error) {
  const code = /** @type {{ code?: unknown } | null} */ (error)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown';
}

/**
 * What `server` does, with its inputs injectable.
 * @param {{ client?: unknown }} [input]
 * @param {Parameters<typeof createPluginRuntime>[0] & { userHome?: string | null }} [options]
 * @returns {Promise<Record<string, Function>>}
 */
export async function startPlugin(input = {}, options = {}) {
  const runtime = await createPluginRuntime({ client: input?.client, ...options });
  if (runtime.profile) {
    const { modelTag, numCtx } = runtime.profile.provider;
    runtime.log.append({ event: 'pluginLoaded', model: modelTag, source: runtime.profile.budget.toolsTokensSource });
    runtime.toaster.showOnce('first-load', buildFirstLoadToast({ modelTag, numCtx, presetStatus: runtime.profile.presetStatus }));
  }
  return createHooks(runtime, options);
}

export default {
  id: PLUGIN_ID,
  /**
   * @param {{ client?: unknown }} input
   * @returns {Promise<Record<string, Function>>}
   */
  server: (input) => startPlugin(input),
};
