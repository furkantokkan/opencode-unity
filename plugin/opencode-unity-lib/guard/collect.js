// Collecting what the guard decides on (spec sections 7.2 and 7.7). Probes run as late and as
// parallel as possible: a loaded model needs no GPU query, a closed Unity needs no PowerShell, and
// the GPU utilization wait overlaps the CPU sampling window, so a cold check costs about 2-2.5 s.
// Probes never throw; every failure comes back as an error that decideGuard turns into a block.
import { classifyModelState } from './decide.js';
import { readNvidiaSmi } from './probes/nvidia-smi.js';
import { readOllamaPs, parseOllamaBaseUrl, isLoopbackHost } from './probes/ollama-ps.js';
import { createUnsupportedProcessProbe } from './probes/processes-unsupported.js';
import { createWin32ProcessProbe } from './probes/processes-win32.js';
import { runCommand } from './probes/run-command.js';
import { analyzeUnityProcesses } from './unity-processes.js';

// Fixed, small timeouts for the two probes the spec pins (7.2); the others follow probeTimeoutSec.
export const OLLAMA_PS_TIMEOUT_MS = 3000;
export const UNITY_DETECT_TIMEOUT_MS = 5000;

/**
 * @typedef {object} GpuFacts
 * @property {import('./probes/nvidia-smi.js').GpuMemoryReading} memory
 * @property {{ ok: true, samples: number[] } | { ok: false, samples: number[], error: string }} utilization
 * @property {number} gpuCount
 */

/**
 * @typedef {object} GuardFacts
 * @property {number} checkedAtMs
 * @property {boolean} cold                Caller asked for a cold verdict, ignoring the loaded model.
 * @property {{ host: string, loopback: boolean }} endpoint
 * @property {import('./probes/ollama-ps.js').OllamaPsReading | null} ollama  Null when the endpoint is remote.
 * @property {GpuFacts | null} gpu         Null on the loaded path, or when guard.adapter is none.
 * @property {import('./unity-processes.js').UnityFacts | null} unity        Null when the endpoint is remote.
 */

/**
 * @typedef {object} GuardProbes
 * @property {(baseUrl: string, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<import('./probes/ollama-ps.js').OllamaPsReading>} readOllamaPs
 * @property {(options: { command: string, timeoutMs: number, signal?: AbortSignal }) => Promise<import('./probes/nvidia-smi.js').NvidiaSmiReading>} readNvidiaSmi
 * @property {import('./unity-processes.js').ProcessProbe} processes
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 * @property {() => number} now
 */

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, run?: import('./probes/run-command.js').RunCommand }} [options]
 * @returns {GuardProbes}
 */
export function createDefaultProbes({ platform = process.platform, env = process.env, fetchImpl = fetch, run = runCommand } = {}) {
  return {
    readOllamaPs: (baseUrl, options) => readOllamaPs(baseUrl, { ...options, fetchImpl }),
    readNvidiaSmi: (options) => readNvidiaSmi({ ...options, run, env, platform }),
    processes: platform === 'win32' ? createWin32ProcessProbe({ run, env }) : createUnsupportedProcessProbe(platform),
    sleep,
    now: Date.now,
  };
}

/**
 * @param {object} options
 * @param {import('./config.js').GuardTarget} options.target
 * @param {import('./config.js').GuardConfig} options.config
 * @param {GuardProbes} options.probes
 * @param {boolean} [options.cold]      Judge a new load even when the model is loaded (`guard --cold`).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<GuardFacts>}
 */
