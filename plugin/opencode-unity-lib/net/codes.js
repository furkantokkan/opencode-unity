// The stable codes of the `unitynet` tool (amendment 35.5, expansion 12.8.2) and the one sentence each
// shows the model. A code is the contract: it appears in the result the model reads, in the session log
// and in `status`, and `net why` names the same step. The sentence is only the explanation, and the
// remedy is the exact command a human would run at the terminal - never something the model can do
// itself, because consent is granted outside the session (`DN20`) and the agent shell cannot reach the
// product's own binary (`DN19`).
//
// Nothing here repeats what the model sent. A host, a port and a pattern id are facts the policy
// decided; a path, a query and a body are not echoed, so a refusal can never become the channel that
// carries the value it refused.

/** The name a human types at the terminal. */
const CLI_NAME = 'opencode-unity';

/**
 * @typedef {object} CodeEntry
 * @property {number | null} step   The execution step of 12.8.2 that produces it; null for the catch-all.
 * @property {string} text          The default sentence, lower case, no final period.
 */

/**
 * @param {number | null} step
 * @param {string} text
 * @returns {Readonly<CodeEntry>}
 */
function entry(step, text) {
  return Object.freeze({ step, text });
}

/**
 * Every code the tool can return. The policy core (S31) and the transport (S33) export their own lists;
 * a test asserts both are covered here, so a code added below the tool cannot reach the model without a
 * sentence.
 */
export const NET_CODES = Object.freeze({
  net_bad_arguments: entry(1, 'the call needs exactly three string arguments: method, url and body'),
  net_disabled: entry(2, 'the network is off for this session'),
  net_policy_drift: entry(2, 'the network policy changed after this session started, so every request is refused'),
  net_rate_limited: entry(3, 'the request limit was reached'),
  net_url_invalid: entry(4, 'the URL cannot be used'),
  net_url_userinfo: entry(4, 'the URL carries a user name or password, which is never sent'),
  net_url_idn: entry(4, 'the host must be written in its ASCII form'),
  net_method_not_allowed: entry(5, 'this method is not allowed for this host'),
  net_body_on_read: entry(5, 'GET and HEAD carry no body; pass an empty body'),
  net_delete_not_allowed: entry(5, 'DELETE is not allowed here'),
  net_host_not_allowed: entry(6, 'this host is not allowed'),
  net_port_not_allowed: entry(6, 'this port or scheme is not allowed for this host'),
  net_path_not_allowed: entry(6, 'this path is not allowed for this host'),
  net_reserved_port: entry(7, 'this port belongs to a local control surface and is never reachable from a session'),
  net_budget_exceeded: entry(8, 'the request is larger than this host allows'),
  net_credential_in_url: entry(9, 'the query carries something shaped like a credential, which is never sent'),
  net_sensitive_outbound: entry(10, 'the request carries something shaped like a credential, which is never sent'),
  net_firebase_project_not_demo: entry(11, 'a Cloud Functions emulator request must name a demo- project as the first path segment'),
  net_firebase_project_is_live: entry(11, 'this path names a live Firebase project, which is never reachable from a session'),
  net_permission_denied: entry(12, 'the permission for this request was denied'),
  net_dns_failed: entry(13, 'the host name could not be resolved'),
  net_address_blocked: entry(13, 'the host resolved only to addresses this tool never connects to'),
  net_connect_timeout: entry(14, 'the connection was not established in time'),
  net_first_byte_timeout: entry(14, 'the server sent no response in time'),
  net_tls_untrusted: entry(14, 'the server certificate is not trusted'),
  net_tls_hostname_mismatch: entry(14, 'the server certificate is for a different host name'),
  net_connect_failed: entry(14, 'the connection failed'),
  net_content_type_not_text: entry(17, 'the response is not a text type this tool shows'),
  net_content_encoding_not_identity: entry(17, 'the server compressed the response although it was asked not to'),
  net_total_timeout: entry(19, 'the request did not finish within the total time limit'),
  net_tool_error: entry(null, 'the tool failed while handling this call'),
});

