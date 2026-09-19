// Shared seams for the `unitynet` suites (build step S35). The tool is driven the way OpenCode drives a
// plugin tool - `execute(args, ctx)` with a context that carries `ask` - over a resolved policy, a
// recording log and, where a test must not open a socket, a recording transport. The end-to-end cases
// use the real transport against servers that listen on 127.0.0.1 only.
import { buildPolicy, FUNCTIONS_ENTRY, LOOPBACK_DEV_ENTRY, SHIPPED_HOST_ENTRIES } from '../net-policy/shipped-policy.mjs';
import { createNetTool } from '../../../plugin/opencode-unity-lib/net/tool.js';
import { hashPolicy } from '../../../plugin/opencode-unity-lib/net/policy.js';

export { buildPolicy, FUNCTIONS_ENTRY, LOOPBACK_DEV_ENTRY, SHIPPED_HOST_ENTRIES };
export { startServer, startRawServer } from '../net-transport/helpers.mjs';

/** A documentation-range address (RFC 5737): public to the IP rules, routable nowhere. */
export const PUBLIC_ADDRESS = '203.0.113.10';

/** The port the fake OpenCode server reports in these suites. */
export const SERVER_PORT = 4096;

/**
 * The resolved policy with its hash recomputed, as `start` would record it after any change a test
 * makes. `buildPolicy` already hashes; this is for tests that edit the policy afterwards.
 * @param {any} policy
 * @returns {any}
 */
export function rehash(policy) {
  const copy = JSON.parse(JSON.stringify(policy));
  copy.policyHash = hashPolicy(copy);
  return copy;
}

/**
 * A log that keeps every record exactly as the tool handed it over.
 */
export function createRecordingLog() {
  /** @type {Record<string, unknown>[]} */
  const records = [];
  return { records, log: { append: (/** @type {Record<string, unknown>} */ record) => records.push(record) } };
}

/**
 * A tool context. `ask` records every request and answers with `answer` (a function may throw).
 * @param {{ sessionID?: string, agent?: string, answer?: (request: any) => void | Promise<void> }} [options]
 */
export function createContext({ sessionID = 'ses_test', agent = 'unity-code', answer = () => {} } = {}) {
  /** @type {any[]} */
  const asks = [];
  return {
    asks,
    ctx: {
      sessionID,
      agent,
      /** @param {any} request */
      ask: async (request) => {
        asks.push(request);
        await answer(request);
      },
    },
  };
}

/**
 * A transport that records the request it was handed and answers with a canned result, so a test can
 * assert what would have gone on the wire without a socket.
 * @param {Partial<import('../../../plugin/opencode-unity-lib/net/transport.js').TransportResult>} [result]
 */
export function createRecordingSend(result = {}) {
  /** @type {any[]} */
  const sent = [];
  /** @param {any} request */
  const send = async (request) => {
    sent.push(request);
    return {
      ok: true,
      code: null,
      detail: null,
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      contentLength: 2,
      body: 'ok',
      bytesRead: 2,
      truncatedAtBytes: false,
      timedOut: false,
      stoppedBy: 'complete',
      connection: { address: request.pinned.text, family: request.pinned.family, port: 443, host: request.host, mode: 'pinned-lookup' },
      redirect: null,
      durationMs: 5,
      ...result,
    };
  };
  return { sent, send };
}

/**
 * A resolver that answers from a table and records every name it was asked about.
 * @param {Record<string, string[]>} table
 */
export function createLookup(table) {
  /** @type {string[]} */
  const asked = [];
  /** @param {string} host */
  const lookup = async (host) => {
    asked.push(host);
    const answers = table[host];
    if (!answers) {
      const error = /** @type {any} */ (new Error(`not found: ${host}`));
      error.code = 'ENOTFOUND';
      throw error;
    }
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { asked, lookup };
}

/**
 * The tool over a policy, with every dependency a test does not name replaced by one that records
 * or refuses. Real DNS is never reached: an unlisted name fails as a lookup error.
 * @param {Partial<import('../../../plugin/opencode-unity-lib/net/tool.js').NetToolOptions> & { network?: unknown }} [options]
 */
export function createTool(options = {}) {
  const logging = createRecordingLog();
  const lookup = createLookup({
    'docs.unity3d.com': [PUBLIC_ADDRESS],
    'learn.microsoft.com': [PUBLIC_ADDRESS],
    'api.nuget.org': [PUBLIC_ADDRESS],
    'registry.npmjs.org': [PUBLIC_ADDRESS],
    'firebase.google.com': [PUBLIC_ADDRESS],
    'api.example.com': [PUBLIC_ADDRESS],
    localhost: ['127.0.0.1'],
  });
  const recording = createRecordingSend();
  const tool = createNetTool({
    network: buildPolicy(),
    log: logging.log,
    readServerPort: () => ({ known: true, port: SERVER_PORT }),
    lookup: lookup.lookup,
    send: recording.send,
    ...options,
  });
  return { tool, records: logging.records, asked: lookup.asked, sent: recording.sent };
}

/**
 * @param {string} method
 * @param {string} url
 * @param {string} [body]
 */
export function call(method, url, body = '') {
  return { method, url, body };
}

/**
 * The deny code a refusal line carries, or null for a result that is not a refusal.
 * @param {string} text
 * @returns {string | null}
 */
export function refusalCode(text) {
  const match = /\brefused (net_[a-z_]+):/.exec(text);
  return match ? match[1] : null;
}
