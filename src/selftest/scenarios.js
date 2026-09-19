// Self-test scenarios (spec 20.3, 20.4): C1, C5, C7, C8, C11 and C12 as data, plus a runner that owns
// the temp dirs, the mocks, the canary home, the fake nvidia-smi, the hang retry and the checks.
// Starting OpenCode is injected, because rendering the profile and building the launch environment
// belongs to src/opencode and src/doctor. Nothing here loads a model or touches the user's files.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCanaryMarkers, writeCanaryHome } from './canary-home.js';
import {
  checkIncludeUsage,
  checkNoCanaries,
  checkNoModelLoadRequests,
  checkPromptsWithinBudget,
  checkSampling,
  checkSingleSystemMessage,
  checkSystemContains,
  checkToolNames,
  getToolNames,
  result,
} from './capture-checks.js';
import { createFakeNvidiaSmi, NVIDIA_SMI_PRESETS } from './fake-nvidia-smi.js';
import { createLoadedModelState, startMockBackend } from './mock-backend.js';
import { DEFAULT_MCP_PATH, MOCK_HUB_INSTRUCTIONS_MARKER, startMockMcpHub } from './mock-mcp-hub.js';
import { NATIVE_LOAD_PATHS } from './mock-ollama.js';
import { estimatePromptTokens } from './mock-openai.js';
import { createRedactor, getLocalRedactionTargets } from '../core/redact.js';

export const SELFTEST_SCHEMA_VERSION = 1;

// Spec 20.3: 180 s per scenario, one retry, because `opencode run` hung in about 5 of 30 reference runs.
export const SCENARIO_TIMEOUT_MS = 180_000;
export const SCENARIO_ATTEMPTS = 2;

// The launcher must make this marker part of the rendered facts file, so C1 can prove the facts
// reached the model (spec 20.3 C1).
export const FACTS_MARKER = 'OCU_SELFTEST_FACTS_2E91';

// Spec 7.6 stop-message template and 8.7 loop-breaker message.
export const GUARD_MESSAGE_PREFIX = 'opencode-unity GPU guard:';
export const SESSION_TOO_LARGE_TEXT = 'start a new session';

// OpenCode reports an unresolved model this way (OC `agent.handler.ts` L67-80, `provider/provider.ts`).
export const MODEL_NOT_FOUND_PATTERN = /model not found|ProviderModelNotFoundError|no models? found/i;

// Spec 11.2: the only MCP tools the editor agent may see. Hub-side names have no server prefix.
export const EDITOR_HUB_TOOLS = Object.freeze(['read_console', 'find_gameobjects', 'get_test_job', 'refresh_unity', 'run_tests']);
export const EDITOR_MCP_TOOL_PREFIX = 'unityMCP_';
export const DEFAULT_EDITOR_MCP_TOOLS = Object.freeze(EDITOR_HUB_TOOLS.map((name) => `${EDITOR_MCP_TOOL_PREFIX}${name}`));

// A guard block evaluates the probes once. Five OpenCode retries would repeat them (OC `retry.ts` L31).
const MAX_PROBE_CALLS_WITHOUT_RETRY = 2;

/**
 * @typedef {object} SelftestProfile
 * @property {string} modelTag
 * @property {number} numCtx
 * @property {number} temperature
 * @property {number} topP
 * @property {number} maxOutputTokens
 * @property {number} promptBudget
 * @property {number} charsPerToken
 */

/** Matches presets/nvidia-24gb-qwen3-coder-30b-16k.json and spec 8.8. @type {SelftestProfile} */
export const DEFAULT_SELFTEST_PROFILE = Object.freeze({
  modelTag: 'ocu-qwen3-coder-30b-16k',
  numCtx: 16384,
  temperature: 0.7,
  topP: 0.8,
  maxOutputTokens: 4096,
  promptBudget: 11776,
  charsPerToken: 3.5,
});

