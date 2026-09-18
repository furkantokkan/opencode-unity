// `setup` end to end (spec 14.1, 5.1): consent per item, the platform block before the first question,
// idempotent re-runs, --dry-run, and the rollback of a failed apply.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { createPrintOnlyAdapter } from '../../src/install/user-env.js';
import { BASE_MODEL, MODEL_TAG, createFakeModels, createFakeOllama, createFakeUserEnv, createHarness, listTree, platformFacts, preflightFacts, readManifestFile } from './helpers.mjs';

const YES = ['--yes'];

describe('setup consent', () => {
  it('exits 9 and names every consent it needs when it cannot ask', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope } = await harness.run(['setup', '--no-model']);

    assert.equal(exitCode, EXIT.CONSENT_REQUIRED);
    assert.equal(envelope.code, 'consent_required');
    assert.deepEqual(
      envelope.data.consents.map((/** @type {{ id: string }} */ consent) => consent.id),
      ['profile-render'],
    );
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('lists the download and the tag as well when a model is wanted', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const harness = await createHarness(t, { ollamaClient });

    const { envelope } = await harness.run(['setup']);

    assert.deepEqual(
      envelope.data.consents.map((/** @type {{ id: string }} */ consent) => consent.id),
      ['model-pull', 'model-create', 'profile-render'],
    );
  });

  it('does not ask about a base model that is already in the store', async (t) => {
    const harness = await createHarness(t);

    const { envelope } = await harness.run(['setup']);

    assert.deepEqual(
      envelope.data.consents.map((/** @type {{ id: string }} */ consent) => consent.id),
      ['model-create', 'profile-render'],
    );
  });

  it('prints the platform block before the first question', async (t) => {
    const harness = await createHarness(t);

    const { stderr } = await harness.run(['setup', '--no-model', ...YES]);

    const block = stderr.indexOf('Platform support');
    const firstStep = stderr.indexOf('Write the clean-room profile');
    assert.ok(block >= 0, stderr);
    assert.ok(firstStep > block, 'the platform block comes first');
    assert.match(stderr, /system {8}/);
  });

  it('accepts only the recommended items with --yes, leaving the environment alone', async (t) => {
    const userEnv = createFakeUserEnv();
    const harness = await createHarness(t, { userEnv });

    const { exitCode } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(userEnv.writes, []);
  });

  it('treats an environment read failure as unset, with a warning, instead of aborting setup', async (t) => {
    const userEnv = createFakeUserEnv();
    const failing = {
      ...userEnv,
      async read() {
        throw new Error('Windows PowerShell did not answer within 60000 ms');
      },
    };
    const harness = await createHarness(t, { userEnv: failing });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.ok(
      envelope?.warnings.some((warning) => warning.includes('Could not read the user environment variable OLLAMA_FLASH_ATTENTION')),
      `warnings: ${JSON.stringify(envelope?.warnings)}`,
    );
    assert.deepEqual(userEnv.writes, [], 'nothing is written on a probe failure');
  });

  it('writes the environment when --ollama-env preselects it, recording the previous value', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    const harness = await createHarness(t, { userEnv });

    const { exitCode } = await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.equal(userEnv.values.get('OLLAMA_KV_CACHE_TYPE'), 'q8_0');
    const manifest = await readManifestFile(harness.paths.installManifest);
    const entry = manifest.entries.find((candidate) => candidate.kind === 'userEnv' && candidate.name === 'OLLAMA_KV_CACHE_TYPE');
    assert.equal(entry?.previous, 'f16');
    assert.equal(entry?.value, 'q8_0');
  });
});

describe('setup on a print-only platform', () => {
  it('prints the Ollama variables as a systemd drop-in and writes none of them', async (t) => {
    const harness = await createHarness(t, { userEnv: /** @type {any} */ (createPrintOnlyAdapter()) });

    const { exitCode, stderr } = await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.match(stderr, /sudo systemctl edit ollama/);
    assert.match(stderr, /Environment="OLLAMA_KV_CACHE_TYPE=q8_0"/);
    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(manifest.entries.some((entry) => entry.kind === 'userEnv' || entry.kind === 'launchctlEnv'), false);
  });
});

