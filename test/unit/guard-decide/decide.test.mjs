// Every row of the decision table in spec 7.3, on both the loaded and the cold path.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyModelState, createFailureVerdict, decideGuard, isSameModelName, secondsUntil } from '../../../plugin/opencode-unity-lib/guard/decide.js';
import { MODEL_TAG, NOW_MS, TARGET, gpuFacts, guardConfig, guardFacts, loadedModel, reasonIds, unityFacts } from './guard-facts.mjs';

/**
 * @param {Parameters<typeof guardFacts>[0]} [factsOptions]
 * @param {Record<string, unknown>} [configOverrides]
 */
function decide(factsOptions = {}, configOverrides = {}) {
  return decideGuard(guardFacts(factsOptions), TARGET, guardConfig(configOverrides));
}

describe('guard decision: endpoint and Ollama (R0, R1)', () => {
  it('blocks a non-loopback Ollama and never looks at the GPU', () => {
    const verdict = decide({ host: 'gpu-box.invalid', loopback: false, models: null, gpu: null, unity: null });
    assert.equal(verdict.path, 'remote');
    assert.equal(verdict.mode, 'stop');
    assert.deepEqual(reasonIds(verdict), ['remote_unguarded']);
    assert.match(verdict.reasons[0].detail, /not on this computer/);
  });

  it('passes a non-loopback Ollama with guard.remote unguarded, with a note', () => {
    const verdict = decide({ host: 'gpu-box.invalid', loopback: false, models: null, gpu: null, unity: null }, { remote: 'unguarded' });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.path, 'remote');
    assert.equal(verdict.mode, null);
    assert.ok(verdict.notes.some((note) => note.includes('guard.remote unguarded')));
  });

  it('blocks when /api/ps cannot be read, and still reports the other checks', () => {
    const verdict = decide({ ollamaError: 'GET /api/ps failed (ECONNREFUSED)', gpu: gpuFacts({ freeMiB: 19800 }) });
    assert.equal(verdict.path, 'cold');
    assert.deepEqual(reasonIds(verdict), ['ollama_unreachable', 'vram_low']);
    assert.equal(verdict.mode, 'stop');
    assert.ok(verdict.notes.some((note) => note.includes('counts as not loaded')));
  });
});

