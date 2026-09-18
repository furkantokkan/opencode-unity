import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView, joinProjectPath } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { discoverComponents, walkTree } from '../../../../src/project/discover.js';
import { readComposeServices } from '../../../../src/project/compose.js';
import { loadSignatures, signatureRow } from '../../../../src/project/signatures.js';
import { detectGameServer, ROLE_LABEL, roleOf, unityGameServerSignals } from '../../../../src/project/components/game-server.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\server-tests' : '/server-tests';

/**
 * @param {Record<string, string | null>} tree
 */
function workspace(tree) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const walk = walkTree(view, ROOT);
  return { view, walk, budget: createReadBudget(view, ROOT) };
}

/**
 * @param {'unityPackage' | 'assembly' | 'dependency'} key
 */
function gameServerRows(key) {
  return [...loadSignatures().rows.values()].filter((row) => row.id.startsWith('game-server/') && row.match[key] !== undefined);
}

describe('the allow-list is the signature table (D-B16, D-B17)', () => {
  for (const row of gameServerRows('unityPackage')) {
    it(`fires on ${row.match.unityPackage} and names the row that did`, () => {
      const signals = unityGameServerSignals({ id: 'unity:client', dir: 'client', packageIds: [String(row.match.unityPackage)] });
      assert.deepEqual(signals.map((signal) => signal.signature), [row.id]);
      assert.equal(signals[0].value, row.value);
      assert.equal(signals[0].file, 'client/Packages/manifest.json');
    });
  }

  it('sees Mirror through its assemblies, with no package manifest at all (claim B28)', () => {
    const assemblies = [
      { name: 'Game.Runtime', file: 'Assets/Game/Game.Runtime.asmdef' },
      { name: 'Mirror', file: 'Assets/Mirror/Core/Mirror.asmdef' },
      { name: 'Mirror.Components', file: 'Assets/Mirror/Components/Mirror.Components.asmdef' },
      { name: 'Mirror.CompilerSymbols', file: 'Assets/Mirror/CompilerSymbols/Mirror.CompilerSymbols.asmdef' },
    ];
    const signals = unityGameServerSignals({ id: 'unity:client', dir: 'client', packageIds: [], assemblies });
    assert.deepEqual(signals.map((signal) => signal.signature).sort(), ['game-server/signal.mirror-assembly', 'game-server/signal.mirror-components', 'game-server/signal.mirror-symbols']);
    assert.deepEqual([...new Set(signals.map((signal) => signal.value))], ['Mirror']);
    assert.ok(signals.some((signal) => signal.file === 'client/Assets/Mirror/Core/Mirror.asmdef'), 'the evidence is the asmdef, placed in the workspace');
  });

  it('places every Unity-relative file in the workspace', () => {
    const signals = unityGameServerSignals({ id: 'unity:client', dir: 'client', packageIds: ['com.unity.transport'], sources: [{ file: 'Assets/Net/Server.cs', text: '#if UNITY_SERVER' }] });
    assert.deepEqual(signals.map((signal) => signal.file).sort(), ['client/Assets/Net/Server.cs', 'client/Packages/manifest.json']);
  });

  it('does not fire on a package that has no row, whatever it is called', () => {
    assert.deepEqual(unityGameServerSignals({ id: 'unity:client', dir: '', packageIds: ['com.unity.inputsystem', 'nakama-js', 'com.example.netlib'] }), []);
  });

  it('keeps every signal traceable to a row that exists', () => {
    for (const key of /** @type {const} */ (['unityPackage', 'assembly', 'dependency'])) {
      for (const row of gameServerRows(key)) assert.ok(signatureRow(row.id));
    }
  });
});

