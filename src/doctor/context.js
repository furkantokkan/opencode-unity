// Everything doctor looks at, collected once (spec 5.4).
//
// This is the only layer in `src/doctor/` that touches a file, a process or a socket. Checks read the
// result and stay pure, which is what makes the two invariants of 5.4 testable: a run reaches the
// Ollama API on the configured endpoint and nothing else, and it never reaches a model-load route.
//
// Nothing here throws for a condition on the machine. A missing file, an unparseable config or an
// unreachable server is a fact to report, so every collector records its own failure and returns.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../core/config.js';
import { findExecutable, runProcess } from '../core/exec.js';
import { readGpuLock } from '../core/lock.js';
import { getHomeDir, getHomePaths, getProjectId, resolveLogSource } from '../core/paths.js';
import { detectPlatform, describePlatform, resolveTier, resolveTiers } from '../core/platform.js';
import { assertPresetAllowed, loadPreset } from '../core/presets.js';
import { assertProfileAllowed, buildRuntimeProfile, loadCompat } from '../core/profile.js';
import { getLocalRedactionTargets } from '../core/redact.js';
import { getInputsHash } from '../facts/stale.js';
import { createOllamaClient, describeBaseUrlSafely } from '../ollama/client.js';
import { buildLaunchContent, renderLaunchContentEnv } from '../opencode/content.js';
import { buildLaunchEnv } from '../opencode/launch-env.js';
import { buildUnityCodePermission } from '../opencode/render.js';
import { readProjectSettings } from '../project/session.js';
import { createNodeFsView } from '../unity/fs-view.js';
import { parseDotnetSdks } from '../unity/project-files.js';
import { findUnityProjectRoot } from '../unity/root.js';
import { scanUnityProject } from '../unity/scan.js';
import { createDefaultProbes } from '../../plugin/opencode-unity-lib/guard/collect.js';
import { evaluateGuard } from '../../plugin/opencode-unity-lib/guard/evaluate.js';
import { isLoopbackHost, parseOllamaBaseUrl } from '../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js';
import { hasAmdgpuCard, resolveBackend, resolveCapabilities } from './capabilities.js';
import { runDeepProbes } from './deep.js';
import { readDriverResets } from './driver-resets.js';
import { readLogSource } from './logs.js';
import { resolveGlobalPrefix } from './node-install.js';
import { collectConfigLayers, createReadIo } from './opencode-config.js';
import { locateOpencode, readOpencodeVersion } from './opencode-binary.js';

/** Default sysfs root for the AMD backend label (amendment 33.5 `guard.amdgpuSysfsRoot`). */
const AMDGPU_SYSFS_ROOT = '/sys/class/drm';

/** Read-only Ollama endpoints are fast or absent; nothing here waits on a slow server. */
const OLLAMA_TIMEOUT_MS = 3000;

/** `dotnet --list-sdks` is a version query; a machine where it is slower than this has other problems. */
const DOTNET_TIMEOUT_MS = 15_000;

/** Codex kept skills here before the documented path; doctor only reports copies (spec D18). */
const CODEX_LEGACY_SKILLS = '.codex/skills';

/** @typedef {import('../core/platform.js').PlatformFacts} PlatformFacts */
/** @typedef {import('../core/platform.js').TierResult} TierResult */

/**
 * @typedef {object} DoctorOptions
 * @property {string | null} projectPath   Absolute, from the positional, --project or the cwd.
 * @property {boolean | null} profile      Null means "decide from what is installed".
 * @property {boolean} deep
 * @property {boolean} strict
 * @property {boolean} redact
 * @property {string | null} logsOverride
 */

/**
 * @typedef {object} DoctorContext
 * @property {string} cliVersion
 * @property {number} nowMs
 * @property {NodeJS.Platform} platform
 * @property {Record<string, string | undefined>} env
 * @property {DoctorOptions} options
 * @property {PlatformInfo} platformInfo
 * @property {HomeInfo} home
 * @property {ProfileInfo} profileInfo
 * @property {OllamaInfo} ollama
 * @property {OpencodeInfo} opencode
 * @property {import('./logs.js').LogReading} logs
 * @property {GpuInfo} gpu
 * @property {ProjectInfo} project
 * @property {import('./node-install.js').GlobalPrefix} node
 * @property {{ legacySkillsPath: string | null }} delegate
 * @property {string[]} warnings
 */