/** @typedef {keyof typeof NET_CODES} NetCode */

/** @type {readonly string[]} */
export const NET_CODE_IDS = Object.freeze(Object.keys(NET_CODES));

/**
 * What a refusal knows about the request. Every field is optional because a refusal at step 1 knows
 * none of them.
 * @typedef {object} DenialContext
 * @property {string} [reason]       The machine reason the deciding module attached.
 * @property {string} [host]         Lowercased, ASCII, no brackets.
 * @property {number} [port]
 * @property {string} [origin]
 * @property {string} [method]
 * @property {boolean} [loopback]    True when the request's host is on this machine.
 * @property {string} [field]        Budget field: `path`, `query` or `body`.
 * @property {number} [limit]
 * @property {number} [actual]
 * @property {string} [key]          A query key, shown only when it is a plain identifier.
 * @property {string} [part]         `url` or `body`, for the outbound scan.
 * @property {string} [patternId]    The detector's pattern id, never the matched text.
 * @property {string} [rule]         The IP rule id that blocked an address.
 * @property {string} [segment]      The first path segment, shown only when it is a plain identifier.
 * @property {string} [feedback]     What a human typed when declining the permission.
 */

/**
 * The sentence and the remedy for one refusal.
 * @param {string} code
 * @param {DenialContext} [context]
 * @returns {{ sentence: string, remedy: string | null }}
 */
export function describeDenial(code, context = {}) {
  const known = Object.prototype.hasOwnProperty.call(NET_CODES, code) ? NET_CODES[/** @type {NetCode} */ (code)] : NET_CODES.net_tool_error;
  const refine = SENTENCES[code];
  const sentence = (refine ? refine(context) : null) ?? known.text;
  const command = REMEDIES[code]?.(context) ?? null;
  return { sentence, remedy: command ? `Ask the user to run: ${command}` : null };
}

/** URL rejection reasons from `url.js`, in words the model can act on. */
const URL_REASONS = Object.freeze({
  scheme: 'only absolute http:// and https:// URLs are accepted',
  fragment: 'remove the #fragment',
  'control-character': 'the URL contains a space or a control character',
  backslash: 'the URL contains a backslash',
  port: 'the port is out of range',
  'percent-encoding': 'the path has malformed percent-encoding',
});

/** Reserved-port rows (`DN10`, `D-M33`), named by what they guard rather than by number. */
const RESERVED_SURFACES = Object.freeze({
  'ollama-api': 'the local model server',
  'unity-mcp-hub': 'the MCP for Unity hub',
  'opencode-server': 'the OpenCode server',
  'opencode-server-unknown': 'the OpenCode server, whose port could not be determined',
  'firebase-emulator-hub': 'the Firebase Emulator Hub',
  'docker-daemon': 'the Docker daemon',
  'docker-daemon-tls': 'the Docker daemon',
  'config-extra': 'a service the configuration reserves',
});

/** A name that is safe to repeat back: an identifier, not free text. */
const PLAIN_NAME = /^[A-Za-z0-9._~-]{1,64}$/;

