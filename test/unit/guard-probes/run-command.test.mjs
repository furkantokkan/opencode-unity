// Running a probe command without a shell: output, exit codes, timeouts, aborts and stdin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readEnv, resolveInvocation, runCommand, summarizeOutput } from '../../../plugin/opencode-unity-lib/guard/probes/run-command.js';
import { createSandbox } from '../../helpers/sandbox.mjs';

const SCRIPTS = {
  ok: "process.stdout.write('0, 24576, 22000, 3\\n'); process.stderr.write('noise\\n');",
  fail: "process.stderr.write('driver not loaded\\n'); process.exit(9);",
  slow: 'setTimeout(() => {}, 30000);',
  stdin: "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { text += chunk; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ length: text.length, head: text.slice(0, 20) })));",
  flood: "const line = 'x'.repeat(1024) + '\\n'; for (let index = 0; index < 8000; index += 1) process.stdout.write(line);",
  env: 'process.stdout.write(String(process.env.OCU_PROBE_TEST));',
  bom: "process.stdout.write(String.fromCharCode(0xfeff) + 'with byte order mark');",
};

/** @type {import('../../helpers/sandbox.mjs').Sandbox} */
let sandbox;

before(async () => {
  sandbox = await createSandbox('run-command');
  await Promise.all(Object.entries(SCRIPTS).map(([name, source]) => fs.writeFile(path.join(sandbox.dirs.bin, `${name}.mjs`), source)));
});

after(() => sandbox.cleanup());

/**
 * @param {keyof typeof SCRIPTS} name
 * @returns {string}
 */
function script(name) {
  return path.join(sandbox.dirs.bin, `${name}.mjs`);
}

describe('runCommand', () => {
  it('collects stdout and stderr of a command that exits 0', async () => {
    const result = await runCommand(process.execPath, [script('ok')], { timeoutMs: 20_000 });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '0, 24576, 22000, 3\n');
    assert.equal(result.stderr, 'noise\n');
    assert.equal(result.error, null);
    assert.equal(result.timedOut, false);
  });

  it('reports a non-zero exit code as an error and keeps the output', async () => {
    const result = await runCommand(process.execPath, [script('fail')], { timeoutMs: 20_000 });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 9);
    assert.match(result.error ?? '', /exited with code 9/);
    assert.equal(result.stderr, 'driver not loaded\n');
  });

  it('stops a command that answers too late and kills its process tree', async () => {
    const startedAt = Date.now();
    const result = await runCommand(process.execPath, [script('slow')], { timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.error ?? '', /did not answer within 0\.3 s/);
    assert.ok(Date.now() - startedAt < 10_000);
  });

  it('writes stdin and closes it', async () => {
    const input = `$ocuSampleMs = 1500\n${'#'.repeat(40)}\n`;
    const result = await runCommand(process.execPath, [script('stdin')], { timeoutMs: 20_000, input });
    assert.equal(result.ok, true);
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.length, input.length);
    assert.equal(answer.head, '$ocuSampleMs = 1500\n');
  });

  it('refuses a command that floods the pipe', async () => {
    const result = await runCommand(process.execPath, [script('flood')], { timeoutMs: 20_000 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /printed more output than a probe ever needs/);
  });

  it('passes only the environment it is given', async () => {
    const withValue = await runCommand(process.execPath, [script('env')], { timeoutMs: 20_000, env: { ...sandbox.env, OCU_PROBE_TEST: 'seen' } });
    assert.equal(withValue.stdout, 'seen');
    const withoutValue = await runCommand(process.execPath, [script('env')], { timeoutMs: 20_000, env: sandbox.env });
    assert.equal(withoutValue.stdout, 'undefined');
  });

  it('strips a byte order mark from the output', async () => {
    const result = await runCommand(process.execPath, [script('bom')], { timeoutMs: 20_000 });
    assert.equal(result.stdout, 'with byte order mark');
  });

  it('reports a command that cannot start', async () => {
    const result = await runCommand('opencode-unity-no-such-probe', ['--version'], { timeoutMs: 20_000 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /could not start \(ENOENT\)/);
  });

  it('answers at once when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand(process.execPath, [script('slow')], { timeoutMs: 20_000, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /was aborted/);
  });

  it('stops a running command when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = runCommand(process.execPath, [script('slow')], { timeoutMs: 20_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /was aborted/);
  });
});

describe('resolveInvocation', () => {
  it('runs a plain command as it is', () => {
    assert.deepEqual(resolveInvocation('nvidia-smi', ['--query-gpu=index'], { platform: 'win32', env: {} }), {
      file: 'nvidia-smi',
      args: ['--query-gpu=index'],
      windowsVerbatimArguments: false,
    });
  });

  it('runs a JavaScript file with Node, which tests use for fakes', () => {
    const invocation = resolveInvocation('C:/fake/nvidia-smi.mjs', ['--query-gpu=index'], { platform: 'win32', env: {}, nodePath: 'node' });
    assert.deepEqual(invocation, { file: 'node', args: ['C:/fake/nvidia-smi.mjs', '--query-gpu=index'], windowsVerbatimArguments: false });
  });

  it('runs a .cmd through the command interpreter, which Node cannot start on its own', () => {
    const invocation = resolveInvocation('C:/fake/nvidia-smi.cmd', ['--query-gpu=index'], { platform: 'win32', env: { ComSpec: 'C:/Windows/System32/cmd.exe' } });
    assert.deepEqual(invocation, {
      file: 'C:/Windows/System32/cmd.exe',
      args: ['/d', '/s', '/c', '""C:/fake/nvidia-smi.cmd" --query-gpu=index"'],
      windowsVerbatimArguments: true,
    });
  });

  it('refuses a .cmd path or argument that the interpreter would read as syntax', () => {
    assert.throws(() => resolveInvocation('C:/fake/nvidia&smi.cmd', [], { platform: 'win32', env: {} }), /special characters/);
    assert.throws(() => resolveInvocation('C:/fake/nvidia-smi.cmd', ['--query-gpu=index a'], { platform: 'win32', env: {} }), /special characters/);
  });

  it('treats a .cmd name as a plain command away from Windows', () => {
    const invocation = resolveInvocation('nvidia-smi.cmd', [], { platform: 'linux', env: {} });
    assert.equal(invocation.file, 'nvidia-smi.cmd');
  });

  it('really starts a .cmd file on Windows', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async () => {
    const launcher = path.join(sandbox.dirs.bin, 'probe.cmd');
    await fs.writeFile(launcher, `@echo off\r\n@echo 0, 24576, 22000, 3\r\n`);
    const invocation = resolveInvocation(launcher, ['--query-gpu=index'], { platform: 'win32', env: sandbox.env });
    const result = await runCommand(invocation.file, invocation.args, { timeoutMs: 20_000, env: sandbox.env, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.stdout.trim(), '0, 24576, 22000, 3');
  });
});

describe('probe helpers', () => {
  it('reads environment variables the way Windows does', () => {
    assert.equal(readEnv({ SystemRoot: 'C:/Windows' }, 'SYSTEMROOT'), 'C:/Windows');
    assert.equal(readEnv({ SYSTEMROOT: 'C:/Windows' }, 'SystemRoot'), 'C:/Windows');
    assert.equal(readEnv({}, 'SystemRoot'), undefined);
  });

  it('shortens command output for a detail line', () => {
    assert.equal(summarizeOutput('  two   lines\nhere  '), 'two lines here');
    assert.equal(summarizeOutput('x'.repeat(200), 20), `${'x'.repeat(17)}...`);
    assert.equal(summarizeOutput('   '), '');
  });
});
