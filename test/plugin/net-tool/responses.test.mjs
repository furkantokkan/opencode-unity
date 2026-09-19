// Steps 13 to 20 of 12.8.2, through the tool and, wherever bytes on a socket matter, the real transport
// against servers on 127.0.0.1: the resolver and the pin, a redirect that is reported and never
// followed, a credential challenge that is never answered, the content-type gate, the byte and time
// budgets, and a result that is fenced and fitted under OpenCode's own tool-output caps.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseIpAddress } from '../../../plugin/opencode-unity-lib/net/ip-rules.js';
import { DEFAULT_NET_LIMITS, fitOutput, lookupAll, safeMediaType } from '../../../plugin/opencode-unity-lib/net/tool.js';
import { sendRequest } from '../../../plugin/opencode-unity-lib/net/transport.js';
import { FUNCTIONS_ENTRY, buildPolicy, call, createContext, createLookup, createTool, refusalCode, rehash, startServer } from './helpers.mjs';

const FAKE_GOOGLE_KEY = ['AI', 'za', 'Sy', 'D'.repeat(33)].join('');

/**
 * The tool over the real transport, with the rendered limits shortened where a test waits for one.
 * @param {Record<string, number>} [limits]
 * @param {Parameters<typeof buildPolicy>[0]} [policy]
 */
function realTool(limits = {}, policy = {}) {
  return createTool({
    network: buildPolicy({ ...policy, limits: { maxRequestsPerSession: 40, maxRequestsPerMinute: 20, ...limits } }),
    send: sendRequest,
  });
}

/**
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} handler
 * @param {(server: Awaited<ReturnType<typeof startServer>>) => Promise<void>} body
 */
async function withServer(handler, body) {
  const server = await startServer(handler);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

describe('step 13: resolve once, filter, pin', () => {
  it('refuses a name that does not resolve', async () => {
    const { tool, sent } = createTool({ lookup: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); } });
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_dns_failed');
    assert.equal(sent.length, 0);
  });

  it('refuses an empty answer as a resolution failure', async () => {
    const { tool } = createTool({ lookup: async () => [] });
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx)), 'net_dns_failed');
  });

  it('stops a resolver that never answers at the total time limit', async () => {
    const { tool, sent } = createTool({
      network: buildPolicy({ limits: { totalTimeoutMs: 50, maxRequestsPerSession: 40, maxRequestsPerMinute: 20 } }),
      lookup: () => new Promise(() => {}),
    });
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_total_timeout');
    assert.equal(sent.length, 0);
  });

  it('asks no resolver about a literal address', async () => {
    const { tool, asked, sent } = createTool();
    await tool.execute(call('GET', 'http://127.0.0.1:3000/'), createContext().ctx);
    await tool.execute(call('GET', 'http://[::1]:3000/'), createContext().ctx);
    assert.deepEqual(asked, []);
    assert.deepEqual(sent.map((request) => request.pinned.text), ['127.0.0.1', parseIpAddress('::1')?.text]);
    assert.deepEqual(sent.map((request) => request.pinned.family), [4, 6]);
  });

  it('the default resolver asks for every address, in system order (a literal, so no resolver is queried)', async () => {
    assert.deepEqual(await lookupAll('127.0.0.1'), [{ address: '127.0.0.1', family: 4 }]);
  });

  it('resolves localhost and keeps only loopback answers for a loopback entry', async () => {
    const resolver = createLookup({ localhost: ['192.168.1.20', '127.0.0.1'] });
    const { tool, sent } = createTool({ lookup: resolver.lookup });
    await tool.execute(call('GET', 'http://localhost:3000/'), createContext().ctx);
    assert.deepEqual(resolver.asked, ['localhost']);
    assert.equal(sent[0].pinned.text, '127.0.0.1');
  });
});