/**
 * @typedef {object} SelftestExpectations
 * @property {readonly string[]} codeTools   Tool names the `unity-code` request must carry (the expected-tools fixture).
 * @property {readonly string[]} [editorMcpTools]  MCP tools visible to `unity-editor`; default: the 11.2 allow-list.
 * @property {(body: import('./capture-checks.js').CapturedChatBody) => number} [estimateTokens]
 * @property {boolean} [captureRequests] Include redacted synthetic request bodies in the result.
 */

/**
 * @typedef {object} ScenarioRun
 * @property {string} agent
 * @property {string} prompt
 * @property {'intact' | 'deleted' | 'syntax-error'} [plugin]  How the launcher must leave the plugin files.
 * @property {Record<string, string>} [env]  Applied after the product launch environment, so it wins.
 */

/**
 * @typedef {object} ScenarioSetup
 * @property {string} root
 * @property {string} home
 * @property {string} projectDir
 * @property {string} binDir
 * @property {string} largeFilePath
 * @property {SelftestProfile} profile
 * @property {Record<string, string>} env
 * @property {string} nvidiaSmiCommand
 * @property {string | null} hubUrl
 * @property {{ url: string, openAiBaseUrl: string }} backend
 */

/**
 * @typedef {object} ScenarioDefinition
 * @property {string} id
 * @property {string} contract       Contract test id from spec 20.3.
 * @property {string} title
 * @property {boolean} [editor]      Needs the editor agent and the mock hub.
 * @property {boolean} [large]       Writes the oversized project file.
 * @property {{ nvidiaSmi: keyof typeof NVIDIA_SMI_PRESETS, modelLoaded: boolean }} guard
 * @property {ScenarioRun[]} runs
 * @property {(setup: ScenarioSetup) => import('./mock-openai.js').Turn[]} turns
 * @property {(setup: ScenarioSetup) => import('./mock-openai.js').Turn} [compactionTurn]
 * @property {(observation: ScenarioObservation, context: VerifyContext) => import('./capture-checks.js').CheckResult[]} verify
 */

/**
 * @typedef {object} LaunchResult
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} [timedOut]
 */

/**
 * @typedef {object} LaunchRequest
 * @property {ScenarioDefinition} scenario
 * @property {ScenarioRun} run
 * @property {number} runIndex
 * @property {ScenarioSetup} setup
 * @property {number} timeoutMs
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} ScenarioObservation
 * @property {boolean} timedOut
 * @property {Array<LaunchResult & { agent: string, chats: import('./mock-openai.js').ChatRecord[] }>} runs
 * @property {string} output       stdout and stderr of every run.
 * @property {import('./mock-openai.js').ChatRecord[]} chats
 * @property {import('./mock-server.js').MockRequest[]} backendRequests
 * @property {import('./mock-mcp-hub.js').McpMessage[]} hubMessages
 * @property {import('./mock-mcp-hub.js').McpToolCall[]} hubToolCalls
 * @property {import('./fake-nvidia-smi.js').NvidiaSmiCall[]} nvidiaSmiCalls
 */

/**
 * @typedef {object} VerifyContext
 * @property {SelftestProfile} profile
 * @property {SelftestExpectations} expectations
 * @property {ScenarioSetup} setup
 */

const DONE_TEXT = 'SELFTEST_DONE';

