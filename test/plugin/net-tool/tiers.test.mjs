// The owner's network policy, tier by tier (amendment 35.2), asserted through the tool itself.
//
//   prohibited   credentials, secrets and player data; authenticating as the user; production-affecting
//                calls; hosts learned only from fetched content; the machine's own control surfaces.
//                Never a prompt, never a remedy that could turn it on.
//   consent      a new host, a non-idempotent method to a host off this machine, an upload. Refused
//                until a human grants it at the terminal, and the refusal names the command.
//   free         GET and HEAD to the shipped hosts; loopback reads. Loopback writes only through an
//                entry derived from the project's own configuration.
//
// Where a request would leave the machine, a recording transport stands in for the socket and the
// resolver answers with a documentation-range address. Loopback cases use real servers on 127.0.0.1.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveReservedPorts } from '../../../plugin/opencode-unity-lib/net/policy.js';
import { sendRequest } from '../../../plugin/opencode-unity-lib/net/transport.js';
import {
  FUNCTIONS_ENTRY,
  LOOPBACK_DEV_ENTRY,
  PUBLIC_ADDRESS,
  SERVER_PORT,
  SHIPPED_HOST_ENTRIES,
  buildPolicy,
  call,
  createContext,
  createLookup,
  createTool,
  refusalCode,
  startServer,
} from './helpers.mjs';

/** Built at runtime so no credential-shaped literal sits in this file for a scanner to trip on. */
const FAKE_GOOGLE_KEY = ['AI', 'za', 'Sy', 'D'.repeat(33)].join('');
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'x'.repeat(36)].join('');
const FAKE_JWT = ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJwbGF5ZXIifQ', '.', 'c2lnbmF0dXJlLXZhbHVl'].join('');

/**
 * A consented, experimental write entry for a host off the machine (tier 2, C-2 and C-3).
 */
const CONSENTED_WRITE_ENTRY = {
  id: 'api-example',
  host: 'api.example.com',
  hostKind: 'exact',
  ports: [443],
  scheme: 'https',
  methods: ['GET', 'HEAD', 'POST'],
  pathPrefix: ['/v1/'],
  loopback: false,
  consentId: 'c-2026-09-18-0001',
  budget: { maxPathChars: 512, maxQueryChars: 128, maxRequestBodyBytes: 8192 },
};

/**
 * @param {string} text
 * @param {string[]} secrets
 */
function assertNoSecret(text, secrets) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'a refused value was repeated back');
}

