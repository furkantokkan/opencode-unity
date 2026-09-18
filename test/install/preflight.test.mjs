// Setup item 0 (spec 14.1): the machine as found. Read-only, never loads a model, and never throws.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { hasModel, parseGpuLine, parseVersion, runPreflight, withModelState } from '../../src/install/preflight.js';
import { findOpencode } from '../../src/opencode/locate.js';
import { useSandbox } from '../helpers/sandbox.mjs';
import { createFakeOllama } from './helpers.mjs';

const COMPAT = { opencode: { tested: '1.18.31' }, ollama: { tested: '0.34.1', min: '0.34.1' } };

/**
 * @param {import('node:test').TestContext} t
 * @param {string[]} names
 */
async function fakePath(t, names) {
  const sandbox = await useSandbox(t, 'preflight');
  for (const name of names) await fs.writeFile(path.join(sandbox.dirs.bin, name), '', 'utf8');
  return { PATH: sandbox.dirs.bin, PATHEXT: '.EXE' };
}

/**
 * @param {Record<string, Partial<import('../../src/core/exec.js').RunResult>>} byProgram  Keyed by lower-case base name without extension.
 */
function fakeRun(byProgram) {
  /** @type {string[]} */
  const started = [];
  /** @type {typeof import('../../src/core/exec.js').runProcess} */
  const run = async (file, args) => {
    const name = path.basename(file).toLowerCase().replace(/\.exe$/, '');
    started.push([name, ...args].join(' '));
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1, ...(byProgram[name] ?? {}) };
  };
  return { run, started };
}

const exe = (/** @type {string} */ name) => (process.platform === 'win32' ? `${name}.exe` : name);

describe('preflight', () => {
  it('reads versions, the GPU and the model list, and loads nothing', async (t) => {
    const env = await fakePath(t, [exe('opencode'), exe('nvidia-smi')]);
    const ollama = createFakeOllama({ models: ['qwen3-coder:30b'] });
    const { run, started } = fakeRun({ opencode: { stdout: '1.18.31\n' }, 'nvidia-smi': { stdout: 'NVIDIA GeForce RTX 3090, 24576\n' } });

    const facts = await runPreflight({ platform: process.platform, env, nodeVersion: '22.11.0', compat: COMPAT, ollama: /** @type {any} */ (ollama), run });

    assert.deepEqual(facts.opencode, { state: 'tested', version: '1.18.31', tested: '1.18.31' });
    assert.deepEqual(facts.ollama, { state: 'tested', version: '0.34.1', tested: '0.34.1' });
    assert.deepEqual(facts.gpu, { name: 'NVIDIA GeForce RTX 3090', totalVramMiB: 24576 });
    assert.deepEqual(facts.models, ['qwen3-coder:30b']);
    assert.deepEqual(ollama.calls.sort(), ['/api/tags', '/api/version']);
    assert.deepEqual(started.sort(), ['nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', 'opencode --version']);
  });

  it('reports what is missing instead of failing', async (t) => {
    const env = await fakePath(t, []);
    const ollama = createFakeOllama();
    ollama.getVersion = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { run, started } = fakeRun({});

    const facts = await runPreflight({ platform: process.platform, env, nodeVersion: '22.11.0', compat: COMPAT, ollama: /** @type {any} */ (ollama), run });

    assert.equal(facts.opencode.state, 'missing');
    assert.equal(facts.ollama.state, 'down');
    assert.deepEqual(facts.gpu, { name: null, totalVramMiB: null });
    assert.equal(facts.dotnetSdk, false);
    assert.deepEqual(started, []);
  });

  it('marks an OpenCode at another version, and one that prints no version', async (t) => {
    const env = await fakePath(t, [exe('opencode')]);
    const other = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama()), run: fakeRun({ opencode: { stdout: 'opencode 1.17.0' } }).run });
    const odd = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama()), run: fakeRun({ opencode: { stdout: 'dev build' } }).run });
    const broken = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama()), run: fakeRun({ opencode: { exitCode: 1 } }).run });

    assert.deepEqual(other.opencode, { state: 'other', version: '1.17.0', tested: '1.18.31' });
    assert.deepEqual(odd.opencode, { state: 'other', version: 'unknown', tested: '1.18.31' });
    assert.deepEqual(broken.opencode, { state: 'unreadable', version: null, tested: '1.18.31' }, 'installed but broken is not missing');
  });

  it('reads the version through the executable behind a Windows npm shim, on every host (spec 13.1 step 9)', async () => {
    // The npm layout of a global install on Windows, in win32 paths, whatever the host is.
    const shim = 'C:\\npm\\opencode.CMD';
    const real = 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
    const files = new Set([shim, real]);
    const manifests = { 'C:\\npm\\node_modules\\opencode-ai\\package.json': JSON.stringify({ bin: { opencode: 'bin/opencode.exe' } }) };
    /** @type {string[]} */
    const started = [];
    const facts = await runPreflight({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      nodeVersion: '22',
      compat: COMPAT,
      ollama: /** @type {any} */ (createFakeOllama()),
      locate: (options) => findOpencode({ ...options, isFile: (file) => files.has(file), readText: (file) => manifests[/** @type {keyof typeof manifests} */ (file)] ?? null }),
      run: async (file, args) => {
        started.push([file, ...args].join(' '));
        return { exitCode: 0, signal: null, stdout: '1.18.31\n', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 };
      },
    });
    assert.deepEqual(facts.opencode, { state: 'tested', version: '1.18.31', tested: '1.18.31' });
    assert.ok(started.includes(`${real} --version`), started.join('\n'));
    assert.ok(!started.some((line) => line.startsWith(shim)), 'the shim itself is never started');
  });

  it('calls a shim it cannot resolve unreadable, never missing, so setup plans no install over it', async () => {
    const shim = 'C:\\npm\\opencode.CMD';
    /** @type {string[]} */
    const started = [];
    const facts = await runPreflight({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      nodeVersion: '22',
      compat: COMPAT,
      ollama: /** @type {any} */ (createFakeOllama()),
      locate: (options) => findOpencode({ ...options, isFile: (file) => file === shim, readText: () => null }),
      run: async (file, args) => {
        started.push([file, ...args].join(' '));
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 };
      },
    });
    assert.deepEqual(facts.opencode, { state: 'unreadable', version: null, tested: '1.18.31' });
    assert.equal(started.some((line) => line.includes('opencode')), false);
  });

  it('orders the Ollama version against the tested one', async (t) => {
    const env = await fakePath(t, []);
    const older = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama({ version: '0.33.0' })), run: fakeRun({}).run });
    const newer = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama({ version: '0.40.0' })), run: fakeRun({}).run });
    assert.equal(older.ollama.state, 'older');
    assert.equal(newer.ollama.state, 'newer');
  });

  it('keeps going when the model list fails after the version answered', async (t) => {
    const env = await fakePath(t, []);
    const ollama = createFakeOllama();
    ollama.listModels = async () => {
      throw new Error('HTTP 500');
    };
    const facts = await runPreflight({ platform: process.platform, env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (ollama), run: fakeRun({}).run });
    assert.equal(facts.ollama.state, 'tested');
    assert.deepEqual(facts.models, []);
  });

  it('finds Windows Terminal by its per-user directory', async (t) => {
    const sandbox = await useSandbox(t, 'preflight');
    await fs.mkdir(path.join(sandbox.dirs.localAppData, 'Microsoft', 'Windows Terminal'), { recursive: true });
    const facts = await runPreflight({
      platform: 'win32',
      env: { PATH: '', LOCALAPPDATA: sandbox.dirs.localAppData },
      nodeVersion: '22',
      compat: COMPAT,
      ollama: /** @type {any} */ (createFakeOllama()),
      run: fakeRun({}).run,
    });
    assert.equal(facts.windowsTerminal, true);
  });

  it('never looks for Windows Terminal off Windows', async (t) => {
    const env = await fakePath(t, []);
    const facts = await runPreflight({ platform: 'linux', env, nodeVersion: '22', compat: COMPAT, ollama: /** @type {any} */ (createFakeOllama()), run: fakeRun({}).run });
    assert.equal(facts.windowsTerminal, false);
  });
});

