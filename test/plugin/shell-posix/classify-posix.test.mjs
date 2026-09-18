// POSIX shell classification (amendment 33.7, CP-S7). The classifier is what enforces safety rules S4
// and S5 once OpenCode runs the agent's shell tool, and off Windows that shell is a POSIX one. The
// rule under test is deny-unmodelled: a construct the family grammar does not model is denied, so a
// string can never reach the shell carrying a second command the classifier did not see.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  SHELL_FAMILY_IDS,
  classifyShellCommand,
} from '../../../plugin/opencode-unity-lib/shell-classify.js';
import { getReadOnlyAllowPatterns, VCS_KINDS } from '../../../plugin/opencode-unity-lib/vcs-tables.js';
import { buildBashPermission } from '../../../src/opencode/render.js';

const HOSTILE_URL = new URL('./hostile-posix.json', import.meta.url);
const HOSTILE_TEXT = fs.readFileSync(HOSTILE_URL, 'utf8');
const HOSTILE = JSON.parse(HOSTILE_TEXT);

// A control character belongs in a file as an escape sequence, never as a byte: written raw it
// survives JSON.parse on some editors, breaks it on others, and takes the file out of the text scans
// either way. The cases that need one build it here instead of carrying it.
const NUL = String.fromCharCode(0);
const VTAB = String.fromCharCode(11);

const PROTECTED = ['*.unity', '*.prefab', '*.csproj', '*Library/*', '*ProjectSettings/*'];

/**
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 */
function classify(command, options = {}) {
  return classifyShellCommand(command, {
    family: 'posix',
    vcsKind: 'git',
    protectedWriteGlobs: PROTECTED,
    mcpHub: { host: '127.0.0.1', port: '8080' },
    ...options,
  });
}

describe('POSIX shell classification: the hostile fixture set', () => {
  it('carries at least the forty strings CP-S7 requires, each with the layer that catches it', () => {
    assert.ok(HOSTILE.cases.length >= 40, `only ${HOSTILE.cases.length} hostile strings`);
    const codes = new Set(HOSTILE.cases.map((entry) => entry.code));
    // A fixture set that only ever trips one rule would prove one rule.
    assert.ok(codes.size >= 5, `hostile strings exercise only ${codes.size} deny codes`);
  });

  it('spells every control character as an escape sequence, so the file stays scannable text', () => {
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(HOSTILE_TEXT));
  });

  it('denies the control characters the fixture file may not carry', () => {
    for (const command of [`ls${NUL}-la`, `dotnet build${NUL}; rm -rf Assets`, `dotnet${VTAB}build`]) {
      const result = classify(command);
      assert.equal(result.decision, 'deny', JSON.stringify(command));
      assert.equal(result.code, 'shell_unmodelled');
    }
  });

  for (const entry of HOSTILE.cases) {
    it(`denies ${JSON.stringify(entry.command)} (${entry.why})`, () => {
      const result = classify(entry.command);
      assert.equal(result.decision, 'deny');
      assert.equal(result.code, entry.code);
      // The reason is shown to the model, so it has to say something and never quote the command.
      assert.ok(String(result.reason).length > 10);
    });
  }
});

describe('POSIX shell classification: what the agent still gets to run', () => {
  it('allows every pattern the rendered bash allow-list grants, for every version control kind', () => {
    for (const vcsKind of VCS_KINDS) {
      const permission = buildBashPermission({
        vcsKind,
        bashMode: 'allowlist',
        csprojNames: ['Assembly-CSharp.csproj'],
        extensions: {},
      });
      const allowed = Object.entries(permission).filter(([, action]) => action === 'allow').map(([pattern]) => pattern);
      // The VCS half of the list comes from the same table the classifier reads, so an empty
      // intersection would mean the test is asserting nothing.
      assert.ok(allowed.length > getReadOnlyAllowPatterns(vcsKind).length);
      for (const pattern of allowed) {
        for (const command of [pattern.replace(/ \*$/, ''), pattern.replace(/ \*$/, ' --verbosity quiet')]) {
          const result = classify(command, { vcsKind });
          assert.equal(result.decision, 'allow', `${vcsKind}: ${command} -> ${result.reason}`);
        }
      }
    }
  });

  it('allows the plain shapes a code agent works in', () => {
    const allowed = [
      'dotnet build Assembly-CSharp.csproj',
      'dotnet test Tests.csproj --verbosity quiet',
      'ls -la Assets/Scripts',
      'cat Assets/Scripts/Player.cs',
      'grep -n Update Assets/Scripts/Player.cs',
      'echo done > notes.txt',
      'dotnet build "My Game.csproj"',
      './build.sh --configuration Debug',
      '/usr/bin/dotnet build Game.csproj',
      'dotnet build Game.csproj | sort',
      'cat log.txt 2> errors.txt',
    ];
    for (const command of allowed) {
      const result = classify(command);
      assert.equal(result.decision, 'allow', `${command} -> ${result.reason}`);
    }
  });
});

