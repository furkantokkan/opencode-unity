// Platform detection and support-tier resolution (amendment 33.2-33.4; CP-D1, CP-D11).
//
// The support matrix lives in tiers.json as data, not as branches: a row is a platform configuration,
// the first matching row wins, and every row states a tier for every command. A configuration the
// matrix never thought about therefore lands on the explicit fallback row instead of quietly
// inheriting the behaviour of the nearest one.
//
// Nothing here spawns a process or opens a socket. The accelerator backend is an input, because
// resolving it means reading sysfs or running nvidia-smi, which is the probe layer's job; the matrix
// only distinguishes backends to label the Linux amdgpu row as experimental.
import fs from 'node:fs';
import os from 'node:os';

import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';

export const TIERS_URL = new URL('./tiers.json', import.meta.url);
export const TIERS_SCHEMA_URL = new URL('../../schema/tiers.schema.json', import.meta.url);

/** Worst last, so the highest index of two tiers is the effective one (amendment 33.4). */
export const TIER_ORDER = Object.freeze(['full', 'degraded', 'experimental', 'refused']);

/** Windows 10 22H2. Ollama refuses anything older (claim 93). */
export const WINDOWS_MIN_BUILD = 19045;

/** Darwin 23 is macOS 14 Sonoma, the oldest release Ollama supports (claim 108). */
export const DARWIN_MIN_MAJOR = 23;

/** `/proc/1/cgroup` names one of these when pid 1 runs inside a container (CP-D11). */
const CONTAINER_CGROUP_PATTERN = /\b(?:docker|containerd|lxc|kubepods)\b/;

const PROC_VERSION_PATH = '/proc/version';
const PROC_INIT_CGROUP_PATH = '/proc/1/cgroup';
const DOCKER_ENV_PATH = '/.dockerenv';

/** @typedef {'full' | 'degraded' | 'experimental' | 'refused'} Tier */
/** @typedef {'nvidia-smi' | 'amdgpu-sysfs' | 'darwin-unified' | 'none' | 'unknown'} AcceleratorBackend */
/** @typedef {'wsl' | 'container' | null} Virtualization */

/**
 * The families the agent's shell classifier models (amendment 33.7). `cmd` is modelled so a command
 * string written for it can be denied, but no v0.1 row starts the product's own shell as cmd.
 * @typedef {'posix' | 'powershell' | 'cmd'} ShellFamily
 */

/**
 * @typedef {object} PlatformFacts
 * @property {NodeJS.Platform} os
 * @property {string} arch
 * @property {string} release           `os.release()`, kept for reports.
 * @property {boolean | null} osVersionSupported  null when this platform has no documented minimum.
 * @property {Virtualization} virtualization
 * @property {string[]} virtualizationSignals     Which probes fired, for doctor's finding.
 * @property {ShellFamily} shellFamily
 * @property {AcceleratorBackend} backend
 */

/**
 * @typedef {object} TierResult
 * @property {string} command
 * @property {string} row                Matching row id in tiers.json.
 * @property {string} rowLabel
 * @property {Tier} tier
 * @property {boolean} degraded          True on a degraded tier, and on an experimental tier that also degrades.
 * @property {string[]} notMeasured      Capability ids this row cannot measure.
 * @property {boolean} noShippedPreset
 * @property {boolean} experimentalBackend
 * @property {boolean} errorFinding      doctor must report `reason` as an ERROR even though the command runs.
 * @property {string | null} reason      Reason id.
 * @property {string | null} message     The verbatim sentence for `reason`.
 * @property {string | null} note
 */

/** @type {Record<string, any> | undefined} */
let tiersCache;

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let tiersValidator;

/**
 * @returns {Record<string, any>}
 */
