// Instrumented OpenCode plugin for the M0 spikes. It mirrors the hook shape planned for
// plugin/opencode-unity.js (spec 8.7), but every behavior is driven by a JSON file named in
// OCU_SPIKE_CONFIG, and every hook call is appended to the JSONL file named in OCU_SPIKE_LOG.
// Only node: builtins and relative imports, so it loads without @opencode-ai/plugin.
import fs from 'node:fs';

import { appendLog } from './spike-lib/log.js';

const RETRY_MESSAGE =
  'opencode-unity GPU guard: the local model is temporarily at capacity because Unity is importing assets. The request will be tried again.';
const STOP_MESSAGE =
  'opencode-unity GPU guard: the model was not loaded because free video memory would drop to 0.7 GiB (minimum 1.5 GiB). Close GPU-heavy apps, then send the prompt again.';
const LOOP_BREAKER_MESSAGE =
  'opencode-unity budget: this session is too large for the local context even after compaction; start a new session.';

function readConfig() {
  const file = process.env.OCU_SPIKE_CONFIG;
  if (!file) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const config = readConfig();
const counters = { guard: 0, params: 0, overflowThrown: 0 };
/** @type {Map<string, { compactedAfterOverflow: boolean }>} */
const sessions = new Map();

function log(hook, data) {
  appendLog(process.env.OCU_SPIKE_LOG, { hook, at: Date.now(), ...data });
}

async function probeOllama() {
  const url = config.guard?.ollamaUrl;
  if (!url) return null;
  const response = await fetch(`${url}/api/ps`);
  const body = await response.json();
  return Array.isArray(body.models) ? body.models.length : -1;
}

async function runGuard(hook) {
  const guard = config.guard;
  if (!guard || (guard.hook !== 'both' && guard.hook !== hook)) return;
  const index = counters.guard++;
  const sequence = guard.sequence ?? ['pass'];
  const verdict = sequence[Math.min(index, sequence.length - 1)];
  const loadedModels = await probeOllama();
  log('guard', { via: hook, index, verdict, loadedModels });
  if (verdict === 'stop') throw new Error(STOP_MESSAGE);
  if (verdict === 'retry') throw new Error(RETRY_MESSAGE);
}

function sessionState(sessionID) {
  if (!sessions.has(sessionID)) sessions.set(sessionID, { compactedAfterOverflow: false });
  return /** @type {{ compactedAfterOverflow: boolean }} */ (sessions.get(sessionID));
}

function runOverflow(input) {
  const overflow = config.overflow;
  if (!overflow) return;
  const state = sessionState(input.sessionID);
  if (input.agent === 'compaction') {
    if (overflow.compaction === 'stop') {
      log('overflow', { action: 'stop-in-compaction' });
      throw new Error(LOOP_BREAKER_MESSAGE);
    }
    state.compactedAfterOverflow = counters.overflowThrown > 0;
    log('overflow', { action: 'compaction-pass' });
    return;
  }
  const mode = overflow.mode;
  const shouldThrow = mode === 'always' || (mode === 'once' && counters.overflowThrown === 0);
  if (!shouldThrow) return;
  if (overflow.loopBreaker && state.compactedAfterOverflow) {
    log('overflow', { action: 'loop-breaker' });
    throw new Error(LOOP_BREAKER_MESSAGE);
  }
  counters.overflowThrown++;
  log('overflow', { action: 'throw-overflow', agent: input.agent });
  throw { type: 'error', error: { code: 'context_length_exceeded', message: 'opencode-unity budget preflight: prompt over budget' } };
}

function injectProvider(cfg) {
  const provider = config.provider;
  if (!provider?.inject) return;
  if (provider.throwInConfig) throw new Error('spike: config hook failure');
  cfg.provider = cfg.provider ?? {};
  cfg.provider[provider.id] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Local model (opencode-unity spike)',
    options: { baseURL: provider.baseURL, apiKey: 'local' },
    models: {
      [provider.modelTag]: {
        name: provider.modelTag,
        tool_call: true,
        temperature: true,
        limit: { context: provider.context ?? 16384, output: provider.output ?? 4096 },
      },
    },
  };
  cfg.enabled_providers = [provider.id];
}

