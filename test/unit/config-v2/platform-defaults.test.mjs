// Platform defaults (amendment 33.5): a few keys default differently per platform, resolved before the
// user's own values so that a value in the file always wins. Every platform is exercised on every
// runner, because the resolution is pure.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG, getDefaultConfig, loadConfig, parseConfigText, resolveConfig } from '../../../src/core/config.js';
import { loadSession } from '../../../src/project/session.js';
import { loadPreset } from '../../../src/core/presets.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

/**
 * Dotted paths of every leaf where two configurations differ.
 * @param {unknown} left
 * @param {unknown} right
 * @param {string} [prefix]
 * @returns {string[]}
 */
function differingPaths(left, right, prefix = '') {
  const isObject = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(left) || !isObject(right)) return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix];
  const keys = new Set([...Object.keys(/** @type {object} */ (left)), ...Object.keys(/** @type {object} */ (right))]);
  return [...keys].flatMap((key) => differingPaths(/** @type {any} */ (left)[key], /** @type {any} */ (right)[key], prefix ? `${prefix}.${key}` : key));
}

describe('getDefaultConfig (33.5)', () => {
  it('uses the Windows column for DEFAULT_CONFIG', () => {
    assert.deepEqual(getDefaultConfig('win32'), DEFAULT_CONFIG);
  });

  it('changes only the keys the amendment lists, on Linux and on macOS', () => {
    assert.deepEqual(differingPaths(DEFAULT_CONFIG, getDefaultConfig('linux')).sort(), ['ollama.startAppIfDown', 'start.pane']);
    assert.deepEqual(differingPaths(DEFAULT_CONFIG, getDefaultConfig('darwin')).sort(), ['guard.minFreeVramAfterLoadMiB', 'start.pane']);
  });

  it('holds the values of the table', () => {
    const linux = getDefaultConfig('linux');
    const darwin = getDefaultConfig('darwin');
    const windows = getDefaultConfig('win32');
    assert.equal(windows.ollama.startAppIfDown, 'ask');
    assert.equal(linux.ollama.startAppIfDown, 'never', 'Ollama is a systemd service on Linux; starting it needs root');
    assert.equal(darwin.ollama.startAppIfDown, 'ask');
    assert.equal(windows.start.pane, 'auto');
    assert.equal(linux.start.pane, 'never');
    assert.equal(darwin.start.pane, 'never');
    assert.equal(windows.guard.minFreeVramAfterLoadMiB, 1500);
    assert.equal(linux.guard.minFreeVramAfterLoadMiB, 1500);
    assert.equal(darwin.guard.minFreeVramAfterLoadMiB, 4096);
    for (const defaults of [windows, linux, darwin]) {
      assert.equal(defaults.guard.adapter, 'auto');
      assert.equal(defaults.ollama.serverLogPath, null, 'the log source is resolved per platform, not stored');
      assert.equal(defaults.safety.bashMode, 'allowlist');
    }
  });

  it('gives every other platform the Linux column', () => {
    for (const platform of ['freebsd', 'openbsd', 'aix', 'sunos', 'android']) {
      assert.deepEqual(getDefaultConfig(platform), getDefaultConfig('linux'), platform);
    }
  });

  it('defaults to the platform it runs on', () => {
    assert.deepEqual(getDefaultConfig(), getDefaultConfig(process.platform));
  });

  it('is frozen and computed once per column', () => {
    const darwin = getDefaultConfig('darwin');
    assert.equal(Object.isFrozen(darwin.guard), true);
    assert.equal(getDefaultConfig('darwin'), darwin);
    assert.equal(getDefaultConfig('freebsd'), getDefaultConfig('linux'));
    assert.equal(DEFAULT_CONFIG.guard.minFreeVramAfterLoadMiB, 1500, 'resolving another column never changes the Windows one');
  });
});

describe('a value in the file wins over the platform default', () => {
  it('keeps what the user wrote, on the platform whose default differs', () => {
    const linux = resolveConfig({ schemaVersion: 2, ollama: { startAppIfDown: 'ask' }, start: { pane: 'auto' } }, 'config.json', { platform: 'linux' });
    assert.equal(linux.ollama.startAppIfDown, 'ask');
    assert.equal(linux.start.pane, 'auto');
    const darwin = resolveConfig({ schemaVersion: 2, guard: { minFreeVramAfterLoadMiB: 1500 } }, 'config.json', { platform: 'darwin' });
    assert.equal(darwin.guard.minFreeVramAfterLoadMiB, 1500);
  });

  it('fills the rest of a partly written block from the platform column', () => {
    const darwin = resolveConfig({ schemaVersion: 2, guard: { maxUnityEditors: 1 }, start: { warm: true } }, 'config.json', { platform: 'darwin' });
    assert.equal(darwin.guard.maxUnityEditors, 1);
    assert.equal(darwin.guard.minFreeVramAfterLoadMiB, 4096);
    assert.equal(darwin.start.warm, true);
    assert.equal(darwin.start.pane, 'never');
  });

  it('resolves one v1 file to each platform its reader runs on', () => {
    const text = JSON.stringify({ schemaVersion: 1, preset: 'nvidia-24gb-qwen3-coder-30b-16k' });
    assert.equal(parseConfigText(text, 'config.json', { platform: 'win32' }).config.start.pane, 'auto');
    assert.equal(parseConfigText(text, 'config.json', { platform: 'linux' }).config.ollama.startAppIfDown, 'never');
    assert.equal(parseConfigText(text, 'config.json', { platform: 'darwin' }).config.guard.minFreeVramAfterLoadMiB, 4096);
  });
});

describe('loadConfig with a platform', () => {
  it('uses the command platform for session defaults and preserves preset guard overrides', async (t) => {
    const sandbox = await useSandbox(t, 'config-v2-session-platform');
    for (const platform of ['win32', 'linux', 'darwin']) {
      const session = await loadSession({
        platform,
        env: sandbox.env,
        cwd: sandbox.root,
        version: '0.1.0',
      });
      const defaults = getDefaultConfig(platform);
      assert.equal(session.config.start.pane, defaults.start.pane, platform);
      assert.equal(session.config.ollama.startAppIfDown, defaults.ollama.startAppIfDown, platform);
      assert.equal(session.config.guard.minFreeVramAfterLoadMiB, defaults.guard.minFreeVramAfterLoadMiB, platform);
      assert.equal(session.profile.guard.minFreeVramAfterLoadMiB,
        loadPreset(session.config.preset).guard.minFreeVramAfterLoadMiB, platform);
    }
  });

  it('applies the given platform to a missing file', async (t) => {
    const sandbox = await useSandbox(t, 'config-v2-platform-missing');
    const missing = sandbox.path('config.json');
    assert.deepEqual((await loadConfig(missing, { platform: 'darwin' })).config, getDefaultConfig('darwin'));
    assert.deepEqual((await loadConfig(missing, { platform: 'linux' })).config, getDefaultConfig('linux'));
    assert.deepEqual((await loadConfig(missing)).config, getDefaultConfig(process.platform));
  });

  it('applies the given platform to a file that exists', async (t) => {
    const sandbox = await useSandbox(t, 'config-v2-platform-file');
    const file = sandbox.path('config.json');
    await fs.writeFile(file, '{ "schemaVersion": 2, "start": { "warm": true } }\n', 'utf8');
    const loaded = await loadConfig(file, { platform: 'linux' });
    assert.equal(loaded.config.start.warm, true);
    assert.equal(loaded.config.start.pane, 'never');
    assert.deepEqual(loaded.user, { schemaVersion: 2, start: { warm: true } }, 'a platform default never enters the user document');
  });
});
