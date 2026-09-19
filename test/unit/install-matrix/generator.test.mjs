import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, OUTPUT_FILES, SHELLS, buildInstallMatrix, generateInstallArtifacts, main, quoteLiteral, readInstallInputs, renderInstallReference, validateInstallMatrix } from '../../../scripts/gen-install-docs.mjs';

// A source override lets an isolated implementation worktree validate against the integration
// registry/schema before those separately owned files are merged; normal CI uses this repository.
const sourceRoot = process.env.OPENCODE_UNITY_TEST_INSTALL_SOURCE ?? ROOT;
const inputs = await readInstallInputs(sourceRoot);
const matrix = buildInstallMatrix(inputs);
const copy = () => JSON.parse(JSON.stringify(matrix));

describe('generated installation matrix', () => {
  it('uses the package, compat and default preset as its only version and model sources', () => {
    assert.equal(matrix.cliVersion, inputs.packageJson.version);
    assert.equal(matrix.pins.opencodeUnity, inputs.packageJson.version);
    assert.equal(matrix.pins.opencode, inputs.compat.opencode.tested);
    assert.equal(matrix.pins.ollama, inputs.compat.ollama.tested);
    assert.equal(matrix.pins.node, inputs.packageJson.engines.node);
    assert.equal(matrix.pins.modelBase, inputs.preset.model.base);
    assert.equal(matrix.pins.modelDownloadGiB, inputs.preset.model.downloadGiB);
    assert.doesNotThrow(() => validateInstallMatrix(matrix, inputs));
  });

  it('covers four shells and pins the same GitHub release asset in each', () => {
    assert.deepEqual(matrix.shells.map((shell) => shell.id), ['powershell', 'cmd', 'zsh', 'bash']);
    const bootstrap = matrix.steps.find((step) => step.id === 'install-cli');
    for (const shell of SHELLS) {
      const command = bootstrap.commands[shell.id];
      assert.match(command, /^npm install -g ["']https:\/\/github\.com\//);
      assert.ok(command.includes(`/v${matrix.cliVersion}/opencode-unity-${matrix.cliVersion}.tgz`));
      assert.doesNotMatch(command, /@latest|#main|#master/);
    }
  });

  it('does not advertise a full macOS or Linux setup or inference path', () => {
    for (const step of matrix.steps.filter((entry) => entry.id === 'preview-setup' || entry.id === 'configure-runtime')) {
      for (const shell of ['zsh', 'bash']) assert.equal(typeof step.commands[shell].notApplicable, 'string');
    }
    for (const shell of ['zsh', 'bash']) {
      assert.match(matrix.steps.find((entry) => entry.id === 'diagnose').commands[shell], /^opencode-unity doctor/);
      assert.match(matrix.steps.find((entry) => entry.id === 'initialize-project').commands[shell], /^opencode-unity init/);
    }
    assert.equal(matrix.steps.some((step) => Object.values(step.commands).some((command) => typeof command === 'string' && /opencode-unity (start|warm|delegate)/.test(command))), false);
  });

  it('marks every persistent effect and keeps the previews and checks read-only', () => {
    for (const step of matrix.steps) {
      assert.equal(step.persistent, !step.readOnly, step.id);
      assert.equal(Array.isArray(step.manifestKinds), !step.readOnly, step.id);
      for (const command of Object.values(step.commands)) if (typeof command === 'string') assert.doesNotMatch(command, /--yes\b/);
    }
    for (const id of ['check-node', 'check-cli', 'diagnose', 'preview-setup', 'verify-hosts', 'preview-project', 'preview-removal']) {
      assert.equal(matrix.steps.find((step) => step.id === id).readOnly, true, id);
    }
    for (const id of ['install-cli', 'configure-runtime', 'install-hosts', 'initialize-project', 'update-hosts', 'remove-hosts']) {
      assert.equal(matrix.steps.find((step) => step.id === id).persistent, true, id);
    }
  });

  it('rejects a planned command flag that is absent from the actual registry', () => {
    const changed = copy();
    changed.steps.find((step) => step.id === 'diagnose').commands.powershell = 'opencode-unity doctor --not-implemented';
    assert.throws(() => validateInstallMatrix(changed, inputs), /not-implemented|Unknown option/);
  });

  it('refuses to generate host commands when their implementation is unavailable', () => {
    assert.throws(() => buildInstallMatrix({ ...inputs, isAvailable: (command) => command.name !== 'host' && inputs.isAvailable(command) }), /host is not implemented/);
  });

  it('rejects incomplete shell coverage, duplicate IDs and inconsistent write classification', () => {
    const missing = copy();
    delete missing.steps[0].commands.cmd;
    assert.throws(() => validateInstallMatrix(missing, inputs), /Invalid install matrix/);
    const duplicate = copy();
    duplicate.steps.push(duplicate.steps[0]);
    assert.throws(() => validateInstallMatrix(duplicate, inputs), /Duplicate install step/);
    const readonly = copy();
    readonly.steps.find((step) => step.id === 'install-cli').readOnly = true;
    assert.throws(() => validateInstallMatrix(readonly, inputs), /Invalid install matrix/);
  });

  it('rejects a disagreement between the Node engine requirement and compatibility table', () => {
    assert.throws(() => buildInstallMatrix({ ...inputs, packageJson: { ...inputs.packageJson, engines: { node: '>=999' } } }), /disagree on the Node minimum/);
  });

  it('regenerates all CLI package references after a version change', () => {
    const next = buildInstallMatrix({ ...inputs, packageJson: { ...inputs.packageJson, version: '7.8.9-preview.1' } });
    const bootstrap = next.steps.find((step) => step.id === 'install-cli');
    for (const command of Object.values(bootstrap.commands)) assert.ok(command.includes('v7.8.9-preview.1/opencode-unity-7.8.9-preview.1.tgz'));
    const docs = renderInstallReference(next);
    assert.ok(docs.includes('7.8.9-preview.1'));
    assert.equal(docs.includes(matrix.cliVersion), false);
  });

  it('explains bootstrap ownership and separates removal commands from installation blocks', () => {
    const text = renderInstallReference(matrix);
    assert.match(text, /npm bootstrap is owned by npm/);
    assert.match(text, /product uninstall does not remove the CLI package/);
    const split = text.indexOf('## Optional maintenance');
    assert.ok(split > 0);
    assert.equal(text.slice(0, split).includes('opencode-unity host uninstall'), false);
    assert.equal(text.slice(split).includes('opencode-unity host uninstall'), true);
  });
});

describe('shell literal quoting', () => {
  it('quotes spaces in all four shells and apostrophes with each supported convention', () => {
    for (const shell of SHELLS) assert.equal(quoteLiteral('Project Name', shell.id), shell.id === 'cmd' ? '"Project Name"' : "'Project Name'");
    assert.equal(quoteLiteral("O'Brien", 'powershell'), "'O''Brien'");
    assert.equal(quoteLiteral("O'Brien", 'bash'), "'O'\\''Brien'");
    assert.equal(quoteLiteral("O'Brien", 'zsh'), "'O'\\''Brien'");
  });

  it('refuses line injection and CMD expansion or ambiguous quoting', () => {
    for (const shell of SHELLS) {
      assert.throws(() => quoteLiteral('first\nsecond', shell.id), /line break/);
      assert.throws(() => quoteLiteral('first\0second', shell.id), /NUL/);
    }
    for (const value of ['%PATH%', '!NAME!', 'double"quote', 'escape^']) assert.throws(() => quoteLiteral(value, 'cmd'), /unsupported/);
    assert.throws(() => quoteLiteral('path', 'fish'), /Unknown shell/);
  });
});

describe('artifact regeneration and check mode', () => {
  it('writes reproducible artifacts, detects drift, and never repairs files in --check mode', async (t) => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-install-docs-'));
    t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
    const messages = [];
    const options = { sourceRoot, outputRoot, log: (line) => messages.push(line) };
    assert.equal(await generateInstallArtifacts(options), 0);
    const before = await Promise.all(OUTPUT_FILES.map(async (name) => ({ text: await fs.readFile(path.join(outputRoot, name), 'utf8'), stat: await fs.stat(path.join(outputRoot, name)) })));
    assert.equal(await generateInstallArtifacts({ ...options, check: true }), 0);
    for (let index = 0; index < OUTPUT_FILES.length; index += 1) {
      const target = path.join(outputRoot, OUTPUT_FILES[index]);
      assert.equal(await fs.readFile(target, 'utf8'), before[index].text);
      assert.equal((await fs.stat(target)).mtimeMs, before[index].stat.mtimeMs);
    }
    const docs = path.join(outputRoot, 'docs/install-matrix.md');
    await fs.writeFile(docs, 'manual drift\n');
    assert.equal(await generateInstallArtifacts({ ...options, check: true }), 1);
    assert.equal(await fs.readFile(docs, 'utf8'), 'manual drift\n');
    assert.equal(await generateInstallArtifacts(options), 0);
    assert.equal(await fs.readFile(docs, 'utf8'), before[1].text);
    assert.ok(messages.some((message) => message.includes('differs')));
  });

  it('keeps both checked-in artifacts identical to generated source data', async () => {
    assert.equal(await fs.readFile(path.join(ROOT, OUTPUT_FILES[0]), 'utf8'), `${JSON.stringify(matrix, null, 2)}\n`);
    assert.equal(await fs.readFile(path.join(ROOT, OUTPUT_FILES[1]), 'utf8'), renderInstallReference(matrix));
  });

  it('refuses unknown or incomplete generator options', async () => {
    await assert.rejects(() => main(['--unknown']), /Unknown or incomplete/);
    await assert.rejects(() => main(['--source-root']), /Unknown or incomplete/);
  });
});