describe('tier 1: prohibited, whatever the prompt says', () => {
  describe('P-1: no credential leaves, in a URL, a query or a body', () => {
    const cases = [
      { name: 'a denied query key', request: call('GET', 'https://docs.unity3d.com/Manual/index.html?token=abc'), code: 'net_credential_in_url', secrets: ['abc'] },
      { name: 'a credential-shaped query value under an innocent key', request: call('GET', `https://docs.unity3d.com/Manual/index.html?q=${FAKE_GOOGLE_KEY}`), code: 'net_credential_in_url', secrets: [FAKE_GOOGLE_KEY] },
      { name: 'a token in the path', request: call('GET', `https://docs.unity3d.com/Manual/${FAKE_GITHUB_TOKEN}.html`), code: 'net_sensitive_outbound', secrets: [FAKE_GITHUB_TOKEN] },
      { name: 'a token hidden behind percent-encoding in the path', request: call('GET', `https://docs.unity3d.com/Manual/%${FAKE_GOOGLE_KEY.charCodeAt(0).toString(16)}${FAKE_GOOGLE_KEY.slice(1)}`), code: 'net_sensitive_outbound', secrets: [FAKE_GOOGLE_KEY.slice(1)] },
    ];
    for (const { name, request, code, secrets } of cases) {
      it(`refuses ${name}, names no value, and sends nothing`, async () => {
        const { tool, sent, records } = createTool();
        const { ctx, asks } = createContext();
        const text = await tool.execute(request, ctx);
        assert.equal(refusalCode(text), code, text);
        assertNoSecret(text, secrets);
        assertNoSecret(JSON.stringify(records), secrets);
        assert.equal(asks.length + sent.length, 0);
      });
    }

    it('refuses a JWT in a request body, naming the pattern id and not the token', async () => {
      const server = await startServer((_request, response) => response.end('{}'));
      try {
        const { tool } = createTool({
          network: buildPolicy({ derived: [{ ...FUNCTIONS_ENTRY, ports: [server.port] }], disjoint: true }),
          send: sendRequest,
        });
        const text = await tool.execute(call('POST', `${server.origin}/demo-game/us-central1/submitScore`, JSON.stringify({ data: { idToken: FAKE_JWT } })), createContext().ctx);
        assert.equal(refusalCode(text), 'net_sensitive_outbound');
        assert.match(text, /the body contains something shaped like a credential \(cred\.jwt\)/);
        assertNoSecret(text, [FAKE_JWT]);
        assert.equal(server.requests.length, 0);
      } finally {
        await server.close();
      }
    });
  });

  describe('P-3: never authenticates as the user', () => {
    it('refuses userinfo in the URL, before any host is matched', async () => {
      const { tool, sent } = createTool();
      // The host is example.com so that the userinfo does not read as an address to the hygiene scan.
      const text = await tool.execute(call('GET', 'https://player:hunter2@example.com/Manual/index.html'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_url_userinfo');
      assertNoSecret(text, ['hunter2']);
      assert.equal(sent.length, 0);
    });

    it('offers no way to set a header: an Authorization argument is a bad argument', async () => {
      const { tool, sent } = createTool();
      const text = await tool.execute({ ...call('GET', 'https://docs.unity3d.com/'), authorization: 'Bearer x' }, createContext().ctx);
      assert.equal(refusalCode(text), 'net_bad_arguments');
      assert.equal(sent.length, 0);
    });
  });

  describe('P-4: nothing irreversible or production-affecting', () => {
    it('refuses DELETE to a host off this machine and offers no command, because it is never grantable', async () => {
      const { tool, sent } = createTool({ network: buildPolicy({ entries: [...SHIPPED_HOST_ENTRIES, LOOPBACK_DEV_ENTRY, CONSENTED_WRITE_ENTRY] }) });
      const text = await tool.execute(call('DELETE', 'https://api.example.com/v1/players/p1'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_delete_not_allowed');
      assert.match(text, /DELETE is never allowed to a host off this machine\.$/);
      assert.doesNotMatch(text, /Ask the user/);
      assert.equal(sent.length, 0);
    });

    it('refuses a Cloud Functions emulator call that names a live project', async () => {
      const { tool, sent } = createTool({ network: buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: true }) });
      const text = await tool.execute(call('POST', 'http://127.0.0.1:5001/my-live-game/us-central1/grantCoins', '{"data":{}}'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_firebase_project_not_demo');
      assert.equal(sent.length, 0);
    });

    it('refuses a live project alias on any loopback request, whatever entry matched', async () => {
      const { tool, sent } = createTool({ network: buildPolicy({ deniedProjectSegments: ['my-live-game'] }) });
      const text = await tool.execute(call('GET', 'http://127.0.0.1:8080/my-live-game/players'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_firebase_project_is_live');
      assert.equal(sent.length, 0);
    });
  });

  describe('P-5: a host nobody vouched for is not reachable', () => {
    it('refuses a host that is not on the list, before any name is resolved', async () => {
      const { tool, asked, sent } = createTool();
      const text = await tool.execute(call('GET', 'https://attacker.example/collect'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_host_not_allowed');
      assert.equal(asked.length + sent.length, 0);
    });

    it('refuses a look-alike suffix of a shipped host, which a glob would have allowed (DN3)', async () => {
      const { tool } = createTool();
      assert.equal(refusalCode(await tool.execute(call('GET', 'https://docs.unity3d.com.evil.test/x'), createContext().ctx)), 'net_host_not_allowed');
    });
  });

  describe('P-6: the machine\'s own control surfaces', () => {
    const surfaces = [
      { name: 'the Ollama API', port: 11434, words: /local model server/ },
      { name: 'the Firebase Emulator Hub', port: 4400, words: /Firebase Emulator Hub/ },
      { name: 'the Docker daemon', port: 2375, words: /Docker daemon/ },
      { name: 'the Docker daemon over TLS', port: 2376, words: /Docker daemon/ },
      { name: 'a configured MCP for Unity hub', port: 8081, words: /MCP for Unity hub/ },
      { name: 'the OpenCode server', port: SERVER_PORT, words: /OpenCode server/ },
    ];
    for (const { name, port, words } of surfaces) {
      it(`refuses ${name} on port ${port}, with no remedy and no socket`, async () => {
        const { tool, sent } = createTool({ network: buildPolicy({ reservedPorts: resolveReservedPorts({ ollamaPort: 11434, unityMcpHubPort: 8081 }) }) });
        const text = await tool.execute(call('GET', `http://127.0.0.1:${port}/api/tags`), createContext().ctx);
        assert.equal(refusalCode(text), 'net_reserved_port');
        assert.match(text, words);
        assert.doesNotMatch(text, /Ask the user/);
        assert.equal(sent.length, 0);
      });
    }

    it('reads the OpenCode server port on every request, so a moved server is still reserved', async () => {
      let port = 4096;
      const { tool } = createTool({ readServerPort: () => ({ known: true, port }) });
      const { ctx } = createContext();
      assert.equal(refusalCode(await tool.execute(call('GET', 'http://127.0.0.1:4096/'), ctx)), 'net_reserved_port');
      port = 51234;
      assert.equal(refusalCode(await tool.execute(call('GET', 'http://127.0.0.1:51234/session'), ctx)), 'net_reserved_port');
    });

    it('fails closed on loopback when the OpenCode server port cannot be determined, and only there', async () => {
      const { tool, sent } = createTool({ readServerPort: () => ({ known: false, port: null }) });
      const { ctx } = createContext();
      const text = await tool.execute(call('GET', 'http://127.0.0.1:3000/'), ctx);
      assert.equal(refusalCode(text), 'net_reserved_port');
      assert.match(text, /whose port could not be determined/);
      assert.equal(refusalCode(await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx)), null);
      assert.equal(sent.length, 1);
    });

    it('fails closed the same way when reading the port throws', async () => {
      const { tool } = createTool({ readServerPort: () => { throw new Error('getter failed'); } });
      assert.equal(refusalCode(await tool.execute(call('GET', 'http://localhost:3000/'), createContext().ctx)), 'net_reserved_port');
    });

    it('refuses the cloud metadata address named as a literal', async () => {
      const { tool } = createTool();
      assert.equal(refusalCode(await tool.execute(call('GET', 'http://169.254.169.254/latest/meta-data/'), createContext().ctx)), 'net_host_not_allowed');
    });

    const rebinding = [
      { name: 'the metadata address', address: '169.254.169.254', rule: 'link-local-v4' },
      { name: 'loopback', address: '127.0.0.1', rule: 'loopback-v4' },
      { name: 'a private address', address: '10.0.0.7', rule: 'private-10' },
      { name: 'an IPv4-mapped loopback', address: '::ffff:127.0.0.1', rule: 'loopback-v4' },
    ];
    for (const { name, address, rule } of rebinding) {
      it(`refuses an allowed name that resolves to ${name}, after the ask and before any socket`, async () => {
        const resolver = createLookup({ 'docs.unity3d.com': [address] });
        const { tool, sent } = createTool({ lookup: resolver.lookup });
        const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
        assert.equal(refusalCode(text), 'net_address_blocked');
        assert.match(text, new RegExp(`\\(${rule}\\)`));
        assert.equal(sent.length, 0);
      });
    }

    it('pins the one address that survives when an answer mixes blocked and public addresses', async () => {
      const resolver = createLookup({ 'docs.unity3d.com': ['10.0.0.7', PUBLIC_ADDRESS, '198.51.100.20'] });
      const { tool, sent } = createTool({ lookup: resolver.lookup });
      assert.equal(refusalCode(await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx)), null);
      assert.equal(sent[0].pinned.text, PUBLIC_ADDRESS);
    });
  });
});

describe('tier 2: consent, once, at the terminal', () => {
  it('C-1: a new host is refused, naming the exact grant command', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', 'https://api.example.com/v1/scores'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_host_not_allowed');
    assert.match(text, /Ask the user to run: opencode-unity net allow api\.example\.com$/);
  });

  it('C-2: a non-idempotent method to a host off this machine is refused, naming the write grant', async () => {
    const { tool, sent } = createTool();
    const text = await tool.execute(call('POST', 'https://docs.unity3d.com/Manual/index.html', '{}'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_method_not_allowed');
    assert.match(text, /Ask the user to run: opencode-unity net allow docs\.unity3d\.com --write --experimental$/);
    assert.equal(sent.length, 0);
  });

  it('C-2 granted: a consented write entry sends the body, with no header the model chose', async () => {
    const { tool, sent } = createTool({ network: buildPolicy({ entries: [...SHIPPED_HOST_ENTRIES, LOOPBACK_DEV_ENTRY, CONSENTED_WRITE_ENTRY] }) });
    const body = JSON.stringify({ data: { score: 120 } });
    const text = await tool.execute(call('POST', 'https://api.example.com/v1/scores', body), createContext().ctx);
    assert.equal(refusalCode(text), null, text);
    assert.equal(sent[0].body, body);
    assert.deepEqual(sent[0].headers, {});
    assert.equal(sent[0].host, 'api.example.com');
  });

  it('C-3: an upload above the entry cap is refused before it leaves, naming the body grant', async () => {
    const { tool, sent } = createTool({ network: buildPolicy({ entries: [...SHIPPED_HOST_ENTRIES, LOOPBACK_DEV_ENTRY, CONSENTED_WRITE_ENTRY] }) });
    const text = await tool.execute(call('POST', 'https://api.example.com/v1/upload', 'x'.repeat(9000)), createContext().ctx);
    assert.equal(refusalCode(text), 'net_budget_exceeded');
    assert.match(text, /the body is 9000 bytes and this host allows 8192/);
    assert.match(text, /opencode-unity net allow api\.example\.com --write --max-body 9000 --experimental$/);
    assert.equal(sent.length, 0);
  });

  it('never grants anything in-session: the permission ask carries always: []', async () => {
    const { tool } = createTool();
    const { ctx, asks } = createContext();
    await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx);
    assert.deepEqual(asks, [{ permission: 'unitynet', patterns: ['GET https://docs.unity3d.com/Manual/index.html'], always: [], metadata: {} }]);
  });
});

describe('tier 3: free by default', () => {
  const shipped = [
    'https://docs.unity3d.com/Manual/index.html',
    'https://learn.microsoft.com/en-us/dotnet/api/system.string',
    'https://api.nuget.org/v3/index.json',
    'https://registry.npmjs.org/firebase-functions',
    'https://firebase.google.com/docs/functions/callable-reference',
  ];
  for (const url of shipped) {
    for (const method of ['GET', 'HEAD']) {
      it(`F-1: ${method} ${new URL(url).host} goes out, pinned to the resolved address, certificate checked against the name`, async () => {
        const { tool, sent } = createTool();
        const text = await tool.execute(call(method, url), createContext().ctx);
        assert.equal(refusalCode(text), null, text);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].method, method);
        assert.equal(sent[0].pinned.text, PUBLIC_ADDRESS);
        assert.equal(sent[0].host, new URL(url).hostname);
        assert.equal(sent[0].body, null);
        assert.equal(sent[0].ca, null);
      });
    }
  }

  it('F-2: a loopback GET reaches a local server end to end and comes back as fenced data', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ scores: [120, 90] }));
    });
    try {
      const { tool } = createTool({ send: sendRequest });
      const text = await tool.execute(call('GET', `${server.origin}/v1/scores?page=1`), createContext().ctx);
      assert.match(text, new RegExp(`^unitynet GET http://127\\.0\\.0\\.1:${server.port} 200 application/json \\d+ bytes in \\d+ ms\\n`));
      assert.match(text, /<<<network-response [0-9a-f]{8}\n/);
      assert.match(text, /"scores"/);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].url, '/v1/scores?page=1');
    } finally {
      await server.close();
    }
  });

  it('F-2: loopback is read-only by default, and the refusal names the flag that derives a write entry', async () => {
    const server = await startServer((_request, response) => response.end('{}'));
    try {
      const { tool } = createTool({ send: sendRequest });
      const text = await tool.execute(call('POST', `${server.origin}/api/scores`, '{"score":1}'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_method_not_allowed');
      assert.match(text, /local ports are read-only/);
      assert.match(text, /Ask the user to run: opencode-unity init --derive local-services --allow-local-writes$/);
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('F-2: a loopback DELETE needs an entry marked destructive, and the refusal names that grant', async () => {
    const { tool, sent } = createTool();
    const text = await tool.execute(call('DELETE', 'http://127.0.0.1:9099/emulator/v1/projects/demo-game/accounts'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_delete_not_allowed');
    assert.match(text, /Ask the user to run: opencode-unity net allow 127\.0\.0\.1 --port 9099 --delete$/);
    assert.equal(sent.length, 0);
  });

  it('F-3: a derived Cloud Functions entry carries a demo- POST to the emulator', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { score: 120, rank: 4 } }));
    });
    try {
      const { tool } = createTool({ network: buildPolicy({ derived: [{ ...FUNCTIONS_ENTRY, ports: [server.port] }], disjoint: true }), send: sendRequest });
      const text = await tool.execute(call('POST', `${server.origin}/demo-game/us-central1/submitScore`, JSON.stringify({ data: { score: 120 } })), createContext().ctx);
      assert.match(text, new RegExp(`^unitynet POST http://127\\.0\\.0\\.1:${server.port} 200 application/json`));
      assert.match(text, /"rank": 4/);
      assert.equal(server.requests[0].method, 'POST');
    } finally {
      await server.close();
    }
  });

  it('F-3: loopback writes need a derived entry: the same POST without one is refused', async () => {
    const { tool, sent } = createTool({ network: buildPolicy() });
    assert.equal(refusalCode(await tool.execute(call('POST', 'http://127.0.0.1:5001/demo-game/us-central1/submitScore', '{"data":{}}'), createContext().ctx)), 'net_method_not_allowed');
    assert.equal(sent.length, 0);
  });

  it('local certificates: a loopback https entry trusts its own caFile, and only that entry', async () => {
    const caEntry = { id: 'local-api', host: 'localhost', hostKind: 'exact', ports: [7001], scheme: 'https', methods: ['GET'], pathPrefix: ['/'], loopback: true, caFile: '/opt/dev-certs/root.pem', budget: { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 0 } };
    /** @type {string[]} */
    const read = [];
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const { tool, sent } = createTool({
      network: buildPolicy({ entries: [...SHIPPED_HOST_ENTRIES, { ...LOOPBACK_DEV_ENTRY, excludePorts: [7001] }, caEntry] }),
      readCaFile: async (file) => { read.push(file); return pem; },
    });
    const { ctx } = createContext();
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://localhost:7001/health'), ctx)), null);
    assert.equal(sent[0].ca, pem);
    assert.equal(sent[0].pinned.text, '127.0.0.1');
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx)), null);
    assert.equal(sent[1].ca, null);
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://localhost:7001/health'), ctx)), null);
    assert.deepEqual(read, ['/opt/dev-certs/root.pem'], 'the anchor is read once and cached');
  });

  const badAnchors = [
    { name: 'a relative path, which would resolve inside the project', caFile: 'certs/root.pem', content: '-----BEGIN CERTIFICATE-----\n' },
    { name: 'a private key', caFile: '/opt/dev-certs/root.pem', content: '-----BEGIN CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\n' },
    { name: 'a file with no certificate', caFile: '/opt/dev-certs/root.pem', content: 'not a certificate' },
  ];
  for (const { name, caFile, content } of badAnchors) {
    it(`local certificates: refuses ${name} as a trust anchor`, async () => {
      const caEntry = { id: 'local-api', host: 'localhost', hostKind: 'exact', ports: [7001], scheme: 'https', methods: ['GET'], pathPrefix: ['/'], loopback: true, caFile, budget: { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 0 } };
      const { tool, sent } = createTool({
        network: buildPolicy({ entries: [{ ...LOOPBACK_DEV_ENTRY, excludePorts: [7001] }, caEntry] }),
        readCaFile: async () => content,
      });
      const text = await tool.execute(call('GET', 'https://localhost:7001/health'), createContext().ctx);
      assert.equal(refusalCode(text), 'net_tls_untrusted');
      assert.match(text, /Ask the user to run: opencode-unity net why https:\/\/localhost:7001$/);
      assert.equal(sent.length, 0);
    });
  }
});
