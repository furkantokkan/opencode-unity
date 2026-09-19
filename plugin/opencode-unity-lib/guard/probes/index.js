// The platform probe interface (amendment 33.6, expansion 11.5). One implementation per platform
// family measures the six capabilities of 33.2 and answers every read with one of three shapes: ok,
// unavailable (this platform cannot measure it) or error (it tried and failed). selectProbes picks the
// implementation once, from `process.platform`, so nothing above this directory branches on the
// platform (CP-D2). A platform without a family gets unsupported.js, whose every read is unavailable,
// and the guard blocks instead of guessing.
//
// Two rules hold for every implementation because selection applies them, not because each family
// remembers to: every command runs with the C locale, so numbers and dates print the same everywhere,
// and a reader that throws, synchronously or not, answers with an error read instead.
import { runCommand } from './run-command.js';
import { createUnsupportedProbes } from './unsupported.js';
import { createWin32Probes } from './win32.js';

/**
 * @typedef {'accelerator.memory' | 'accelerator.utilization' | 'accelerator.workingSetCap' | 'process.enumerate' | 'process.cpuTime' | 'process.classify'} Capability
 */

/**
 * What an implementation says about one capability: measured and `required` or `advisory` (its class
 * in 33.2), `unavailable` (it has a meaning here but this implementation cannot measure it) or
 * `not-applicable` (33.2 "n/a": the capability does not exist on this platform, so no rule reads it).
 * @typedef {'required' | 'advisory' | 'unavailable' | 'not-applicable'} CapabilityStatus
 */

/**
 * @template T
 * @typedef {{ status: 'ok', value: T, source: string, sampledAt: number }
 *   | { status: 'unavailable', capability: Capability, reason: string, detail: string }
 *   | { status: 'error', capability: Capability, reason: string, detail: string }} Read
 */

/**
 * @typedef {{ totalMiB: number, freeMiB: number, unit: 'vram' | 'unified' }} AcceleratorMemory
 * @typedef {{ percent: number }} AcceleratorUtilization
 * @typedef {{ running: boolean, count: number }} UnityPresenceValue
 */

/**
 * One read answers both accelerator capabilities: nvidia-smi reports them in one process start, and
 * the first utilization sample has to come with the memory figures (spec 7.2).
 * @typedef {object} AcceleratorSample
 * @property {number} deviceCount    Accelerators the backend listed; 0 when it listed none.
 * @property {Read<AcceleratorMemory>} memory
 * @property {Read<AcceleratorUtilization>} utilization
 */

/**
 * @typedef {object} AcceleratorRequest
 * @property {string} nvidiaSmiCommand   `guard.nvidiaSmiCommand`
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} PresenceRequest
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} PlatformProbes
 * @property {string} id                       The implementation: 'win32' or 'unsupported'.
 * @property {string} platform                 The `process.platform` it was selected for.
 * @property {'nvidia-smi' | 'amdgpu-sysfs' | 'darwin-unified' | 'none'} backend
 * @property {Readonly<Record<Capability, CapabilityStatus>>} capabilities
 * @property {number | null} cpuTimeResolutionMs   Null when process.cpuTime is not measured (CP-D9).
 * @property {(request: AcceleratorRequest) => Promise<AcceleratorSample>} readAccelerator
 * @property {(request: PresenceRequest) => Promise<Read<UnityPresenceValue>>} readUnityPresence   Fast check: is any Unity process running?
 * @property {(request: import('../unity-processes.js').SampleRequest) => Promise<Read<import('../unity-processes.js').ProcessSnapshot>>} readProcessSnapshot
 */

/**
 * What every implementation factory receives.
 * @typedef {object} ProbeContext
 * @property {string} platform
 * @property {Record<string, string | undefined>} env
 * @property {import('./run-command.js').RunCommand} run   Already runs every command with the C locale.
 * @property {() => number} now
 */

/** The class of each capability (33.2). An implementation may lower none of them. */
export const CAPABILITY_CLASSES = Object.freeze({
  'accelerator.memory': 'required',
  'accelerator.utilization': 'advisory',
  'accelerator.workingSetCap': 'advisory',
  'process.enumerate': 'required',
  'process.cpuTime': 'required',
  'process.classify': 'required',
});

/** @type {Readonly<Record<string, (context: ProbeContext) => PlatformProbes>>} */
const k_families = Object.freeze({
  win32: createWin32Probes,
});

/** The platforms that have a probe family in this version; every other one gets unsupported.js. */
export const PROBE_FAMILIES = Object.freeze(Object.keys(k_families));

const k_localeNames = Object.freeze(['LC_ALL', 'LANG']);

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined>, run?: import('./run-command.js').RunCommand, now?: () => number }} [options]
 * @returns {PlatformProbes}
 */
export function selectProbes({ platform = process.platform, env = process.env, run = runCommand, now = Date.now } = {}) {
  const create = Object.hasOwn(k_families, platform) ? k_families[platform] : createUnsupportedProbes;
  return catchReaderFailures(create({ platform, env, run: withCLocale(run, platform), now }));
}

/**
 * Wraps a command runner so every command it starts sees `LC_ALL=C` and `LANG=C`. On Windows,
 * where variable names ignore case, every other spelling of the two names is dropped first; the
 * child would otherwise keep whichever spelling Windows finds first.
 * @param {import('./run-command.js').RunCommand} run
 * @param {string} platform
 * @returns {import('./run-command.js').RunCommand}
 */
export function withCLocale(run, platform) {
  return (file, args, options) => run(file, args, { ...options, env: setCLocale(options.env ?? process.env, platform) });
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} platform
 * @returns {Record<string, string | undefined>}
 */
function setCLocale(env, platform) {
  const isLocaleName = platform === 'win32'
    ? (/** @type {string} */ key) => k_localeNames.includes(key.toUpperCase())
    : (/** @type {string} */ key) => k_localeNames.includes(key);
  /** @type {Record<string, string | undefined>} */
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isLocaleName(key)) result[key] = value;
  }
  for (const name of k_localeNames) result[name] = 'C';
  return result;
}

/**
 * Turns a reader that throws or rejects into one that answers with an error read, so one broken
 * implementation blocks the guard with a reason instead of crashing whoever asked.
 * @param {PlatformProbes} probes
 * @returns {PlatformProbes}
 */
export function catchReaderFailures(probes) {
  const failure = (/** @type {unknown} */ error) => `the ${probes.id} probe failed unexpectedly (${describeError(error)})`;
  return {
    ...probes,
    async readAccelerator(request) {
      try {
        return await probes.readAccelerator(request);
      } catch (error) {
        const detail = failure(error);
        return { deviceCount: 0, memory: createErrorRead('accelerator.memory', detail), utilization: createErrorRead('accelerator.utilization', detail) };
      }
    },
    async readUnityPresence(request) {
      try {
        return await probes.readUnityPresence(request);
      } catch (error) {
        return createErrorRead('process.enumerate', failure(error));
      }
    },
    async readProcessSnapshot(request) {
      try {
        return await probes.readProcessSnapshot(request);
      } catch (error) {
        return createErrorRead('process.enumerate', failure(error));
      }
    },
  };
}

/**
 * @param {Capability} capability
 * @param {string} detail
 * @returns {{ status: 'error', capability: Capability, reason: string, detail: string }}
 */
function createErrorRead(capability, detail) {
  return { status: 'error', capability, reason: 'probe_failed', detail };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