describe('setup apply', () => {
  it('writes the profile, the isolated config home and the manifest', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    const tree = await listTree(harness.home);
    const profile = `profile/${harness.version}`;
    assert.ok(tree.includes(`${profile}/opencode.jsonc`), tree.join(','));
    assert.ok(tree.includes(`${profile}/agents/unity-code.md`));
    assert.ok(tree.includes(`${profile}/opencode-unity.runtime.json`));
    assert.ok(tree.includes(`${profile}/plugins/opencode-unity.js`));
    assert.ok(tree.includes(`${profile}/plugins/opencode-unity-lib/toast.js`));
    assert.ok(tree.includes('xdg-config/'));
    assert.ok(tree.includes('config.json'));
    assert.ok(tree.includes('profile/current.json'));
    assert.ok(tree.includes('state/install-manifest.json'));
    assert.equal(envelope.data.preset, 'nvidia-24gb-qwen3-coder-30b-16k');
  });

  it('records every written file with the hash it actually wrote', async (t) => {
    const harness = await createHarness(t);

    await harness.run(['setup', '--no-model', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.cliVersion, harness.version);
    for (const entry of manifest.entries.filter((candidate) => candidate.kind === 'file')) {
      assert.match(/** @type {string} */ (entry.sha256), /^[0-9a-f]{64}$/);
      assert.notEqual(entry.sha256, '0'.repeat(64));
      await fs.access(/** @type {string} */ (entry.path));
    }
    const kinds = new Set(manifest.entries.map((entry) => entry.kind));
    assert.deepEqual([...kinds].sort(), ['dir', 'file']);
  });

  it('pulls and creates the model, and records both', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const models = createFakeModels({ installed: ollamaClient.installed });
    const harness = await createHarness(t, { ollamaClient, models, preflight: preflightFacts({ models: [] }) });

    const { exitCode } = await harness.run(['setup', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(models.commands, [`pull ${BASE_MODEL}`, `create ${MODEL_TAG}`]);
    const manifest = await readManifestFile(harness.paths.installManifest);
    const recorded = manifest.entries.filter((entry) => entry.kind === 'ollamaModel');
    assert.deepEqual(
      recorded.map((entry) => [entry.name, entry.pulledBySetup, entry.derived]),
      [
        [BASE_MODEL, true, false],
        [MODEL_TAG, false, true],
      ],
    );
  });

  it('does not claim it downloaded a base model that was already there', async (t) => {
    const harness = await createHarness(t);

    await harness.run(['setup', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    const base = manifest.entries.find((entry) => entry.kind === 'ollamaModel' && entry.name === BASE_MODEL);
    assert.equal(base?.pulledBySetup, false);
    assert.deepEqual(harness.models.commands, [`create ${MODEL_TAG}`]);
  });

  it('changes nothing on a second run and says so', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);
    const before = await listTree(harness.home);
    const commands = [...harness.models.commands];

    const { exitCode, envelope } = await harness.run(['setup', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.match(envelope.message, /already in place/);
    assert.deepEqual(await listTree(harness.home), before);
    assert.deepEqual(harness.models.commands, commands);
  });

  it('asks nothing on a settled re-run, so it works without --yes', async (t) => {
    const harness = await createHarness(t);
    await harness.run(['setup', ...YES]);

    const { exitCode } = await harness.run(['setup']);

    assert.equal(exitCode, EXIT.OK);
  });

  it('still records a base model as downloaded by setup after a second run', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const harness = await createHarness(t, { ollamaClient });
    await harness.run(['setup', ...YES]);

    await harness.run(['setup', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    const base = manifest.entries.find((entry) => entry.kind === 'ollamaModel' && entry.name === BASE_MODEL);
    assert.equal(base?.pulledBySetup, true);
    assert.deepEqual(harness.models.commands, [`pull ${BASE_MODEL}`, `create ${MODEL_TAG}`]);
  });

  it('remembers the value from before the first setup through a second one', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    const harness = await createHarness(t, { userEnv });
    await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    const entry = manifest.entries.find((candidate) => candidate.kind === 'userEnv' && candidate.name === 'OLLAMA_KV_CACHE_TYPE');
    assert.equal(entry?.previous, 'f16');
  });

  it('records nothing for a variable the user had already set to the same value', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_NUM_PARALLEL: '1' });
    const harness = await createHarness(t, { userEnv });

    await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(
      manifest.entries.some((entry) => entry.kind === 'userEnv' && entry.name === 'OLLAMA_NUM_PARALLEL'),
      false,
    );
  });

  it('never replaces an existing config.json', async (t) => {
    const harness = await createHarness(t);
    await fs.mkdir(harness.home, { recursive: true });
    await fs.writeFile(harness.paths.config, '{ "schemaVersion": 1, "preset": "nvidia-24gb-qwen3-coder-30b-16k" }\n', 'utf8');

    await harness.run(['setup', '--no-model', ...YES]);

    assert.match(await fs.readFile(harness.paths.config, 'utf8'), /^\{ "schemaVersion"/);
    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(
      manifest.entries.some((entry) => entry.kind === 'file' && entry.path === harness.paths.config),
      false,
    );
  });
});

describe('setup preset choice', () => {
  it('says so when it falls back to the configured preset because nothing was recommended', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ totalVramMiB: null }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.ok(envelope.warnings.some((warning) => /No preset is recommended/.test(warning)), envelope.warnings.join('|'));
  });

  it('recommends no preset for an AMD card and says which one it used instead', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'linux', backend: 'amdgpu-sysfs' }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', '--experimental', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.ok(envelope.warnings.some((warning) => /No preset is recommended/.test(warning)));
  });

  it('exits 8 on macOS, where no shipped preset applies', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'darwin', arch: 'arm64', backend: 'darwin-unified' }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', '--experimental', ...YES]);

    assert.equal(exitCode, EXIT.UNSUPPORTED);
    assert.equal(envelope.code, 'preset_platform_unsupported');
  });

  it('refuses an experimental preset named with --preset unless --experimental', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', '--preset', 'nvidia-24gb-qwen3-coder-30b-32k', ...YES]);

    assert.equal(exitCode, EXIT.UNSUPPORTED);
    assert.equal(envelope.code, 'preset_experimental');
  });
});

