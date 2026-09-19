// A v1 config.json migrates forward in memory on every read and on an explicit write only; it is never
// silently rewritten (amendment 38.4, 38.18). Every read-side claim here is proven against a filesystem
// snapshot taken before and after, including modification times, so a rewrite with identical bytes
// still fails the test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getDefaultConfig, loadConfig, parseConfigText, renderInitialConfig, resolveConfig, writeConfigFile } from '../../../src/core/config.js';
import { CONFIG_V2_BLOCKS } from '../../../src/core/migrations.js';
import { diffSnapshots, snapshotTree } from '../../helpers/fixture-fs.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';
import { createCommandHarness } from '../commands/helpers.mjs';

const V1_TEXT = [
  '{',
  '  // written by an earlier opencode-unity, then edited by hand',
  '  "schemaVersion": 1,',
  '  "preset": "nvidia-24gb-qwen3-coder-30b-32k",',
  '  "safety": { "bashMode": "ask", "extraProtectedEditGlobs": ["*Art/*"] },',
  '  "experimental": { "presets": true },',
  '}',
  '',
].join('\n');

/**
 * Content hashes of everything under `root`, plus the modification time of every file.
 * @param {string} root
 * @returns {Promise<{ tree: Record<string, unknown>, times: Record<string, number> }>}
 */
async function snapshotWithTimes(root) {
  const tree = await snapshotTree(root);
  /** @type {Record<string, number>} */
  const times = {};
  for (const [relativePath, entry] of Object.entries(tree)) {
    if (/** @type {{ type: string }} */ (entry).type === 'file') times[relativePath] = (await fs.stat(path.join(root, relativePath))).mtimeMs;
  }
  return { tree, times };
}

/**
 * @param {{ tree: Record<string, unknown>, times: Record<string, number> }} before
 * @param {{ tree: Record<string, unknown>, times: Record<string, number> }} after
 */
function assertUnchanged(before, after) {
  assert.deepEqual(diffSnapshots(/** @type {any} */ (before.tree), /** @type {any} */ (after.tree)), { added: [], removed: [], changed: [] });
  assert.deepEqual(after.times, before.times);
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {string} [text]
 */
async function writeV1Home(t, label, text = V1_TEXT) {
  const sandbox = await useSandbox(t, label);
  const home = sandbox.path('product-home');
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, 'config.json');
  await fs.writeFile(file, text, 'utf8');
  return { home, file };
}

describe('reading a v1 config.json writes nothing', () => {
  it('migrates in memory and leaves every byte and every timestamp on disk as it was', async (t) => {
    const { home, file } = await writeV1Home(t, 'config-v2-read');
    const before = await snapshotWithTimes(home);

    const loaded = await loadConfig(file);
    parseConfigText(await fs.readFile(file, 'utf8'), file);
    resolveConfig(loaded.user, file);

    assertUnchanged(before, await snapshotWithTimes(home));
    assert.equal(await fs.readFile(file, 'utf8'), V1_TEXT);
    assert.equal(loaded.fileVersion, 1);
    assert.equal(loaded.migrations.length, 1);
    assert.equal(loaded.user.schemaVersion, 2);
    assert.equal(loaded.config.schemaVersion, 2);
    assert.equal(loaded.config.safety.bashMode, 'ask');
  });

  it('migrates it again, the same way, on the next read', async (t) => {
    const { file } = await writeV1Home(t, 'config-v2-reread');
    const first = await loadConfig(file, { platform: 'darwin' });
    const second = await loadConfig(file, { platform: 'darwin' });
    assert.deepEqual(second, first);
    assert.equal(second.fileVersion, 1);
  });

  it('leaves a v1 file alone while guard and status run against it', async (t) => {
    const harness = await createCommandHarness(t, { config: { schemaVersion: 1 } });
    const configText = await fs.readFile(harness.paths.config, 'utf8');
    assert.equal(JSON.parse(configText).schemaVersion, 1);
    const before = await snapshotWithTimes(path.dirname(harness.paths.config));

    const guard = await harness.run('guard');
    const status = await harness.run('status', { deps: { watcher: { poll: async () => [], render: () => [] } } });

    assert.equal(guard.exitCode, 0, guard.message);
    assert.equal(status.exitCode, 0, status.message);
    assert.equal(await fs.readFile(harness.paths.config, 'utf8'), configText);
    const after = await snapshotWithTimes(path.dirname(harness.paths.config));
    assert.deepEqual(after.times[path.basename(harness.paths.config)], before.times[path.basename(harness.paths.config)]);
  });
});

describe('an explicit write moves the file forward', () => {
  it('writes the migrated form of a v1 document, which then loads without a migration', async (t) => {
    const { file } = await writeV1Home(t, 'config-v2-write');
    const inMemory = await loadConfig(file, { platform: 'win32' });

    await writeConfigFile(file, /** @type {Record<string, unknown>} */ (parseConfigText(V1_TEXT).user));
    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(written.schemaVersion, 2);
    assert.deepEqual(written.network, CONFIG_V2_BLOCKS.network);

    const reloaded = await loadConfig(file, { platform: 'win32' });
    assert.equal(reloaded.fileVersion, 2);
    assert.deepEqual(reloaded.migrations, []);
    assert.deepEqual(reloaded.config, inMemory.config);
  });

  it('migrates a v1 document handed to it directly, rather than writing version 1 again', async (t) => {
    const { file } = await writeV1Home(t, 'config-v2-write-direct');
    await writeConfigFile(file, { schemaVersion: 1, preset: 'nvidia-24gb-qwen3-coder-30b-16k' });
    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(written.schemaVersion, 2);
    assert.deepEqual(Object.keys(written), ['schemaVersion', 'preset', 'network', 'shape', 'project', 'safety', 'experimental']);
  });

  it('keeps every value the user wrote and adds only the new blocks, as upgrade writes it', async (t) => {
    const { file } = await writeV1Home(t, 'config-v2-upgrade-shape');
    const loaded = await loadConfig(file);
    await writeConfigFile(file, loaded.user);
    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(written), ['schemaVersion', 'preset', 'safety', 'experimental', 'network', 'shape', 'project']);
    assert.equal(written.preset, 'nvidia-24gb-qwen3-coder-30b-32k');
    assert.deepEqual(written.safety, { bashMode: 'ask', extraProtectedEditGlobs: ['*Art/*'], multiplayerProtectedGlobs: CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs });
    assert.deepEqual(written.experimental, { presets: true, platforms: false });
    for (const key of ['ollama', 'guard', 'start']) assert.equal(Object.hasOwn(written, key), false, `${key} is a platform-dependent block the file never had`);
  });

  it('refuses a document that would not load and leaves the old file and its folder as they were', async (t) => {
    const { home, file } = await writeV1Home(t, 'config-v2-write-invalid');
    const before = await snapshotWithTimes(home);
    await assert.rejects(writeConfigFile(file, { schemaVersion: 1, network: 'off' }), /network must be an object/);
    assertUnchanged(before, await snapshotWithTimes(home));
  });

  it('starts a new install at version 2 with only the version and the preset', () => {
    const initial = JSON.parse(renderInitialConfig('nvidia-24gb-qwen3-coder-30b-32k'));
    assert.deepEqual(initial, { schemaVersion: 2, preset: 'nvidia-24gb-qwen3-coder-30b-32k' });
    assert.deepEqual(parseConfigText(renderInitialConfig(), 'config.json', { platform: 'linux' }).migrations, []);
    assert.equal(resolveConfig(initial, 'config.json', { platform: 'linux' }).start.pane, getDefaultConfig('linux').start.pane);
  });
});