describe('the dedicated-server signals (claim B26)', () => {
  it('fires on the define, the scripted subtarget and the command-line flag', () => {
    const row = signatureRow('game-server/signal.unity-server-define');
    for (const token of row.match.contains ?? []) {
      const signals = unityGameServerSignals({ id: 'unity:client', dir: '', sources: [{ file: 'Assets/Game/Net/ServerLoop.cs', text: `#if ${token}` }] });
      assert.deepEqual(signals.map((signal) => signal.signature), [row.id], token);
      assert.equal(signals[0].file, 'Assets/Game/Net/ServerLoop.cs');
    }
  });

  it('reads a workflow file that the walk never sees, because the folder is hidden', () => {
    const { budget } = workspace({ '.github/workflows/build.yml': 'run: unity -standaloneBuildSubtarget Server' });
    const { overlays } = detectGameServer(budget, { unityClients: [{ id: 'unity:root', dir: '' }], ciFiles: ['.github/workflows/build.yml'] });
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].attachedTo, 'unity:root');
    assert.deepEqual(overlays[0].products, ['UNITY_SERVER']);
    assert.equal(overlays[0].declaredBy, '.github/workflows/build.yml');
  });

  it('attaches a workflow signal to the workspace when it cannot tell which Unity client it builds', () => {
    const { budget } = workspace({ '.github/workflows/build.yml': 'run: unity -standaloneBuildSubtarget Server' });
    const { overlays } = detectGameServer(budget, { unityClients: [{ id: 'unity:client', dir: 'client' }, { id: 'unity:tools', dir: 'tools' }], ciFiles: ['.github/workflows/build.yml'] });
    assert.deepEqual(overlays.map((overlay) => overlay.attachedTo), ['workspace']);
    assert.deepEqual(budget.state.opened, ['.github/workflows/build.yml'], 'read once, however many clients there are');
  });
});

describe('a node service is its own attachment point', () => {
  it('fires on a dependency that has a row, and attaches to that service', () => {
    const { budget } = workspace({ 'apps/match/package.json': '{}' });
    const { overlays } = detectGameServer(budget, {
      nodeServices: [{ id: 'node:match', dir: 'apps/match', declaredBy: 'apps/match/package.json', dependencyNames: ['colyseus', '@colyseus/core', 'socket.io', 'express'] }],
    });
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].attachedTo, 'node:match');
    assert.equal(overlays[0].dir, 'apps/match');
    assert.deepEqual(overlays[0].products, ['Colyseus', 'Socket.IO']);
    assert.equal(overlays[0].id, 'server:apps-match');
  });

  it('produces no overlay at all for a service with no signal', () => {
    const { budget } = workspace({ 'apps/api/package.json': '{}' });
    const { overlays } = detectGameServer(budget, { nodeServices: [{ id: 'node:api', dir: 'apps/api', declaredBy: 'apps/api/package.json', dependencyNames: ['express', 'fastify'] }] });
    assert.deepEqual(overlays, []);
  });
});

describe('a matchmaking or lobby role is a label, not a claim', () => {
  it('carries its qualifier, and is produced only by route names', () => {
    assert.equal(ROLE_LABEL, 'matchmaking/lobby (by route names)');
    assert.equal(roleOf([{ label: 'ROOM lobby' }]), ROLE_LABEL);
    assert.equal(roleOf([{ label: 'GET /matchmaking/ticket' }]), ROLE_LABEL);
    assert.equal(roleOf([{ label: 'GET /health' }, { label: 'POST /scores' }]), null);
    assert.equal(roleOf([]), null);
  });

  it('is attached to the service whose routes produced it, and to no other', () => {
    const { budget } = workspace({ 'apps/match/package.json': '{}', 'apps/api/package.json': '{}' });
    const { overlays } = detectGameServer(budget, {
      nodeServices: [
        { id: 'node:match', dir: 'apps/match', declaredBy: 'apps/match/package.json', dependencyNames: ['colyseus'], routes: [{ label: 'ROOM lobby' }] },
        { id: 'node:api', dir: 'apps/api', declaredBy: 'apps/api/package.json', dependencyNames: ['socket.io'], routes: [{ label: 'GET /health' }] },
      ],
    });
    assert.deepEqual(overlays.map((overlay) => [overlay.attachedTo, overlay.role]), [['node:match', ROLE_LABEL], ['node:api', null]]);
  });
});

describe('the workspace attachment point', () => {
  const agones = ['apiVersion: agones.dev/v1', 'kind: GameServer', 'metadata:', '  name: sample'].join('\n');
  const compose = ['services:', '  gameserver:', '    image: sample/gameserver:dev', '    ports:', '      - "7777:7777"'].join('\n');

  it('fires on a custom resource kind (claim B31) and attaches to the workspace', () => {
    const { budget, walk } = workspace({ 'k8s/gameserver.yaml': agones });
    const { overlays } = detectGameServer(budget, { files: walk.files });
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].attachedTo, 'workspace');
    assert.deepEqual(overlays[0].products, ['Agones']);
  });

  it('adds the compose port only once a custom resource has established the overlay', () => {
    const withResource = workspace({ 'k8s/gameserver.yaml': agones, 'compose.yaml': compose });
    const composeFacts = readComposeServices(withResource.budget, { files: withResource.walk.files });
    const both = detectGameServer(withResource.budget, { files: withResource.walk.files, compose: composeFacts });
    assert.deepEqual(both.overlays[0].signals.map((signal) => signal.signature), ['game-server/port.compose', 'game-server/signal.agones']);

    const alone = workspace({ 'compose.yaml': compose });
    const aloneFacts = readComposeServices(alone.budget, { files: alone.walk.files });
    assert.deepEqual(detectGameServer(alone.budget, { files: alone.walk.files, compose: aloneFacts }).overlays, [], 'a published port on its own says nothing about a game server');
  });
});

