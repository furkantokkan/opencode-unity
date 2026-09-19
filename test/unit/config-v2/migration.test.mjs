// The one config.json migration of amendment A1.2 (D-M6, D-M21): schemaVersion 1 -> 2 inserts the network,
// shape and project blocks, experimental.platforms and safety.multiplayerProtectedGlobs. It is pure,
// idempotent, keeps every value and every key order the file already has, and runs in memory on every
// read of an older file.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { DEFAULT_CONFIG, parseConfigText, resolveConfig } from '../../../src/core/config.js';
import { stringifyJson } from '../../../src/core/jsonc.js';
import {
  CONFIG_MIGRATIONS,
  CONFIG_V2_BLOCKS,
  CURRENT_CONFIG_SCHEMA_VERSION,
  deepFreeze,
  migrateConfigV1ToV2,
  migrateDocument,
} from '../../../src/core/migrations.js';
import { catchError } from '../../helpers/catch-error.mjs';

const PRESET = 'nvidia-24gb-qwen3-coder-30b-16k';
const NEW_BLOCKS = ['network', 'shape', 'project'];
const PLATFORMS = /** @type {const} */ (['win32', 'linux', 'darwin']);

/** A v1 file with only the two keys `setup` writes. */
const V1_MINIMAL = deepFreeze({ schemaVersion: 1, preset: PRESET });

/** A v1 file that sets something in every v1 block, in an order a person might have written. */
const V1_FULL = deepFreeze({
  schemaVersion: 1,
  preset: 'nvidia-24gb-qwen3-coder-30b-32k',
  experimental: { presets: true },
  ollama: { baseUrl: 'http://127.0.0.1:11500' },
  guard: { maxUnityEditors: 1, assetImportProcessPatterns: ['AssetImportWorker'] },
  safety: { readLimitLines: 120, bashMode: 'ask', extraProtectedEditGlobs: ['*Art/*'] },
  start: { warm: true },
  delegate: { temperature: 0.1 },
  projects: { 'demo-0a1b2c3d': { editor: { enabled: true } } },
});

