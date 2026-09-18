// What comes back, against real sockets on 127.0.0.1: the streaming byte budget, a declared length
// that is a lie, the content-type gate, the redirect that stops and the challenge that is not
// answered (amendment 35.5 steps 15-18, `S-NET-5`, `S-NET-6`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONNECT_MODES, TRANSPORT_CODES, sendRequest } from '../../../plugin/opencode-unity-lib/net/transport.js';
import { createRequestStub, createResponseStub, createSocketStub, limits, pin, startRawServer, startServer, streamBody } from './helpers.mjs';

const PIN = pin('127.0.0.1');

/**
 * @param {string} origin
 * @param {{ path?: string, method?: string, body?: string, maxResponseBytes?: number }} [options]
 */
function get(origin, { path = '/', method = 'GET', body, maxResponseBytes } = {}) {
  return sendRequest({
    method,
    url: `${origin}${path}`,
    pinned: PIN,
    body: body ?? null,
    limits: limits(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    connectMode: CONNECT_MODES.literalAddress,
  });
}

describe('a response that fits', () => {
  it('comes back whole, with its status and type', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"packages":["com.unity.inputsystem"]}');
    });
    t.after(() => server.close());

    const result = await get(server.origin, { path: '/v1/packages' });
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
    assert.equal(result.status, 200);
    assert.equal(result.stoppedBy, 'complete');
    assert.equal(result.contentType, 'application/json; charset=utf-8');
    assert.equal(result.body, '{"packages":["com.unity.inputsystem"]}');
    assert.equal(result.bytesRead, 38);
    assert.equal(result.truncatedAtBytes, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
  });

  it('passes a server error through instead of hiding it', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('upstream is unwell');
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.status, 500);
    assert.equal(result.body, 'upstream is unwell');
    assert.equal(result.ok, true);
  });

  it('sends the body it was given and reports what came back', async (t) => {
    /** @type {string[]} */
    const received = [];
    const server = await startServer((request, response) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"result":{"rank":4}}');
      });
    });
    t.after(() => server.close());

    const result = await get(server.origin, { method: 'POST', path: '/demo-app/us-central1/submit', body: '{"data":{"score":120}}' });
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"result":{"rank":4}}');
    assert.deepEqual(received, ['{"data":{"score":120}}']);
    assert.equal(server.requests[0].headers['content-length'], '22');
    assert.equal(server.requests[0].headers['accept-encoding'], 'identity');
  });
});

describe('the streaming byte budget', () => {
  it('cuts a body that is far larger than the budget and keeps only what fits', async (t) => {
    const server = await startServer((_request, response) => streamBody(response, { totalBytes: 10 * 1024 * 1024 }));
    t.after(() => server.close());

    const result = await get(server.origin, { maxResponseBytes: 4096 });
    assert.equal(result.ok, true);
    assert.equal(result.stoppedBy, 'byte-budget');
    assert.equal(result.truncatedAtBytes, true);
    assert.equal(result.bytesRead, 4096, 'the count stops at the budget');
    assert.equal(result.body.length, 4096, 'and nothing beyond the budget is retained');
  });

  it('does not call a body that ends exactly at the budget truncated', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('a'.repeat(1024));
    });
    t.after(() => server.close());

    const result = await get(server.origin, { maxResponseBytes: 1024 });
    assert.equal(result.bytesRead, 1024);
    assert.equal(result.truncatedAtBytes, false);
    assert.equal(result.stoppedBy, 'complete');
  });

  it('counts the bytes that arrive, not the length the server declared', async (t) => {
    // No Content-Length at all: chunked, and much larger than the budget.
    const server = await startRawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
      const block = 'b'.repeat(8192);
      for (let index = 0; index < 20; index += 1) socket.write(`${block.length.toString(16)}\r\n${block}\r\n`);
      socket.write('0\r\n\r\n');
    });
    t.after(() => server.close());

    const result = await get(server.origin, { maxResponseBytes: 2048 });
    assert.equal(result.contentLength, null, 'nothing was declared');
    assert.equal(result.bytesRead, 2048);
    assert.equal(result.truncatedAtBytes, true);
  });

  it('does not wait for a declared length the server never sends', async (t) => {
    const server = await startRawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n');
      socket.write('twenty bytes exactly');
      socket.end();
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.contentLength, 1048576, 'the lie is reported');
    assert.equal(result.bytesRead, 20, 'and what actually arrived is what is kept');
    assert.equal(result.body, 'twenty bytes exactly');
    assert.equal(result.stoppedBy, 'connection-lost');
    assert.equal(result.ok, true, 'a short body is not a refusal');
  });

  it('keeps nothing a server sends after the length it declared', async (t) => {
    const server = await startRawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\n');
      socket.write('hello');
      // The flood arrives after the declared body is complete, so this is a lie the client is already
      // past rather than a race with the parser.
      setTimeout(() => socket.write('c'.repeat(200000)), 20).unref();
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.bytesRead, 5);
    assert.equal(result.body, 'hello');
    assert.equal(result.stoppedBy, 'complete', 'the parse error that follows cannot reopen a settled result');
  });
});

describe('the content-type gate', () => {
  it('returns the type and the length of something it will not show, and no body', async (t) => {
    const payload = Buffer.alloc(300, 'z');
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
      response.end(payload);
    });
    t.after(() => server.close());

    const result = await get(server.origin, { path: '/download.bin' });
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.contentTypeNotText);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'application/octet-stream');
    assert.equal(result.contentLength, 300);
    assert.equal(result.body, '');
    assert.equal(result.bytesRead, 0, 'the body is never read');
  });

  it('refuses a body the server compressed although identity was asked for', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      response.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.contentEncodingNotIdentity);
    assert.equal(result.body, '');
  });

  it('accepts an explicit identity encoding', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'identity' });
      response.end('plain');
    });
    t.after(() => server.close());

    assert.equal((await get(server.origin)).body, 'plain');
  });
});

