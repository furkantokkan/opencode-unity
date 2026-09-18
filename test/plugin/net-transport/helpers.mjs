// Loopback servers, limits and request stubs for the transport suite (build step S33).
//
// Two real servers, because the transport's interesting behaviour is in bytes on a socket: an ordinary
// `node:http` server for the status, header and streaming cases, and a raw `node:net` server for the
// responses a compliant server cannot produce - a declared length that is a lie, headers that never
// arrive, a body that stops half way. Both listen on 127.0.0.1 only and are closed by the test.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';

import { parseIpAddress } from '../../../plugin/opencode-unity-lib/net/ip-rules.js';

/**
 * A pinned address in the shape step 13 hands over: what the IP rules parsed, not a hand-written pair.
 * @param {string} text
 * @returns {import('../../../plugin/opencode-unity-lib/net/ip-rules.js').IpAddress}
 */
export function pin(text) {
  const address = parseIpAddress(text);
  if (address === null) throw new Error(`the test pinned something that is not an address: ${text}`);
  return address;
}

/** The shipped limits (amendment 35.7), shortened where a test has to wait for one. */
export const TEST_LIMITS = Object.freeze({ maxResponseBytes: 65536, connectTimeoutMs: 5000, firstByteTimeoutMs: 10000, totalTimeoutMs: 20000 });

/**
 * @param {Partial<typeof TEST_LIMITS>} [overrides]
 * @returns {typeof TEST_LIMITS}
 */
export function limits(overrides = {}) {
  return { ...TEST_LIMITS, ...overrides };
}

/**
 * @typedef {object} TestServer
 * @property {number} port
 * @property {string} origin        `http://127.0.0.1:<port>`
 * @property {Array<{ method: string, url: string, headers: Record<string, unknown> }>} requests
 * @property {() => Promise<void>} close
 */

/**
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<TestServer>}
 */
export async function startServer(handler) {
  /** @type {TestServer['requests']} */
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    response.on('error', () => {});
    request.on('error', () => {});
    try {
      handler(request, response);
    } catch {
      response.destroy();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * A server that speaks HTTP by hand. The callback is given the socket once the request head has
 * arrived, so a test can answer with any bytes at all - or with none.
 * @param {(socket: import('node:net').Socket, head: string) => void} onRequest
 * @returns {Promise<TestServer>}
 */
export async function startRawServer(onRequest) {
  /** @type {TestServer['requests']} */
  const requests = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let head = '';
    const onData = (/** @type {Buffer} */ chunk) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      const [start] = head.split('\r\n');
      const [method = '', url = ''] = start.split(' ');
      requests.push({ method, url, headers: parseHeadHeaders(head) });
      onRequest(socket, head);
    };
    socket.on('data', onData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * Writes a body in chunks until `totalBytes` have gone out or the client has walked away.
 * @param {import('node:http').ServerResponse} response
 * @param {{ totalBytes: number, chunkBytes?: number, contentType?: string }} options
 */
export function streamBody(response, { totalBytes, chunkBytes = 16 * 1024, contentType = 'text/plain' }) {
  response.writeHead(200, { 'content-type': contentType });
  const chunk = Buffer.alloc(chunkBytes, 'a');
  let sent = 0;
  const write = () => {
    while (sent < totalBytes) {
      if (response.destroyed || response.writableEnded) return;
      sent += chunkBytes;
      if (!response.write(chunk)) {
        response.once('drain', write);
        return;
      }
    }
    response.end();
  };
  write();
}

/**
 * A stand-in for `http.request`, for the cases a real socket cannot produce on demand: a connection
 * that never completes, and a socket that reports an address the policy never approved.
 * @returns {{ request: (options: any) => any, calls: Array<{ options: any, request: any }> }}
 */
export function createRequestStub() {
  /** @type {Array<{ options: any, request: any }>} */
  const calls = [];
  const request = (/** @type {any} */ options) => {
    const clientRequest = /** @type {any} */ (new EventEmitter());
    clientRequest.destroyed = false;
    clientRequest.sentBody = undefined;
    clientRequest.end = (/** @type {any} */ body) => {
      clientRequest.sentBody = body;
    };
    clientRequest.destroy = () => {
      clientRequest.destroyed = true;
    };
    calls.push({ options, request: clientRequest });
    return clientRequest;
  };
  return { request, calls };
}

/**
 * A socket stand-in. `connecting` starts true, and `connect()` flips it and emits, in the order a real
 * socket does.
 * @param {{ remoteAddress?: string | null }} [options]
 * @returns {any}
 */
export function createSocketStub({ remoteAddress = '127.0.0.1' } = {}) {
  const socket = /** @type {any} */ (new EventEmitter());
  socket.connecting = true;
  socket.destroyed = false;
  socket.remoteAddress = remoteAddress ?? undefined;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.connect = () => {
    socket.connecting = false;
    socket.emit('connect');
  };
  return socket;
}

/**
 * A response stand-in carrying a status and headers; the test pushes the body itself.
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 * @returns {any}
 */
export function createResponseStub({ status = 200, headers = { 'content-type': 'text/plain' } } = {}) {
  const response = /** @type {any} */ (new EventEmitter());
  response.statusCode = status;
  response.headers = headers;
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
  };
  return response;
}

/**
 * @param {string} head
 * @returns {Record<string, string>}
 */
function parseHeadHeaders(head) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) {
    if (line === '') break;
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}
