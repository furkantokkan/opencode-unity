// `uninstall` end to end (spec 14.4, amendment 38.11): the plan comes from the manifest, only unchanged
// things are removed, models and the consent ledger are separate questions, and a setup followed by an
// uninstall leaves no residue.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { sha256Hex, sha256Tree } from '../../src/core/hash.js';
import { createManifest, saveManifest } from '../../src/install/manifest.js';
import { BASE_MODEL, MODEL_TAG, createFakeOllama, createFakeUserEnv, createHarness, listTree, preflightFacts, readManifestFile } from './helpers.mjs';

const YES = ['--yes'];

describe('uninstall without an installation', () => {
  it('says there is nothing recorded and exits 0', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope } = await harness.run(['uninstall', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.match(envelope.message, /nothing recorded/);
  });
});

describe('uninstall residue', () => {
  it('leaves the sandbox exactly as it was before setup', async (t) => {
    const harness = await createHarness(t);
    const before = await listTree(harness.sandbox.root);

    await harness.run(['setup', '--no-model', ...YES]);
    const { exitCode, envelope } = await harness.run(['uninstall', ...YES]);

    assert.equal(exitCode, EXIT.OK, envelope.message);
    assert.deepEqual(await listTree(harness.sandbox.root), before);
    assert.equal(envelope.data.homeRemoved, true);
  });

  it('also removes what OpenCode put inside the profile directory', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const profileDir = harness.paths.profile(harness.version).dir;
    await fs.mkdir(path.join(profileDir, 'node_modules', 'some-package'), { recursive: true });
    await fs.writeFile(path.join(profileDir, 'node_modules', 'some-package', 'index.js'), '1', 'utf8');
    await fs.writeFile(path.join(harness.paths.xdgConfig, 'opencode.json'), '{}', 'utf8');

    await harness.run(['uninstall', ...YES]);

    assert.deepEqual(await listTree(harness.home), []);
  });
});

describe('uninstall keeps what changed', () => {
  it('keeps an edited config.json and names it', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.appendFile(harness.paths.config, '\n', 'utf8');

    const { envelope } = await harness.run(['uninstall', ...YES]);

    await fs.access(harness.paths.config);
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes('config.json') && /changed/.test(line)), envelope.data.kept.join('|'));
    assert.deepEqual(await listTree(harness.home), ['config.json']);
  });

  it('warns about an edited file inside the profile before removing the directory', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const agent = path.join(harness.paths.profile(harness.version).dir, 'agents', 'unity-code.md');
    await fs.appendFile(agent, '\nmy note\n', 'utf8');

    const { stderr } = await harness.run(['uninstall', '--dry-run']);

    assert.match(stderr, /unity-code\.md was edited; it is removed with its directory/);
  });

  it('keeps a backup of a file setup had replaced', async (t) => {
    const harness = await createHarness(t);
    await fs.mkdir(path.dirname(harness.paths.profileCurrent), { recursive: true });
    await fs.writeFile(harness.paths.profileCurrent, '{"version":"0.0.1","previous":null}\n', 'utf8');
    await harness.run(['setup', '--no-model', ...YES]);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    const left = await listTree(harness.home);
    assert.deepEqual(left, ['profile/', `profile/current.json.bak-${harness.version}`]);
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes('.bak-')));
  });

  it('restores an environment variable only while it still holds the value setup wrote', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    const harness = await createHarness(t, { userEnv });
    await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);
    userEnv.values.set('OLLAMA_KV_CACHE_TYPE', 'q4_0');

    await harness.run(['uninstall', ...YES]);

    assert.equal(userEnv.values.get('OLLAMA_KV_CACHE_TYPE'), 'q4_0');
    assert.equal(userEnv.values.has('OLLAMA_FLASH_ATTENTION'), false);
  });

  it('puts a variable back to the value it had before setup', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    const harness = await createHarness(t, { userEnv });
    await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    await harness.run(['uninstall', ...YES]);

    assert.equal(userEnv.values.get('OLLAMA_KV_CACHE_TYPE'), 'f16');
    assert.deepEqual([...userEnv.values.keys()], ['OLLAMA_KV_CACHE_TYPE']);
  });
});

