// The shell guard the plugin installs on tool.execute.before (spec 8.7.1). What it adds on top of the
// classifier is the per-project state and the Error OpenCode hands back to the model.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROTECTED_EDIT_GLOBS,
  SHELL_GUARD_PREFIX,
  SHELL_TOOL_IDS,
  createShellGuard,
  createShellGuardError,
  isShellTool,
  parseHubEndpoint,
} from '../../../plugin/opencode-unity-lib/shell-guard.js';
import { catchError } from '../../helpers/catch-error.mjs';

describe('shell guard', () => {
  it('picks the family from the platform', () => {
    assert.equal(createShellGuard({ platform: 'win32' }).family, 'powershell');
    assert.equal(createShellGuard({ platform: 'linux' }).family, 'posix');
    assert.equal(createShellGuard({ platform: 'win32', family: 'posix' }).family, 'posix');
  });

  it('throws a readable Error for a blocked command and returns the classification for an allowed one', () => {
    const guard = createShellGuard({ platform: 'linux', vcsKind: 'git' });
    assert.equal(guard.check({ command: 'dotnet build Game.csproj' }).decision, 'allow');
    const error = catchError(() => guard.check({ command: 'git push origin main' }));
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith(SHELL_GUARD_PREFIX));
    assert.match(error.message, /version control/);
    assert.match(error.message, /Ask the human/);
  });

  it('never repeats the command in the message, because the command is model output', () => {
    const guard = createShellGuard({ platform: 'linux' });
    const error = catchError(() => guard.check({ command: 'rm -rf Assets/Secret' }));
    assert.ok(!error.message.includes('Assets/Secret'));
  });

  it('treats a missing or wrongly typed command as empty, and refuses it', () => {
    const guard = createShellGuard({ platform: 'linux' });
    for (const args of [undefined, null, {}, { command: 42 }]) {
      const error = catchError(() => guard.check(args));
      assert.match(error.message, /empty/);
    }
  });

  it('blocks the protected Unity files by default and adds the ones the profile names', () => {
    const guard = createShellGuard({ platform: 'linux', extraProtectedEditGlobs: ['*Art/Source/*'] });
    assert.equal(guard.classify('echo x > Assets/Scenes/Main.unity').code, 'shell_protected_write');
    assert.equal(guard.classify('echo x > Art/Source/hero.psd').code, 'shell_protected_write');
    assert.equal(guard.classify('echo x > notes.md').decision, 'allow');
  });

  it('carries every non-negotiable edit tuple of spec 8.5.4 in its glob list', () => {
    const guard = createShellGuard({ platform: 'linux' });
    const tuples = [
      'Assets/Scenes/Main.unity',
      'Assets/UI/Menu.prefab',
      'Assets/Data/Config.asset',
      'Assets/X.cs.meta',
      'ProjectSettings/ProjectSettings.asset',
      'Packages/manifest.json',
      'Assembly-CSharp.csproj',
      'Assets/Game/Game.asmdef',
    ];
    for (const file of tuples) {
      assert.equal(guard.classify(`echo x > ${file}`).code, 'shell_protected_write', file);
    }
    assert.ok(PROTECTED_EDIT_GLOBS.includes('*.unity'));
  });

  it('blocks HTTP clients aimed at the hub the project recorded', () => {
    const guard = createShellGuard({ platform: 'linux', mcpHubUrl: 'http://127.0.0.1:8080/mcp' });
    assert.equal(guard.classify('curl http://127.0.0.1:8080/mcp').code, 'shell_network_hub');
    assert.equal(createShellGuard({ platform: 'linux' }).classify('curl http://127.0.0.1:8080/mcp').decision, 'allow');
  });

  it('reads an endpoint out of a hub URL and shrugs at anything else', () => {
    assert.deepEqual(parseHubEndpoint('http://127.0.0.1:8080/mcp'), { host: '127.0.0.1', port: '8080' });
    assert.deepEqual(parseHubEndpoint('https://hub.example/mcp'), { host: 'hub.example', port: '443' });
    assert.deepEqual(parseHubEndpoint('http://hub.example/mcp'), { host: 'hub.example', port: '80' });
    assert.deepEqual(parseHubEndpoint('http://[::1]:8080/mcp'), { host: '::1', port: '8080' });
    for (const value of [null, '', '   ', 'not a url']) assert.equal(parseHubEndpoint(value), null);
  });

  it('knows which tool ids run a shell command', () => {
    assert.ok(isShellTool('bash'));
    assert.ok(!isShellTool('read'));
    assert.ok(!isShellTool('unityMCP_read_console'));
    assert.ok(SHELL_TOOL_IDS.includes('bash'));
  });

  it('gives a next step for every deny code', () => {
    const codes = ['shell_unmodelled', 'shell_no_command_node', 'shell_unparsable', 'shell_wrapper', 'shell_vcs_write', 'shell_recursive_delete', 'shell_protected_write', 'shell_network_hub', 'shell_blocked_command', null];
    for (const code of codes) {
      const error = createShellGuardError({ decision: 'deny', family: 'posix', code, reason: null, commands: [] });
      assert.match(error.message, /[.]$/);
      assert.ok(error.message.length > SHELL_GUARD_PREFIX.length + 10, String(code));
    }
  });
});
