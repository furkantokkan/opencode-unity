// The environment adapter behind setup item 7 (spec 14.1, amendment 38.11). No test here touches the
// real registry or launchd: every adapter gets a fake runner that records what would have been run.
//
// The quoting cases are hostile on purpose. A value reaches PowerShell as source text, so the single
// quote, `$`, the backtick and a line break are each proven harmless or refused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEnvName,
  assertEnvValue,
  createLaunchctlAdapter,
  createPrintOnlyAdapter,
  createUserEnvAdapter,
  createWindowsUserEnvAdapter,
  quotePowerShell,
  renderEnvInstructions,
  resolveWindowsPowerShell,
} from '../../src/install/user-env.js';
import { catchAsync } from '../helpers/catch-error.mjs';

/**
 * @param {Array<Partial<import('../../src/core/exec.js').RunResult>>} [results]
 */
function fakeRun(results = []) {
  /** @type {Array<{ file: string, args: readonly string[], input: string | undefined }>} */
  const calls = [];
  /** @type {typeof import('../../src/core/exec.js').runProcess} */
  const run = async (file, args, options) => {
    calls.push({ file, args, input: options.input });
    const next = results.shift() ?? {};
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1, ...next };
  };
  return { run, calls };
}

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' };

describe('PowerShell quoting', () => {
  it('doubles a single quote and nothing else', () => {
    assert.equal(quotePowerShell("it's"), "'it''s'");
  });

  it('leaves $, backtick and double quote literal inside single quotes', () => {
    assert.equal(quotePowerShell('$env:PATH `whoami` "x"'), `'$env:PATH \`whoami\` "x"'`);
  });

  it('cannot be closed early by a crafted value', () => {
    const quoted = quotePowerShell("'; Remove-Item C:\\ -Recurse; '");
    // Every quote inside is doubled, so the literal ends only at the final character.
    assert.equal(quoted, "'''; Remove-Item C:\\ -Recurse; '''");
    const inner = quoted.slice(1, -1);
    assert.equal(inner.replaceAll("''", '').includes("'"), false);
  });
});

describe('environment names and values', () => {
  for (const name of ['OLLAMA_HOST', '_X', 'a1']) {
    it(`accepts the name ${name}`, () => assert.equal(assertEnvName(name), name));
  }
  for (const name of ['1A', 'A B', 'A;B', 'A=B', "A'B", '', 'A-B', '$A']) {
    it(`refuses the name ${JSON.stringify(name)}`, () => assert.throws(() => assertEnvName(name), /not a usable environment variable name/));
  }

  for (const [label, value] of [
    ['a line feed', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a NUL', 'a\u0000b'],
    ['an escape', 'a\u001bb'],
    ['a delete', 'a\u007fb'],
  ]) {
    it(`refuses a value with ${label}`, () => assert.throws(() => assertEnvValue(value), /control characters/));
  }

  it('refuses an oversized value and a non-string', () => {
    assert.throws(() => assertEnvValue('x'.repeat(2049)), /at most 2048/);
    assert.throws(() => assertEnvValue(/** @type {any} */ (5)), /must be a string/);
  });
});

describe('Windows PowerShell location', () => {
  const SYSTEM_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  it('takes the copy in the system directory, not whatever is first on PATH', () => {
    const files = new Set([SYSTEM_POWERSHELL.toLowerCase(), 'c:\\evil\\powershell.exe']);
    const found = resolveWindowsPowerShell({
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', PATHEXT: '.COM;.EXE' },
      isFile: (candidate) => files.has(candidate.toLowerCase()),
    });
    assert.equal(found.toLowerCase(), SYSTEM_POWERSHELL.toLowerCase());
  });

  it('falls back to PATH without SystemRoot, and to the bare name without either', () => {
    const onPath = resolveWindowsPowerShell({ env: { PATH: 'C:\\Tools', PATHEXT: '.EXE' }, isFile: (candidate) => candidate.toLowerCase() === 'c:\\tools\\powershell.exe' });
    assert.equal(onPath.toLowerCase(), 'c:\\tools\\powershell.exe');
    assert.equal(resolveWindowsPowerShell({ env: { SystemRoot: 'C:\\Windows' }, isFile: () => false }), 'powershell');
  });
});

describe('Windows adapter', () => {
  it('pipes a script to Windows PowerShell, without -EncodedCommand', async () => {
    const { run, calls } = fakeRun([{ stdout: '"q8_0"' }]);
    const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });

    assert.equal(await adapter.read('OLLAMA_KV_CACHE_TYPE'), 'q8_0');

    assert.equal(calls[0].file, 'PS');
    assert.deepEqual(calls[0].args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    assert.match(/** @type {string} */ (calls[0].input), /GetEnvironmentVariable\('OLLAMA_KV_CACHE_TYPE', 'User'\)/);
    assert.equal(adapter.kind, 'userEnv');
  });

  it('reads an unset variable as null', async () => {
    const { run } = fakeRun([{ stdout: 'null' }]);
    const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });
    assert.equal(await adapter.read('A'), null);
  });

  it('writes user scope only, with the value quoted', async () => {
    const { run, calls } = fakeRun();
    const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });

    await adapter.write('A', "x'y$z");

    assert.equal(calls[0].input, "[Environment]::SetEnvironmentVariable('A', 'x''y$z', 'User')\n");
  });

  it('restores a missing variable by removing it', async () => {
    const { run, calls } = fakeRun();
    const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });

    await adapter.restore('A', null);
    await adapter.restore('A', 'old');

    assert.equal(calls[0].input, "[Environment]::SetEnvironmentVariable('A', $null, 'User')\n");
    assert.equal(calls[1].input, "[Environment]::SetEnvironmentVariable('A', 'old', 'User')\n");
  });

  it('refuses a hostile value before anything is started', async () => {
    const { run, calls } = fakeRun();
    const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });

    await assert.rejects(adapter.write('A', "x'\nRemove-Item C:\\"), /control characters/);
    await assert.rejects(adapter.write('A;B', 'x'), /not a usable/);
    assert.deepEqual(calls, []);
  });

  it('reports a failed, timed-out or unstartable PowerShell', async () => {
    for (const [result, pattern] of /** @type {const} */ ([
      [{ exitCode: 1, stderr: 'Access denied' }, /exited 1: Access denied/],
      [{ timedOut: true, exitCode: null }, /did not answer/],
      [{ error: new Error('ENOENT'), exitCode: null }, /could not be started/],
      [{ stdout: '{"a":1}' }, /unexpected shape/],
      [{ stdout: 'not json' }, /not JSON/],
    ])) {
      const { run } = fakeRun([result]);
      const adapter = createWindowsUserEnvAdapter({ env: WINDOWS_ENV, timeoutMs: 1000, run, locate: () => 'PS' });
      const error = await catchAsync(() => adapter.read('A'));
      assert.match(error.message, pattern);
    }
  });

  it('finds PowerShell only when it first has to run it', async () => {
    let located = 0;
    const { run } = fakeRun([{ stdout: 'null' }]);
    const adapter = createWindowsUserEnvAdapter({ env: {}, timeoutMs: 1000, run, locate: () => `PS${(located += 1)}` });
    assert.equal(located, 0);
    await adapter.read('A');
    assert.equal(located, 1);
  });
});