export async function collectGuardFacts({ target, config, probes, cold = false, signal }) {
  const parsed = parseOllamaBaseUrl(target.baseUrl);
  const endpoint = { host: parsed ? parsed.hostname : String(target.baseUrl), loopback: parsed ? isLoopbackHost(parsed.hostname) : false };
  const checkedAtMs = probes.now();
  if (!endpoint.loopback) return { checkedAtMs, cold, endpoint, ollama: null, gpu: null, unity: null };

  const ollama = await probes.readOllamaPs(target.baseUrl, { timeoutMs: OLLAMA_PS_TIMEOUT_MS, signal });
  const model = classifyModelState(ollama, target, { keepAliveMarginSec: config.keepAliveMarginSec, nowMs: checkedAtMs, cold });
  if (model.loaded) {
    const sampleCpu = config.importWhileLoaded === 'wait';
    const unity = await collectUnity({ config, probes, signal, sampleCpu });
    return { checkedAtMs, cold, endpoint, ollama, gpu: null, unity };
  }
  const [gpu, unity] = await Promise.all([
    config.adapter === 'none' ? Promise.resolve(null) : collectGpu({ config, probes, signal }),
    collectUnity({ config, probes, signal, sampleCpu: true }),
  ]);
  return { checkedAtMs, cold, endpoint, ollama, gpu, unity };
}

/**
 * Memory and the first utilization sample come from one nvidia-smi call. The second sample is taken
 * only when the first reaches the limit, because both must reach it to block (7.3 C3).
 * @param {{ config: import('./config.js').GuardConfig, probes: GuardProbes, signal?: AbortSignal }} options
 * @returns {Promise<GpuFacts>}
 */
async function collectGpu({ config, probes, signal }) {
  const timeoutMs = config.probeTimeoutSec * 1000;
  const startedAt = probes.now();
  const first = await probes.readNvidiaSmi({ command: config.nvidiaSmiCommand, timeoutMs, signal });
  if (!first.ok) return { memory: { ok: false, error: first.error }, utilization: { ok: false, samples: [], error: first.error }, gpuCount: 0 };
  if (!first.memory.ok) {
    // A failed memory query already blocks, so the utilization query is skipped.
    return { memory: first.memory, utilization: { ok: false, samples: [], error: first.memory.error }, gpuCount: first.gpuCount };
  }
  if (!first.utilization.ok) return { memory: first.memory, utilization: { ok: false, samples: [], error: first.utilization.error }, gpuCount: first.gpuCount };
  const samples = [first.utilization.percent];
  if (first.utilization.percent < config.maxGpuUtilPercent) {
    return { memory: first.memory, utilization: { ok: true, samples }, gpuCount: first.gpuCount };
  }
  await probes.sleep(Math.max(0, startedAt + config.gpuUtilSampleIntervalMs - probes.now()), signal);
  const second = await probes.readNvidiaSmi({ command: config.nvidiaSmiCommand, timeoutMs, signal });
  if (!second.ok) return { memory: first.memory, utilization: { ok: false, samples, error: second.error }, gpuCount: first.gpuCount };
  if (!second.utilization.ok) return { memory: first.memory, utilization: { ok: false, samples, error: second.utilization.error }, gpuCount: first.gpuCount };
  samples.push(second.utilization.percent);
  return { memory: first.memory, utilization: { ok: true, samples }, gpuCount: first.gpuCount };
}

/**
 * @param {{ config: import('./config.js').GuardConfig, probes: GuardProbes, signal?: AbortSignal, sampleCpu: boolean }} options
 * @returns {Promise<import('./unity-processes.js').UnityFacts>}
 */
async function collectUnity({ config, probes, signal, sampleCpu }) {
  const patterns = config.assetImportProcessPatterns;
  const presence = await probes.processes.detect({ timeoutMs: UNITY_DETECT_TIMEOUT_MS, signal });
  const needDetails = sampleCpu || config.maxUnityEditors > 0;
  if (!presence.ok || !presence.running || !needDetails) {
    return analyzeUnityProcesses(presence, null, { patterns, cpuSampled: false });
  }
  const reading = await probes.processes.sample({
    patterns: [...patterns],
    sampleMs: config.assetImportSampleMs,
    sampleCpu,
    timeoutMs: config.probeTimeoutSec * 1000 + (sampleCpu ? config.assetImportSampleMs : 0),
    signal,
  });
  return analyzeUnityProcesses(presence, reading, { patterns, cpuSampled: sampleCpu, selfPid: process.pid });
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
