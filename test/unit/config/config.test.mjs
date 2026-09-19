import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_PRESET_ID,
  getDefaultConfig,
  applyConfigDefaults,
  getConfigWarnings,
  loadConfig,
  mergeDeep,
  parseConfigText,
  readConfigSchema,
  renderInitialConfig,
  resolveConfig,
  validateConfig,
  writeConfigFile,
} from '../../../src/core/config.js';
import { CURRENT_CONFIG_SCHEMA_VERSION } from '../../../src/core/migrations.js';
import { catchError } from '../../helpers/catch-error.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';

describe('defaults (spec 6.2)', () => {
  it('matches the documented default for every block', () => {
    assert.equal(DEFAULT_CONFIG.schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION);
    assert.equal(DEFAULT_CONFIG.preset, DEFAULT_PRESET_ID);
    assert.equal(DEFAULT_CONFIG.ollama.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(DEFAULT_CONFIG.ollama.startAppIfDown, 'ask');
    assert.equal(DEFAULT_CONFIG.guard.minFreeVramAfterLoadMiB, 1500);
    assert.equal(DEFAULT_CONFIG.guard.maxGpuUtilPercent, 60);
    assert.equal(DEFAULT_CONFIG.guard.assetImportCpuPercent, 20);
    assert.equal(DEFAULT_CONFIG.guard.maxUnityEditors, 3);
    assert.equal(DEFAULT_CONFIG.guard.importWhileLoaded, 'wait');
    assert.equal(DEFAULT_CONFIG.guard.keepAliveMarginSec, 60);
    assert.equal(DEFAULT_CONFIG.guard.onColdBlock, 'stop');
    assert.equal(DEFAULT_CONFIG.guard.onLoadedBusy, 'retry');
    assert.equal(DEFAULT_CONFIG.guard.remote, 'block');
    assert.equal(DEFAULT_CONFIG.budget.reserveTokens, 512);
    assert.equal(DEFAULT_CONFIG.budget.charsPerToken, 3.5);
    assert.deepEqual(DEFAULT_CONFIG.budget.calibrationClamp, [0.7, 1.4]);
    assert.deepEqual(DEFAULT_CONFIG.budget.prefixTargetTokens, { 'unity-code': 5000, 'unity-editor': 7000 });
    assert.deepEqual(DEFAULT_CONFIG.budget.prefixFailTokens, { 'unity-code': 6000, 'unity-editor': 8000 });
    assert.equal(DEFAULT_CONFIG.safety.bashMode, 'allowlist', 'dangerous actions are denied, never asked (spec D5)');
    assert.equal(DEFAULT_CONFIG.safety.readLimitLines, 200);
    assert.equal(DEFAULT_CONFIG.start.warm, false, 'a 19 GiB load is never eager (spec D19)');
    assert.equal(DEFAULT_CONFIG.delegate.temperature, 0.2);
    assert.deepEqual(DEFAULT_CONFIG.delegate.checkCommandPrefixes, ['dotnet build ', 'dotnet test ']);
    assert.deepEqual(DEFAULT_CONFIG.experimental, { platforms: false, presets: false, untestedVersions: false });
  });

  it('is frozen, so one command cannot change what another command sees', () => {
    assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
    assert.throws(() => {
      /** @type {any} */ (DEFAULT_CONFIG).guard.minFreeVramAfterLoadMiB = 0;
    });
  });

  it('validates against schema/config.schema.json', () => {
    assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
    assert.equal(readConfigSchema().properties.preset.default, DEFAULT_PRESET_ID);
  });

  it('fills only what the file leaves out', () => {
    const merged = /** @type {any} */ (applyConfigDefaults({ schemaVersion: 1, guard: { maxUnityEditors: 1 }, projects: { 'demo-0a1b2c3d': { editor: { enabled: true } } } }));
    assert.equal(merged.guard.maxUnityEditors, 1);
    assert.equal(merged.guard.minFreeVramAfterLoadMiB, getDefaultConfig().guard.minFreeVramAfterLoadMiB);
    assert.deepEqual(merged.projects['demo-0a1b2c3d'], { editor: { enabled: true, trust: false, allowPlayMode: false }, bashMode: null });
  });
});

describe('parseConfigText', () => {
  it('accepts comments and trailing commas', () => {
    const loaded = parseConfigText('{\n  // the preset to use\n  "schemaVersion": 1,\n  "preset": "nvidia-24gb-qwen3-coder-30b-32k",\n}\n');
    assert.equal(loaded.config.preset, 'nvidia-24gb-qwen3-coder-30b-32k');
    assert.equal(loaded.user.schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION);
    assert.equal(loaded.user.preset, 'nvidia-24gb-qwen3-coder-30b-32k');
    assert.equal(loaded.migrations.length, 1);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.fileVersion, 1);
  });

  it('reports a syntax error with its line and column, as exit 1', () => {
    const error = catchError(() => parseConfigText('{ "schemaVersion": 1,, }', 'config.json'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_invalid');
    assert.match(error.message, /line 1/);
  });

  it('rejects an unknown key and names it (spec 6.2)', () => {
    const error = catchError(() => parseConfigText('{ "schemaVersion": 1, "guard": { "minFreeVramAfterLoadMB": 1500 } }'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /guard\.minFreeVramAfterLoadMB is not a known key/);
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "gpu": {} }')).message, /gpu is not a known key/);
  });

  it('rejects values outside their range or choice list', () => {
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "guard": { "maxGpuUtilPercent": 140 } }')).message, /must be <= 100/);
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "guard": { "importWhileLoaded": "later" } }')).message, /must be one of/);
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "ollama": { "baseUrl": "127.0.0.1:11434" } }')).message, /ollama\.baseUrl/);
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "safety": { "readLimitLines": 0 } }')).message, /readLimitLines/);
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "projects": { "bad id": {} } }')).message, /is not a valid key/);
  });

  it('rejects rules a schema cannot express', () => {
    assert.match(catchError(() => parseConfigText('{ "schemaVersion": 1, "budget": { "calibrationClamp": [1.4, 0.7] } }')).message, /low <= high/);
    assert.match(
      catchError(() => parseConfigText('{ "schemaVersion": 1, "budget": { "prefixTargetTokens": { "unity-code": 9000, "unity-editor": 7000 } } }')).message,
      /must not exceed budget\.prefixFailTokens\.unity-code/,
    );
  });
});