describe('a redirect', () => {
  it('is reported and never followed, and the target sees nothing', async (t) => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the model must never see this');
    });
    t.after(() => target.close());
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/moved`, 'content-type': 'text/html' });
      response.end('<html>moved</html>');
    });
    t.after(() => server.close());

    const result = await get(server.origin, { path: '/old' });
    assert.equal(result.status, 302);
    assert.equal(result.stoppedBy, 'redirect');
    assert.equal(result.body, '', 'not even the redirect page body is read');
    // The header is reported as it came; the policy decides whether that target is reachable.
    assert.equal(result.redirect?.location, `${target.origin}/moved`);
    assert.equal(target.requests.length, 0, 'the redirect target was never contacted');
    assert.equal(server.requests.length, 1);
  });

  it('stops on every 3xx, whatever the server calls it', async (t) => {
    /** @type {number} */
    let status = 301;
    const server = await startServer((_request, response) => {
      response.writeHead(status, { location: 'https://other.example.test/x', 'content-type': 'text/html' });
      response.end('moved');
    });
    t.after(() => server.close());

    for (const code of [301, 302, 303, 307, 308]) {
      status = code;
      const result = await get(server.origin);
      assert.equal(result.status, code);
      assert.equal(result.stoppedBy, 'redirect');
      assert.equal(result.redirect?.location, 'https://other.example.test/x');
    }
    assert.equal(server.requests.length, 5, 'one request each, never a second for the target');
  });

  it('reports a 3xx that carries no target at all', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(304, { 'content-type': 'text/html' });
      response.end();
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.status, 304);
    assert.deepEqual(result.redirect, { status: 304, location: null });
  });
});

describe('a challenge', () => {
  it('is returned once and never answered', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="api"', 'content-type': 'application/json' });
      response.end('{"error":"unauthorized"}');
    });
    t.after(() => server.close());

    const result = await get(server.origin, { path: '/private' });
    assert.equal(result.status, 401);
    assert.equal(result.stoppedBy, 'auth-required');
    assert.equal(result.body, '', 'the challenge body is not read either');
    assert.equal(server.requests.length, 1, 'exactly one request; no retry with a credential');
  });

  it('treats a proxy challenge the same way', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(407, { 'proxy-authenticate': 'Basic', 'content-type': 'text/plain' });
      response.end('proxy');
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.status, 407);
    assert.equal(result.stoppedBy, 'auth-required');
    assert.equal(server.requests.length, 1);
  });
});

describe('a connection that fails', () => {
  it('comes back as a result with a code, never as a throw', async () => {
    const result = await sendRequest({
      method: 'GET',
      // Port 9 is the discard port: nothing listens there in the test sandbox.
      url: 'http://127.0.0.1:9/x',
      pinned: PIN,
      limits: limits({ connectTimeoutMs: 2000 }),
      connectMode: CONNECT_MODES.literalAddress,
    });
    assert.equal(result.ok, false);
    assert.ok([TRANSPORT_CODES.connectFailed, TRANSPORT_CODES.connectTimeout].includes(String(result.code)), String(result.code));
    assert.equal(result.status, null);
  });

  it('keeps the part of a body that arrived before the connection broke', async () => {
    const stub = createRequestStub();
    const pending = sendRequest(
      { method: 'GET', url: 'http://docs.example.test/Manual/index.html', pinned: PIN, limits: limits(), connectMode: CONNECT_MODES.literalAddress },
      { httpRequest: /** @type {any} */ (stub.request) },
    );
    const socket = createSocketStub();
    stub.calls[0].request.emit('socket', socket);
    socket.connect();
    const incoming = createResponseStub({ status: 200, headers: { 'content-type': 'text/plain' } });
    stub.calls[0].request.emit('response', incoming);
    incoming.emit('data', new TextEncoder().encode('half a page'));
    stub.calls[0].request.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.stoppedBy, 'connection-lost');
    assert.equal(result.body, 'half a page');
    assert.equal(result.status, 200);
  });

  it('answers with a result when the runtime refuses to start the request', async () => {
    const result = await sendRequest(
      { method: 'GET', url: 'http://docs.example.test/Manual/index.html', pinned: PIN, limits: limits(), connectMode: CONNECT_MODES.literalAddress },
      {
        httpRequest: /** @type {any} */ (
          () => {
            throw Object.assign(new Error('no sockets left'), { code: 'EMFILE' });
          }
        ),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.connectFailed);
    assert.match(String(result.detail), /could not be started/);
  });

  it('falls back to UTF-8 when the server names a character set the runtime does not have', async (t) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=x-made-up-42' });
      response.end('readable anyway');
    });
    t.after(() => server.close());

    const result = await get(server.origin);
    assert.equal(result.body, 'readable anyway');
  });

  it('answers with a result even when the request could not be built at all', async () => {
    const result = await sendRequest(
      /** @type {any} */ ({
        method: 'GET',
        url: 'this is not a url',
        pinned: PIN,
        limits: limits(),
        connectMode: CONNECT_MODES.literalAddress,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.connectFailed);
    assert.equal(result.body, '');
    assert.equal(result.status, null);
  });
});
