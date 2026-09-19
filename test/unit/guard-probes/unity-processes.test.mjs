// Turning a process snapshot into import CPU, editor CPU and editor count (spec 7.2), on the
// recorded snapshots of test/fixtures/processes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseProbeResult } from '../../../plugin/opencode-unity-lib/guard/probes/processes-win32.js';
import { analyzeUnityProcesses, matchesProcessPattern, measureCpuPercent, roundPercent, validateProcessSnapshot } from '../../../plugin/opencode-unity-lib/guard/unity-processes.js';

const FIXTURES = new URL('../../fixtures/processes/', import.meta.url);
const PATTERNS = ['AssetImportWorker', '-importWorker'];
const RUNNING = { ok: true, running: true, count: 1 };

/**
 * The recordings are win32 probe output, so they are read the way the win32 probe reads its answer:
 * that is where each process gets its `program`.
 * @param {string} name
 * @returns {Promise<import('../../../plugin/opencode-unity-lib/guard/unity-processes.js').SnapshotReading>}
 */
async function readSnapshot(name) {
  const stdout = JSON.stringify(JSON.parse(await fs.readFile(new URL(`${name}.json`, FIXTURES), 'utf8')));
  return parseProbeResult({ ok: true, exitCode: 0, stdout, stderr: '', error: null, timedOut: false });
}

/**
 * @param {string} name
 * @param {{ cpuSampled?: boolean, patterns?: string[], selfPid?: number }} [options]
 */
async function analyze(name, { cpuSampled = true, patterns = PATTERNS, selfPid } = {}) {
  return analyzeUnityProcesses(RUNNING, await readSnapshot(name), { patterns, cpuSampled, selfPid });
}

describe('recorded Unity process snapshots', () => {
  it('reads an idle editor with its standby shader compiler', async () => {
    const facts = await analyze('idle-editor');
    assert.equal(facts.ok, true);
    assert.equal(facts.editorCount, 1);
    assert.equal(facts.importCpuPercent, 0);
    assert.equal(facts.busiestEditorCpuPercent, 5.3);
    assert.deepEqual(facts.importProcesses, [{ pid: 4200, name: 'UnityShaderCompiler.exe', cpuPercent: 0 }]);
    assert.deepEqual(facts.unreadable, []);
  });

  it('sums the CPU of the import workers', async () => {
    const facts = await analyze('import-busy');
    assert.equal(facts.importCpuPercent, 52.9);
    assert.deepEqual(facts.importProcesses.map((entry) => entry.cpuPercent), [33.1, 19.8]);
    assert.equal(facts.editorCount, 1);
    assert.equal(facts.busiestEditorCpuPercent, 5.3);
  });

  it('counts every shader compiler, whether a worker or the editor started it', async () => {
    const facts = await analyze('shader-children');
    assert.equal(facts.importProcesses.length, 3);
    assert.equal(facts.importCpuPercent, 79.3);
    assert.equal(facts.busiestEditorCpuPercent, 79.3, 'an in-process import shows up as editor CPU');
  });

  it('counts the editors that have a window', async () => {
    const facts = await analyze('many-editors');
    assert.equal(facts.editorCount, 4);
    assert.equal(facts.editors.length, 4);
    assert.equal(facts.importProcesses.length, 0);
  });

  it('names the processes whose CPU time it could not read, and skips the ones that are gone', async () => {
    const facts = await analyze('unreadable');
    assert.deepEqual(facts.unreadable, [{ pid: 4310, name: 'Unity.exe', kind: 'import', error: 'Access is denied' }]);
    // 4311 exited, 4312 is a reused pid; 4313 hides its command line, so it counts as a worker.
    assert.deepEqual(facts.importProcesses.map((entry) => entry.pid), [4313]);
    assert.equal(facts.importCpuPercent, 59.5);
  });

  it('skips the probe, its parents and the caller', async () => {
    const reading = await readSnapshot('many-editors');
    reading.snapshot.ancestors.push(4101);
    reading.snapshot.probePid = 4102;
    const facts = analyzeUnityProcesses(RUNNING, reading, { patterns: PATTERNS, cpuSampled: true, selfPid: 4103 });
    assert.equal(facts.ok && facts.editorCount, 1);
  });

  it('reports no numbers when CPU time was not sampled', async () => {
    const facts = await analyze('import-busy', { cpuSampled: false });
    assert.equal(facts.importCpuPercent, null);
    assert.equal(facts.busiestEditorCpuPercent, null);
    assert.equal(facts.elapsedMs, null);
    assert.equal(facts.editorCount, 1);
    assert.deepEqual(facts.importProcesses.map((entry) => entry.cpuPercent), [null, null]);
  });

  it('matches only the configured patterns', async () => {
    const facts = await analyze('import-busy', { patterns: ['no-such-worker'] });
    assert.equal(facts.importProcesses.length, 0);
    assert.equal(facts.importCpuPercent, 0);
  });
});