describe('getConfigWarnings (settings that weaken a safety default)', () => {
  it('warns about every weakened guard or safety setting', () => {
    const config = resolveConfig({
      schemaVersion: 1,
      guard: { remote: 'unguarded', adapter: 'none', importWhileLoaded: 'allow', maxUnityEditors: 0, nvidiaSmiCommand: 'fake-nvidia-smi' },
      safety: { bashMode: 'ask' },
    });
    const warnings = getConfigWarnings(config).join('\n');
    for (const expected of ['guard.remote', 'guard.adapter', 'guard.importWhileLoaded', 'guard.maxUnityEditors', 'guard.nvidiaSmiCommand', 'safety.bashMode']) {
      assert.match(warnings, new RegExp(expected.replace('.', '\\.')), expected);
    }
  });

  it('says nothing about the defaults', () => {
    assert.deepEqual(getConfigWarnings(resolveConfig({ schemaVersion: 1 })), []);
  });
});

describe('loadConfig and writeConfigFile', () => {
  it('treats a missing file as all defaults', async (t) => {
    const sandbox = await useSandbox(t, 'config-missing');
    const loaded = await loadConfig(sandbox.path('config.json'));
    assert.equal(loaded.exists, false);
    assert.equal(loaded.fileVersion, null);
    assert.deepEqual(loaded.user, {});
    assert.deepEqual(loaded.config, getDefaultConfig());
  });

  it('writes what setup writes, and reads it back', async (t) => {
    const sandbox = await useSandbox(t, 'config-write');
    const file = sandbox.path('product-home', 'config.json');
    const initial = renderInitialConfig('nvidia-24gb-qwen3-coder-30b-32k');
    assert.deepEqual(JSON.parse(initial), { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, preset: 'nvidia-24gb-qwen3-coder-30b-32k' });
    await writeConfigFile(file, JSON.parse(initial));
    const loaded = await loadConfig(file);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.preset, 'nvidia-24gb-qwen3-coder-30b-32k');
    assert.equal(loaded.config.guard.minFreeVramAfterLoadMiB, getDefaultConfig().guard.minFreeVramAfterLoadMiB, 'the file holds user choices only, not preset values');
    assert.deepEqual(await fs.readdir(sandbox.path('product-home')), ['config.json'], 'no temp file is left behind');
  });

  it('refuses to write a document that would not load', async (t) => {
    const sandbox = await useSandbox(t, 'config-write-invalid');
    const file = sandbox.path('config.json');
    await assert.rejects(writeConfigFile(file, { schemaVersion: 1, preset: 'Bad Preset' }), /preset/);
    await assert.rejects(fs.access(file));
  });

  it('turns an unreadable file into exit 1', async (t) => {
    const sandbox = await useSandbox(t, 'config-unreadable');
    const dir = sandbox.path('config.json');
    await fs.mkdir(dir, { recursive: true });
    const error = await loadConfig(dir).then(() => null, (thrown) => thrown);
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_unreadable');
  });
});

describe('mergeDeep', () => {
  it('merges objects, replaces arrays and copies everything', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 4 };
    const merged = /** @type {any} */ (mergeDeep(base, { a: { c: [3] }, e: 5 }));
    assert.deepEqual(merged, { a: { b: 1, c: [3] }, d: 4, e: 5 });
    merged.a.b = 99;
    assert.equal(base.a.b, 1);
    assert.deepEqual(mergeDeep(base, undefined), base);
    assert.equal(mergeDeep({ a: 1 }, null), null);
  });
});