/**
 * @typedef {object} PlatformInfo
 * @property {PlatformFacts} facts
 * @property {TierResult} doctorTier
 * @property {Record<string, TierResult>} tiers
 * @property {ReturnType<typeof describePlatform>} block
 * @property {import('./capabilities.js').CapabilityState[]} capabilities
 * @property {string[]} refusedCommands
 */

/**
 * @typedef {object} HomeInfo
 * @property {string} dir
 * @property {ReturnType<typeof getHomePaths>} paths
 * @property {boolean} installed          True when config.json exists: `setup` has run here.
 * @property {import('../core/config.js').Config} config
 * @property {Record<string, any>} userConfig
 * @property {string[]} configWarnings
 * @property {string | null} configError
 */

/**
 * @typedef {object} ProfileInfo
 * @property {string} presetId
 * @property {import('../core/presets.js').Preset | null} preset
 * @property {string | null} presetError
 * @property {string | null} presetRefusal   Why the preset is not allowed here without --experimental.
 * @property {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile | null} runtime
 * @property {import('../core/vram.js').VramEstimate | null} vram
 * @property {string | null} error
 * @property {string[]} warnings
 * @property {boolean} rendered             The profile assets exist under <home>/profile/<version>/.
 * @property {string} renderedConfigPath
 */

/**
 * @typedef {object} OllamaInfo
 * @property {string} baseUrl
 * @property {boolean} loopback
 * @property {boolean} reachable
 * @property {string | null} error
 * @property {string | null} version
 * @property {string} testedVersion
 * @property {import('../ollama/client.js').InstalledModel[]} models
 * @property {import('../ollama/client.js').ShowResult | null} show
 * @property {import('../ollama/client.js').RunningModel[]} running
 * @property {string[]} requestedRoutes     Every route the run asked for, for the invariant test.
 */

/**
 * @typedef {object} OpencodeInfo
 * @property {import('./opencode-binary.js').OpencodeBinary} binary
 * @property {string} testedVersion
 * @property {import('./opencode-config.js').ConfigLayers} config
 * @property {import('./deep.js').DeepResult | null} deep
 */

/**
 * @typedef {object} GpuInfo
 * @property {import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict | null} verdict
 * @property {string | null} error
 * @property {ReturnType<typeof readGpuLock> | null} lock
 * @property {{ checked: boolean, events: number, since: string | null, error: string | null }} driverResets
 */

/**
 * @typedef {object} ProjectInfo
 * @property {string} path                   Where doctor was pointed.
 * @property {string | null} root            The Unity project root, when there is one.
 * @property {string | null} projectId
 * @property {ReturnType<typeof scanUnityProject> | null} scan
 * @property {string | null} scanError
 * @property {Record<string, any> | null} projectJson
 * @property {string | null} factsText
 * @property {string | null} factsPath
 * @property {boolean} initialized
 * @property {string | null} inputsHash    What the facts would hash to right now.
 */

/**
 * @typedef {object} ContextDependencies
 * @property {typeof fetch} [fetchImpl]
 * @property {typeof runProcess} [run]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {import('./opencode-config.js').ReadIo} [io]
 * @property {import('../unity/fs-view.js').FsView} [fsView]
 * @property {(filePath: string) => Promise<string | null>} [readLogFile]
 * @property {() => number} [now]
 * @property {string} [homedir]
 * @property {string} [hostname]
 * @property {string} [username]
 * @property {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} [locate]
 * @property {(target: string) => boolean} [exists]
 * @property {(dir: string) => string[]} [readdir]
 * @property {(target: string) => string | null} [readlink]
 * @property {(options: object) => Promise<import('./deep.js').DeepResult>} [runDeep]
 * @property {string} [arch]                          Default process.arch; tests judge other rows with it.
 * @property {string} [release]                       Default os.release().
 * @property {(target: string) => string | null} [readSystemFile]  /proc reads for the virtualization probe.
 * @property {(target: string) => boolean} [isWritable]  For the global npm prefix check.
 * @property {string} [execPath]                     Default process.execPath.
 * @property {PlatformFacts} [platformFacts]         The machine the support matrix judges, as in
 *   `src/cli/main.js`. Detected when absent; injected by tests so a Windows runner can judge the macOS
 *   row while its own paths and processes stay those of the host.
 */

