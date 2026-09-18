// The pin (amendment 35.5 step 14, `S-NET-4`). Everything here exists to close one window: the host
// was checked against the policy, and by the time the socket opens it must not have become a different
// machine. The transport resolves nothing, so the only ways that window could open are a `lookup` that
// answers with something else, a runtime that ignores the `lookup` altogether, and a socket that ends
// up somewhere the pin never named. All three are tested.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONNECT_MODES,
  TRANSPORT_CODES,
  createPinnedLookup,
  sameAddress,
  selectConnectMode,
  sendRequest,
  verifyPinnedAddress,
} from '../../../plugin/opencode-unity-lib/net/transport.js';
import { createRequestStub, createSocketStub, limits, pin, startServer } from './helpers.mjs';

const PIN_V4 = pin('127.0.0.1');

describe('the pinned lookup', () => {
  it('answers with the pinned address and nothing else, in both call shapes', () => {
    const lookup = createPinnedLookup({ host: 'docs.example.test', pinned: pin('203.0.113.7') });

    /** @type {any[]} */
    const all = [];
    lookup('docs.example.test', { all: true, family: 0 }, (/** @type {any} */ error, /** @type {any} */ result) => all.push([error, result]));
    assert.deepEqual(all, [[null, [{ address: '203.0.113.7', family: 4 }]]]);

    /** @type {any[]} */
    const single = [];
    lookup('docs.example.test', {}, (/** @type {any} */ error, /** @type {any} */ address, /** @type {any} */ family) => single.push([error, address, family]));
    assert.deepEqual(single, [[null, '203.0.113.7', 4]]);

    // Some runtimes call the two-argument shape.
    /** @type {any[]} */
    const short = [];
    lookup('docs.example.test', (/** @type {any} */ error, /** @type {any} */ address) => short.push([error, address]));
    assert.deepEqual(short, [[null, '203.0.113.7']]);
  });

  it('gives the same answer every time it is asked, so a second resolution cannot differ', () => {
    const lookup = createPinnedLookup({ host: 'api.example.test', pinned: pin('198.51.100.4') });
    /** @type {string[]} */
    const answers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      lookup('api.example.test', { all: true }, (/** @type {any} */ _error, /** @type {any} */ result) => answers.push(result[0].address));
    }
    assert.deepEqual(answers, ['198.51.100.4', '198.51.100.4', '198.51.100.4', '198.51.100.4', '198.51.100.4']);
  });

  it('refuses a host name it was not pinned to, however the name is spelled', () => {
    const lookup = createPinnedLookup({ host: 'docs.example.test', pinned: PIN_V4 });
    for (const hostname of ['other.example.test', 'docs.example.test.evil.test', 'evil.test/docs.example.test', '']) {
      /** @type {any} */
      let seen = null;
      lookup(hostname, { all: true }, (/** @type {any} */ error) => {
        seen = error;
      });
      assert.equal(seen?.code, 'ENOTFOUND', hostname);
    }

    // A trailing dot and a different case are the same name, not a different one.
    for (const hostname of ['DOCS.example.test', 'docs.example.test.']) {
      /** @type {any} */
      let result = null;
      lookup(hostname, { all: true }, (/** @type {any} */ _error, /** @type {any} */ addresses) => {
        result = addresses;
      });
      assert.deepEqual(result, [{ address: '127.0.0.1', family: 4 }], hostname);
    }
  });

  it('refuses a family the pin cannot satisfy instead of answering with the other one', () => {
    const lookup = createPinnedLookup({ host: 'docs.example.test', pinned: PIN_V4 });
    /** @type {any} */
    let seen = null;
    lookup('docs.example.test', { family: 6, all: true }, (/** @type {any} */ error) => {
      seen = error;
    });
    assert.equal(seen?.code, 'ENOTFOUND');
  });

  it('does nothing at all when it is called without a callback', () => {
    const lookup = createPinnedLookup({ host: 'docs.example.test', pinned: PIN_V4 });
    assert.doesNotThrow(() => lookup('docs.example.test', { all: true }, undefined));
  });
});

