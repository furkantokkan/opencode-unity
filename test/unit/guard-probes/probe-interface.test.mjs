// The platform probe interface (amendment 33.6, expansion 11.5): which implementation a platform
// gets, what each one declares, how the win32 family restates its answers as reads, and what a
// platform without a family answers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { CAPABILITY_CLASSES, PROBE_FAMILIES, selectProbes, withCLocale } from '../../../plugin/opencode-unity-lib/guard/probes/index.js';
import { parseProbeResult, readWin32ProgramName } from '../../../plugin/opencode-unity-lib/guard/probes/processes-win32.js';

const FIXTURES = new URL('../../fixtures/processes/', import.meta.url);
const ENV = Object.freeze({ SystemRoot: 'C:\\Windows' });
const NOW_MS = Date.parse('2026-09-18T10:00:00.000Z');
const CAPABILITIES = Object.keys(CAPABILITY_CLASSES);
const OTHER_PLATFORMS = ['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'plan9', ''];

/**
 * @param {Record<string, Partial<import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').CommandResult>>} answers  By program name.
 */
function recordingRun(answers = {}) {
  /** @type {Array<{ file: string, args: readonly string[], options: import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunOptions }>} */
  const calls = [];
  /** @type {import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunCommand} */
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    const program = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    return { ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...answers[program] };
  };
  return { calls, run };
}

/**
 * @param {Parameters<typeof recordingRun>[0]} [answers]
 */
function win32Probes(answers) {
  const fake = recordingRun(answers);
  return { fake, probes: selectProbes({ platform: 'win32', env: { ...ENV }, run: fake.run, now: () => NOW_MS }) };
}

/**
 * @param {string} name
 * @returns {Promise<string>}  The recording as the script prints it: one JSON line.
 */
async function readRecording(name) {
  return `${JSON.stringify(JSON.parse(await fs.readFile(new URL(`${name}.json`, FIXTURES), 'utf8')))}\r\n`;
}

describe('probe selection', () => {
  it('gives Windows its probe family', () => {
    assert.ok(PROBE_FAMILIES.includes('win32'));
    const probes = selectProbes({ platform: 'win32', env: { ...ENV } });
    assert.equal(probes.id, 'win32');
    assert.equal(probes.platform, 'win32');
    assert.equal(probes.backend, 'nvidia-smi');
    assert.equal(probes.cpuTimeResolutionMs, 0.0001);
  });

  it('gives every platform without a family the unsupported probe, keeping the platform name', () => {
    for (const platform of [...OTHER_PLATFORMS, 'constructor', '__proto__', 'hasOwnProperty', 'toString'].filter((name) => !PROBE_FAMILIES.includes(name))) {
      const probes = selectProbes({ platform, env: {} });
      assert.equal(probes.id, 'unsupported', platform);
      assert.equal(probes.platform, platform);
      assert.equal(probes.backend, 'none');
      assert.equal(probes.cpuTimeResolutionMs, null);
    }
  });

  it('starts nothing while selecting', () => {
    const fake = recordingRun();
    for (const platform of ['win32', 'linux', 'darwin', 'aix']) selectProbes({ platform, env: {}, run: fake.run });
    assert.equal(fake.calls.length, 0);
  });

  it('reads the platform of this process by default', () => {
    const probes = selectProbes();
    assert.equal(probes.platform, process.platform);
    assert.equal(probes.id, PROBE_FAMILIES.includes(process.platform) ? process.platform : 'unsupported');
  });
});

describe('what each implementation declares', () => {
  it('lists the six capabilities of 33.2 with their classes', () => {
    assert.deepEqual(CAPABILITY_CLASSES, {
      'accelerator.memory': 'required',
      'accelerator.utilization': 'advisory',
      'accelerator.workingSetCap': 'advisory',
      'process.enumerate': 'required',
      'process.cpuTime': 'required',
      'process.classify': 'required',
    });
  });

  it('never lowers or raises a class, only says a capability is unmeasured or absent', () => {
    for (const platform of [...PROBE_FAMILIES, 'aix']) {
      const probes = selectProbes({ platform, env: {} });
      assert.deepEqual(Object.keys(probes.capabilities).sort(), [...CAPABILITIES].sort(), platform);
      for (const capability of CAPABILITIES) {
        const status = probes.capabilities[/** @type {keyof typeof CAPABILITY_CLASSES} */ (capability)];
        const allowed = [CAPABILITY_CLASSES[/** @type {keyof typeof CAPABILITY_CLASSES} */ (capability)], 'unavailable', 'not-applicable'];
        assert.ok(allowed.includes(status), `${platform} ${capability}: ${status}`);
      }
      const measuresCpuTime = probes.capabilities['process.cpuTime'] === 'required';
      assert.equal(probes.cpuTimeResolutionMs !== null && probes.cpuTimeResolutionMs > 0, measuresCpuTime, `${platform} cpuTimeResolutionMs`);
      assert.equal(probes.backend === 'none', probes.capabilities['accelerator.memory'] !== 'required', `${platform} backend`);
    }
  });

  it('declares on Windows what 33.2 measures there', () => {
    assert.deepEqual(selectProbes({ platform: 'win32', env: {} }).capabilities, {
      'accelerator.memory': 'required',
      'accelerator.utilization': 'advisory',
      'accelerator.workingSetCap': 'not-applicable',
      'process.enumerate': 'required',
      'process.cpuTime': 'required',
      'process.classify': 'required',
    });
  });
});

