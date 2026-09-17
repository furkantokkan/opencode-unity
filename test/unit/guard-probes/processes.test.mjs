// The Unity process probes: the fast tasklist check, the PowerShell probe script, and the answer for
// platforms this version has no adapter for.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildProbeInput, createWin32ProcessProbe, parseProbeResult, parseTasklistOutput, readProbeScript } from '../../../plugin/opencode-unity-lib/guard/probes/processes-win32.js';
import { createUnsupportedProcessProbe } from '../../../plugin/opencode-unity-lib/guard/probes/processes-unsupported.js';

const FIXTURES = new URL('../../fixtures/processes/', import.meta.url);
const ENV = { SystemRoot: 'C:\\Windows' };
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * @param {string} name
 * @returns {Promise<unknown>}
 */
async function readFixture(name) {
  return JSON.parse(await fs.readFile(new URL(name, FIXTURES), 'utf8'));
}

/**
 * @param {Array<Partial<import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').CommandResult>>} answers
 */
function fakeRun(answers) {
  const calls = [];
  let index = 0;
  return {
    calls,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return { ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...answer };
    },
  };
}

describe('tasklist output', () => {
  it('counts the Unity processes it lists', () => {
    const text = '"Unity.exe","4100","Console","1","2,335,016 K"\r\n"Unity.exe","4310","Console","1","1,003,548 K"\r\n';
    assert.deepEqual(parseTasklistOutput(text), { ok: true, running: true, count: 2 });
  });

  it('reads the localized "no tasks" line as no Unity process', () => {
    assert.deepEqual(parseTasklistOutput('INFO: No tasks are running which match the specified criteria.\r\n'), { ok: true, running: false, count: 0 });
    assert.deepEqual(parseTasklistOutput('INFORMATION: Es werden keine Tasks ausgefuehrt.\r\n'), { ok: true, running: false, count: 0 });
  });

  it('fails closed on output it does not recognize', () => {
    for (const text of ['', 'Unity.exe 4100\r\n', 'ERROR\r\nsecond line\r\n', '"Unity.exe","4100"\r\n"notepad.exe","5100","Console","1","1 K"\r\n']) {
      const reading = parseTasklistOutput(text);
      assert.equal(reading.ok, false, `expected ${JSON.stringify(text)} to be refused`);
    }
  });

  it('refuses a row for another program', () => {
    const reading = parseTasklistOutput('"notepad.exe","5100","Console","1","1 K"\r\n');
    assert.equal(reading.ok, false);
    assert.match(reading.error, /unexpected tasklist row/);
  });
});

describe('the PowerShell probe input', () => {
  it('puts the settings first, strips comments and blank lines, and ends with a blank line', () => {
    const script = '# a comment\n\n$first = 1\n\n  # indented comment\n$second = 2\n';
    const input = buildProbeInput(script, { patterns: ['AssetImportWorker'], sampleMs: 1500, sampleCpu: true });
    const lines = input.split('\n');
    assert.equal(lines[0], `$ocuSampleMs = 1500; $ocuSampleCpu = $true; $ocuPatterns = @('${Buffer.from('AssetImportWorker').toString('base64')}')`);
    assert.deepEqual(lines.slice(1, 3), ['$first = 1', '$second = 2']);
    assert.ok(input.endsWith('\n\n'), 'PowerShell runs the block only after a blank line');
  });

  it('carries patterns as base64, so no character needs quoting', () => {
    const input = buildProbeInput('$x = 1\n', { patterns: ["it's", 'a b*c', '\u00fcber'], sampleMs: 200, sampleCpu: false });
    assert.match(input, /\$ocuSampleCpu = \$false/);
    const encoded = /\$ocuPatterns = @\((.*)\)/.exec(input)?.[1] ?? '';
    const decoded = encoded.split(', ').map((item) => Buffer.from(item.replaceAll("'", ''), 'base64').toString('utf8'));
    assert.deepEqual(decoded, ["it's", 'a b*c', '\u00fcber']);
  });

  it('refuses a sample window that is not a whole number of milliseconds', () => {
    assert.throws(() => buildProbeInput('$x = 1\n', { patterns: [], sampleMs: -1, sampleCpu: true }), /non-negative integer/);
    assert.throws(() => buildProbeInput('$x = 1\n', { patterns: [], sampleMs: 1.5, sampleCpu: true }), /non-negative integer/);
  });

  it('ships a script that only reads', async () => {
    const script = await readProbeScript();
    assert.match(script, /Get-CimInstance -ClassName Win32_Process/);
    assert.match(script, /ConvertTo-Json/);
    assert.ok(!/Stop-Process|Remove-Item|Set-Content|Invoke-WebRequest|Start-Process/.test(script), 'the probe script must not change anything');
  });
});