/** @type {ScenarioDefinition[]} */
export const SELFTEST_SCENARIOS = [
  {
    id: 'C1',
    contract: 'C1',
    title: 'unity-code request shape: one system message, facts, no canaries, sampling, tools, usage',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: `Reply with the single word ${DONE_TEXT}.` }],
    turns: () => [{ text: DONE_TEXT }],
    verify: (observation, { profile, expectations }) => {
      const body = observation.chats.find((chat) => chat.kind === 'chat')?.body;
      if (!body) return [result('request-recorded', false, 'no agent request reached the mock endpoint')];
      return [
        result('request-recorded', true, `${observation.chats.length} requests recorded`),
        checkExitCodes(observation),
        checkSingleSystemMessage(body),
        checkSystemContains(body, FACTS_MARKER),
        checkSampling(body, { temperature: profile.temperature, topP: profile.topP, maxTokens: profile.maxOutputTokens }),
        checkToolNames(body, expectations.codeTools),
        checkIncludeUsage(body),
      ];
    },
  },
  {
    id: 'C5',
    contract: 'C5',
    title: 'cold guard block: no request reaches the model, the reason is reported, no retry',
    guard: { nvidiaSmi: 'lowVram', modelLoaded: false },
    runs: [{ agent: 'unity-code', prompt: 'Explain the guard.' }],
    turns: () => [{ text: DONE_TEXT }],
    verify: (observation) => [
      checkNoModelLoadRequests(observation.backendRequests),
      checkOutputContains(observation, GUARD_MESSAGE_PREFIX, 'guard-reason-reported'),
      checkAtMost('no-retry', observation.nvidiaSmiCalls.length, MAX_PROBE_CALLS_WITHOUT_RETRY, 'nvidia-smi calls'),
    ],
  },
  {
    id: 'C7-plugin-deleted',
    contract: 'C7',
    title: 'plugin file deleted: the model does not resolve and no request is sent',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Reply with one word.', plugin: 'deleted' }],
    turns: () => [{ text: DONE_TEXT }],
    verify: verifyFailedClosed,
  },
  {
    id: 'C7-plugin-broken',
    contract: 'C7',
    title: 'syntax error in a plugin library: the model does not resolve and no request is sent',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Reply with one word.', plugin: 'syntax-error' }],
    turns: () => [{ text: DONE_TEXT }],
    verify: verifyFailedClosed,
  },
  {
    id: 'C7-pure',
    contract: 'C7',
    title: 'OPENCODE_PURE=1: external plugins are skipped, so no request is sent',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Reply with one word.', env: { OPENCODE_PURE: '1' } }],
    turns: () => [{ text: DONE_TEXT }],
    verify: verifyFailedClosed,
  },
  {
    id: 'C8-overflow',
    contract: 'C8',
    title: 'oversized tool result: the over-budget request is not sent and compaction runs',
    large: true,
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Read the large file, then answer.' }],
    turns: (setup) => [{ toolCalls: [{ name: 'read', arguments: { filePath: setup.largeFilePath } }] }, { text: DONE_TEXT }],
    verify: (observation, context) => [
      checkAtLeast('compaction-requested', countKind(observation, 'compaction'), 1, 'compaction requests'),
      checkBudget(observation, context),
      // OpenCode 1.18.31 exits 1 after a recovered ContextOverflowError too (spike C). Require the
      // post-compaction request and answer, rather than treating the exit code as recovery evidence.
      checkAtLeast('continued-after-compaction', countKind(observation, 'chat'), 2, 'agent requests'),
      checkOutputContains(observation, DONE_TEXT, 'answer-after-compaction'),
    ],
  },
  {
    id: 'C8-loop-breaker',
    contract: 'C8',
    title: 'second overflow after a compaction: the session halts with the stop message',
    large: true,
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Read the large file, then answer.' }],
    turns: (setup) => [{ toolCalls: [{ name: 'read', arguments: { filePath: setup.largeFilePath } }] }, { text: DONE_TEXT }],
    // A summary that does not fit either: the next step overflows again with no successful step between.
    compactionTurn: (setup) => ({ text: buildFiller('summary', Math.round(setup.profile.promptBudget * setup.profile.charsPerToken)) }),
    verify: (observation, context) => [
      checkAtLeast('compaction-requested', countKind(observation, 'compaction'), 1, 'compaction requests'),
      checkBudget(observation, context),
      checkOutputContains(observation, SESSION_TOO_LARGE_TEXT, 'loop-breaker-message'),
    ],
  },
  {
    id: 'C11-editor',
    contract: 'C11',
    title: 'editor agent: allow-listed MCP tools only, argument policy applied, instructions scoped',
    editor: true,
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [
      { agent: 'unity-editor', prompt: 'Check the Unity console.' },
      { agent: 'unity-code', prompt: `Reply with the single word ${DONE_TEXT}.` },
    ],
    turns: () => [
      { toolCalls: [{ name: `${EDITOR_MCP_TOOL_PREFIX}read_console`, arguments: { action: 'clear' } }] },
      { toolCalls: [{ name: `${EDITOR_MCP_TOOL_PREFIX}run_tests`, arguments: { mode: 'PlayMode', test_names: ['SelftestSuite.Sample'] } }] },
      { toolCalls: [{ name: `${EDITOR_MCP_TOOL_PREFIX}find_gameobjects`, arguments: { search_term: 'Main Camera', unity_instance: 'OtherProject@fedcba9876543210' } }] },
      { text: DONE_TEXT },
      { text: DONE_TEXT },
    ],
    verify: verifyEditor,
  },
  {
    id: 'C12-offline',
    contract: 'C12',
    title: 'offline start: OpenCode starts, the plugin loads and the provider resolves',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{
      agent: 'unity-code',
      prompt: `Reply with the single word ${DONE_TEXT}.`,
      env: { npm_config_registry: 'http://127.0.0.1:9', OPENCODE_DISABLE_MODELS_FETCH: '1' },
    }],
    turns: () => [{ text: DONE_TEXT }],
    verify: (observation) => [
      checkExitCodes(observation),
      checkAtLeast('provider-resolved', countKind(observation, 'chat'), 1, 'agent requests'),
    ],
  },
];