export function readTiersSchema() {
  return JSON.parse(fs.readFileSync(TIERS_SCHEMA_URL, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validateTiers(value) {
  tiersValidator ??= compileSchema(readTiersSchema());
  return tiersValidator(value);
}

/**
 * The shipped matrix, validated once. A shipped file that fails its own schema is a build error, not a
 * user error, so this throws rather than producing an exit code.
 * @param {{ url?: URL, cache?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function loadTiers({ url = TIERS_URL, cache = true } = {}) {
  if (cache && tiersCache !== undefined && url === TIERS_URL) return tiersCache;
  const value = JSON.parse(fs.readFileSync(url, 'utf8'));
  const errors = validateTiers(value);
  if (errors.length > 0) throw new TypeError(`Invalid support matrix: ${formatSchemaErrors(errors)}`);
  if (cache && url === TIERS_URL) tiersCache = value;
  return value;
}

/**
 * @param {Tier} first
 * @param {Tier} second
 * @returns {Tier}
 */
export function worstTier(first, second) {
  return TIER_ORDER.indexOf(second) > TIER_ORDER.indexOf(first) ? second : first;
}

/**
 * Whether the OS version itself rules the platform out. `null` means "no documented minimum for this
 * OS", which is not the same as "supported" and never selects the refusal row.
 * @param {{ platform?: NodeJS.Platform, release?: string }} [options]
 * @returns {boolean | null}
 */
export function isOsVersionSupported({ platform = process.platform, release = os.release() } = {}) {
  if (platform === 'win32') {
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(release);
    if (parts === null) return null;
    const major = Number(parts[1]);
    if (major !== 10) return major > 10;
    return Number(parts[3]) >= WINDOWS_MIN_BUILD;
  }
  if (platform === 'darwin') {
    const major = /^(\d+)\./.exec(release);
    return major === null ? null : Number(major[1]) >= DARWIN_MIN_MAJOR;
  }
  return null;
}

/**
 * WSL and container detection (CP-D11). Both are refused as a launch host because every probe
 * succeeds inside them and enumerates only that namespace, so the guard would return a confident
 * pass while an import runs on the host.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, readFile?: (path: string) => string | null, exists?: (path: string) => boolean }} [options]
 * @returns {{ kind: Virtualization, signals: string[] }}
 */
export function detectVirtualization({
  platform = process.platform,
  env = process.env,
  readFile = readTextFile,
  exists = fileExists,
} = {}) {
  /** @type {string[]} */
  const signals = [];
  // Windows inherits WSL_DISTRO_NAME across the interop boundary, so on win32 the variable says which
  // distribution is installed, not that this process runs inside it.
  if (platform !== 'win32' && nonEmpty(env.WSL_DISTRO_NAME) !== undefined) signals.push('WSL_DISTRO_NAME');
  if (/microsoft/i.test(readFile(PROC_VERSION_PATH) ?? '')) signals.push(PROC_VERSION_PATH);
  if (signals.length > 0) return { kind: 'wsl', signals };

  if (exists(DOCKER_ENV_PATH)) signals.push(DOCKER_ENV_PATH);
  if (CONTAINER_CGROUP_PATTERN.test(readFile(PROC_INIT_CGROUP_PATH) ?? '')) signals.push(PROC_INIT_CGROUP_PATH);
  return signals.length > 0 ? { kind: 'container', signals } : { kind: null, signals };
}

/**
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {ShellFamily}
 */
export function resolveShellFamily({ platform = process.platform } = {}) {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.release]
 * @param {AcceleratorBackend} [options.backend]  Resolved by the probe layer; `unknown` before it runs.
 * @param {(path: string) => string | null} [options.readFile]
 * @param {(path: string) => boolean} [options.exists]
 * @returns {PlatformFacts}
 */
export function detectPlatform({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  release = os.release(),
  backend = 'unknown',
  readFile = readTextFile,
  exists = fileExists,
} = {}) {
  const virtualization = detectVirtualization({ platform, env, readFile, exists });
  return {
    os: platform,
    arch,
    release,
    osVersionSupported: isOsVersionSupported({ platform, release }),
    virtualization: virtualization.kind,
    virtualizationSignals: virtualization.signals,
    shellFamily: resolveShellFamily({ platform }),
    backend,
  };
}

/**
 * The first row whose every stated condition holds. The last row of tiers.json states none, so this
 * always returns something.
 * @param {PlatformFacts} facts
 * @param {{ tiers?: Record<string, any> }} [options]
 * @returns {Record<string, any>}
 */
export function selectTierRow(facts, { tiers = loadTiers() } = {}) {
  const row = tiers.rows.find((/** @type {Record<string, any>} */ candidate) => matchesRow(candidate.match, facts));
  if (row === undefined) throw new TypeError('The support matrix has no fallback row');
  return row;
}

/**
 * Whether the matrix states a tier for this command id. The CLI gate asks first, because a command the
 * matrix has never heard of is a registry mistake to surface, not a platform refusal to report.
 * @param {string} command
 * @param {{ tiers?: Record<string, any> }} [options]
 * @returns {boolean}
 */
export function coversCommand(command, { tiers = loadTiers() } = {}) {
  return tiers.commands.includes(command);
}

/**
 * @param {string} command  A command id from tiers.json, for example 'start' or 'shape-no-model'.
 * @param {PlatformFacts} facts
 * @param {{ tiers?: Record<string, any> }} [options]
 * @returns {TierResult}
 */
export function resolveTier(command, facts, { tiers = loadTiers() } = {}) {
  if (!coversCommand(command, { tiers })) throw new TypeError(`The support matrix does not cover the command '${command}'`);
  const row = selectTierRow(facts, { tiers });
  const cell = row.tiers[command];
  if (cell === undefined) throw new TypeError(`The support matrix row '${row.id}' has no cell for '${command}'`);
  const reason = cell.reason ?? null;
  if (reason !== null && !Object.hasOwn(tiers.reasons, reason)) {
    throw new TypeError(`The support matrix row '${row.id}' names an unknown reason '${reason}'`);
  }
  return {
    command,
    row: row.id,
    rowLabel: row.label,
    tier: cell.tier,
    degraded: cell.degraded === true || cell.tier === 'degraded',
    notMeasured: [...(cell.notMeasured ?? [])],
    noShippedPreset: cell.noShippedPreset === true,
    experimentalBackend: cell.experimentalBackend === true,
    errorFinding: cell.errorFinding === true,
    reason,
    message: reason === null ? null : tiers.reasons[reason],
    note: cell.note ?? null,
  };
}

/**
 * Every command's tier for one machine, which is what the platform block and `--print-platform` print.
 * @param {PlatformFacts} facts
 * @param {{ tiers?: Record<string, any> }} [options]
 * @returns {Record<string, TierResult>}
 */
export function resolveTiers(facts, { tiers = loadTiers() } = {}) {
  return Object.fromEntries(tiers.commands.map((/** @type {string} */ command) => [command, resolveTier(command, facts, { tiers })]));
}

/**
 * The `data.platform` object every platform-caused exit 8 carries (amendment 33.9).
 * @param {PlatformFacts} facts
 * @param {TierResult} result
 * @returns {{ os: NodeJS.Platform, arch: string, backend: AcceleratorBackend, tier: Tier, reason: string | null, notMeasured: string[] }}
 */
export function describePlatform(facts, result) {
  return {
    os: facts.os,
    arch: facts.arch,
    backend: facts.backend,
    tier: result.tier,
    reason: result.reason,
    notMeasured: [...result.notMeasured],
  };
}

/**
 * @param {Record<string, any>} match
 * @param {PlatformFacts} facts
 * @returns {boolean}
 */
function matchesRow(match, facts) {
  if (match.os !== undefined && !match.os.includes(facts.os)) return false;
  if (match.arch !== undefined && !match.arch.includes(facts.arch)) return false;
  if (match.backend !== undefined && !match.backend.includes(facts.backend)) return false;
  if (match.virtualization !== undefined && (facts.virtualization === null || !match.virtualization.includes(facts.virtualization))) return false;
  if (match.osVersionSupported !== undefined && match.osVersionSupported !== facts.osVersionSupported) return false;
  return true;
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
