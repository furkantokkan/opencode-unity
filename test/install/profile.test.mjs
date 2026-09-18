// What a profile directory consists of (spec 6.1): the rendered OpenCode assets, the runtime profile and
// a byte-for-byte copy of the plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { loadPreset } from '../../src/core/presets.js';
import { buildRuntimeProfile } from '../../src/core/profile.js';
import { PLUGIN_SOURCE_URL, RUNTIME_PROFILE_FILE, collectPluginFiles, renderProfileFiles } from '../../src/install/profile.js';
import { PLUGIN_FILES } from './helpers.mjs';

const HOME = process.platform === 'win32' ? 'C:\\Users\\user\\AppData\\Local\\opencode-unity' : '/home/user/.local/share/opencode-unity';

function buildProfile() {
  return buildRuntimeProfile({ config: DEFAULT_CONFIG, preset: loadPreset('nvidia-24gb-qwen3-coder-30b-16k'), cliVersion: '0.1.0', home: HOME }).profile;
}

describe('profile files', () => {
  it('holds the OpenCode assets, the runtime profile and the plugin under plugins/', async () => {
    const files = await renderProfileFiles({ profile: buildProfile(), config: DEFAULT_CONFIG, cliVersion: '0.1.0', pluginFiles: PLUGIN_FILES });
    assert.deepEqual(Object.keys(files).sort(), [
      'agents/unity-code.md',
      'agents/unity-editor.md',
      'commands/compile.md',
      'opencode-unity.runtime.json',
      'opencode.jsonc',
      'plugins/opencode-unity-lib/toast.js',
      'plugins/opencode-unity.js',
    ]);
    const runtime = JSON.parse(/** @type {string} */ (files[RUNTIME_PROFILE_FILE]));
    assert.equal(runtime.provider.modelTag, 'ocu-qwen3-coder-30b-16k');
    assert.match(/** @type {string} */ (files['opencode.jsonc']), /ocu-qwen3-coder-30b-16k/);
  });

  it('copies the shipped plugin byte for byte, with POSIX keys', async () => {
    const files = await collectPluginFiles();
    const root = fileURLToPath(PLUGIN_SOURCE_URL);
    assert.ok(Object.hasOwn(files, 'opencode-unity.js'));
    const nested = Object.keys(files).filter((key) => key.includes('/'));
    assert.ok(nested.length > 0);
    assert.ok(Object.keys(files).every((key) => !key.includes('\\')));
    for (const key of ['opencode-unity.js', nested[0]]) {
      assert.deepEqual(Buffer.from(files[key]), await fs.readFile(path.join(root, ...key.split('/'))));
    }
  });

  it('lists the plugin in a stable order', async () => {
    const keys = Object.keys(await collectPluginFiles());
    assert.deepEqual(keys, [...keys].sort());
  });
});