describe('the committed fixtures', () => {
  it('describes the dedicated-server project from every source it has', () => {
    const root = path.join(WORKSPACES, 'unity-plus-dedicated-server');
    const view = createNodeFsView();
    const discovery = discoverComponents(view, root);
    const compose = readComposeServices(discovery.budget, { files: discovery.walk.files });
    const manifest = JSON.parse(String(view.readText(joinProjectPath(root, 'Packages/manifest.json'))?.text));
    const sources = ['Assets/Editor/BuildScript.cs', 'Assets/Game/Net/ServerLoop.cs'].map((file) => ({ file, text: String(view.readText(joinProjectPath(root, file))?.text) }));

    const { overlays } = detectGameServer(discovery.budget, {
      unityClients: [{ id: 'unity:root', dir: '', packageIds: Object.keys(manifest.dependencies), sources }],
      files: discovery.walk.files,
      compose,
    });

    const unity = overlays.find((overlay) => overlay.attachedTo === 'unity:root');
    const workspaceOverlay = overlays.find((overlay) => overlay.attachedTo === 'workspace');
    assert.ok(unity && workspaceOverlay);
    assert.deepEqual(unity.products, ['Dedicated Server package', 'Multiplayer Play Mode', 'Netcode for GameObjects', 'UNITY_SERVER']);
    assert.deepEqual(workspaceOverlay.products, ['Agones'], 'the compose port is evidence, not a product name');
    assert.ok(workspaceOverlay.signals.some((signal) => signal.signature === 'game-server/port.compose'));
    assert.equal(unity.role, null, 'a Unity client has no route names to label');
  });

  it('describes the monorepo: one Unity client, one match service, and no overlay on the API', () => {
    const root = path.join(WORKSPACES, 'monorepo-workspaces');
    const view = createNodeFsView();
    const discovery = discoverComponents(view, root);
    const manifest = JSON.parse(String(view.readText(joinProjectPath(root, 'client/Packages/manifest.json'))?.text));

    const { overlays } = detectGameServer(discovery.budget, {
      unityClients: [{ id: 'unity:client', dir: 'client', packageIds: Object.keys(manifest.dependencies) }],
      nodeServices: [
        { id: 'node:api', dir: 'apps/api', declaredBy: 'apps/api/package.json', dependencyNames: ['express'], routes: [{ label: 'GET /health' }] },
        { id: 'node:match', dir: 'apps/match', declaredBy: 'apps/match/package.json', dependencyNames: ['colyseus', '@colyseus/core'], routes: [{ label: 'ROOM lobby' }, { label: 'ROOM match' }] },
      ],
      files: discovery.walk.files,
    });

    assert.deepEqual(overlays.map((overlay) => overlay.attachedTo), ['unity:client', 'node:match']);
    assert.deepEqual(overlays[0].products, ['Colyseus', 'Netcode for GameObjects']);
    assert.equal(overlays[1].role, ROLE_LABEL);
  });

  it('produces no overlay for a project with no multiplayer signal', () => {
    const root = path.join(WORKSPACES, 'unity-plus-functions');
    const view = createNodeFsView();
    const discovery = discoverComponents(view, root);
    const manifest = JSON.parse(String(view.readText(joinProjectPath(root, 'client/Packages/manifest.json'))?.text));
    const { overlays } = detectGameServer(discovery.budget, {
      unityClients: [{ id: 'unity:client', dir: 'client', packageIds: Object.keys(manifest.dependencies ?? {}) }],
      nodeServices: [{ id: 'node:functions', dir: 'functions', declaredBy: 'functions/package.json', dependencyNames: ['firebase-functions', 'firebase-admin'] }],
      files: discovery.walk.files,
    });
    assert.deepEqual(overlays, []);
  });
});