describe('guard decision: what counts as loaded (D7)', () => {
  it('takes the loaded fast path for our tag at our context with keep-alive left', () => {
    const verdict = decide({ models: [loadedModel()], gpu: null });
    assert.equal(verdict.path, 'loaded');
    assert.equal(verdict.pass, true);
    assert.equal(verdict.model.loaded, true);
    assert.equal(verdict.cacheSec, 15);
    assert.ok(verdict.notes.some((note) => note.includes('no extra video memory is needed')));
  });

  it('accepts the implicit :latest tag and ignores letter case', () => {
    assert.equal(isSameModelName(`${MODEL_TAG}:latest`, MODEL_TAG), true);
    assert.equal(isSameModelName(MODEL_TAG.toUpperCase(), MODEL_TAG), true);
    assert.equal(isSameModelName(`${MODEL_TAG}:q4`, MODEL_TAG), false);
    assert.equal(isSameModelName('other-model:latest', MODEL_TAG), false);
    assert.equal(decide({ models: [loadedModel({ name: MODEL_TAG })], gpu: null }).path, 'loaded');
  });

  it('treats a model that unloads inside the keep-alive margin as a new load, and counts its memory as free', () => {
    const verdict = decide({ models: [loadedModel({ expiresInSec: 30, sizeVramMiB: 18500 })], gpu: gpuFacts({ freeMiB: 3000 }) });
    assert.equal(verdict.path, 'cold');
    assert.equal(verdict.model.state, 'expiring');
    assert.equal(verdict.model.reclaimableMiB, 18500);
    assert.equal(verdict.pass, true, verdict.reasons.map((reason) => reason.detail).join('; '));
    assert.ok(verdict.notes.some((note) => note.includes('checked as a new load')));
  });

  it('stays on the loaded path exactly at the margin', () => {
    assert.equal(decide({ models: [loadedModel({ expiresInSec: 60 })], gpu: null }).path, 'loaded');
    assert.equal(decide({ models: [loadedModel({ expiresInSec: 59 })], gpu: gpuFacts() }).path, 'cold');
  });

  it('treats a model loaded at another context as not loaded and never counts its memory', () => {
    const verdict = decide({ models: [loadedModel({ contextLength: 32768, sizeVramMiB: 20000 })], gpu: gpuFacts({ freeMiB: 3000 }) });
    assert.equal(verdict.path, 'cold');
    assert.equal(verdict.model.state, 'other-context');
    assert.equal(verdict.model.reclaimableMiB, 0);
    assert.deepEqual(reasonIds(verdict), ['vram_low']);
    assert.ok(verdict.notes.some((note) => note.includes('the next request reloads it')));
  });

  it('treats another loaded model as occupied memory, not as free', () => {
    const verdict = decide({ models: [loadedModel({ name: 'other-model:latest', sizeVramMiB: 20000 })], gpu: gpuFacts({ freeMiB: 3000 }) });
    assert.equal(verdict.model.state, 'not-listed');
    assert.deepEqual(verdict.model.otherModels, ['other-model:latest']);
    assert.deepEqual(reasonIds(verdict), ['vram_low']);
    assert.ok(verdict.notes.some((note) => note.includes('not counted as free')));
  });

  it('judges a new load when the caller asks for a cold verdict', () => {
    const verdict = decide({ cold: true, models: [loadedModel()], gpu: gpuFacts({ freeMiB: 3000 }) });
    assert.equal(verdict.path, 'cold');
    assert.equal(verdict.model.state, 'cold-requested');
    assert.equal(verdict.model.reclaimableMiB, 18500);
  });

  it('reads expires_at the way Ollama writes it', () => {
    assert.equal(secondsUntil('2026-09-17T12:00:30.000Z', NOW_MS), 30);
    assert.equal(secondsUntil('2026-09-17T12:00:30.1234567Z', NOW_MS), 30.123);
    assert.equal(secondsUntil('0001-01-01T00:00:00Z', NOW_MS), Number.POSITIVE_INFINITY);
    assert.equal(secondsUntil('not a date', NOW_MS), null);
    assert.equal(secondsUntil(null, NOW_MS), null);
    const verdict = decide({ models: [loadedModel({ expiresAt: '0001-01-01T00:00:00Z' })], gpu: null });
    assert.equal(verdict.path, 'loaded');
    assert.ok(verdict.notes.some((note) => note.includes('no unload deadline')));
  });

  it('treats an unreadable expires_at as a new load', () => {
    const verdict = decide({ models: [loadedModel({ expiresAt: 'soon' })], gpu: gpuFacts() });
    assert.equal(verdict.path, 'cold');
    assert.equal(verdict.model.state, 'unknown-expiry');
    assert.equal(verdict.model.reclaimableMiB, 0);
  });

  it('classifies nothing when /api/ps was not read', () => {
    const state = classifyModelState(null, TARGET, { keepAliveMarginSec: 60, nowMs: NOW_MS, cold: false });
    assert.deepEqual(state, { loaded: false, state: 'unreadable', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] });
  });
});

describe('guard decision: loaded path (L1-L3)', () => {
  const loaded = { models: [loadedModel()], gpu: null };

  it('L1 blocks more open editors than allowed, and never retries that', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ editorCount: 4 }) });
    assert.deepEqual(reasonIds(verdict), ['too_many_editors']);
    assert.equal(verdict.mode, 'stop');
    assert.equal(verdict.reasons[0].data.editorCount, 4);
  });

  it('L1 is off with maxUnityEditors 0', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ editorCount: 9 }) }, { maxUnityEditors: 0 });
    assert.equal(verdict.pass, true);
  });

  it('L2 blocks a busy import with retry wording while the model is loaded', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: 63, importCount: 2 }) });
    assert.deepEqual(reasonIds(verdict), ['import_busy']);
    assert.equal(verdict.mode, 'retry');
    assert.equal(verdict.reasons[0].data.workers.cpuPercent, 63);
    assert.equal(verdict.reasons[0].data.editor, null);
  });

  it('L2 uses guard.onLoadedBusy', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: 63 }) }, { onLoadedBusy: 'stop' });
    assert.equal(verdict.mode, 'stop');
  });

  it('L2 passes an import exactly below the limit and notes the numbers', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: 19.9 }) });
    assert.equal(verdict.pass, true);
    assert.ok(verdict.notes.some((note) => note.includes('19.9% CPU')));
    assert.equal(decide({ ...loaded, unity: unityFacts({ importCpuPercent: 20 }) }).pass, false);
  });

  it('L2 blocks a busy editor, because in-process imports run inside Unity.exe', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: 1, editorCpuPercent: 85 }) });
    assert.deepEqual(reasonIds(verdict), ['import_busy']);
    assert.equal(verdict.reasons[0].data.editor.cpuPercent, 85);
    assert.equal(verdict.reasons[0].data.workers, null);
    assert.equal(decide({ ...loaded, unity: unityFacts({ importCpuPercent: 1, editorCpuPercent: 85 }) }, { editorImportCpuPercent: 0 }).pass, true);
  });

  it('L2 reports both the workers and the editor when both are busy', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: 63, editorCpuPercent: 85 }) });
    assert.equal(verdict.reasons.length, 1);
    assert.equal(verdict.reasons[0].data.workers.cpuPercent, 63);
    assert.equal(verdict.reasons[0].data.editor.cpuPercent, 85);
  });

  it('L2 is skipped with guard.importWhileLoaded allow', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ importCpuPercent: null, editorCpuPercent: null, cpuSampled: false }) }, { importWhileLoaded: 'allow' });
    assert.equal(verdict.pass, true);
    assert.ok(verdict.notes.some((note) => note.includes('guard.importWhileLoaded allow')));
  });

  it('L3 blocks when the process probe failed', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ error: 'powershell.exe process probe printed no JSON' }) });
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.equal(verdict.reasons[0].data.probe, 'processes');
    assert.equal(verdict.mode, 'stop');
  });

  it('L3 blocks when a matched process hides its CPU time', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ unreadable: [{ pid: 4310, name: 'Unity.exe', kind: 'import', error: 'Access is denied' }] }) });
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.match(verdict.reasons[0].detail, /Access is denied/);
  });

  it('ignores an unreadable editor CPU time when the editor check is off', () => {
    const unreadable = [{ pid: 4100, name: 'Unity.exe', kind: 'editor', error: 'Access is denied' }];
    assert.equal(decide({ ...loaded, unity: unityFacts({ unreadable }) }).pass, false);
    assert.equal(decide({ ...loaded, unity: unityFacts({ unreadable }) }, { editorImportCpuPercent: 0 }).pass, true);
  });

  it('passes with no Unity process running', () => {
    const verdict = decide({ ...loaded, unity: unityFacts({ running: false, editorCount: 0, importCpuPercent: 0, editorCpuPercent: 0, importCount: 0, cpuSampled: false }) });
    assert.equal(verdict.pass, true);
    assert.ok(verdict.notes.some((note) => note.includes('no Unity process is running')));
  });
});

