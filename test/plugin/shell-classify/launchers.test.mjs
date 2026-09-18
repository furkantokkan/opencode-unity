// PowerShell's own program launcher is a wrapper like cmd's `start`: `Start-Process git -ArgumentList
// push` runs a VCS write whose program the classifier would otherwise read as `start-process` (S5,
// spec 8.7.1). The family is not trusted to be right - OpenCode may run pwsh while SHELL names bash - so
// every spelling is refused under every family, and the benign controls stay allowed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHELL_FAMILIES, WRAPPER_PROGRAMS, classifyShellCommand } from '../../../plugin/opencode-unity-lib/shell-classify.js';

const LAUNCHES = [
  'Start-Process git -ArgumentList push',
  'Start-Process -FilePath git -ArgumentList push',
  'START-PROCESS git push',
  'saps git push',
  'Start-Process.exe git',
  'Microsoft.PowerShell.Management\\Start-Process git push',
];

/** The same launch behind each family's own separator; cmd reads `;` as part of an argument. */
const SEPARATED = Object.freeze({
  posix: 'dotnet build; Start-Process git push',
  powershell: 'dotnet build; Start-Process git push',
  cmd: 'dotnet build & Start-Process git push',
});

const CONTROLS = ['dotnet build', 'git status'];

describe('program launchers (spec 8.7.1 wrappers, S5)', () => {
  it('lists Start-Process and its alias as wrappers', () => {
    assert.ok(WRAPPER_PROGRAMS.includes('start-process'));
    assert.ok(WRAPPER_PROGRAMS.includes('saps'));
  });

  it('has a separated case for every family', () => {
    assert.deepEqual(Object.keys(SEPARATED).sort(), Object.keys(SHELL_FAMILIES).sort());
  });

  for (const family of Object.keys(SHELL_FAMILIES)) {
    it(`refuses every spelling under the ${family} grammar`, () => {
      for (const command of [...LAUNCHES, SEPARATED[/** @type {keyof typeof SEPARATED} */ (family)]]) {
        const result = classifyShellCommand(command, { family, vcsKind: 'git' });
        assert.equal(result.decision, 'deny', `${family}: ${command}`);
      }
    });

    it(`still allows the ordinary commands under the ${family} grammar`, () => {
      for (const command of CONTROLS) {
        assert.equal(classifyShellCommand(command, { family, vcsKind: 'git' }).decision, 'allow', `${family}: ${command}`);
      }
    });
  }
});
