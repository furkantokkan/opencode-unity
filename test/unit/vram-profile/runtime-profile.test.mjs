import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  RUNTIME_PROFILE_FILE_NAME,
  RUNTIME_PROFILE_SCHEMA,
  RUNTIME_PROFILE_SCHEMA_VERSION,
  getDefaultRuntimeProfilePath,
  loadRuntimeProfile,
  parseRuntimeProfile,
  validateRuntimeProfile,
} from '../../../plugin/opencode-unity-lib/runtime-profile.js';
import { resolveConfig } from '../../../src/core/config.js';
import { loadPreset } from '../../../src/core/presets.js';
import { buildRuntimeProfile, renderRuntimeProfile } from '../../../src/core/profile.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

const SCHEMA_FILE = new URL('../../../schema/runtime-profile.schema.json', import.meta.url);

function buildProfile() {
  return buildRuntimeProfile({
    config: resolveConfig({ schemaVersion: 1 }),
    preset: loadPreset('nvidia-24gb-qwen3-coder-30b-16k'),
    cliVersion: '0.1.0',
    home: '/tmp/opencode-unity-home',
    kv: { kvType: 'q8_0', source: 'server-log' },
  }).profile;
}

describe('runtime profile schema', () => {
  it('the published schema file matches the copy the plugin carries', async () => {
    // Only plugin/ is copied into the rendered profile, so the plugin cannot read schema/.
    const published = JSON.parse(await fs.readFile(SCHEMA_FILE, 'utf8'));
    assert.deepEqual(published, JSON.parse(JSON.stringify(RUNTIME_PROFILE_SCHEMA)));
    assert.equal(published.properties.schemaVersion.const, RUNTIME_PROFILE_SCHEMA_VERSION);
  });

  it('accepts a freshly built profile', () => {
    assert.deepEqual(validateRuntimeProfile(buildProfile()), []);
  });
});

describe('validateRuntimeProfile fails closed (spec D3, 6.3)', () => {
  it('reports a profile written by another schema version, with the upgrade step', () => {
    const problems = validateRuntimeProfile({ ...buildProfile(), schemaVersion: 2 });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /schemaVersion 2 is not supported/);
    assert.match(problems[0], /opencode-unity upgrade/);
  });

  it('reports anything that is not an object', () => {
    for (const value of [null, undefined, 42, 'text', []]) assert.ok(validateRuntimeProfile(value).length > 0, String(value));
  });

  it('reports a missing or unknown key', () => {
    const { provider, ...withoutProvider } = buildProfile();
    assert.match(validateRuntimeProfile(withoutProvider).join(' '), /provider is required/);
    assert.match(validateRuntimeProfile({ ...buildProfile(), extra: true }).join(' '), /extra is not a known key/);
  });

  it('reports a provider block that does not match our contract', () => {
    const profile = buildProfile();
    assert.match(validateRuntimeProfile({ ...profile, provider: { ...profile.provider, id: 'other' } }).join(' '), /provider\.id/);
    assert.match(validateRuntimeProfile({ ...profile, provider: { ...profile.provider, npm: 'ollama-ai-provider' } }).join(' '), /provider\.npm/);
    assert.match(validateRuntimeProfile({ ...profile, provider: { ...profile.provider, modelTag: 'qwen3-coder:30b' } }).join(' '), /provider\.modelTag/);
    assert.match(validateRuntimeProfile({ ...profile, provider: { ...profile.provider, baseURL: 'http://127.0.0.1:11434' } }).join(' '), /provider\.baseURL/);
    assert.match(validateRuntimeProfile({ ...profile, provider: { ...profile.provider, keepAlive: 'forever' } }).join(' '), /provider\.keepAlive/);
  });

  it('reports limits that would let Ollama truncate, and a budget that does not add up', () => {
    const profile = buildProfile();
    const tooLarge = { ...profile, provider: { ...profile.provider, limit: { context: 32_768, output: 4096 } } };
    assert.match(validateRuntimeProfile(tooLarge).join(' '), /larger than provider\.numCtx/);
    const badOutput = { ...profile, provider: { ...profile.provider, limit: { context: 16_384, output: 16_384 } } };
    assert.match(validateRuntimeProfile(badOutput).join(' '), /must be smaller/);
    const badBudget = { ...profile, budget: { ...profile.budget, promptBudget: 12_000 } };
    assert.match(validateRuntimeProfile(badBudget).join(' '), /must equal limit\.context - limit\.output - reserveTokens/);
  });

  it('reports a base URL that does not match the provider URL and a reversed calibration clamp', () => {
    const profile = buildProfile();
    assert.match(validateRuntimeProfile({ ...profile, ollama: { baseUrl: 'http://127.0.0.1:11500' } }).join(' '), /must be ollama\.baseUrl/);
    assert.match(validateRuntimeProfile({ ...profile, budget: { ...profile.budget, calibrationClamp: [1.4, 0.7] } }).join(' '), /calibrationClamp/);
  });

  it('reports a guard block with a missing key or an unknown mode', () => {
    const profile = buildProfile();
    const { nvidiaSmiCommand, ...guard } = profile.guard;
    assert.match(validateRuntimeProfile({ ...profile, guard }).join(' '), /guard\.nvidiaSmiCommand is required/);
    assert.match(validateRuntimeProfile({ ...profile, guard: { ...profile.guard, importWhileLoaded: 'ignore' } }).join(' '), /guard\.importWhileLoaded/);
    assert.match(validateRuntimeProfile({ ...profile, guard: { ...profile.guard, modelVramMiB: 0 } }).join(' '), /guard\.modelVramMiB/);
  });
});

