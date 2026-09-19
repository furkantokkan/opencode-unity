// `upgrade` end to end (spec 14.3): the new profile is rendered beside the old one, a file the user edited
// is carried over with the new template beside it as `.ocu-new`, the pointer remembers the previous
// version, and `--rollback` goes back to it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { saveManifest } from '../../src/install/manifest.js';
import { MODEL_TAG, createHarness, listTree, platformFacts, preflightFacts, readManifestFile } from './helpers.mjs';

const YES = ['--yes'];
const OLD_VERSION = '0.0.9';

/**
 * Turns a fresh setup into one an older CLI would have left: the profile directory, every manifest path
 * inside it, the manifest version and the pointer all name OLD_VERSION.
 * @param {Awaited<ReturnType<typeof createHarness>>} harness
 */
async function simulateOlderInstall(harness) {
  const currentDir = harness.paths.profile(harness.version).dir;
  const oldDir = harness.paths.profile(OLD_VERSION).dir;
  await fs.rename(currentDir, oldDir);
  const pointer = `${JSON.stringify({ version: OLD_VERSION, previous: null })}\n`;
  await fs.writeFile(harness.paths.profileCurrent, pointer, 'utf8');
  const manifest = await readManifestFile(harness.paths.installManifest);
  manifest.cliVersion = OLD_VERSION;
  manifest.entries = manifest.entries.map((entry) => {
    const next = { ...entry, createdBy: `setup@${OLD_VERSION}` };
    if (typeof entry.path === 'string' && (entry.path === currentDir || entry.path.startsWith(`${currentDir}${path.sep}`))) {
      next.path = oldDir + entry.path.slice(currentDir.length);
    }
    // The older CLI wrote this pointer, so the record holds its hash.
    if (entry.path === harness.paths.profileCurrent) next.sha256 = sha256Hex(pointer);
    return next;
  });
  await saveManifest(harness.paths.installManifest, manifest);
  return { oldDir, newDir: currentDir };
}

describe('upgrade preconditions', () => {
  it('asks for setup first when nothing is installed', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope } = await harness.run(['upgrade', ...YES]);

    assert.equal(exitCode, EXIT.USAGE);
    assert.match(envelope.message, /No install manifest/);
  });

  it('refuses an installation written by a newer version', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.writeFile(harness.paths.profileCurrent, `${JSON.stringify({ version: '9.0.0', previous: null })}\n`, 'utf8');

    const { exitCode, envelope } = await harness.run(['upgrade', ...YES]);

    assert.equal(exitCode, EXIT.VALIDATION);
    assert.equal(envelope.code, 'installation_newer');
  });
});

describe('upgrade from an older version', () => {
  it('migrates a preview v1 config only on apply and preserves released choices', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const { newDir } = await simulateOlderInstall(harness);
    const preview = {
      ...JSON.parse(await fs.readFile(harness.paths.config, 'utf8')),
      schemaVersion: 1,
      guard: { allowOffload: true },
      delegate: { enabled: false, monitorWindow: true },
      safety: { extraProtectedEditGlobs: ['*Art/*'] },
    };
    const text = JSON.stringify(preview, null, 2) + '\n';
    await fs.writeFile(harness.paths.config, text);

    const dry = await harness.run(['upgrade', '--dry-run']);
    assert.equal(dry.exitCode, EXIT.OK, dry.envelope.message);
    assert.ok(dry.envelope.data.steps.includes('config-migrate'));
    assert.equal(await fs.readFile(harness.paths.config, 'utf8'), text);

    const applied = await harness.run(['upgrade', ...YES]);
    assert.equal(applied.exitCode, EXIT.OK, applied.envelope.message);
    const config = JSON.parse(await fs.readFile(harness.paths.config, 'utf8'));
    assert.equal(config.schemaVersion, 2);
    assert.deepEqual(config.guard, preview.guard);
    assert.deepEqual(config.delegate, preview.delegate);
    assert.deepEqual(config.safety.extraProtectedEditGlobs, ['*Art/*']);
    const profile = JSON.parse(await fs.readFile(path.join(newDir, 'opencode-unity.runtime.json'), 'utf8'));
    assert.equal(profile.guard.allowOffload, true);
    assert.deepEqual(profile.safety.extraProtectedEditGlobs, ['*Art/*']);
  });

  it('renders the new profile, keeps the old one, and moves the pointer', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const { oldDir, newDir } = await simulateOlderInstall(harness);

    const { exitCode, envelope } = await harness.run(['upgrade', ...YES]);

    assert.equal(exitCode, EXIT.OK, envelope.message);
    await fs.access(path.join(newDir, 'opencode.jsonc'));
    await fs.access(path.join(oldDir, 'opencode.jsonc'));
    assert.deepEqual(JSON.parse(await fs.readFile(harness.paths.profileCurrent, 'utf8')), { version: harness.version, previous: OLD_VERSION });
    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(manifest.cliVersion, harness.version);
    assert.equal(envelope.data.from, OLD_VERSION);
  });

  it('carries an edited file over and writes the new template beside it', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const { oldDir, newDir } = await simulateOlderInstall(harness);
    await fs.appendFile(path.join(oldDir, 'agents', 'unity-code.md'), '\nmy house rule\n', 'utf8');

    const { envelope } = await harness.run(['upgrade', ...YES]);

    const carried = await fs.readFile(path.join(newDir, 'agents', 'unity-code.md'), 'utf8');
    assert.match(carried, /my house rule/);
    const template = await fs.readFile(path.join(newDir, 'agents', 'unity-code.md.ocu-new'), 'utf8');
    assert.doesNotMatch(template, /my house rule/);
    assert.deepEqual(envelope.data.carriedOver, ['agents/unity-code.md']);
  });

  it('writes nothing with --dry-run', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);
    const before = await listTree(harness.home);

    const { exitCode, envelope } = await harness.run(['upgrade', '--dry-run']);

    assert.equal(exitCode, EXIT.OK);
    assert.equal(envelope.data.dryRun, true);
    assert.deepEqual(await listTree(harness.home), before);
  });

  it('exits 9 when it cannot ask and --yes was not given', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);

    const { exitCode } = await harness.run(['upgrade']);

    assert.equal(exitCode, EXIT.CONSENT_REQUIRED);
  });

  it('an uninstall after the upgrade still leaves no residue', async (t) => {
    const harness = await createHarness(t);
    const before = await listTree(harness.sandbox.root);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);
    await harness.run(['upgrade', ...YES]);

    const { exitCode } = await harness.run(['uninstall', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(await listTree(harness.sandbox.root), before);
  });
});