describe('preflight parsers', () => {
  it('reads GPU 0 name and total memory', () => {
    assert.deepEqual(parseGpuLine('NVIDIA RTX A6000, 49140\nNVIDIA RTX A6000, 49140\n'), { name: 'NVIDIA RTX A6000', totalVramMiB: 49140 });
  });

  it('refuses output that is not name, memory', () => {
    assert.deepEqual(parseGpuLine(''), { name: null, totalVramMiB: null });
    assert.deepEqual(parseGpuLine('NVIDIA only'), { name: null, totalVramMiB: null });
    assert.deepEqual(parseGpuLine('X, [N/A]'), { name: 'X', totalVramMiB: null });
  });

  it('pulls a semver out of a version line', () => {
    assert.equal(parseVersion('opencode 1.18.31'), '1.18.31');
    assert.equal(parseVersion('v0.34.1-rc0'), '0.34.1-rc0');
    assert.equal(parseVersion('no digits'), null);
  });

  it('counts name and name:latest as the same model', () => {
    const installed = new Set(['llama3:latest', 'qwen3-coder:30b']);
    assert.equal(hasModel(installed, 'llama3'), true);
    assert.equal(hasModel(installed, 'qwen3-coder:30b'), true);
    assert.equal(hasModel(new Set(['llama3']), 'llama3:latest'), true);
    assert.equal(hasModel(installed, 'qwen3-coder:14b'), false);
  });

  it('finishes the facts once the preset is known', () => {
    const facts = /** @type {any} */ ({ models: ['a:1'] });
    assert.deepEqual(withModelState(facts, { base: 'a:1', tag: 'ocu-a' }), { models: ['a:1'], baseModelInstalled: true, taggedModelInstalled: false });
  });
});
