import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { HOME_ENV_NAME, getHomeDir, getHomePaths, getOllamaDefaultPaths, getPathApi, getProjectId, normalizeProjectPath } from '../../../src/core/paths.js';
import { sha256Hex } from '../../../src/core/hash.js';

const WINDOWS = { platform: /** @type {NodeJS.Platform} */ ('win32'), homedir: 'C:\\Users\\<user>' };
const LINUX = { platform: /** @type {NodeJS.Platform} */ ('linux'), homedir: '/home/<user>' };

describe('getHomeDir (spec 6.1)', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    assert.equal(getHomeDir({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' } }), 'D:\\AppData\\Local\\opencode-unity');
    assert.equal(getHomeDir({ ...WINDOWS, env: {} }), 'C:\\Users\\<user>\\AppData\\Local\\opencode-unity');
  });

  it('uses XDG_DATA_HOME elsewhere, and ignores a relative one', () => {
    assert.equal(getHomeDir({ ...LINUX, env: { XDG_DATA_HOME: '/data' } }), '/data/opencode-unity');
    assert.equal(getHomeDir({ ...LINUX, env: {} }), '/home/<user>/.local/share/opencode-unity');
    assert.equal(getHomeDir({ ...LINUX, env: { XDG_DATA_HOME: 'relative' } }), '/home/<user>/.local/share/opencode-unity');
  });

  it('lets OPENCODE_UNITY_HOME win, resolved to an absolute path', () => {
    assert.equal(getHomeDir({ ...LINUX, env: { [HOME_ENV_NAME]: '/opt/ocu', XDG_DATA_HOME: '/data' } }), '/opt/ocu');
    assert.equal(getHomeDir({ ...WINDOWS, env: { [HOME_ENV_NAME]: 'D:\\ocu\\' } }), 'D:\\ocu');
    assert.equal(getHomeDir({ ...LINUX, env: { [HOME_ENV_NAME]: '  ' } }), '/home/<user>/.local/share/opencode-unity');
  });
});

describe('getHomePaths (spec 6.1 layout)', () => {
  const paths = getHomePaths('C:\\home\\opencode-unity', { platform: 'win32' });

  it('places every file where the spec says', () => {
    assert.equal(paths.config, 'C:\\home\\opencode-unity\\config.json');
    assert.equal(paths.profileCurrent, 'C:\\home\\opencode-unity\\profile\\current.json');
    assert.equal(paths.xdgConfig, 'C:\\home\\opencode-unity\\xdg-config');
    assert.equal(paths.projectsIndex, 'C:\\home\\opencode-unity\\projects\\index.json');
    assert.equal(paths.installManifest, 'C:\\home\\opencode-unity\\state\\install-manifest.json');
    assert.equal(paths.gpuLock, 'C:\\home\\opencode-unity\\state\\gpu.lock');
    assert.equal(paths.sessionsDir, 'C:\\home\\opencode-unity\\state\\sessions');
    assert.equal(paths.delegateLedger, 'C:\\home\\opencode-unity\\state\\delegate\\ledger.jsonl');
    assert.equal(paths.prefixCapture('0.1.0'), 'C:\\home\\opencode-unity\\state\\prefix-0.1.0.json');
  });

  it('lays out a profile version directory', () => {
    const profile = paths.profile('0.1.0');
    assert.equal(profile.dir, 'C:\\home\\opencode-unity\\profile\\0.1.0');
    assert.equal(profile.opencodeConfig, 'C:\\home\\opencode-unity\\profile\\0.1.0\\opencode.jsonc');
    assert.equal(profile.runtimeProfile, 'C:\\home\\opencode-unity\\profile\\0.1.0\\opencode-unity.runtime.json');
    assert.equal(profile.modelfile, 'C:\\home\\opencode-unity\\profile\\0.1.0\\Modelfile');
    assert.equal(profile.pluginsDir, 'C:\\home\\opencode-unity\\profile\\0.1.0\\plugins');
  });

  it('lays out a project directory', () => {
    const project = paths.project('mygame-0a1b2c3d');
    assert.equal(project.facts, 'C:\\home\\opencode-unity\\projects\\mygame-0a1b2c3d\\facts.md');
    assert.equal(project.localJson, 'C:\\home\\opencode-unity\\projects\\mygame-0a1b2c3d\\local.json');
    assert.equal(project.launchJson, 'C:\\home\\opencode-unity\\projects\\mygame-0a1b2c3d\\launch.json');
    assert.equal(project.verifyCache, 'C:\\home\\opencode-unity\\projects\\mygame-0a1b2c3d\\verify-cache.json');
  });

  it('refuses a version or project id that could escape the home directory', () => {
    assert.throws(() => paths.profile('../evil'), /Invalid CLI version/);
    assert.throws(() => paths.project('..\\evil-0a1b2c3d'), /Invalid project id/);
    assert.throws(() => paths.project('mygame'), /Invalid project id/);
    assert.throws(() => paths.project('.hidden-0a1b2c3d'), /Invalid project id/);
  });

  it('uses POSIX separators on other platforms', () => {
    const posix = getHomePaths('/home/<user>/.local/share/opencode-unity', { platform: 'linux' });
    assert.equal(posix.config, '/home/<user>/.local/share/opencode-unity/config.json');
    assert.equal(getPathApi('linux'), path.posix);
    assert.equal(getPathApi('win32'), path.win32);
  });
});

