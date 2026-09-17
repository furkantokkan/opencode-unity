// GPU memory and utilization from nvidia-smi (spec section 7.2). One query returns both, so the
// first utilization sample costs no extra process start. Only GPU index 0 is measured (7.9). Any
// output that is not exactly what the query asks for is an error: the guard fails closed on it.
import { resolveInvocation, runCommand, summarizeOutput } from './run-command.js';

export const NVIDIA_SMI_QUERY_ARGS = Object.freeze([
  '--query-gpu=index,memory.total,memory.free,utilization.gpu',
  '--format=csv,noheader,nounits',
]);

export const DEFAULT_NVIDIA_SMI_COMMAND = 'nvidia-smi';

/**
 * @typedef {{ ok: true, totalMiB: number, freeMiB: number } | { ok: false, error: string }} GpuMemoryReading
 * @typedef {{ ok: true, percent: number } | { ok: false, error: string }} GpuUtilizationReading
 * @typedef {{ ok: true, gpuCount: number, memory: GpuMemoryReading, utilization: GpuUtilizationReading }} NvidiaSmiSuccess
 * @typedef {NvidiaSmiSuccess | { ok: false, error: string }} NvidiaSmiReading
 */

/**
 * Parses the output of NVIDIA_SMI_QUERY_ARGS: one `index, memory.total, memory.free, utilization.gpu`
 * line per GPU, whole MiB and percent. Memory and utilization are judged separately, because some
 * GPUs report `[N/A]` utilization while their memory figures are valid.
 * @param {string} text
 * @returns {NvidiaSmiReading}
 */
export function parseNvidiaSmiOutput(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: 'nvidia-smi printed nothing' };
  /** @type {string[] | undefined} */
  let firstGpu;
  for (const line of lines) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length !== 4 || !/^\d+$/.test(fields[0])) {
      return { ok: false, error: `unexpected nvidia-smi output '${summarizeOutput(text, 80)}'` };
    }
    if (Number(fields[0]) === 0) firstGpu = fields;
  }
  if (!firstGpu) return { ok: false, error: 'nvidia-smi did not list GPU index 0' };
  const [, total, free, utilization] = firstGpu;
  return { ok: true, gpuCount: lines.length, memory: parseMemory(total, free), utilization: parseUtilization(utilization) };
}

/**
 * @typedef {object} NvidiaSmiOptions
 * @property {number} timeoutMs
 * @property {string} [command]       `guard.nvidiaSmiCommand`
 * @property {import('./run-command.js').RunCommand} [run]
 * @property {string} [platform]
 * @property {Record<string, string | undefined>} [env]
 * @property {AbortSignal} [signal]
 */

/**
 * Runs the query once. Never throws.
 * @param {NvidiaSmiOptions} options
 * @returns {Promise<NvidiaSmiReading>}
 */
export async function readNvidiaSmi({ timeoutMs, command = DEFAULT_NVIDIA_SMI_COMMAND, run = runCommand, platform = process.platform, env = process.env, signal }) {
  /** @type {ReturnType<typeof resolveInvocation>} */
  let invocation;
  try {
    invocation = resolveInvocation(command, NVIDIA_SMI_QUERY_ARGS, { platform, env });
  } catch (error) {
    return { ok: false, error: `nvidia-smi command is not usable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = await run(invocation.file, invocation.args, {
    timeoutMs,
    env,
    platform,
    signal,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (!result.ok) {
    const output = summarizeOutput(`${result.stdout} ${result.stderr}`, 80);
    return { ok: false, error: `nvidia-smi ${result.error}${output ? `: ${output}` : ''}` };
  }
  return parseNvidiaSmiOutput(result.stdout);
}

/**
 * @param {string} total
 * @param {string} free
 * @returns {GpuMemoryReading}
 */
function parseMemory(total, free) {
  if (!/^\d+$/.test(total) || !/^\d+$/.test(free)) {
    return { ok: false, error: `nvidia-smi memory figures '${total}, ${free}' are not whole MiB` };
  }
  const totalMiB = Number(total);
  const freeMiB = Number(free);
  if (freeMiB > totalMiB) return { ok: false, error: `nvidia-smi reports more free memory (${freeMiB} MiB) than total (${totalMiB} MiB)` };
  return { ok: true, totalMiB, freeMiB };
}

/**
 * @param {string} value
 * @returns {GpuUtilizationReading}
 */
function parseUtilization(value) {
  if (!/^\d+$/.test(value) || Number(value) > 100) {
    return { ok: false, error: `nvidia-smi utilization '${value}' is not a percent` };
  }
  return { ok: true, percent: Number(value) };
}
