// P1-P7 of amendment 37.3, one describe per rule. Memory trees throughout, because the point of each
// case is a single structural fact and a fixture would bury it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMemoryFsView } from '../../../../src/unity/fs-view.js';
import { discoverComponents, hasStartMarker, isWithin, ownerOf, UNITY_CLOSED_DIRS } from '../../../../src/project/discover.js';

const ROOT = process.platform === 'win32' ? 'C:\\precedence-tests' : '/precedence-tests';
const UNITY_VERSION = 'm_EditorVersion: 6000.3.8f1\n';

/**
 * @param {Record<string, string | null>} tree
 */
function discover(tree, options = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  return discoverComponents(view, ROOT, options);
}

/**
 * @param {import('../../../../src/project/discover.js').WorkspaceDiscovery} result
 */
function ids(result) {
  return [...result.anchors, ...result.overlays].map((component) => component.id);
}

describe('P1 - a file belongs to the anchor with the longest matching prefix', () => {
  const result = discover({
    'package.json': '{"name":"root","dependencies":{"express":"5.2.1"}}',
    'apps/api/package.json': '{"name":"api"}',
    'apps/api/src/index.js': '',
    'apps/api/nested/deep/file.js': '',
    'shared/util.js': '',
  });

  it('assigns a nested file to the nested anchor, not the enclosing one', () => {
    assert.equal(ownerOf(result.anchors, 'apps/api/nested/deep/file.js'), 'node:apps-api');
    assert.equal(ownerOf(result.anchors, 'shared/util.js'), 'node:root');
  });

  it('answers null for a path no anchor covers', () => {
    const outside = discover({ 'apps/api/package.json': '{"name":"api"}', 'docs/readme.md': '' });
    assert.equal(ownerOf(outside.anchors, 'docs/readme.md'), null);
  });

  it('treats the workspace root as containing everything', () => {
    assert.equal(isWithin('anything/at/all', ''), true);
    assert.equal(isWithin('apps/api', 'apps'), true);
    assert.equal(isWithin('apps-extra/api', 'apps'), false, 'a prefix must end at a separator');
  });
});

describe('P2 - a Unity client closes its own folders and nothing else', () => {
  const result = discover({
    'ProjectSettings/ProjectVersion.txt': UNITY_VERSION,
    'Assets/ThirdParty/package.json': '{"name":"vendored","scripts":{"start":"node ."}}',
    'Assets/Game/Player.cs': '',
    'Packages/com.example.tool/package.json': '{"name":"com.example.tool"}',
    'ProjectSettings/ProjectSettings.asset': '',
    'functions/package.json': '{"name":"functions"}',
  });

  it('creates no component under Assets, Packages or ProjectSettings', () => {
    assert.deepEqual(ids(result), ['unity:root', 'node:functions']);
    assert.deepEqual([...UNITY_CLOSED_DIRS], ['Assets', 'Packages', 'ProjectSettings']);
  });

  it('still finds a service in a sibling folder, which is the commonest real shape', () => {
    assert.ok(ids(result).includes('node:functions'));
  });
});

describe('P3 - node_modules and the build output folders are never descended', () => {
  it('finds nothing inside them, however service-shaped it looks', () => {
    const result = discover({
      'package.json': '{"name":"root"}',
      'node_modules/pkg/package.json': '{"name":"pkg"}',
      'dist/package.json': '{"name":"bundled"}',
      'Assets/ThirdParty/node_modules/pkg/package.json': '{"name":"pkg"}',
      'ProjectSettings/ProjectVersion.txt': UNITY_VERSION,
    });
    assert.deepEqual(ids(result), ['unity:root', 'node:root']);
  });
});

