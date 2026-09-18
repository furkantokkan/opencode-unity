import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANCHOR_KINDS, assignComponentIds, COMPONENT_KINDS, componentId, ID_PREFIXES, isAnchorKind, MAX_SLUG_LENGTH, OVERLAY_KINDS, slugForDir } from '../../../../src/project/ids.js';

describe('component ids', () => {
  it('names a component after its folder, which is what a 200-character fact block can carry', () => {
    assert.equal(componentId('unity-client', 'client'), 'unity:client');
    assert.equal(componentId('node-service', 'functions'), 'node:functions');
    assert.equal(componentId('node-service', 'apps/api'), 'node:apps-api');
    assert.equal(componentId('dotnet-service', 'Api'), 'dotnet:api');
    assert.equal(componentId('firebase-project', ''), 'firebase:root');
    assert.equal(componentId('database', 'functions', 'drizzle'), 'db:functions-drizzle');
    assert.equal(componentId('game-server', ''), 'server:root');
  });

  it('treats the workspace root and "." as the same folder', () => {
    assert.equal(slugForDir(''), 'root');
    assert.equal(slugForDir('.'), 'root');
    assert.equal(slugForDir('./apps/api'), 'apps-api');
  });

  it('collapses every non-alphanumeric run to one dash', () => {
    assert.equal(slugForDir('apps/@scope/my_api.v2'), 'apps-scope-my-api-v2');
    assert.equal(slugForDir('Api.Tests'), 'api-tests');
  });

  it('caps the slug at 24 characters, keeping whole trailing segments', () => {
    const id = componentId('node-service', 'apps/services/matchmaking');
    assert.ok(id.length <= 'node:'.length + MAX_SLUG_LENGTH, id);
    assert.equal(id, 'node:services-matchmaking');
    assert.equal(slugForDir('a-single-segment-that-is-far-too-long-to-fit').length, MAX_SLUG_LENGTH);
  });

  it('refuses a kind it does not know rather than inventing a prefix', () => {
    assert.throws(() => componentId(/** @type {any} */ ('tooling'), 'ops'), /Unknown component kind/);
  });

  it('separates anchors from overlays, because only anchors can conflict', () => {
    assert.deepEqual([...ANCHOR_KINDS], ['unity-client', 'node-service', 'dotnet-service']);
    assert.deepEqual([...OVERLAY_KINDS], ['firebase-project', 'database', 'game-server']);
    assert.deepEqual([...COMPONENT_KINDS].sort(), Object.keys(ID_PREFIXES).sort());
    assert.equal(isAnchorKind('node-service'), true);
    assert.equal(isAnchorKind('database'), false);
  });
});

describe('assignComponentIds', () => {
  it('leaves distinct components alone', () => {
    assert.deepEqual(
      assignComponentIds([
        { kind: 'unity-client', dir: 'client' },
        { kind: 'node-service', dir: 'functions' },
        { kind: 'firebase-project', dir: '' },
      ]),
      ['unity:client', 'node:functions', 'firebase:root'],
    );
  });

  it('breaks a collision with a suffix derived from the declaring file, not from the position', () => {
    // Two folders whose trailing segments coincide once the 24-character cap has bitten.
    const candidates = [
      { kind: /** @type {const} */ ('node-service'), dir: 'apps/alpha/services/matchmaking', declaredBy: 'apps/alpha/services/matchmaking/package.json' },
      { kind: /** @type {const} */ ('node-service'), dir: 'apps/beta/services/matchmaking', declaredBy: 'apps/beta/services/matchmaking/package.json' },
    ];
    const ids = assignComponentIds(candidates);
    assert.equal(ids[0], 'node:services-matchmaking');
    assert.notEqual(ids[0], ids[1]);
    assert.match(ids[1], /^node:services-matchmaking-[0-9a-f]{4}$/);
    assert.deepEqual(assignComponentIds(candidates), ids, 'the suffix is stable across runs');
  });

  it('keeps going when even the suffix collides', () => {
    const same = { kind: /** @type {const} */ ('database'), dir: 'db', declaredBy: 'db/schema.prisma' };
    const ids = assignComponentIds([same, same, same]);
    assert.equal(new Set(ids).size, 3);
  });
});
