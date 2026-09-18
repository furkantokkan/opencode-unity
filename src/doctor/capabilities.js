// Which guard capabilities this machine can actually measure, and which of them the guard needs.
//
// The support matrix (src/core/tiers.json) names the capabilities and says which ones a row leaves
// unmeasured. That is the shipped expectation. This module answers the narrower question doctor asks:
// on this machine, right now, is there a probe behind each capability at all? A row can promise
// `accelerator.memory` and still have no nvidia-smi installed.
import { getPathApi } from '../core/paths.js';

/** @typedef {import('../core/platform.js').PlatformFacts} PlatformFacts */
/** @typedef {import('../core/platform.js').AcceleratorBackend} AcceleratorBackend */

/**
 * Amendment 33.2: without these the guard cannot judge a cold load at all - it cannot see free memory,
 * and it cannot see a Unity import running. The two advisory ones sharpen the decision, and their
 * absence degrades a verdict rather than blocking it (CP-D3).
 */
export const REQUIRED_CAPABILITIES = Object.freeze(['accelerator.memory', 'process.enumerate', 'process.cpuTime', 'process.classify']);

/** Amendment 33.2: the Metal working-set cap only exists where memory is unified. */
const DARWIN_ONLY_CAPABILITIES = Object.freeze(['accelerator.workingSetCap']);

/**
 * @typedef {object} CapabilityState
 * @property {string} id
 * @property {boolean} applicable  False where the capability has no meaning (33.2 "n/a").
 * @property {boolean} measured
 * @property {boolean} required
 * @property {string} source       The probe behind it, or why there is none.
 */

/**
 * The accelerator backend, from what is installed rather than from what the platform usually has.
 * v0.1 ships one accelerator probe (nvidia-smi), so anything else is named honestly and left
 * unmeasured instead of being guessed at.
 * @param {object} input
 * @param {NodeJS.Platform} input.platform
 * @param {boolean} input.nvidiaSmiPresent
 * @param {boolean} [input.amdgpuPresent]
 * @returns {AcceleratorBackend}
 */
export function resolveBackend({ platform, nvidiaSmiPresent, amdgpuPresent = false }) {
  if (nvidiaSmiPresent) return 'nvidia-smi';
  if (platform === 'darwin') return 'darwin-unified';
  if (platform === 'linux' && amdgpuPresent) return 'amdgpu-sysfs';
  return 'none';
}

/**
 * True when at least one card directory under the sysfs root has a device driver link that resolves to
 * the amdgpu driver.
 * @param {string} sysfsRoot
 * @param {{ readdir: (dir: string) => string[], readlink: (target: string) => string | null }} io
 * @returns {boolean}
 */
export function hasAmdgpuCard(sysfsRoot, { readdir, readlink }) {
  const api = getPathApi('linux');
  return readdir(sysfsRoot)
    .filter((name) => /^card\d+$/.test(name))
    .some((name) => /(?:^|[/\\])amdgpu$/.test(readlink(api.join(sysfsRoot, name, 'device', 'driver')) ?? ''));
}

/**
 * @param {object} input
 * @param {PlatformFacts} input.facts
 * @param {boolean} input.nvidiaSmiWorks   nvidia-smi is installed and answered a query.
 * @returns {CapabilityState[]}
 */
export function resolveCapabilities({ facts, nvidiaSmiWorks }) {
  const accelerator = nvidiaSmiWorks
    ? { measured: true, source: 'nvidia-smi' }
    : { measured: false, source: `no accelerator probe ships for backend '${facts.backend}' in this version` };
  // Only the win32 process probe exists (spec 17); everywhere else processes-unsupported.js reports
  // every process capability as unavailable, which is what makes those rows degraded.
  const processes = facts.os === 'win32'
    ? { measured: true, source: 'win32 process probe' }
    : { measured: false, source: `no process probe ships for ${facts.os} in this version` };
  return [
    state(facts, 'accelerator.memory', accelerator),
    state(facts, 'accelerator.utilization', accelerator),
    state(facts, 'accelerator.workingSetCap', { measured: false, source: 'no probe reads the Metal working-set cap in this version' }),
    state(facts, 'process.enumerate', processes),
    state(facts, 'process.cpuTime', processes),
    state(facts, 'process.classify', processes),
  ];
}

/**
 * @param {PlatformFacts} facts
 * @param {string} id
 * @param {{ measured: boolean, source: string }} result
 * @returns {CapabilityState}
 */
function state(facts, id, result) {
  const applicable = !DARWIN_ONLY_CAPABILITIES.includes(id) || facts.os === 'darwin';
  return {
    id,
    applicable,
    measured: applicable && result.measured,
    required: REQUIRED_CAPABILITIES.includes(id),
    source: applicable ? result.source : `not applicable on ${facts.os}`,
  };
}
