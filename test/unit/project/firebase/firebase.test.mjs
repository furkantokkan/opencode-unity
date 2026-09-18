import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { DEMO_PREFIX, readFirebaseFacts } from '../../../../src/project/components/firebase.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\firebase-tests' : '/firebase-tests';

/**
 * @param {Record<string, string | null>} tree
 * @param {{ dir?: string }} [options]
 */
function read(tree, { dir = '' } = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const budget = createReadBudget(view, ROOT);
  return { facts: readFirebaseFacts(budget, { dir }), budget };
}

/**
 * @param {unknown} value
 */
function asJson(value) {
  return JSON.stringify(value);
}

describe('the documented comprehensive firebase.json', () => {
  const { facts } = read({
    'firebase.json': asJson({
      hosting: { public: 'public' },
      apphosting: { backendId: 'sample' },
      firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
      storage: { rules: 'storage.rules' },
      database: { rules: 'database.rules.json' },
      dataconnect: { source: 'dataconnect' },
      functions: [{ source: 'functions', codebase: 'default' }],
      emulators: { auth: { port: 9099 }, functions: { port: 5001 }, firestore: { port: 8080 }, database: { port: 9000 }, hosting: { port: 5000 }, pubsub: { port: 8085 }, storage: { port: 9199 }, ui: { enabled: true, port: 4000 }, hub: { port: 4400 }, singleProjectMode: true },
      extensions: {},
      remoteconfig: { template: 'remoteconfig.template.json' },
    }),
  });

  it('records every configured product key', () => {
    assert.deepEqual(facts.products, ['apphosting', 'database', 'dataconnect', 'emulators', 'extensions', 'firestore', 'functions', 'hosting', 'remoteconfig', 'storage']);
  });

  it('records every rules file and every index file as a path, and opens none of them', () => {
    assert.deepEqual(facts.rulesFiles, ['database.rules.json', 'firestore.rules', 'storage.rules']);
    assert.deepEqual(facts.indexFiles, ['firestore.indexes.json']);
  });

  it('keeps product emulator ports apart from the suite own surfaces', () => {
    assert.deepEqual(facts.emulators, { auth: 9099, functions: 5001, firestore: 8080, database: 9000, hosting: 5000, pubsub: 8085, storage: 9199 });
    assert.deepEqual(facts.suitePorts, { ui: 4000, hub: 4400 });
  });

  it('ignores a port that is not a usable integer', () => {
    const { facts: odd } = read({ 'firebase.json': asJson({ emulators: { functions: { port: 'auto' }, firestore: { port: 0 }, auth: { port: 70_000 }, storage: { port: 9199 } } }) });
    assert.deepEqual(odd.emulators, { storage: 9199 });
  });
});

describe('functions: the array form and the object form', () => {
  it('maps a two-codebase array to two entries, sorted by codebase', () => {
    const { facts } = read({
      'firebase.json': asJson({ functions: [{ source: 'services/match', codebase: 'match' }, { source: 'functions', codebase: 'default' }] }),
      'functions/package.json': asJson({ engines: { node: '22' } }),
      'services/match/package.json': asJson({ engines: { node: '20' } }),
    });
    assert.deepEqual(
      facts.codebases.map((entry) => `${entry.codebase} ${entry.source} ${entry.runtime}`),
      ['default functions nodejs22', 'match services/match nodejs20'],
    );
  });

  it('accepts the single-object form firebase init writes', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'functions' } }), 'functions/package.json': asJson({ engines: { node: '22' } }) });
    assert.equal(facts.codebases.length, 1);
    assert.equal(facts.codebases[0].codebase, 'default');
  });

  it('defaults the source to functions/ when the entry does not name one', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: {} }), 'functions/package.json': asJson({ engines: { node: '22' } }) });
    assert.equal(facts.codebases[0].source, 'functions');
  });

  it('normalises a source written with backslashes', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'services\\match' } }), 'services/match/package.json': asJson({ engines: { node: '22' } }) });
    assert.equal(facts.codebases[0].source, 'services/match');
  });
});

