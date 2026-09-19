// The Windows guard matrix, driven end to end through the public entry points (createDefaultProbes
// and evaluateGuard) with every command and HTTP answer faked. Each scenario records the verdict and
// every probe call, so win32-golden.test.mjs can prove that repackaging the probes behind the
// platform interface (amendment 33.6, C22) changed nothing on Windows: not a verdict, not a message,
// not a spawned command line, not a sleep.
import fs from 'node:fs';
import { createDefaultProbes } from '../../../plugin/opencode-unity-lib/guard/collect.js';
import { evaluateGuard } from '../../../plugin/opencode-unity-lib/guard/evaluate.js';

export const GOLDEN_URL = new URL('./golden/win32-verdicts.json', import.meta.url);

const FIXTURES = new URL('../../fixtures/processes/', import.meta.url);
const NOW_MS = Date.parse('2026-09-17T12:00:00.000Z');
const MODEL_TAG = 'ocu-model-16k';
const ENV = Object.freeze({ SystemRoot: 'C:\\Windows' });
const TARGET = Object.freeze({ baseUrl: 'http://127.0.0.1:11434', modelTag: MODEL_TAG, numCtx: 16384 });
// Recorded snapshots use small pids. The guard skips its own pid, so they are moved far above any pid a
// test runner can have; otherwise one run in a few thousand would skip a fixture process.
const PID_OFFSET = 70_000_000;