describe('POSIX shell classification: the constructs this family gained', () => {
  it('denies a heredoc, whose body is a second command the tokenizer never reads', () => {
    for (const command of ['cat << EOF', 'cat <<EOF\nrm -rf Assets\nEOF', 'cat <<< hi']) {
      assert.match(String(classify(command).reason), /heredoc or descriptor redirection/, command);
    }
  });

  it('denies descriptor redirection, which used to hide the write target of a protected file', () => {
    // `>&` put the ampersand where the tokenizer looked for the target, so the file after it was read
    // as an ordinary argument and the protected-write rule never saw it.
    const result = classify('echo x >& Assets/Scenes/Main.unity');
    assert.equal(result.decision, 'deny');
    assert.equal(result.code, 'shell_unmodelled');
    for (const command of ['ls 2>&1', 'echo hi |& cat', 'echo x >| out.txt', 'exec 3<> file']) {
      assert.equal(classify(command).decision, 'deny', command);
    }
    // The modelled redirections still work, so denying the rest costs the agent nothing it needs.
    assert.equal(classify('dotnet build Game.csproj > build.log').decision, 'allow');
    assert.equal(classify('dotnet build Game.csproj 2> build.log').decision, 'allow');
    assert.equal(classify('dotnet build Game.csproj >> build.log').decision, 'allow');
  });

  it('denies a program named in a form it cannot reduce to a basename', () => {
    const hidden = [
      '=git push',            // zsh equals expansion
      'GIT_DIR=x git push',   // an assignment prefix
      'PATH=/tmp git push',   // an assignment prefix whose value has a path separator in it
      '@echo off',
      '-rf Assets',
    ];
    for (const command of hidden) {
      const result = classify(command);
      assert.equal(result.decision, 'deny', command);
      assert.match(String(result.reason), /cannot be checked/, command);
    }
    // A path is still a path, quoted or not, absolute or relative.
    for (const command of ['/usr/bin/dotnet build', './dotnet build', '../tools/dotnet build', '"My Tools/dotnet" build']) {
      assert.equal(classify(command).decision, 'allow', command);
    }
  });

  it('denies the command prefixes that run a program the permission rules never see', () => {
    const prefixed = ['command git push', 'time git push', 'eval git push', 'exec git push', 'builtin cd /', 'coproc git push', 'nice -n 10 git push', 'timeout 5 git push', 'setsid git push', 'stdbuf -o0 git push', 'xargs git push', 'nohup git push', 'env GIT_DIR=x git push'];
    for (const command of prefixed) {
      const result = classify(command);
      assert.equal(result.code, 'shell_wrapper', command);
    }
  });

  it('denies every POSIX shell invoked as a program, whichever one the host prefers', () => {
    for (const shell of ['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'fish', 'busybox']) {
      assert.equal(classify(`${shell} -c "git push"`).code, 'shell_wrapper', shell);
    }
  });
});

describe('POSIX shell classification: the safety rules hold on every family', () => {
  it('denies a version control write on every family, including through an alias-looking prefix (S5)', () => {
    const writes = ['git push origin main', 'git commit -m x', 'git reset --hard', '/usr/bin/git push', 'g"i"t push', '"git" push'];
    for (const family of SHELL_FAMILY_IDS) {
      for (const command of writes) {
        assert.equal(classify(command, { family }).code, 'shell_vcs_write', `${family}: ${command}`);
      }
      // A client of a VCS this project does not use is denied whatever the subcommand is.
      assert.equal(classify('hg status', { family }).code, 'shell_vcs_write', family);
    }
  });

  it('denies a protected-path write on every family, with either separator (S4)', () => {
    const writes = [
      'echo x > Assets/Scenes/Main.unity',
      'echo x > Assets\\Scenes\\Main.unity',
      'echo x >> ProjectSettings/ProjectSettings.asset',
      'cp blank.txt Assets/UI/Menu.prefab',
      'cp blank.txt Assets\\UI\\Menu.prefab',
      'mv blank.txt Library/state.bin',
    ];
    for (const family of SHELL_FAMILY_IDS) {
      for (const command of writes) {
        const result = classify(command, { family });
        assert.equal(result.decision, 'deny', `${family}: ${command}`);
        // A backslash is an escape on posix, so those two spellings are refused one layer earlier.
        const expected = family === 'posix' && command.includes('\\') ? 'shell_unmodelled' : 'shell_protected_write';
        assert.equal(result.code, expected, `${family}: ${command}`);
      }
    }
  });
});

describe('POSIX shell classification: deny-unmodelled is closed under concatenation', () => {
  // Every fragment below carries a construct the POSIX grammar refuses. Sticking one onto a command
  // the classifier allows must deny the whole string, at either end: that is what "a construct it
  // cannot model denies the command" means when the model writes a plausible command and one operator.
  const FRAGMENTS = ['$(git push)', '`id`', '<(cat x)', '>(tee x)', '${IFS}', '&', '\\', '~', '%', '!', '<<', '>&', '|&', '>|', '#', '(', ')', '{', '}', '*', '?', '[a]', '::', "$'\\x3b'", '2>&1'];
  const BENIGN = ['dotnet build Game.csproj', 'ls -la', 'cat Assets/Main.cs', 'git status', 'echo hello'];

  it('allows every benign command on its own, or the rest of this test proves nothing', () => {
    for (const command of BENIGN) assert.equal(classify(command).decision, 'allow', command);
  });

  it('denies every benign command with one unmodelled fragment on either end', () => {
    for (const benign of BENIGN) {
      for (const fragment of FRAGMENTS) {
        assert.equal(classify(`${benign} ${fragment}`).decision, 'deny', `suffix ${fragment}`);
        assert.equal(classify(`${fragment} ${benign}`).decision, 'deny', `prefix ${fragment}`);
      }
    }
  });
});

describe('POSIX shell classification: property test over 10,000 generated strings', () => {
  // The oracle is written from the POSIX grammar rather than from the implementation: a command the
  // classifier allows may only be made of quoted runs, the separators and redirections it models, and
  // plain words. A double-quoted run keeps `$` and a backtick, because they still expand inside one,
  // and no descriptor or heredoc operator may survive anywhere.
  const QUOTED = /'[^']*'|"[^"$`]*"/g;
  const UNMODELLED_REDIRECT = /<<|<>|[<>]&|&>|>\||\|&/;
  const MODELLED = /&&|\|\||[;|\n]|\d?>>|\d?>|</g;
  const PLAIN_WORDS = /^[A-Za-z0-9 \t_.+:=,@/-]*$/;

  const PIECES = [
    'dotnet', 'build', 'git', 'status', 'push', 'Game.csproj', 'Assets/Main.cs', 'echo', 'x', 'cat',
    ';', '&&', '||', '|', '$(', ')', '`', '${', '}', '<(', '>', '>>', '<', '&', '\\', "'", '"',
    '<<', 'EOF', '>&', '2>&1', '|&', '>|', '=git', 'PATH=/tmp', 'command', 'time', 'rm', '-rf',
    '~', '%', '!', '#', '*', '::', ' ', '\n', '\t',
  ];
  const FRAGMENTS = ['$(id)', '`id`', '${IFS}', '<<', '>&', '~', '%', '!', '\\', '*'];

  /** @param {number} seed */
  function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('never allows a string the POSIX grammar does not fully model, and never stays allowing with one fragment added', () => {
    const random = createRandom(20260918);
    let allowed = 0;
    for (let index = 0; index < 10000; index += 1) {
      const count = 1 + Math.floor(random() * 6);
      let command = '';
      for (let piece = 0; piece < count; piece += 1) command += `${PIECES[Math.floor(random() * PIECES.length)]} `;
      if (classify(command).decision !== 'allow') continue;
      allowed += 1;

      const masked = command.replace(QUOTED, (run) => 'Q'.repeat(run.length));
      assert.ok(!UNMODELLED_REDIRECT.test(masked), `allowed a descriptor redirection: ${JSON.stringify(command)}`);
      assert.ok(PLAIN_WORDS.test(masked.replace(MODELLED, ' ')), `allowed a string that is not plain: ${JSON.stringify(command)}`);

      const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      assert.equal(classify(`${command} ${fragment}`).decision, 'deny', `stayed allowed with ${fragment}: ${JSON.stringify(command)}`);
    }
    // The generator must actually produce allowable strings, or the assertions above prove nothing.
    assert.ok(allowed > 50, `only ${allowed} of 10000 generated strings were allowed`);
  });
});