describe('P4 - a workspace root is not a service', () => {
  it('turns a package.json with workspaces into a marker', () => {
    const result = discover({ 'package.json': '{"name":"root","workspaces":["apps/*"]}', 'apps/api/package.json': '{"name":"api"}' });
    assert.deepEqual(ids(result), ['node:apps-api']);
    assert.equal(result.workspaceRoot.present, true);
    assert.equal(result.workspaceRoot.tool, 'npm');
  });

  it('treats a package.json beside pnpm-workspace.yaml as a marker too', () => {
    const result = discover({ 'package.json': '{"name":"root"}', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/api/package.json': '{"name":"api"}' });
    assert.equal(result.workspaceRoot.tool, 'pnpm');
    assert.equal(result.workspaceRoot.declaredBy, 'pnpm-workspace.yaml');
    assert.deepEqual(ids(result), ['node:apps-api']);
  });

  it('keeps it a service when it has a start marker', () => {
    for (const manifest of ['{"name":"r","workspaces":["apps/*"],"bin":"./cli.js"}', '{"name":"r","workspaces":["apps/*"],"scripts":{"start":"node ."}}', '{"name":"r","workspaces":["apps/*"],"dependencies":{"fastify":"5.12.5"}}']) {
      const result = discover({ 'package.json': manifest, 'apps/api/package.json': '{"name":"api"}' });
      assert.deepEqual(ids(result), ['node:apps-api', 'node:root'], manifest);
      assert.equal(result.workspaceRoot.present, false, manifest);
    }
  });

  it('recognises the three start markers and nothing else', () => {
    assert.equal(hasStartMarker({ bin: './cli.js' }), true);
    assert.equal(hasStartMarker({ scripts: { start: 'node .' } }), true);
    assert.equal(hasStartMarker({ devDependencies: { express: '5.2.1' } }), true);
    assert.equal(hasStartMarker({ scripts: { test: 'vitest run' } }), false);
    assert.equal(hasStartMarker({ dependencies: { 'left-pad': '1.0.0' } }), false);
    assert.equal(hasStartMarker(null), false);
  });

  it('records the declared globs without expanding them', () => {
    const result = discover({ 'package.json': '{"name":"root","workspaces":["apps/*","packages/**"]}', 'apps/api/package.json': '{"name":"api"}' });
    assert.deepEqual(result.workspaceRoot.members, ['apps/*', 'packages/**']);
  });
});

describe('P5 - an overlay attaches to the nearest enclosing anchor', () => {
  it('attaches to the workspace when no anchor encloses it', () => {
    const result = discover({ 'firebase.json': '{"functions":{"source":"functions"}}', 'functions/package.json': '{"name":"functions"}' });
    const overlay = result.overlays[0];
    assert.equal(overlay.id, 'firebase:root');
    assert.equal(overlay.attachedTo, 'workspace');
  });

  it('attaches to the deepest anchor that contains it', () => {
    const result = discover({ 'package.json': '{"name":"root","dependencies":{"express":"5.2.1"}}', 'apps/api/package.json': '{"name":"api"}', 'apps/api/drizzle.config.ts': 'export default {};' });
    const overlay = result.overlays[0];
    assert.equal(overlay.id, 'db:apps-api-drizzle');
    assert.equal(overlay.attachedTo, 'node:apps-api');
  });

  it('declares a supabase overlay for the folder that holds supabase/, not for supabase/ itself', () => {
    const result = discover({ 'apps/api/package.json': '{"name":"api"}', 'apps/api/supabase/config.toml': '[api]\nport = 54321\n' });
    assert.deepEqual(ids(result), ['node:apps-api', 'db:apps-api-supabase']);
    assert.equal(result.overlays[0].dir, 'apps/api');
    assert.equal(result.overlays[0].attachedTo, 'node:apps-api');
  });
});

describe('P6 - two anchors may share a folder', () => {
  const result = discover({
    'package.json': '{"name":"api"}',
    'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
    'Service.cs': '',
    'index.ts': '',
    'notes.md': '',
  });

  it('creates both anchors and reports the ambiguity rather than hiding it', () => {
    assert.deepEqual(ids(result).sort(), ['dotnet:root', 'node:root']);
    assert.deepEqual(result.sharedFolders, ['']);
    assert.ok(result.notes.includes('component.shared-folder'));
  });

  it('splits the folder by extension family', () => {
    assert.equal(ownerOf(result.anchors, 'Service.cs'), 'dotnet:root');
    assert.equal(ownerOf(result.anchors, 'Api.csproj'), 'dotnet:root');
    assert.equal(ownerOf(result.anchors, 'index.ts'), 'node:root');
    assert.equal(ownerOf(result.anchors, 'package.json'), 'node:root');
  });

  it('gives anything else to the anchor whose declaring file sorts first', () => {
    assert.equal(ownerOf(result.anchors, 'notes.md'), 'dotnet:root', 'Api.csproj sorts before package.json');
  });
});

describe('P7 - a component that cannot be described is dropped, not guessed', () => {
  it('marks an unreadable declaring file and gives it no manifest', () => {
    const result = discover({ 'apps/api/package.json': '{ this is not json' });
    const anchor = result.anchors[0];
    assert.equal(anchor.kind, 'node-service');
    assert.equal(anchor.status, 'unreadable');
    assert.equal(anchor.manifest, null);
    assert.ok(result.notes.includes('component.unreadable'));
  });

  it('never falls back to another kind rules: the kind stays what the declaring file said', () => {
    const result = discover({ 'apps/api/package.json': 'not json at all', 'apps/api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
    const byKind = Object.fromEntries(result.anchors.map((anchor) => [anchor.kind, anchor.status]));
    assert.equal(byKind['node-service'], 'unreadable');
    assert.equal(byKind['dotnet-service'], 'ok');
  });

  it('reports a component the read budget could not reach as unbudgeted, not as broken', () => {
    const result = discover({ 'a/package.json': '{"name":"a"}', 'b/package.json': '{"name":"b"}', 'c/package.json': '{"name":"c"}' }, { limits: { workspaceBytes: 20 } });
    const statuses = result.anchors.map((anchor) => anchor.status);
    assert.ok(statuses.includes('unbudgeted'), statuses.join(','));
  });
});
