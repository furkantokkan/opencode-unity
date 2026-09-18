import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCommandHarness, createRunner } from './helpers.mjs';
import { sha256Tree } from '../../../src/core/hash.js';
import { IN_PROJECT_DIR } from '../../../src/facts/vcs-rules.js';
import { snapshotTree } from '../../helpers/fixture-fs.mjs';

/** `dotnet --list-sdks` answers with two SDKs; nothing else is ever spawned by init. */
const dotnet = () => createRunner({ '--list-sdks': { stdout: '8.0.404 [C:\\dotnet\\sdk]\n9.0.100 [C:\\dotnet\\sdk]\n' } });

/**
 * Writes the entry MCP for Unity's OpenCode configurator would write into the sandboxed user config.
 * The URL is only read, never contacted.
 * @param {import('./helpers.mjs').CommandHarness} harness
 * @param {string} hubUrl
 * @returns {Promise<string>}
 */
async function writeConfiguratorHub(harness, hubUrl) {
  const directory = path.join(harness.sandbox.env.XDG_CONFIG_HOME, 'opencode');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'opencode.json'), JSON.stringify({ mcp: { unityMCP: { type: 'remote', url: hubUrl } } }), 'utf8');
  return hubUrl;
}

describe('commands/init', () => {
  it('writes facts, project.json, local.json and the registry, and touches nothing in the project', async (t) => {
    const harness = await createCommandHarness(t);
    const before = await snapshotTree(harness.projectRoot);
    const runner = dotnet();

    const result = await harness.run('init', { deps: { run: runner.run } });
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /scanned/);
    assert.deepEqual(runner.calls.map((call) => call.file), ['dotnet']);

    const projectPaths = harness.paths.project(result.data.projectId);
    const facts = await fs.readFile(projectPaths.facts, 'utf8');
    assert.match(facts, /opencode-unity/);
    const projectJson = JSON.parse(await fs.readFile(projectPaths.projectJson, 'utf8'));
    assert.equal(projectJson.schemaVersion, 1);
    assert.equal(typeof projectJson.inputsHash, 'string');
    const local = JSON.parse(await fs.readFile(projectPaths.localJson, 'utf8'));
    assert.equal(local.projectPath, harness.projectRoot);
    assert.equal(typeof local.hubUrl, 'string');
    assert.match(local.editorWindowTitlePrefix, / - $/);

    const index = JSON.parse(await fs.readFile(harness.paths.projectsIndex, 'utf8'));
    assert.equal(index.projects[0].id, result.data.projectId);
    assert.equal(index.projects[0].path, harness.projectRoot);
    assert.equal(index.projects[0].lastStart, null);

    assert.deepEqual(await snapshotTree(harness.projectRoot), before);
  });

  it('keeps no absolute path, user name or machine name in the shareable files', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('init', { deps: { run: dotnet().run } });
    const projectPaths = harness.paths.project(result.data.projectId);
    for (const file of [projectPaths.facts, projectPaths.projectJson]) {
      const text = await fs.readFile(file, 'utf8');
      assert.equal(text.includes(harness.projectRoot), false, `${file} holds the absolute project path`);
      assert.equal(text.includes(harness.home), false, `${file} holds the product home`);
    }
  });

  it('does nothing on a second run and re-scans with --refresh', async (t) => {
    const harness = await createCommandHarness(t);
    await harness.run('init', { deps: { run: dotnet().run } });

    const again = await harness.run('init', { deps: { run: dotnet().run } });
    assert.match(again.message, /already scanned and its facts are fresh/);
    assert.deepEqual(again.data.written, []);

    const refreshed = await harness.run('init', { options: { refresh: true }, deps: { run: dotnet().run } });
    assert.match(refreshed.message, /scanned/);
    assert.equal(refreshed.data.written.length > 0, true);
  });

  it('still honours --editor and --in-project on a project whose facts are fresh', async (t) => {
    const harness = await createCommandHarness(t, { fixture: 'mcp-for-unity-installed' });
    const first = await harness.run('init', { deps: { run: dotnet().run } });
    assert.equal(first.exitCode, 0, first.message);

    const editor = await harness.run('init', { options: { editor: true }, deps: { run: dotnet().run } });
    assert.doesNotMatch(editor.message, /already scanned/);
    assert.equal(editor.data.editorReason, 'hub_unconfirmed', 'the hub question was reached');
    const config = JSON.parse(await fs.readFile(harness.paths.config, 'utf8'));
    assert.equal(config.projects[first.data.projectId].editor.enabled, true);

    const exported = await harness.run('init', { options: { inProject: true }, deps: { run: dotnet().run } });
    assert.doesNotMatch(exported.message, /already scanned/);
    await fs.access(path.join(harness.projectRoot, IN_PROJECT_DIR, 'facts.md'));
    await fs.access(path.join(harness.projectRoot, IN_PROJECT_DIR, 'project.json'));
  });

  it('--dry-run scans, prints the plan and writes nothing anywhere, asking nothing (spec 5.1)', async (t) => {
    const harness = await createCommandHarness(t, { fixture: 'mcp-for-unity-installed' });
    const home = await snapshotTree(harness.home);
    const project = await snapshotTree(harness.projectRoot);
    const result = await harness.run('init', { options: { inProject: true, editor: true }, global: { dryRun: true, yes: false }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(result.data.dryRun, true);
    assert.match(result.message, /dry run, nothing was written/);
    const projectPaths = harness.paths.project(result.data.projectId);
    assert.deepEqual(result.data.wouldWrite, [projectPaths.facts, projectPaths.projectJson, projectPaths.localJson, harness.paths.projectsIndex, harness.paths.config]);
    assert.deepEqual(result.data.inProject.slice(0, 2), [path.join(harness.projectRoot, IN_PROJECT_DIR, 'facts.md'), path.join(harness.projectRoot, IN_PROJECT_DIR, 'project.json')]);
    assert.match(result.output.join('\n'), /nothing is written/);
    assert.deepEqual(await snapshotTree(harness.home), home, 'the product home is untouched');
    assert.deepEqual(await snapshotTree(harness.projectRoot), project, 'the Unity project is untouched');
  });

  it('refreshes the Windows Terminal profiles setup wrote once it has recorded the project (spec 13.5)', async (t) => {
    const harness = await createCommandHarness(t);
    /** @type {Array<{ platform: string, projects: string[] }>} */
    const calls = [];
    const refreshFragment = async (/** @type {{ platform: string, paths: { projectsIndex: string } }} */ input) => {
      const index = JSON.parse(await fs.readFile(input.paths.projectsIndex, 'utf8'));
      calls.push({ platform: input.platform, projects: index.projects.map((/** @type {{ id: string }} */ entry) => entry.id) });
      return { updated: ['fragment.json'], warnings: ['fragment note'] };
    };
    const result = await harness.run('init', { deps: { run: dotnet().run, refreshFragment } });
    assert.equal(result.exitCode, 0, result.message);
    assert.deepEqual(calls.map((call) => call.projects), [[result.data.projectId]], 'it runs after the project is in the index');
    assert.ok(result.data.written.includes('fragment.json'));
    assert.ok(result.warnings.includes('fragment note'));

    const dry = await harness.run('init', { options: { refresh: true }, global: { dryRun: true }, deps: { run: dotnet().run, refreshFragment } });
    assert.equal(dry.exitCode, 0);
    assert.equal(calls.length, 1, 'a dry run refreshes nothing');
  });

  it('re-scans by itself once the project changed', async (t) => {
    const harness = await createCommandHarness(t);
    await harness.run('init', { deps: { run: dotnet().run } });
    await fs.writeFile(path.join(harness.projectRoot, 'Assets', 'Extra.asmdef'), '{"name":"Extra"}', 'utf8');

    const result = await harness.run('init', { deps: { run: dotnet().run } });
    assert.match(result.message, /scanned/);
  });

  it('--print writes nothing and prints the facts', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('init', { options: { print: true }, deps: { run: dotnet().run } });
    assert.match(result.message, /nothing was written/);
    assert.equal(result.output.join('\n').includes('opencode-unity'), true);
    await assert.rejects(() => fs.access(harness.paths.project(result.data.projectId).facts));
  });

  it('exits 1 outside a Unity project', async (t) => {
    const harness = await createCommandHarness(t, { fixture: null });
    const result = await harness.run('init', { deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'not_a_unity_project');
    assert.match(result.error?.hint ?? '', /Unity project folder/);
  });

  it('finds the project root from a folder inside it', async (t) => {
    const harness = await createCommandHarness(t);
    const inside = path.join(harness.projectRoot, 'Assets');
    const result = await harness.run('init', { cwd: inside, deps: { run: dotnet().run } });
    assert.equal(result.data.root, harness.projectRoot);
  });

  it('--in-project exports the two shareable files and prints ignore lines without editing any', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('init', { options: { inProject: true }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 0);

    const exported = path.join(harness.projectRoot, IN_PROJECT_DIR);
    assert.equal((await fs.readdir(exported)).sort().join(','), 'facts.md,project.json');
    // P21: each export carries the hash this machine will recognise its own output by.
    for (const entry of result.data.exported) {
      assert.equal(entry.sha256, createHash('sha256').update(await fs.readFile(entry.path, 'utf8'), 'utf8').digest('hex'));
    }
    assert.equal(result.data.exported.length, 2);
    const printed = result.output.join('\n');
    assert.match(printed, /\.gitignore/);
    assert.match(printed, /nothing was edited/);
    await assert.rejects(() => fs.access(path.join(harness.projectRoot, '.gitignore')));

    // uninstall --projects removes the folder only while it still hashes to what was recorded here.
    const manifest = JSON.parse(await fs.readFile(harness.paths.installManifest, 'utf8'));
    const record = manifest.entries.find((/** @type {any} */ entry) => entry.kind === 'projectDir');
    assert.equal(record?.path, exported);
    assert.equal(record?.sha256Tree, await sha256Tree(exported));
    assert.match(record?.createdBy ?? '', /^init@/);
  });

  it('--in-project keeps the export and says it is untracked when the install manifest cannot be read', async (t) => {
    const harness = await createCommandHarness(t);
    await fs.mkdir(path.dirname(harness.paths.installManifest), { recursive: true });
    await fs.writeFile(harness.paths.installManifest, '{ not json', 'utf8');
    const result = await harness.run('init', { options: { inProject: true }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 0, result.message);
    await fs.access(path.join(harness.projectRoot, IN_PROJECT_DIR, 'facts.md'));
    assert.ok(result.warnings.some((warning) => /not recorded/.test(warning)), result.warnings.join('|'));
    assert.equal(await fs.readFile(harness.paths.installManifest, 'utf8'), '{ not json');
  });

  it('--in-project needs consent and writes nothing when it is declined', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('init', { options: { inProject: true }, global: { yes: false }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 9);
    assert.equal(result.code, 'consent_required');
    await assert.rejects(() => fs.access(path.join(harness.projectRoot, IN_PROJECT_DIR)));
  });

  it('--editor refuses a project without MCP for Unity', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('init', { options: { editor: true }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'editor_package_missing');
  });

  it('--editor records the choice in config.json, but --yes never confirms the package-default hub (spike M fallback)', async (t) => {
    const harness = await createCommandHarness(t, { fixture: 'mcp-for-unity-installed' });
    const result = await harness.run('init', { options: { editor: true }, deps: { run: dotnet().run } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.editorAgent, false);
    assert.equal(result.data.editorReason, 'hub_unconfirmed');
    assert.ok(result.warnings.some((warning) => /not confirmed/.test(warning)), result.warnings.join('|'));

    const config = JSON.parse(await fs.readFile(harness.paths.config, 'utf8'));
    assert.equal(config.projects[result.data.projectId].editor.enabled, true);
    // config.json holds user choices only, so the defaults must not have been written into it.
    assert.equal(config.guard, undefined);
    assert.equal(config.budget, undefined);
    const local = JSON.parse(await fs.readFile(harness.paths.project(result.data.projectId).localJson, 'utf8'));
    assert.equal(local.editor.hubUrlConfirmed, false);
  });

  it('--editor accepts the hub MCP for Unity wrote into the OpenCode config, and a refresh keeps that confirmation', async (t) => {
    const harness = await createCommandHarness(t, { fixture: 'mcp-for-unity-installed' });
    const hubUrl = await writeConfiguratorHub(harness, 'http://127.0.0.1:8090/mcp');

    const enabled = await harness.run('init', { options: { editor: true }, deps: { run: dotnet().run } });
    assert.equal(enabled.exitCode, 0, enabled.message);
    assert.equal(enabled.data.editorAgent, true);
    const localPath = harness.paths.project(enabled.data.projectId).localJson;
    const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
    assert.equal(local.editor.hubUrl, hubUrl);
    assert.equal(local.editor.hubUrlConfirmed, true);
    assert.equal(local.editor.allowPlayMode, false);
    assert.match(await fs.readFile(harness.paths.project(enabled.data.projectId).facts, 'utf8'), /\/ue /);

    const refreshed = await harness.run('init', { options: { refresh: true }, deps: { run: dotnet().run } });
    assert.equal(refreshed.data.editorAgent, true);

    // A hub that moved is asked about again rather than trusted on the old answer.
    await writeConfiguratorHub(harness, 'http://127.0.0.1:8091/mcp');
    const moved = await harness.run('init', { options: { refresh: true }, deps: { run: dotnet().run } });
    assert.equal(moved.data.editorAgent, false);
    assert.equal(moved.data.editorReason, 'hub_unconfirmed');
    assert.ok(moved.warnings.some((warning) => /not confirmed/.test(warning)), moved.warnings.join('|'));
  });

  it('treats a missing or failing dotnet as a fact, not a failure', async (t) => {
    const harness = await createCommandHarness(t);
    const runner = createRunner({ '--list-sdks': { error: new Error('ENOENT'), exitCode: null } });
    const result = await harness.run('init', { deps: { run: runner.run } });
    assert.equal(result.exitCode, 0);

    const projectJson = JSON.parse(await fs.readFile(harness.paths.project(result.data.projectId).projectJson, 'utf8'));
    assert.equal(projectJson.schemaVersion, 1);
  });

  it('passes the scanner warnings through, including the .opencode folder note', async (t) => {
    const harness = await createCommandHarness(t, { fixture: 'dot-opencode-present' });
    const result = await harness.run('init', { deps: { run: dotnet().run } });
    assert.equal(result.warnings.some((warning) => warning.includes('.opencode folder')), true);
  });

  it('reads the project from --project as well as from the positional path', async (t) => {
    const harness = await createCommandHarness(t);
    const elsewhere = path.join(harness.sandbox.root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });

    const byGlobal = await harness.run('init', { cwd: elsewhere, global: { project: harness.projectRoot }, deps: { run: dotnet().run } });
    assert.equal(byGlobal.data.root, harness.projectRoot);

    const byPositional = await harness.run('init', { cwd: elsewhere, args: { path: harness.projectRoot }, options: { refresh: true }, deps: { run: dotnet().run } });
    assert.equal(byPositional.data.root, harness.projectRoot);
  });
});
