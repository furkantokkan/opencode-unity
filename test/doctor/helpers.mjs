// Synthetic doctor contexts for the pure check tests.
//
// The default is a healthy, installed Windows machine: every check that applies passes. A test then
// changes the one fact it is about with `makeContext({ ... })`, so a failing assertion points at that
// fact and not at an accident of the machine running the suite.
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { getHomePaths } from '../../src/core/paths.js';
import { resolveTier, resolveTiers, describePlatform } from '../../src/core/platform.js';
import { loadPreset } from '../../src/core/presets.js';
import { buildRuntimeProfile, loadCompat } from '../../src/core/profile.js';
import { parseShowResponse } from '../../src/ollama/client.js';
import { resolveCapabilities } from '../../src/doctor/capabilities.js';
import { runChecks } from '../../src/doctor/engine.js';

export const CLI_VERSION = '0.1.0';
export const HOME = path.resolve(path.sep, 'ocu-test', 'home');
export const PROJECT_ROOT = path.resolve(path.sep, 'ocu-test', 'projects', 'sample');

/** @type {Readonly<import('../../src/core/platform.js').PlatformFacts>} */
export const WINDOWS_FACTS = Object.freeze({
  os: 'win32',
  arch: 'x64',
  release: '10.0.26100',
  osVersionSupported: true,
  virtualization: null,
  virtualizationSignals: [],
  shellFamily: 'powershell',
  backend: 'nvidia-smi',
});

/** @type {Readonly<import('../../src/core/platform.js').PlatformFacts>} */
export const MAC_FACTS = Object.freeze({
  os: 'darwin',
  arch: 'arm64',
  release: '24.0.0',
  osVersionSupported: true,
  virtualization: null,
  virtualizationSignals: [],
  shellFamily: 'posix',
  backend: 'darwin-unified',
});

/** @type {Readonly<import('../../src/core/platform.js').PlatformFacts>} */
export const LINUX_FACTS = Object.freeze({
  os: 'linux',
  arch: 'x64',
  release: '6.8.0',
  osVersionSupported: null,
  virtualization: null,
  virtualizationSignals: [],
  shellFamily: 'posix',
  backend: 'nvidia-smi',
});

const PRESET = loadPreset(DEFAULT_CONFIG.preset);
const RUNTIME = buildRuntimeProfile({ config: DEFAULT_CONFIG, preset: PRESET, cliVersion: CLI_VERSION, home: HOME });

/**
 * The profile's own model, as `/api/show` describes a correctly created tag.
 * @returns {import('../../src/ollama/client.js').ShowResult}
 */
export function healthyShow() {
  return parseShowResponse({
    parameters: `num_ctx                        ${RUNTIME.profile.provider.numCtx}\ntemperature                    0.7`,
    renderer: PRESET.model.renderer,
    parser: PRESET.model.parser,
    system: '',
    template: '',
    details: {},
    model_info: {},
    capabilities: ['completion', 'tools'],
  });
}

/**
 * @param {import('../../src/core/platform.js').PlatformFacts} facts
 * @param {{ nvidiaSmiWorks?: boolean }} [options]
 */
export function platformInfoFor(facts, { nvidiaSmiWorks = facts.backend === 'nvidia-smi' } = {}) {
  const doctorTier = resolveTier('doctor', facts);
  const tiers = resolveTiers(facts);
  return {
    facts,
    doctorTier,
    tiers,
    block: describePlatform(facts, doctorTier),
    capabilities: resolveCapabilities({ facts, nvidiaSmiWorks }),
    refusedCommands: Object.values(tiers).filter((tier) => tier.tier === 'refused').map((tier) => tier.command),
  };
}

/** A passing guard verdict with a memory reading, as decideGuard produces on a quiet machine. */
export function passingVerdict({ freeMiB = 23000, totalMiB = 24576 } = {}) {
  return {
    verdict: 'pass',
    pass: true,
    path: 'cold',
    mode: null,
    reasons: [],
    notes: ['ocu-qwen3-coder-30b-16k is not loaded'],
    cacheSec: 3,
    checkedAt: '2026-09-18T10:00:00.000Z',
    target: { modelTag: RUNTIME.profile.provider.modelTag, numCtx: RUNTIME.profile.provider.numCtx },
    model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
    measurements: {
      gpu: { memory: { ok: true, totalMiB, freeMiB }, utilization: { ok: true, samples: [3] }, gpuCount: 1 },
      unity: null,
      loadedModels: [],
    },
  };
}

/** The permission block the rendered profile carries for the code agent, reduced to what the tuples need. */
export function profilePermission() {
  return {
    edit: { '*': 'allow', '*.unity': 'deny', '*.prefab': 'deny', '*.asset': 'deny', '*.meta': 'deny', 'ProjectSettings/*': 'deny', 'Packages/manifest.json': 'deny', '*.csproj': 'deny', '*.asmdef': 'deny' },
    read: { '*': 'allow', '*.unity': 'deny', '.env': 'deny' },
    bash: { '*': 'deny', 'dotnet build *': 'allow' },
    external_directory: 'deny',
    webfetch: 'deny',
    task: 'deny',
    doom_loop: 'deny',
  };
}