describe('a platform without a probe family', () => {
  it('reads every capability as unavailable with reason no_probe', async () => {
    const probes = selectProbes({ platform: 'aix', env: {} });
    assert.ok(Object.values(probes.capabilities).every((status) => status === 'unavailable'));
    const accelerator = await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
    assert.equal(accelerator.deviceCount, 0);
    assert.deepEqual(accelerator.memory, { status: 'unavailable', capability: 'accelerator.memory', reason: 'no_probe', detail: 'no probe for accelerator.memory ships for aix in this version' });
    assert.deepEqual(accelerator.utilization, { status: 'unavailable', capability: 'accelerator.utilization', reason: 'no_probe', detail: 'no probe for accelerator.utilization ships for aix in this version' });
    const unavailable = { status: 'unavailable', capability: 'process.enumerate', reason: 'no_probe', detail: 'no probe for process.enumerate ships for aix in this version' };
    assert.deepEqual(await probes.readUnityPresence({ timeoutMs: 1000 }), unavailable);
    assert.deepEqual(await probes.readProcessSnapshot({ patterns: [], sampleMs: 1500, sampleCpu: true, timeoutMs: 1000 }), unavailable);
  });
});

describe('the Windows accelerator read', () => {
  it('restates one nvidia-smi query as a memory read and a utilization read', async () => {
    const { fake, probes } = win32Probes({ 'nvidia-smi': { stdout: '0, 24576, 22000, 3\r\n1, 8192, 8000, 0\r\n' } });
    const signal = new AbortController().signal;
    const sample = await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 7000, signal });
    assert.deepEqual(sample, {
      deviceCount: 2,
      memory: { status: 'ok', value: { totalMiB: 24576, freeMiB: 22000, unit: 'vram' }, source: 'nvidia-smi', sampledAt: NOW_MS },
      utilization: { status: 'ok', value: { percent: 3 }, source: 'nvidia-smi', sampledAt: NOW_MS },
    });
    assert.equal(fake.calls.length, 1, 'both capabilities come from one process start');
    assert.equal(fake.calls[0].options.timeoutMs, 7000);
    assert.equal(fake.calls[0].options.signal, signal);
    assert.equal(fake.calls[0].options.platform, 'win32');
  });

  it('runs the configured command', async () => {
    const { fake, probes } = win32Probes({ 'fake-smi.exe': { stdout: '0, 24576, 22000, 3\r\n' } });
    await probes.readAccelerator({ nvidiaSmiCommand: 'D:/tools/fake-smi.exe', timeoutMs: 1000 });
    assert.equal(fake.calls[0].file, 'D:/tools/fake-smi.exe');
  });

  it('fails both capabilities with the nvidia-smi error text when the query fails', async () => {
    const { probes } = win32Probes({ 'nvidia-smi': { ok: false, exitCode: null, error: 'could not start (ENOENT)' } });
    const sample = await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
    assert.deepEqual(sample, {
      deviceCount: 0,
      memory: { status: 'error', capability: 'accelerator.memory', reason: 'probe_failed', detail: 'nvidia-smi could not start (ENOENT)' },
      utilization: { status: 'error', capability: 'accelerator.utilization', reason: 'probe_failed', detail: 'nvidia-smi could not start (ENOENT)' },
    });
  });

  it('keeps a readable memory figure when only utilization is unreadable, and the other way round', async () => {
    const utilizationNa = await win32Probes({ 'nvidia-smi': { stdout: '0, 24576, 22000, [N/A]\r\n' } }).probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
    assert.equal(utilizationNa.memory.status, 'ok');
    assert.deepEqual(utilizationNa.utilization, { status: 'error', capability: 'accelerator.utilization', reason: 'probe_failed', detail: "nvidia-smi utilization '[N/A]' is not a percent" });
    const memoryNa = await win32Probes({ 'nvidia-smi': { stdout: '0, 24576, [N/A], 3\r\n' } }).probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
    assert.equal(memoryNa.memory.status, 'error');
    assert.equal(memoryNa.utilization.status, 'ok');
    assert.equal(memoryNa.deviceCount, 1);
  });
});