describe('launchctl adapter', () => {
  it('reads, writes and restores through launchctl with arguments, never a shell', async () => {
    const { run, calls } = fakeRun([{ stdout: '1\n' }, {}, {}, {}]);
    const adapter = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run });

    assert.equal(await adapter.read('OLLAMA_FLASH_ATTENTION'), '1');
    await adapter.write('OLLAMA_FLASH_ATTENTION', '1');
    await adapter.restore('OLLAMA_FLASH_ATTENTION', null);
    await adapter.restore('OLLAMA_FLASH_ATTENTION', '0');

    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args]),
      [
        ['/bin/launchctl', 'getenv', 'OLLAMA_FLASH_ATTENTION'],
        ['/bin/launchctl', 'setenv', 'OLLAMA_FLASH_ATTENTION', '1'],
        ['/bin/launchctl', 'unsetenv', 'OLLAMA_FLASH_ATTENTION'],
        ['/bin/launchctl', 'setenv', 'OLLAMA_FLASH_ATTENTION', '0'],
      ],
    );
    assert.equal(adapter.kind, 'launchctlEnv');
  });

  it('reads an unset or failing getenv as null', async () => {
    const { run } = fakeRun([{ stdout: '' }, { exitCode: 1 }]);
    const adapter = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run });
    assert.equal(await adapter.read('A'), null);
    assert.equal(await adapter.read('A'), null);
  });

  it('reports a failing setenv and a missing launchctl', async () => {
    const failing = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run: fakeRun([{ exitCode: 2, stderr: 'denied' }]).run });
    await assert.rejects(failing.write('A', 'b'), /exited 2: denied/);
    const missing = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run: fakeRun([{ error: new Error('ENOENT'), exitCode: null }]).run });
    await assert.rejects(missing.read('A'), /could not be started/);
    const slow = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run: fakeRun([{ timedOut: true, exitCode: null }]).run });
    await assert.rejects(slow.read('A'), /did not answer/);
    const restoring = createLaunchctlAdapter({ env: {}, timeoutMs: 1000, run: fakeRun([{ exitCode: 3, stderr: 'no' }]).run });
    await assert.rejects(restoring.restore('A', null), /unsetenv exited 3/);
  });
});

describe('print-only adapter', () => {
  it('reads nothing, restores nothing, and refuses to write', async () => {
    const adapter = createPrintOnlyAdapter();
    assert.equal(adapter.kind, 'print');
    assert.equal(await adapter.read('A'), null);
    await adapter.restore('A', 'x');
    await assert.rejects(adapter.write('A', 'b'), /never writes/);
  });
});

describe('adapter selection', () => {
  it('writes on Windows and macOS, and only prints on Linux', () => {
    assert.equal(createUserEnvAdapter({ platform: 'win32', env: WINDOWS_ENV }).kind, 'userEnv');
    assert.equal(createUserEnvAdapter({ platform: 'darwin', env: {} }).kind, 'launchctlEnv');
    assert.equal(createUserEnvAdapter({ platform: 'linux', env: {} }).kind, 'print');
    assert.equal(createUserEnvAdapter({ platform: 'freebsd', env: {} }).kind, 'print');
  });
});

describe('printed instructions', () => {
  const values = { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' };

  it('gives Linux a systemd drop-in, never a command it runs', () => {
    const lines = renderEnvInstructions(values, 'linux');
    assert.equal(lines[0], 'sudo systemctl edit ollama, then add:');
    assert.ok(lines.includes('  Environment="OLLAMA_KV_CACHE_TYPE=q8_0"'));
  });

  it('gives macOS and Windows their own command', () => {
    assert.deepEqual(renderEnvInstructions(values, 'darwin'), ['launchctl setenv OLLAMA_FLASH_ATTENTION 1', 'launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0']);
    assert.match(renderEnvInstructions(values, 'win32')[0], /SetEnvironmentVariable\('OLLAMA_FLASH_ATTENTION', '1', 'User'\)/);
  });

  it('prints nothing for no values', () => {
    assert.deepEqual(renderEnvInstructions({}, 'linux'), []);
  });
});
