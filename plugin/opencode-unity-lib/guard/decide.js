// The guard decision (spec section 7.3). Pure: it turns collected facts into a verdict, so every row
// of the table is unit-testable without a GPU, Unity or Ollama. It collects every reason it finds and
// blocks when there is at least one. Anything unreadable is a reason, so the guard fails closed.
import { formatGiB } from './messages.js';

/**
 * @typedef {'remote_unguarded' | 'ollama_unreachable' | 'too_many_editors' | 'import_busy' | 'probe_failed' | 'vram_low' | 'gpu_busy'} GuardReasonId
 * @typedef {'stop' | 'retry'} GuardMode
 * @typedef {'settings' | 'nvidia-smi-memory' | 'nvidia-smi-utilization' | 'processes' | 'guard'} ProbeName
 */

/**
 * @typedef {{ cpuPercent: number, limitPercent: number, processCount: number }} ImportBusyPart
 * @typedef {{ workers: ImportBusyPart | null, editor: ImportBusyPart | null }} ImportBusyData
 * @typedef {object} VramLowData
 * @property {number} freeMiB
 * @property {number} reclaimableMiB    Video memory of our own model, which unloads before the reload.
 * @property {number} availableMiB      freeMiB + reclaimableMiB.
 * @property {number} modelVramMiB
 * @property {number} freeAfterLoadMiB
 * @property {number} minFreeVramAfterLoadMiB
 */

/**
 * @typedef {{ id: 'remote_unguarded', mode: GuardMode, detail: string, data: { host: string } }} RemoteReason
 * @typedef {{ id: 'ollama_unreachable', mode: GuardMode, detail: string, data: { error: string } }} OllamaReason
 * @typedef {{ id: 'too_many_editors', mode: GuardMode, detail: string, data: { editorCount: number, maxUnityEditors: number } }} EditorsReason
 * @typedef {{ id: 'import_busy', mode: GuardMode, detail: string, data: ImportBusyData }} ImportReason
 * @typedef {{ id: 'vram_low', mode: GuardMode, detail: string, data: VramLowData }} VramReason
 * @typedef {{ id: 'gpu_busy', mode: GuardMode, detail: string, data: { samples: number[], maxGpuUtilPercent: number } }} GpuReason
 * @typedef {{ id: 'probe_failed', mode: GuardMode, detail: string, data: { probe: ProbeName, error: string } }} ProbeFailedReason
 * @typedef {RemoteReason | OllamaReason | EditorsReason | ImportReason | VramReason | GpuReason | ProbeFailedReason} GuardReason
 */

/**
 * @typedef {object} ModelState
 * @property {boolean} loaded                 True only on the loaded fast path (7.3 LOADED).
 * @property {'loaded' | 'not-listed' | 'other-context' | 'expiring' | 'unknown-expiry' | 'unreadable' | 'cold-requested'} state
 * @property {number | null} contextLength
 * @property {number | null} expiresInSec     Infinity when the model stays loaded without a deadline.
 * @property {number} sizeVramMiB
 * @property {number} reclaimableMiB          Counted as free: our model at our context unloads before a reload.
 * @property {string[]} otherModels
 */

/**
 * @typedef {object} GuardVerdict
 * @property {'pass' | 'blocked'} verdict
 * @property {boolean} pass
 * @property {'remote' | 'loaded' | 'cold'} path
 * @property {GuardMode | null} mode
 * @property {GuardReason[]} reasons
 * @property {string[]} notes
 * @property {number} cacheSec                How long this pass may be reused (0 for a block).
 * @property {string} checkedAt               ISO timestamp.
 * @property {{ modelTag: string, numCtx: number }} target
 * @property {ModelState} model
 * @property {GuardMeasurements} measurements
 */

/**
 * @typedef {object} GuardMeasurements
 * @property {import('./collect.js').GpuFacts | null} gpu
 * @property {import('./unity-processes.js').UnityFacts | null} unity
 * @property {import('./probes/ollama-ps.js').LoadedModelEntry[]} loadedModels
 */

const k_bytesPerMiB = 1048576;

/**
 * @param {import('./collect.js').GuardFacts} facts
 * @param {import('./config.js').GuardTarget} target
 * @param {import('./config.js').GuardConfig} config
 * @returns {GuardVerdict}
 */
