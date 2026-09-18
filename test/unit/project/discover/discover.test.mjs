import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { discoverComponents, discoverWorkspace, findWorkspaceRoot, walkTree, WORKSPACE_SKIP_DIRS } from '../../../../src/project/discover.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\discover-tests' : '/discover-tests';

/**
 * @param {Record<string, string | null>} tree
 */
function viewOf(tree) {
  return createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
}

/**
 * @param {string} fixture
 */
function discover(fixture) {
  return discoverComponents(createNodeFsView(), path.join(WORKSPACES, fixture));
}

/**
 * @param {import('../../../../src/project/discover.js').WorkspaceDiscovery} result
 */
function summarize(result) {
  return [...result.anchors, ...result.overlays].map((component) => `${component.id} ${component.kind} ${component.dir || '.'} <- ${component.declaredBy}`);
}

describe('the four repository shapes', () => {
  it('A: a Unity client beside a functions service, with firebase.json at the root', () => {
    const result = discover('unity-plus-functions');
    assert.deepEqual(summarize(result), [
      'unity:client unity-client client <- client/ProjectSettings/ProjectVersion.txt',
      'node:functions node-service functions <- functions/package.json',
      'firebase:root firebase-project . <- firebase.json',
    ]);
    assert.equal(result.overlays[0].attachedTo, 'workspace', 'firebase.json references functions/, it does not own it');
    assert.deepEqual(result.notes, []);
  });

  it('B: a standalone backend is a valid workspace, and used to be exit 1', () => {
    const result = discover('standalone-node-service');
    assert.deepEqual(summarize(result), ['node:root node-service . <- package.json', 'db:drizzle database . <- drizzle.config.ts']);
    assert.equal(result.anchors.some((anchor) => anchor.kind === 'unity-client'), false);
    assert.equal(result.overlays[0].attachedTo, 'node:root');
  });

  it('C: a monorepo root is a marker, and its members are the services', () => {
    const result = discover('monorepo-workspaces');
    assert.deepEqual(summarize(result), [
      'node:apps-api node-service apps/api <- apps/api/package.json',
      'node:apps-match node-service apps/match <- apps/match/package.json',
      'unity:client unity-client client <- client/ProjectSettings/ProjectVersion.txt',
      'node:packages-shared node-service packages/shared <- packages/shared/package.json',
    ]);
    assert.deepEqual(result.workspaceRoot, { present: true, tool: 'npm', members: ['apps/*', 'packages/*'], declaredBy: 'package.json', manifest: result.workspaceRoot.manifest, manifestStatus: 'ok' });
  });

  it('D: one Unity project in both roles, with its siblings still ordinary workspace paths', () => {
    const result = discover('unity-plus-dedicated-server');
    assert.deepEqual(summarize(result), ['unity:root unity-client . <- ProjectSettings/ProjectVersion.txt']);
    assert.deepEqual(result.walk.unityRoots, ['']);
    assert.ok(result.walk.files.includes('compose.yaml'));
    assert.ok(result.walk.files.includes('k8s/gameserver.yaml'), 'a sibling folder of the Unity root is walked');
    assert.equal(result.walk.files.some((file) => file.startsWith('Assets/')), false, 'the Unity root closes its own folders');
  });

  it('B variant: a Microsoft.NET.Sdk.Web csproj is an anchor and a test project is not', () => {
    const result = discover('backend-only-dotnet');
    assert.deepEqual(summarize(result), ['dotnet:api dotnet-service Api <- Api/Api.csproj']);
  });
});

describe('discovery is deterministic', () => {
  it('produces the same result twice, for every fixture', () => {
    for (const fixture of ['unity-plus-functions', 'standalone-node-service', 'monorepo-workspaces', 'unity-plus-dedicated-server', 'backend-only-dotnet', 'hostile-workspace']) {
      assert.deepEqual(summarize(discover(fixture)), summarize(discover(fixture)), fixture);
    }
  });

  it('is unaffected by the separator style of the path it is given', () => {
    const view = createNodeFsView();
    const posix = path.join(WORKSPACES, 'unity-plus-functions');
    const mixed = `${posix.split(path.sep).join('/')}/functions/..`;
    assert.deepEqual(summarize(discoverComponents(view, mixed)), summarize(discoverComponents(view, posix)));
  });

  it('records every fact with the signature row and the file that produced it', () => {
    const result = discover('unity-plus-functions');
    assert.deepEqual(result.anchors[0].evidence, [{ fact: 'anchor', signature: 'spec:9.1', file: 'client/ProjectSettings/ProjectVersion.txt' }]);
    assert.deepEqual(result.anchors[1].evidence, [{ fact: 'anchor', signature: 'node/anchor.package-json', file: 'functions/package.json' }]);
    assert.deepEqual(result.overlays[0].evidence, [{ fact: 'overlay', signature: 'firebase/overlay.firebase-json', file: 'firebase.json' }]);
  });
});