describe('the Windows process reads', () => {
  it('answers presence from tasklist', async () => {
    const { fake, probes } = win32Probes({ 'tasklist.exe': { stdout: '"Unity.exe","4100","Console","1","2,335,016 K"\r\n' } });
    assert.deepEqual(await probes.readUnityPresence({ timeoutMs: 5000 }), { status: 'ok', value: { running: true, count: 1 }, source: 'tasklist', sampledAt: NOW_MS });
    assert.equal(fake.calls[0].file, 'C:\\Windows\\System32\\tasklist.exe');
    const failed = await win32Probes({ 'tasklist.exe': { ok: false, exitCode: null, error: 'could not start (ENOENT)' } }).probes.readUnityPresence({ timeoutMs: 5000 });
    assert.deepEqual(failed, { status: 'error', capability: 'process.enumerate', reason: 'probe_failed', detail: 'tasklist could not start (ENOENT)' });
  });

  it('answers the snapshot from the PowerShell script, naming each program', async () => {
    const { fake, probes } = win32Probes({ 'powershell.exe': { stdout: await readRecording('shader-children') } });
    const read = await probes.readProcessSnapshot({ patterns: ['AssetImportWorker'], sampleMs: 1500, sampleCpu: true, timeoutMs: 11_500 });
    assert.equal(read.status, 'ok');
    assert.equal(read.status === 'ok' && read.source, 'win32-probe.ps1');
    const processes = read.status === 'ok' ? read.value.processes : [];
    assert.deepEqual(processes.map((entry) => [entry.name, entry.program]), [
      ['Unity.exe', 'unity'],
      ['UnityShaderCompiler.exe', 'unityshadercompiler'],
      ['UnityShaderCompiler.exe', 'unityshadercompiler'],
      ['UnityShaderCompiler.exe', 'unityshadercompiler'],
    ]);
    assert.equal(fake.calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('fails the snapshot read with the probe error text', async () => {
    const { probes } = win32Probes({ 'powershell.exe': { stdout: '{"schema":2}\r\n' } });
    const read = await probes.readProcessSnapshot({ patterns: [], sampleMs: 1500, sampleCpu: true, timeoutMs: 11_500 });
    assert.deepEqual(read, { status: 'error', capability: 'process.enumerate', reason: 'probe_failed', detail: 'process probe output is malformed (unknown schema)' });
  });
});

describe('the Windows image-name rule', () => {
  it('drops .exe and case, and nothing else', () => {
    const cases = [
      ['Unity.exe', 'unity'],
      ['UNITY.EXE', 'unity'],
      ['Unity', 'unity'],
      ['UnityShaderCompiler.exe', 'unityshadercompiler'],
      ['Unity.exe.exe', 'unity.exe'],
      ['Unity.bin', 'unity.bin'],
      ['Unity.exe ', 'unity.exe '],
      ['Unity Hub.exe', 'unity hub'],
    ];
    for (const [name, program] of cases) assert.equal(readWin32ProgramName(name), program, name);
  });

  it('names the program of every process in a script answer and keeps the reported name', async () => {
    const reading = parseProbeResult({ ok: true, exitCode: 0, stdout: await readRecording('import-busy'), stderr: '', error: null, timedOut: false });
    assert.equal(reading.ok, true);
    const processes = reading.ok ? reading.snapshot.processes : [];
    assert.ok(processes.length > 0);
    for (const entry of processes) {
      assert.equal(entry.name, 'Unity.exe');
      assert.equal(entry.program, 'unity');
    }
  });
});

describe('the C locale', () => {
  it('replaces every Windows spelling of LC_ALL and LANG and keeps the rest', async () => {
    const fake = recordingRun();
    const run = withCLocale(fake.run, 'win32');
    await run('x', [], { timeoutMs: 1, env: { Path: 'C:\\bin', lc_all: 'de_DE', Lang: 'de_DE.UTF-8', LANG: 'tr_TR', SystemRoot: 'C:\\Windows' } });
    assert.deepEqual(fake.calls[0].options.env, { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', LC_ALL: 'C', LANG: 'C' });
  });

  it('replaces only the exact names where names are case-sensitive', async () => {
    const fake = recordingRun();
    const run = withCLocale(fake.run, 'linux');
    await run('x', [], { timeoutMs: 1, env: { PATH: '/bin', lang: 'kept', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE', LC_NUMERIC: 'de_DE' } });
    assert.deepEqual(fake.calls[0].options.env, { PATH: '/bin', lang: 'kept', LC_NUMERIC: 'de_DE', LC_ALL: 'C', LANG: 'C' });
  });

  it('starts from this process environment when a caller passes none, and keeps every other option', async () => {
    const fake = recordingRun();
    const signal = new AbortController().signal;
    await withCLocale(fake.run, process.platform)('x', ['a'], { timeoutMs: 5, signal, input: 'in' });
    const { env, ...rest } = fake.calls[0].options;
    assert.deepEqual(rest, { timeoutMs: 5, signal, input: 'in' });
    assert.equal(env?.LC_ALL, 'C');
    assert.equal(env?.LANG, 'C');
    assert.ok(Object.keys(env ?? {}).length > 2, 'the rest of the environment is kept');
  });
});