const NO_TASKS = { stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' };
const ONE_UNITY = { stdout: '"Unity.exe","70004100","Console","1","2,335,016 K"\r\n' };
const TWO_UNITY = { stdout: '"Unity.exe","70004100","Console","1","2,335,016 K"\r\n"Unity.exe","70004310","Console","1","1,003,548 K"\r\n' };

/**
 * @typedef {Partial<import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').CommandResult> & { takeMs?: number }} FakeAnswer
 * @typedef {{ status: number, body: unknown } | { reject: string }} FakePs
 * @typedef {object} Scenario
 * @property {string} id
 * @property {FakePs} [ps]
 * @property {FakeAnswer[]} [nvidia]      One answer per nvidia-smi call; the last repeats.
 * @property {FakeAnswer} [tasklist]
 * @property {FakeAnswer} [powershell]
 * @property {Record<string, unknown>} [config]
 * @property {Partial<typeof TARGET>} [target]
 * @property {boolean} [cold]
 */

/**
 * @param {string} line  One `index, memory.total, memory.free, utilization.gpu` row.
 * @returns {FakeAnswer}
 */
function smi(line) {
  return { stdout: `${line}\r\n` };
}

/**
 * @param {string} name  A recorded snapshot under test/fixtures/processes.
 * @returns {FakeAnswer}
 */
function recorded(name) {
  const snapshot = JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
  return snapshotAnswer(snapshot);
}

/**
 * @param {any} snapshot
 * @returns {FakeAnswer}
 */
function snapshotAnswer(snapshot) {
  const moved = {
    ...snapshot,
    probePid: snapshot.probePid + PID_OFFSET,
    ancestors: snapshot.ancestors.map((/** @type {number} */ pid) => pid + PID_OFFSET),
    processes: snapshot.processes.map((/** @type {any} */ entry) => ({ ...entry, pid: entry.pid + PID_OFFSET, parentPid: entry.parentPid + PID_OFFSET })),
  };
  return { stdout: `WARNING: noise before the answer\r\n${JSON.stringify(moved)}\r\n` };
}

/**
 * @param {number} seconds
 * @returns {{ state: 'ok', seconds: number, startMs: number, error: null }}
 */
function cpu(seconds) {
  return { state: 'ok', seconds, startMs: 1758000000000, error: null };
}

/**
 * Every spelling of a Windows image name the classification has to agree on, before and after the
 * `.exe` rule moved into the win32 probe.
 * @returns {FakeAnswer}
 */
function imageNameSpellings() {
  const entry = (/** @type {number} */ pid, /** @type {string} */ name, /** @type {boolean} */ hasWindow, /** @type {string | null} */ commandLine) => ({
    pid,
    parentPid: 700,
    name,
    commandLine,
    hasWindow,
    first: cpu(10),
    second: cpu(10.3 + pid / 10000),
  });
  return snapshotAnswer({
    schema: 1,
    probePid: 1000,
    ancestors: [900],
    sampleMs: 1500,
    elapsedMs: 1500,
    processes: [
      entry(4100, 'UNITY.EXE', true, '"C:\\Editor\\UNITY.EXE" -projectPath D:\\Projects\\SampleGame'),
      entry(4101, 'Unity.EXE', false, null),
      entry(4102, 'unityshadercompiler.Exe', false, '"C:\\Editor\\Data\\Tools\\UnityShaderCompiler.exe"'),
      entry(4103, 'Unity', true, 'Unity -projectPath D:\\Projects\\SampleGame'),
      entry(4104, 'Unity.exe.exe', true, 'Unity.exe.exe'),
      entry(4105, 'Unity.bin', true, 'Unity.bin'),
      entry(4106, 'Unity Hub.exe', true, '"C:\\Hub\\Unity Hub.exe"'),
      entry(4107, 'MyUnity.exe', false, null),
      entry(4108, 'Unity.exe ', true, 'Unity.exe '),
      entry(4109, 'UnityShaderCompiler', false, 'UnityShaderCompiler'),
    ],
  });
}

const LOADED_MODEL = {
  name: `${MODEL_TAG}:latest`,
  model: `${MODEL_TAG}:latest`,
  context_length: 16384,
  expires_at: new Date(NOW_MS + 1800 * 1000).toISOString(),
  size_vram: 18500 * 1048576,
};

/** @type {readonly Scenario[]} */
export const SCENARIOS = Object.freeze([
  { id: 'cold-clear' },
  { id: 'cold-vram-low', nvidia: [smi('0, 24576, 15000, 3')] },
  { id: 'cold-gpu-busy', nvidia: [smi('0, 24576, 22000, 95'), smi('0, 24576, 22000, 97')] },
  { id: 'cold-gpu-busy-then-idle', nvidia: [smi('0, 24576, 22000, 95'), smi('0, 24576, 22000, 10')] },
  { id: 'cold-gpu-busy-slow-first-read', nvidia: [{ ...smi('0, 24576, 22000, 95'), takeMs: 1400 }, smi('0, 24576, 22000, 99')] },
  { id: 'cold-gpu-second-read-fails', nvidia: [smi('0, 24576, 22000, 95'), { ok: false, exitCode: 9, error: 'exited with code 9', stderr: 'NVIDIA-SMI has failed' }] },
  { id: 'cold-gpu-second-read-na', nvidia: [smi('0, 24576, 22000, 95'), smi('0, 24576, 22000, [N/A]')] },
  { id: 'cold-nvidia-smi-missing', nvidia: [{ ok: false, exitCode: null, error: 'could not start (ENOENT)' }] },
  { id: 'cold-nvidia-smi-timeout', nvidia: [{ ok: false, exitCode: null, error: 'did not answer within 10 s', timedOut: true }] },
  { id: 'cold-nvidia-smi-garbage', nvidia: [smi('garbage')] },
  { id: 'cold-nvidia-smi-empty', nvidia: [{ stdout: '' }] },
  { id: 'cold-nvidia-smi-no-gpu-0', nvidia: [smi('1, 24576, 22000, 3')] },
  { id: 'cold-nvidia-smi-two-gpus', nvidia: [{ stdout: '0, 24576, 22000, 3\r\n1, 8192, 8000, 0\r\n' }] },
  { id: 'cold-utilization-na', nvidia: [smi('0, 24576, 22000, [N/A]')] },
  { id: 'cold-memory-na', nvidia: [smi('0, 24576, [N/A], 3')] },
  { id: 'cold-memory-free-above-total', nvidia: [smi('0, 24576, 30000, 3')] },
  { id: 'cold-idle-editor', tasklist: ONE_UNITY, powershell: recorded('idle-editor') },
  { id: 'cold-import-busy', tasklist: TWO_UNITY, powershell: recorded('import-busy') },
  { id: 'cold-shader-children', tasklist: ONE_UNITY, powershell: recorded('shader-children') },
  { id: 'cold-many-editors', tasklist: TWO_UNITY, powershell: recorded('many-editors') },
  { id: 'cold-unreadable', tasklist: TWO_UNITY, powershell: recorded('unreadable') },
  { id: 'cold-image-name-spellings', tasklist: ONE_UNITY, powershell: imageNameSpellings() },
  { id: 'cold-image-name-spellings-no-editor-limit', tasklist: ONE_UNITY, powershell: imageNameSpellings(), config: { maxUnityEditors: 0, editorImportCpuPercent: 0 } },
  { id: 'cold-custom-patterns', tasklist: TWO_UNITY, powershell: recorded('import-busy'), config: { assetImportProcessPatterns: ['no-such-worker'] } },
  { id: 'cold-tasklist-missing', tasklist: { ok: false, exitCode: null, error: 'could not start (ENOENT)' } },
  { id: 'cold-tasklist-garbage', tasklist: { stdout: 'something\r\nelse\r\n' } },
  { id: 'cold-tasklist-other-program', tasklist: { stdout: '"notepad.exe","5100","Console","1","1 K"\r\n' } },
  { id: 'cold-powershell-failure-json', tasklist: ONE_UNITY, powershell: { ok: false, exitCode: 1, error: 'exited with code 1', stdout: '{"schema":1,"error":"Access denied by the CIM service"}\r\n' } },
  { id: 'cold-powershell-no-json', tasklist: ONE_UNITY, powershell: { stdout: 'nothing useful\r\n' } },
  { id: 'cold-powershell-bad-schema', tasklist: ONE_UNITY, powershell: { stdout: '{"schema":2}\r\n' } },
  { id: 'cold-powershell-timeout', tasklist: ONE_UNITY, powershell: { ok: false, exitCode: null, error: 'did not answer within 11.5 s', timedOut: true } },
  { id: 'cold-everything-wrong', nvidia: [smi('0, 24576, 15000, 95'), smi('0, 24576, 15000, 96')], tasklist: TWO_UNITY, powershell: recorded('import-busy') },
  { id: 'cold-adapter-none', config: { adapter: 'none' }, tasklist: ONE_UNITY, powershell: recorded('idle-editor') },
  { id: 'cold-requested-while-loaded', ps: { status: 200, body: { models: [LOADED_MODEL] } }, cold: true },
  { id: 'loaded-clear', ps: { status: 200, body: { models: [LOADED_MODEL] } } },
  { id: 'loaded-import-busy', ps: { status: 200, body: { models: [LOADED_MODEL] } }, tasklist: TWO_UNITY, powershell: recorded('import-busy') },
  { id: 'loaded-import-allowed', ps: { status: 200, body: { models: [LOADED_MODEL] } }, tasklist: TWO_UNITY, powershell: recorded('import-busy'), config: { importWhileLoaded: 'allow' } },
  { id: 'loaded-import-allowed-no-editor-limit', ps: { status: 200, body: { models: [LOADED_MODEL] } }, tasklist: TWO_UNITY, powershell: recorded('import-busy'), config: { importWhileLoaded: 'allow', maxUnityEditors: 0 } },
  { id: 'loaded-many-editors', ps: { status: 200, body: { models: [LOADED_MODEL] } }, tasklist: TWO_UNITY, powershell: recorded('many-editors') },
  { id: 'loaded-tasklist-missing', ps: { status: 200, body: { models: [LOADED_MODEL] } }, tasklist: { ok: false, exitCode: null, error: 'could not start (ENOENT)' } },
  { id: 'loaded-other-context', ps: { status: 200, body: { models: [{ ...LOADED_MODEL, context_length: 8192 }] } } },
  { id: 'loaded-expiring', ps: { status: 200, body: { models: [{ ...LOADED_MODEL, expires_at: new Date(NOW_MS + 30 * 1000).toISOString() }] } } },
  { id: 'loaded-other-model', ps: { status: 200, body: { models: [{ ...LOADED_MODEL, name: 'someone-else:7b', model: 'someone-else:7b' }] } } },
  { id: 'ollama-unreachable', ps: { reject: 'ECONNREFUSED' } },
  { id: 'ollama-http-500', ps: { status: 500, body: { error: 'boom' } } },
  { id: 'ollama-no-models-list', ps: { status: 200, body: { nothing: true } } },
  { id: 'remote-blocked', target: { baseUrl: 'http://192.168.1.20:11434' } },
  { id: 'remote-unguarded', target: { baseUrl: 'http://192.168.1.20:11434' }, config: { remote: 'unguarded' } },
  { id: 'settings-invalid', config: { modelVramMiB: 0 } },
  { id: 'target-invalid', target: { numCtx: -1 } },
]);

/**
 * @param {Scenario} scenario
 * @returns {Promise<{ verdict: unknown, calls: unknown[] }>}
 */
export async function runScenario(scenario) {
  /** @type {unknown[]} */
  const calls = [];
  let clock = NOW_MS;
  let nvidiaIndex = 0;
  const nvidia = scenario.nvidia ?? [smi('0, 24576, 22000, 3')];

  /** @type {import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunCommand} */
  const run = async (file, args, options) => {
    const program = file.split(/[\\/]/).pop()?.toLowerCase() ?? file;
    calls.push({
      kind: 'spawn',
      at: clock - NOW_MS,
      file,
      args: [...args],
      timeoutMs: options.timeoutMs,
      platform: options.platform ?? null,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      input: options.input === undefined ? null : options.input.split('\n')[0],
    });
    /** @type {FakeAnswer} */
    let answer;
    if (program === 'tasklist.exe') answer = scenario.tasklist ?? NO_TASKS;
    else if (program === 'powershell.exe') answer = scenario.powershell ?? { ok: false, exitCode: 1, error: 'exited with code 1', stdout: '' };
    else {
      answer = nvidia[Math.min(nvidiaIndex, nvidia.length - 1)];
      nvidiaIndex += 1;
    }
    const { takeMs = 0, ...result } = answer;
    clock += takeMs;
    return { ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...result };
  };

  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    calls.push({ kind: 'fetch', at: clock - NOW_MS, url: String(url) });
    const ps = scenario.ps ?? { status: 200, body: { models: [] } };
    if ('reject' in ps) throw Object.assign(new TypeError('fetch failed'), { cause: { code: ps.reject } });
    return new Response(JSON.stringify(ps.body), { status: ps.status, headers: { 'content-type': 'application/json' } });
  };

  const probes = {
    ...createDefaultProbes({ platform: 'win32', env: { ...ENV }, fetchImpl, run }),
    sleep: async (/** @type {number} */ ms) => {
      calls.push({ kind: 'sleep', at: clock - NOW_MS, ms });
      clock += ms;
    },
    now: () => clock,
  };
  const verdict = await evaluateGuard({
    target: { ...TARGET, ...scenario.target },
    config: { modelVramMiB: 19000, ...scenario.config },
    probes,
    cold: scenario.cold ?? false,
  });
  return { verdict, calls };
}