describe('process presence', () => {
  it('passes a probe failure through', () => {
    const facts = analyzeUnityProcesses({ ok: false, error: 'tasklist did not answer' }, null, { patterns: PATTERNS, cpuSampled: true });
    assert.deepEqual(facts, { ok: false, error: 'tasklist did not answer' });
  });

  it('reads no Unity process as zero imports and zero editors', () => {
    const facts = analyzeUnityProcesses({ ok: true, running: false, count: 0 }, null, { patterns: PATTERNS, cpuSampled: true });
    assert.equal(facts.ok && facts.running, false);
    assert.equal(facts.editorCount, 0);
    assert.equal(facts.importCpuPercent, 0);
    assert.equal(facts.detailsRead, true);
  });

  it('says when details were not read, so no check may assume they are zero', () => {
    const facts = analyzeUnityProcesses(RUNNING, null, { patterns: PATTERNS, cpuSampled: false });
    assert.equal(facts.ok && facts.running, true);
    assert.equal(facts.detailsRead, false);
    assert.equal(facts.editorCount, null);
    assert.equal(facts.importCpuPercent, null);
  });

  it('passes a snapshot failure through', () => {
    const facts = analyzeUnityProcesses(RUNNING, { ok: false, error: 'printed no JSON' }, { patterns: PATTERNS, cpuSampled: true });
    assert.deepEqual(facts, { ok: false, error: 'printed no JSON' });
  });
});

describe('CPU percent between two readings', () => {
  const reading = (seconds, startMs = 10, state = 'ok') => ({ state, seconds, startMs, error: null });

  it('measures delta CPU time over the measured window', () => {
    assert.deepEqual(measureCpuPercent(reading(10), reading(10.75), 1500), { state: 'measured', percent: 50 });
    assert.deepEqual(measureCpuPercent(reading(10), reading(34), 1500), { state: 'measured', percent: 1600 });
  });

  it('skips a process that was already gone or exited during the window', () => {
    assert.deepEqual(measureCpuPercent({ state: 'exited', seconds: null, startMs: null, error: null }, reading(10), 1500), { state: 'gone' });
    assert.deepEqual(measureCpuPercent(reading(10), { state: 'exited', seconds: null, startMs: null, error: null }, 1500), { state: 'gone' });
  });

  it('skips a pid another process reused', () => {
    assert.deepEqual(measureCpuPercent(reading(10, 10), reading(0.5, 99), 1500), { state: 'gone' });
    assert.deepEqual(measureCpuPercent(reading(10, 10), reading(0.5, 10), 1500), { state: 'gone' });
  });

  it('fails closed when a reading is missing, failed or has no window', () => {
    assert.equal(measureCpuPercent(null, reading(10), 1500).state, 'unreadable');
    assert.equal(measureCpuPercent(reading(10), null, 1500).state, 'unreadable');
    assert.equal(measureCpuPercent({ state: 'error', seconds: null, startMs: null, error: 'Access is denied' }, reading(10), 1500).error, 'Access is denied');
    assert.equal(measureCpuPercent(reading(10), { state: 'error', seconds: null, startMs: null, error: null }, 1500).error, 'CPU time unreadable');
    assert.equal(measureCpuPercent(reading(10), reading(11), 0).state, 'unreadable');
    assert.equal(measureCpuPercent(reading(10), reading(11), null).state, 'unreadable');
  });

  it('rounds to a tenth of a percent', () => {
    assert.equal(roundPercent(52.94999), 52.9);
    assert.equal(roundPercent(0.04), 0);
  });
});

