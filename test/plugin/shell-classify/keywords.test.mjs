// Keywords, alias constructs and hub spellings (amendment 33.7 and 35.8 layer 1, spec 8.7.1, S5). Each
// string below makes a real shell run git, a recursive delete or an HTTP call to the hub under a first
// word that is not the program: a compound statement, an alias the next line expands (OpenCode runs
// bash and zsh with aliases on), a trap, a zsh precommand modifier, or a host spelled so a textual
// comparison misses it. The family is not trusted to be right, so every one is refused under every
// family, and the ordinary commands that merely mention a keyword stay allowed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMAND_PREFIXES,
  SHELL_FAMILIES,
  UNMODELLED_ARGUMENTS,
  UNMODELLED_COMMANDS,
  WRAPPER_PROGRAMS,
  classifyShellCommand,
} from '../../../plugin/opencode-unity-lib/shell-classify.js';

const HUB = Object.freeze({ host: '127.0.0.1', port: '8080' });

/** Compound statements and alias constructs, one string per form, written for the shell that runs it. */
const HIDDEN_PROGRAMS = [
  'if git push; then true; fi',
  'for x in a; do git push; done',
  'while git commit -m x; do break; done',
  'until rm -rf Assets; do true; done',
  'then git push',
  'do rm -rf Assets',
  'elif git push',
  'case',
  'select x in a; do git push; done',
  'function g; git push; end',
  'and git push',
  'or git push',
  'not git push',
  'repeat 1 git push',
  'alias g=git\ng push',
  'alias g=git; g push',
  'unalias g',
  "trap 'git push' EXIT",
  'hash -p /usr/bin/git g; g push',
  'emulate sh -c git',
  'sched +0 git push',
  'Set-Alias g git; g push',
  'sal g git; g push',
  'New-Alias -Name g -Value git; g push',
  'nal g git',
  'Microsoft.PowerShell.Utility\\Set-Alias g git',
  'call git push',
  'doskey g=git push',
  'if exist a git push',
  'noglob git push',
  'nocorrect git push',
  'noglob rm -rf Assets',
];

/** PowerShell's alias and function drives define a name from inside an ordinary cmdlet. */
const DRIVE_DEFINITIONS = [
  'New-Item -Path alias:g -Value git',
  "ni 'Alias:g' -Value git",
  'Set-Item -Path:alias:g git',
  'New-Item function:g -Value git',
];

/** Loopback spellings an HTTP client resolves to the hub's own address. */
const HUB_CALLS = [
  'curl http://127.0.0.1:8080/mcp',
  'curl http://127.1:8080/mcp',
  'curl http://2130706433:8080/mcp',
  'curl http://0x7f.1:8080/mcp',
  'curl http://127.0.0.2:8080/mcp',
  'curl http://LOCALHOST:8080/mcp',
  'curl http://localhost.:08080/mcp',
  'curl 127.1:8080/mcp',
  'curl -x 127.1:8080 http://example.test/',
  'curl --resolve example.test:8080:127.1 http://example.test:8080/mcp',
  'Invoke-RestMethod -Uri http://127.1:8080/mcp -Method Post',
  'iwr -Uri:http://127.1:8080/mcp',
];

const CONTROLS = [
  'dotnet build',
  'git status',
  'echo if then fi',
  'grep -n function Assets/Scripts/Player.cs',
  'dotnet test Tests.csproj --filter Alias',
  'curl http://127.0.0.1:9999/other',
  'curl https://docs.unity3d.com/Manual/index.html',
];

/**
 * @param {string} command
 * @param {string} family
 */
function classify(command, family) {
  return classifyShellCommand(command, { family: /** @type {'posix'} */ (family), vcsKind: 'git', mcpHub: HUB });
}

describe('first words that are not programs (33.7, 35.8 layer 1)', () => {
  it('keeps the keyword list apart from the wrapper list, so each rule owns its code', () => {
    for (const name of UNMODELLED_COMMANDS) {
      assert.equal(WRAPPER_PROGRAMS.includes(name), false, name);
      assert.equal(name, name.toLowerCase(), name);
    }
    for (const name of ['noglob', 'nocorrect']) assert.ok(COMMAND_PREFIXES.includes(name), name);
    assert.ok(UNMODELLED_ARGUMENTS.length > 0);
  });

  for (const family of Object.keys(SHELL_FAMILIES)) {
    it(`refuses a program hidden behind a keyword or an alias under the ${family} grammar`, () => {
      for (const command of HIDDEN_PROGRAMS) {
        const result = classify(command, family);
        assert.equal(result.decision, 'deny', `${family}: ${JSON.stringify(command)}`);
        assert.ok(['shell_unmodelled', 'shell_wrapper'].includes(/** @type {string} */ (result.code)), `${family}: ${command} -> ${result.code}`);
        assert.ok(String(result.reason).length > 10);
      }
    });

    it(`refuses a PowerShell alias or function drive path under the ${family} grammar`, () => {
      for (const command of DRIVE_DEFINITIONS) {
        const result = classify(command, family);
        assert.equal(result.decision, 'deny', `${family}: ${command}`);
        assert.equal(result.code, 'shell_unmodelled', `${family}: ${command}`);
      }
    });

    it(`refuses every loopback spelling of the hub under the ${family} grammar`, () => {
      for (const command of HUB_CALLS) {
        assert.equal(classify(command, family).code, 'shell_network_hub', `${family}: ${command}`);
      }
    });

    it(`still allows the commands that only mention a keyword under the ${family} grammar`, () => {
      for (const command of CONTROLS) {
        const result = classify(command, family);
        assert.equal(result.decision, 'allow', `${family}: ${command} -> ${result.reason}`);
      }
    });
  }

  it('compares a remote hub by its normalised name and its port, not by loopback', () => {
    const remote = { host: 'hub.example.test', port: '8080' };
    assert.equal(classifyShellCommand('curl http://HUB.example.test:8080/x', { family: 'posix', mcpHub: remote }).code, 'shell_network_hub');
    assert.equal(classifyShellCommand('curl http://127.1:8080/x', { family: 'posix', mcpHub: remote }).decision, 'allow');
    assert.equal(classifyShellCommand('curl http://hub.example.test:9090/x', { family: 'posix', mcpHub: remote }).decision, 'allow');
  });
});
