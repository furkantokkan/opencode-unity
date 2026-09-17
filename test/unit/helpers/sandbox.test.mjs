import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runProcess } from '../../helpers/run-cli.mjs';
import { CLOSED_PORT_URL, SANDBOX_PARENT, assertSafeEnv, buildSandboxEnv, createSandbox, useSandbox } from '../../helpers/sandbox.mjs';

describe('sandbox', () => {
  it('creates every home directory inside its root and removes it on cleanup', async () => {
    const sandbox = await createSandbox('layout test');
    assert.ok(sandbox.root.startsWith(SANDBOX_PARENT));
    for (const dir of Object.values(sandbox.dirs)) {
      assert.ok(dir.startsWith(sandbox.root), dir);
      assert.ok(fs.statSync(dir).isDirectory(), dir);
    }
    assert.ok(sandbox.productHome.startsWith(sandbox.root));
    assert.equal(sandbox.path('a', 'b'), path.join(sandbox.root, 'a', 'b'));
    await sandbox.cleanup();
    assert.equal(fs.existsSync(sandbox.root), false);
  });

  it('points every home and backend variable into the sandbox or at a closed port', async (t) => {
    const sandbox = await useSandbox(t, 'env');
    const { env, dirs } = sandbox;
    assert.equal(env.HOME, dirs.home);
    assert.equal(env.USERPROFILE, dirs.home);
    assert.equal(env.LOCALAPPDATA, dirs.localAppData);
    assert.equal(env.APPDATA, dirs.appData);
    assert.equal(env.XDG_CONFIG_HOME, dirs.xdgConfig);
    assert.equal(env.XDG_DATA_HOME, dirs.xdgData);
    assert.equal(env.XDG_CACHE_HOME, dirs.xdgCache);
    assert.equal(env.XDG_STATE_HOME, dirs.xdgState);
    assert.equal(env.OLLAMA_HOST, CLOSED_PORT_URL);
    assert.equal(env.npm_config_registry, CLOSED_PORT_URL);
    assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
  });

  it('drops parent variables outside the allow-list', () => {
    const dirs = /** @type {any} */ ({ home: 'h', localAppData: 'l', appData: 'a', xdgConfig: 'c', xdgData: 'd', xdgCache: 'k', xdgState: 's', tmp: 't', npmCache: 'n' });
    const env = buildSandboxEnv(dirs, {
      Path: '/bin',
      SystemRoot: 'C:\\Windows',
      OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_PERMISSION: '{}',
      ANTHROPIC_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      XDG_CONFIG_HOME: '/real/config',
    });
    assert.equal(env.Path, '/bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    for (const name of ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
      assert.equal(name in env, false, name);
    }
    assert.equal(env.OLLAMA_HOST, CLOSED_PORT_URL);
    assert.equal(env.XDG_CONFIG_HOME, 'c');
  });

  it('refuses environments that reach the real Ollama or Unity MCP hub ports', async () => {
    assert.throws(() => assertSafeEnv({ OLLAMA_HOST: 'http://127.0.0.1:11434' }), /OLLAMA_HOST/);
    assert.throws(() => assertSafeEnv({ HUB: 'http://localhost:8081/mcp' }), /HUB/);
    assert.doesNotThrow(() => assertSafeEnv({ MOCK: 'http://127.0.0.1:18081', OTHER: 'http://127.0.0.1:114340' }));
    await assert.rejects(runProcess(process.execPath, ['-e', ''], { env: { OLLAMA_HOST: '127.0.0.1:11434' } }), /real service port/);
  });

  it('runs a child with exactly the sandbox environment', async (t) => {
    const sandbox = await useSandbox(t, 'child');
    const script = 'process.stdout.write(JSON.stringify({ home: require("os").homedir(), leak: process.env.OPENCODE_UNITY_SANDBOX_LEAK ?? null }))';
    process.env.OPENCODE_UNITY_SANDBOX_LEAK = 'leaked';
    t.after(() => {
      delete process.env.OPENCODE_UNITY_SANDBOX_LEAK;
    });
    const result = await runProcess(process.execPath, ['-e', script], { env: sandbox.env, cwd: sandbox.root });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { home: sandbox.dirs.home, leak: null });
  });

  it('passes input to the child and times out hung processes', async (t) => {
    const sandbox = await useSandbox(t, 'input');
    const echo = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { env: sandbox.env, input: 'yes\n' });
    assert.equal(echo.stdout, 'yes\n');
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: sandbox.env, timeoutMs: 300 }),
      /timed out after 300 ms/,
    );
  });
});
