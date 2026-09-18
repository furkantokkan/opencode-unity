// `ollama pull/create/rm` and `npm i -g` behind their interfaces (spec 14.1 items 1, 4, 5). Every test
// hands in a fake runner and a fake PATH; nothing is started and no network is used.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertModelName,
  assertPackageName,
  assertVersion,
  createModelInstaller,
  createNpmInstaller,
  resolveNpmCommand,
} from '../../src/install/external.js';
import { useSandbox } from '../helpers/sandbox.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {Array<Partial<import('../../src/core/exec.js').RunResult>>} [results]
 */
function fakeRun(results = []) {
  /** @type {Array<{ file: string, args: readonly string[], timeoutMs: number }>} */
  const calls = [];
  /** @type {typeof import('../../src/core/exec.js').runProcess} */
  const run = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1, ...(results.shift() ?? {}) };
  };
  return { run, calls };
}

/**
 * A directory on a fake PATH holding an empty file per name, so `findExecutable` finds them.
 * @param {import('node:test').TestContext} t
 * @param {string[]} names
 */
async function fakePath(t, names) {
  const sandbox = await useSandbox(t, 'external');
  const bin = sandbox.dirs.bin;
  for (const name of names) await fs.writeFile(path.join(bin, name), '', 'utf8');
  return { bin, env: { PATH: bin, PATHEXT: '.EXE;.CMD' } };
}

const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';

describe('model installer', () => {
  it('runs pull, create and rm with plain arguments', async (t) => {
    const { bin, env } = await fakePath(t, [exe]);
    const { run, calls } = fakeRun();
    const installer = createModelInstaller({ env, platform: process.platform, run, timeouts: { pull: 10, create: 20, remove: 30 } });

    await installer.pull('qwen3-coder:30b');
    await installer.create('ocu-qwen3-coder-30b-16k', '/profile/Modelfile');
    await installer.remove('ocu-qwen3-coder-30b-16k');

    // Windows reports the PATHEXT spelling (`ollama.EXE`); the volume does not care about case.
    assert.deepEqual(
      calls.map((call) => [path.basename(call.file).toLowerCase(), ...call.args, call.timeoutMs]),
      [
        [exe, 'pull', 'qwen3-coder:30b', 10],
        [exe, 'create', 'ocu-qwen3-coder-30b-16k', '-f', '/profile/Modelfile', 20],
        [exe, 'rm', 'ocu-qwen3-coder-30b-16k', 30],
      ],
    );
    assert.equal(path.dirname(calls[0].file), bin);
  });

  it('says what to do when ollama is not on PATH', async () => {
    const installer = createModelInstaller({ env: { PATH: '' }, platform: process.platform, run: fakeRun().run });
    await assert.rejects(installer.pull('a:b'), /was not found on PATH/);
  });

  it('turns every kind of failure into a sentence', async (t) => {
    const { env } = await fakePath(t, [exe]);
    for (const [result, pattern] of /** @type {const} */ ([
      [{ exitCode: 1, stderr: 'pulling manifest\nError: pull model manifest: file does not exist' }, /exited 1: Error: pull model manifest/],
      [{ timedOut: true, exitCode: null }, /did not finish within/],
      [{ aborted: true, exitCode: null }, /was interrupted/],
      [{ error: new Error('EACCES'), exitCode: null }, /could not be started \(EACCES\)/],
    ])) {
      const installer = createModelInstaller({ env, platform: process.platform, run: fakeRun([result]).run });
      await assert.rejects(installer.pull('a:b'), pattern);
    }
  });

  it('refuses a model name it would have to quote', async () => {
    const installer = createModelInstaller({ env: {}, platform: process.platform, run: fakeRun().run });
    await assert.rejects(installer.pull('a b'), /not a usable Ollama model name/);
  });
});

describe('model names', () => {
  for (const name of ['qwen3-coder:30b', 'library/llama3:8b-instruct-q4_K_M', 'ocu-qwen3-coder-30b-16k', 'a']) {
    it(`accepts ${name}`, () => assert.equal(assertModelName(name), name));
  }
  for (const name of ['', '-rm', 'a b', 'a;b', 'a:b:c', 'a$(x)', '../a', 'a:']) {
    it(`refuses ${JSON.stringify(name)}`, () => assert.throws(() => assertModelName(name)));
  }
});

