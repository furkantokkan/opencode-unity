// Layer 3 of the network extension (amendment 35.8, 12.10.3): the text that defeats token matching.
// A URL-shaped token, a .NET or COM network type, a proxy or certificate flag and an encoded command
// are refused wherever they appear, and the `ask` mode never relaxes any of them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NETWORK_BLOCKED_TEXT, SHELL_FAMILY_IDS, classifyShellCommand } from '../../../plugin/opencode-unity-lib/shell-classify.js';

// Built rather than written, so no line of this file needs a doubled backslash to mean one.
const BS = String.fromCharCode(92);

/**
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 */
function classify(command, options = {}) {
  return classifyShellCommand(command, { family: 'posix', vcsKind: 'git', networkBash: 'deny', ...options });
}

/**
 * UTF-16LE base64, the form PowerShell's `-EncodedCommand` takes.
 * @param {string} text
 */
function encodeCommand(text) {
  return Buffer.from(text, 'utf16le').toString('base64');
}

describe('URL-shaped tokens', () => {
  it('refuses every scheme 35.8 names, and any other scheme, in an argument of an allowed program', () => {
    for (const url of ['http://example.test', 'https://example.test/x', 'ftp://example.test', 'ws://example.test', 'wss://example.test', 'file://server/share', 'gopher://example.test', 'HTTPS://EXAMPLE.TEST']) {
      for (const family of SHELL_FAMILY_IDS) {
        const result = classify(`git log --grep ${url}`, { family });
        assert.equal(result.code, 'shell_blocked_text', `${family}: ${url}`);
        assert.equal(result.reason, 'the command contains a URL');
      }
    }
  });

  it('refuses a URL spelled with backslashes, which the .NET URI parser accepts', () => {
    assert.equal(classify(`Write-Output http:${BS}${BS}example.test`, { family: 'powershell' }).code, 'shell_blocked_text');
    assert.equal(classify(`Write-Output http:/${BS}example.test`, { family: 'powershell' }).code, 'shell_blocked_text');
  });

  it('conservatively refuses URLs spliced or obscured with quoted pieces', () => {
    const spliced = [
      ['posix', "echo ht'tp'://example.test"],
      ['posix', "echo 'http:'//example.test"],
      ['posix', 'echo "http:""//example.test"'],
      ['posix', "echo h't't'p's'':'/'/example.test"],
      ['powershell', "Write-Output 'http:''//example.test'"],
      ['powershell', "Write-Output 'ht''tp://example.test'"],
      ['cmd', 'echo "http:"//example.test'],
    ];
    for (const [family, command] of spliced) {
      assert.equal(classify(command, { family }).code, 'shell_blocked_text', `${family}: ${command}`);
    }
  });

  it('refuses a URL joined to a switch or an assignment', () => {
    for (const command of ['git log --grep=http://example.test', 'dotnet build -p:RestoreSources=https://feed.example.test', 'Write-Output -InputObject:https://example.test']) {
      assert.equal(classify(command, { family: 'powershell' }).code, 'shell_blocked_text', command);
    }
  });

  it('refuses a network path: //host and the UNC form, which opens an SMB session', () => {
    const paths = [
      ['posix', 'cat //example.test/share/x'],
      ['posix', 'ls //example.test'],
      ['powershell', `Get-Content ${BS}${BS}example.test${BS}share${BS}x`],
      ['powershell', `Get-ChildItem -Path:${BS}${BS}example.test${BS}share`],
      ['powershell', `Copy-Item a.txt,${BS}${BS}example.test${BS}share${BS}x`],
      ['cmd', `type ${BS}${BS}example.test${BS}share${BS}x`],
      ['cmd', `dir "${BS}${BS}example.test${BS}share"`],
      ['posix', 'echo x > //example.test/share/x'],
    ];
    for (const [family, command] of paths) {
      assert.equal(classify(command, { family }).code, 'shell_blocked_text', `${family}: ${command}`);
    }
  });

  it('does not mistake a local path for a network one', () => {
    for (const [family, command] of [
      ['powershell', `dotnet build C:${BS}Projects${BS}Game${BS}Game.csproj`],
      ['cmd', `dotnet build C:${BS}Projects${BS}Game${BS}Game.csproj`],
      ['posix', 'dotnet build /home/dev/Game/Game.csproj'],
      ['posix', 'ls Assets/Scripts'],
      ['powershell', 'dotnet build C:/Projects/Game/Game.csproj'],
    ]) {
      const result = classify(command, { family });
      assert.equal(result.decision, 'allow', `${family}: ${command} -> ${result.reason}`);
    }
  });
});

