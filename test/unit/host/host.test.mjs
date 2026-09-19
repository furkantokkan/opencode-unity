import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../../../src/commands/host.js';
import { createConsent } from '../../../src/cli/consent.js';
import { main } from '../../../src/cli/main.js';
import { sha256Hex, sha256Tree } from '../../../src/core/hash.js';
import { getHomePaths } from '../../../src/core/paths.js';
import { createManifest, loadManifest, saveManifest, upsertEntry } from '../../../src/install/manifest.js';
import { resolveSkillPath } from '../../../src/install/skills.js';
import { buildHostInstallStep, readHostTemplate, resolveHostTargets } from '../../../src/hosts/install.js';

const VERSION = '0.1.0-preview.5';

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homedir = path.join(root, 'user');
  const home = path.join(root, 'product');
  await fs.mkdir(homedir);
  const paths = getHomePaths(home);
  const files = Object.fromEntries(['claude', 'codex'].map((target) => [target, resolveSkillPath(target, { homedir })]));
  async function invoke(action, { host = ['claude', 'codex'], dryRun = false, yes = true, consent, ...dependencies } = {}) {
    const context = {
      command: `host ${action}`, subcommand: action, args: {}, options: { host },
      global: { dryRun, yes }, output: { text() {} },
      consent: consent ?? createConsent({ interactive: false, yes }),
      env: { OPENCODE_UNITY_HOME: home }, platform: process.platform, cwd: root, version: VERSION,
      signal: new AbortController().signal,
    };
    return run(context, { homedir, ...dependencies });
  }
  async function seed(target, content, { owned = true } = {}) {
    const file = files[target];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    if (owned) {
      const manifest = (await loadManifest(paths.installManifest)).manifest ?? createManifest(VERSION);
      await saveManifest(paths.installManifest, upsertEntry(manifest, { kind: 'skillCopy', target, path: file, sha256: sha256Hex(content), createdBy: `host@${VERSION}` }));
    }
  }
  return { root, homedir, home, paths, files, invoke, seed };
}

