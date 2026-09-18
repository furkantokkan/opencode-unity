// What the transport asks the runtime for, before anything is sent. The connection options are built
// by a pure function so the two modes, the certificate rules of `S-NET-17` and the headers the entry
// may not own can all be asserted without a socket.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import tls from 'node:tls';

import {
  CONNECT_MODES,
  TRANSPORT_CODES,
  buildConnection,
  classifyRequestError,
  createIdentityCheck,
  isAllowedContentType,
  parseContentType,
  readRedirect,
} from '../../../plugin/opencode-unity-lib/net/transport.js';
import { pin } from './helpers.mjs';

const PIN = pin('203.0.113.7');

/**
 * @param {Partial<import('../../../plugin/opencode-unity-lib/net/transport.js').TransportRequest> & { connectMode: string }} overrides
 */
function plan(overrides) {
  return buildConnection(
    /** @type {any} */ ({
      method: 'GET',
      url: 'https://docs.example.test/Manual/index.html?q=a',
      pinned: PIN,
      limits: { maxResponseBytes: 65536, connectTimeoutMs: 5000, firstByteTimeoutMs: 10000, totalTimeoutMs: 20000 },
      ...overrides,
    }),
  );
}

describe('the connection plan', () => {
  it('sends the name to the runtime in lookup mode and the address itself in fallback mode', () => {
    const lookupMode = plan({ connectMode: CONNECT_MODES.pinnedLookup });
    assert.equal(lookupMode.options.host, 'docs.example.test');
    assert.equal(typeof lookupMode.options.lookup, 'function');

    const literalMode = plan({ connectMode: CONNECT_MODES.literalAddress });
    assert.equal(literalMode.options.host, '203.0.113.7');
    assert.equal(literalMode.options.lookup, undefined, 'the fallback needs no lookup to be honoured');
  });

  it('pins the address family and refuses the runtime a second attempt on another one', () => {
    for (const connectMode of [CONNECT_MODES.pinnedLookup, CONNECT_MODES.literalAddress]) {
      const built = plan({ connectMode });
      assert.equal(built.options.family, 4, connectMode);
      assert.equal(built.options.autoSelectFamily, false, connectMode);
      assert.equal(built.agentOptions.keepAlive, false, connectMode);
      assert.equal(built.agentOptions.maxSockets, 1, connectMode);
    }
  });

  it('carries the authorised host name in the Host header whichever mode connects', () => {
    for (const connectMode of [CONNECT_MODES.pinnedLookup, CONNECT_MODES.literalAddress]) {
      assert.equal(plan({ connectMode }).options.headers.host, 'docs.example.test', connectMode);
      assert.equal(plan({ connectMode }).options.setHost, false, connectMode);
    }
    // A non-default port belongs in the header; a default one does not.
    assert.equal(plan({ connectMode: CONNECT_MODES.literalAddress, url: 'http://127.0.0.1:5001/demo-app/us-central1/fn' }).options.headers.host, '127.0.0.1:5001');
    assert.equal(plan({ connectMode: CONNECT_MODES.literalAddress, url: 'http://127.0.0.1/x' }).options.headers.host, '127.0.0.1');
  });

  it('keeps the port and path the URL carried, and asks for no encoding it would have to decode', () => {
    const built = plan({ connectMode: CONNECT_MODES.pinnedLookup });
    assert.equal(built.port, 443);
    assert.equal(built.path, '/Manual/index.html?q=a');
    assert.equal(built.options.headers['accept-encoding'], 'identity');
    assert.equal(built.options.headers.connection, 'close');
    assert.equal(built.module, 'https');
    assert.equal(plan({ connectMode: CONNECT_MODES.pinnedLookup, url: 'http://127.0.0.1:8080/x' }).module, 'http');
    assert.equal(plan({ connectMode: CONNECT_MODES.pinnedLookup, url: 'http://127.0.0.1:8080/x' }).port, 8080);
  });

  it('validates the certificate against the host name, never against the address it is pinned to', () => {
    const built = plan({ connectMode: CONNECT_MODES.literalAddress });
    assert.equal(built.options.servername, 'docs.example.test');
    assert.equal(built.options.rejectUnauthorized, true);
    assert.equal(typeof built.options.checkServerIdentity, 'function');

    // The identity check ignores the name the socket was opened with and uses the authorised one.
    const check = /** @type {(hostname: string, cert: any) => Error | undefined} */ (built.options.checkServerIdentity);
    const certificate = { subject: { CN: 'docs.example.test' }, subjectaltname: 'DNS:docs.example.test' };
    assert.equal(check('203.0.113.7', certificate), undefined, 'a certificate for the host is accepted although the socket went to an address');
    const wrong = check('docs.example.test', { subject: { CN: 'other.example.test' }, subjectaltname: 'DNS:other.example.test' });
    assert.ok(wrong instanceof Error, 'a certificate for another host is refused');
  });

  it('never offers a way to turn certificate validation off', () => {
    const built = plan({ connectMode: CONNECT_MODES.literalAddress, headers: { rejectUnauthorized: 'false', insecure: 'true' } });
    assert.equal(built.options.rejectUnauthorized, true);
    // A key an entry smuggled in arrives as a header, where it is inert, and never as an option.
    assert.equal(built.options.insecure, undefined);
    assert.equal(built.options.strictSSL, undefined);
  });

  it('passes a loopback trust anchor through and adds none on a plain connection', () => {
    const secure = plan({ connectMode: CONNECT_MODES.literalAddress, url: 'https://localhost:7051/health', ca: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n' });
    assert.match(String(secure.options.ca), /BEGIN CERTIFICATE/);
    const plain = plan({ connectMode: CONNECT_MODES.literalAddress, url: 'http://localhost:7051/health', ca: 'ignored' });
    assert.equal(plain.options.ca, undefined);
    assert.equal(plain.options.servername, undefined);
    assert.equal(plain.options.checkServerIdentity, undefined);
  });

  it('lets an entry add headers but never the four the transport owns', () => {
    const built = plan({
      connectMode: CONNECT_MODES.literalAddress,
      headers: { 'X-Emulator-Key': 'local', HOST: 'evil.test', 'Accept-Encoding': 'gzip', Connection: 'keep-alive', 'Content-Length': '99' },
    });
    assert.equal(built.options.headers['x-emulator-key'], 'local');
    assert.equal(built.options.headers.host, 'docs.example.test');
    assert.equal(built.options.headers['accept-encoding'], 'identity');
    assert.equal(built.options.headers.connection, 'close');
    assert.equal(built.options.headers['content-length'], undefined, 'a request with no body declares no length');
  });

  it('measures the body it is about to send rather than believing a declared length', () => {
    const text = plan({ connectMode: CONNECT_MODES.literalAddress, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body: '{"data":{"score":1}}' });
    assert.equal(text.options.headers['content-length'], '20');
    assert.equal(text.options.headers['content-type'], 'application/json');

    const bytes = plan({ connectMode: CONNECT_MODES.literalAddress, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body: new TextEncoder().encode('abcde') });
    assert.equal(bytes.options.headers['content-length'], '5');

    const declared = plan({ connectMode: CONNECT_MODES.literalAddress, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body: 'ab', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(declared.options.headers['content-length'], '2');
    assert.equal(declared.options.headers['content-type'], 'text/plain', 'an entry that names a type keeps it');
  });

  it('treats a multi-byte body as bytes, because a header that counts characters would be wrong', () => {
    const body = '{"q":"éü"}';
    assert.equal(body.length, 10, 'ten characters');
    const built = plan({ connectMode: CONNECT_MODES.literalAddress, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body });
    assert.equal(built.options.headers['content-length'], '12', 'twelve bytes');
  });

  it('uses the host the policy matched when a suffix entry authorised a different spelling', () => {
    const built = plan({ connectMode: CONNECT_MODES.literalAddress, url: 'https://a.docs.example.test/x', host: 'a.docs.example.test' });
    assert.equal(built.options.servername, 'a.docs.example.test');
    assert.equal(built.options.headers.host, 'a.docs.example.test');
  });
});

describe('the identity check', () => {
  it('is absent rather than weakened when the runtime does not publish one', () => {
    const original = tls.checkServerIdentity;
    try {
      // @ts-expect-error - deliberately removing the function a partial runtime may not have.
      tls.checkServerIdentity = undefined;
      assert.equal(createIdentityCheck('docs.example.test'), undefined);
    } finally {
      tls.checkServerIdentity = original;
    }
  });
});

describe('the content-type gate', () => {
  it('admits the text shapes a documentation or API answer arrives in', () => {
    for (const value of ['text/html', 'text/plain; charset=utf-8', 'TEXT/MARKDOWN', 'application/json', 'application/json; charset=utf-8', 'application/vnd.api+json', 'application/xml', 'application/x-ndjson']) {
      assert.equal(isAllowedContentType(value), true, value);
    }
  });

  it('refuses everything else, including a missing type', () => {
    for (const value of ['application/octet-stream', 'image/png', 'application/pdf', 'application/zip', 'multipart/form-data', 'application/javascript', '', '   ', null, undefined]) {
      assert.equal(isAllowedContentType(value), false, String(value));
    }
  });

  it('reads the charset without letting it change the decision', () => {
    assert.deepEqual(parseContentType('text/html; charset="ISO-8859-1"'), { type: 'text/html', charset: 'iso-8859-1' });
    assert.deepEqual(parseContentType('application/json'), { type: 'application/json', charset: null });
    assert.deepEqual(parseContentType(null), { type: null, charset: null });
  });
});

describe('a redirect that is read but not followed', () => {
  it('reports the header exactly as it arrived, absolute or not', () => {
    // Resolving it and deciding whether the target is allowed belongs to the policy, so the transport
    // reports one thing and judges nothing: two resolvers with different rules is the failure to avoid.
    assert.deepEqual(readRedirect(302, 'https://other.example.test:8443/moved'), { status: 302, location: 'https://other.example.test:8443/moved' });
    assert.deepEqual(readRedirect(301, '/somewhere/else'), { status: 301, location: '/somewhere/else' });
    assert.deepEqual(readRedirect(307, '  https://other.example.test/x  '), { status: 307, location: 'https://other.example.test/x' });
  });

  it('reports no target when the server sent none it could use', () => {
    for (const location of [undefined, '', '   ']) {
      assert.deepEqual(readRedirect(304, location), { status: 304, location: null }, String(location));
    }
    assert.equal(readRedirect(302, ['https://a.example.test/x', 'https://b.example.test/x']).location, 'https://a.example.test/x');
  });
});

describe('failures with a name', () => {
  it('separates a certificate for the wrong host from one that cannot be trusted', () => {
    assert.equal(classifyRequestError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), TRANSPORT_CODES.tlsHostnameMismatch);
    for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER']) {
      assert.equal(classifyRequestError({ code }), TRANSPORT_CODES.tlsUntrusted, code);
    }
  });

  it('calls everything else a connection failure rather than guessing', () => {
    for (const error of [{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }, { code: 'ENOTFOUND' }, new Error('nothing useful'), null, undefined]) {
      assert.equal(classifyRequestError(error), TRANSPORT_CODES.connectFailed, String(error));
    }
  });
});
