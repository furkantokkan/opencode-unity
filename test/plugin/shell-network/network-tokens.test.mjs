// The blocked first tokens of the network extension (amendment 35.8 layer 2, 12.10.3, DN19). The list
// holds whether or not a network policy exists: the plugin passes a `network.bash` mode on every call,
// and `deny` is the default and the only non-experimental value.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NETWORK_ASK_GROUPS,
  NETWORK_ASK_PROGRAMS,
  NETWORK_BASH_MODES,
  SHELL_BLOCKED_PROGRAMS,
  SHELL_BLOCKED_PROGRAM_GROUPS,
  SHELL_BLOCKED_SUBCOMMANDS,
  SHELL_FAMILY_IDS,
  SHELL_PRODUCT_PROGRAMS,
  classifyShellCommand,
  isListedProgram,
} from '../../../plugin/opencode-unity-lib/shell-classify.js';

/** The list of amendment 35.8, in the spelling the spec prints it. */
const SPEC_LIST = `
  curl  wget  iwr  irm  Invoke-WebRequest  Invoke-RestMethod  Start-BitsTransfer  bitsadmin
  certutil  Test-NetConnection  tnc  Resolve-DnsName  nslookup  dig  host  nc  ncat  netcat
  telnet  ftp  tftp  ssh  scp  sftp  rsync  openssl  socat  aria2c  httpie  http  https
  npx  bunx  pnpx  npm  pnpm  yarn  corepack
  node  bun  deno  tsx  ts-node  python  python3  py  perl  ruby  php
  firebase  gcloud  gsutil  bq  aws  az  supabase  vercel  netlify  heroku  gh  glab
  docker  podman  kubectl  helm  terraform
  psql  mysql  mongosh  redis-cli  sqlite3
  opencode-unity  opencode  ollama
`.trim().split(/\s+/);

/** The first words of `PM_DENY` (37.6), which is rendered from the same constant (D-M19). */
const PM_DENY_FIRST_WORDS = [
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack', 'node', 'tsx', 'ts-node', 'deno', 'docker',
  'kubectl', 'helm', 'terraform', 'psql', 'mysql', 'mongosh', 'redis-cli', 'sqlite3', 'prisma', 'drizzle-kit',
  'knex', 'supabase',
];

/** The wrappers 35.8 names, each spelled for the shell that would run it. */
const WRAPPERS = ['cmd /c', 'powershell -Command', 'pwsh -c', 'bash -c', 'sh -c', 'wsl', 'env', 'nohup', 'xargs', 'Start-Process'];

/**
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 */
function classify(command, options = {}) {
  return classifyShellCommand(command, { family: 'posix', vcsKind: 'git', networkBash: 'deny', ...options });
}

describe('the shared blocked-token constant', () => {
  it('holds every name of the 35.8 list, case-folded', () => {
    for (const name of SPEC_LIST) {
      assert.ok(SHELL_BLOCKED_PROGRAMS.includes(name.toLowerCase()), name);
    }
  });

  it('holds every first word of PM_DENY, so the rendered rules never name a program the classifier lets through', () => {
    for (const name of PM_DENY_FIRST_WORDS) assert.ok(SHELL_BLOCKED_PROGRAMS.includes(name), name);
    assert.deepEqual([...SHELL_BLOCKED_SUBCOMMANDS.dotnet.slice(0, 3)], ['ef', 'run', 'publish']);
  });

  it('is frozen, lowercase, free of duplicates, and flattened from its groups', () => {
    assert.ok(Object.isFrozen(SHELL_BLOCKED_PROGRAM_GROUPS));
    assert.ok(Object.isFrozen(SHELL_BLOCKED_PROGRAMS));
    for (const names of Object.values(SHELL_BLOCKED_PROGRAM_GROUPS)) {
      assert.ok(Object.isFrozen(names));
      for (const name of names) assert.equal(name, name.toLowerCase(), name);
    }
    assert.equal(new Set(SHELL_BLOCKED_PROGRAMS).size, SHELL_BLOCKED_PROGRAMS.length);
    assert.equal(SHELL_BLOCKED_PROGRAMS.length, Object.values(SHELL_BLOCKED_PROGRAM_GROUPS).flat().length);
  });

  it('asks only about clients that reach a host without the user identity', () => {
    assert.deepEqual([...NETWORK_BASH_MODES], ['deny', 'ask']);
    for (const group of NETWORK_ASK_GROUPS) assert.ok(Object.hasOwn(SHELL_BLOCKED_PROGRAM_GROUPS, group), group);
    for (const group of ['product', 'remoteShells', 'cloud', 'packageManagers', 'installers', 'interpreters', 'scriptHosts', 'containers', 'databases', 'migrations']) {
      assert.ok(!NETWORK_ASK_GROUPS.includes(group), group);
      for (const name of SHELL_BLOCKED_PROGRAM_GROUPS[group]) assert.ok(!NETWORK_ASK_PROGRAMS.includes(name), `${group}: ${name}`);
    }
  });
});