describe('parseRuntimeProfile', () => {
  it('reads rendered JSON, with or without a byte-order mark, and freezes the result', () => {
    const text = renderRuntimeProfile(buildProfile());
    const result = parseRuntimeProfile(`﻿${text}`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(Object.isFrozen(result.profile), true);
    assert.equal(Object.isFrozen(result.profile.provider), true);
    assert.throws(() => {
      /** @type {any} */ (result.profile).provider.modelTag = 'other';
    });
  });

  it('returns a reason instead of throwing for broken content', () => {
    for (const [text, pattern] of [
      ['{', /invalid JSON/],
      ['[]', /must be an object/],
      ['{"schemaVersion": 99}', /not supported/],
    ]) {
      const result = parseRuntimeProfile(/** @type {string} */ (text));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /** @type {RegExp} */ (pattern));
    }
  });

  it('lists at most five problems and counts the rest', () => {
    const result = parseRuntimeProfile('{"schemaVersion": 1}');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /and \d+ more/);
  });
});

describe('loadRuntimeProfile', () => {
  it('reads the profile next to the plugins directory', async (t) => {
    const sandbox = await useSandbox(t, 'runtime-profile');
    const file = sandbox.path(RUNTIME_PROFILE_FILE_NAME);
    await fs.writeFile(file, renderRuntimeProfile(buildProfile()));
    const result = await loadRuntimeProfile({ path: file });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.profile.presetId, 'nvidia-24gb-qwen3-coder-30b-16k');
  });

  it('reports a missing file without throwing, so the plugin injects nothing', async (t) => {
    const sandbox = await useSandbox(t, 'runtime-profile-missing');
    const result = await loadRuntimeProfile({ path: sandbox.path('absent', RUNTIME_PROFILE_FILE_NAME) });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /file not found/);
      assert.match(result.reason, new RegExp(RUNTIME_PROFILE_FILE_NAME.replace('.', '\\.')));
    }
  });

  it('reports a read failure without throwing', async () => {
    const result = await loadRuntimeProfile({
      path: 'x',
      readFile: () => Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /cannot read/);
  });

  it('looks two levels above the lib directory, where setup renders the file', () => {
    // A file URL needs a drive letter on Windows; on POSIX it is just another directory name.
    const fromLib = getDefaultRuntimeProfilePath('file:///C:/profile/0.1.0/plugins/opencode-unity-lib/runtime-profile.js');
    assert.equal(path.basename(fromLib), RUNTIME_PROFILE_FILE_NAME);
    assert.equal(path.basename(path.dirname(fromLib)), '0.1.0');
  });
});