/**
 * @param {{ includeEditor?: boolean, ids?: readonly string[] }} [options]
 * @returns {ScenarioDefinition[]}
 */
export function selectSelftestScenarios({ includeEditor = false, ids } = {}) {
  return SELFTEST_SCENARIOS.filter((scenario) => (includeEditor || !scenario.editor) && (!ids || ids.includes(scenario.id)));
}

/**
 * Runs every selected scenario in order and returns the record `doctor --selftest` stores per
 * OpenCode version (spec 20.4).
 * @param {object} options
 * @param {(request: LaunchRequest) => Promise<LaunchResult>} options.launch
 * @param {string} options.opencodeVersion
 * @param {string} options.cliVersion
 * @param {SelftestExpectations} options.expectations
 * @param {SelftestProfile} [options.profile]
 * @param {boolean} [options.includeEditor]
 * @param {readonly string[]} [options.ids]
 * @param {string} [options.tempRoot]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.attempts]
 * @param {(scenario: ScenarioDefinition) => void} [options.onScenarioStart]
 * @param {AbortSignal} [options.signal]
 */
export async function runSelftest(options) {
  const { launch, opencodeVersion, cliVersion, includeEditor = false, ids } = options;
  requireExpectations(options.expectations);
  const scenarios = selectSelftestScenarios({ includeEditor, ids });
  if (scenarios.length === 0 || ids?.some((id) => !scenarios.some((scenario) => scenario.id === id))) {
    throw new TypeError('self-test needs at least one known, enabled scenario');
  }
  const startedAt = new Date();
  const results = [];
  for (const scenario of scenarios) {
    options.onScenarioStart?.(scenario);
    results.push(await runScenario(scenario, { ...options, launch }));
  }
  const finishedAt = new Date();
  return {
    schemaVersion: SELFTEST_SCHEMA_VERSION,
    opencodeVersion,
    cliVersion,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    editorAgent: includeEditor,
    ok: results.every((scenario) => scenario.ok),
    scenarios: results,
  };
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {object} options
 * @param {(request: LaunchRequest) => Promise<LaunchResult>} options.launch
 * @param {SelftestExpectations} options.expectations
 * @param {SelftestProfile} [options.profile]
 * @param {string} [options.tempRoot]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.attempts]
 * @param {AbortSignal} [options.signal]
 */