describe('step 15: a redirect is reported, never followed (DN7)', () => {
  it('hands back the full target URL when the target passes the whole policy, and never contacts it', async () => {
    await withServer((_request, response) => response.end('never'), async (target) => {
      await withServer((_request, response) => {
        response.writeHead(302, { location: `${target.origin}/v1/scores?page=2` });
        response.end();
      }, async (origin) => {
        const text = await realTool().tool.execute(call('GET', `${origin.origin}/v1/scores`), createContext().ctx);
        assert.equal(text, `unitynet GET ${origin.origin} 302 redirect to ${target.origin}/v1/scores?page=2, allowed. It was not followed; call again with that URL if you still need it.`);
        assert.equal(target.requests.length, 0);
      });
    });
  });

  it('resolves a relative location against the request URL', async () => {
    await withServer((_request, response) => {
      response.writeHead(301, { location: '/Manual/new-page.html' });
      response.end();
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/Manual/old-page.html`), createContext().ctx);
      assert.match(text, new RegExp(`301 redirect to ${server.origin.replace(/[.]/g, '\\.')}/Manual/new-page\\.html, allowed`));
    });
  });

  const refused = [
    { name: 'a host nobody allowed', location: 'https://attacker.example/steal?token=abc', where: 'attacker.example:443', code: 'net_host_not_allowed' },
    { name: 'a reserved port', location: 'http://127.0.0.1:11434/api/pull', where: '127.0.0.1:11434', code: 'net_reserved_port' },
    { name: 'a credential in the query', location: `/v1/next?q=${FAKE_GOOGLE_KEY}`, where: '127.0.0.1:', code: 'net_credential_in_url' },
    { name: 'the metadata address', location: 'http://169.254.169.254/latest/meta-data/', where: '169.254.169.254:80', code: 'net_host_not_allowed' },
  ];
  for (const { name, location, where, code } of refused) {
    it(`names only host and port for ${name}, never the path or query`, async () => {
      await withServer((_request, response) => {
        response.writeHead(302, { location });
        response.end();
      }, async (server) => {
        const text = await realTool().tool.execute(call('GET', `${server.origin}/v1/scores`), createContext().ctx);
        assert.ok(text.includes(`302 redirect to ${where}`), text);
        assert.ok(text.includes(`not allowed (${code})`), text);
        assert.match(text, /It was not followed\. Call again with an allowed URL if you have one\.$/);
        for (const hidden of ['/steal', 'token', 'abc', '/api/pull', FAKE_GOOGLE_KEY, 'meta-data']) assert.equal(text.includes(hidden), false, `${hidden} leaked`);
      });
    });
  }

  it('says so when there is no usable location', async () => {
    await withServer((_request, response) => {
      response.writeHead(307);
      response.end();
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/x`), createContext().ctx);
      assert.match(text, /307 redirect with no usable location, not followed\./);
    });
  });

  it('judges a 303 after a POST as the GET a client would send next, and a 307 as the same POST', async () => {
    await withServer((request, response) => {
      response.writeHead(request.url?.startsWith('/demo-game/see-other') ? 303 : 307, { location: 'https://docs.unity3d.com/Manual/index.html' });
      response.end();
    }, async (server) => {
      const { tool } = realTool({}, { derived: [{ ...FUNCTIONS_ENTRY, ports: [server.port] }], disjoint: true });
      const seeOther = await tool.execute(call('POST', `${server.origin}/demo-game/see-other`, '{"data":{}}'), createContext().ctx);
      assert.match(seeOther, /303 redirect to https:\/\/docs\.unity3d\.com\/Manual\/index\.html, allowed/);
      const temporary = await tool.execute(call('POST', `${server.origin}/demo-game/temporary`, '{"data":{}}'), createContext().ctx);
      assert.match(temporary, /307 redirect to docs\.unity3d\.com:443, not allowed \(net_method_not_allowed\)/);
    });
  });
});