export function decideGuard(facts, target, config) {
  /** @type {GuardReason[]} */
  const reasons = [];
  /** @type {string[]} */
  const notes = [];
  const model = classifyModelState(facts.ollama, target, { keepAliveMarginSec: config.keepAliveMarginSec, nowMs: facts.checkedAtMs, cold: facts.cold });

  if (!facts.endpoint.loopback) {
    if (config.remote === 'unguarded') {
      notes.push(`Ollama at ${facts.endpoint.host} is not on this computer; the guard is off (guard.remote unguarded)`);
    } else {
      reasons.push({
        id: 'remote_unguarded',
        mode: 'stop',
        detail: `Ollama at ${facts.endpoint.host} is not on this computer, so video memory and Unity activity cannot be checked`,
        data: { host: facts.endpoint.host },
      });
    }
    return buildVerdict('remote', reasons, notes, config, facts, target, model);
  }

  if (facts.ollama && !facts.ollama.ok) {
    reasons.push({ id: 'ollama_unreachable', mode: 'stop', detail: facts.ollama.error, data: { error: facts.ollama.error } });
  }
  addModelNotes(notes, model, target, facts);

  const path = model.loaded ? 'loaded' : 'cold';
  if (path === 'loaded') decideLoadedPath(reasons, notes, facts, config);
  else decideColdPath(reasons, notes, facts, config, model);

  return buildVerdict(path, reasons, notes, config, facts, target, model);
}

/**
 * The verdict for a guard that could not run at all: invalid settings, or an unexpected failure.
 * @param {{ probe: ProbeName, error: string, target?: import('./config.js').GuardTarget, nowMs?: number }} failure
 * @returns {GuardVerdict}
 */
export function createFailureVerdict({ probe, error, target, nowMs = Date.now() }) {
  return {
    verdict: 'blocked',
    pass: false,
    path: 'cold',
    mode: 'stop',
    reasons: [{ id: 'probe_failed', mode: 'stop', detail: error, data: { probe, error } }],
    notes: [],
    cacheSec: 0,
    checkedAt: new Date(nowMs).toISOString(),
    target: { modelTag: typeof target?.modelTag === 'string' ? target.modelTag : '', numCtx: Number.isSafeInteger(target?.numCtx) ? /** @type {number} */ (target?.numCtx) : 0 },
    model: { loaded: false, state: 'unreadable', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
    measurements: { gpu: null, unity: null, loadedModels: [] },
  };
}

/**
 * Is our model loaded at our context, and long enough to serve the next request (spec 7.3 LOADED)?
 * @param {import('./probes/ollama-ps.js').OllamaPsReading | null} reading
 * @param {import('./config.js').GuardTarget} target
 * @param {{ keepAliveMarginSec: number, nowMs: number, cold: boolean }} options
 * @returns {ModelState}
 */
export function classifyModelState(reading, target, { keepAliveMarginSec, nowMs, cold }) {
  /** @type {ModelState} */
  const state = { loaded: false, state: 'unreadable', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] };
  if (!reading || !reading.ok) return state;
  const entry = reading.models.find((model) => isSameModelName(model.name, target.modelTag) || isSameModelName(model.model, target.modelTag)) ?? null;
  state.otherModels = reading.models.filter((model) => model !== entry).map((model) => model.name);
  if (!entry) return { ...state, state: 'not-listed' };
  state.contextLength = entry.contextLength;
  state.sizeVramMiB = entry.sizeVramBytes === null ? 0 : Math.floor(entry.sizeVramBytes / k_bytesPerMiB);
  state.expiresInSec = secondsUntil(entry.expiresAt, nowMs);
  if (entry.contextLength !== target.numCtx) return { ...state, state: 'other-context' };
  if (state.expiresInSec === null) return { ...state, state: 'unknown-expiry' };
  // Our own model at our own context is unloaded before a reload, so its video memory counts as free.
  if (state.expiresInSec < keepAliveMarginSec) return { ...state, state: 'expiring', reclaimableMiB: state.sizeVramMiB };
  if (cold) return { ...state, state: 'cold-requested', reclaimableMiB: state.sizeVramMiB };
  return { ...state, state: 'loaded', loaded: true, reclaimableMiB: state.sizeVramMiB };
}

/**
 * Ollama lists models with their tag, so `name` may carry the implicit `:latest`.
 * @param {string} name
 * @param {string} modelTag
 * @returns {boolean}
 */
