import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HOME_ENV_NAME, getOllamaDefaultPaths, resolveHome, resolveLogSource, resolveOllamaPaths } from '../../../src/core/paths.js';

const WINDOWS = { platform: /** @type {NodeJS.Platform} */ ('win32'), homedir: 'C:\\Users\\<user>' };
const LINUX = { platform: /** @type {NodeJS.Platform} */ ('linux'), homedir: '/home/<user>' };
const MACOS = { platform: /** @type {NodeJS.Platform} */ ('darwin'), homedir: '/Users/<user>' };

const never = () => false;
const always = () => true;

describe('resolveHome (amendment 33.8)', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    assert.equal(resolveHome({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' } }), 'D:\\AppData\\Local\\opencode-unity');
    assert.equal(resolveHome({ ...WINDOWS, env: {} }), 'C:\\Users\\<user>\\AppData\\Local\\opencode-unity');
  });

  it('stays XDG on Linux and on macOS, so one tree does not mix two conventions', () => {
    assert.equal(resolveHome({ ...LINUX, env: {} }), '/home/<user>/.local/share/opencode-unity');
    assert.equal(resolveHome({ ...LINUX, env: { XDG_DATA_HOME: '/data' } }), '/data/opencode-unity');
    assert.equal(resolveHome({ ...MACOS, env: {} }), '/Users/<user>/.local/share/opencode-unity');
    assert.equal(resolveHome({ ...MACOS, env: { XDG_DATA_HOME: '/data' } }), '/data/opencode-unity');
  });

  it('lets OPENCODE_UNITY_HOME win on every platform', () => {
    assert.equal(resolveHome({ ...MACOS, env: { [HOME_ENV_NAME]: '/opt/ocu', XDG_DATA_HOME: '/data' } }), '/opt/ocu');
    assert.equal(resolveHome({ ...WINDOWS, env: { [HOME_ENV_NAME]: 'D:\\ocu' } }), 'D:\\ocu');
  });
});

describe('resolveOllamaPaths (claims 91, 92, 95, 117)', () => {
  it('places the Windows app, log and model store', () => {
    const paths = resolveOllamaPaths({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' } });
    assert.deepEqual(paths, {
      configDir: 'C:\\Users\\<user>\\.ollama',
      modelsDir: 'C:\\Users\\<user>\\.ollama\\models',
      appPath: 'D:\\AppData\\Local\\Programs\\Ollama\\ollama app.exe',
      logsDir: 'D:\\AppData\\Local\\Ollama',
      serverLogPath: 'D:\\AppData\\Local\\Ollama\\server.log',
    });
  });

  it('places the macOS app under /Applications and the logs under ~/.ollama/logs', () => {
    assert.deepEqual(resolveOllamaPaths({ ...MACOS, env: {} }), {
      configDir: '/Users/<user>/.ollama',
      modelsDir: '/Users/<user>/.ollama/models',
      appPath: '/Applications/Ollama.app',
      logsDir: '/Users/<user>/.ollama/logs',
      serverLogPath: '/Users/<user>/.ollama/logs/server.log',
    });
  });

  it('puts the Linux store under the service user and reports no app and no log file', () => {
    assert.deepEqual(resolveOllamaPaths({ ...LINUX, env: {} }), {
      configDir: '/usr/share/ollama/.ollama',
      modelsDir: '/usr/share/ollama/.ollama/models',
      appPath: null,
      logsDir: null,
      serverLogPath: null,
    });
  });

  it('lets OLLAMA_MODELS override the store on every platform', () => {
    assert.equal(resolveOllamaPaths({ ...LINUX, env: { OLLAMA_MODELS: '/mnt/models' } }).modelsDir, '/mnt/models');
    assert.equal(resolveOllamaPaths({ ...MACOS, env: { OLLAMA_MODELS: '/Volumes/big/models' } }).modelsDir, '/Volumes/big/models');
    assert.equal(resolveOllamaPaths({ ...WINDOWS, env: { OLLAMA_MODELS: 'E:\\models' } }).modelsDir, 'E:\\models');
    assert.equal(resolveOllamaPaths({ ...LINUX, env: { OLLAMA_MODELS: '   ' } }).modelsDir, '/usr/share/ollama/.ollama/models');
  });

  it('keeps the older two-field view working for callers that only want the app and the log', () => {
    assert.deepEqual(getOllamaDefaultPaths({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' } }), {
      appPath: 'D:\\AppData\\Local\\Programs\\Ollama\\ollama app.exe',
      serverLogPath: 'D:\\AppData\\Local\\Ollama\\server.log',
    });
    assert.deepEqual(getOllamaDefaultPaths({ ...LINUX, env: {} }), { appPath: null, serverLogPath: null });
  });
});

describe('resolveLogSource (amendment 33.8)', () => {
  it('is a file on Windows and macOS when the log is there', () => {
    assert.deepEqual(resolveLogSource({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' }, exists: always }), {
      kind: 'file',
      path: 'D:\\AppData\\Local\\Ollama\\server.log',
      rotation: 'server-*.log',
    });
    assert.deepEqual(resolveLogSource({ ...MACOS, env: {}, exists: always }), {
      kind: 'file',
      path: '/Users/<user>/.ollama/logs/server.log',
      rotation: 'server-*.log',
    });
  });

  it('is the journal on Linux, where Ollama runs as a systemd unit, read as bare message text', () => {
    assert.deepEqual(resolveLogSource({ ...LINUX, env: {}, exists: never }), {
      kind: 'journal',
      unit: 'ollama',
      command: ['journalctl', '-u', 'ollama', '--no-pager', '--output=cat'],
    });
  });

  it('adds -n only when a caller asks for a line count', () => {
    const source = resolveLogSource({ ...LINUX, env: {}, lines: 400 });
    assert.deepEqual(source.kind === 'journal' ? source.command : [], ['journalctl', '-u', 'ollama', '--no-pager', '--output=cat', '-n', '400']);
  });

  it('is none when nothing resolves, which is what a hand-started `ollama serve` looks like', () => {
    assert.deepEqual(resolveLogSource({ ...MACOS, env: {}, exists: never }), { kind: 'none' });
    assert.deepEqual(resolveLogSource({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' }, exists: never }), { kind: 'none' });
    assert.deepEqual(resolveLogSource({ platform: /** @type {NodeJS.Platform} */ ('freebsd'), homedir: '/home/<user>', env: {}, exists: never }), { kind: 'none' });
  });

  it('takes a configured path as the user stating their own install, without checking it first', () => {
    assert.deepEqual(resolveLogSource({ ...LINUX, env: {}, configuredPath: '/var/log/ollama.log', exists: never }), {
      kind: 'file',
      path: '/var/log/ollama.log',
      rotation: 'server-*.log',
    });
    assert.deepEqual(resolveLogSource({ ...LINUX, env: {}, configuredPath: '   ', exists: never }).kind, 'journal');
  });
});