describe('managed host skills', () => {
  it('installs, verifies, reruns idempotently, and removes both hosts while retaining product data', async (t) => {
    const h = await harness(t);
    const installed = await h.invoke('install');
    assert.equal(installed.exitCode, 0);
    assert.deepEqual(installed.data.files.map((file) => file.status), ['current', 'current']);
    assert.ok(installed.data.files.every((file) => file.owned));
    assert.equal((await h.invoke('verify')).exitCode, 0);
    const snapshot = await sha256Tree(h.root);
    assert.equal((await h.invoke('install')).message, 'No host skill files changed.');
    assert.equal(await sha256Tree(h.root), snapshot);
    await fs.writeFile(path.join(h.home, 'keep.txt'), 'product data');
    const removed = await h.invoke('uninstall');
    assert.equal(removed.data.removed.length, 2);
    assert.deepEqual(await fs.readdir(h.homedir), []);
    assert.equal(await fs.readFile(path.join(h.home, 'keep.txt'), 'utf8'), 'product data');
    assert.deepEqual((await loadManifest(h.paths.installManifest)).manifest.entries, []);
  });

  it('dry-run install/update/verify/uninstall performs zero writes and never asks for consent', async (t) => {
    const h = await harness(t);
    const consent = { request() { throw new Error('unexpected consent'); } };
    let before = await sha256Tree(h.root);
    await h.invoke('install', { dryRun: true, consent });
    assert.equal(await sha256Tree(h.root), before);
    await h.seed('claude', 'older shipped bytes');
    before = await sha256Tree(h.root);
    assert.equal((await h.invoke('verify', { consent })).exitCode, 5);
    await h.invoke('update', { dryRun: true, consent });
    await h.invoke('uninstall', { dryRun: true, consent });
    assert.equal(await sha256Tree(h.root), before);
  });

  it('requires consent for writes but not for verification', async (t) => {
    const h = await harness(t);
    await assert.rejects(h.invoke('install', { yes: false }), (error) => error.code === 'consent_required');
    assert.deepEqual(await fs.readdir(h.root), ['user']);
    assert.equal((await h.invoke('verify', { yes: false })).exitCode, 5);
    const declined = await h.invoke('install', { consent: { request: async () => [{ id: 'host-install', accepted: false }] } });
    assert.match(declined.message, /declined/);
    assert.deepEqual(await fs.readdir(h.root), ['user']);
  });

  it('replaces an unchanged recorded old release and retains unrelated manifest entries', async (t) => {
    const h = await harness(t);
    await h.seed('claude', 'old shipped skill');
    const other = path.join(h.home, 'untouched.txt');
    await fs.writeFile(other, 'keep');
    const manifest = (await loadManifest(h.paths.installManifest)).manifest;
    await saveManifest(h.paths.installManifest, upsertEntry(manifest, { kind: 'file', path: other, sha256: sha256Hex('keep'), createdBy: `setup@${VERSION}` }));
    const result = await h.invoke('update', { host: ['claude'] });
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.readFile(h.files.claude, 'utf8'), await readHostTemplate('claude'));
    assert.equal((await loadManifest(h.paths.installManifest)).manifest.entries.length, 2);
    await h.invoke('uninstall', { host: ['claude'] });
    assert.equal((await loadManifest(h.paths.installManifest)).manifest.entries.length, 1);
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
  });

  it('preserves edited originals, writes a review candidate, and keeps both at uninstall', async (t) => {
    const h = await harness(t);
    await h.seed('claude', 'old shipped skill');
    await fs.writeFile(h.files.claude, 'my edits');
    const result = await h.invoke('update', { host: ['claude'] });
    assert.equal(result.code, 'host_conflict');
    assert.equal(await fs.readFile(h.files.claude, 'utf8'), 'my edits');
    assert.equal(await fs.readFile(`${h.files.claude}.ocu-new`, 'utf8'), await readHostTemplate('claude'));
    const removed = await h.invoke('uninstall', { host: ['claude'] });
    assert.deepEqual(removed.data.removed, []);
    assert.equal(removed.data.kept.length, 2);
    assert.equal(await fs.readFile(h.files.claude, 'utf8'), 'my edits');
  });

  it('preserves an unowned manually installed file even when it matches this release', async (t) => {
    const h = await harness(t);
    await h.seed('codex', await readHostTemplate('codex'), { owned: false });
    const result = await h.invoke('install', { host: ['codex'] });
    assert.equal(result.data.files[0].owned, false);
    assert.equal((await loadManifest(h.paths.installManifest)).manifest, null);
    assert.equal((await h.invoke('verify', { host: ['codex'] })).exitCode, 0);
    await h.invoke('uninstall', { host: ['codex'] });
    assert.equal(await fs.readFile(h.files.codex, 'utf8'), await readHostTemplate('codex'));
  });

  it('keeps user edits to an existing review candidate and does not create a manifest', async (t) => {
    const h = await harness(t);
    await h.seed('claude', 'custom skill', { owned: false });
    await fs.writeFile(`${h.files.claude}.ocu-new`, 'my candidate edits');
    const before = await sha256Tree(h.root);
    const result = await h.invoke('install', { host: ['claude'] });
    assert.equal(result.code, 'host_conflict');
    assert.equal(await sha256Tree(h.root), before);
  });

  it('retains backups after removing an unchanged installed skill', async (t) => {
    const h = await harness(t);
    await h.invoke('install', { host: ['claude'] });
    const backup = `${h.files.claude}.bak-${VERSION}`;
    await fs.writeFile(backup, 'personal backup');
    const result = await h.invoke('uninstall', { host: ['claude'] });
    assert.equal(result.data.removed.length, 1);
    assert.equal(await fs.readFile(backup, 'utf8'), 'personal backup');
    assert.ok(result.data.kept.some((value) => value.includes(backup)));
  });

  it('rechecks user changes made while uninstall consent was open', async (t) => {
    const h = await harness(t);
    await h.invoke('install', { host: ['claude'] });
    const result = await h.invoke('uninstall', { host: ['claude'], consent: {
      async request() {
        await fs.writeFile(h.files.claude, 'saved during consent');
        return [{ id: 'remove', accepted: true }];
      },
    } });
    assert.deepEqual(result.data.removed, []);
    assert.equal(await fs.readFile(h.files.claude, 'utf8'), 'saved during consent');
  });

  it('rechecks conflicts created while install consent was open', async (t) => {
    const h = await harness(t);
    await h.invoke('install', { host: ['claude'], consent: {
      async request() {
        await h.seed('claude', 'just saved', { owned: false });
        await fs.writeFile(`${h.files.claude}.ocu-new`, 'candidate just saved');
        return [{ id: 'host-install', accepted: true }];
      },
    } });
    assert.equal(await fs.readFile(h.files.claude, 'utf8'), 'just saved');
    assert.equal(await fs.readFile(`${h.files.claude}.ocu-new`, 'utf8'), 'candidate just saved');
    assert.equal((await loadManifest(h.paths.installManifest)).manifest, null);
  });

  it('rolls back all newly installed host files on a later write failure', async (t) => {
    const h = await harness(t);
    await assert.rejects(h.invoke('install', { onOperation(operation) {
      if (operation.path === h.files.codex) throw new Error('injected write failure');
    } }), /injected write failure/);
    assert.deepEqual(await fs.readdir(h.homedir), []);
    assert.deepEqual(await fs.readdir(h.root), ['user']);
  });

  it('refuses symlinked host directories without changing the redirected target', async (t) => {
    const h = await harness(t);
    const other = path.join(h.root, 'other');
    await fs.mkdir(other);
    await fs.symlink(other, path.join(h.homedir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(h.invoke('install', { host: ['claude'] }), (error) => error.code === 'host_path_unsafe');
    assert.deepEqual(await fs.readdir(other), []);
  });

  it('refuses a directory at SKILL.md and a broken host path', async (t) => {
    const h = await harness(t);
    await fs.mkdir(h.files.claude, { recursive: true });
    await assert.rejects(h.invoke('verify', { host: ['claude'] }), (error) => error.code === 'host_path_unsafe');
    await fs.writeFile(path.join(h.homedir, '.agents'), 'not a directory');
    await assert.rejects(h.invoke('install', { host: ['codex'] }), (error) => error.code === 'host_path_unsafe');
  });

  it('limits removal to the selected canonical host path even with other skill entries', async (t) => {
    const h = await harness(t);
    await h.invoke('install');
    const outside = path.join(h.root, 'outside.md');
    await fs.writeFile(outside, 'other');
    const manifest = (await loadManifest(h.paths.installManifest)).manifest;
    await saveManifest(h.paths.installManifest, upsertEntry(manifest, { kind: 'skillCopy', target: 'claude', path: outside, sha256: sha256Hex('other'), createdBy: `host@${VERSION}` }));
    await h.invoke('uninstall', { host: ['claude'] });
    assert.equal(await fs.readFile(outside, 'utf8'), 'other');
    assert.equal(await fs.readFile(h.files.codex, 'utf8'), await readHostTemplate('codex'));
    assert.equal((await loadManifest(h.paths.installManifest)).manifest.entries.length, 2);
  });

  it('detects existing host roots for auto and never claims host execution verification', async (t) => {
    const h = await harness(t);
    await assert.rejects(h.invoke('install', { host: ['auto'] }), /No host configuration directory/);
    await fs.mkdir(path.join(h.homedir, '.codex'));
    assert.deepEqual(await resolveHostTargets(['auto'], { homedir: h.homedir, platform: process.platform }), ['codex']);
    await fs.mkdir(path.join(h.homedir, '.claude'));
    const result = await h.invoke('install', { host: ['auto', 'codex'] });
    assert.equal(result.data.files.length, 2);
    assert.match(result.message, /new host session/);
  });

  it('rejects unspecified, invalid, manual-only hosts and invalid actions before writing', async (t) => {
    const h = await harness(t);
    for (const host of [[], ['../other'], ['antigravity']]) await assert.rejects(h.invoke('install', { host }), (error) => error.exitCode === 1);
    await assert.rejects(h.invoke('unknown'), (error) => error.exitCode === 1);
    await assert.rejects(readHostTemplate('other'), (error) => error.exitCode === 1);
    assert.deepEqual(await fs.readdir(h.root), ['user']);
  });

  it('exports a setup-compatible step with per-host ownership and safe conflict rules', async (t) => {
    const h = await harness(t);
    const result = await buildHostInstallStep({ targets: ['codex'], homedir: h.homedir, platform: process.platform, cliVersion: VERSION, manifest: createManifest(VERSION) });
    assert.equal(result.step.id, 'host-install');
    assert.equal(result.step.nature, 'consent');
    assert.equal(result.step.preselected, true);
    assert.equal(result.step.operations[0].onConflict, 'preserve');
    assert.equal(result.step.operations[0].entry.kind, 'skillCopy');
    assert.equal(result.step.operations[0].entry.target, 'codex');
  });

  it('runs the complete command envelope through the CLI with an isolated host home', async (t) => {
    const h = await harness(t);
    const options = [{ name: 'host', type: 'list', choices: ['claude', 'codex', 'auto'], required: true }, { name: 'host-home', type: 'string' }];
    const command = {
      name: 'host', group: 'advanced', summary: 'Host skill integration', module: '../commands/host.js', positionals: [],
      options: [],
      subcommands: ['install', 'verify', 'update', 'uninstall'].map((name) => ({ name, summary: name, options, positionals: [] })),
      exitCodes: [0, 1, 4, 5, 7, 9, 130],
    };
    for (const action of ['install', 'verify', 'update', 'uninstall']) {
      let output = '';
      const code = await main(['host', action, '--host', 'codex', '--host-home', h.homedir, '--yes', '--json'], {
        commands: [command], loadCommand: async () => ({ run }), isAvailable: () => true,
        cwd: h.root, env: { OPENCODE_UNITY_HOME: h.home }, platform: process.platform,
        stdout: { write: (value) => { output += value; return true; } }, stderr: { write: () => true }, interactive: false,
      });
      assert.equal(code, 0, output);
      const envelope = JSON.parse(output);
      assert.equal(envelope.command, `host ${action}`);
      assert.equal(envelope.ok, true);
    }
    assert.deepEqual(await fs.readdir(h.homedir), []);
  });
});
