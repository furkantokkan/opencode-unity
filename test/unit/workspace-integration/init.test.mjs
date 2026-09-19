import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createCommandHarness } from '../commands/helpers.mjs';
import { snapshotTree } from '../../helpers/fixture-fs.mjs';
import { sha256Tree } from '../../../src/core/hash.js';
import { buildWorkspaceJson, renderWorkspaceFacts, validateWorkspaceJson } from '../../../src/facts/workspace.js';
import { getWorkspaceInputsHash, resolveWorkspaceProjectRoot, scanWorkspace } from '../../../src/project/workspace.js';
import { createNodeFsView } from '../../../src/unity/fs-view.js';

const fixtures = fileURLToPath(new URL('../../fixtures/workspaces/', import.meta.url));
const noProcess = { run: async () => { throw new Error('Workspace init must not launch a process'); } };

async function workspaceHarness(t, fixture = 'standalone-node-service') {
  const harness = await createCommandHarness(t, { fixture: null, ollama: false });
  await fs.cp(path.join(fixtures, fixture), harness.projectRoot, { recursive: true });
  return harness;
}

async function readProject(harness, result) {
  return JSON.parse(await fs.readFile(harness.paths.project(result.data.projectId).projectJson, 'utf8'));
}

describe('workspace init integration', () => {
  it('initializes a standalone Node service and database without changing repository files', async (t) => {
    const harness = await workspaceHarness(t);
    const before = await snapshotTree(harness.projectRoot);
    const result = await harness.run('init', { deps: noProcess });
    assert.equal(result.exitCode, 0, result.message);
    const document = await readProject(harness, result);
    assert.equal(document.schemaVersion, 2);
    assert.deepEqual(validateWorkspaceJson(document), []);
    assert.deepEqual(document.workspace.components.map((item) => item.kind), ['node-service', 'database']);
    const facts = await fs.readFile(harness.paths.project(result.data.projectId).facts, 'utf8');
    assert.match(facts, /TypeScript; fastify; pnpm/);
    assert.match(facts, /drizzle/);
    assert.ok(facts.length <= 2600);
    assert.equal(Object.hasOwn(document, 'unity'), false);
    assert.deepEqual(await snapshotTree(harness.projectRoot), before);
  });

  it('includes a Unity client, Node functions and Firebase in one workspace', async (t) => {
    const harness = await workspaceHarness(t, 'unity-plus-functions');
    const result = await harness.run('init', { deps: noProcess });
    assert.equal(result.exitCode, 0, result.message);
    const document = await readProject(harness, result);
    assert.deepEqual(document.workspace.components.map((item) => item.id), ['unity:client', 'node:functions', 'firebase:root']);
    const text = await fs.readFile(harness.paths.project(result.data.projectId).facts, 'utf8');
    assert.match(text, /unity:client.*client/);
    assert.match(text, /Unity/);
    assert.match(text, /firebase-functions/);
    assert.match(text, /firebase:root/);
    assert.equal(result.data.editorAgent, false);
  });

  it('builds a read-only launch for an initialized standalone service', async (t) => {
    const harness = await workspaceHarness(t);
    const initialized = await harness.run('init', { deps: noProcess });
    assert.equal(initialized.exitCode, 0, initialized.message);
    const before = await snapshotTree(harness.projectRoot);
    const result = await harness.run('start', { options: { printEnv: true } });
    assert.equal(result.exitCode, 0, result.message);
    assert.deepEqual(await snapshotTree(harness.projectRoot), before);
  });

  it('initializes an ASP.NET service without reading appsettings values', async (t) => {
    const harness = await workspaceHarness(t, 'backend-only-dotnet');
    const canary = 'WORKSPACE_CONNECTION_SECRET';
    await fs.writeFile(path.join(harness.projectRoot, 'Api', 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Main: canary } }));
    const read = [];
    const original = createNodeFsView();
    const view = { ...original, readText(file, options) { read.push(file); return original.readText(file, options); } };
    const result = await harness.run('init', { deps: { ...noProcess, view } });
    assert.equal(result.exitCode, 0, result.message);
    const document = await readProject(harness, result);
    assert.equal(document.workspace.components[0].kind, 'dotnet-service');
    assert.equal(document.workspace.components[0].details.efCore, false);
    assert.equal(document.workspace.components[0].details.targetFramework, 'net10.0');
    assert.equal(read.some((file) => file.endsWith('appsettings.json')), false);
    assert.equal(JSON.stringify(document).includes(canary), false);
  });

  for (const mode of ['print', 'dryRun']) {
    it(`${mode} is read-only in both the home and workspace and asks no consent`, async (t) => {
      const harness = await workspaceHarness(t, 'unity-plus-functions');
      const beforeHome = await snapshotTree(harness.home);
      const beforeProject = await snapshotTree(harness.projectRoot);
      const result = await harness.run('init', { options: { print: mode === 'print', inProject: true }, global: { dryRun: mode === 'dryRun', yes: false }, deps: noProcess });
      assert.equal(result.exitCode, 0, result.message);
      assert.match(result.message, /nothing was written/);
      assert.deepEqual(await snapshotTree(harness.home), beforeHome);
      assert.deepEqual(await snapshotTree(harness.projectRoot), beforeProject);
    });
  }

  it('rejects an ambiguous workspace editor request before writing', async (t) => {
    const harness = await workspaceHarness(t, 'unity-plus-functions');
    const beforeHome = await snapshotTree(harness.home);
    const result = await harness.run('init', { options: { editor: true }, deps: noProcess });
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'workspace_editor_requires_unity');
    assert.match(result.error.hint, /specific Unity client/);
    assert.deepEqual(await snapshotTree(harness.home), beforeHome);
  });

  it('keeps fresh facts unchanged and refreshes after a service source changes', async (t) => {
    const harness = await workspaceHarness(t);
    const first = await harness.run('init', { deps: noProcess });
    assert.equal(first.exitCode, 0, first.message);
    const same = await harness.run('init', { deps: noProcess });
    assert.deepEqual(same.data.written, []);
    assert.match(same.message, /already scanned/);
    const source = path.join(harness.projectRoot, 'src', 'server.ts');
    await fs.appendFile(source, '\n// Changed service input\n');
    const next = await harness.run('init', { deps: noProcess });
    assert.equal(next.exitCode, 0, next.message);
    assert.notEqual(first.data.inputsHash, next.data.inputsHash);
    assert.ok(next.data.written.length > 0);
  });

  it('exports only shareable files and records the exact uninstall ownership hash', async (t) => {
    const harness = await workspaceHarness(t);
    const result = await harness.run('init', { options: { inProject: true }, deps: noProcess });
    assert.equal(result.exitCode, 0, result.message);
    const directory = path.join(harness.projectRoot, '.opencode-unity');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['facts.md', 'project.json']);
    const manifest = JSON.parse(await fs.readFile(harness.paths.installManifest, 'utf8'));
    assert.equal(manifest.entries.find((item) => item.path === directory).sha256Tree, await sha256Tree(directory));
    for (const file of ['facts.md', 'project.json']) {
      const text = await fs.readFile(path.join(directory, file), 'utf8');
      assert.equal(text.includes(harness.projectRoot), false);
      assert.equal(text.includes(harness.home), false);
    }
    await assert.rejects(fs.access(path.join(harness.projectRoot, '.gitignore')));
  });

  it('requires the existing export consent before any workspace writes', async (t) => {
    const harness = await workspaceHarness(t);
    const before = await snapshotTree(harness.home);
    const result = await harness.run('init', { options: { inProject: true }, global: { yes: false }, deps: noProcess });
    assert.equal(result.exitCode, 9);
    assert.equal(result.code, 'consent_required');
    assert.deepEqual(await snapshotTree(harness.home), before);
  });

  it('never serializes script bodies, Firebase project IDs, env values or database credentials', async (t) => {
    const harness = await workspaceHarness(t, 'unity-plus-functions');
    const canary = 'WORKSPACE_CONFIGURATION_SECRET';
    const manifest = path.join(harness.projectRoot, 'functions', 'package.json');
    const packageJson = JSON.parse(await fs.readFile(manifest, 'utf8'));
    packageJson.scripts = { test: `echo ${canary}` };
    packageJson.engines = { node: canary };
    await fs.writeFile(manifest, JSON.stringify(packageJson));
    await fs.writeFile(path.join(harness.projectRoot, '.firebaserc'), JSON.stringify({ projects: { default: canary } }));
    await fs.writeFile(path.join(harness.projectRoot, 'functions', '.env'), `PASSWORD=${canary}`);
    const original = createNodeFsView();
    const opened = [];
    const view = { ...original, readText(file, options) { opened.push(file); return original.readText(file, options); } };
    const result = await harness.run('init', { deps: { ...noProcess, view } });
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(opened.some((file) => file.endsWith('.env')), false);
    const files = harness.paths.project(result.data.projectId);
    assert.equal((await fs.readFile(files.facts, 'utf8')).includes(canary), false);
    assert.equal((await fs.readFile(files.projectJson, 'utf8')).includes(canary), false);
  });

  it('records an unreadable component without inventing framework or script facts', async (t) => {
    const harness = await workspaceHarness(t);
    await fs.writeFile(path.join(harness.projectRoot, 'package.json'), '{ malformed');
    const result = await harness.run('init', { deps: noProcess });
    assert.equal(result.exitCode, 0, result.message);
    const document = await readProject(harness, result);
    assert.equal(document.workspace.components[0].status, 'unreadable');
    const facts = await fs.readFile(harness.paths.project(result.data.projectId).facts, 'utf8');
    assert.match(facts, /facts unreadable/);
    assert.doesNotMatch(facts, /fastify/);
  });
});