function applyToolPolicy(input, output) {
  const policy = config.toolBefore ?? {};
  if (input.tool === 'read' && policy.clampRead) {
    output.args.limit = Math.min(output.args.limit ?? policy.clampRead, policy.clampRead);
  }
  if (input.tool.startsWith('unityMCP_')) {
    if (policy.stripUnityInstance && output.args && 'unity_instance' in output.args) delete output.args.unity_instance;
    if (policy.runTestsEditModeOnly && input.tool === 'unityMCP_run_tests') {
      if (output.args.mode === undefined) output.args.mode = 'EditMode';
      if (output.args.mode !== 'EditMode') {
        throw new Error('opencode-unity: run_tests only allows EditMode in the editor check agent.');
      }
    }
    if (policy.readConsoleGetOnly && input.tool === 'unityMCP_read_console') {
      if (output.args.action === undefined) output.args.action = 'get';
      if (output.args.action !== 'get') {
        throw new Error('opencode-unity: read_console only allows action "get" in the editor check agent.');
      }
    }
  }
  for (const pattern of policy.denyCommandPatterns ?? []) {
    const command = String(output.args?.command ?? '');
    if (new RegExp(pattern, 'i').test(command)) {
      throw new Error(`opencode-unity shell guard: "${command}" is blocked.`);
    }
  }
}

export default {
  id: 'opencode-unity-spike',
  server: async (input) => {
    log('server', { directory: input.directory, worktree: input.worktree });
    return {
      config: async (cfg) => {
        log('config', {
          hadProvider: Boolean(cfg.provider),
          enabledProviders: cfg.enabled_providers ?? null,
          model: cfg.model ?? null,
          instructions: cfg.instructions ?? null,
          agents: Object.keys(cfg.agent ?? {}),
          mcp: Object.keys(cfg.mcp ?? {}),
          pluginOrigins: (cfg.plugin_origins ?? []).map((origin) => origin.source),
        });
        injectProvider(cfg);
      },
      'experimental.chat.messages.transform': async (_input, output) => {
        const first = output.messages?.[0]?.info;
        log('messages.transform', { sessionID: first?.sessionID ?? null, count: output.messages?.length ?? 0, chars: JSON.stringify(output.messages ?? []).length });
      },
      'experimental.chat.system.transform': async (hookInput, output) => {
        log('system.transform', { sessionID: hookInput.sessionID ?? null, model: hookInput.model?.id ?? null, systemCount: output.system.length, systemChars: output.system.join('').length });
        await runGuard('system');
      },
      'chat.params': async (hookInput, output) => {
        counters.params++;
        log('chat.params', {
          sessionID: hookInput.sessionID,
          agent: hookInput.agent,
          model: hookInput.model?.id ?? null,
          temperature: output.temperature ?? null,
          topP: output.topP ?? null,
          maxOutputTokens: output.maxOutputTokens ?? null,
        });
        await runGuard('params');
        runOverflow(hookInput);
      },
      'tool.execute.before': async (hookInput, output) => {
        log('tool.execute.before', { tool: hookInput.tool, args: output.args });
        applyToolPolicy(hookInput, output);
      },
      'tool.execute.after': async (hookInput, output) => {
        log('tool.execute.after', { tool: hookInput.tool, outputHead: String(output.output ?? '').slice(0, 400) });
      },
      'shell.env': async (hookInput, output) => {
        const set = config.shellEnv?.set ?? {};
        for (const [name, value] of Object.entries(set)) output.env[name] = value;
        log('shell.env', { cwd: hookInput.cwd, set: Object.keys(set) });
      },
      'experimental.text.complete': async (_hookInput, output) => {
        log('text.complete', { chars: output.text.length });
      },
      event: async ({ event }) => {
        const keep = ['session.status', 'session.error', 'permission.asked', 'permission.updated', 'permission.replied', 'session.compacted', 'message.updated'];
        if (!keep.includes(event.type)) return;
        const properties = event.properties ?? {};
        if (event.type === 'message.updated') {
          const info = properties.info ?? {};
          log('event', { type: event.type, role: info.role, agent: info.agent ?? info.mode ?? null, summary: info.summary ?? null, error: info.error ?? null, tokens: info.tokens ?? null, finish: info.finish ?? null });
          return;
        }
        log('event', { type: event.type, properties });
      },
    };
  },
};
