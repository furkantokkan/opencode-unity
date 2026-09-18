import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catchError } from '../../helpers/catch-error.mjs';
import { ORIGINAL_XDG_ENV, UNSET_MARKER } from '../../../plugin/opencode-unity-lib/shell-env.js';
import { BASH_TIMEOUT_MS, buildLaunchEnv, describeLaunchEnv, isCredentialName, KEPT_OPENCODE_VARIABLES } from '../../../src/opencode/launch-env.js';
import { BINARY_ENV_NAME, findOpencode, isShim, listNpmPrefixes, parseVersion, readOpencodeVersion, requireOpencode, resolvePackageExecutable } from '../../../src/opencode/locate.js';

const base = {
  home: '/opt/product-home',
  profileDir: '/opt/product-home/profile/0.1.0',
  xdgConfigDir: '/opt/product-home/xdg-config',
  projectId: 'sample-1a2b3c4d',
};

describe('opencode/launch-env', () => {
  it('sets every variable of spec 8.1', () => {
    const result = buildLaunchEnv({ ...base, env: { PATH: '/usr/bin', XDG_CONFIG_HOME: '/user/.config' }, configContent: '{"a":1}' });
    assert.equal(result.env.PATH, '/usr/bin');
    assert.equal(result.env.XDG_CONFIG_HOME, base.xdgConfigDir);
    assert.equal(result.env.OPENCODE_CONFIG_DIR, base.profileDir);
    assert.equal(result.env.OPENCODE_CONFIG_CONTENT, '{"a":1}');
    assert.equal(result.env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
    assert.equal(result.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
    assert.equal(result.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(result.env.OPENCODE_DISABLE_MODELS_FETCH, '1');
    assert.equal(result.env.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
    assert.equal(result.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS, String(BASH_TIMEOUT_MS));
    assert.equal(result.env.OPENCODE_UNITY_HOME, base.home);
    assert.equal(result.env.OPENCODE_UNITY_PROJECT, base.projectId);
    assert.equal(result.env[ORIGINAL_XDG_ENV], '/user/.config');
    assert.equal(result.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
  });

  it('records an unset XDG_CONFIG_HOME with the marker the plugin restores from', () => {
    const result = buildLaunchEnv({ ...base, env: {} });
    assert.equal(result.env[ORIGINAL_XDG_ENV], UNSET_MARKER);
  });

  it('keeps only the four user-interface OPENCODE_ variables', () => {
    const env = { OPENCODE_DISABLE_MOUSE: '1', OPENCODE_GIT_BASH_PATH: '/bash', OPENCODE_THEME: 'dark', OPENCODE_CONFIG_CONTENT: '{}' };
    const result = buildLaunchEnv({ ...base, env });
    assert.equal(result.env.OPENCODE_DISABLE_MOUSE, '1');
    assert.equal(result.env.OPENCODE_GIT_BASH_PATH, '/bash');
    assert.deepEqual(result.removedOpencode, ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_THEME']);
    assert.equal(KEPT_OPENCODE_VARIABLES.length, 4);
  });

  it('warns about exactly the four inherited variables that would change the rules', () => {
    const env = { OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_PERMISSION: '{}', OPENCODE_PURE: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_THEME: 'dark' };
    const result = buildLaunchEnv({ ...base, env });
    assert.equal(result.warnings.length, 4);
    assert.equal(result.warnings.some((warning) => warning.includes('OPENCODE_THEME')), false);
    for (const warning of result.warnings) assert.match(warning, /would have changed the rules/);
  });

  it('drops cloud credentials and never prints their values', () => {
    const env = {
      OPENAI_API_KEY: 'sk-secret',
      SOME_AUTH_TOKEN: 'secret',
      OTHER_ACCESS_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AZURE_OPENAI_ENDPOINT: 'https://example.invalid',
      GOOGLE_APPLICATION_CREDENTIALS: '/key.json',
      HF_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      OPENCODE_CONSOLE_TOKEN: 'secret',
      KEEP_ME: 'visible',
    };
    const result = buildLaunchEnv({ ...base, env });
    assert.equal(result.env.KEEP_ME, 'visible');
    assert.equal(result.removedCredentials.length, 10);
    for (const name of result.removedCredentials) assert.equal(result.env[name], undefined);
    assert.equal(JSON.stringify(describeLaunchEnv(result)).includes('secret'), false);
    assert.match(result.warnings.at(-1) ?? '', /10 credential, backend or proxy variable/);
  });

  it('also drops the never-forwarded names of amendment 12.12.4, lower-case proxy spellings included', () => {
    const env = {
      FIREBASE_TOKEN: 'secret',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
      NPM_TOKEN: 'secret',
      DEPLOY_SECRET: 'secret',
      https_proxy: 'http://proxy.example.invalid:3128',
      NO_PROXY: 'localhost',
      PARALLEL_API_KEY: 'secret',
      KEEP_ME: 'visible',
    };
    const result = buildLaunchEnv({ ...base, env });
    assert.deepEqual(Object.keys(result.env).filter((name) => name in env), ['KEEP_ME']);
    assert.equal(result.removedCredentials.length, 8);
    assert.equal(JSON.stringify(describeLaunchEnv(result)).includes('secret'), false);
  });

  it('matches credential names case-insensitively through the upper-cased form', () => {
    const result = buildLaunchEnv({ ...base, env: { openai_api_key: 'sk', Aws_Region: 'eu' } });
    assert.deepEqual(result.removedCredentials, ['Aws_Region', 'openai_api_key']);
    assert.equal(isCredentialName('MY_API_KEY'), true);
    assert.equal(isCredentialName('MY_API_KEY_SUFFIX'), false);
  });

  it('sets OPENCODE_DISABLE_PROJECT_CONFIG only when asked', () => {
    const result = buildLaunchEnv({ ...base, env: {}, disableProjectConfig: true });
    assert.equal(result.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.equal(describeLaunchEnv(result).set.some(([name]) => name === 'OPENCODE_DISABLE_PROJECT_CONFIG'), true);
  });

  it('skips a variable whose value is undefined', () => {
    const result = buildLaunchEnv({ ...base, env: { GONE: undefined, KEPT: 'yes' } });
    assert.equal('GONE' in result.env, false);
    assert.equal(result.env.KEPT, 'yes');
  });

  it('refuses to build without the paths it isolates with', () => {
    for (const missing of ['home', 'profileDir', 'xdgConfigDir', 'projectId']) {
      assert.throws(() => buildLaunchEnv({ ...base, [missing]: '', env: {} }), new RegExp(missing));
    }
  });
});

describe('opencode/locate', () => {
  const manifest = JSON.stringify({ bin: { opencode: './bin/opencode.exe' } });
  // PATHEXT entries are upper case, and Windows file names are case-insensitive; the double compares the
  // way the platform does rather than the way the string happens to be spelled.
  const matches = (/** @type {string} */ candidate, /** @type {string} */ expected) => candidate.toLowerCase() === expected.toLowerCase();

  it('uses an executable found on PATH as it is', () => {
    const found = findOpencode({
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      isFile: (candidate) => candidate === '/usr/bin/opencode',
    });
    assert.deepEqual(found, { file: '/usr/bin/opencode', shim: null, source: 'path', notes: [] });
  });

  it('resolves the real executable behind a Windows batch shim', () => {
    const prefix = 'C:\\npm';
    const real = 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
    const found = findOpencode({
      env: { PATH: prefix, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isFile: (candidate) => matches(candidate, 'C:\\npm\\opencode.cmd') || candidate === real,
      readText: () => manifest,
    });
    assert.equal(found?.file, real);
    assert.equal(found?.shim, 'C:\\npm\\opencode.CMD');
    assert.match(found?.notes[0] ?? '', /batch shim/);
    assert.equal(isShim(real), false);
    assert.equal(isShim('C:\\npm\\opencode.cmd'), true);
  });

  it('resolves bin/opencode the way a shell would when the package manifest cannot be read', () => {
    const real = 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
    const found = findOpencode({
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isFile: (candidate) => matches(candidate, 'C:\\npm\\opencode.cmd') || matches(candidate, real),
      readText: () => null,
    });
    assert.equal(matches(found?.file ?? '', real), true);
    assert.equal(isShim(found?.file ?? ''), false);
    assert.equal(resolvePackageExecutable('/prefix', { platform: 'linux', isFile: () => true, readText: () => 'not json' }), '/prefix/node_modules/opencode-ai/bin/opencode');
  });

  it('never returns a shim the package itself declares', () => {
    const resolved = resolvePackageExecutable('C:\\npm', {
      platform: 'win32',
      isFile: (candidate) => candidate.endsWith('.cmd'),
      readText: () => JSON.stringify({ bin: { opencode: './bin/opencode.cmd' } }),
    });
    assert.equal(resolved, null);
  });

  it('refuses a shim whose package is incomplete instead of spawning it', () => {
    const error = catchError(() => findOpencode({
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isFile: (candidate) => matches(candidate, 'C:\\npm\\opencode.cmd'),
      readText: () => null,
    }));
    assert.equal(error.code, 'opencode_shim_unresolved');
    assert.match(error.hint, /npm i -g opencode-ai/);
  });

  it('searches the npm prefixes when nothing is on PATH, and reports a missing install', () => {
    const real = 'D:\\profile-data\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
    const found = findOpencode({
      env: { PATH: '', APPDATA: 'D:\\profile-data\\Roaming' },
      platform: 'win32',
      isFile: (candidate) => candidate === real,
      readText: () => manifest,
    });
    assert.equal(found?.file, real);
    assert.equal(found?.source, 'npm-prefix');

    assert.equal(findOpencode({ env: { PATH: '' }, platform: 'linux', isFile: () => false }), null);
    const error = catchError(() => requireOpencode({ env: { PATH: '' }, platform: 'linux', isFile: () => false }));
    assert.equal(error.code, 'opencode_missing');
  });

  it('prefers the test override over PATH', () => {
    const found = findOpencode({
      env: { PATH: '/usr/bin', [BINARY_ENV_NAME]: '/cache/opencode' },
      platform: 'linux',
      isFile: (candidate) => candidate === '/cache/opencode' || candidate === '/usr/bin/opencode',
    });
    assert.equal(found?.file, '/cache/opencode');
  });

  it('lists the npm prefixes each platform uses', () => {
    assert.deepEqual(listNpmPrefixes({ env: { npm_config_prefix: '/opt/npm' }, platform: 'linux', homedir: '/opt/user-home' }), ['/opt/npm', '/opt/user-home/.npm-global', '/usr/local', '/usr']);
    assert.deepEqual(listNpmPrefixes({ env: {}, platform: 'win32', homedir: 'C:\\u' }), ['C:\\u\\AppData\\Roaming\\npm']);
    assert.deepEqual(listNpmPrefixes({ env: {}, platform: 'linux', homedir: '' }), []);
  });

  it('reads a version, and says why when it cannot', async () => {
    const ok = await readOpencodeVersion('/bin/opencode', { run: async () => /** @type {any} */ ({ exitCode: 0, stdout: 'opencode 1.18.31\n', stderr: '', error: null, timedOut: false }) });
    assert.deepEqual(ok, { version: '1.18.31', error: null });

    const spawnFailed = await readOpencodeVersion('/bin/opencode', { run: async () => /** @type {any} */ ({ error: new Error('ENOENT'), stdout: '', stderr: '', exitCode: null, timedOut: false }) });
    assert.equal(spawnFailed.version, null);
    assert.match(spawnFailed.error ?? '', /ENOENT/);

    const timedOut = await readOpencodeVersion('/bin/opencode', { timeoutMs: 5000, run: async () => /** @type {any} */ ({ error: null, timedOut: true, stdout: '', stderr: '', exitCode: null }) });
    assert.match(timedOut.error ?? '', /within 5 s/);

    const nonZero = await readOpencodeVersion('/bin/opencode', { run: async () => /** @type {any} */ ({ error: null, timedOut: false, exitCode: 3, stdout: '', stderr: '' }) });
    assert.match(nonZero.error ?? '', /exited 3/);

    const garbage = await readOpencodeVersion('/bin/opencode', { run: async () => /** @type {any} */ ({ error: null, timedOut: false, exitCode: 0, stdout: 'hello', stderr: '' }) });
    assert.match(garbage.error ?? '', /Could not read a version from 'hello'/);

    assert.equal(parseVersion('v1.2.3-beta.1 (build)'), '1.2.3-beta.1');
    assert.equal(parseVersion('no numbers'), null);
  });
});
