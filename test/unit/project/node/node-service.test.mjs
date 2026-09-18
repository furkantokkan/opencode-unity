import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { discoverComponents, walkTree } from '../../../../src/project/discover.js';
import { detectNodeService, expandWorkspaceMembers, LOCK_FILES, MAX_WORKSPACE_MEMBERS } from '../../../../src/project/components/node-service.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\node-service-tests' : '/node-service-tests';

/**
 * @param {Record<string, string | null>} tree
 * @param {{ dir?: string, manifest?: Record<string, unknown> | null, workspaceRoot?: any, extractRoutes?: boolean }} [options]
 */
function detect(tree, { dir = '', manifest, workspaceRoot, extractRoutes = true } = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const walk = walkTree(view, ROOT);
  const budget = createReadBudget(view, ROOT);
  const declaredBy = dir === '' ? 'package.json' : `${dir}/package.json`;
  const resolved = manifest === undefined ? JSON.parse(String(tree[declaredBy])) : manifest;
  const facts = detectNodeService(budget, { dir, declaredBy, manifest: resolved, files: walk.files, workspaceRoot, extractRoutes, view, root: ROOT });
  return { facts, budget, walk };
}

/**
 * @param {string} name
 */
function fixture(name) {
  const root = path.join(WORKSPACES, name);
  const view = createNodeFsView();
  return { view, root, discovery: discoverComponents(view, root) };
}

/**
 * @param {unknown} value
 */
function asJson(value) {
  return JSON.stringify(value);
}

describe('the package manager comes from the lock file, and the lock file is never opened', () => {
  for (const row of LOCK_FILES) {
    for (const lockFile of row.files) {
      it(`resolves ${row.manager} from ${lockFile}`, () => {
        const { facts, budget } = detect({ 'package.json': asJson({ name: 'sample' }), [lockFile]: 'ignored content' });
        assert.equal(facts.packageManager.name, row.manager);
        assert.equal(facts.packageManager.evidence, lockFile);
        assert.equal(budget.state.opened.includes(lockFile), false, 'the file name is the evidence; its content is never read');
        assert.ok(facts.evidence.some((entry) => entry.signature === row.signature && entry.file === lockFile));
      });
    }
  }

  it('reports two managers in one folder as a conflict and still answers deterministically', () => {
    const { facts } = detect({ 'package.json': asJson({}), 'package-lock.json': '{}', 'yarn.lock': '' });
    assert.equal(facts.packageManager.conflict, true);
    assert.equal(facts.packageManager.name, 'npm');
    assert.deepEqual(facts.packageManager.lockFiles, ['package-lock.json', 'yarn.lock']);
    assert.ok(facts.warnings.includes('component.lockfile-conflict'));
  });

  it('inherits the manager of the folder that installed it when a member has no lock file', () => {
    const { facts } = detect(
      { 'package.json': asJson({ workspaces: ['apps/*'] }), 'package-lock.json': '{}', 'apps/api/package.json': asJson({ name: 'api' }) },
      { dir: 'apps/api' },
    );
    assert.equal(facts.packageManager.name, 'npm');
    assert.equal(facts.packageManager.inherited, true);
    assert.equal(facts.packageManager.evidence, 'package-lock.json');
  });

  it('treats packageManager as a second opinion, and reports a disagreement (claim B8)', () => {
    const { facts } = detect({ 'package.json': asJson({ packageManager: 'pnpm@10.4.1' }), 'package-lock.json': '{}' });
    assert.equal(facts.packageManager.name, 'npm');
    assert.equal(facts.packageManager.declared, 'pnpm@10.4.1');
    assert.equal(facts.packageManager.mismatch, true);
    assert.ok(facts.warnings.includes('component.packagemanager-mismatch'));
  });

  it('uses the declared manager when there is no lock file at all, and nothing when there is neither', () => {
    assert.equal(detect({ 'package.json': asJson({ packageManager: 'yarn@4.5.0' }) }).facts.packageManager.name, 'yarn');
    assert.equal(detect({ 'package.json': asJson({ packageManager: 'unknown-tool@1' }) }).facts.packageManager.name, null);
    assert.equal(detect({ 'package.json': asJson({}) }).facts.packageManager.name, null);
  });
});