describe('the functions runtime', () => {
  it('prefers functions.runtime, and says where it came from', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'functions', runtime: 'nodejs20' } }), 'functions/package.json': asJson({ engines: { node: '22' } }) });
    assert.equal(facts.codebases[0].runtime, 'nodejs20');
    assert.equal(facts.codebases[0].runtimeSource, 'firebase.json functions.runtime');
  });

  it('falls back to engines.node in the source package.json', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'functions' } }), 'functions/package.json': asJson({ engines: { node: '>=20' } }) });
    assert.equal(facts.codebases[0].runtime, 'nodejs20');
    assert.equal(facts.codebases[0].runtimeSource, 'functions/package.json engines.node');
  });

  it('reuses a manifest discovery already read rather than opening it again', () => {
    const { facts, budget } = readWithManifests();
    assert.equal(facts.codebases[0].runtime, 'nodejs22');
    assert.deepEqual(budget.state.opened, ['firebase.json']);
  });

  it('reports an unknown runtime instead of inventing one', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'functions' } }) });
    assert.equal(facts.codebases[0].runtime, null);
    assert.equal(facts.codebases[0].runtimeSource, null);
    assert.ok(facts.warnings.includes('firebase.functions-runtime-unknown'));
  });

  function readWithManifests() {
    const view = createMemoryFsView({ [path.join(ROOT, 'firebase.json')]: asJson({ functions: { source: 'functions' } }) });
    const budget = createReadBudget(view, ROOT);
    return { facts: readFirebaseFacts(budget, { nodeManifests: { functions: { engines: { node: '22' } } } }), budget };
  }
});

describe('.firebaserc alias keys', () => {
  it('turns every non-demo alias key into a denied project segment', () => {
    const { facts } = read({ 'firebase.json': asJson({}), '.firebaserc': asJson({ projects: { default: 'sample-prod', staging: 'sample-staging', 'demo-ci': 'demo-ci' } }) });
    assert.deepEqual(facts.aliases, ['default', 'demo-ci', 'staging']);
    assert.deepEqual(facts.deniedProjectSegments, ['default', 'staging']);
    assert.equal(DEMO_PREFIX, 'demo-');
  });

  it('records only demo- project ids, and never a live one', () => {
    const { facts } = read({ 'firebase.json': asJson({}), '.firebaserc': asJson({ projects: { default: 'demo-sample', prod: 'sample-prod-1234' } }) });
    assert.deepEqual(facts.demoProjectIds, ['demo-sample']);
    assert.equal(JSON.stringify(facts).includes('sample-prod-1234'), false, 'a live project id must not be recorded');
  });

  it('warns only when the default alias points at a live project', () => {
    const live = read({ 'firebase.json': asJson({}), '.firebaserc': asJson({ projects: { default: 'sample-prod' } }) }).facts;
    const demo = read({ 'firebase.json': asJson({}), '.firebaserc': asJson({ projects: { default: 'demo-sample' } }) }).facts;
    const none = read({ 'firebase.json': asJson({}), '.firebaserc': asJson({ projects: { staging: 'demo-staging' } }) }).facts;

    assert.equal(live.defaultAliasIsDemo, false);
    assert.ok(live.warnings.includes('firebase.live-alias-default'));
    assert.equal(demo.defaultAliasIsDemo, true);
    assert.deepEqual(demo.warnings, []);
    assert.equal(none.defaultAliasIsDemo, null);
    assert.deepEqual(none.warnings, []);
  });

  it('survives a .firebaserc that is absent or malformed', () => {
    const absent = read({ 'firebase.json': asJson({}) }).facts;
    const broken = read({ 'firebase.json': asJson({}), '.firebaserc': '{ not json' }).facts;
    for (const facts of [absent, broken]) {
      assert.equal(facts.rcPresent, false);
      assert.deepEqual(facts.aliases, []);
      assert.deepEqual(facts.deniedProjectSegments, []);
    }
  });
});

