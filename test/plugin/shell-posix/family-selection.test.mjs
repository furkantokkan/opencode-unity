// Family selection (amendment 33.7, CP-S7). Which grammar reads a command string is a safety
// decision, not a formatting one: OpenCode prefers pwsh, then powershell, then bash on Windows
// (claim 146), and a bash command read with PowerShell's rules is weaker than either.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { familyForShell } from '../../../plugin/opencode-unity-lib/shell-classify.js';
import { createShellGuard, selectShellFamily } from '../../../plugin/opencode-unity-lib/shell-guard.js';

// A backslash written through an editing tool is worth spelling out once: this is one character.
const BACKSLASH = String.fromCharCode(92);

describe('the family a shell name resolves to', () => {
  it('reads a bare name, a path with either separator, and a name with an executable suffix', () => {
    assert.equal(familyForShell('bash'), 'posix');
    assert.equal(familyForShell('/bin/zsh'), 'posix');
    assert.equal(familyForShell(`C:${BACKSLASH}Windows${BACKSLASH}System32${BACKSLASH}cmd.exe`), 'cmd');
    assert.equal(familyForShell('/usr/local/bin/pwsh'), 'powershell');
    assert.equal(familyForShell('BASH.EXE'), 'posix');
  });

  it('reads a login shell, a quoted path, and a shell followed by its arguments', () => {
    // A login shell is spelled with a leading dash by convention and is the same program.
    assert.equal(familyForShell('-bash'), 'posix');
    assert.equal(familyForShell('"/bin/sh"'), 'posix');
    assert.equal(familyForShell('pwsh -NoLogo -NonInteractive'), 'powershell');
    assert.equal(familyForShell('   /bin/dash   '), 'posix');
  });

  it('reads a path that has a space in it, which is where a Windows shell usually lives', () => {
    assert.equal(familyForShell('C:/Program Files/Git/bin/bash.exe'), 'posix');
  });

  it('says nothing rather than guessing for a shell this product does not model', () => {
    for (const value of ['nu', '/usr/bin/nu', 'elvish', '', '   ', null, undefined, 42, {}]) {
      assert.equal(familyForShell(/** @type {any} */ (value)), null, JSON.stringify(value));
    }
  });
});

describe('the family the guard classifies with', () => {
  it('prefers what the caller states, then the shell, then the platform', () => {
    assert.equal(selectShellFamily({ platform: 'linux' }), 'posix');
    assert.equal(selectShellFamily({ platform: 'darwin' }), 'posix');
    assert.equal(selectShellFamily({ platform: 'win32' }), 'powershell');
    assert.equal(selectShellFamily({ platform: 'win32', shell: '/bin/bash' }), 'posix');
    assert.equal(selectShellFamily({ platform: 'linux', shell: 'pwsh' }), 'powershell');
    assert.equal(selectShellFamily({ platform: 'win32', shell: '/bin/bash', family: 'cmd' }), 'cmd');
    // An unrecognised shell falls back to the platform rather than to a guess.
    assert.equal(selectShellFamily({ platform: 'win32', shell: 'nu' }), 'powershell');
    assert.equal(selectShellFamily({ platform: 'linux', shell: null }), 'posix');
  });

  it('carries the resolved family on the guard it builds', () => {
    assert.equal(createShellGuard({ platform: 'win32' }).family, 'powershell');
    assert.equal(createShellGuard({ platform: 'win32', shell: 'bash' }).family, 'posix');
    assert.equal(createShellGuard({ platform: 'linux', shell: 'zsh' }).family, 'posix');
    assert.equal(createShellGuard({ platform: 'linux', family: 'cmd', shell: 'bash' }).family, 'cmd');
  });

  it('is what keeps a bash command on Windows from being read with the wrong rules', () => {
    // `g\it push` is a path to `it` under PowerShell and the word `git` under bash, so the family
    // decides whether this reaches the shell as a version control write nobody classified.
    const command = `g${BACKSLASH}it push`;
    const powershell = createShellGuard({ platform: 'win32', vcsKind: 'git' });
    assert.equal(powershell.classify(command).decision, 'allow');

    const gitBash = createShellGuard({ platform: 'win32', vcsKind: 'git', shell: 'C:/Program Files/Git/bin/bash.exe' });
    assert.equal(gitBash.family, 'posix');
    const result = gitBash.classify(command);
    assert.equal(result.decision, 'deny');
    assert.equal(result.code, 'shell_unmodelled');
  });

  it('classifies with the resolved family end to end, message included', () => {
    const guard = createShellGuard({ platform: 'linux', shell: '/bin/zsh', vcsKind: 'git' });
    assert.equal(guard.check({ command: 'dotnet build Game.csproj' }).decision, 'allow');
    assert.throws(() => guard.check({ command: '=git push' }), /opencode-unity shell guard:/);
  });
});
