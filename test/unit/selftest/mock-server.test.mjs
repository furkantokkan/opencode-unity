import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMockPort, FORBIDDEN_MOCK_PORTS, sendJson, startMockServer } from '../../../src/selftest/mock-server.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../../../src/selftest/mock-server.js').MockHandler[]} handlers
 */
async function serve(t, handlers) {
  const server = await startMockServer({ handlers });
  t.after(() => server.close());
  return server;
}

/** @type {import('../../../src/selftest/mock-server.js').MockHandler} */
const echoHandler = {
  name: 'echo',
  handle(request, response) {
    if (request.path !== '/echo') return false;
    sendJson(response, 200, { method: request.method, body: request.body });
    return true;
  },
};

test('mock server: routes to the first handler that answers and records every request', async (t) => {
  const seen = [];
  const server = await serve(t, [
    { name: 'skip', handle: (request) => { seen.push(request.path); return false; } },
    echoHandler,
  ]);

  const answer = await fetch(`${server.url}/echo`, { method: 'POST', body: JSON.stringify({ hello: 'world' }) });

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { method: 'POST', body: { hello: 'world' } });
  assert.deepEqual(seen, ['/echo']);
  assert.equal(server.requests.length, 1);
  const [request] = server.requests;
  assert.equal(request.handledBy, 'echo');
  assert.equal(request.status, 200);
  assert.equal(request.bodyBytes, JSON.stringify({ hello: 'world' }).length);
  assert.equal(request.aborted, false);
  assert.match(request.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('mock server: an unrouted request gets 404 and is still recorded', async (t) => {
  const server = await serve(t, [echoHandler]);

  const answer = await fetch(`${server.url}/other?x=1`);

  assert.equal(answer.status, 404);
  assert.equal(server.requests[0].path, '/other');
  assert.equal(server.requests[0].url, '/other?x=1');
  assert.equal(server.requests[0].handledBy, null);
});

test('mock server: a body that is not JSON stays available as text', async (t) => {
  const server = await serve(t, [echoHandler]);

  await fetch(`${server.url}/echo`, { method: 'POST', body: 'not json' });

  assert.equal(server.requests[0].body, undefined);
  assert.equal(server.requests[0].bodyText, 'not json');
});

test('mock server: waitFor resolves when the condition holds and rejects on timeout', async (t) => {
  const server = await serve(t, [echoHandler]);

  const waiting = server.waitFor((requests) => requests.length === 1);
  await fetch(`${server.url}/echo`);
  await waiting;

  await assert.rejects(
    () => server.waitFor((requests) => requests.length === 5, { timeoutMs: 30 }),
    /condition not met within 30 ms/,
  );
});

test('mock server: a handler failure answers 500 instead of hanging', async (t) => {
  const server = await serve(t, [{ name: 'broken', handle: () => { throw new Error('mock exploded'); } }]);

  const answer = await fetch(`${server.url}/anything`);

  assert.equal(answer.status, 500);
  assert.match(JSON.stringify(await answer.json()), /mock exploded/);
});

test('mock server: the ports of the real Ollama and the real hub are refused', async () => {
  for (const port of FORBIDDEN_MOCK_PORTS) {
    assert.throws(() => assertMockPort(port), /belongs to a real service/);
    await assert.rejects(() => startMockServer({ handlers: [], port }), /belongs to a real service/);
  }
  await assert.rejects(() => startMockServer({ handlers: [], host: '0.0.0.0' }), /listen on 127\.0\.0\.1 only/);
});
