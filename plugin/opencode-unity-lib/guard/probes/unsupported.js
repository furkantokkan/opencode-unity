// The probe for a platform no family ships for in this version (amendment 33.6). It measures nothing
// and spawns nothing: every capability reads unavailable with reason `no_probe`, so the guard blocks on
// the required ones instead of guessing, and a caller can name exactly what is missing.

/** @type {Readonly<Record<import('./index.js').Capability, import('./index.js').CapabilityStatus>>} */
export const UNSUPPORTED_CAPABILITIES = Object.freeze({
  'accelerator.memory': 'unavailable',
  'accelerator.utilization': 'unavailable',
  'accelerator.workingSetCap': 'unavailable',
  'process.enumerate': 'unavailable',
  'process.cpuTime': 'unavailable',
  'process.classify': 'unavailable',
});

/**
 * @param {Pick<import('./index.js').ProbeContext, 'platform'>} context
 * @returns {import('./index.js').PlatformProbes}
 */
export function createUnsupportedProbes({ platform }) {
  const missing = (/** @type {import('./index.js').Capability} */ capability) => ({
    status: /** @type {const} */ ('unavailable'),
    capability,
    reason: 'no_probe',
    detail: `no probe for ${capability} ships for ${platform} in this version`,
  });
  return {
    id: 'unsupported',
    platform,
    backend: 'none',
    capabilities: UNSUPPORTED_CAPABILITIES,
    cpuTimeResolutionMs: null,
    readAccelerator: async () => ({ deviceCount: 0, memory: missing('accelerator.memory'), utilization: missing('accelerator.utilization') }),
    readUnityPresence: async () => missing('process.enumerate'),
    readProcessSnapshot: async () => missing('process.enumerate'),
  };
}
