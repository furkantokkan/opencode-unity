// Loopback HTTP server shared by the self-test mocks (spec 20.3, 20.4). Each mock is a handler object;
// one server can host several handlers, so the OpenAI-compatible and native Ollama mocks can share a
// port the way a real Ollama server does. Every request is recorded, including ones no handler takes.
import { EventEmitter } from 'node:events';
import http from 'node:http';

export const LOOPBACK_HOST = '127.0.0.1';

// Real Ollama (11434) and the real MCP for Unity hub (8081). A mock must never take their place.
export const FORBIDDEN_MOCK_PORTS = Object.freeze([11434, 8081]);

/**
 * @typedef {object} MockRequest
 * @property {number} index        Position in the server log, starting at 0.
 * @property {string} method
 * @property {string} path         Path without the query string.
 * @property {string} url          Path with the query string.
 * @property {Record<string, string>} headers  Lower-case names; repeated headers are joined with ', '.
 * @property {string} bodyText
 * @property {unknown} body        Parsed JSON, or undefined when the body is empty or not JSON.
 * @property {number} bodyBytes
 * @property {string} receivedAt   ISO timestamp.
 * @property {string | null} handledBy  Name of the handler that answered, or null for a 404.
 * @property {number | null} status     Status code once the response finished.
 * @property {boolean} aborted     True when the connection closed before the response finished.
 */

/**
 * @typedef {object} MockHandler
 * @property {string} name
 * @property {(request: MockRequest, response: http.ServerResponse) => boolean | Promise<boolean>} handle
 *   Returns true when it answered the request.
 */

/**
 * @typedef {object} MockServer
 * @property {string} url          `http://127.0.0.1:<port>` without a trailing slash.
 * @property {number} port
 * @property {MockRequest[]} requests
 * @property {(predicate: (requests: MockRequest[]) => boolean, options?: { timeoutMs?: number }) => Promise<MockRequest[]>} waitFor
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ handlers: MockHandler[], port?: number, host?: string }} options
 * @returns {Promise<MockServer>}
 */
export async function startMockServer({ handlers, port = 0, host = LOOPBACK_HOST }) {
  assertMockPort(port);
  if (host !== LOOPBACK_HOST) throw new Error(`mock servers listen on ${LOOPBACK_HOST} only, not ${host}`);
  /** @type {MockRequest[]} */
  const requests = [];
  const events = new EventEmitter();
  const server = http.createServer((incoming, response) => {
    handleIncoming(incoming, response, handlers, requests, events).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: `mock failure: ${error.message}` });
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  let closed = false;
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    requests,
    waitFor: (predicate, options) => waitForRequests(requests, events, predicate, options),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * @param {number} port
 */
export function assertMockPort(port) {
  if (FORBIDDEN_MOCK_PORTS.includes(port)) {
    throw new Error(`refusing to start a mock on port ${port}: it belongs to a real service`);
  }
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 * @param {Record<string, string>} [headers]
 */
export function sendJson(response, status, value, headers = {}) {
  const text = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(text);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {http.IncomingMessage} incoming
 * @param {http.ServerResponse} response
 * @param {MockHandler[]} handlers
 * @param {MockRequest[]} requests
 * @param {EventEmitter} events
 */
async function handleIncoming(incoming, response, handlers, requests, events) {
  const bodyBuffer = await readBody(incoming);
  const url = incoming.url ?? '/';
  const bodyText = bodyBuffer.toString('utf8');
  /** @type {MockRequest} */
  const request = {
    index: requests.length,
    method: incoming.method ?? 'GET',
    path: new URL(url, 'http://mock').pathname,
    url,
    headers: normalizeHeaders(incoming.headers),
    bodyText,
    body: parseJson(bodyText),
    bodyBytes: bodyBuffer.length,
    receivedAt: new Date().toISOString(),
    handledBy: null,
    status: null,
    aborted: false,
  };
  requests.push(request);
  response.on('finish', () => {
    request.status = response.statusCode;
    events.emit('change');
  });
  response.on('close', () => {
    if (!response.writableFinished) {
      request.aborted = true;
      events.emit('change');
    }
  });
  events.emit('change');
  for (const handler of handlers) {
    if (await handler.handle(request, response)) {
      request.handledBy = handler.name;
      return;
    }
  }
  sendJson(response, 404, { error: `mock: no route for ${request.method} ${request.path}` });
}

/**
 * @param {http.IncomingMessage} incoming
 * @returns {Promise<Buffer>}
 */
function readBody(incoming) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
}

/**
 * @param {http.IncomingHttpHeaders} headers
 * @returns {Record<string, string>}
 */
function normalizeHeaders(headers) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {MockRequest[]} requests
 * @param {EventEmitter} events
 * @param {(requests: MockRequest[]) => boolean} predicate
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<MockRequest[]>}
 */
function waitForRequests(requests, events, predicate, { timeoutMs = 5000 } = {}) {
  if (predicate(requests)) return Promise.resolve(requests);
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (!predicate(requests)) return;
      clearTimeout(timer);
      events.off('change', onChange);
      resolve(requests);
    };
    const timer = setTimeout(() => {
      events.off('change', onChange);
      reject(new Error(`mock: condition not met within ${timeoutMs} ms (${requests.length} requests recorded)`));
    }, timeoutMs);
    events.on('change', onChange);
  });
}