describe('the config migration set (D-M6, D-M21)', () => {
  it('ships exactly one config migration, from version 1 to version 2', () => {
    assert.equal(CURRENT_CONFIG_SCHEMA_VERSION, 2);
    assert.equal(CONFIG_MIGRATIONS.length, 1);
    assert.equal(CONFIG_MIGRATIONS[0].from, 1);
    assert.equal(CONFIG_MIGRATIONS[0].migrate, migrateConfigV1ToV2);
    assert.equal(Object.isFrozen(CONFIG_MIGRATIONS[0]), true);
  });

  it('inserts the three blocks, experimental.platforms and the multiplayer globs with their defaults', () => {
    const result = migrateDocument(V1_MINIMAL);
    assert.equal(result.fromVersion, 1);
    assert.equal(result.toVersion, 2);
    assert.deepEqual(result.applied, [CONFIG_MIGRATIONS[0].summary]);
    assert.deepEqual(result.document, {
      schemaVersion: 2,
      preset: PRESET,
      network: CONFIG_V2_BLOCKS.network,
      shape: CONFIG_V2_BLOCKS.shape,
      project: CONFIG_V2_BLOCKS.project,
      safety: { multiplayerProtectedGlobs: CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs },
      experimental: { platforms: false },
    });
  });

  it('gives an existing install the standard network profile, and the upgrade notice says so (R26)', () => {
    const { document, applied } = migrateDocument(V1_FULL);
    assert.equal(/** @type {any} */ (document).network.enabled, true);
    assert.equal(/** @type {any} */ (document).network.profile, 'standard');
    assert.equal(/** @type {any} */ (document).network.bash, 'deny', 'the upgrade grants no shell network access');
    assert.match(applied[0], /network block \(standard profile/);
    assert.match(applied[0], /read-only/);
  });

  it('inserts the version-2 values the amendment states', () => {
    assert.deepEqual(CONFIG_V2_BLOCKS.network.limits, {
      maxResponseBytes: 65536, maxOutputChars: 8192, maxRequestBodyBytes: 32768,
      maxUrlChars: 2048, connectTimeoutMs: 5000, firstByteTimeoutMs: 10000,
      totalTimeoutMs: 20000, maxRequestsPerSession: 40, maxRequestsPerMinute: 20,
    });
    assert.deepEqual(CONFIG_V2_BLOCKS.shape, { mode: 'auto', maxInputChars: 2000, maxOutputTokens: 256, timeoutSec: 60, anchorCandidates: 5, grepTimeoutMs: 2000 });
    assert.equal(CONFIG_V2_BLOCKS.project.components, 'auto');
    assert.equal(CONFIG_V2_BLOCKS.project.factsBudgetChars, 2600);
    assert.deepEqual(CONFIG_V2_BLOCKS.project.verify.scriptOrder, ['test', 'build', 'typecheck', 'check']);
    assert.equal(CONFIG_V2_BLOCKS.project.verify.blockScriptBodies, true);
    assert.deepEqual(CONFIG_V2_BLOCKS.project.multiplayer, { ruleBlock: 'auto' });
    assert.deepEqual(CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs, [
      '*.rules', '*Economy/*', '*Purchas*/*', '*Entitlement*/*', '*Anticheat*/*', '*AntiCheat*/*',
      '*ServerAuthority*', '*Reconcil*', '*Rollback*',
    ]);
  });

  it('keeps the snapshot frozen, so no caller can change what a later migration inserts', () => {
    assert.equal(Object.isFrozen(CONFIG_V2_BLOCKS.network.limits), true);
    assert.equal(Object.isFrozen(CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs), true);
    assert.throws(() => {
      /** @type {any} */ (CONFIG_V2_BLOCKS).shape.mode = 'always';
    });
  });

  it('is where the version-2 defaults come from, so the two cannot differ', () => {
    assert.deepEqual(DEFAULT_CONFIG.network, CONFIG_V2_BLOCKS.network);
    assert.deepEqual(DEFAULT_CONFIG.shape, CONFIG_V2_BLOCKS.shape);
    assert.deepEqual(DEFAULT_CONFIG.project, CONFIG_V2_BLOCKS.project);
    assert.deepEqual(DEFAULT_CONFIG.safety.multiplayerProtectedGlobs, CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs);
    assert.equal(DEFAULT_CONFIG.experimental.platforms, CONFIG_V2_BLOCKS.experimental.platforms);
  });
});

describe('migrateConfigV1ToV2 keeps what the file says', () => {
  it('never replaces a value the file already has, and fills only what is missing', () => {
    const document = {
      schemaVersion: 1,
      safety: { bashMode: 'ask', multiplayerProtectedGlobs: ['*Economy/*'] },
      experimental: { presets: true, platforms: true },
      network: { profile: 'none', limits: { maxRequestsPerSession: 5 } },
      shape: { mode: 'off' },
    };
    const migrated = /** @type {any} */ (migrateConfigV1ToV2(document));
    assert.deepEqual(migrated.safety, { bashMode: 'ask', multiplayerProtectedGlobs: ['*Economy/*'] });
    assert.deepEqual(migrated.experimental, { presets: true, platforms: true });
    assert.equal(migrated.network.profile, 'none');
    assert.equal(migrated.network.enabled, true);
    assert.equal(migrated.network.limits.maxRequestsPerSession, 5);
    assert.equal(migrated.network.limits.maxResponseBytes, 65536);
    assert.equal(migrated.shape.mode, 'off');
    assert.equal(migrated.shape.maxInputChars, 2000);
  });

  it('keeps a value it cannot use, so validation names it instead of the migration hiding it', () => {
    const migrated = /** @type {any} */ (migrateConfigV1ToV2({ schemaVersion: 1, network: 'off', safety: ['x'] }));
    assert.equal(migrated.network, 'off');
    assert.deepEqual(migrated.safety, ['x']);
    const error = catchError(() => parseConfigText('{ "schemaVersion": 1, "network": "off" }'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_invalid');
    assert.match(error.message, /network must be an object/);
  });

  it('keeps an unknown key, which is still exit 1 after the migration', () => {
    const migrated = migrateConfigV1ToV2({ schemaVersion: 1, gpu: { index: 0 } });
    assert.deepEqual(migrated.gpu, { index: 0 });
    const error = catchError(() => parseConfigText('{ "schemaVersion": 1, "gpu": { "index": 0 } }'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /gpu is not a known key/);
  });

  it('keeps the key order of the file and appends what it adds', () => {
    const migrated = migrateConfigV1ToV2(structuredClone(V1_FULL));
    assert.deepEqual(Object.keys(migrated), [...Object.keys(V1_FULL), ...NEW_BLOCKS]);
    assert.deepEqual(Object.keys(/** @type {any} */ (migrated).safety), [...Object.keys(V1_FULL.safety), 'multiplayerProtectedGlobs']);
    assert.deepEqual(Object.keys(/** @type {any} */ (migrated).experimental), ['presets', 'platforms']);
    assert.equal(Object.keys(migrated)[0], 'schemaVersion', 'the version stays where the file had it');
  });

  it('writes no platform default into the file, so a file migrated on one platform reads right on another', () => {
    const migrated = /** @type {any} */ (migrateConfigV1ToV2(structuredClone(V1_MINIMAL)));
    for (const key of ['ollama', 'guard', 'start']) assert.equal(Object.hasOwn(migrated, key), false, key);
  });
});

describe('migrateConfigV1ToV2 is pure and idempotent', () => {
  it('never changes its input, even a frozen one', () => {
    const before = structuredClone(V1_FULL);
    migrateConfigV1ToV2(V1_FULL);
    assert.deepEqual(V1_FULL, before);
  });

  it('returns a document that shares nothing with its input', () => {
    const input = structuredClone(V1_FULL);
    const migrated = /** @type {any} */ (migrateConfigV1ToV2(input));
    migrated.guard.maxUnityEditors = 9;
    migrated.projects['demo-0a1b2c3d'].editor.enabled = false;
    migrated.network.allow.push({ id: 'x' });
    assert.equal(input.guard.maxUnityEditors, 1);
    assert.equal(input.projects['demo-0a1b2c3d'].editor.enabled, true);
    assert.deepEqual(CONFIG_V2_BLOCKS.network.allow, []);
  });

  it('gives the same answer every time', () => {
    for (const document of [V1_MINIMAL, V1_FULL, { schemaVersion: 1, network: { profile: 'custom' } }]) {
      assert.deepEqual(migrateConfigV1ToV2(document), migrateConfigV1ToV2(document));
    }
  });

  it('changes nothing the second time it runs over its own output', () => {
    for (const document of [V1_MINIMAL, V1_FULL, { schemaVersion: 1, safety: { multiplayerProtectedGlobs: [] } }]) {
      const once = migrateConfigV1ToV2(document);
      assert.deepEqual(migrateConfigV1ToV2(once), once);
    }
  });

  it('leaves a version-2 document alone and reports no step', () => {
    const current = migrateDocument(V1_FULL).document;
    const again = migrateDocument(current);
    assert.deepEqual(again.document, current);
    assert.notEqual(again.document, current);
    assert.deepEqual(again.applied, []);
    assert.equal(again.fromVersion, 2);
  });

  it('refuses a file from a newer version instead of guessing', () => {
    const error = catchError(() => parseConfigText('{ "schemaVersion": 3 }'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_too_new');
  });
});

describe('a migrated file resolves exactly as a version-2 file does', () => {
  it('resolves a v1 file to the same configuration as the version-2 defaults, on every platform', () => {
    for (const platform of PLATFORMS) {
      assert.deepEqual(
        resolveConfig(V1_MINIMAL, 'config.json', { platform }),
        resolveConfig({ schemaVersion: 2, preset: PRESET }, 'config.json', { platform }),
        platform,
      );
    }
  });

  it('round-trips through the written form without a second migration', () => {
    const loaded = parseConfigText(stringifyJson(V1_FULL));
    assert.equal(loaded.fileVersion, 1);
    assert.equal(loaded.migrations.length, 1);
    const reread = parseConfigText(stringifyJson(loaded.user));
    assert.equal(reread.fileVersion, 2);
    assert.deepEqual(reread.migrations, []);
    assert.deepEqual(reread.user, loaded.user);
    assert.deepEqual(reread.config, loaded.config);
  });

  it('keeps every v1 value through to the resolved configuration', () => {
    const { config } = parseConfigText(stringifyJson(V1_FULL), 'config.json', { platform: 'win32' });
    assert.equal(config.preset, 'nvidia-24gb-qwen3-coder-30b-32k');
    assert.equal(config.ollama.baseUrl, 'http://127.0.0.1:11500');
    assert.equal(config.guard.maxUnityEditors, 1);
    assert.deepEqual(config.guard.assetImportProcessPatterns, ['AssetImportWorker']);
    assert.equal(config.safety.bashMode, 'ask');
    assert.equal(config.safety.readLimitLines, 120);
    assert.deepEqual(config.safety.extraProtectedEditGlobs, ['*Art/*']);
    assert.equal(config.start.warm, true);
    assert.equal(config.delegate.temperature, 0.1);
    assert.equal(config.projects['demo-0a1b2c3d'].editor.enabled, true);
    assert.deepEqual(config.experimental, { platforms: false, presets: true, untestedVersions: false });
  });

  it('reads a v1 file with comments and trailing commas', () => {
    const loaded = parseConfigText('{\n  // written by hand\n  "schemaVersion": 1,\n  "safety": { "bashMode": "ask", },\n}\n');
    assert.equal(loaded.config.schemaVersion, 2);
    assert.equal(loaded.config.safety.bashMode, 'ask');
    assert.deepEqual(loaded.config.safety.multiplayerProtectedGlobs, CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs);
  });
});