/** A user OpenCode config layer with a well-formed model entry. */
export function healthyLayer(overrides = {}) {
  return {
    path: path.join(HOME, 'profile', CLI_VERSION, 'opencode.jsonc'),
    origin: 'profile',
    value: {
      provider: {
        'opencode-unity': {
          models: {
            [RUNTIME.profile.provider.modelTag]: {
              limit: { context: RUNTIME.profile.provider.limit.context, output: RUNTIME.profile.provider.limit.output },
              temperature: true,
            },
          },
        },
      },
      permission: profilePermission(),
      ...overrides,
    },
    error: null,
  };
}

/**
 * @param {Record<string, any>} [overrides]  Shallow per section: `{ ollama: { reachable: false } }`
 *   replaces only `reachable`. `platformInfo` may be given as facts via `facts`.
 * @returns {import('../../src/doctor/context.js').DoctorContext}
 */
export function makeContext(overrides = {}) {
  const facts = overrides.facts ?? WINDOWS_FACTS;
  const platform = facts.os;
  const paths = getHomePaths(HOME, { platform: process.platform });
  const compat = loadCompat();
  const base = {
    cliVersion: CLI_VERSION,
    nowMs: Date.parse('2026-09-18T10:00:00.000Z'),
    platform,
    env: {},
    options: { projectPath: PROJECT_ROOT, profile: null, deep: false, strict: false, redact: false, logsOverride: null },
    platformInfo: platformInfoFor(facts),
    home: { dir: HOME, paths, installed: true, config: DEFAULT_CONFIG, userConfig: {}, configWarnings: [], configError: null },
    profileInfo: {
      presetId: PRESET.id,
      preset: PRESET,
      presetError: null,
      presetRefusal: null,
      runtime: RUNTIME.profile,
      vram: RUNTIME.vram,
      error: null,
      warnings: [],
      rendered: true,
      renderedConfigPath: paths.profile(CLI_VERSION).opencodeConfig,
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      loopback: true,
      reachable: true,
      error: null,
      version: compat.ollama.tested,
      testedVersion: compat.ollama.tested,
      models: [{ name: `${RUNTIME.profile.provider.modelTag}:latest`, model: `${RUNTIME.profile.provider.modelTag}:latest`, sizeBytes: 1, digest: null, modifiedAt: null, details: {} }],
      show: healthyShow(),
      running: [],
      requestedRoutes: [],
    },
    opencode: {
      binary: { path: path.join(HOME, 'bin', 'opencode'), version: compat.opencode.tested, error: null },
      testedVersion: compat.opencode.tested,
      config: { layers: [healthyLayer()], target: 'profile', warnings: [] },
      deep: null,
    },
    logs: {
      source: { kind: 'file', path: path.join(HOME, 'server.log'), rotation: 'server-*.log' },
      read: true,
      unreadableReason: null,
      fix: 'start Ollama so it writes its server log, or pass --logs <path>',
      summary: emptySummary(),
      recent: emptySummary(),
      log: null,
    },
    gpu: { verdict: passingVerdict(), error: null, lock: { state: 'free' }, driverResets: { checked: true, events: 0, since: '2026-09-11T10:00:00.000Z', error: null } },
    project: {
      path: PROJECT_ROOT,
      root: PROJECT_ROOT,
      projectId: 'sample-0123abcd',
      scan: healthyScan(),
      scanError: null,
      projectJson: null,
      factsText: null,
      factsPath: null,
      initialized: false,
      inputsHash: null,
    },
    node: { prefix: path.join(HOME, 'node'), modulesDir: path.join(HOME, 'node', 'node_modules'), source: 'derived from the Node installation prefix', writable: true, checkedPath: path.join(HOME, 'node') },
    delegate: { legacySkillsPath: null },
    warnings: [],
  };
  const merged = /** @type {Record<string, any>} */ ({ ...base });
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'facts') continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return /** @type {any} */ (merged);
}

/** @returns {import('../../src/ollama/server-log.js').ServerLogSummary} */
export function emptySummary() {
  return {
    chatCompletionRequests: 0,
    truncations: 0,
    truncatedPromptTokens: null,
    truncationLimits: [],
    samplers: 0,
    defaultSamplers: 0,
    cudaErrors: 0,
    kvCacheType: null,
  };
}

/** A scan result with the fields the checks read, for a project in good shape. */
export function healthyScan(overrides = {}) {
  return {
    root: PROJECT_ROOT,
    projectName: 'sample',
    unity: { editorVersion: '6000.0.23f1', stream: '6000.0', support: 'reference-tested', warnings: [] },
    projectFiles: { generated: true, csproj: [{ name: 'Assembly-CSharp.csproj' }] },
    staleness: { stale: false, count: 0, examples: [], missingScripts: 0, missingAssemblies: 0 },
    dotnet: { checked: true, present: true, sdks: ['8.0.100'] },
    instructionFiles: [],
    opencodeDir: false,
    local: { hubUrl: 'http://127.0.0.1:8080/mcp', hubUrlSource: 'package-default', hubLoopback: true },
    vcs: { kind: 'git', source: 'marker', depth: 0, marker: '.git', found: [] },
    ...overrides,
  };
}

/**
 * Runs one check against a context and returns its findings.
 * @param {import('../../src/doctor/engine.js').CheckSpec} check
 * @param {import('../../src/doctor/context.js').DoctorContext} context
 */
export function runOne(check, context) {
  return runChecks(context, { checks: [check] }).findings;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