export async function runScenario(scenario, options) {
  const {
    launch,
    expectations,
    profile = DEFAULT_SELFTEST_PROFILE,
    tempRoot = os.tmpdir(),
    timeoutMs = SCENARIO_TIMEOUT_MS,
    attempts = SCENARIO_ATTEMPTS,
    signal,
  } = options;
  requireExpectations(expectations);
  const startedAt = Date.now();
  let hangs = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    const scenarioSetup = await setUpScenario(scenario, { profile, tempRoot });
    try {
      const observation = await observeScenario(scenario, scenarioSetup, { launch, timeoutMs, signal });
      if (observation.timedOut && attempt < attempts) {
        hangs += 1;
        continue;
      }
      const checks = [
        ...(observation.timedOut ? [result('no-hang', false, `OpenCode did not finish within ${Math.round(timeoutMs / 1000)} s`)] : []),
        ...commonChecks(observation),
        ...scenario.verify(observation, { profile, expectations, setup: scenarioSetup }),
      ];
      const scenarioResult = buildScenarioResult(scenario, checks, { attempt, hangs, startedAt, observation });
      const targets = getLocalRedactionTargets();
      const redactor = createRedactor({ ...targets, homeDirs: [...(targets.homeDirs ?? []), scenarioSetup.root] });
      return redactor.redactValue({ ...scenarioResult,
        ...(expectations.captureRequests ? { requests: observation.chats.map(({ kind, body }) => ({ kind, body })) } : {}),
        ...(!scenarioResult.ok ? { errors: readLaunchErrors(observation) } : {}),
      });
    } finally {
      await scenarioSetup.cleanup();
    }
  }
  /* c8 ignore next */
  throw new Error(`scenario ${scenario.id} produced no result`);
}

/** Return structured error events only, never a transcript containing file contents or tool titles.
 * @param {ScenarioObservation} observation
 */
function readLaunchErrors(observation) {
  const errors = [];
  for (const run of observation.runs) {
    for (const line of run.stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'error') errors.push(event.error);
      } catch { /* Non-JSON output is not a report artifact. */ }
    }
  }
  return errors.slice(-5);
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {import('./capture-checks.js').CheckResult[]} checks
 * @param {{ attempt: number, hangs: number, startedAt: number, observation: ScenarioObservation }} context
 */
function buildScenarioResult(scenario, checks, { attempt, hangs, startedAt, observation }) {
  return {
    id: scenario.id,
    contract: scenario.contract,
    title: scenario.title,
    ok: checks.every((check) => check.ok),
    attempts: attempt,
    hangs,
    durationMs: Date.now() - startedAt,
    exitCodes: observation.runs.map((run) => run.exitCode),
    checks,
  };
}

/**
 * Checks that every scenario shares: nothing reached a native load endpoint, and no canary content
 * reached the model.
 * @param {ScenarioObservation} observation
 * @returns {import('./capture-checks.js').CheckResult[]}
 */