describe('guard decision: cold path (C1-C6)', () => {
  it('C1 blocks when nvidia-smi cannot report memory', () => {
    const verdict = decide({ gpu: gpuFacts({ memoryError: "nvidia-smi exited with code 9: NVIDIA-SMI has failed", utilizationError: 'skipped' }) });
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.equal(verdict.reasons[0].data.probe, 'nvidia-smi-memory');
    assert.equal(verdict.mode, 'stop');
  });

  it('C2 blocks when the load would leave less than the minimum free', () => {
    const verdict = decide({ gpu: gpuFacts({ freeMiB: 19800 }) });
    assert.deepEqual(reasonIds(verdict), ['vram_low']);
    assert.equal(verdict.reasons[0].data.freeAfterLoadMiB, 800);
    assert.equal(verdict.mode, 'stop');
    assert.equal(decide({ gpu: gpuFacts({ freeMiB: 20500 }) }).pass, true);
  });

  it('C2 follows guard.onColdBlock', () => {
    assert.equal(decide({ gpu: gpuFacts({ freeMiB: 19800 }) }, { onColdBlock: 'retry' }).mode, 'retry');
  });

  it('C2 lets the rest of the model run from system RAM when guard.allowOffload is on', () => {
    const verdict = decide({ gpu: gpuFacts({ freeMiB: 19800 }) }, { allowOffload: true });
    assert.equal(verdict.pass, true, verdict.reasons.map((reason) => reason.detail).join('; '));
    assert.deepEqual(reasonIds(verdict), []);
    const note = verdict.notes.find((line) => line.includes('system RAM'));
    assert.ok(note, verdict.notes.join('; '));
    assert.ok(note.includes('0.7 GiB'), note);
  });

  it('C2 still blocks with guard.allowOffload when even the minimum free memory is not there', () => {
    const verdict = decide({ gpu: gpuFacts({ freeMiB: 1000 }) }, { allowOffload: true });
    assert.deepEqual(reasonIds(verdict), ['vram_low']);
    assert.equal(verdict.mode, 'stop');
  });

  it('C3 blocks only when both utilization samples reach the limit', () => {
    assert.equal(decide({ gpu: gpuFacts({ samples: [85, 90] }) }).pass, false);
    assert.deepEqual(reasonIds(decide({ gpu: gpuFacts({ samples: [85, 90] }) })), ['gpu_busy']);
    assert.equal(decide({ gpu: gpuFacts({ samples: [85, 12] }) }).pass, true);
    assert.equal(decide({ gpu: gpuFacts({ samples: [59] }) }).pass, true);
    assert.equal(decide({ gpu: gpuFacts({ samples: [60, 60] }) }).pass, false);
  });

  it('C3 fails closed when the utilization query failed', () => {
    const verdict = decide({ gpu: gpuFacts({ utilizationError: "unexpected nvidia-smi output '[N/A]'" }) });
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.equal(verdict.reasons[0].data.probe, 'nvidia-smi-utilization');
  });

  it('C4 blocks a busy import with the cold mode', () => {
    const verdict = decide({ unity: unityFacts({ importCpuPercent: 63 }) });
    assert.deepEqual(reasonIds(verdict), ['import_busy']);
    assert.equal(verdict.mode, 'stop');
    assert.equal(decide({ unity: unityFacts({ importCpuPercent: 63 }) }, { onColdBlock: 'retry' }).mode, 'retry');
  });

  it('C5 blocks too many editors and C4 and C5 are both reported', () => {
    const verdict = decide({ unity: unityFacts({ editorCount: 4, importCpuPercent: 63 }) });
    assert.deepEqual(reasonIds(verdict), ['import_busy', 'too_many_editors']);
    assert.equal(verdict.mode, 'stop');
  });

  it('C6 blocks when the process probe failed', () => {
    const verdict = decide({ unity: unityFacts({ error: 'tasklist did not answer within 5 s' }) });
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
  });

  it('passes a cold check with no Unity process running', () => {
    const verdict = decide({ unity: unityFacts({ running: false, editorCount: 0, importCpuPercent: 0, editorCpuPercent: 0, importCount: 0, cpuSampled: false }) });
    assert.equal(verdict.pass, true);
    assert.ok(verdict.notes.some((note) => note.includes('no Unity process is running')));
  });

  it('collects every reason it finds', () => {
    const verdict = decide({
      ollamaError: 'GET /api/ps gave no answer within 3 s',
      gpu: gpuFacts({ freeMiB: 19800, samples: [95, 96] }),
      unity: unityFacts({ editorCount: 4, importCpuPercent: 63, editorCpuPercent: 90 }),
    });
    assert.deepEqual(reasonIds(verdict), ['ollama_unreachable', 'vram_low', 'gpu_busy', 'import_busy', 'too_many_editors']);
    assert.equal(verdict.verdict, 'blocked');
  });

  it('keeps stop when stop and retry reasons meet', () => {
    const verdict = decide({ gpu: gpuFacts({ freeMiB: 19800 }), unity: unityFacts({ editorCount: 4 }) }, { onColdBlock: 'retry' });
    assert.deepEqual(reasonIds(verdict), ['vram_low', 'too_many_editors']);
    assert.equal(verdict.mode, 'stop');
  });

  it('skips the GPU checks with guard.adapter none', () => {
    const verdict = decide({ gpu: null });
    assert.equal(verdict.pass, true);
    assert.ok(verdict.notes.some((note) => note.includes('guard.adapter none')));
  });

  it('notes a second GPU, because only GPU 0 is measured', () => {
    const verdict = decide({ gpu: gpuFacts({ gpuCount: 2 }) });
    assert.ok(verdict.notes.some((note) => note.includes('only GPU 0 is measured')));
  });

  it('caches a cold pass for the cold cache time and never caches a block', () => {
    assert.equal(decide({}).cacheSec, 3);
    assert.equal(decide({}, { coldPassCacheSec: 0 }).cacheSec, 0);
    assert.equal(decide({ gpu: gpuFacts({ freeMiB: 0 }) }).cacheSec, 0);
  });

  it('reports the measurements and the target for status and doctor', () => {
    const verdict = decide({ models: [loadedModel()], gpu: null, unity: unityFacts() });
    assert.deepEqual(verdict.target, { modelTag: MODEL_TAG, numCtx: 16384 });
    assert.equal(verdict.measurements.loadedModels.length, 1);
    assert.equal(verdict.measurements.unity?.ok, true);
    assert.equal(verdict.checkedAt, '2026-09-17T12:00:00.000Z');
  });
});

describe('guard failure verdict', () => {
  it('blocks with a stop reason when the guard could not run', () => {
    const verdict = createFailureVerdict({ probe: 'settings', error: 'guard.maxGpuUtilPercent must be between 1 and 100', target: TARGET, nowMs: NOW_MS });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.mode, 'stop');
    assert.equal(verdict.cacheSec, 0);
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.equal(verdict.reasons[0].data.probe, 'settings');
    assert.deepEqual(verdict.target, { modelTag: MODEL_TAG, numCtx: 16384 });
  });

  it('works without a usable target', () => {
    const verdict = createFailureVerdict({ probe: 'guard', error: 'TypeError: probes.now is not a function', nowMs: NOW_MS });
    assert.deepEqual(verdict.target, { modelTag: '', numCtx: 0 });
  });
});