describe('npm names and versions', () => {
  it('accepts plain and scoped names and a semver', () => {
    assert.equal(assertPackageName('opencode-ai'), 'opencode-ai');
    assert.equal(assertPackageName('@scope/pkg'), '@scope/pkg');
    assert.equal(assertVersion('1.18.31'), '1.18.31');
    assert.equal(assertVersion('1.0.0-beta.2'), '1.0.0-beta.2');
  });

  it('refuses anything that would reach npm as more than a name', () => {
    for (const name of ['Opencode', 'a b', '--global', 'a;b', '@/x']) assert.throws(() => assertPackageName(name));
    for (const version of ['latest', '^1.0.0', '1.0', '1.0.0 && x']) assert.throws(() => assertVersion(version));
  });
});

describe('npm resolution', () => {
  it('runs the npm CLI script with node on Windows, never the .cmd shim', () => {
    // Compared without case, as NTFS does: PATHEXT spells the extension in capitals.
    const files = new Set(['c:\\nodejs\\npm.cmd', 'c:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
    const command = resolveNpmCommand({
      platform: 'win32',
      env: { PATH: 'C:\\nodejs', PATHEXT: '.EXE;.CMD' },
      execPath: 'C:\\nodejs\\node.exe',
      isFile: (candidate) => files.has(candidate.toLowerCase()),
    });
    assert.deepEqual(command, { file: 'C:\\nodejs\\node.exe', leadingArgs: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'] });
  });

  it('finds the script under a POSIX prefix', () => {
    const files = new Set(['/usr/local/bin/npm', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']);
    const command = resolveNpmCommand({ platform: 'linux', env: { PATH: '/usr/local/bin' }, execPath: '/usr/local/bin/node', isFile: (candidate) => files.has(candidate) });
    assert.deepEqual(command, { file: '/usr/local/bin/node', leadingArgs: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js'] });
  });

  it('starts a POSIX npm directly when the script is elsewhere', () => {
    const command = resolveNpmCommand({ platform: 'darwin', env: { PATH: '/opt/bin' }, isFile: (candidate) => candidate === '/opt/bin/npm' });
    assert.deepEqual(command, { file: '/opt/bin/npm', leadingArgs: [] });
  });

  it('gives up on a Windows shim without its script, instead of starting cmd.exe', () => {
    const command = resolveNpmCommand({ platform: 'win32', env: { PATH: 'C:\\x', PATHEXT: '.CMD' }, isFile: (candidate) => candidate === 'C:\\x\\npm.cmd' });
    assert.equal(command, null);
  });

  it('reports no npm at all', () => {
    assert.equal(resolveNpmCommand({ platform: 'linux', env: { PATH: '' }, isFile: () => false }), null);
  });
});

describe('npm installer', () => {
  it('installs exactly the named version, globally', async (t) => {
    const sandbox = await useSandbox(t, 'npm');
    const bin = sandbox.dirs.bin;
    const shim = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await fs.writeFile(shim, '', 'utf8');
    await fs.mkdir(path.join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    await fs.writeFile(path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '', 'utf8');
    const { run, calls } = fakeRun();

    await createNpmInstaller({ env: { PATH: bin, PATHEXT: '.CMD' }, platform: process.platform, run }).installGlobal('opencode-ai', '1.18.31');

    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args.slice(1), ['install', '--global', 'opencode-ai@1.18.31']);
  });

  it('says to run the command by hand when npm cannot be found', async () => {
    const installer = createNpmInstaller({ env: { PATH: '' }, platform: process.platform, run: fakeRun().run });
    await assert.rejects(installer.installGlobal('opencode-ai', '1.18.31'), /run 'npm i -g opencode-ai@1\.18\.31' yourself/);
  });

  it('reports a failing install with its last line', async (t) => {
    const sandbox = await useSandbox(t, 'npm');
    const bin = sandbox.dirs.bin;
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '', 'utf8');
    await fs.mkdir(path.join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    await fs.writeFile(path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '', 'utf8');
    for (const [result, pattern] of /** @type {const} */ ([
      [{ exitCode: 1, stderr: 'npm ERR! code EACCES\nnpm ERR! permission denied' }, /exited 1: npm ERR! permission denied/],
      [{ timedOut: true, exitCode: null }, /did not finish/],
      [{ aborted: true, exitCode: null }, /interrupted/],
      [{ error: new Error('ENOENT'), exitCode: null }, /could not be started/],
    ])) {
      const installer = createNpmInstaller({ env: { PATH: bin, PATHEXT: '.CMD' }, platform: process.platform, run: fakeRun([result]).run });
      await assert.rejects(installer.installGlobal('opencode-ai', '1.18.31'), pattern);
    }
  });
});
