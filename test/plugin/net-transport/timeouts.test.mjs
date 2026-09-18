// The three timeouts (amendment 35.5, steps 14 and 19). They are separate on purpose: OpenCode's own
// `webfetch` bounds request execution and not the body read (claim 125), so a server that answers
// immediately and then dribbles for an hour would be unbounded under a single timer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONNECT_MODES, TRANSPORT_CODES, sendRequest } from '../../../plugin/opencode-unity-lib/net/transport.js';
import { createRequestStub, createSocketStub, limits, pin, startRawServer } from './helpers.mjs';

const PIN = pin('127.0.0.1');

describe('the connect timeout', () => {
  it('fires while the socket is still connecting, and nothing else has started', async () => {
    const stub = createRequestStub();
    const pending = sendRequest(
      {
        method: 'GET',
        url: 'http://docs.example.test/Manual/index.html',
        pinned: PIN,
        limits: limits({ connectTimeoutMs: 30, firstByteTimeoutMs: 20000, totalTimeoutMs: 20000 }),
        connectMode: CONNECT_MODES.pinnedLookup,
      },
      { httpRequest: /** @type {any} */ (stub.request) },
    );
    // A socket that never connects: no `connect` event is ever emitted.
    stub.calls[0].request.emit('socket', createSocketStub());

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.connectTimeout);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, null);
    assert.ok(stub.calls[0].request.destroyed);
  });

  it('is over once the socket is connected, however slowly the answer comes', async (t) => {
    const server = await startRawServer((socket) => {
      setTimeout(() => socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nslow'), 500).unref();
    });
    t.after(() => server.close());

    // The header is slower than the connect budget: a connect timer that was not cleared would end this.
    const result = await sendRequest({
      method: 'GET',
      url: `${server.origin}/slow-headers`,
      pinned: PIN,
      limits: limits({ connectTimeoutMs: 300, firstByteTimeoutMs: 8000, totalTimeoutMs: 15000 }),
      connectMode: CONNECT_MODES.literalAddress,
    });
    assert.equal(result.ok, true, String(result.code));
    assert.equal(result.body, 'slow');
  });
});

describe('the first-byte timeout', () => {
  it('fires when the connection stands open and no header ever arrives', async (t) => {
    // The server accepts and says nothing at all.
    const server = await startRawServer(() => {});
    t.after(() => server.close());

    const started = Date.now();
    const result = await sendRequest({
      method: 'GET',
      url: `${server.origin}/silent`,
      pinned: PIN,
      limits: limits({ connectTimeoutMs: 4000, firstByteTimeoutMs: 80, totalTimeoutMs: 8000 }),
      connectMode: CONNECT_MODES.literalAddress,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.firstByteTimeout);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, null);
    assert.ok(Date.now() - started < 4000, 'the first-byte budget ended it, not the connect budget');
  });
});

describe('the total timeout', () => {
  it('ends a body that never stops, and hands back what had arrived', async (t) => {
    const server = await startRawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
      socket.write('4\r\ndrip\r\n');
      // And then nothing: the chunked body is never closed.
    });
    t.after(() => server.close());

    const result = await sendRequest({
      method: 'GET',
      url: `${server.origin}/dribble`,
      pinned: PIN,
      limits: limits({ connectTimeoutMs: 4000, firstByteTimeoutMs: 4000, totalTimeoutMs: 150 }),
      connectMode: CONNECT_MODES.literalAddress,
    });
    assert.equal(result.ok, true, 'the call still produces a result the session can continue from');
    assert.equal(result.code, TRANSPORT_CODES.totalTimeout);
    assert.equal(result.stoppedBy, 'total-timeout');
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'drip', 'what arrived before the limit is kept');
  });

  it('refuses outright when it fires before any header, whatever the other two budgets allow', async (t) => {
    const server = await startRawServer(() => {});
    t.after(() => server.close());

    const result = await sendRequest({
      method: 'GET',
      url: `${server.origin}/silent`,
      pinned: PIN,
      limits: limits({ connectTimeoutMs: 9000, firstByteTimeoutMs: 9000, totalTimeoutMs: 60 }),
      connectMode: CONNECT_MODES.literalAddress,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.totalTimeout);
    assert.equal(result.status, null);
    assert.equal(result.body, '');
  });
});

describe('every settled request', () => {
  it('leaves no timer running behind it', async () => {
    const before = countTimers();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stub = createRequestStub();
      const pending = sendRequest(
        {
          method: 'GET',
          url: 'http://docs.example.test/Manual/index.html',
          pinned: PIN,
          // Budgets far longer than the test: a leaked timer would still be pending at the end.
          limits: limits({ connectTimeoutMs: 30000, firstByteTimeoutMs: 30000, totalTimeoutMs: 30000 }),
          connectMode: CONNECT_MODES.pinnedLookup,
        },
        { httpRequest: /** @type {any} */ (stub.request) },
      );
      const socket = createSocketStub({ remoteAddress: '198.51.100.99' });
      stub.calls[0].request.emit('socket', socket);
      socket.connect();
      const result = await pending;
      assert.equal(result.code, TRANSPORT_CODES.addressBlocked);
    }
    assert.ok(countTimers() <= before, `timers left behind: ${countTimers() - before}`);
  });
});

/**
 * @returns {number}
 */
function countTimers() {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}
