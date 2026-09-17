// Builders for guard facts, so each test states only what it is about (spec 7.3).
import { resolveGuardConfig } from '../../../plugin/opencode-unity-lib/guard/config.js';

export const NOW_MS = Date.parse('2026-09-17T12:00:00.000Z');
export const MODEL_TAG = 'ocu-model-16k';

/** @type {import('../../../plugin/opencode-unity-lib/guard/config.js').GuardTarget} */
export const TARGET = Object.freeze({ baseUrl: 'http://127.0.0.1:11434', modelTag: MODEL_TAG, numCtx: 16384 });

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/config.js').GuardConfig}
 */
export function guardConfig(overrides = {}) {
  const resolved = resolveGuardConfig({ modelVramMiB: 19000, ...overrides });
  if (!resolved.ok) throw new Error(`test config is invalid: ${resolved.errors.join('; ')}`);
  return resolved.config;
}

/**
 * @param {{ name?: string, contextLength?: number | null, expiresInSec?: number | null, expiresAt?: string | null, sizeVramMiB?: number }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js').LoadedModelEntry}
 */
export function loadedModel({ name = `${MODEL_TAG}:latest`, contextLength = 16384, expiresInSec = 1800, expiresAt, sizeVramMiB = 18500 } = {}) {
  return {
    name,
    model: name,
    contextLength,
    expiresAt: expiresAt !== undefined ? expiresAt : expiresInSec === null ? null : new Date(NOW_MS + expiresInSec * 1000).toISOString(),
    sizeVramBytes: sizeVramMiB * 1048576,
  };
}

/**
 * @param {{ freeMiB?: number, totalMiB?: number, samples?: number[], memoryError?: string, utilizationError?: string, gpuCount?: number }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/collect.js').GpuFacts}
 */
export function gpuFacts({ freeMiB = 22000, totalMiB = 24576, samples = [3], memoryError, utilizationError, gpuCount = 1 } = {}) {
  return {
    memory: memoryError === undefined ? { ok: true, totalMiB, freeMiB } : { ok: false, error: memoryError },
    utilization: utilizationError === undefined ? { ok: true, samples } : { ok: false, samples, error: utilizationError },
    gpuCount,
  };
}

/**
 * @param {{ running?: boolean, error?: string, editorCount?: number | null, importCpuPercent?: number | null, editorCpuPercent?: number | null, importCount?: number, unreadable?: Array<{ pid: number, name: string, kind: 'import' | 'editor', error: string }>, cpuSampled?: boolean, detailsRead?: boolean }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/unity-processes.js').UnityFacts}
 */
export function unityFacts({
  running = true,
  error,
  editorCount = 1,
  importCpuPercent = 2,
  editorCpuPercent = 5,
  importCount = 1,
  unreadable = [],
  cpuSampled = true,
  detailsRead = true,
} = {}) {
  if (error !== undefined) return { ok: false, error };
  const importProcesses = Array.from({ length: importCount }, (_, index) => ({
    pid: 4310 + index,
    name: 'Unity.exe',
    cpuPercent: importCpuPercent === null ? null : Math.round((importCpuPercent / importCount) * 10) / 10,
  }));
  const editors = Array.from({ length: Math.max(0, editorCount ?? 0) }, (_, index) => ({ pid: 4100 + index, name: 'Unity.exe', cpuPercent: index === 0 ? editorCpuPercent : 1 }));
  return {
    ok: true,
    running,
    detailsRead,
    editorCount,
    cpuSampled,
    elapsedMs: cpuSampled ? 1512 : null,
    importProcesses,
    importCpuPercent,
    editors,
    busiestEditorCpuPercent: cpuSampled ? editorCpuPercent : null,
    unreadable,
  };
}

/**
 * @param {{ host?: string, loopback?: boolean, cold?: boolean, ollamaError?: string, models?: import('../../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js').LoadedModelEntry[] | null, gpu?: import('../../../plugin/opencode-unity-lib/guard/collect.js').GpuFacts | null, unity?: import('../../../plugin/opencode-unity-lib/guard/unity-processes.js').UnityFacts | null, checkedAtMs?: number }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardFacts}
 */
export function guardFacts({ host = '127.0.0.1', loopback = true, cold = false, ollamaError, models = [], gpu = gpuFacts(), unity = unityFacts(), checkedAtMs = NOW_MS } = {}) {
  return {
    checkedAtMs,
    cold,
    endpoint: { host, loopback },
    ollama: ollamaError !== undefined ? { ok: false, error: ollamaError } : models === null ? null : { ok: true, models },
    gpu,
    unity,
  };
}

/**
 * @param {import('../../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} verdict
 * @returns {string[]}
 */
export function reasonIds(verdict) {
  return verdict.reasons.map((reason) => reason.id);
}
