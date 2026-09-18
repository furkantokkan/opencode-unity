// Guard settings: the defaults of spec 6.2, and validation that never weakens the guard.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUARD_DEFAULTS, resolveGuardConfig, validateGuardTarget } from '../../../plugin/opencode-unity-lib/guard/config.js';

describe('guard settings', () => {
  it('ships the defaults of spec 6.2', () => {
    assert.deepEqual(GUARD_DEFAULTS, {
      minFreeVramAfterLoadMiB: 1500,
      allowOffload: false,
      maxGpuUtilPercent: 60,
      gpuUtilSampleIntervalMs: 1000,
      assetImportCpuPercent: 20,
      assetImportSampleMs: 1500,
      assetImportProcessPatterns: ['AssetImportWorker', '-importWorker'],
      editorImportCpuPercent: 60,
      maxUnityEditors: 3,
      importWhileLoaded: 'wait',
      keepAliveMarginSec: 60,
      coldPassCacheSec: 3,
      loadedPassCacheSec: 15,
      probeTimeoutSec: 10,
      onColdBlock: 'stop',
      onLoadedBusy: 'retry',
      remote: 'block',
      adapter: 'auto',
      nvidiaSmiCommand: 'nvidia-smi',
    });
  });

  it('fills the defaults and keeps the given values', () => {
    const resolved = resolveGuardConfig({ modelVramMiB: 20000, maxUnityEditors: 1, onColdBlock: 'retry' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.config.modelVramMiB, 20000);
    assert.equal(resolved.config.maxUnityEditors, 1);
    assert.equal(resolved.config.onColdBlock, 'retry');
    assert.equal(resolved.config.minFreeVramAfterLoadMiB, 1500);
  });

  it('copies the pattern list, so a caller cannot change it later', () => {
    const patterns = ['AssetImportWorker'];
    const resolved = resolveGuardConfig({ modelVramMiB: 19000, assetImportProcessPatterns: patterns });
    assert.equal(resolved.ok, true);
    patterns.push('anything');
    assert.deepEqual(resolved.config.assetImportProcessPatterns, ['AssetImportWorker']);
    resolveGuardConfig({ modelVramMiB: 19000 });
    assert.deepEqual(GUARD_DEFAULTS.assetImportProcessPatterns, ['AssetImportWorker', '-importWorker']);
  });

  it('needs the VRAM estimate, which has no safe default', () => {
    const resolved = resolveGuardConfig({});
    assert.equal(resolved.ok, false);
    assert.deepEqual(resolved.errors, ['guard.modelVramMiB is required']);
  });

  it('rejects values outside the schema range', () => {
    const cases = [
      [{ maxGpuUtilPercent: 0 }, /maxGpuUtilPercent must be between 1 and 100/],
      [{ maxGpuUtilPercent: 101 }, /maxGpuUtilPercent must be between 1 and 100/],
      [{ assetImportCpuPercent: 0 }, /assetImportCpuPercent must be between 1 and 102400/],
      [{ assetImportSampleMs: 99 }, /assetImportSampleMs must be between 100 and 60000/],
      [{ gpuUtilSampleIntervalMs: 10001 }, /gpuUtilSampleIntervalMs must be between 100 and 10000/],
      [{ keepAliveMarginSec: 3601 }, /keepAliveMarginSec must be between 0 and 3600/],
      [{ coldPassCacheSec: 61 }, /coldPassCacheSec must be between 0 and 60/],
      [{ loadedPassCacheSec: 301 }, /loadedPassCacheSec must be between 0 and 300/],
      [{ probeTimeoutSec: 0 }, /probeTimeoutSec must be between 1 and 120/],
      [{ maxUnityEditors: 65 }, /maxUnityEditors must be between 0 and 64/],
      [{ editorImportCpuPercent: -1 }, /editorImportCpuPercent must be between 0 and 102400/],
      [{ minFreeVramAfterLoadMiB: 1500.5 }, /minFreeVramAfterLoadMiB must be an integer/],
      [{ importWhileLoaded: 'later' }, /importWhileLoaded must be one of wait, allow/],
      [{ onColdBlock: 'ask' }, /onColdBlock must be one of stop, retry/],
      [{ onLoadedBusy: 'ask' }, /onLoadedBusy must be one of retry, stop/],
      [{ remote: 'allow' }, /remote must be one of block, unguarded/],
      [{ adapter: 'nvidia' }, /adapter must be one of auto, none/],
      [{ nvidiaSmiCommand: '  ' }, /nvidiaSmiCommand must be a non-empty single-line string/],
      [{ nvidiaSmiCommand: 'nvidia-smi\nrm -rf' }, /nvidiaSmiCommand must be a non-empty single-line string/],
      [{ allowOffload: 'yes' }, /allowOffload must be true or false/],
    ];
    for (const [overrides, expected] of cases) {
      const resolved = resolveGuardConfig({ modelVramMiB: 19000, ...overrides });
      assert.equal(resolved.ok, false, `expected ${JSON.stringify(overrides)} to be refused`);
      assert.match(resolved.errors.join('; '), expected);
    }
  });

  it('reports every problem at once', () => {
    const resolved = resolveGuardConfig({ maxGpuUtilPercent: 0, probeTimeoutSec: 0 });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.errors.length, 3);
  });

  it('rejects pattern lists that would match every process', () => {
    const cases = [
      [[], /must be a non-empty list of strings/],
      [['*'], /must contain more than wildcards/],
      [['? ?'], /must contain more than wildcards/],
      [[''], /non-empty single-line strings/],
      [['worker\tname'], /non-empty single-line strings/],
      [[42], /non-empty single-line strings/],
      [['a'.repeat(201)], /at most 200 characters/],
      [new Array(33).fill('worker'), /at most 32 entries/],
      ['AssetImportWorker', /must be a non-empty list of strings/],
    ];
    for (const [patterns, expected] of cases) {
      const resolved = resolveGuardConfig({ modelVramMiB: 19000, assetImportProcessPatterns: patterns });
      assert.equal(resolved.ok, false, `expected ${JSON.stringify(patterns)} to be refused`);
      assert.match(resolved.errors.join('; '), expected);
    }
  });

  it('ignores keys the guard does not use', () => {
    const resolved = resolveGuardConfig({ modelVramMiB: 19000, kvType: 'q8_0', kvTypeSource: 'server-log', somethingElse: true });
    assert.equal(resolved.ok, true);
    assert.ok(!('kvType' in resolved.config));
  });

  it('refuses anything that is not a settings object', () => {
    for (const value of [null, undefined, 'guard', 42, []]) {
      const resolved = resolveGuardConfig(value);
      assert.equal(resolved.ok, false);
      assert.deepEqual(resolved.errors, ['guard settings are missing']);
    }
  });
});

describe('guard target', () => {
  it('accepts a loopback Ollama URL with or without /v1', () => {
    assert.deepEqual(validateGuardTarget({ baseUrl: 'http://127.0.0.1:11434', modelTag: 'ocu-model-16k', numCtx: 16384 }), []);
    assert.deepEqual(validateGuardTarget({ baseUrl: 'http://127.0.0.1:11434/v1', modelTag: 'ocu-model-16k', numCtx: 16384 }), []);
  });

  it('names every problem', () => {
    assert.deepEqual(validateGuardTarget(undefined), ['the guard target (base URL, model tag, context) is missing']);
    const problems = validateGuardTarget({ baseUrl: 'not a url', modelTag: ' ', numCtx: -1 });
    assert.equal(problems.length, 3);
    assert.deepEqual(validateGuardTarget({ baseUrl: 'http://127.0.0.1:11434', modelTag: 'tag\nrm', numCtx: 16384 }), ['the model tag is empty or not a single line']);
    assert.deepEqual(validateGuardTarget({ baseUrl: 'http://127.0.0.1:11434', modelTag: 'tag', numCtx: 1.5 }), ['the context size is not a positive integer']);
  });
});