describe('process patterns', () => {
  it('matches the name or the command line anywhere, ignoring case', () => {
    const entry = { name: 'Unity.exe', commandLine: '"C:\\Editor\\Unity.exe" -name AssetImportWorker0 -projectPath D:\\Projects\\SampleGame' };
    assert.equal(matchesProcessPattern(entry, 'assetimportworker'), true);
    assert.equal(matchesProcessPattern(entry, 'unity.exe'), true);
    assert.equal(matchesProcessPattern(entry, 'AssetImportWorker?'), true);
    assert.equal(matchesProcessPattern(entry, 'Asset*Worker0'), true);
    assert.equal(matchesProcessPattern(entry, 'Asset?Worker'), false);
    assert.equal(matchesProcessPattern(entry, 'ShaderCompiler'), false);
  });

  it('treats a hidden command line as empty text, never as a match', () => {
    assert.equal(matchesProcessPattern({ name: 'Unity.exe', commandLine: null }, 'AssetImportWorker'), false);
    assert.equal(matchesProcessPattern({ name: 'Unity.exe', commandLine: null }, 'unity'), true);
  });

  it('takes a pattern literally apart from its wildcards', () => {
    const entry = { name: 'worker.exe', commandLine: 'a+b (c)' };
    assert.equal(matchesProcessPattern(entry, 'a+b (c)'), true);
    assert.equal(matchesProcessPattern(entry, 'a.b'), false);
  });
});

describe('snapshot validation', () => {
  const valid = { schema: 1, probePid: 10, ancestors: [9], sampleMs: 1500, elapsedMs: 1501.2, processes: [] };

  it('accepts what the script prints', () => {
    assert.equal(validateProcessSnapshot(valid).ok, true);
  });

  it('reports the failure the script wrote', () => {
    const reading = validateProcessSnapshot({ schema: 1, error: 'Access denied' });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /process probe failed: Access denied/);
  });

  it('refuses anything else, so the guard fails closed', () => {
    const cases = [
      [null, /not an object/],
      [[], /not an object/],
      [{ ...valid, schema: 2 }, /unknown schema/],
      [{ ...valid, probePid: -1 }, /probePid/],
      [{ ...valid, ancestors: ['9'] }, /ancestors/],
      [{ ...valid, sampleMs: null }, /sampleMs/],
      [{ ...valid, elapsedMs: -5 }, /elapsedMs/],
      [{ ...valid, processes: {} }, /processes/],
      [{ ...valid, processes: [{ pid: 1 }] }, /process entry/],
      [{ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: 5, hasWindow: false }] }, /process entry/],
      [{ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: null, hasWindow: 'yes' }] }, /process entry/],
      [{ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: null, hasWindow: true, first: { state: 'busy' } }] }, /CPU reading of pid 1/],
      [{ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: null, hasWindow: true, first: { state: 'ok', seconds: null, startMs: null, error: null } }] }, /CPU reading of pid 1/],
      [{ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: null, hasWindow: true, second: { state: 'ok', seconds: -1, startMs: 1, error: null } }] }, /CPU reading of pid 1/],
    ];
    for (const [value, expected] of cases) {
      const reading = validateProcessSnapshot(value);
      assert.equal(reading.ok, false, `expected ${JSON.stringify(value)} to be refused`);
      assert.match(reading.error, expected);
    }
  });

  it('accepts missing CPU readings, which mean CPU time was not sampled', () => {
    const reading = validateProcessSnapshot({ ...valid, processes: [{ pid: 1, parentPid: 2, name: 'Unity.exe', commandLine: null, hasWindow: true, first: null, second: undefined }] });
    assert.equal(reading.ok, true);
    assert.equal(reading.snapshot.processes[0].first, null);
    assert.equal(reading.snapshot.processes[0].second, null);
  });
});
