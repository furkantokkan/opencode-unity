import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMemoryFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { extractRoutes, literalListenPorts, literalRelativeImports, MAX_ROUTES, MAX_ROUTE_LABEL } from '../../../../src/project/routes.js';

const ROOT = process.platform === 'win32' ? 'C:\\route-tests' : '/route-tests';

/**
 * @param {Record<string, string>} tree
 * @param {{ entry?: string, maxRoutes?: number, maxHops?: number }} [options]
 */
function scan(tree, { entry = 'src/index.js', maxRoutes = MAX_ROUTES, maxHops = 3 } = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const budget = createReadBudget(view, ROOT);
  const facts = extractRoutes(budget, { entry, files: Object.keys(tree), maxRoutes, maxHops });
  return { facts, budget, labels: facts.routes.map((route) => route.label) };
}

describe('the five shapes of 14.6.4', () => {
  it('records a method and a path', () => {
    const { labels } = scan({
      'src/index.js': ["import express from 'express';", "app.get('/health', handler);", "app.post('/scores', handler);", "app.delete('/scores/:id', handler);"].join('\n'),
    });
    assert.deepEqual(labels, ['DELETE /scores/:id', 'GET /health', 'POST /scores']);
  });

  it('records a mount', () => {
    const { labels } = scan({ 'src/index.js': "app.use('/seasons', seasonRouter);" });
    assert.deepEqual(labels, ['MOUNT /seasons']);
  });

  it('records a route object whose method and url are on later lines', () => {
    const { labels } = scan({ 'src/index.js': ['app.route({', "  method: 'PUT',", "  url: '/players/:id',", '  handler,', '});'].join('\n') });
    assert.deepEqual(labels, ['PUT /players/:id']);
  });

  it('records a function and its transport, in both the CommonJS and the ESM spelling', () => {
    const { labels } = scan({
      'src/index.js': ['exports.health = onRequest(handler);', 'export const claimReward = onCall(handler);', 'exports.legacy = functions.https.onRequest(handler);'].join('\n'),
    });
    assert.deepEqual(labels, ['FN claimReward (callable)', 'FN health (http)', 'FN legacy (http)']);
  });

  it('records a room definition', () => {
    const { labels } = scan({ 'src/index.js': ["gameServer.define('lobby', LobbyRoom);", "gameServer.define('match', MatchRoom);"].join('\n') });
    assert.deepEqual(labels, ['ROOM lobby', 'ROOM match']);
  });
});

describe('what the scan refuses to call a route', () => {
  it('ignores a method call whose argument is not a path', () => {
    const { labels } = scan({ 'src/index.js': ["const value = cache.get('season');", "app.get('/health', handler);"].join('\n') });
    assert.deepEqual(labels, ['GET /health']);
  });

  it('ignores a registration that does not start its line', () => {
    const { labels } = scan({ 'src/index.js': "const register = () => app.get('/late', handler);" });
    assert.deepEqual(labels, []);
  });

  it('records the literal prefix of an interpolated path, never the expression', () => {
    const { labels } = scan({ 'src/index.js': ['app.get(`/players/${id}/scores`, handler);'].join('\n') });
    assert.deepEqual(labels, ['GET /players/...']);
  });

  it('clamps a very long path to the label budget', () => {
    const long = `/${'segment/'.repeat(12)}end`;
    const { labels } = scan({ 'src/index.js': `app.get('${long}', handler);` });
    assert.equal(labels[0].length, MAX_ROUTE_LABEL);
    assert.ok(labels[0].endsWith('...'));
  });

  it('deduplicates identical labels from two files', () => {
    const { labels } = scan({
      'src/index.js': ["import './routes/a.js';", "app.get('/health', handler);"].join('\n'),
      'src/routes/a.js': "router.get('/health', handler);",
    });
    assert.deepEqual(labels, ['GET /health']);
  });
});