export function commonChecks(observation) {
  return [
    checkNoModelLoadRequests(observation.backendRequests, NATIVE_LOAD_PATHS, 'no-native-load-calls'),
    checkNoCanaries(observation.chats.map((chat) => chat.body), listCanaryMarkers()),
  ];
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {{ profile: SelftestProfile, tempRoot: string }} options
 * @returns {Promise<ScenarioSetup & { cleanup: () => Promise<void>, mocks: { backend: any, hub: any, nvidiaSmi: any } }>}
 */
async function setUpScenario(scenario, { profile, tempRoot }) {
  const root = await fsp.mkdtemp(path.join(tempRoot, `ocu-selftest-${scenario.id.toLowerCase()}-`));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const binDir = path.join(root, 'bin');
  const tmpDir = path.join(root, 'tmp');
  await Promise.all([home, projectDir, binDir, tmpDir].map((dir) => fsp.mkdir(dir, { recursive: true })));
  await writeCanaryHome(home);
  const files = buildProjectFiles(scenario, profile);
  await writeFiles(projectDir, files);

  const backend = await startMockBackend({ ollama: scenario.guard.modelLoaded ? createLoadedModelState(profile) : { models: [{ name: profile.modelTag }] } });
  const hub = scenario.editor
    ? await startMockMcpHub({ endpoints: { [DEFAULT_MCP_PATH]: { allowedToolCalls: [...EDITOR_HUB_TOOLS] } } })
    : null;
  const nvidiaSmi = await createFakeNvidiaSmi(binDir, NVIDIA_SMI_PRESETS[scenario.guard.nvidiaSmi]);

  /** @type {ScenarioSetup} */
  const scenarioSetup = {
    root,
    home,
    projectDir,
    binDir,
    largeFilePath: path.join(projectDir, ...LARGE_FILE_RELATIVE_PATH.split('/')),
    profile,
    nvidiaSmiCommand: nvidiaSmi.scriptPath,
    hubUrl: hub?.mcpUrl ?? null,
    backend: { url: backend.url, openAiBaseUrl: backend.openAiBaseUrl },
    env: buildScenarioEnv({ home, tmpDir, backendUrl: backend.url }),
  };
  backend.openai.setScript(scenario.turns(scenarioSetup));
  if (scenario.compactionTurn) backend.openai.setKindTurn('compaction', scenario.compactionTurn(scenarioSetup));

  return {
    ...scenarioSetup,
    mocks: { backend, hub, nvidiaSmi },
    cleanup: async () => {
      await backend.close();
      await hub?.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * The sandbox variables every scenario child needs. The launcher keeps the system variables it needs
 * to start a process (PATH and friends), applies the product launch environment on top, and applies
 * `run.env` last.
 * @param {{ home: string, tmpDir: string, backendUrl: string }} options
 * @returns {Record<string, string>}
 */
export function buildScenarioEnv({ home, tmpDir, backendUrl }) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TEMP: tmpDir,
    TMP: tmpDir,
    TMPDIR: tmpDir,
    OLLAMA_HOST: backendUrl,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {ScenarioSetup & { mocks: any }} scenarioSetup
 * @param {{ launch: (request: LaunchRequest) => Promise<LaunchResult>, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<ScenarioObservation>}
 */
async function observeScenario(scenario, scenarioSetup, { launch, timeoutMs, signal }) {
  const { backend, hub, nvidiaSmi } = scenarioSetup.mocks;
  const runs = [];
  let timedOut = false;
  for (const [runIndex, run] of scenario.runs.entries()) {
    const before = backend.openai.chats.length;
    const launched = await launchWithTimeout(launch, { scenario, run, runIndex, setup: scenarioSetup, timeoutMs, signal });
    runs.push({ ...launched, agent: run.agent, chats: backend.openai.chats.slice(before) });
    if (launched.timedOut) {
      timedOut = true;
      break;
    }
  }
  return {
    timedOut,
    runs,
    output: runs.map((run) => `${run.stdout}\n${run.stderr}`).join('\n'),
    chats: backend.openai.chats,
    backendRequests: backend.server.requests,
    hubMessages: hub ? hub.hub.messages : [],
    hubToolCalls: hub ? hub.hub.toolCalls : [],
    nvidiaSmiCalls: await nvidiaSmi.readCalls(),
  };
}

/**
 * @param {(request: LaunchRequest) => Promise<LaunchResult>} launch
 * @param {Omit<LaunchRequest, 'signal'> & { signal?: AbortSignal }} request
 * @returns {Promise<LaunchResult>}
 */
async function launchWithTimeout(launch, { signal, ...request }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('scenario timeout'));
        resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true });
      }, request.timeoutMs);
    });
    const launched = await Promise.race([launch({ ...request, signal: controller.signal }), timeout]);
    return { timedOut: false, ...launched };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Kept small and fictional; the launcher decides what to run on it.
const LARGE_FILE_RELATIVE_PATH = 'Assets/Scripts/SelftestLargeData.cs';
// A read returns at most 200 lines (OpenCode's own limit, clamped by the plugin per spec 8.7), so the
// file stays inside it: the class head, the filler, the closing brace and the final newline.
const LARGE_FILE_LINES = 200;

/**
 * @param {ScenarioDefinition} scenario
 * @param {SelftestProfile} profile
 * @returns {Record<string, string>}
 */