describe('project ids (spec 6.1)', () => {
  it('hashes the normalized absolute path, lowercased on Windows', () => {
    const id = getProjectId('C:\\Repos\\MyGame\\', { platform: 'win32', cwd: 'C:\\Repos' });
    assert.equal(id, `MyGame-${sha256Hex('c:\\repos\\mygame').slice(0, 8)}`);
    assert.equal(getProjectId('C:\\Repos\\mygame', { platform: 'win32', cwd: 'C:\\Repos' }).slice(-8), id.slice(-8), 'case does not matter on Windows');
  });

  it('keeps case on POSIX, where paths are case-sensitive', () => {
    const upper = getProjectId('/repos/MyGame', { platform: 'linux', cwd: '/repos' });
    const lower = getProjectId('/repos/mygame', { platform: 'linux', cwd: '/repos' });
    assert.notEqual(upper.slice(-8), lower.slice(-8));
  });

  it('resolves a relative path against the working directory', () => {
    assert.equal(getProjectId('MyGame', { platform: 'win32', cwd: 'C:\\Repos' }), getProjectId('C:\\Repos\\MyGame', { platform: 'win32', cwd: 'C:\\Other' }));
  });

  it('makes the folder name safe for a directory name', () => {
    assert.match(getProjectId('/repos/My Game (2026)!', { platform: 'linux', cwd: '/repos' }), /^My-Game-2026-[0-9a-f]{8}$/);
    assert.match(getProjectId('/repos/...', { platform: 'linux', cwd: '/repos' }), /^project-[0-9a-f]{8}$/);
  });

  it('normalizes a path without touching the drive root', () => {
    assert.equal(normalizeProjectPath('C:\\', { platform: 'win32', cwd: 'C:\\' }), 'c:\\');
    assert.equal(normalizeProjectPath('/', { platform: 'linux', cwd: '/' }), '/');
  });
});

describe('getOllamaDefaultPaths (spec 6.2)', () => {
  it('knows the Windows install and log locations', () => {
    const paths = getOllamaDefaultPaths({ ...WINDOWS, env: { LOCALAPPDATA: 'D:\\AppData\\Local' } });
    assert.equal(paths.appPath, 'D:\\AppData\\Local\\Programs\\Ollama\\ollama app.exe');
    assert.equal(paths.serverLogPath, 'D:\\AppData\\Local\\Ollama\\server.log');
  });

  it('has no defaults elsewhere, so doctor asks for --logs', () => {
    assert.deepEqual(getOllamaDefaultPaths({ ...LINUX, env: {} }), { appPath: null, serverLogPath: null });
  });
});