export function isSameModelName(name, modelTag) {
  const left = name.toLowerCase();
  const right = modelTag.toLowerCase();
  return left === right || (!right.includes(':') && left === `${right}:latest`);
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./collect.js').GuardFacts} facts
 * @param {import('./config.js').GuardConfig} config
 */
function decideLoadedPath(reasons, notes, facts, config) {
  const unity = facts.unity;
  if (!unity) return;
  if (!unity.ok) {
    reasons.push(probeFailed('processes', unity.error));
    return;
  }
  if (!unity.running) {
    notes.push('no Unity process is running');
    return;
  }
  addEditorCountReason(reasons, notes, unity, config);
  if (config.importWhileLoaded === 'allow') {
    notes.push('import activity is not checked while the model is loaded (guard.importWhileLoaded allow)');
    return;
  }
  addImportReasons(reasons, notes, unity, config, config.onLoadedBusy);
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./collect.js').GuardFacts} facts
 * @param {import('./config.js').GuardConfig} config
 * @param {ModelState} model
 */
function decideColdPath(reasons, notes, facts, config, model) {
  const gpu = facts.gpu;
  if (gpu === null) {
    notes.push('GPU checks are off (guard.adapter none)');
  } else if (!gpu.memory.ok) {
    reasons.push(probeFailed('nvidia-smi-memory', gpu.memory.error));
  } else {
    addVramReason(reasons, notes, gpu.memory, model, config);
    addUtilizationReason(reasons, notes, gpu, config);
    if (gpu.gpuCount > 1) notes.push(`${gpu.gpuCount} GPUs found; only GPU 0 is measured`);
  }

  const unity = facts.unity;
  if (!unity) return;
  if (!unity.ok) {
    reasons.push(probeFailed('processes', unity.error));
    return;
  }
  if (!unity.running) {
    notes.push('no Unity process is running');
    return;
  }
  addImportReasons(reasons, notes, unity, config, config.onColdBlock);
  addEditorCountReason(reasons, notes, unity, config);
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {{ ok: true, totalMiB: number, freeMiB: number }} memory
 * @param {ModelState} model
 * @param {import('./config.js').GuardConfig} config
 */
function addVramReason(reasons, notes, memory, model, config) {
  const availableMiB = memory.freeMiB + model.reclaimableMiB;
  const freeAfterLoadMiB = availableMiB - config.modelVramMiB;
  /** @type {VramLowData} */
  const data = {
    freeMiB: memory.freeMiB,
    reclaimableMiB: model.reclaimableMiB,
    availableMiB,
    modelVramMiB: config.modelVramMiB,
    freeAfterLoadMiB,
    minFreeVramAfterLoadMiB: config.minFreeVramAfterLoadMiB,
  };
  const summary = `free ${formatGiB(memory.freeMiB)}${model.reclaimableMiB > 0 ? ` plus ${formatGiB(model.reclaimableMiB)} the loaded model releases` : ''} minus the model's ${formatGiB(config.modelVramMiB)} leaves ${formatGiB(freeAfterLoadMiB)} (minimum ${formatGiB(config.minFreeVramAfterLoadMiB)})`;
  if (freeAfterLoadMiB >= config.minFreeVramAfterLoadMiB) {
    notes.push(`video memory: ${summary}`);
    return;
  }
  if (config.allowOffload && availableMiB >= config.minFreeVramAfterLoadMiB) {
    const offloadMiB = config.modelVramMiB - (availableMiB - config.minFreeVramAfterLoadMiB);
    notes.push(`video memory: ${summary}; guard.allowOffload is on, so about ${formatGiB(offloadMiB)} of the model runs from system RAM and replies are slower`);
    return;
  }
  reasons.push({ id: 'vram_low', mode: config.onColdBlock, detail: `not enough video memory: ${summary}`, data });
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./collect.js').GpuFacts} gpu
 * @param {import('./config.js').GuardConfig} config
 */
function addUtilizationReason(reasons, notes, gpu, config) {
  if (!gpu.utilization.ok) {
    reasons.push(probeFailed('nvidia-smi-utilization', gpu.utilization.error));
    return;
  }
  const samples = gpu.utilization.samples;
  const busy = samples.length >= 2 && samples.every((sample) => sample >= config.maxGpuUtilPercent);
  const summary = `${samples.join('% then ')}% (limit ${config.maxGpuUtilPercent}%)`;
  if (busy) {
    reasons.push({ id: 'gpu_busy', mode: config.onColdBlock, detail: `GPU utilization stayed high: ${summary}`, data: { samples: [...samples], maxGpuUtilPercent: config.maxGpuUtilPercent } });
  } else {
    notes.push(`GPU utilization ${summary}`);
  }
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./unity-processes.js').UnityFactsOk} unity
 * @param {import('./config.js').GuardConfig} config
 * @param {GuardMode} mode
 */
function addImportReasons(reasons, notes, unity, config, mode) {
  const editorCheck = config.editorImportCpuPercent > 0;
  const unreadable = unity.unreadable.filter((entry) => entry.kind === 'import' || editorCheck);
  if (unreadable.length > 0) {
    const detail = unreadable.map((entry) => `${entry.name} pid ${entry.pid}: ${entry.error}`).join(', ');
    reasons.push(probeFailed('processes', `CPU time of ${unreadable.length} Unity process(es) could not be read: ${detail}`));
  }
  if (unity.importCpuPercent !== null && unity.importCpuPercent >= config.assetImportCpuPercent) {
    /** @type {ImportBusyData} */
    const data = {
      workers: { cpuPercent: unity.importCpuPercent, limitPercent: config.assetImportCpuPercent, processCount: unity.importProcesses.length },
      editor: null,
    };
    addBusyEditor(data, unity, config, editorCheck);
    reasons.push({ id: 'import_busy', mode, detail: describeImportDetail(data, unity), data });
    return;
  }
  /** @type {ImportBusyData} */
  const data = { workers: null, editor: null };
  addBusyEditor(data, unity, config, editorCheck);
  if (data.editor) {
    reasons.push({ id: 'import_busy', mode, detail: describeImportDetail(data, unity), data });
    return;
  }
  if (unity.importCpuPercent !== null) {
    notes.push(`${unity.importProcesses.length} import process(es) at ${unity.importCpuPercent}% CPU (limit ${config.assetImportCpuPercent}%)`);
  }
  if (editorCheck && unity.busiestEditorCpuPercent !== null) {
    notes.push(`busiest Unity editor at ${unity.busiestEditorCpuPercent}% CPU (limit ${config.editorImportCpuPercent}%)`);
  }
}

/**
 * @param {ImportBusyData} data
 * @param {import('./unity-processes.js').UnityFactsOk} unity
 * @param {import('./config.js').GuardConfig} config
 * @param {boolean} editorCheck
 */
function addBusyEditor(data, unity, config, editorCheck) {
  if (!editorCheck || unity.busiestEditorCpuPercent === null) return;
  if (unity.busiestEditorCpuPercent < config.editorImportCpuPercent) return;
  const busy = unity.editors.filter((editor) => (editor.cpuPercent ?? 0) >= config.editorImportCpuPercent);
  data.editor = { cpuPercent: unity.busiestEditorCpuPercent, limitPercent: config.editorImportCpuPercent, processCount: busy.length };
}

/**
 * @param {ImportBusyData} data
 * @param {import('./unity-processes.js').UnityFactsOk} unity
 * @returns {string}
 */
function describeImportDetail(data, unity) {
  const parts = [];
  if (data.workers) {
    const busiest = [...unity.importProcesses].sort((left, right) => (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0)).slice(0, 3);
    const named = busiest.map((entry) => `${entry.name} pid ${entry.pid} ${entry.cpuPercent}%`).join(', ');
    parts.push(`Unity asset import running: ${data.workers.processCount} process(es) at ${data.workers.cpuPercent}% CPU over ${unity.elapsedMs === null ? 'the sample' : `${Math.round(unity.elapsedMs)} ms`} (limit ${data.workers.limitPercent}%; ${named})`);
  }
  if (data.editor) {
    parts.push(`${data.editor.processCount} Unity editor(s) busy importing, compiling or in Play Mode at up to ${data.editor.cpuPercent}% CPU (limit ${data.editor.limitPercent}%)`);
  }
  return parts.join('; ');
}

/**
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./unity-processes.js').UnityFactsOk} unity
 * @param {import('./config.js').GuardConfig} config
 */
function addEditorCountReason(reasons, notes, unity, config) {
  if (config.maxUnityEditors <= 0 || unity.editorCount === null) return;
  if (unity.editorCount > config.maxUnityEditors) {
    reasons.push({
      id: 'too_many_editors',
      mode: 'stop',
      detail: `${unity.editorCount} Unity editors are open (guard.maxUnityEditors ${config.maxUnityEditors})`,
      data: { editorCount: unity.editorCount, maxUnityEditors: config.maxUnityEditors },
    });
  } else {
    notes.push(`${unity.editorCount} Unity editor(s) open (maximum ${config.maxUnityEditors})`);
  }
}

/**
 * @param {string[]} notes
 * @param {ModelState} model
 * @param {import('./config.js').GuardTarget} target
 * @param {import('./collect.js').GuardFacts} facts
 */
function addModelNotes(notes, model, target, facts) {
  switch (model.state) {
    case 'loaded':
      notes.push(`${target.modelTag} is loaded at context ${target.numCtx}${describeExpiry(model.expiresInSec)}; no extra video memory is needed`);
      break;
    case 'cold-requested':
      notes.push(`${target.modelTag} is loaded, but the check was asked to judge a new load`);
      break;
    case 'other-context':
      notes.push(`${target.modelTag} is loaded at context ${model.contextLength}, not ${target.numCtx}; the next request reloads it`);
      break;
    case 'expiring':
      notes.push(`${target.modelTag} unloads in less than the keep-alive margin${describeExpiry(model.expiresInSec)}; checked as a new load`);
      break;
    case 'unknown-expiry':
      notes.push(`${target.modelTag} is loaded, but Ollama did not report when it unloads; checked as a new load`);
      break;
    case 'not-listed':
      notes.push(`${target.modelTag} is not loaded`);
      break;
    default:
      if (facts.ollama && !facts.ollama.ok) notes.push('Ollama did not answer, so the model counts as not loaded');
      break;
  }
  if (model.otherModels.length > 0) {
    notes.push(`other loaded models: ${model.otherModels.join(', ')}; their video memory is not counted as free`);
  }
}

/**
 * @param {number | null} expiresInSec
 * @returns {string}
 */
function describeExpiry(expiresInSec) {
  if (expiresInSec === null) return '';
  if (expiresInSec === Number.POSITIVE_INFINITY) return ' with no unload deadline';
  return ` (unloads in ${Math.max(0, Math.round(expiresInSec))} s)`;
}

/**
 * @param {ProbeName} probe
 * @param {string} error
 * @returns {ProbeFailedReason}
 */
function probeFailed(probe, error) {
  return { id: 'probe_failed', mode: 'stop', detail: error, data: { probe, error } };
}

/**
 * @param {'remote' | 'loaded' | 'cold'} path
 * @param {GuardReason[]} reasons
 * @param {string[]} notes
 * @param {import('./config.js').GuardConfig} config
 * @param {import('./collect.js').GuardFacts} facts
 * @param {import('./config.js').GuardTarget} target
 * @param {ModelState} model
 * @returns {GuardVerdict}
 */
function buildVerdict(path, reasons, notes, config, facts, target, model) {
  const pass = reasons.length === 0;
  const mode = pass ? null : reasons.some((reason) => reason.mode === 'stop') ? 'stop' : 'retry';
  return {
    verdict: pass ? 'pass' : 'blocked',
    pass,
    path,
    mode,
    reasons,
    notes,
    cacheSec: pass ? (path === 'loaded' ? config.loadedPassCacheSec : config.coldPassCacheSec) : 0,
    checkedAt: new Date(facts.checkedAtMs).toISOString(),
    target: { modelTag: target.modelTag, numCtx: target.numCtx },
    model,
    measurements: {
      gpu: facts.gpu,
      unity: facts.unity,
      loadedModels: facts.ollama && facts.ollama.ok ? facts.ollama.models : [],
    },
  };
}

/**
 * Seconds until an RFC 3339 timestamp. Infinity for Go's zero time, which means "no deadline";
 * null when the value is missing or unreadable.
 * @param {string | null} expiresAt
 * @param {number} nowMs
 * @returns {number | null}
 */
export function secondsUntil(expiresAt, nowMs) {
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') return null;
  const normalized = expiresAt.replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return null;
  if (new Date(parsed).getUTCFullYear() <= 1) return Number.POSITIVE_INFINITY;
  return (parsed - nowMs) / 1000;
}