export function buildProjectFiles(scenario, profile) {
  const packages = { dependencies: { 'com.unity.test-framework': '1.4.5', ...(scenario.editor ? { 'com.coplaydev.unity-mcp': '10.1.0' } : {}) } };
  /** @type {Record<string, string>} */
  const files = {
    'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.0f1\nm_EditorVersionWithRevision: 6000.0.0f1 (0000000000f1)\n',
    'Packages/manifest.json': `${JSON.stringify(packages, null, 2)}\n`,
    'Assets/Scripts/SelftestPlayer.cs': 'using UnityEngine;\n\npublic class SelftestPlayer : MonoBehaviour\n{\n    void Start()\n    {\n        Debug.Log("selftest");\n    }\n}\n',
  };
  if (scenario.large) files[LARGE_FILE_RELATIVE_PATH] = buildLargeFile(profile);
  return files;
}

/**
 * A file whose read result is over the prompt budget for the next step (system and tools add about
 * 5,000 tokens, spec 8.8) but still fits a compaction request, which carries no tools.
 * @param {SelftestProfile} profile
 * @returns {string}
 */
function buildLargeFile(profile) {
  const targetChars = Math.round(profile.promptBudget * 0.75 * profile.charsPerToken);
  const fillerLines = LARGE_FILE_LINES - 4;
  const lineLength = Math.ceil(targetChars / fillerLines);
  const body = Array.from({ length: fillerLines }, (_, index) => {
    const filler = 'abcdefghij '.repeat(Math.ceil(lineLength / 11));
    return `    // selftest filler line ${String(index).padStart(4, '0')} ${filler}`.slice(0, lineLength);
  });
  return `public static class SelftestLargeData\n{\n${body.join('\n')}\n}\n`;
}

/**
 * @param {string} label
 * @param {number} chars
 * @returns {string}
 */
function buildFiller(label, chars) {
  const unit = `selftest ${label} filler text; it only makes the request large. `;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
}

/**
 * @param {ScenarioObservation} observation
 * @returns {import('./capture-checks.js').CheckResult[]}
 */
function verifyFailedClosed(observation) {
  return [
    checkNoModelLoadRequests(observation.backendRequests),
    checkOutputMatches(observation, MODEL_NOT_FOUND_PATTERN, 'model-not-resolved', 'the model must not resolve without the plugin'),
  ];
}

/**
 * @param {ScenarioObservation} observation
 * @param {VerifyContext} context
 * @returns {import('./capture-checks.js').CheckResult[]}
 */
function verifyEditor(observation, { expectations }) {
  const expectedMcpTools = expectations.editorMcpTools ?? DEFAULT_EDITOR_MCP_TOOLS;
  const editorBody = observation.runs[0]?.chats.find((chat) => chat.kind === 'chat')?.body;
  const codeBodies = (observation.runs[1]?.chats ?? []).filter((chat) => chat.kind === 'chat').map((chat) => chat.body);
  if (!editorBody) return [result('editor-request-recorded', false, 'no editor-agent request reached the mock endpoint')];
  const mcpTools = getToolNames(editorBody).filter((name) => name.startsWith(EDITOR_MCP_TOOL_PREFIX));
  const findCalls = observation.hubToolCalls.filter((call) => call.name === 'find_gameobjects');
  return [
    result('editor-request-recorded', true, `${observation.runs[0].chats.length} editor requests recorded`),
    checkToolNames({ tools: mcpTools.map((name) => ({ function: { name } })) }, expectedMcpTools, 'editor-mcp-tools'),
    checkSystemContains(editorBody, MOCK_HUB_INSTRUCTIONS_MARKER),
    codeBodies.length === 0
      ? result('code-session-clean', false, 'no unity-code request reached the mock endpoint')
      : checkCodeSessionWithoutMcp(codeBodies),
    checkNoneMatch('read-console-clear-rejected', observation.hubToolCalls, (call) => call.name === 'read_console' && call.arguments.action === 'clear', 'read_console calls with action clear'),
    checkNoneMatch('play-mode-rejected', observation.hubToolCalls, (call) => call.name === 'run_tests' && call.arguments.mode === 'PlayMode', 'run_tests calls in PlayMode'),
    findCalls.length === 0
      ? result('instance-argument-stripped', false, 'no find_gameobjects call reached the hub')
      : checkNoneMatch('instance-argument-stripped', findCalls, (call) => 'unity_instance' in call.arguments, 'calls carrying unity_instance'),
    checkNoneMatch('no-denied-tool-calls', observation.hubToolCalls, (call) => !call.allowed, 'calls to tools outside the allow-list'),
  ];
}