describe('the facts a rule block and a verify command need', () => {
  const tree = {
    'package.json': asJson({
      type: 'module',
      engines: { node: '22' },
      scripts: { test: 'vitest run', build: 'tsc -p .' },
      dependencies: { fastify: '5.12.5', 'drizzle-orm': '0.45.2' },
      devDependencies: { vitest: '5.0.1', typescript: '7.0.2' },
    }),
    'pnpm-lock.yaml': '',
    'tsconfig.json': asJson({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
    'src/server.ts': "app.get('/health', handler);",
  };

  it('records engines, module type, scripts and the dependency key set without versions', () => {
    const { facts } = detect(tree);
    assert.equal(facts.engines, '22');
    assert.equal(facts.moduleType, 'module');
    assert.deepEqual(Object.keys(facts.scripts), ['build', 'test']);
    assert.deepEqual(facts.dependencyNames, ['drizzle-orm', 'fastify', 'typescript', 'vitest']);
    assert.equal(JSON.stringify(facts.dependencyNames).includes('5.12.5'), false, 'a version must never be recorded');
  });

  it('records the frameworks that have a signature row, and no others', () => {
    const { facts } = detect(tree);
    assert.deepEqual(facts.frameworks, ['fastify']);
  });

  it('reads outDir and rootDir, and maps the compiled entry through them', () => {
    const { facts } = detect({ ...tree, 'package.json': asJson({ scripts: { start: 'node dist/server.js' } }) });
    assert.deepEqual([facts.typescript.present, facts.typescript.outDir, facts.typescript.rootDir], [true, 'dist', 'src']);
    assert.equal(facts.entry.path, 'src/server.ts');
    assert.equal(facts.entry.mapped, true);
    assert.deepEqual(facts.routes.map((route) => route.label), ['GET /health']);
  });

  it('reads a tsconfig.json that carries comments, which is not JSON', () => {
    const jsonc = ['{', '  // the build output', '  "extends": "./base.json",', '  "compilerOptions": { "outDir": "lib", "rootDir": "src" }', '}'].join('\n');
    const { facts } = detect({ 'package.json': asJson({}), 'tsconfig.json': jsonc });
    assert.deepEqual([facts.typescript.outDir, facts.typescript.rootDir, facts.typescript.extended], ['lib', 'src', true]);
  });

  it('prefers the script body over the dependency when deciding the test runner (claims B9, B10)', () => {
    assert.equal(detect({ 'package.json': asJson({ scripts: { test: 'node --test' }, devDependencies: { vitest: '5.0.1' } }) }).facts.testRunner, 'node --test');
    assert.equal(detect({ 'package.json': asJson({ devDependencies: { vitest: '5.0.1' } }) }).facts.testRunner, 'vitest');
    assert.equal(detect({ 'package.json': asJson({ devDependencies: { jest: '30.5.1' } }) }).facts.testRunner, 'jest');
    assert.equal(detect({ 'package.json': asJson({}) }).facts.testRunner, null);
  });

  it('does not scan a compiled-only entry for routes', () => {
    const { facts, budget } = detect({
      'package.json': asJson({ main: 'dist/server.js' }),
      'tsconfig.json': asJson({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
      'dist/server.js': "app.get('/generated', handler);",
    });
    assert.equal(facts.entry.compiledOnly, true);
    assert.deepEqual(facts.routes, []);
    assert.equal(budget.state.opened.includes('dist/server.js'), false);
  });
});

describe('a secret file is a path, never a read', () => {
  it('lists the environment files beside the manifest and opens none of them', () => {
    const { facts, budget } = detect({
      'package.json': asJson({}),
      '.env': 'API_TOKEN=OCU-TEST-SECRET',
      '.env.local': 'API_TOKEN=OCU-TEST-SECRET',
      '.env.example': 'API_TOKEN=',
    });
    assert.deepEqual(facts.secretFiles, ['.env', '.env.local']);
    assert.ok(facts.warnings.includes('component.secret-file-present'));
    assert.deepEqual(budget.state.opened, [], 'listing a folder opens no file at all');
    assert.equal(JSON.stringify(facts).includes('OCU-TEST-SECRET'), false);
  });

  it('lists an environment file whatever case it is spelled in', () => {
    const { facts } = detect({ 'package.json': asJson({}), '.ENV': 'X=1', '.Env.Example': 'X=' });
    assert.deepEqual(facts.secretFiles, ['.ENV']);
  });

  it('reports no secret file when there is none', () => {
    const { facts } = detect({ 'package.json': asJson({}) });
    assert.deepEqual(facts.secretFiles, []);
    assert.equal(facts.warnings.includes('component.secret-file-present'), false);
  });
});

describe('a component that cannot be described is dropped, not guessed (P7)', () => {
  it('returns unreadable, with no facts and no other kind of rule', () => {
    const { facts } = detect({ 'package.json': '{ not json' }, { manifest: null });
    assert.equal(facts.status, 'unreadable');
    assert.deepEqual(facts.warnings, ['component.unreadable']);
    assert.deepEqual([facts.testRunner, facts.entry.path, facts.packageManager.name], [null, null, null]);
    assert.deepEqual(facts.evidence, []);
  });
});

describe('workspace globs expand with a small subset and a cap (D-B5)', () => {
  it('expands a literal path, a trailing /* and a trailing /**', () => {
    const expanded = expandWorkspaceMembers(['apps/*', 'packages/**', 'tools/cli']);
    assert.deepEqual(expanded.patterns, [
      { prefix: 'apps', depth: 'one' },
      { prefix: 'packages', depth: 'any' },
      { prefix: 'tools/cli', depth: 'exact' },
    ]);
    assert.deepEqual(expanded.unexpanded, []);
  });

  it('refuses every other pattern rather than resolving it', () => {
    const expanded = expandWorkspaceMembers(['**/../**', '!apps/legacy', 'a/*/b', '/abs/path', '']);
    assert.deepEqual(expanded.patterns, []);
    assert.equal(expanded.unexpanded.length, 5);
  });

  it('stops at the member cap', () => {
    const expanded = expandWorkspaceMembers(Array.from({ length: MAX_WORKSPACE_MEMBERS + 5 }, (_, index) => `apps/app-${index}`));
    assert.equal(expanded.patterns.length, MAX_WORKSPACE_MEMBERS);
    assert.equal(expanded.truncated, true);
  });

  it('marks a package as a member only when a pattern covers its folder', () => {
    const workspaceRoot = { present: true, tool: 'npm', members: ['apps/*'], declaredBy: 'package.json', manifest: {}, manifestStatus: 'ok' };
    assert.equal(detect({ 'package.json': asJson({}), 'apps/api/package.json': asJson({}) }, { dir: 'apps/api', workspaceRoot }).facts.workspaceMember, true);
    assert.equal(detect({ 'package.json': asJson({}), 'tools/cli/package.json': asJson({}) }, { dir: 'tools/cli', workspaceRoot }).facts.workspaceMember, false);
    assert.equal(detect({ 'package.json': asJson({}), 'apps/api/nested/package.json': asJson({}) }, { dir: 'apps/api/nested', workspaceRoot }).facts.workspaceMember, false);
  });
});

describe('the committed fixtures', () => {
  it('describes the standalone service of shape B end to end', () => {
    const { view, root, discovery } = fixture('standalone-node-service');
    const anchor = discovery.anchors.find((component) => component.kind === 'node-service');
    assert.ok(anchor);
    const facts = detectNodeService(discovery.budget, { dir: anchor.dir, declaredBy: anchor.declaredBy, manifest: anchor.manifest, files: discovery.walk.files, workspaceRoot: discovery.workspaceRoot, view, root });

    assert.equal(facts.packageManager.name, 'pnpm');
    assert.equal(facts.engines, '22');
    assert.equal(facts.moduleType, 'module');
    assert.deepEqual(facts.frameworks, ['fastify']);
    assert.equal(facts.testRunner, 'vitest');
    assert.equal(facts.entry.path, 'src/server.ts');
    assert.equal(facts.entry.source, 'scripts.start');
    assert.deepEqual(facts.routes.map((route) => route.label), ['GET /health', 'GET /seasons/:id', 'POST /scores']);
  });

  it('describes the two services of the monorepo, each with its own routes', () => {
    const { view, root, discovery } = fixture('monorepo-workspaces');
    const facts = discovery.anchors
      .filter((component) => component.kind === 'node-service')
      .map((component) => detectNodeService(discovery.budget, { dir: component.dir, declaredBy: component.declaredBy, manifest: component.manifest, files: discovery.walk.files, workspaceRoot: discovery.workspaceRoot, view, root }));

    const api = facts.find((entry) => entry.dir === 'apps/api');
    const match = facts.find((entry) => entry.dir === 'apps/match');
    assert.ok(api && match);
    assert.deepEqual(api.routes.map((route) => route.label), ['GET /health', 'MOUNT /seasons', 'POST /scores']);
    assert.deepEqual(match.routes.map((route) => route.label), ['ROOM lobby', 'ROOM match', 'ROOM queue']);
    assert.equal(api.packageManager.inherited, true, 'the root lock file installed both members');
    assert.equal(api.workspaceMember, true);
    assert.equal(api.testRunner, 'node --test');
  });

  it('never opens a lock file, a secret or a bundled path on any fixture', () => {
    for (const name of ['unity-plus-functions', 'standalone-node-service', 'monorepo-workspaces', 'hostile-workspace']) {
      const { view, root, discovery } = fixture(name);
      for (const component of discovery.anchors.filter((entry) => entry.kind === 'node-service')) {
        detectNodeService(discovery.budget, { dir: component.dir, declaredBy: component.declaredBy, manifest: component.manifest, files: discovery.walk.files, workspaceRoot: discovery.workspaceRoot, view, root });
      }
      for (const opened of discovery.budget.state.opened) {
        assert.doesNotMatch(opened, /lock|\.env|runtimeconfig|service-account|google-services|appsettings|npmrc/i, `${name} opened ${opened}`);
      }
    }
  });
});