describe('network.bash deny: every blocked token, on every family', () => {
  for (const family of SHELL_FAMILY_IDS) {
    it(`refuses every name as a first token under the ${family} grammar`, () => {
      for (const name of SHELL_BLOCKED_PROGRAMS) {
        const result = classify(`${name} example.test`, { family });
        assert.equal(result.decision, 'deny', `${family}: ${name}`);
        assert.equal(result.code, 'shell_blocked_command', `${family}: ${name}`);
        // The reason is shown to the model; it names the program and never quotes the command.
        assert.match(String(result.reason), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.ok(!String(result.reason).includes('example.test'));
      }
    });
  }

  it('matches after basename normalisation: case, a path, a suffix, a trailing dot', () => {
    const spellings = [
      'CURL example.test',
      'curl.exe example.test',
      'CURL.EXE example.test',
      'curl.exe. example.test',
      './curl example.test',
      '/usr/bin/curl example.test',
      'C:/Windows/System32/curl.exe example.test',
      'Invoke-WebRequest example.test',
      'INVOKE-WEBREQUEST example.test',
      'Microsoft.PowerShell.Utility\\Invoke-WebRequest example.test',
      'npm.cmd ci',
      'npx.ps1 create-x',
      'C:\\nodejs\\node.exe -e x',
      '"C:\\Program Files\\nodejs\\node.exe" -e x',
    ];
    for (const command of spellings) {
      const result = classify(command, { family: 'cmd' });
      assert.equal(result.code, 'shell_blocked_command', command);
    }
    // PowerShell reads a quoted first word as an expression; refused either way.
    assert.equal(classify('"C:\\Program Files\\nodejs\\node.exe" -e x', { family: 'powershell' }).decision, 'deny');
  });

  it('matches a versioned interpreter as the interpreter it is', () => {
    for (const command of ['python3.12 -c x', 'pip3.11 install x', 'node22 -e x', 'ruby3.2 -e x', 'php8.3 -r x', 'python3.12.exe -c x']) {
      assert.equal(classify(command).code, 'shell_blocked_command', command);
    }
    assert.ok(isListedProgram('python3.12', SHELL_BLOCKED_PROGRAMS));
    assert.ok(isListedProgram('sqlite3', SHELL_BLOCKED_PROGRAMS));
    assert.ok(!isListedProgram('7z', SHELL_BLOCKED_PROGRAMS));
    assert.ok(!isListedProgram('123', SHELL_BLOCKED_PROGRAMS));
  });

  it('names the blocked program inside every wrapper 35.8 lists', () => {
    for (const wrapper of WRAPPERS) {
      for (const inner of ['curl example.test', 'npm ci', 'opencode-unity net allow example.test', 'ollama pull tiny']) {
        const result = classify(`${wrapper} "${inner}"`, { family: 'cmd' });
        assert.equal(result.decision, 'deny', `${wrapper} ${inner}`);
        assert.equal(result.code, 'shell_blocked_command', `${wrapper} ${inner}`);
      }
    }
    // A wrapper around an unlisted program is still refused, as a wrapper.
    assert.equal(classify('bash -c "dotnet build"').code, 'shell_wrapper');
  });

  it('refuses a blocked token after any separator of the family', () => {
    const separated = [
      ['posix', 'dotnet build; curl example.test'],
      ['posix', 'dotnet build && npm ci'],
      ['posix', 'git status || node -e x'],
      ['posix', 'git status | nc example.test 80'],
      ['posix', 'dotnet build\nssh example.test'],
      ['powershell', 'dotnet build; iwr example.test'],
      ['powershell', 'git status | Resolve-DnsName example.test'],
      ['cmd', 'dotnet build & curl example.test'],
      ['cmd', 'dotnet build && certutil -urlcache -f example.test x'],
    ];
    for (const [family, command] of separated) {
      assert.equal(classify(command, { family }).code, 'shell_blocked_command', `${family}: ${command}`);
    }
  });

  it('refuses the dotnet subcommands PM_DENY refuses, and keeps build and test', () => {
    for (const subcommand of SHELL_BLOCKED_SUBCOMMANDS.dotnet) {
      assert.equal(classify(`dotnet ${subcommand} x`).code, 'shell_blocked_command', subcommand);
      assert.equal(classify(`dotnet --diagnostics ${subcommand.toUpperCase()} x`).code, 'shell_blocked_command', subcommand);
    }
    assert.equal(classify('dotnet bin/Game.dll').code, 'shell_blocked_command');
    for (const command of ['dotnet build Game.csproj', 'dotnet test Tests.csproj --verbosity quiet', 'dotnet --version', 'dotnet']) {
      assert.equal(classify(command).decision, 'allow', command);
    }
  });

  it('still lets the agent build, test and read its own project', () => {
    for (const family of SHELL_FAMILY_IDS) {
      for (const command of ['dotnet build Assembly-CSharp.csproj', 'dotnet test Tests.csproj', 'git status', 'git log --oneline', 'ls Assets', 'grep -n UnityWebRequest Assets/Scripts/Api.cs']) {
        const result = classify(command, { family });
        assert.equal(result.decision, 'allow', `${family}: ${command} -> ${result.reason}`);
      }
    }
  });
});

describe('the verify-command exception (D-B10, D-B11)', () => {
  const verify = 'npm --prefix apps/api run test';

  it('allows a verify command by full-string equality only', () => {
    assert.equal(classify(verify, { allowExactCommands: [verify] }).decision, 'allow');
    for (const near of [`${verify} && curl example.test`, `${verify} ; npm ci`, `${verify} x`, ` ${verify}`, 'npm run test']) {
      assert.equal(classify(near, { allowExactCommands: [verify] }).decision, 'deny', near);
    }
  });

  it('never unlocks the product names, whatever the verify list says', () => {
    for (const name of SHELL_PRODUCT_PROGRAMS) {
      const command = `${name} net allow example.test`;
      assert.equal(classify(command, { allowExactCommands: [command] }).code, 'shell_blocked_command', name);
    }
  });

  it('keeps layer 3 for a verify command', () => {
    const withUrl = 'npm --prefix apps/api run test --registry=https://registry.example.test';
    assert.equal(classify(withUrl, { allowExactCommands: [withUrl] }).code, 'shell_blocked_text');
  });
});

describe('network.bash ask: the experimental mode (12.10.4)', () => {
  it('asks about a network client instead of refusing it', () => {
    for (const name of NETWORK_ASK_PROGRAMS) {
      const result = classify(`${name} example.test`, { networkBash: 'ask' });
      assert.equal(result.decision, 'ask', name);
      assert.equal(result.code, 'shell_network_ask', name);
      assert.match(String(result.reason), /asks before it runs/);
    }
    assert.equal(classify('iwr example.test', { family: 'powershell', networkBash: 'ask' }).decision, 'ask');
  });

  it('changes only the network clients: privilege, identity and code runners stay refused', () => {
    const stillDenied = SHELL_BLOCKED_PROGRAMS.filter((name) => !NETWORK_ASK_PROGRAMS.includes(name));
    assert.ok(stillDenied.length > 40);
    for (const name of stillDenied) {
      const result = classify(`${name} example.test`, { networkBash: 'ask' });
      assert.equal(result.decision, 'deny', name);
      assert.equal(result.code, 'shell_blocked_command', name);
    }
    for (const name of ['opencode-unity', 'opencode', 'ollama', 'ssh', 'gh', 'firebase', 'npm', 'node', 'docker', 'psql']) {
      assert.equal(classify(`${name} x`, { networkBash: 'ask' }).decision, 'deny', name);
    }
  });

  it('refuses the whole command when any other part of it is refused', () => {
    assert.equal(classify('curl example.test; git push', { networkBash: 'ask' }).code, 'shell_vcs_write');
    assert.equal(classify('curl example.test && npm ci', { networkBash: 'ask' }).code, 'shell_blocked_command');
    assert.equal(classify('bash -c "curl example.test"', { networkBash: 'ask' }).decision, 'deny');
    assert.equal(classify('curl example.test > Assets/Scenes/Main.unity', { networkBash: 'ask', protectedWriteGlobs: ['*.unity'] }).code, 'shell_protected_write');
  });

  it('keeps the second list blocked outright', () => {
    for (const command of ['curl https://example.test', 'curl --insecure example.test', 'curl -k example.test', 'curl --proxy p.test example.test']) {
      assert.equal(classify(command, { networkBash: 'ask' }).code, 'shell_blocked_text', command);
    }
    assert.equal(classify('iwr example.test -SkipCertificateCheck', { family: 'powershell', networkBash: 'ask' }).code, 'shell_blocked_text');
  });

  it('still refuses the local hub rather than asking about it', () => {
    const hub = { host: '127.0.0.1', port: '8080' };
    assert.equal(classify('curl 127.1:8080/mcp', { networkBash: 'ask', mcpHub: hub }).code, 'shell_network_hub');
  });

  it('reads an unknown mode as deny', () => {
    for (const mode of ['allow', 'ASK', '', 0, false]) {
      assert.equal(classify('curl example.test', { networkBash: /** @type {any} */ (mode) }).decision, 'deny', String(mode));
    }
  });
});

describe('without a network.bash mode', () => {
  it('leaves the network lists to the caller that names a mode, and keeps the product names', () => {
    // The milestone-2 grammar tests call the classifier this way; the plugin always passes a mode.
    assert.equal(classifyShellCommand('curl example.test', { family: 'posix' }).decision, 'allow');
    assert.equal(classifyShellCommand('curl example.test', { family: 'posix', networkBash: null }).decision, 'allow');
    for (const name of SHELL_PRODUCT_PROGRAMS) {
      assert.equal(classifyShellCommand(`${name} x`, { family: 'posix' }).code, 'shell_blocked_command', name);
      assert.equal(classifyShellCommand(`env ${name} x`, { family: 'posix' }).code, 'shell_blocked_command', name);
    }
  });
});
