import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_MAX_OUTPUT_BYTES, findExecutable, getFirstOutputLine, runProcess } from '../../../src/core/exec.js';

const NODE = process.execPath;
// Killing our own child directly keeps the test off taskkill, which is covered by the signal tests.
const killTree = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
};

describe('runProcess', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 10_000 });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.equal(result.error, null);
    assert.ok(result.durationMs >= 0);
  });

  it('passes arguments without a shell, so quotes and ampersands are literal', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdout.write(process.argv[1])', 'a & b "c"'], { timeoutMs: 10_000 });
    assert.equal(result.stdout, 'a & b "c"');
  });

  it('writes stdin and closes it', async () => {
    const script = 'let text = ""; process.stdin.on("data", (chunk) => { text += chunk; }); process.stdin.on("end", () => process.stdout.write(`[${text}]`));';
    const result = await runProcess(NODE, ['-e', script], { input: 'probe script', timeoutMs: 10_000 });
    assert.equal(result.stdout, '[probe script]');
  });

  it('closes stdin even without input, so a child that reads does not hang', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdin.on("end", () => process.stdout.write("done")); process.stdin.resume()'], { timeoutMs: 5000 });
    assert.equal(result.stdout, 'done');
    assert.equal(result.timedOut, false);
  });

  it('kills the process tree on a timeout and says so', async () => {
    const result = await runProcess(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 150, killTree });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it('stops on an abort signal', async () => {
    const controller = new AbortController();
    const pending = runProcess(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 10_000, signal: controller.signal, killTree });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
  });

  it('returns at once when the signal is already aborted', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdout.write("never")'], { timeoutMs: 1000, signal: AbortSignal.abort() });
    assert.equal(result.aborted, true);
    assert.equal(result.stdout, '');
  });

  it('reports a program that does not exist instead of throwing', async () => {
    const result = await runProcess(path.join(process.cwd(), 'no-such-program-xyz'), [], { timeoutMs: 5000 });
    assert.equal(/** @type {any} */ (result.error)?.code, 'ENOENT');
    assert.equal(result.exitCode, null);
  });

  it('caps output and reports that it was truncated', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeoutMs: 10_000, maxOutputBytes: 100 });
    assert.equal(result.stdout.length, 100);
    assert.equal(result.truncated, true);
    assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1024 * 1024);
  });

  it('hands the child to the caller, for example to track it for Ctrl+C', async () => {
    /** @type {number[]} */
    const seen = [];
    let untracked = false;
    const result = await runProcess(NODE, ['-e', 'process.stdout.write("ok")'], {
      timeoutMs: 10_000,
      onSpawn: (child) => {
        seen.push(/** @type {number} */ (child.pid));
        return () => {
          untracked = true;
        };
      },
    });
    assert.equal(result.stdout, 'ok');
    assert.equal(seen.length, 1);
    assert.equal(untracked, true);
  });

  it('refuses a Windows batch shim, which would need a shell that re-parses arguments', async () => {
    const result = await runProcess('C:\\npm\\opencode.cmd', ['--version'], { timeoutMs: 1000, platform: 'win32' });
    assert.equal(/** @type {any} */ (result.error)?.code, 'ESHELLSHIM');
    assert.match(/** @type {any} */ (result.error).message, /batch file/);
  });

  it('needs a timeout', () => {
    assert.throws(() => runProcess(NODE, [], { timeoutMs: 0 }), /timeoutMs/);
  });

  it('reads a version line out of mixed output', () => {
    assert.equal(getFirstOutputLine({ stdout: '\n  1.18.31 \n', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 }), '1.18.31');
    assert.equal(getFirstOutputLine({ stdout: '', stderr: 'ollama version is 0.34.1', exitCode: 0, signal: null, timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 }), 'ollama version is 0.34.1');
    assert.equal(getFirstOutputLine({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 }), '');
  });
});

describe('findExecutable', () => {
  const files = new Set(['C:\\bin\\ollama.exe', 'C:\\bin\\opencode.cmd', '/usr/bin/ollama', '/usr/bin/node']);
  // Windows file names are case-insensitive, and PATHEXT entries are usually upper case.
  const lowered = new Set([...files].map((file) => file.toLowerCase()));
  const isFile = (/** @type {string} */ candidate) => files.has(candidate) || lowered.has(candidate.toLowerCase());

  it('tries every PATHEXT extension on Windows', () => {
    const env = { Path: 'C:\\missing;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findExecutable('ollama', { env, platform: 'win32', isFile }), 'C:\\bin\\ollama.EXE');
    assert.equal(findExecutable('opencode', { env, platform: 'win32', isFile }), 'C:\\bin\\opencode.CMD');
    assert.equal(findExecutable('ollama.exe', { env, platform: 'win32', isFile }), 'C:\\bin\\ollama.exe');
    assert.equal(findExecutable('nvidia-smi', { env, platform: 'win32', isFile }), null);
  });

  it('searches PATH in order on POSIX', () => {
    const env = { PATH: '/empty:/usr/bin' };
    assert.equal(findExecutable('ollama', { env, platform: 'linux', isFile }), '/usr/bin/ollama');
    assert.equal(findExecutable('missing', { env, platform: 'linux', isFile }), null);
  });

  it('checks a name with a directory part as given', () => {
    assert.equal(findExecutable('C:\\bin\\ollama', { env: {}, platform: 'win32', isFile }), 'C:\\bin\\ollama.EXE');
    assert.equal(findExecutable('/usr/bin/node', { env: {}, platform: 'linux', isFile }), '/usr/bin/node');
    assert.equal(findExecutable('/usr/bin/absent', { env: {}, platform: 'linux', isFile }), null);
  });

  it('finds the real node binary on this machine', () => {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const found = findExecutable(name);
    assert.ok(found === null || found.length > 0);
  });
});