describe('setup Windows Terminal fragment', { skip: process.platform !== 'win32' && 'the fragment exists on Windows only' }, () => {
  it('writes one profile per initialized project, and uninstall leaves Windows Terminal exactly as it was', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ windowsTerminal: true }) });
    const terminalDir = path.join(harness.sandbox.dirs.localAppData, 'Microsoft', 'Windows Terminal');
    await fs.mkdir(terminalDir, { recursive: true });
    await fs.writeFile(path.join(terminalDir, 'settings.json'), '{ "profiles": {} }\n', 'utf8');
    await fs.writeFile(path.join(harness.sandbox.dirs.bin, 'opencode-unity.cmd'), '', 'utf8');
    await fs.mkdir(harness.paths.projectsRoot, { recursive: true });
    await fs.writeFile(harness.paths.projectsIndex, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'MyGame-1a2b3c4d', name: 'MyGame', path: harness.sandbox.path('MyGame'), lastStart: null, factsVersion: 1 }] }), 'utf8');
    const before = await listTree(harness.sandbox.dirs.localAppData);
    const env = { PATH: harness.sandbox.dirs.bin, PATHEXT: '.CMD' };

    const { exitCode } = await harness.run(['setup', '--no-model', ...YES], { env });

    assert.equal(exitCode, EXIT.OK);
    const fragment = path.join(terminalDir, 'Fragments', 'opencode-unity', 'profiles.json');
    const bytes = await fs.readFile(fragment);
    assert.notEqual(bytes[0], 0xef, 'no byte-order mark');
    assert.equal(JSON.parse(bytes.toString('utf8')).profiles[0].name, 'Unity local LLM - MyGame');
    const manifest = await readManifestFile(harness.paths.installManifest);
    const entry = manifest.entries.find((candidate) => candidate.kind === 'wtFragment');
    assert.equal(entry?.path, fragment);
    assert.equal(entry?.createdRoot, path.join(terminalDir, 'Fragments'));

    await harness.run(['uninstall', ...YES], { env });

    assert.deepEqual(await listTree(harness.sandbox.dirs.localAppData), before.filter((line) => !line.startsWith('opencode-unity')));
    assert.equal(await fs.readFile(path.join(terminalDir, 'settings.json'), 'utf8'), '{ "profiles": {} }\n');
  });

  it('writes no fragment, and says why, while the launcher is not on PATH yet', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ windowsTerminal: true }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES], { env: { PATH: harness.sandbox.dirs.bin } });

    assert.equal(exitCode, EXIT.OK);
    assert.ok(envelope.warnings.some((warning) => /not on PATH yet/.test(warning)));
    const manifest = await readManifestFile(harness.paths.installManifest);
    assert.equal(manifest.entries.some((entry) => entry.kind === 'wtFragment'), false);
  });

  it('keeps a fragment directory another program has written into', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ windowsTerminal: true }) });
    await fs.writeFile(path.join(harness.sandbox.dirs.bin, 'opencode-unity.cmd'), '', 'utf8');
    const env = { PATH: harness.sandbox.dirs.bin, PATHEXT: '.CMD' };
    await harness.run(['setup', '--no-model', ...YES], { env });
    const fragments = path.join(harness.sandbox.dirs.localAppData, 'Microsoft', 'Windows Terminal', 'Fragments');
    await fs.mkdir(path.join(fragments, 'other-app'), { recursive: true });
    await fs.writeFile(path.join(fragments, 'other-app', 'profiles.json'), '{}', 'utf8');

    await harness.run(['uninstall', ...YES], { env });

    await assert.rejects(fs.access(path.join(fragments, 'opencode-unity')));
    await fs.access(path.join(fragments, 'other-app', 'profiles.json'));
  });
});