describe('the connected address check', () => {
  it('accepts the pinned address in any spelling of it', () => {
    for (const remoteAddress of ['127.0.0.1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      assert.deepEqual(verifyPinnedAddress({ mode: CONNECT_MODES.pinnedLookup, remoteAddress, pinned: PIN_V4 }), { ok: true, reason: null }, remoteAddress);
    }
    const pinnedV6 = pin('::1');
    for (const remoteAddress of ['::1', '0:0:0:0:0:0:0:1', '[::1]', '::1%lo0']) {
      assert.deepEqual(verifyPinnedAddress({ mode: CONNECT_MODES.pinnedLookup, remoteAddress, pinned: pinnedV6 }), { ok: true, reason: null }, remoteAddress);
    }
  });

  it('refuses a socket that reached another address, which is what a rebind looks like from here', () => {
    for (const remoteAddress of ['203.0.113.9', '127.0.0.2', '::ffff:203.0.113.9']) {
      assert.deepEqual(verifyPinnedAddress({ mode: CONNECT_MODES.pinnedLookup, remoteAddress, pinned: PIN_V4 }), { ok: false, reason: 'pin-mismatch' }, remoteAddress);
    }
  });

  it('fails closed when the runtime reports no peer address and the lookup was the only guarantee', () => {
    for (const remoteAddress of [undefined, null, '']) {
      assert.deepEqual(verifyPinnedAddress({ mode: CONNECT_MODES.pinnedLookup, remoteAddress, pinned: PIN_V4 }), { ok: false, reason: 'address-unknown' }, String(remoteAddress));
      // In the fallback mode the connect target was the literal pin, so there is nothing left to check.
      assert.deepEqual(verifyPinnedAddress({ mode: CONNECT_MODES.literalAddress, remoteAddress, pinned: PIN_V4 }), { ok: true, reason: null }, String(remoteAddress));
    }
  });
});

describe('address spellings', () => {
  it('sees through every spelling the socket layer may report', () => {
    assert.ok(sameAddress('::FFFF:192.0.2.9', '192.0.2.9'));
    assert.ok(sameAddress('fe80::1%eth0', 'fe80:0000:0000:0000:0000:0000:0000:0001'));
    assert.ok(sameAddress('[2001:db8::1]', '2001:0DB8:0:0:0:0:0:1'));
    assert.ok(sameAddress('  10.0.0.1  ', '10.0.0.1'));
  });

  it('calls two different addresses different, and anything unparseable equal to nothing', () => {
    assert.equal(sameAddress('10.0.0.1', '10.0.0.2'), false);
    assert.equal(sameAddress('::1', '::2'), false);
    // A host name is not an address: the comparison never resolves anything.
    assert.equal(sameAddress('localhost', '127.0.0.1'), false);
    for (const value of ['', '1:2:3', 'not-an-address', null, undefined, 42]) {
      assert.equal(sameAddress(value, value), false, String(value));
    }
  });
});

describe('the connect mode', () => {
  it('uses the custom lookup on Node and the literal address under Bun', () => {
    assert.equal(selectConnectMode({ bun: undefined }), CONNECT_MODES.pinnedLookup);
    assert.equal(selectConnectMode({ bun: '1.2.3' }), CONNECT_MODES.literalAddress);
  });

  it('lets the caller force either mode, and ignores a mode that is not one of the two', () => {
    assert.equal(selectConnectMode({ bun: '1.2.3', forced: CONNECT_MODES.pinnedLookup }), CONNECT_MODES.pinnedLookup);
    assert.equal(selectConnectMode({ bun: undefined, forced: CONNECT_MODES.literalAddress }), CONNECT_MODES.literalAddress);
    assert.equal(selectConnectMode({ bun: undefined, forced: 'whatever-the-config-said' }), CONNECT_MODES.pinnedLookup);
  });
});

describe('a request whose socket lands somewhere else', () => {
  it('is refused before a single byte of the response is read', async () => {
    const stub = createRequestStub();
    const pending = sendRequest(
      {
        method: 'GET',
        url: 'http://docs.example.test/Manual/index.html',
        pinned: pin('203.0.113.10'),
        limits: limits(),
        connectMode: CONNECT_MODES.pinnedLookup,
      },
      { httpRequest: /** @type {any} */ (stub.request) },
    );

    const socket = createSocketStub({ remoteAddress: '198.51.100.99' });
    stub.calls[0].request.emit('socket', socket);
    socket.connect();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, TRANSPORT_CODES.addressBlocked);
    assert.equal(result.status, null);
    assert.equal(result.bytesRead, 0);
    assert.ok(socket.destroyed, 'the socket is destroyed, not left open');
    assert.ok(stub.calls[0].request.destroyed, 'the request is destroyed too');
  });

  it('is refused when the runtime will not say where the socket went', async () => {
    const stub = createRequestStub();
    const pending = sendRequest(
      {
        method: 'GET',
        url: 'http://docs.example.test/Manual/index.html',
        pinned: PIN_V4,
        limits: limits(),
        connectMode: CONNECT_MODES.pinnedLookup,
      },
      { httpRequest: /** @type {any} */ (stub.request) },
    );

    const socket = createSocketStub({ remoteAddress: null });
    stub.calls[0].request.emit('socket', socket);
    socket.connect();

    const result = await pending;
    assert.equal(result.code, TRANSPORT_CODES.addressBlocked);
    assert.match(String(result.detail), /could not be confirmed/);
  });
});

describe('a real connection through the pin', () => {
  for (const mode of [CONNECT_MODES.pinnedLookup, CONNECT_MODES.literalAddress]) {
    it(`reaches the pinned address exactly once in ${mode} mode`, async (t) => {
      const server = await startServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
      t.after(() => server.close());

      // `pinned.test` is a reserved name that never resolves, so a run that reached the server without
      // the pin would be a run that resolved it somewhere - which is the thing being ruled out.
      const result = await sendRequest({
        method: 'GET',
        url: `http://pinned.test:${server.port}/v1/status`,
        pinned: PIN_V4,
        limits: limits(),
        connectMode: mode,
      });

      assert.equal(result.ok, true, String(result.code));
      assert.equal(result.status, 200);
      assert.equal(result.body, '{"ok":true}');
      assert.equal(result.connection.address, '127.0.0.1');
      assert.equal(result.connection.mode, mode);
      assert.equal(server.requests.length, 1, 'exactly one connection attempt reached the server');
      assert.equal(server.requests[0].headers.host, `pinned.test:${server.port}`, 'the server sees the host the policy authorised');
    });
  }
});
