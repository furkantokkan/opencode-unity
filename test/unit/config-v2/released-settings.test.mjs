import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig, resolveConfig, writeConfigFile } from '../../../src/core/config.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

const PREVIEW_SETTINGS = {
  schemaVersion: 1,
  guard: { allowOffload: true },
  delegate: { enabled: false, monitorWindow: true },
  ollama: { startAppIfDown: 'always' },
  start: { pane: 'auto' },
  safety: { extraProtectedEditGlobs: ['*Art/*'], extraProtectedReadGlobs: ['*private-notes*'] },
};

describe('config-v2 preserves released preview settings', () => {
  it('keeps explicit guard, delegation and platform choices through read and write', async (t) => {
    const sandbox = await useSandbox(t, 'config-v2-released-settings');
    const file = path.join(sandbox.root, 'config.json');
    const text = JSON.stringify(PREVIEW_SETTINGS, null, 2) + '\n';
    await fs.writeFile(file, text);

    const loaded = await loadConfig(file, { platform: 'linux' });
    assert.equal(loaded.fileVersion, 1);
    assert.equal(loaded.config.schemaVersion, 2);
    assert.equal(await fs.readFile(file, 'utf8'), text, 'reading must not rewrite v1');
    await writeConfigFile(file, loaded.user);
    const reloaded = await loadConfig(file, { platform: 'linux' });
    assert.equal(reloaded.fileVersion, 2);
    assert.deepEqual(reloaded.migrations, []);
    assert.deepEqual(reloaded.config, loaded.config);
    for (const [section, choices] of Object.entries(PREVIEW_SETTINGS)) {
      if (section === 'schemaVersion') continue;
      for (const [key, value] of Object.entries(choices)) {
        assert.deepEqual(reloaded.user[section][key], value, `${section}.${key}`);
        assert.deepEqual(reloaded.config[section][key], value, `${section}.${key}`);
      }
    }
  });

  it('does not conceal invalid released choices during migration', () => {
    for (const settings of [
      { guard: { allowOffload: 'yes' } },
      { delegate: { enabled: 'off' } },
      { delegate: { monitorWindow: 'on' } },
    ]) {
      assert.throws(() => resolveConfig({ schemaVersion: 1, ...settings }), /must be true or false/);
    }
  });
});