describe('workspace facts boundaries', () => {
  it('renders deterministically and honors component and character caps', () => {
    const root = path.join(fixtures, 'unity-plus-functions');
    const options = { settings: { maxComponents: 2, maxRenderedBlocks: 1, factsBudgetChars: 500, unityBlockChars: 200 } };
    const scan = scanWorkspace(createNodeFsView(), root, options);
    assert.equal(scan.components.length, 2);
    assert.equal(scan.truncated, true);
    const facts = renderWorkspaceFacts(scan);
    assert.ok(facts.length <= 500);
    assert.ok(facts.dropped.length > 0);
    assert.deepEqual(renderWorkspaceFacts(scan), facts);
    assert.deepEqual(validateWorkspaceJson(buildWorkspaceJson(scan)), []);
  });

  it('selects exact component IDs and preserves Unity-only mode', () => {
    const root = path.join(fixtures, 'unity-plus-functions');
    const view = createNodeFsView();
    assert.deepEqual(scanWorkspace(view, root, { settings: { components: ['node:functions'] } }).components.map((item) => item.id), ['node:functions']);
    assert.deepEqual(scanWorkspace(view, root, { settings: { components: 'unity-only' } }).components.map((item) => item.kind), ['unity-client']);
    assert.equal(scanWorkspace(view, path.join(root, 'client')).unityOnly, true);
  });

  it('recomputes the same freshness hash from recorded settings', () => {
    const root = path.join(fixtures, 'standalone-node-service');
    const view = createNodeFsView();
    const scan = scanWorkspace(view, root, { settings: { maxComponents: 1 } });
    assert.equal(getWorkspaceInputsHash(view, root, buildWorkspaceJson(scan)), scan.inputsHash);
  });

  it('charges nested Unity source reads to the same workspace byte budget', () => {
    const root = path.join(fixtures, 'unity-plus-functions');
    const original = createNodeFsView();
    let bytes = 0;
    const view = { ...original, readText(file, options) {
      const read = original.readText(file, options);
      if (read) bytes += Buffer.byteLength(read.text);
      return read;
    } };
    const scan = scanWorkspace(view, root, { settings: { readBudgetBytes: 500 } });
    assert.ok(bytes <= 500, `${bytes} exceeds the shared read budget`);
    assert.equal(scan.truncated, true);
    assert.match(renderWorkspaceFacts(scan).text, /component list is incomplete/);
  });

  it('ignores unknown settings and refuses oversized persisted scan limits', () => {
    const root = path.join(fixtures, 'standalone-node-service');
    const scan = scanWorkspace(createNodeFsView(), root, { settings: { readBudgetBytes: 1e99, maxComponents: 1e99, credentials: 'SECRET' } });
    assert.equal(scan.options.readBudgetBytes, 6291456);
    assert.equal(scan.options.maxComponents, 12);
    assert.equal(JSON.stringify(buildWorkspaceJson(scan)).includes('SECRET'), false);
  });

  it('resolves nested standalone service folders and preserves explicit workspace roots', async (t) => {
    const harness = await workspaceHarness(t);
    const view = createNodeFsView();
    assert.equal(resolveWorkspaceProjectRoot(view, path.join(harness.projectRoot, 'src')), harness.projectRoot);
    assert.equal(resolveWorkspaceProjectRoot(view, harness.projectRoot, { explicit: true }), harness.projectRoot);
  });

  it('rejects accidental raw manifest or command fields in the shareable schema', () => {
    const document = buildWorkspaceJson(scanWorkspace(createNodeFsView(), path.join(fixtures, 'standalone-node-service')));
    document.workspace.components[0].details.manifest = { scripts: { test: 'secret' } };
    assert.ok(validateWorkspaceJson(document).some((error) => error.path.includes('manifest')));
  });
});