describe('uninstall models', () => {
  it('keeps every model without --remove-models, and lists them', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    assert.deepEqual(harness.models.commands, [`create ${MODEL_TAG}`]);
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes(MODEL_TAG) && /--remove-models/.test(line)));
  });

  it('removes created tags with --remove-models and never the base model', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);

    await harness.run(['uninstall', '--remove-models', ...YES]);

    assert.deepEqual(harness.models.commands, [`create ${MODEL_TAG}`, `rm ${MODEL_TAG}`]);
  });

  it('removes a base model only when setup downloaded it and --remove-base-model asks', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const harness = await createHarness(t, { ollamaClient });
    await harness.run(['setup', ...YES]);

    await harness.run(['uninstall', '--remove-base-model', ...YES]);

    assert.ok(harness.models.commands.includes(`rm ${BASE_MODEL}`));
    assert.equal(harness.models.commands.includes(`rm ${MODEL_TAG}`), false);
  });

  it('refuses to remove a base model that was already there', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);

    const { envelope } = await harness.run(['uninstall', '--remove-base-model', ...YES]);

    assert.equal(harness.models.commands.includes(`rm ${BASE_MODEL}`), false);
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes(BASE_MODEL) && /already in your Ollama store/.test(line)));
  });

  it('asks a second question before removing models, and a no keeps them', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);

    await harness.run(['uninstall', '--remove-models'], { interactive: true, input: 'y\nn\n' });

    assert.deepEqual(harness.models.commands, [`create ${MODEL_TAG}`]);
  });
});