/** @type {Record<string, (context: DenialContext) => string | null>} */
const SENTENCES = {
  net_bad_arguments: ({ reason, limit }) => {
    if (reason === 'url-too-long') return `the url is longer than ${limit} characters`;
    if (reason === 'unknown-method') return 'method must be one of GET, HEAD, POST, PUT, PATCH or DELETE, in capitals';
    return null;
  },
  net_disabled: () => 'the network is off for this session (profile none, --offline, or no usable policy)',
  net_rate_limited: ({ reason, limit }) => (reason === 'minute'
    ? `more than ${limit} requests in one minute; wait before the next one`
    : `this session has used all ${limit} of its requests`),
  net_url_invalid: ({ reason }) => URL_REASONS[/** @type {keyof typeof URL_REASONS} */ (reason ?? '')] ?? 'the URL could not be parsed as an absolute URL',
  net_method_not_allowed: ({ method, loopback }) => (loopback
    ? `${method ?? 'this method'} is not allowed on this local port; local ports are read-only unless the project's own configuration defines a write entry`
    : `${method ?? 'this method'} is not allowed for this host`),
  net_delete_not_allowed: ({ reason }) => (reason === 'delete-off-machine'
    ? 'DELETE is never allowed to a host off this machine'
    : 'DELETE on this local port needs an entry marked destructive'),
  net_port_not_allowed: ({ reason, port }) => (reason === 'scheme'
    ? 'this scheme is not allowed for this host'
    : `port ${port} is not allowed for this host`),
  net_path_not_allowed: ({ reason }) => (reason === 'traversal'
    ? 'the path leaves its allowed prefix through a dot segment, which is never allowed'
    : 'this path is outside the prefixes allowed for this host'),
  net_reserved_port: ({ port, reason }) => {
    const surface = RESERVED_SURFACES[/** @type {keyof typeof RESERVED_SURFACES} */ (reason ?? '')] ?? 'a reserved local service';
    return port ? `port ${port} belongs to ${surface} and is never reachable from a session` : `this port belongs to ${surface} and is never reachable from a session`;
  },
  net_budget_exceeded: ({ field, limit, actual }) => {
    if (field === 'body') return `the body is ${actual} bytes and this host allows ${limit}`;
    if (field === 'path' || field === 'query') return `the ${field} is ${actual} characters and this host allows ${limit}`;
    return null;
  },
  net_credential_in_url: ({ key }) => (typeof key === 'string' && PLAIN_NAME.test(key)
    ? `the query parameter "${key}" looks like a credential and is never sent`
    : null),
  net_sensitive_outbound: ({ part, patternId }) => {
    const where = part === 'body' ? 'body' : 'URL';
    return patternId ? `the ${where} contains something shaped like a credential (${patternId}), which is never sent` : null;
  },
  net_permission_denied: ({ reason, feedback }) => {
    if (reason === 'rule') return 'a permission rule refuses this request';
    if (reason === 'corrected' && feedback) return `the user declined this request and said: ${feedback}`;
    if (reason === 'rejected' || reason === 'corrected') return 'the user declined this request';
    return null;
  },
  net_address_blocked: ({ rule }) => (typeof rule === 'string' && PLAIN_NAME.test(rule)
    ? `the host resolved only to addresses this tool never connects to (${rule})`
    : null),
};

/** @type {Record<string, (context: DenialContext) => string | null>} */
const REMEDIES = {
  net_disabled: () => `${CLI_NAME} init --network standard`,
  net_policy_drift: () => `${CLI_NAME} start`,
  net_host_not_allowed: ({ host }) => (host ? `${CLI_NAME} net allow ${host}` : null),
  net_port_not_allowed: ({ reason, host, port }) => (reason === 'port' && host && port ? `${CLI_NAME} net allow ${host} --port ${port}` : null),
  net_path_not_allowed: ({ reason, host, segment }) => {
    if (reason === 'traversal' || !host) return null;
    const prefix = typeof segment === 'string' && PLAIN_NAME.test(segment) ? `/${segment}/` : '<prefix>';
    return `${CLI_NAME} net allow ${host} --path ${prefix}`;
  },
  net_method_not_allowed: ({ method, host, loopback }) => {
    if (!host || (method !== 'POST' && method !== 'PUT' && method !== 'PATCH')) return null;
    return loopback ? `${CLI_NAME} init --derive local-services --allow-local-writes` : `${CLI_NAME} net allow ${host} --write --experimental`;
  },
  net_delete_not_allowed: ({ reason, host, port }) => (reason === 'not-destructive' && host && port ? `${CLI_NAME} net allow ${host} --port ${port} --delete` : null),
  net_budget_exceeded: ({ field, host, loopback, actual }) => (field === 'body' && host && !loopback && typeof actual === 'number'
    ? `${CLI_NAME} net allow ${host} --write --max-body ${actual} --experimental`
    : null),
  net_tls_untrusted: ({ loopback, origin }) => (loopback && origin ? `${CLI_NAME} net why ${origin}` : null),
};