describe('setup --dry-run', () => {
  it('prints the plan and writes nothing', async (t) => {
    const ollamaClient = createFakeOllama({ models: [] });
    const harness = await createHarness(t, { ollamaClient, preflight: preflightFacts({ models: [] }) });

    const { exitCode, envelope, stderr } = await harness.run(['setup', '--dry-run']);

    assert.equal(exitCode, EXIT.OK);
    assert.equal(envelope.data.dryRun, true);
    assert.match(stderr, /Download the base model/);
    assert.match(stderr, /create model tag ocu-qwen3-coder-30b-16k/);
    assert.deepEqual(await listTree(harness.home), []);
  });
});

describe('setup platform gates', () => {
  it('does not let --yes stand in for --experimental on an experimental row', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'linux' }) });

    const { exitCode, stderr } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.UNSUPPORTED);
    assert.match(stderr, /setup {9}experimental/);
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('treats --experimental as the acknowledgement', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'linux' }) });

    const { exitCode, stderr } = await harness.run(['setup', '--no-model', '--experimental', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.match(stderr, /acknowledged by --experimental/);
  });

  it('asks nothing about the platform on a full row', async (t) => {
    const harness = await createHarness(t);

    const { stderr } = await harness.run(['setup', '--no-model', ...YES]);

    assert.doesNotMatch(stderr, /experimental platform row/);
  });

  it('exits 8 before anything is asked on a refused row', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'linux', virtualization: 'container' }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.UNSUPPORTED);
    assert.equal(envelope.data.platform.tier, 'refused');
  });

  it('refuses --terminal off Windows', async (t) => {
    const harness = await createHarness(t, { facts: platformFacts({ os: 'linux' }) });

    const { exitCode, envelope } = await harness.run(['setup', '--terminal', '--experimental', ...YES]);

    assert.equal(exitCode, EXIT.USAGE);
    assert.match(envelope.message, /--terminal/);
  });
});

