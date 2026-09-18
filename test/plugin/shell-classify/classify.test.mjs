// The shell classifier (spec 8.7.1, amendment 33.7 and 35.8). The rule under test is the one the
// amendment inverted: deny-unmodelled is the primary rule on every family, powershell and cmd
// included, because on Windows this classifier is the only boundary the permission layer cannot reach.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCKED_TEXT,
  SHELL_FAMILIES,
  WRAPPER_PROGRAMS,
  classifyShellCommand,
  getDefaultFamily,
  matchesGlob,
  normalizeProgram,
  parseShellCommand,
} from '../../../plugin/opencode-unity-lib/shell-classify.js';

const PROTECTED = ['*.unity', '*.prefab', '*.csproj', '*Library/*', '*ProjectSettings/*'];

/**
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 */
function classify(command, options = {}) {
  return classifyShellCommand(command, { family: 'posix', vcsKind: 'git', protectedWriteGlobs: PROTECTED, mcpHub: { host: '127.0.0.1', port: '8080' }, ...options });
}

describe('shell classifier: what it allows', () => {
  it('allows the build command the code agent lives on', () => {
    for (const family of ['posix', 'powershell', 'cmd']) {
      const result = classify('dotnet build Assembly-CSharp.csproj', { family });
      assert.equal(result.decision, 'allow', `${family}: ${result.reason}`);
      assert.equal(result.commands.length, 1);
      assert.equal(result.commands[0].program, 'dotnet');
    }
  });

  it('allows the read-only subcommands of the version control the project actually uses', () => {
    for (const subcommand of ['status', 'diff', 'log', 'show', 'blame']) {
      assert.equal(classify(`git ${subcommand} --oneline`).decision, 'allow');
    }
    assert.equal(classify('cm status', { vcsKind: 'plastic' }).decision, 'allow');
    assert.equal(classify('hg log', { vcsKind: 'hg' }).decision, 'allow');
  });

  it('allows a pipeline of allowed commands and reports every node', () => {
    const result = classify('dotnet build Game.csproj | sort');
    assert.equal(result.decision, 'allow');
    assert.deepEqual(result.commands.map((node) => node.program), ['dotnet', 'sort']);
  });

  it('keeps quoted arguments whole', () => {
    const result = classify('dotnet build "My Game.csproj"');
    assert.deepEqual(result.commands[0].args, ['build', 'My Game.csproj']);
  });

  it('reads the quote escape of each family', () => {
    // A doubled quote escapes itself on the Windows families; posix escapes with a backslash.
    assert.deepEqual(classify('dotnet build "a""b.csproj"', { family: 'powershell' }).commands[0].args, ['build', 'a"b.csproj']);
    assert.deepEqual(classify("dotnet build 'a''b.csproj'", { family: 'cmd' }).commands[0].args, ['build', "a'b.csproj"]);
    assert.deepEqual(classify('dotnet build "a\\"b.csproj"').commands[0].args, ['build', 'a"b.csproj']);
    assert.deepEqual(classify("dotnet build 'a b.csproj'").commands[0].args, ['build', 'a b.csproj']);
  });
});