describe('findWorkspaceRoot', () => {
  it('uses the VCS root when the upward search finds a marker', () => {
    const view = viewOf({ '.git/HEAD': 'ref: refs/heads/main', 'apps/api/package.json': '{}' });
    const resolved = findWorkspaceRoot(view, path.join(ROOT, 'apps', 'api'));
    assert.equal(resolved.root, path.resolve(ROOT));
    assert.equal(resolved.source, 'vcs');
    assert.equal(resolved.vcsKind, 'git');
  });

  it('falls back to the directory it was given when there is no marker', () => {
    const view = viewOf({ 'apps/api/package.json': '{}' });
    const given = path.join(ROOT, 'apps', 'api');
    const resolved = findWorkspaceRoot(view, given);
    assert.equal(resolved.root, path.resolve(given));
    assert.equal(resolved.source, 'given');
    assert.equal(resolved.vcsKind, null);
  });

  it('discoverWorkspace resolves the root before it discovers', () => {
    const view = viewOf({ '.git/HEAD': 'ref: refs/heads/main', 'apps/api/package.json': '{"name":"api"}' });
    const result = discoverWorkspace(view, path.join(ROOT, 'apps', 'api'));
    assert.equal(result.rootSource, 'vcs');
    assert.deepEqual(summarize(result), ['node:apps-api node-service apps/api <- apps/api/package.json']);
  });
});

describe('walkTree', () => {
  it('skips the extended skip list, and never descends node_modules', () => {
    const result = walkTree(
      viewOf({
        'src/index.js': '',
        'node_modules/left-pad/package.json': '',
        'dist/bundle.js': '',
        'build/out.js': '',
        'out/o.js': '',
        '.next/x.js': '',
        'coverage/lcov.info': '',
        'vendor/lib.js': '',
        '.turbo/cache': '',
        'obj/Debug/x.cs': '',
        '.git/HEAD': '',
      }),
      ROOT,
    );
    assert.deepEqual(result.files, ['src/index.js']);
    for (const skipped of ['node_modules', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '.turbo', 'obj']) {
      assert.ok(WORKSPACE_SKIP_DIRS.includes(skipped), `${skipped} is in the skip list`);
    }
  });

  it('stops at the entry cap and says so', () => {
    const tree = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/File${index}.js`, '']));
    const result = walkTree(viewOf(tree), ROOT, { maxEntries: 10 });
    assert.equal(result.truncated, true);
    assert.equal(result.entryCount, 10);
  });

  it('stops at the depth cap and says so', () => {
    const deep = `${Array.from({ length: 14 }, (_, index) => `d${index}`).join('/')}/package.json`;
    const result = walkTree(viewOf({ 'package.json': '{}', [deep]: '{}' }), ROOT, { maxDepth: 3 });
    assert.equal(result.depthLimited, true);
    assert.equal(result.files.includes(deep), false);
    assert.ok(result.files.includes('package.json'));
  });

  it('reports a truncated walk as a doctor note, because it can mis-assign files', () => {
    const tree = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/File${index}.js`, '']));
    const result = discoverComponents(viewOf({ ...tree, 'package.json': '{"name":"x"}' }), ROOT, { limits: { walkEntryCap: 5 } });
    assert.ok(result.notes.includes('component.walk-truncated'));
  });

  it('reports a workspace with nothing in it, which is the one exit-1 case left', () => {
    const result = discoverComponents(viewOf({ 'README.md': '# nothing here' }), ROOT);
    assert.deepEqual(result.anchors, []);
    assert.deepEqual(result.overlays, []);
    assert.ok(result.notes.includes('component.none-found'));
  });
});