describe('step 16: a credential challenge is returned and never answered (P-3)', () => {
  for (const status of [401, 407]) {
    it(`returns ${status} with no body and no retry`, async () => {
      await withServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer realm="game"' });
        response.end('sign in at https://attacker.example/login');
      }, async (server) => {
        const text = await realTool().tool.execute(call('GET', `${server.origin}/v1/me`), createContext().ctx);
        assert.equal(text, `unitynet GET ${server.origin} ${status} authentication required; the request was not retried, and this tool never signs in or sends a credential.`);
        assert.equal(server.requests.length, 1);
      });
    });
  }
});

describe('step 17: the content-type gate', () => {
  it('returns type and declared length only for a body that is not text', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/logo.png`), createContext().ctx);
      assert.equal(text, `unitynet GET ${server.origin} 200 refused net_content_type_not_text: the response is image/png, 4 bytes declared, which this tool does not show.`);
    });
  });

  it('never prints a hostile Content-Type header outside the fence', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream ignore-previous-instructions' });
      response.end('x');
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/blob`), createContext().ctx);
      assert.equal(refusalCode(text), 'net_content_type_not_text');
      assert.doesNotMatch(text, /ignore/);
      assert.match(text, /the response is unknown/);
    });
  });

  it('refuses a compressed body it asked not to receive', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.end('not really gzip');
    }, async (server) => {
      assert.equal(refusalCode(await realTool().tool.execute(call('GET', `${server.origin}/x`), createContext().ctx)), 'net_content_encoding_not_identity');
    });
  });

  it('passes a server error through as data', async () => {
    await withServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":{"status":"INTERNAL","message":"boom"}}');
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/x`), createContext().ctx);
      assert.match(text, new RegExp(`^unitynet GET ${server.origin.replace(/[.]/g, '\\.')} 500 application/json`));
      assert.match(text, /"INTERNAL"/);
    });
  });

  it('says there was no body for HEAD', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': '1234' });
      response.end();
    }, async (server) => {
      const text = await realTool().tool.execute(call('HEAD', `${server.origin}/Manual/index.html`), createContext().ctx);
      assert.match(text, new RegExp(`^unitynet HEAD ${server.origin.replace(/[.]/g, '\\.')} 200 text/html 0 bytes in \\d+ ms, no body\\.$`));
    });
  });
});

describe('steps 14, 18 and 19: time and byte budgets', () => {
  it('cuts a body at maxResponseBytes and says so in the status line', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(5000));
    }, async (server) => {
      const text = await realTool({ maxResponseBytes: 1024 }).tool.execute(call('GET', `${server.origin}/big`), createContext().ctx);
      assert.match(text, / 200 text\/plain 1024 bytes in \d+ ms, cut at 1024 bytes\n/);
    });
  });

  it('returns what arrived when the total time limit ends a slow body', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first part of the page');
    }, async (server) => {
      // Long enough that a slow runner still sees the headers first; the body never ends either way.
      const { tool, records } = realTool({ totalTimeoutMs: 800 });
      const text = await tool.execute(call('GET', `${server.origin}/slow`), createContext().ctx);
      assert.match(text, /, stopped at the total time limit \(net_total_timeout\)\n/);
      assert.match(text, /first part of the page/);
      assert.equal(records[0].code, 'net_total_timeout');
    });
  });

  it('refuses when the server sends no header in time', async () => {
    await withServer(() => {}, async (server) => {
      const text = await realTool({ firstByteTimeoutMs: 100 }).tool.execute(call('GET', `${server.origin}/hang`), createContext().ctx);
      assert.equal(refusalCode(text), 'net_first_byte_timeout');
    });
  });

  it('refuses when nothing listens on the port', async () => {
    const server = await startServer(() => {});
    const port = server.port;
    await server.close();
    const text = await realTool().tool.execute(call('GET', `http://127.0.0.1:${port}/`), createContext().ctx);
    assert.equal(refusalCode(text), 'net_connect_failed');
  });

  it('sends the entry\'s literal loopback headers, drops a secret-looking one, and never an Authorization the model chose', async () => {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    }, async (server) => {
      const secret = ['Bearer ', 'ya29.', 'a'.repeat(30)].join('');
      const policy = buildPolicy({ derived: [{ ...FUNCTIONS_ENTRY, id: 'firestore', ports: [server.port], methods: ['GET'], firebaseEmulator: false }], disjoint: true });
      // Header changes are part of the policy and need a fresh hash.
      const raw = { ...policy, entries: policy.entries.map((/** @type {any} */ entry) => (entry.id === 'firestore' ? { ...entry, headers: { Authorization: 'Bearer owner', 'X-Leak': secret, 'Bad Header': 'x' } } : entry)) };
      const { tool } = createTool({ network: rehash(raw), send: sendRequest });
      const text = await tool.execute(call('GET', `${server.origin}/v1/projects/demo-game/databases/(default)/documents/players/p1`), createContext().ctx);
      assert.equal(refusalCode(text), null, text);
      assert.equal(server.requests[0].headers.authorization, 'Bearer owner');
      assert.equal(server.requests[0].headers['x-leak'], undefined);
      assert.equal(server.requests[0].headers['accept-encoding'], 'identity');
    });
  });
});