describe('shell classifier: layer 1, deny-unmodelled', () => {
  const posixHostile = [
    ['dotnet build; rm -rf Assets', 'shell_recursive_delete'],
    ['dotnet build; rm -rf ~', 'shell_unmodelled'],
    ['$(git push)', 'shell_unmodelled'],
    ['echo `id`', 'shell_unmodelled'],
    ['cat <(echo hi)', 'shell_unmodelled'],
    ['echo >(tee x)', 'shell_unmodelled'],
    ["echo 'a\nb'", 'shell_unmodelled'],
    ['echo a \\\n b', 'shell_unmodelled'],
    ["$'\\x3b'", 'shell_unmodelled'],
    ['${IFS}cat', 'shell_unmodelled'],
    ['echo x &', 'shell_unmodelled'],
    ['(cd /; ls)', 'shell_unmodelled'],
    ['{ ls; }', 'shell_unmodelled'],
    ['!!', 'shell_unmodelled'],
    ['ls # then rm -rf', 'shell_unmodelled'],
    ['echo "unbalanced', 'shell_unparsable'],
  ];

  for (const [command, code] of posixHostile) {
    it(`denies the posix form ${JSON.stringify(command)}`, () => {
      const result = classify(command);
      assert.equal(result.decision, 'deny');
      assert.equal(result.code, code);
    });
  }

  // The three bypasses of amendment 35.8: each is caught by the grammar, not by any list.
  const powershellHostile = [
    ["[Type]::GetType('System.Net.'+'WebClient')", 'a type literal'],
    ["[Net.Sockets.TcpClient]::new('x',80)", 'a type literal'],
    ['[Net.Dns]::GetHostAddresses($exfil)', 'a type literal'],
    ['$c = New-Object Net.WebClient', 'a variable'],
    ['& "C:/tools/curl.exe" http://x', 'a call operator'],
    ['. ./profile.ps1', 'the dot-source operator'],
    ['@(1,2) | ForEach-Object { $x }', 'an array'],
    ["'ex' + 'filtrate'", 'string concatenation'],
    ["'a','b' -join ''", 'a string construction operator'],
    ['Get-Content x | iex', 'expression evaluation'],
  ];

  for (const [command, what] of powershellHostile) {
    it(`denies the powershell form ${JSON.stringify(command)}`, () => {
      const result = classify(command, { family: 'powershell' });
      assert.equal(result.decision, 'deny', command);
      assert.match(String(result.reason), new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }

  it('denies cmd expansion, escaping and grouping', () => {
    for (const command of ['echo %PATH%', 'echo a^&b', '(dir & del x)', 'echo !var!']) {
      assert.equal(classify(command, { family: 'cmd' }).decision, 'deny', command);
    }
  });

  // Double quotes suppress word splitting, not expansion. Blanking a double-quoted run would let two
  // characters step around layer 1 on every family, and layers 2 and 3 do not backstop it: the
  // tokenizer folds the inner program into one argument token, so `git`, `rm` and `curl` never become
  // command nodes at all.
  it('denies an expansion that hides inside a double-quoted run', () => {
    const quotedHostile = [
      ['posix', 'git status "$(git push --force)"'],
      ['posix', 'echo "$(rm -rf Assets)"'],
      ['posix', 'echo "${IFS}cat"'],
      ['posix', 'echo "`id`"'],
      ['powershell', 'Write-Output "$([Net.WebClient]::new())"'],
      ['powershell', 'Write-Output "$(Remove-Item -Recurse -Force Assets)"'],
      ['cmd', 'echo "%USERPROFILE%"'],
      ['cmd', 'echo "%COMSPEC% /c del /s Assets"'],
    ];
    for (const [family, command] of quotedHostile) {
      const result = classify(command, { family });
      assert.equal(result.decision, 'deny', `${family}: ${command}`);
      assert.equal(result.code, 'shell_unmodelled', command);
    }
  });

  it('still reads a single-quoted run as literal where the family says it is', () => {
    // Nothing expands inside single quotes on posix or powershell, so the same text stays a word.
    assert.equal(classify("echo '$(rm -rf Assets)'").decision, 'allow');
    assert.equal(classify("Write-Output '$([Net.WebClient]::new())'", { family: 'powershell' }).decision, 'allow');
    // cmd has no literal quote at all: `%VAR%` expands inside both of its quote characters.
    assert.equal(classify("echo '%USERPROFILE%'", { family: 'cmd' }).code, 'shell_unmodelled');
  });

  it('denies a string that runs no program the permission rules can see', () => {
    for (const command of ['> out.txt', '; ;', '| |']) {
      const result = classify(command);
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.code, 'shell_no_command_node');
    }
  });

  it('denies an empty command and a null byte', () => {
    assert.equal(classify('   ').code, 'shell_empty');
    assert.equal(classify('ls\u0000-la').code, 'shell_unmodelled');
    assert.equal(classifyShellCommand(/** @type {any} */ (null), { family: 'posix' }).code, 'shell_empty');
  });

  it('refuses a family it does not model', () => {
    const result = parseShellCommand('ls', /** @type {any} */ ('fish'));
    assert.equal(result.ok, false);
  });
});

describe('shell classifier: layer 2, blocked first tokens', () => {
  it('denies every interpreter wrapper, because what they run is invisible to the permission layer', () => {
    for (const wrapper of WRAPPER_PROGRAMS) {
      const result = classify(`${wrapper} whatever`);
      assert.equal(result.decision, 'deny', wrapper);
      assert.equal(result.code, 'shell_wrapper');
    }
  });

  it('matches a first token after basename normalisation', () => {
    assert.equal(normalizeProgram('C:/tools/CURL.EXE'), 'curl');
    assert.equal(normalizeProgram('./curl'), 'curl');
    assert.equal(normalizeProgram('/usr/bin/curl'), 'curl');
    assert.equal(normalizeProgram('npm.cmd'), 'npm');
    assert.equal(normalizeProgram('script.ps1'), 'script');
    assert.equal(normalizeProgram('.exe'), '.exe');
  });

  it('applies the caller-supplied deny list to the normalised token', () => {
    const options = { blockedPrograms: ['node', 'opencode-unity'] };
    for (const command of ['node -e "x"', '/usr/local/bin/node script.js', 'opencode-unity net allow x']) {
      const result = classify(command, options);
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.code, 'shell_blocked_command');
    }
  });

  it('allows a verify command by full-string equality only', () => {
    const options = { blockedPrograms: ['npm'], allowExactCommands: ['npm --prefix apps/api run test'] };
    assert.equal(classify('npm --prefix apps/api run test', options).decision, 'allow');
    assert.equal(classify('npm --prefix apps/api run test2', options).decision, 'deny');
    assert.equal(classify('npm run test', options).decision, 'deny');
  });

  it('blocks version control that would write, and every client of a VCS this project does not use', () => {
    for (const command of ['git push origin main', 'git commit -m x', 'git reset --hard', 'git -C other status']) {
      assert.equal(classify(command).code, 'shell_vcs_write', command);
    }
    for (const command of ['cm checkin -c x', 'p4 submit', 'svn commit', 'hg push']) {
      assert.equal(classify(command).code, 'shell_vcs_write', command);
    }
    assert.equal(classify('git status', { vcsKind: null }).code, 'shell_vcs_write');
    assert.equal(classify('git status', { vcsKind: 'plastic' }).code, 'shell_vcs_write');
    assert.equal(classify('git', { vcsKind: 'git' }).code, 'shell_vcs_write');
  });

  it('blocks recursive deletes in every spelling', () => {
    const commands = [
      ['posix', 'rm -rf Assets'],
      ['posix', 'rm -fr Assets'],
      ['posix', 'rm -r Assets'],
      ['posix', 'rmdir Assets'],
      ['powershell', 'Remove-Item -Recurse -Force Assets'],
      ['powershell', 'ri -Recurse Assets'],
      ['cmd', 'rd /s Assets'],
      ['cmd', 'del /s Assets'],
      ['cmd', 'format C:'],
    ];
    for (const [family, command] of commands) {
      assert.equal(classify(command, { family }).code, 'shell_recursive_delete', command);
    }
    assert.equal(classify('rm notes.txt').decision, 'allow');
  });

  it('blocks writes that land on a protected Unity file, by redirection or by copy', () => {
    const commands = [
      ['posix', 'echo x > Assets/Scenes/Main.unity'],
      ['posix', 'echo x >> ProjectSettings/ProjectSettings.asset'],
      ['posix', 'cp template.csproj Assembly-CSharp.csproj'],
      ['powershell', 'Set-Content Assets/UI/Menu.prefab "x"'],
      ['powershell', 'Copy-Item a.txt Library/state.bin'],
      // An absolute destination is where a posix `cp`, `mv`, `tee` or `install` target lands, and the
      // glob list matches it: the check may not depend on which of two equivalent spellings is used.
      ['posix', 'cp blank.txt /home/dev/Game/Assets/Scenes/Main.unity'],
      ['posix', 'tee /home/dev/Game/ProjectSettings/ProjectSettings.asset'],
      ['posix', 'install -m 644 blank.txt /srv/proj/Assets/UI/Menu.prefab'],
      ['posix', 'mv blank.txt /srv/proj/Game.csproj'],
    ];
    for (const [family, command] of commands) {
      assert.equal(classify(command, { family }).code, 'shell_protected_write', command);
    }
    assert.equal(classify('echo x > notes.txt').decision, 'allow');
    assert.equal(classify('echo x > notes.txt', { protectedWriteGlobs: [] }).decision, 'allow');
    // A Windows switch is still a switch, not a path: `/s` and `/MIR` must not be read as targets.
    assert.equal(classify('xcopy /s a.txt b.txt', { family: 'cmd' }).decision, 'allow');
    assert.equal(classify('robocopy /MIR src dst', { family: 'cmd' }).decision, 'allow');
    assert.equal(classify('Copy-Item a.txt b.txt', { family: 'powershell' }).decision, 'allow');
  });

  it('blocks an HTTP client aimed at the local Unity MCP hub', () => {
    for (const command of ['curl http://127.0.0.1:8080/mcp', 'wget http://localhost:8080/mcp', 'iwr http://0.0.0.0:8080/mcp']) {
      assert.equal(classify(command).code, 'shell_network_hub', command);
    }
    // The bracketed IPv6 form never reaches the hub rule: brackets are unmodelled everywhere.
    assert.equal(classify('curl http://[::1]:8080/mcp').code, 'shell_unmodelled');
    assert.equal(classify('curl http://127.0.0.1:9999/other').decision, 'allow');
    assert.equal(classify('curl http://127.0.0.1:8080/mcp', { mcpHub: null }).decision, 'allow');
    assert.equal(classify('curl http://hub.example:8080/x', { mcpHub: { host: 'hub.example', port: '8080' } }).code, 'shell_network_hub');
  });
});

describe('shell classifier: layer 3, blocked text', () => {
  it('denies an encoded command and expression evaluation wherever they appear', () => {
    assert.equal(classify('powershell -EncodedCommand ZQBjAGgAbwA=', { family: 'powershell' }).code, 'shell_blocked_text');
    assert.equal(classify('cat /dev/tcp/10.0.0.1/80').code, 'shell_blocked_text');
    assert.equal(classify('dotnet build && iex x', { family: 'powershell' }).code, 'shell_blocked_text');
    assert.ok(BLOCKED_TEXT.length >= 3);
  });
});

describe('shell classifier: helpers', () => {
  it('picks the family from the platform', () => {
    assert.equal(getDefaultFamily('win32'), 'powershell');
    assert.equal(getDefaultFamily('linux'), 'posix');
    assert.equal(getDefaultFamily('darwin'), 'posix');
  });

  it('matches globs case-insensitively across both separators', () => {
    assert.ok(matchesGlob('Assets\\Scenes\\Main.UNITY', '*.unity'));
    assert.ok(matchesGlob('a/Library/x/y', '*Library/*'));
    assert.ok(!matchesGlob('Assets/Main.cs', '*.unity'));
  });

  it('sorts the separators of every family longest first, so && never reads as &', () => {
    for (const family of Object.values(SHELL_FAMILIES)) {
      const lengths = family.separators.map((separator) => separator.length);
      assert.deepEqual(lengths, [...lengths].sort((left, right) => right - left));
    }
  });
});

describe('shell classifier: property test over 10,000 generated strings', () => {
  // The contract, stated without re-running the implementation's own patterns: a command the
  // classifier allows is made of quoted strings, the separators and redirections it models, and plain
  // words. Nothing else survives, so no allowed string can carry a construct that turns its first
  // token into something else. A backslash is a path separator on the two Windows families and an
  // escape on posix, so it belongs to the plain alphabet only off posix.
  // `&` on its own is a separator on cmd and a call operator everywhere else.
  // A quoted run is modelled only when nothing inside it still expands: `$` and a backtick keep
  // running inside double quotes on posix and powershell, and `%` keeps running inside either quote
  // on cmd, which has no literal quote. An oracle that stripped every double-quoted run would share
  // the implementation's blind spot and assert nothing about the one bypass that matters.
  const MODELLED = /'[^']*'|"[^"$`]*"|&&|\|\||[;|\n]|\d?>>|\d?>|</g;
  const MODELLED_CMD = /'[^'%]*'|"[^"%]*"|&&|\|\||[;|&\n]|\d?>>|\d?>|</g;
  const PLAIN_WORDS = /^[A-Za-z0-9 \t_.+:=,@/-]*$/;
  const PLAIN_WORDS_WINDOWS = /^[A-Za-z0-9 \t_.+:=,@/\\-]*$/;

  /** @param {number} seed */
  function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('never allows a string that carries an unmodelled construct', () => {
    const pieces = [
      'dotnet', 'build', 'git', 'status', 'push', 'Game.csproj', 'Assets/Main.cs', 'echo', 'x',
      ';', '&&', '||', '|', '$(', ')', '`', '${', '}', '<(', '>', '>>', '&', '\\', "'", '"',
      '::', '[', ']', '+', '%PATH%', '^', '!', 'rm', '-rf', 'curl', 'http://127.0.0.1:8080/mcp',
      ' ', '\n', '\t', '-EncodedCommand', 'iex', '/dev/tcp/1/2', 'Remove-Item', '-Recurse',
    ];
    const random = createRandom(20260918);
    const families = ['posix', 'powershell', 'cmd'];
    let allowed = 0;
    for (let index = 0; index < 10000; index += 1) {
      const family = families[Math.floor(random() * families.length)];
      const count = 1 + Math.floor(random() * 6);
      let command = '';
      for (let piece = 0; piece < count; piece += 1) command += `${pieces[Math.floor(random() * pieces.length)]} `;
      const result = classify(command, { family });
      if (result.decision !== 'allow') continue;
      allowed += 1;
      const rest = command.replace(family === 'cmd' ? MODELLED_CMD : MODELLED, ' ');
      const plain = family === 'posix' ? PLAIN_WORDS : PLAIN_WORDS_WINDOWS;
      assert.ok(plain.test(rest), `allowed a string that is not plain on ${family}: ${JSON.stringify(command)}`);
    }
    // The generator must actually produce allowable strings, or the assertion above proves nothing.
    assert.ok(allowed > 50, `only ${allowed} of 10000 generated strings were allowed`);
  });
});
