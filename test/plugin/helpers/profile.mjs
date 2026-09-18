// A real runtime profile for the plugin suites: built through src/core/profile.js rather than
// hand-written, so a schema change breaks these tests instead of silently passing a stale fixture.
import { resolveConfig } from '../../../src/core/config.js';
import { loadPreset } from '../../../src/core/presets.js';
import { buildRuntimeProfile } from '../../../src/core/profile.js';

export const TEST_HOME = '/opt/opencode-unity-home';

/**
 * @param {{ userConfig?: Record<string, unknown>, preset?: string, home?: string }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile}
 */
export function buildTestProfile({ userConfig = {}, preset = 'nvidia-24gb-qwen3-coder-30b-16k', home = TEST_HOME } = {}) {
  return buildRuntimeProfile({
    config: resolveConfig({ schemaVersion: 1, ...userConfig }),
    userConfig: { schemaVersion: 1, ...userConfig },
    preset: loadPreset(preset),
    cliVersion: '0.1.0',
    home,
  }).profile;
}

/**
 * A profile with individual fields replaced. The result is a plain object, not frozen, so a test can
 * push it out of range on purpose.
 * @param {(profile: any) => void} mutate
 * @returns {any}
 */
export function buildProfileWith(mutate) {
  const profile = JSON.parse(JSON.stringify(buildTestProfile()));
  mutate(profile);
  return profile;
}