describe('setup preconditions', () => {
  it('exits 2 when Ollama does not answer and a model is wanted', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ ollama: 'down', models: [] }) });

    const { exitCode, envelope } = await harness.run(['setup', ...YES]);

    assert.equal(exitCode, EXIT.BLOCKED);
    assert.equal(envelope.code, 'ollama_unreachable');
  });

  it('still writes the profile with --no-model while Ollama is down', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ ollama: 'down', models: [] }) });

    const { exitCode } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
  });

  it('offers the global OpenCode install only when OpenCode is missing', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ opencode: 'missing' }) });

    const { exitCode } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(harness.npm.commands, ['install -g opencode-ai@1.18.31']);
  });

  it('leaves another OpenCode version alone and warns instead', async (t) => {
    const harness = await createHarness(t, { preflight: preflightFacts({ opencode: 'other' }) });

    const { exitCode, envelope } = await harness.run(['setup', '--no-model', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(harness.npm.commands, []);
    assert.ok(envelope.warnings.some((warning) => /1\.17\.0 is installed/.test(warning)), envelope.warnings.join('|'));
  });

  it('says --delegate moved to --host', async (t) => {
    const harness = await createHarness(t);

    const { envelope, stderr } = await harness.run(['setup', '--no-model', '--delegate', 'claude', ...YES]);

    assert.ok(envelope.warnings.some((warning) => /--delegate is now --host/.test(warning)));
    assert.match(stderr, /opencode-unity host install --host claude/);
  });

  it('accepts --host through the registry, with every host id, and prints no deprecation notice', async (t) => {
    const harness = await createHarness(t);

    const { exitCode, envelope, stderr } = await harness.run(['setup', '--no-model', '--host', 'codex,antigravity', ...YES]);

    assert.equal(exitCode, EXIT.OK);
    assert.ok(!envelope.warnings.some((warning) => /--delegate is now --host/.test(warning)));
    assert.match(stderr, /opencode-unity host install --host codex,antigravity/);
  });
});

describe('setup rollback', () => {
  it('puts everything back when an operation fails', async (t) => {
    const harness = await createHarness(t, {
      onOperation: (operation) => {
        if (operation.op === 'createModel') throw new Error('the model tag could not be created');
      },
    });

    const { exitCode, envelope } = await harness.run(['setup', ...YES]);

    assert.equal(exitCode, EXIT.RUNTIME);
    assert.match(envelope.message, /rolled back/);
    assert.equal(envelope.data.rolledBack, true);
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('removes a model tag it created before a later step failed', async (t) => {
    const harness = await createHarness(t, {
      onOperation: (operation) => {
        if (operation.op === 'writeFile' && operation.path.endsWith('current.json')) throw new Error('disk full');
      },
    });

    const { exitCode } = await harness.run(['setup', ...YES]);

    assert.equal(exitCode, EXIT.RUNTIME);
    assert.deepEqual(harness.models.commands, [`create ${MODEL_TAG}`, `rm ${MODEL_TAG}`]);
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('restores an environment variable it had changed', async (t) => {
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    // The last variable fails, so every earlier one was already written and has to be put back.
    const harness = await createHarness(t, {
      userEnv,
      onOperation: (operation) => {
        if (operation.op === 'setEnv' && operation.name === 'OLLAMA_KEEP_ALIVE') throw new Error('access denied');
      },
    });

    const { exitCode } = await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    assert.equal(exitCode, EXIT.RUNTIME);
    assert.equal(userEnv.values.get('OLLAMA_KV_CACHE_TYPE'), 'f16');
    assert.equal(userEnv.values.has('OLLAMA_FLASH_ATTENTION'), false);
    assert.ok(userEnv.writes.includes('restore OLLAMA_KV_CACHE_TYPE=f16'));
    assert.deepEqual(await listTree(harness.home), []);
  });

  it('keeps a file it replaced, by putting the backup back', async (t) => {
    const harness = await createHarness(t);
    const pointer = harness.paths.profileCurrent;
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, '{"version":"0.0.1","previous":null}\n', 'utf8');
    // The environment step runs after the pointer was replaced, so failing there proves the backup is
    // moved back rather than merely left beside a new file.
    harness.onOperation = (operation) => {
      if (operation.op === 'setEnv') throw new Error('stop here');
    };

    const { exitCode } = await harness.run(['setup', '--no-model', '--ollama-env', ...YES]);

    assert.equal(exitCode, EXIT.RUNTIME);
    assert.equal(await fs.readFile(pointer, 'utf8'), '{"version":"0.0.1","previous":null}\n');
    const siblings = await fs.readdir(path.dirname(pointer));
    assert.deepEqual(siblings, ['current.json']);
  });
});
