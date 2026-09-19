import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';

import { resolveConfig } from '../../../src/core/config.js';
import { loadPreset } from '../../../src/core/presets.js';
import { buildRuntimeProfile, renderRuntimeProfile } from '../../../src/core/profile.js';
import { parseRuntimeProfile, validateRuntimeProfile } from '../../../plugin/opencode-unity-lib/runtime-profile.js';

function build(config) {
  return buildRuntimeProfile({
    config,
    preset: loadPreset(config.preset),
    cliVersion: '0.1.0',
    home: path.join(os.tmpdir(), 'profile-boundary'),
  }).profile;
}

describe('config and runtime-profile boundary', () => {
  it('does not copy workspace-only settings into the plugin schema', () => {
    const config = resolveConfig({
      schemaVersion: 2,
      safety: { multiplayerProtectedGlobs: ['*Economy/*'] },
    });
    const before = structuredClone(config);

    const profile = build(config);

    assert.deepEqual(validateRuntimeProfile(profile), []);
    assert.equal(parseRuntimeProfile(renderRuntimeProfile(profile)).ok, true);
    assert.equal(Object.hasOwn(profile.safety, 'multiplayerProtectedGlobs'), false);
    assert.deepEqual(config, before, 'profile rendering must not discard user settings');
  });

  it('preserves guard choices and both lists of custom file protections', () => {
    const config = structuredClone(resolveConfig({
      schemaVersion: 1,
      guard: { allowOffload: true },
      safety: {
        bashMode: 'ask',
        readLimitLines: 120,
        extraProtectedEditGlobs: ['*Art/*'],
        extraProtectedReadGlobs: ['*private-notes*'],
      },
    }));
    const profile = build(config);
    assert.equal(profile.guard.allowOffload, true);
    assert.equal(profile.safety.bashMode, 'ask');
    assert.equal(profile.safety.readLimitLines, 120);
    assert.deepEqual(profile.safety.extraProtectedEditGlobs, ['*Art/*']);
    assert.deepEqual(profile.safety.extraProtectedReadGlobs, ['*private-notes*']);
    config.safety.extraProtectedEditGlobs.push('*Drafts/*');
    config.safety.extraProtectedReadGlobs.length = 0;
    assert.deepEqual(profile.safety.extraProtectedEditGlobs, ['*Art/*']);
    assert.deepEqual(profile.safety.extraProtectedReadGlobs, ['*private-notes*']);
  });

  it('still rejects unknown fields in the serialized plugin profile', () => {
    const profile = structuredClone(build(resolveConfig({ schemaVersion: 1 })));
    profile.safety.allowSecrets = true;
    assert.ok(validateRuntimeProfile(profile).some((problem) => /safety.allowSecrets/.test(problem)));
    assert.equal(parseRuntimeProfile(JSON.stringify(profile)).ok, false);
  });
});