describe('the PowerShell probe answer', () => {
  it('validates a snapshot the script printed', async () => {
    const snapshot = await readFixture('idle-editor.json');
    const reading = parseProbeResult({ ok: true, exitCode: 0, stdout: `${JSON.stringify(snapshot)}\r\n`, stderr: '', error: null, timedOut: false });
    assert.equal(reading.ok, true);
    assert.equal(reading.snapshot.processes.length, 2);
  });

  it('takes the last JSON line, because PowerShell may print earlier noise', () => {
    const reading = parseProbeResult({ ok: true, exitCode: 0, stdout: 'warning\n{"broken"\n{"schema":1,"probePid":1,"ancestors":[],"sampleMs":0,"elapsedMs":null,"processes":[]}\n', stderr: '', error: null, timedOut: false });
    assert.equal(reading.ok, true);
    assert.equal(reading.snapshot.probePid, 1);
  });

  it('reports the failure JSON the script prints before exiting 1', () => {
    const reading = parseProbeResult({ ok: false, exitCode: 1, stdout: '{"schema":1,"error":"Access denied by the CIM service"}\n', stderr: '', error: 'exited with code 1', timedOut: false });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /exited with code 1: Access denied by the CIM service/);
  });

  it('fails closed when PowerShell printed no JSON at all', () => {
    const reading = parseProbeResult({ ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /printed no JSON/);
  });

  it('fails closed on a timeout', () => {
    const reading = parseProbeResult({ ok: false, exitCode: null, stdout: '', stderr: '', error: 'did not answer within 11.5 s', timedOut: true });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /did not answer within 11\.5 s/);
  });
});

describe('the Windows process probe', () => {
  it('asks tasklist for Unity.exe only, without PowerShell', async () => {
    const fake = fakeRun([{ stdout: '"Unity.exe","4100","Console","1","2,335,016 K"\r\n' }]);
    const probe = createWin32ProcessProbe({ run: fake.run, env: ENV });
    const presence = await probe.detect({ timeoutMs: 5000 });
    assert.deepEqual(presence, { ok: true, running: true, count: 1 });
    assert.equal(fake.calls[0].file, TASKLIST);
    assert.deepEqual(fake.calls[0].args, ['/FI', 'IMAGENAME eq Unity.exe', '/FO', 'CSV', '/NH']);
    assert.equal(fake.calls[0].options.timeoutMs, 5000);
  });

  it('turns a failed tasklist call into an error', async () => {
    const fake = fakeRun([{ ok: false, error: 'could not start (ENOENT)', stderr: '' }]);
    const probe = createWin32ProcessProbe({ run: fake.run, env: ENV });
    const presence = await probe.detect({ timeoutMs: 5000 });
    assert.equal(presence.ok, false);
    assert.match(presence.error, /tasklist could not start \(ENOENT\)/);
  });

  it('pipes the script to PowerShell without an encoded command or a policy change', async () => {
    const snapshot = await readFixture('import-busy.json');
    const fake = fakeRun([{ stdout: `${JSON.stringify(snapshot)}\r\n` }]);
    const probe = createWin32ProcessProbe({ run: fake.run, env: ENV });
    const reading = await probe.sample({ patterns: ['AssetImportWorker'], sampleMs: 1500, sampleCpu: true, timeoutMs: 11_500 });
    assert.equal(reading.ok, true);
    const call = fake.calls[0];
    assert.equal(call.file, POWERSHELL);
    assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    assert.equal(call.options.timeoutMs, 11_500);
    assert.match(call.options.input, /^\$ocuSampleMs = 1500; \$ocuSampleCpu = \$true;/);
    assert.ok(call.options.input.endsWith('\n\n'));
  });

  it('reports a script that cannot be read', async () => {
    const fake = fakeRun([{ stdout: '' }]);
    const probe = createWin32ProcessProbe({
      run: fake.run,
      env: ENV,
      readScript: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const reading = await probe.sample({ patterns: [], sampleMs: 1500, sampleCpu: true, timeoutMs: 11_500 });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /probe script could not be read/);
    assert.equal(fake.calls.length, 0);
  });

  it('falls back to the plain program names without SystemRoot', async () => {
    const fake = fakeRun([{ stdout: 'INFO: No tasks\r\n' }]);
    const probe = createWin32ProcessProbe({ run: fake.run, env: {} });
    await probe.detect({ timeoutMs: 5000 });
    assert.equal(fake.calls[0].file, 'tasklist.exe');
  });

  it('reads this machine for real', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async () => {
    const probe = createWin32ProcessProbe();
    const presence = await probe.detect({ timeoutMs: 20_000 });
    assert.equal(presence.ok, true, presence.ok ? '' : presence.error);
    const reading = await probe.sample({ patterns: ['opencode-unity-no-such-process'], sampleMs: 150, sampleCpu: true, timeoutMs: 40_000 });
    assert.equal(reading.ok, true, reading.ok ? '' : reading.error);
    assert.ok(reading.snapshot.probePid > 0);
    assert.ok(reading.snapshot.ancestors.includes(process.pid), 'the probe must know its own parent chain, so the guard can skip it');
    assert.equal(reading.snapshot.sampleMs, 150);
  });
});

describe('the probe for platforms without an adapter', () => {
  it('answers with an error, so the guard blocks', async () => {
    const probe = createUnsupportedProcessProbe('darwin');
    assert.equal(probe.platform, 'darwin');
    const presence = await probe.detect({ timeoutMs: 5000 });
    assert.equal(presence.ok, false);
    assert.match(presence.error, /not implemented on darwin/);
    const reading = await probe.sample({ patterns: [], sampleMs: 1500, sampleCpu: true, timeoutMs: 5000 });
    assert.equal(reading.ok, false);
  });
});
