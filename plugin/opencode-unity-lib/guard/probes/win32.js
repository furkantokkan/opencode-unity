// The Windows probe family behind the platform interface (amendment 33.6, expansion 11.5.3): nvidia-smi
// for the accelerator, tasklist for the fast Unity check and the PowerShell Win32_Process script for
// the process snapshot. It runs exactly the commands it ran before the interface existed; each answer
// is only restated as a read, with the same error text as its detail.
import { readNvidiaSmi } from './nvidia-smi.js';
import { createWin32ProcessProbe } from './processes-win32.js';

/** @type {Readonly<Record<import('./index.js').Capability, import('./index.js').CapabilityStatus>>} */
export const WIN32_CAPABILITIES = Object.freeze({
  'accelerator.memory': 'required',
  'accelerator.utilization': 'advisory',
  // The Metal working-set cap exists only on unified memory (33.2 "n/a").
  'accelerator.workingSetCap': 'not-applicable',
  'process.enumerate': 'required',
  'process.cpuTime': 'required',
  'process.classify': 'required',
});

// Process.TotalProcessorTime counts in 100 ns ticks.
const k_cpuTimeResolutionMs = 0.0001;

/**
 * @param {import('./index.js').ProbeContext} context
 * @returns {import('./index.js').PlatformProbes}
 */
export function createWin32Probes({ env, run, now }) {
  const processes = createWin32ProcessProbe({ run, env });
  return {
    id: 'win32',
    platform: 'win32',
    backend: 'nvidia-smi',
    capabilities: WIN32_CAPABILITIES,
    cpuTimeResolutionMs: k_cpuTimeResolutionMs,
    async readAccelerator({ nvidiaSmiCommand, timeoutMs, signal }) {
      const reading = await readNvidiaSmi({ command: nvidiaSmiCommand, timeoutMs, signal, run, env, platform: 'win32' });
      if (!reading.ok) {
        return { deviceCount: 0, memory: createErrorRead('accelerator.memory', reading.error), utilization: createErrorRead('accelerator.utilization', reading.error) };
      }
      const sampledAt = now();
      return {
        deviceCount: reading.gpuCount,
        memory: reading.memory.ok
          ? { status: 'ok', value: { totalMiB: reading.memory.totalMiB, freeMiB: reading.memory.freeMiB, unit: 'vram' }, source: 'nvidia-smi', sampledAt }
          : createErrorRead('accelerator.memory', reading.memory.error),
        utilization: reading.utilization.ok
          ? { status: 'ok', value: { percent: reading.utilization.percent }, source: 'nvidia-smi', sampledAt }
          : createErrorRead('accelerator.utilization', reading.utilization.error),
      };
    },
    async readUnityPresence({ timeoutMs, signal }) {
      const presence = await processes.detect({ timeoutMs, signal });
      if (!presence.ok) return createErrorRead('process.enumerate', presence.error);
      return { status: 'ok', value: { running: presence.running, count: presence.count }, source: 'tasklist', sampledAt: now() };
    },
    async readProcessSnapshot(request) {
      const reading = await processes.sample(request);
      if (!reading.ok) return createErrorRead('process.enumerate', reading.error);
      return { status: 'ok', value: reading.snapshot, source: 'win32-probe.ps1', sampledAt: now() };
    },
  };
}

/**
 * @param {import('./index.js').Capability} capability
 * @param {string} detail
 * @returns {{ status: 'error', capability: import('./index.js').Capability, reason: string, detail: string }}
 */
function createErrorRead(capability, detail) {
  return { status: 'error', capability, reason: 'probe_failed', detail };
}