describe('the reader is the only parser, and it refuses what it cannot describe', () => {
  it('returns absent, not an error, when there is no firebase.json', () => {
    const { facts } = read({ 'package.json': '{}' });
    assert.equal(facts.status, 'absent');
    assert.equal(facts.declaredBy, null);
  });

  it('returns unreadable rather than a guess when firebase.json is malformed', () => {
    const { facts } = read({ 'firebase.json': '{ "functions": ' });
    assert.equal(facts.status, 'unreadable');
    assert.equal(facts.declaredBy, 'firebase.json');
    assert.deepEqual(facts.codebases, []);
    assert.ok(facts.warnings.includes('component.unreadable'));
  });

  it('reads a firebase.json that is not at the workspace root', () => {
    const { facts } = read({ 'backend/firebase.json': asJson({ firestore: { rules: 'firestore.rules' }, functions: { source: 'fns' } }), 'backend/fns/package.json': asJson({ engines: { node: '22' } }) }, { dir: 'backend' });
    assert.equal(facts.declaredBy, 'backend/firebase.json');
    assert.deepEqual(facts.rulesFiles, ['backend/firestore.rules']);
    assert.equal(facts.codebases[0].source, 'backend/fns');
  });

  it('names the signature row and the file behind every fact it states', () => {
    const { facts } = read({ 'firebase.json': asJson({ functions: { source: 'functions' }, firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, emulators: { functions: { port: 5001 } } }), 'functions/package.json': asJson({ engines: { node: '22' } }), '.firebaserc': asJson({ projects: { default: 'demo-sample' } }) });
    assert.deepEqual(facts.evidence, [
      { fact: 'overlay', signature: 'firebase/overlay.firebase-json', file: 'firebase.json' },
      { fact: 'signal', signature: 'firebase/signal.codebase', file: 'firebase.json' },
      { fact: 'runtime', signature: 'firebase/runtime.engines-node', file: 'functions/package.json' },
      { fact: 'signal', signature: 'firebase/signal.rules-files', file: 'firebase.json' },
      { fact: 'signal', signature: 'firebase/signal.index-files', file: 'firebase.json' },
      { fact: 'port', signature: 'firebase/port.emulators', file: 'firebase.json' },
      { fact: 'signal', signature: 'firebase/signal.alias-keys', file: '.firebaserc' },
    ]);
  });

  it('opens two files and no credential file, on a workspace full of them', () => {
    const root = path.join(WORKSPACES, 'hostile-workspace');
    const budget = createReadBudget(createNodeFsView(), root);
    const facts = readFirebaseFacts(budget);

    assert.equal(facts.status, 'ok');
    assert.deepEqual(budget.state.opened, ['firebase.json', 'functions/package.json', '.firebaserc']);
    assert.equal(budget.state.opened.some((file) => file.includes('runtimeconfig') || file.includes('service-account') || file.includes('google-services') || file.endsWith('.env')), false);
  });

  // `firebase.json` is repository content, which S15 declares untrusted. A path out of it must never
  // steer a metered read out of the workspace (D-B7) nor land in a committed fact (P6, CP-D14).
  it('drops a source, a rules path and an index path that leave the workspace', () => {
    for (const source of ['../private', '../../elsewhere', '/etc/functions', 'C:/Windows/Temp', 'sub/../../up']) {
      const { facts, budget } = read({
        'firebase.json': asJson({ functions: { source }, firestore: { rules: '../../etc/firestore.rules', indexes: '/etc/indexes.json' } }),
      });
      assert.deepEqual(facts.codebases, [], source);
      assert.deepEqual(facts.rulesFiles, []);
      assert.deepEqual(facts.indexFiles, []);
      assert.deepEqual(facts.warnings, ['firebase.path-outside-workspace']);
      assert.deepEqual(budget.state.opened, ['firebase.json']);
    }
  });

  it('still reads a source that stays inside the workspace, in either separator', () => {
    for (const source of ['services/match', 'services\\match', './services/match']) {
      const { facts, budget } = read({
        'firebase.json': asJson({ functions: { source } }),
        'services/match/package.json': asJson({ engines: { node: '22' } }),
      });
      assert.deepEqual(facts.codebases.map((entry) => entry.source), ['services/match'], source);
      assert.deepEqual(facts.warnings, []);
      assert.deepEqual(budget.state.opened, ['firebase.json', 'services/match/package.json']);
    }
  });
});

describe('the shape A fixture', () => {
  it('reads exactly what the facts block will render', () => {
    const budget = createReadBudget(createNodeFsView(), path.join(WORKSPACES, 'unity-plus-functions'));
    const facts = readFirebaseFacts(budget);

    assert.equal(facts.status, 'ok');
    assert.deepEqual(facts.codebases, [{ codebase: 'default', source: 'functions', runtime: 'nodejs22', runtimeSource: 'functions/package.json engines.node' }]);
    assert.deepEqual(facts.rulesFiles, ['firestore.rules', 'storage.rules']);
    assert.deepEqual(facts.indexFiles, ['firestore.indexes.json']);
    assert.deepEqual(facts.emulators, { auth: 9099, functions: 5001, firestore: 8080 });
    assert.deepEqual(facts.demoProjectIds, ['demo-sample']);
    assert.deepEqual(facts.warnings, []);
  });
});