describe('one hop, and exactly one', () => {
  const tree = {
    'src/index.js': ["import game from './routes/game.js';", "const admin = require('./routes/admin');", "export * from './routes/season.js';", "import express from 'express';", "app.use('/game', game);"].join('\n'),
    'src/routes/game.js': ["import deep from './deep.js';", "router.get('/game/state', handler);"].join('\n'),
    'src/routes/admin.js': "router.post('/admin/ban', handler);",
    'src/routes/season.js': "router.get('/season/current', handler);",
    'src/routes/deep.js': "router.get('/never/reached', handler);",
  };

  it('follows literal relative imports from the entry and stops there', () => {
    const { facts, labels } = scan(tree);
    assert.deepEqual(facts.sources, ['src/index.js', 'src/routes/game.js', 'src/routes/admin.js', 'src/routes/season.js']);
    assert.deepEqual(labels, ['GET /game/state', 'GET /season/current', 'MOUNT /game', 'POST /admin/ban']);
    assert.equal(labels.includes('GET /never/reached'), false, 'a second-level import must not be followed');
  });

  it('follows at most the configured number of files and says it stopped', () => {
    const { facts } = scan(tree, { maxHops: 2 });
    assert.deepEqual(facts.sources, ['src/index.js', 'src/routes/game.js', 'src/routes/admin.js']);
    assert.equal(facts.truncated, true);
  });

  it('never follows a bare specifier, an alias or a path that leaves the workspace', () => {
    const files = ['src/index.js', 'src/routes/game.js'];
    const text = ["import express from 'express';", "import x from '@app/shared';", "import y from '../../outside/x.js';", "import game from './routes/game.js';"].join('\n');
    assert.deepEqual(literalRelativeImports(text, 'src/index.js', files), ['src/routes/game.js']);
  });
});

describe('a literal listen port, from the entry file only (37.8)', () => {
  it('records the positional and the object form', () => {
    assert.deepEqual(literalListenPorts(['app.listen(3000);', 'await server.listen({ host: "127.0.0.1", port: 8081 });', 'app.listen(3000, () => {});'].join('\n')), [3000, 8081]);
  });

  it('records nothing for a port that comes from a variable or is not a port', () => {
    assert.deepEqual(literalListenPorts(['app.listen(process.env.PORT);', 'app.listen(PORT);', 'app.listen({ port: Number(process.env.PORT) });', 'app.listen(0);', 'app.listen(70000);', '  const later = () => app.listen(9999);'].join('\n')), []);
  });

  it('reads the entry file for it and not the files one hop away', () => {
    const { facts } = scan({ 'src/index.js': ["import './server.js';", 'app.listen(3000);'].join('\n'), 'src/server.js': 'other.listen(4000);' });
    assert.deepEqual(facts.listenPorts, [3000]);
    assert.ok(facts.evidence.some((entry) => entry.signature === 'spec:37.8' && entry.file === 'src/index.js'));
  });
});

describe('the caps and the refusals', () => {
  it('keeps at most the configured number of routes, sorted, and reports the cut', () => {
    const lines = Array.from({ length: 25 }, (_, index) => `app.get('/route-${String(index).padStart(2, '0')}', handler);`);
    const { facts } = scan({ 'src/index.js': lines.join('\n') }, { maxRoutes: 20 });
    assert.equal(facts.routes.length, 20);
    assert.equal(facts.truncated, true);
    assert.deepEqual(facts.routes.map((route) => route.label).slice(0, 2), ['GET /route-00', 'GET /route-01']);
  });

  it('extracts nothing, and opens nothing, when there is no entry', () => {
    const { facts, budget } = scan({ 'src/index.js': "app.get('/health', handler);" }, { entry: null });
    assert.deepEqual(facts.routes, []);
    assert.deepEqual(budget.state.opened, []);
  });

  it('names the entry file behind the route list', () => {
    const { facts } = scan({ 'src/index.js': "app.get('/health', handler);" });
    assert.deepEqual(facts.evidence, [{ fact: 'routes', signature: 'spec:37.4', file: 'src/index.js' }]);
  });
});