/**
 * @param {object} input
 * @param {string} input.cliVersion
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {DoctorOptions} input.options
 * @param {AbortSignal} [input.signal]
 * @param {ContextDependencies} [input.deps]
 * @returns {Promise<DoctorContext>}
 */
export async function collectDoctorContext({ cliVersion, env, platform, options, signal, deps = {} }) {
  const {
    fetchImpl = globalThis.fetch,
    run = runProcess,
    io = createReadIo(),
    fsView = createNodeFsView(),
    readLogFile,
    now = Date.now,
    homedir = os.homedir(),
    locate = findExecutable,
    exists = (/** @type {string} */ target) => fsSync.existsSync(target),
    readdir = safeReaddir,
    readlink = safeReadlink,
  } = deps;
  /** @type {string[]} */
  const warnings = [];

  const home = await collectHome({ env, platform, homedir, warnings });
  const platformInfo = collectPlatform({
    env,
    platform,
    locate,
    readdir,
    readlink,
    arch: deps.arch ?? process.arch,
    release: deps.release ?? os.release(),
    readSystemFile: deps.readSystemFile,
    exists,
    injectedFacts: deps.platformFacts,
  });
  const profileInfo = collectProfile({ home, cliVersion, platform, arch: platformInfo.facts.arch, exists, warnings });
  const dotnetSdks = await collectDotnetSdks({ env, platform, run, locate, signal });
  const project = collectProject({ options, env, home, platform, fsView, exists, dotnetSdks });

  const probes = deps.probes ?? createDefaultProbes({ platform, env, fetchImpl });
  const logSource = resolveLogSource({ env, platform, homedir, configuredPath: options.logsOverride ?? home.config.ollama.serverLogPath, exists });
  // Independent readers run together: the guard's sampling window alone is most of a second, and
  // nothing below reads another's result.
  const [ollama, opencode, logs, gpu] = await Promise.all([
    collectOllama({ home, profileInfo, fetchImpl, signal }),
    collectOpencode({ env, platform, project, profileInfo, options, io, locate, isFile: exists, run, signal, deps, home, cliVersion }),
    readLogSource({ source: logSource, numCtx: profileInfo.runtime?.provider.numCtx, signal, env, platform, readFile: readLogFile, run, nowMs: now() }),
    collectGpu({ home, profileInfo, probes, platform, env, run, locate, signal, now, nowMs: now() }),
  ]);
  warnings.push(...opencode.config.warnings);
  const nodeInstall = resolveGlobalPrefix({
    env,
    platform,
    exists,
    ...(deps.isWritable === undefined ? {} : { isWritable: deps.isWritable }),
    ...(deps.execPath === undefined ? {} : { execPath: deps.execPath }),
  });

  return Object.freeze({
    cliVersion,
    nowMs: now(),
    platform,
    env,
    options,
    platformInfo,
    home,
    profileInfo,
    ollama,
    opencode,
    logs,
    gpu,
    project,
    node: nodeInstall,
    delegate: { legacySkillsPath: findLegacySkills({ homedir, platform, exists }) },
    warnings,
  });
}

/**
 * Redaction targets for `--redact` and `--markdown`: what this run touched, plus the local identity
 * values the report would otherwise carry into an issue (spec P5).
 * @param {DoctorContext} context
 * @param {{ env?: Record<string, string | undefined>, homedir?: string, hostname?: string }} [overrides]
 * @returns {import('../core/redact.js').RedactionTargets}
 */