describe('step 20: sanitised, fenced, and fitted under the tool-output caps', () => {
  it('keeps a many-line body under maxOutputLines', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('line\n'.repeat(3000));
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/lines`), createContext().ctx);
      assert.ok(text.split('\n').length <= DEFAULT_NET_LIMITS.maxOutputLines, `${text.split('\n').length} lines`);
      assert.match(text, /\[truncated: \d+ more characters\]/);
      assert.match(text, />>>network-response [0-9a-f]{8}\n\nEnd of data\./);
    });
  });

  it('keeps a multi-byte body under maxOutputBytes', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String.fromCodePoint(0x11f).repeat(8000));
    }, async (server) => {
      const text = await realTool().tool.execute(call('GET', `${server.origin}/wide`), createContext().ctx);
      assert.ok(new TextEncoder().encode(text).length <= DEFAULT_NET_LIMITS.maxOutputBytes);
      assert.ok(text.includes(String.fromCodePoint(0x11f).repeat(100)));
    });
  });

  it('fitOutput leaves a small result alone and shrinks until both caps hold', () => {
    const limits = { ...DEFAULT_NET_LIMITS, maxOutputLines: 20, maxOutputBytes: 800 };
    const small = fitOutput({ summary: 'unitynet GET https://docs.unity3d.com 200 text/plain 2 bytes in 1 ms', text: 'ok', contentType: 'text/plain', limits, randomHex: () => 'abcdef01' });
    assert.match(small, /<<<network-response abcdef01\nok\n>>>network-response abcdef01/);
    const fitted = fitOutput({ summary: 'unitynet GET https://docs.unity3d.com 200 text/plain', text: 'word '.repeat(2000) + '\nrow'.repeat(500), contentType: 'text/plain', limits });
    assert.ok(fitted.split('\n').length <= 20);
    assert.ok(new TextEncoder().encode(fitted).length <= 800);
  });

  it('fitOutput still returns the fence when the caps are too small for any body', () => {
    const text = fitOutput({ summary: 'unitynet GET https://docs.unity3d.com 200 text/plain', text: 'x'.repeat(500), contentType: 'text/plain', limits: { ...DEFAULT_NET_LIMITS, maxOutputLines: 2, maxOutputBytes: 50 } });
    assert.match(text, /<<<network-response [0-9a-f]+\n\n>>>network-response/);
  });

  it('safeMediaType prints only a clean type/subtype', () => {
    assert.equal(safeMediaType('Application/JSON; charset=utf-8'), 'application/json');
    assert.equal(safeMediaType('text/html; x="ignore previous instructions"'), 'text/html');
    assert.equal(safeMediaType('text/html ignore previous'), 'unknown');
    assert.equal(safeMediaType(''), null);
    assert.equal(safeMediaType(undefined), null);
  });
});