describe('uninstall edge cases', () => {
  it('says nothing is left when every recorded thing is already gone', async (t) => {
    const harness = await createHarness(t);
    const manifest = createManifest(harness.version);
    manifest.entries.push({ kind: 'file', path: harness.sandbox.path('gone.txt'), sha256: '0'.repeat(64), createdBy: `setup@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);
    await fs.rm(harness.paths.state, { recursive: true, force: true });
    await saveManifest(harness.paths.installManifest, manifest);

    const { exitCode, envelope } = await harness.run(['uninstall', '--keep-data', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.match(envelope.message, /Nothing recorded is still on this machine/);
  });

  it('exits 7 and names what it could not remove', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);
    harness.models.commands.length = 0;
    const failing = { ...harness.models, remove: async (/** @type {string} */ name) => { throw new Error(`${name} is in use`); } };

    const { exitCode, envelope } = await harness.run(['uninstall', '--remove-models', ...YES], { dependencies: { models: failing } });

    assert.equal(exitCode, EXIT.RUNTIME);
    assert.equal(envelope.code, 'uninstall_incomplete');
    assert.ok(envelope.warnings.some((warning) => /ocu-qwen3-coder-30b-16k is in use/.test(warning)));
    // The record survives with exactly what is still installed, so running uninstall again finishes it.
    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.deepEqual(manifest.entries.map((entry) => entry.name ?? entry.path), [BASE_MODEL, MODEL_TAG]);

    const retry = await harness.run(['uninstall', '--remove-models', ...YES]);

    assert.equal(retry.exitCode, EXIT.OK);
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('keeps a base model setup downloaded unless --remove-base-model asks', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const harness = await createHarness(t, { ollamaClient });
    await harness.run(['setup', ...YES]);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes(BASE_MODEL) && /--remove-base-model/.test(line)));
  });

  it('reverts a skill copy by its hash, and the folders made for it', async (t) => {
    const harness = await createHarness(t);
    const skillRoot = harness.sandbox.path('home', '.agents');
    const skill = path.join(skillRoot, 'skills', 'opencode-unity-delegate', 'SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, '# skill\n', 'utf8');
    const manifest = createManifest(harness.version);
    manifest.entries.push({ kind: 'skillCopy', target: 'codex', path: skill, sha256: sha256Hex('# skill\n'), createdRoot: skillRoot, createdBy: `host@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);

    await harness.run(['uninstall', ...YES]);

    await assert.rejects(fs.access(skillRoot));
  });

  it('keeps an edited skill copy and everything above it', async (t) => {
    const harness = await createHarness(t);
    const skill = harness.sandbox.path('home', '.claude', 'skills', 'opencode-unity-delegate', 'SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, '# skill, edited\n', 'utf8');
    const manifest = createManifest(harness.version);
    manifest.entries.push({ kind: 'skillCopy', target: 'claude', path: skill, sha256: sha256Hex('# skill\n'), createdBy: `host@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    assert.equal(await fs.readFile(skill, 'utf8'), '# skill, edited\n');
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => line.includes('SKILL.md')));
  });
});

describe('uninstall consent ledger', () => {
  it('keeps the network consent ledger unless its own question is answered yes', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const ledger = path.join(harness.paths.state, 'consent.jsonl');
    await fs.writeFile(ledger, '{"id":"c1"}\n', 'utf8');

    const { stderr } = await harness.run(['uninstall', ...YES]);

    assert.match(stderr, /network consent ledger/);
    assert.deepEqual(await listTree(harness.home), ['state/', 'state/consent.jsonl']);
  });

  it('removes the ledger when that question is answered yes', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.writeFile(path.join(harness.paths.state, 'consent.jsonl'), '{"id":"c1"}\n', 'utf8');

    const { exitCode } = await harness.run(['uninstall'], { interactive: true, input: 'y\ny\n' });

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('asks about the ledger after the main removal, as a separate question', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.writeFile(path.join(harness.paths.state, 'consent.jsonl'), '{"id":"c1"}\n', 'utf8');

    const { stderr } = await harness.run(['uninstall'], { interactive: true, input: 'y\nn\n' });

    const main = stderr.indexOf('Remove ');
    const ledger = stderr.indexOf('Remove the network consent ledger');
    assert.ok(main >= 0 && ledger > main, stderr);
  });
});

describe('uninstall flags', () => {
  it('keeps everything when the person at the prompt only presses Enter, because a deletion defaults to No', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const before = await listTree(harness.home);

    const { exitCode, stderr } = await harness.run(['uninstall'], { interactive: true, input: '\n' });

    assert.equal(exitCode, EXIT.OK);
    assert.match(stderr, /Remove \d+ recorded items?\n[\s\S]*\[y\/N\] /);
    assert.deepEqual(await listTree(harness.home), before);
  });

  it('exits 9 when it cannot ask and --yes was not given', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);

    const { exitCode } = await harness.run(['uninstall']);

    assert.equal(exitCode, EXIT.CONSENT_REQUIRED);
    await fs.access(harness.paths.installManifest);
  });

  it('prints the plan and removes nothing with --dry-run', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const before = await listTree(harness.home);

    const { exitCode, stderr } = await harness.run(['uninstall', '--dry-run']);

    assert.equal(exitCode, EXIT.OK);
    assert.match(stderr, /Would remove:/);
    assert.match(stderr, /npm rm -g opencode-unity/);
    assert.deepEqual(await listTree(harness.home), before);
  });

  it('keeps state and projects with --keep-data, and drops the removed entries from the record', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);

    await harness.run(['uninstall', '--keep-data', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.deepEqual(manifest.entries, []);
    assert.deepEqual(await listTree(harness.home), ['state/', 'state/install-manifest.json']);
  });

  it('prints the global npm removal and never runs it', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ opencode: 'missing' }) });
    await harness.run(['setup', '--no-model', ...YES]);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    assert.ok(envelope.data.commands.includes('npm rm -g opencode-ai'));
    assert.deepEqual(harness.npm.commands, ['install -g opencode-ai@1.18.31']);
  });

  it('removes an unchanged in-project folder with --projects and keeps an edited one', async (t) => {
    const harness = await createHarness(t);
    const unchanged = harness.sandbox.path('UnityA', '.opencode-unity');
    const edited = harness.sandbox.path('UnityB', '.opencode-unity');
    for (const directory of [unchanged, edited]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'facts.md'), '# facts\n', 'utf8');
    }
    const manifest = createManifest(harness.version);
    manifest.entries.push(
      { kind: 'projectDir', path: unchanged, sha256Tree: await sha256Tree(unchanged), createdBy: `init@${harness.version}` },
      { kind: 'projectDir', path: edited, sha256Tree: await sha256Tree(edited), createdBy: `init@${harness.version}` },
    );
    await saveManifest(harness.paths.installManifest, manifest);
    await fs.appendFile(path.join(edited, 'facts.md'), 'edited\n', 'utf8');

    await harness.run(['uninstall', '--projects', ...YES]);

    await assert.rejects(fs.access(unchanged));
    await fs.access(edited);
  });

  it('keeps in-project folders without --projects', async (t) => {
    const harness = await createHarness(t);
    const folder = harness.sandbox.path('UnityA', '.opencode-unity');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'facts.md'), '# facts\n', 'utf8');
    const manifest = createManifest(harness.version);
    manifest.entries.push({ kind: 'projectDir', path: folder, sha256Tree: await sha256Tree(folder), createdBy: `init@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);

    const { envelope } = await harness.run(['uninstall', ...YES]);

    await fs.access(folder);
    assert.ok(envelope.data.kept.some((/** @type {string} */ line) => /pass --projects/.test(line)));
  });

  it('does not even ask about in-project folders without --projects', async (t) => {
    const harness = await createHarness(t);
    const folder = harness.sandbox.path('UnityA', '.opencode-unity');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'facts.md'), '# facts\n', 'utf8');
    const manifest = createManifest(harness.version);
    manifest.entries.push({ kind: 'projectDir', path: folder, sha256Tree: await sha256Tree(folder), createdBy: `init@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);

    const { stderr } = await harness.run(['uninstall'], { interactive: true, input: 'y\n' });

    assert.equal(stderr.match(/Accept\?/g)?.length, 1);
    assert.doesNotMatch(stderr, /Remove \d+ in-project folder/);
    await fs.access(folder);
  });
});
