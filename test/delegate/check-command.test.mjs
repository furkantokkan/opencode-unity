// The check command that runs after an apply (spec 12.3). A host agent can hold a standing approval for
// `delegate ...`, so anything this accepts is a command that runs without another human look.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { resolveAutoCheck, runCheckCommands, validateCheckCommand } from '../../src/delegate/check-command.js';
import { getCompileCommand } from '../../src/facts/compile-map.js';
import { catchError } from '../helpers/catch-error.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const PREFIXES = ['dotnet build ', 'dotnet test '];

/**
 * @param {string} command
 * @returns {any}
 */
function refusal(command) {
  return catchError(() => validateCheckCommand(command, PREFIXES));
}

describe('validateCheckCommand', () => {
  it('accepts an allowed command and splits it into argv without a shell', () => {
    const check = validateCheckCommand('dotnet build Assembly-CSharp.csproj -nologo', PREFIXES);
    assert.equal(check.file, 'dotnet');
    assert.deepEqual(check.args, ['build', 'Assembly-CSharp.csproj', '-nologo']);
  });

  it('removes double quotes and keeps what they grouped together', () => {
    const check = validateCheckCommand('dotnet build "My Game.csproj" "-clp:ErrorsOnly;NoSummary"', PREFIXES);
    assert.deepEqual(check.args, ['build', 'My Game.csproj', '-clp:ErrorsOnly;NoSummary']);
  });

  it('accepts the exact prefix with nothing after it', () => {
    assert.equal(validateCheckCommand('dotnet test', ['dotnet test ']).file, 'dotnet');
  });

  it('refuses a command that does not start with an allowed prefix', () => {
    const error = refusal('npm run build');
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /does not start with an allowed prefix/);
    assert.match(error.message, /'dotnet build', 'dotnet test'/);
  });

  it('refuses a prefix that only looks like one', () => {
    assert.match(refusal('dotnet buildx Foo.csproj').message, /allowed prefix/);
  });

  it('refuses the shell operators that would make it two commands', () => {
    for (const command of [
      'dotnet build a.csproj && rm -rf /',
      'dotnet build a.csproj | tee out.txt',
      'dotnet build a.csproj ; echo done',
      'dotnet build a.csproj > out.txt',
      'dotnet build a.csproj < in.txt',
      'dotnet build (a).csproj',
    ]) {
      assert.match(refusal(command).message, /shell operator/, command);
    }
  });

  it('refuses a substitution and a line break wherever they appear', () => {
    assert.match(refusal('dotnet build `whoami`.csproj').message, /contains "`"/);
    assert.match(refusal('dotnet build $(whoami).csproj').message, /contains "\$\("/);
    assert.match(refusal('dotnet build a.csproj\nrm -rf /').message, /contains/);
  });

  it('allows an operator inside double quotes, because there is no shell to read it', () => {
    assert.deepEqual(validateCheckCommand('dotnet build "a;b.csproj"', PREFIXES).args, ['build', 'a;b.csproj']);
  });

  it('refuses unbalanced quotes', () => {
    assert.match(refusal('dotnet build "a.csproj').message, /double quotes are not balanced/);
  });

  it('refuses MSBuild switches that can run code during the build', () => {
    for (const command of [
      'dotnet build a.csproj -p:PreBuildEvent=calc.exe',
      'dotnet build a.csproj /property:X=1',
      'dotnet build a.csproj -l:MyLogger,my.dll',
      'dotnet build a.csproj -logger:My,my.dll',
      'dotnet build a.csproj -dl:Central,my.dll',
    ]) {
      assert.match(refusal(command).message, /can run commands or load code/, command);
    }
  });

  it('keeps the console-logger switch the compile map itself uses', () => {
    assert.doesNotThrow(() => validateCheckCommand(getCompileCommand('Assembly-CSharp.csproj'), PREFIXES));
  });

  it('refuses an empty command', () => {
    assert.match(refusal('   ').message, /is empty/);
  });
});

describe('resolveAutoCheck', () => {
  const compileMap = [
    { prefix: 'Assets/Game/Editor/', assembly: 'Game.Editor', csproj: 'Game.Editor.csproj', command: getCompileCommand('Game.Editor.csproj'), source: 'asmdef', generated: true },
    { prefix: 'Assets/Game/', assembly: 'Game', csproj: 'Game.csproj', command: getCompileCommand('Game.csproj'), source: 'asmdef', generated: true },
    { prefix: 'Assets/', assembly: 'Assembly-CSharp', csproj: 'Assembly-CSharp.csproj', command: getCompileCommand('Assembly-CSharp.csproj'), source: 'default', generated: true },
  ];
  const root = process.platform === 'win32' ? 'C:\\project' : '/project';

  it('picks the longest matching prefix, once per csproj', () => {
    const checks = resolveAutoCheck({
      changedPaths: ['Assets/Game/Player.cs', 'Assets/Game/Enemy.cs', 'Assets/Game/Editor/Tool.cs'],
      compileMap,
      cwd: root,
      projectRoot: root,
      prefixes: PREFIXES,
    });
    assert.deepEqual(checks.map((check) => check.args[1]), ['Game.csproj', 'Game.Editor.csproj']);
  });

  it('refuses when the project facts are missing', () => {
    const error = catchError(() => resolveAutoCheck({ changedPaths: ['Assets/a.cs'], compileMap: [], cwd: root, projectRoot: root, prefixes: PREFIXES }));
    assert.match(error.message, /needs the project facts/);
  });

  it('refuses when no changed file maps to a compile command', () => {
    const error = catchError(() =>
      resolveAutoCheck({ changedPaths: ['notes.md'], compileMap: compileMap.slice(0, 2), cwd: root, projectRoot: root, prefixes: PREFIXES }));
    assert.match(error.message, /found no compile command for notes\.md/);
  });
});

describe('runCheckCommands', () => {
  it('reports success and the output of a command that passes', async (t) => {
    const sandbox = await useSandbox(t, 'check-pass');
    await fs.writeFile(path.join(sandbox.root, 'ok.mjs'), "process.stdout.write('build ok\\n');\n", 'utf8');
    const [result] = await runCheckCommands([{ text: 'node ok.mjs', file: process.execPath, args: ['ok.mjs'] }], {
      cwd: sandbox.root,
      timeoutMs: 30_000,
      env: sandbox.env,
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /build ok/);
  });

  it('stops at the first failure and keeps its output', async (t) => {
    const sandbox = await useSandbox(t, 'check-fail');
    await fs.writeFile(path.join(sandbox.root, 'fail.mjs'), "process.stderr.write('CS0103: missing symbol\\n');\nprocess.exit(1);\n", 'utf8');
    await fs.writeFile(path.join(sandbox.root, 'never.mjs'), "process.stdout.write('should not run\\n');\n", 'utf8');
    const results = await runCheckCommands(
      [
        { text: 'node fail.mjs', file: process.execPath, args: ['fail.mjs'] },
        { text: 'node never.mjs', file: process.execPath, args: ['never.mjs'] },
      ],
      { cwd: sandbox.root, timeoutMs: 30_000, env: sandbox.env },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].output, /CS0103/);
  });

  it('reports a command that cannot be started at all', async (t) => {
    const sandbox = await useSandbox(t, 'check-missing');
    const [result] = await runCheckCommands([{ text: 'nope', file: path.join(sandbox.root, 'not-here'), args: [] }], {
      cwd: sandbox.root,
      timeoutMs: 10_000,
      env: sandbox.env,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /could not start/);
  });
});