export function buildRedactionTargets(context, overrides = {}) {
  const projectPaths = [context.project.root, context.project.path].filter((value) => typeof value === 'string');
  const projectNames = [context.project.scan?.projectName].filter((value) => typeof value === 'string');
  const targets = getLocalRedactionTargets({
    env: overrides.env ?? context.env,
    homedir: overrides.homedir ?? os.homedir(),
    hostname: overrides.hostname ?? os.hostname(),
    projectPaths,
    projectNames,
  });
  return { ...targets, homeDirs: [...(targets.homeDirs ?? []), context.home.dir] };
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {string} input.homedir
 * @param {string[]} input.warnings
 * @returns {Promise<HomeInfo>}
 */
async function collectHome({ env, platform, homedir, warnings }) {
  const dir = getHomeDir({ env, platform, homedir });
  const paths = getHomePaths(dir, { platform });
  try {
    const loaded = await loadConfig(paths.config);
    warnings.push(...loaded.warnings);
    return { dir, paths, installed: loaded.exists, config: loaded.config, userConfig: loaded.user, configWarnings: loaded.warnings, configError: null };
  } catch (cause) {
    // The file is there and unusable, which is a configured machine with a broken configuration: the
    // severity policy must not treat it as "nothing is installed here".
    return {
      dir,
      paths,
      installed: true,
      config: DEFAULT_CONFIG,
      userConfig: {},
      configWarnings: [],
      configError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} input.locate
 * @param {(dir: string) => string[]} input.readdir
 * @param {(target: string) => string | null} input.readlink
 * @param {string} input.arch
 * @param {string} input.release
 * @param {((target: string) => string | null) | undefined} input.readSystemFile
 * @param {(target: string) => boolean} input.exists
 * @param {PlatformFacts | undefined} input.injectedFacts
 * @returns {PlatformInfo}
 */
function collectPlatform({ env, platform, locate, readdir, readlink, arch, release, readSystemFile, exists, injectedFacts }) {
  const nvidiaSmiPresent = locate('nvidia-smi', { env, platform }) !== null;
  const amdgpuPresent = platform === 'linux' && hasAmdgpuCard(AMDGPU_SYSFS_ROOT, { readdir, readlink });
  const backend = resolveBackend({ platform, nvidiaSmiPresent, amdgpuPresent });
  const facts = injectedFacts ?? detectPlatform({
    platform,
    arch,
    release,
    env,
    backend,
    ...(readSystemFile === undefined ? {} : { readFile: readSystemFile, exists }),
  });
  const doctorTier = resolveTier('doctor', facts);
  const tiers = resolveTiers(facts);
  return {
    facts,
    doctorTier,
    tiers,
    block: describePlatform(facts, doctorTier),
    capabilities: resolveCapabilities({ facts, nvidiaSmiWorks: nvidiaSmiPresent }),
    refusedCommands: Object.values(tiers).filter((tier) => tier.tier === 'refused').map((tier) => tier.command),
  };
}

/**
 * @param {object} input
 * @param {HomeInfo} input.home
 * @param {string} input.cliVersion
 * @param {NodeJS.Platform} input.platform
 * @param {string} input.arch
 * @param {(target: string) => boolean} input.exists
 * @param {string[]} input.warnings
 * @returns {ProfileInfo}
 */
function collectProfile({ home, cliVersion, platform, arch, exists, warnings }) {
  const presetId = home.config.preset;
  const renderedConfigPath = home.paths.profile(cliVersion).opencodeConfig;
  const rendered = exists(renderedConfigPath);
  /** @type {ProfileInfo} */
  const base = {
    presetId,
    preset: null,
    presetError: null,
    presetRefusal: null,
    runtime: null,
    vram: null,
    error: null,
    warnings: [],
    rendered,
    renderedConfigPath,
  };
  /** @type {import('../core/presets.js').Preset} */
  let preset;
  try {
    preset = loadPreset(presetId);
  } catch (cause) {
    return { ...base, presetError: cause instanceof Error ? cause.message : String(cause) };
  }
  /** @type {string | null} */
  let presetRefusal = null;
  try {
    assertPresetAllowed(preset, { experimental: home.config.experimental.presets, platform, arch });
  } catch (cause) {
    presetRefusal = cause instanceof Error ? cause.message : String(cause);
  }
  try {
    const result = buildRuntimeProfile({ config: home.config, userConfig: home.userConfig, preset, cliVersion, home: home.dir });
    warnings.push(...result.warnings);
    let profileRefusal = presetRefusal;
    try {
      assertProfileAllowed(result.profile, { experimental: home.config.experimental.presets });
    } catch (cause) {
      profileRefusal ??= cause instanceof Error ? cause.message : String(cause);
    }
    return { ...base, preset, presetRefusal: profileRefusal, runtime: result.profile, vram: result.vram, warnings: result.warnings };
  } catch (cause) {
    return { ...base, preset, presetRefusal, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * @param {object} input
 * @param {DoctorOptions} input.options
 * @param {Record<string, string | undefined>} input.env
 * @param {HomeInfo} input.home
 * @param {NodeJS.Platform} input.platform
 * @param {import('../unity/fs-view.js').FsView} input.fsView
 * @param {(target: string) => boolean} input.exists
 * @param {string[] | null} input.dotnetSdks
 * @returns {ProjectInfo}
 */
function collectProject({ options, env, home, platform, fsView, exists, dotnetSdks }) {
  const projectPath = options.projectPath ?? process.cwd();
  const root = findUnityProjectRoot(fsView, projectPath);
  /** @type {ProjectInfo} */
  const base = {
    path: projectPath,
    root,
    projectId: null,
    scan: null,
    scanError: null,
    projectJson: null,
    factsText: null,
    factsPath: null,
    initialized: false,
    inputsHash: null,
  };
  if (root === null) return base;
  const projectId = getProjectId(root, { platform });
  const projectPaths = home.paths.project(projectId);
  const projectJson = readJsonFile(projectPaths.projectJson, exists);
  const factsText = exists(projectPaths.facts) ? readTextFile(projectPaths.facts) : null;
  /** @type {ReturnType<typeof scanUnityProject> | null} */
  let scan = null;
  /** @type {string | null} */
  let scanError = null;
  /** @type {string | null} */
  let inputsHash = null;
  try {
    scan = scanUnityProject(fsView, root, { env, dotnetSdks });
    inputsHash = getInputsHash(fsView, root, { env });
  } catch (cause) {
    scanError = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    ...base,
    projectId,
    scan,
    scanError,
    projectJson,
    factsText,
    factsPath: projectPaths.facts,
    initialized: projectJson !== null,
    inputsHash,
  };
}

/**
 * The installed .NET SDKs, for the compile check. `dotnet --list-sdks` is a local read-only version
 * query, like nvidia-smi; when the executable is absent the answer is "none", not "not checked".
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {typeof runProcess} input.run
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} input.locate
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<string[] | null>}
 */
async function collectDotnetSdks({ env, platform, run, locate, signal }) {
  const binary = locate('dotnet', { env, platform });
  if (binary === null) return [];
  const result = await run(binary, ['--list-sdks'], { timeoutMs: DOTNET_TIMEOUT_MS, env, platform, signal });
  if (result.error !== null || result.timedOut || result.exitCode !== 0) return null;
  return parseDotnetSdks(result.stdout);
}

/**
 * Only the read-only endpoints of spec 4.5 are called: version, tags, show and ps. `requestedRoutes`
 * records what was asked for, so a test can assert the list rather than trust the code.
 * @param {object} input
 * @param {HomeInfo} input.home
 * @param {ProfileInfo} input.profileInfo
 * @param {typeof fetch} input.fetchImpl
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<OllamaInfo>}
 */
async function collectOllama({ home, profileInfo, fetchImpl, signal }) {
  const baseUrl = home.config.ollama.baseUrl;
  /** @type {string[]} */
  const requestedRoutes = [];
  const tracking = (/** @type {string | URL | Request} */ input, /** @type {RequestInit | undefined} */ init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    requestedRoutes.push(url.pathname);
    return fetchImpl(input, init);
  };
  /** @type {ReturnType<typeof createOllamaClient>} */
  let client;
  try {
    client = createOllamaClient({ baseUrl, fetch: /** @type {typeof fetch} */ (tracking), timeoutMs: OLLAMA_TIMEOUT_MS });
  } catch (cause) {
    // A base URL the client refuses is exactly what doctor exists to report, so it becomes the
    // `ollama.reachable` finding rather than an abort before the report (and its redactor) runs.
    const safe = describeBaseUrlSafely(baseUrl);
    const origin = parseOllamaBaseUrl(safe);
    return {
      baseUrl: safe,
      loopback: origin !== null && isLoopbackHost(origin.hostname),
      reachable: false,
      error: cause instanceof Error ? cause.message : String(cause),
      version: null,
      testedVersion: loadCompat().ollama.tested,
      models: [],
      show: null,
      running: [],
      requestedRoutes,
    };
  }
  const modelTag = profileInfo.runtime?.provider.modelTag ?? null;
  const parsed = parseOllamaBaseUrl(client.baseUrl);
  /** @type {OllamaInfo} */
  const base = {
    baseUrl: client.baseUrl,
    loopback: parsed !== null && isLoopbackHost(parsed.hostname),
    reachable: false,
    error: null,
    version: null,
    testedVersion: loadCompat().ollama.tested,
    models: [],
    show: null,
    running: [],
    requestedRoutes,
  };
  try {
    const version = await client.getVersion({ signal });
    const [models, running] = await Promise.all([client.listModels({ signal }), client.listRunning({ signal })]);
    const show = modelTag === null ? null : await client.showModel(modelTag, { signal }).catch(() => null);
    return { ...base, reachable: true, version, models, running, show };
  } catch (cause) {
    return { ...base, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {ProjectInfo} input.project
 * @param {ProfileInfo} input.profileInfo
 * @param {DoctorOptions} input.options
 * @param {import('./opencode-config.js').ReadIo} input.io
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} input.locate
 * @param {(target: string) => boolean} input.isFile
 * @param {typeof runProcess} input.run
 * @param {AbortSignal | undefined} input.signal
 * @param {ContextDependencies} input.deps
 * @param {HomeInfo} input.home
 * @param {string} input.cliVersion
 * @returns {Promise<OpencodeInfo>}
 */
async function collectOpencode({ env, platform, project, profileInfo, options, io, locate, isFile, run, signal, deps, home, cliVersion }) {
  const binary = await readOpencodeVersion({
    env,
    platform,
    signal,
    run,
    locate: (/** @type {{ env: Record<string, string | undefined>, platform: NodeJS.Platform }} */ inner) => locateOpencode({ ...inner, locate, isFile }),
  });
  const useProfile = options.profile ?? (profileInfo.rendered && project.initialized);
  const config = collectConfigLayers({
    env,
    projectPath: project.root ?? project.path,
    profileConfigPath: useProfile ? profileInfo.renderedConfigPath : null,
    worktreeRoot: resolveWorktreeRoot(project, platform),
    io,
  });
  const runDeep = deps.runDeep ?? runDeepProbes;
  // With the profile the probes must see what `start` launches (spec 5.4, 8.1): the clean-room env,
  // not the user's own OpenCode setup, whose config dirs they would otherwise also write into.
  const probeEnv = options.deep && useProfile ? buildProfileProbeEnv({ env, home, project, cliVersion }) : env;
  const deep = options.deep ? await runDeep({ binary, env: probeEnv, platform, cwd: project.root ?? project.path, signal, run }) : null;
  return { binary, testedVersion: loadCompat().opencode.tested, config, deep };
}

/**
 * The launch environment `start` would build for this project, per-launch content included when the
 * project has facts to point at.
 * @param {{ env: Record<string, string | undefined>, home: HomeInfo, project: ProjectInfo, cliVersion: string }} input
 * @returns {Record<string, string>}
 */
export function buildProfileProbeEnv({ env, home, project, cliVersion }) {
  const projectId = project.projectId ?? 'doctor';
  /** @type {string | undefined} */
  let configContent;
  if (project.factsPath) {
    const compileMap = Array.isArray(project.projectJson?.compileMap) ? project.projectJson.compileMap : [];
    const csprojNames = [...new Set(compileMap.map((/** @type {{ csproj?: unknown }} */ row) => row?.csproj).filter((name) => typeof name === 'string'))];
    const permission = buildUnityCodePermission({
      vcsKind: project.projectJson?.vcs?.kind ?? null,
      bashMode: readProjectSettings(home.config, projectId).bashMode ?? home.config.safety.bashMode,
      csprojNames,
      safety: home.config.safety,
    });
    configContent = renderLaunchContentEnv(buildLaunchContent({ factsPath: project.factsPath, unityCodePermission: permission }));
  }
  return buildLaunchEnv({
    env,
    home: home.dir,
    profileDir: home.paths.profile(cliVersion).dir,
    xdgConfigDir: home.paths.xdgConfig,
    projectId,
    configContent,
  }).env;
}

/**
 * @param {object} input
 * @param {HomeInfo} input.home
 * @param {ProfileInfo} input.profileInfo
 * @param {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} input.probes
 * @param {NodeJS.Platform} input.platform
 * @param {Record<string, string | undefined>} input.env
 * @param {typeof runProcess} input.run
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} input.locate
 * @param {AbortSignal | undefined} input.signal
 * @param {() => number} input.now
 * @param {number} input.nowMs
 * @returns {Promise<GpuInfo>}
 */
async function collectGpu({ home, profileInfo, probes, platform, env, run, locate, signal, now, nowMs }) {
  const lock = readGpuLock(home.paths.gpuLock, { now });
  const runtime = profileInfo.runtime;
  const driverResets = await readDriverResets({ platform, env, run, locate, signal, nowMs });
  /** @type {GpuInfo} */
  const base = { verdict: null, error: null, lock, driverResets };
  if (runtime === null) return { ...base, error: 'the runtime profile could not be built, so the guard has no target' };
  try {
    const verdict = await evaluateGuard({
      target: { modelTag: runtime.provider.modelTag, numCtx: runtime.provider.numCtx, baseUrl: runtime.ollama.baseUrl },
      config: runtime.guard,
      probes,
      signal,
    });
    return { ...base, verdict };
  } catch (cause) {
    return { ...base, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * @param {object} input
 * @param {string} input.homedir
 * @param {NodeJS.Platform} input.platform
 * @param {(target: string) => boolean} input.exists
 * @returns {string | null}
 */
function findLegacySkills({ homedir, platform, exists }) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const target = api.join(homedir, ...CODEX_LEGACY_SKILLS.split('/'));
  return exists(target) ? target : null;
}

/**
 * @param {string} target
 * @param {(target: string) => boolean} exists
 * @returns {Record<string, any> | null}
 */
function readJsonFile(target, exists) {
  if (!exists(target)) return null;
  try {
    const value = JSON.parse(fsSync.readFileSync(target, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function readTextFile(target) {
  try {
    return fsSync.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddir(dir) {
  try {
    return fsSync.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function safeReadlink(target) {
  try {
    return fsSync.readlinkSync(target);
  } catch {
    return null;
  }
}

/**
 * The outermost directory OpenCode walks to for project configuration and instruction files: the VCS
 * worktree root when the scan found a marker, else null for "up to the filesystem root".
 * @param {ProjectInfo} project
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
export function resolveWorktreeRoot(project, platform) {
  const depth = project.scan?.vcs.depth;
  if (project.root === null || typeof depth !== 'number') return null;
  const api = platform === 'win32' ? path.win32 : path.posix;
  let current = project.root;
  for (let step = 0; step < depth; step += 1) current = api.dirname(current);
  return current;
}