describe('upgrade at the same version', () => {
  it('finds the version in the manifest when the pointer is missing, and changes nothing', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.rm(harness.paths.profileCurrent);

    const { exitCode, envelope } = await harness.run(['upgrade', ...YES]);

    assert.equal(exitCode, EXIT.OK, envelope.message);
    assert.equal(envelope.data.from, harness.version);
    assert.deepEqual(envelope.data.carriedOver, []);
  });

  it('warns that start needs --experimental for a preset that is experimental here', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    harness.facts = platformFacts({ os: 'linux' });

    const { envelope } = await harness.run(['upgrade', '--dry-run']);

    assert.ok(envelope.warnings.some((warning) => /experimental on linux/.test(warning)), envelope.warnings.join('|'));
  });

  it('keeps a model tag it could not remove, and says why', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);
    const manifest = await readManifestFile(harness.paths.installManifest);
    manifest.entries.push({ kind: 'ollamaModel', name: 'ocu-old', pulledBySetup: false, derived: true, createdBy: `setup@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);
    const failing = { ...harness.models, remove: async () => { throw new Error('in use'); } };

    const { envelope } = await harness.run(['upgrade', '--prune-models', ...YES], { dependencies: { models: failing } });

    assert.deepEqual(envelope.data.removedTags, []);
    assert.ok(envelope.warnings.some((warning) => /ocu-old could not be removed: in use/.test(warning)));
  });
});

describe('upgrade notices', () => {
  it('says a new model tag is needed when the recorded tag is not the preset tag', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);
    const manifest = await readManifestFile(harness.paths.installManifest);
    manifest.entries = manifest.entries.map((entry) => (entry.name === MODEL_TAG ? { ...entry, name: 'ocu-qwen3-coder-30b-8k' } : entry));
    await saveManifest(harness.paths.installManifest, manifest);

    const { stderr } = await harness.run(['upgrade', '--dry-run']);

    assert.match(stderr, /create a new model tag/);
  });

  it('asks to re-scan projects whose facts an older generator wrote', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await fs.mkdir(harness.paths.projectsRoot, { recursive: true });
    await fs.writeFile(harness.paths.projectsIndex, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'Old-00000000', name: 'Old', path: '/p', lastStart: null, factsVersion: 0 }] }), 'utf8');

    const { stderr } = await harness.run(['upgrade', '--dry-run']);

    assert.match(stderr, /init --refresh': Old-00000000/);
  });
});

describe('upgrade of the Windows Terminal fragment', { skip: process.platform !== 'win32' && 'the fragment exists on Windows only' }, () => {
  it('re-renders a fragment that is still exactly ours', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ windowsTerminal: true }) });
    await fs.writeFile(path.join(harness.sandbox.dirs.bin, 'opencode-unity.cmd'), '', 'utf8');
    const env = { PATH: harness.sandbox.dirs.bin, PATHEXT: '.CMD' };
    await harness.run(['setup', '--no-model', ...YES], { env });
    await simulateOlderInstall(harness);
    await fs.mkdir(harness.paths.projectsRoot, { recursive: true });
    await fs.writeFile(harness.paths.projectsIndex, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'New-11111111', name: 'New', path: harness.sandbox.path('New'), lastStart: null, factsVersion: 1 }] }), 'utf8');

    const { exitCode } = await harness.run(['upgrade', ...YES], { env });

    assert.equal(exitCode, EXIT.OK);
    const fragment = path.join(harness.sandbox.dirs.localAppData, 'Microsoft', 'Windows Terminal', 'Fragments', 'opencode-unity', 'profiles.json');
    assert.equal(JSON.parse(await fs.readFile(fragment, 'utf8')).profiles[0].name, 'Unity local LLM - New');
  });
});

describe('setup --migrate', () => {
  it('runs the same migration as upgrade', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);

    const { exitCode, envelope } = await harness.run(['setup', '--migrate', ...YES]);

    assert.equal(exitCode, EXIT.OK, envelope.message);
    assert.equal(envelope.data.from, OLD_VERSION);
    assert.deepEqual(JSON.parse(await fs.readFile(harness.paths.profileCurrent, 'utf8')), { version: harness.version, previous: OLD_VERSION });
  });
});

describe('upgrade --rollback', () => {
  it('points back at the previous profile and prints the npm command', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);
    await harness.run(['upgrade', ...YES]);

    const { exitCode, envelope } = await harness.run(['upgrade', '--rollback', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.equal(envelope.data.command, `npm i -g opencode-unity@${OLD_VERSION}`);
    assert.deepEqual(JSON.parse(await fs.readFile(harness.paths.profileCurrent, 'utf8')), { version: OLD_VERSION, previous: null });
  });

  it('asks first, like every other change', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);
    await harness.run(['upgrade', ...YES]);
    const before = await fs.readFile(harness.paths.profileCurrent, 'utf8');

    const refused = await harness.run(['upgrade', '--rollback']);
    const declined = await harness.run(['upgrade', '--rollback'], { interactive: true, input: 'n\n' });
    const dry = await harness.run(['upgrade', '--rollback', '--dry-run']);

    assert.equal(refused.exitCode, EXIT.CONSENT_REQUIRED);
    assert.match(declined.envelope.message, /Nothing was changed/);
    assert.equal(dry.envelope.data.dryRun, true);
    assert.equal(await fs.readFile(harness.paths.profileCurrent, 'utf8'), before);
  });

  it('leaves nothing behind for uninstall to miss after a rollback', async (t) => {
    const harness = await createHarness(t);
    const tree = await listTree(harness.sandbox.root);
    await harness.run(['setup', '--no-model', ...YES]);
    await simulateOlderInstall(harness);
    await harness.run(['upgrade', ...YES]);
    await harness.run(['upgrade', '--rollback', ...YES]);

    await harness.run(['uninstall', ...YES]);

    assert.deepEqual(await listTree(harness.sandbox.root), tree);
  });

  it('says so when there is nothing to go back to', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);

    const { exitCode, envelope } = await harness.run(['upgrade', '--rollback']);

    assert.equal(exitCode, EXIT.VALIDATION);
    assert.equal(envelope.code, 'rollback_unavailable');
  });

  it('refuses when the previous profile directory is gone', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', '--no-model', ...YES]);
    const { oldDir } = await simulateOlderInstall(harness);
    await harness.run(['upgrade', ...YES]);
    await fs.rm(oldDir, { recursive: true, force: true });

    const { exitCode, envelope } = await harness.run(['upgrade', '--rollback']);

    assert.equal(exitCode, EXIT.VALIDATION);
    assert.match(envelope.message, /no longer in/);
  });
});

describe('upgrade --prune-models', () => {
  it('removes older created tags and keeps the current one', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);
    const manifest = await readManifestFile(harness.paths.installManifest);
    manifest.entries.push({ kind: 'ollamaModel', name: 'ocu-qwen3-coder-30b-16k-old', pulledBySetup: false, derived: true, createdBy: `setup@${harness.version}` });
    await saveManifest(harness.paths.installManifest, manifest);

    const { exitCode, envelope } = await harness.run(['upgrade', '--prune-models', ...YES]);

    assert.equal(exitCode, EXIT.OK, envelope.message);
    assert.deepEqual(envelope.data.removedTags, ['ocu-qwen3-coder-30b-16k-old']);
    assert.equal(harness.models.commands.includes(`rm ${MODEL_TAG}`), false);
    const after = await readManifestFile(harness.paths.installManifest);
    assert.equal(after.entries.some((entry) => entry.name === 'ocu-qwen3-coder-30b-16k-old'), false);
    assert.equal(after.entries.some((entry) => entry.name === MODEL_TAG), true);
  });
});