describe('.NET and COM network types', () => {
  it('refuses every type 35.8 names, in any case and inside a quoted string', () => {
    const types = ['Net.WebClient', 'System.Net.Http', 'HttpClient', 'WebRequest', 'Msxml2.XMLHTTP', 'WinHttp.WinHttpRequest', 'Net.Sockets', 'System.Net.Sockets', 'Net.Dns', 'System.Net.Dns', 'Net.HttpListener'];
    for (const type of types) {
      for (const spelling of [type, type.toLowerCase(), type.toUpperCase()]) {
        const result = classify(`Write-Output '${spelling}'`, { family: 'powershell' });
        assert.equal(result.code, 'shell_blocked_text', spelling);
        assert.equal(result.reason, 'the command contains a .NET or COM network type');
      }
    }
    assert.equal(classify("Write-Output 'MSXML2.ServerXMLHTTP'", { family: 'powershell' }).code, 'shell_blocked_text');
    assert.equal(classify("Write-Output 'System.Net.HttpWebRequest'", { family: 'powershell' }).code, 'shell_blocked_text');
    assert.ok(NETWORK_BLOCKED_TEXT.length > 0);
  });

  it('leaves the Invoke-WebRequest cmdlet to layer 2, and Unity own HTTP class alone', () => {
    // The cmdlet is a first token the ask mode may ask about; the text rule must not refuse it first.
    assert.equal(classify('Invoke-WebRequest example.test', { family: 'powershell', networkBash: 'ask' }).decision, 'ask');
    assert.equal(classify('grep -rn UnityWebRequest Assets/Scripts').decision, 'allow');
  });
});

describe('proxy and certificate flags', () => {
  it('refuses each as a standalone token, and joined to its value', () => {
    for (const flag of ['--proxy', '-Proxy', '-SkipCertificateCheck', '--insecure', '-k', '-K', '--PROXY', '--proxy=p.test', '-Proxy:p.test']) {
      const result = classify(`git log ${flag} x`);
      assert.equal(result.code, 'shell_blocked_text', flag);
      assert.equal(result.reason, 'the command contains a proxy or certificate-check flag');
    }
    // Quoting a flag does not stop the program from reading it.
    assert.equal(classify("git log '--insecure'").code, 'shell_blocked_text');
  });

  it('does not refuse a flag that only starts the same way', () => {
    for (const command of ['git log --keep', 'dotnet build -kx', 'git log --proxyless']) {
      assert.equal(classify(command).decision, 'allow', command);
    }
  });
});

describe('encoded commands', () => {
  it('refuses a UTF-16LE base64 word behind any prefix of -EncodedCommand, in every mode', () => {
    const payload = encodeCommand('iwr example.test');
    for (const flag of ['-e', '-ec', '-en', '-enco', '-encodedc']) {
      for (const networkBash of ['deny', 'ask', undefined]) {
        const result = classifyShellCommand(`Write-Output ${flag} ${payload}`, { family: 'powershell', networkBash });
        assert.equal(result.decision, 'deny', `${flag} ${networkBash}`);
        assert.equal(result.code, 'shell_blocked_text', `${flag} ${networkBash}`);
      }
    }
    assert.equal(classify(`Write-Output ${encodeCommand('dir')}`, { family: 'powershell' }).reason, 'the command contains an encoded command');
  });

  it('does not refuse a hash, a path or an identifier that happens to be base64-shaped', () => {
    for (const command of [
      'git show 3f786850e387550fdab836ed7e6dc881de23001b',
      'git log 3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab8',
      'ls Assets/Scripts/Gameplay/Enemies1',
      'grep -n PlayerControllerBase Assets/Scripts/Player.cs',
    ]) {
      assert.equal(classify(command).decision, 'allow', command);
    }
  });
});

describe('the other substrings of layer 3', () => {
  it('refuses expression evaluation and socket redirections under every mode', () => {
    for (const networkBash of ['deny', 'ask']) {
      assert.equal(classify('Get-Content x | iex', { family: 'powershell', networkBash }).code, 'shell_blocked_text');
      assert.equal(classify('Invoke-Expression x', { family: 'powershell', networkBash }).code, 'shell_blocked_text');
      assert.equal(classify('cat /dev/tcp/10.0.0.1/80', { networkBash }).code, 'shell_blocked_text');
      assert.equal(classify('cat /dev/udp/10.0.0.1/53', { networkBash }).code, 'shell_blocked_text');
    }
  });
});
