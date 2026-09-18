// README.md is the install guide, so its commands are checked like code: every `opencode-unity` command
// it shows parses against the CLI argument table (amendment 34.6), the GitHub install names this
// version's tag, every preview host file it tells you to copy exists, and nothing it asks an agent to
// run switches off that agent's own permission system (amendment 32.7 S-H8).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgv } from '../../src/cli/args.js';
import { extractDocumentedCommands, parseDocumentedCommand, toArgv } from '../helpers/documented-commands.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

const BYPASS_FLAGS = ['--dangerously-skip-permissions', '--yolo', 'bypassPermissions', 'danger-full-access', 'always-proceed', 'allowNonWorkspaceAccess'];

/**
 * @returns {string}  `<owner>/<repo>` from package.json `repository.url`.
 */
function repositorySlug() {
  const match = /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(PACKAGE.repository?.url ?? '');
  assert.ok(match, 'package.json repository.url names a GitHub repository');
  return match[1];
}

describe('README.md', () => {
  it('shows only opencode-unity commands the CLI parses', () => {
    const commands = extractDocumentedCommands(README);
    assert.ok(commands.filter((command) => !command.inline).length >= 20, `found ${commands.length} commands`);
    const verbs = new Set();
    for (const command of commands) {
      const parsed = /** @type {any} */ (parseDocumentedCommand(command, parseArgv));
      if (parsed?.kind === 'command') verbs.add(parsed.command.name);
    }
    for (const verb of ['setup', 'init', 'start', 'doctor', 'uninstall', 'delegate']) assert.ok(verbs.has(verb), `the README shows ${verb}`);
  });

  it('installs this exact version from GitHub, quoted for every shell', () => {
    const spec = `"github:${repositorySlug()}#v${PACKAGE.version}"`;
    const installs = README.split('\n').filter((line) => /npm install -g "?github:/.test(line));
    assert.ok(installs.length >= 4, 'the agent prompt and each platform block install from GitHub');
    for (const line of installs) assert.ok(line.includes(`npm install -g ${spec}`), `outdated or unquoted install line: ${line.trim()}`);
  });

  it('names the preview version in its banner and in the agent prompt', () => {
    assert.ok(README.includes(`Preview ${PACKAGE.version}`));
    assert.match(README, /Install the opencode-unity preview on this machine/);
  });

  it('tells you to copy only host files the package ships', () => {
    const copied = [...README.matchAll(/hosts[\\/]((?:claude|codex|antigravity)[\w\\/.-]*\.md)/g)].map((match) => match[1].replace(/\\/g, '/'));
    assert.ok(copied.length >= 6, `found ${copied.length} host file references`);
    for (const file of new Set(copied)) assert.ok(fs.existsSync(path.join(REPO_ROOT, 'hosts', file)), `hosts/${file} exists`);
    assert.ok(PACKAGE.files.includes('hosts/'), 'package.json files ships hosts/');
  });

  it('asks no agent to bypass its permission system', () => {
    const blocks = README.split(/\n\s*\n/);
    for (const flag of BYPASS_FLAGS) {
      // `start` refusing these flags may be documented; running a host with one may not.
      for (const block of blocks.filter((candidate) => candidate.includes(flag))) {
        assert.match(block, /\brefuses\b/, `${flag} appears outside a refusal: ${block.trim().slice(0, 120)}`);
      }
    }
  });
});

describe('test/helpers/documented-commands.mjs', () => {
  it('fills placeholders, drops optional repeats and keeps quoted values together', () => {
    assert.deepEqual(toArgv('opencode-unity delegate apply <reviewId> [--check auto] --json').slice(1), ['delegate', 'apply', '20260918-120000-edit-abc123.0123abcd', '--check', 'auto', '--json']);
    assert.deepEqual(toArgv('opencode-unity delegate ask --task "<exact task>" --files <path> [<path> ...] --json').slice(1), ['delegate', 'ask', '--task', 'value', '--files', 'Assets/Scripts/Player.cs', '--json']);
    assert.deepEqual(toArgv("opencode-unity init '<project path>'").slice(1), ['init', 'value']);
  });

  it('finds commands in code blocks, numbered lines and inline code, and skips comments', () => {
    const markdown = ['Run `opencode-unity doctor` first.', '```text', '3. opencode-unity --version', '# opencode-unity not-a-command', 'npm install -g "github:x/y#v1"', '```'].join('\n');
    const commands = extractDocumentedCommands(markdown);
    assert.deepEqual(commands.map((command) => [command.source, command.inline]), [['opencode-unity doctor', true], ['opencode-unity --version', false]]);
  });

  it('accepts a command group named in prose but rejects one in a code block', () => {
    const [inline] = extractDocumentedCommands('Use `opencode-unity delegate` for bulk work.');
    assert.equal(parseDocumentedCommand(inline, parseArgv), null);
    const [block] = extractDocumentedCommands('```text\nopencode-unity delegate\n```');
    assert.throws(() => parseDocumentedCommand(block, parseArgv), /does not parse/);
    const [unknown] = extractDocumentedCommands('```text\nopencode-unity start --no-such-flag\n```');
    assert.throws(() => parseDocumentedCommand(unknown, parseArgv), /does not parse/);
  });
});