/**
 * @param {import('./capture-checks.js').CapturedChatBody[]} bodies
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkCodeSessionWithoutMcp(bodies) {
  const withMcpTools = bodies.flatMap(getToolNames).filter((name) => name.startsWith(EDITOR_MCP_TOOL_PREFIX));
  const withInstructions = bodies.filter((body) => JSON.stringify(body).includes(MOCK_HUB_INSTRUCTIONS_MARKER));
  const ok = withMcpTools.length === 0 && withInstructions.length === 0;
  return result('code-session-clean', ok, ok
    ? 'the unity-code session carries no MCP tools and no server instructions'
    : `unity-code session leaked ${withMcpTools.length} MCP tools and ${withInstructions.length} requests with server instructions`);
}

/**
 * @param {ScenarioObservation} observation
 * @param {VerifyContext} context
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkBudget(observation, { profile, expectations }) {
  const estimate = expectations.estimateTokens ?? estimatePromptTokens;
  return checkPromptsWithinBudget(observation.chats.filter((chat) => chat.kind !== 'title').map((chat) => chat.body), profile.promptBudget, estimate);
}

/**
 * @param {ScenarioObservation} observation
 * @param {import('./mock-openai.js').ChatRequestKind} kind
 * @returns {number}
 */
function countKind(observation, kind) {
  return observation.chats.filter((chat) => chat.kind === kind).length;
}

/**
 * @param {ScenarioObservation} observation
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkExitCodes(observation) {
  const failed = observation.runs.filter((run) => run.exitCode !== 0);
  return result('runs-succeeded', failed.length === 0, failed.length === 0
    ? `${observation.runs.length} runs exited 0`
    : `${failed.length} runs failed: ${failed.map((run) => `${run.agent} exit ${run.exitCode}`).join(', ')}`);
}

/**
 * @param {ScenarioObservation} observation
 * @param {string} text
 * @param {string} id
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkOutputContains(observation, text, id) {
  const ok = observation.output.includes(text);
  return result(id, ok, ok ? `output contains '${text}'` : `output does not contain '${text}'`);
}

/**
 * @param {ScenarioObservation} observation
 * @param {RegExp} pattern
 * @param {string} id
 * @param {string} label
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkOutputMatches(observation, pattern, id, label) {
  const ok = pattern.test(observation.output);
  return result(id, ok, ok ? `output matches ${pattern}` : `${label}; output does not match ${pattern}`);
}

/**
 * @param {string} id
 * @param {number} actual
 * @param {number} maximum
 * @param {string} label
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkAtMost(id, actual, maximum, label) {
  const ok = actual <= maximum;
  return result(id, ok, `${actual} ${label} (at most ${maximum} expected)`);
}

/**
 * @param {string} id
 * @param {number} actual
 * @param {number} minimum
 * @param {string} label
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkAtLeast(id, actual, minimum, label) {
  const ok = actual >= minimum;
  return result(id, ok, `${actual} ${label} (at least ${minimum} expected)`);
}

/**
 * @template T
 * @param {string} id
 * @param {readonly T[]} items
 * @param {(item: T) => boolean} predicate
 * @param {string} label
 * @returns {import('./capture-checks.js').CheckResult}
 */
function checkNoneMatch(id, items, predicate, label) {
  const matches = items.filter(predicate);
  return result(id, matches.length === 0, matches.length === 0 ? `no ${label}` : `${matches.length} ${label}`);
}

/**
 * @param {SelftestExpectations} expectations
 */
function requireExpectations(expectations) {
  if (!expectations?.codeTools?.length) {
    throw new TypeError('expectations.codeTools is required: the self-test compares the request tools with the expected set');
  }
}
