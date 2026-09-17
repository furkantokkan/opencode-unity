// Mock MCP for Unity hub (spec 11, 20.3 C11): a streamable-HTTP JSON-RPC endpoint serving the 10.1.0
// tool-list fixture, two resources and original server instructions with a marker line. It never
// contacts Unity or the real hub. Every JSON-RPC message and every `tools/call` is recorded, so tests
// can prove which calls reached the hub and with which arguments.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sendJson, startMockServer } from './mock-server.js';

export const UNITY_MCP_TOOLS_FIXTURE_URL = new URL('./fixtures/unity-mcp-10.1.0-tools.json', import.meta.url);

export const MOCK_HUB_INSTRUCTIONS_MARKER = 'OCU-MOCK-HUB-INSTRUCTIONS';

// Original text: it only needs a recognizable marker and a realistic size.
export const MOCK_HUB_INSTRUCTIONS = `${MOCK_HUB_INSTRUCTIONS_MARKER}
Mock editor hub for opencode-unity tests. Read the instances resource before using editor tools, and
check the console after refreshing. This text stands in for the server instructions of a real hub.`;

export const DEFAULT_MCP_PATH = '/mcp';
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const INSTANCES_RESOURCE_URI = 'mcpforunity://instances';
export const EDITOR_STATE_RESOURCE_URI = 'mcpforunity://editor/state';

// A fictional project; the hash is 16 hex digits like the real instance id (UM `ProjectIdentityUtility.cs` L53-60).
export const DEFAULT_UNITY_INSTANCES = Object.freeze([Object.freeze({ name: 'SampleProject', hash: '0123456789abcdef' })]);

/**
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, unknown>} inputSchema
 * @property {Record<string, unknown>} [annotations]
 */

/**
 * @typedef {object} McpMessage
 * @property {string} endpoint
 * @property {string | null} sessionId
 * @property {string} method
 * @property {unknown} id       null for notifications.
 * @property {any} params
 */

/**
 * @typedef {object} McpToolCall
 * @property {string} endpoint
 * @property {string | null} sessionId
 * @property {string} name
 * @property {Record<string, unknown>} arguments  Exactly as received.
 * @property {boolean} allowed
 */

/**
 * @typedef {object} UnityInstance
 * @property {string} name   Project folder name.
 * @property {string} hash
 * @property {string} [unityVersion]
 */

/**
 * @typedef {object} McpEndpointOptions
 * @property {McpTool[]} [tools]           Default: the MCP for Unity 10.1.0 fixture.
 * @property {string} [instructions]
 * @property {readonly UnityInstance[]} [instances]  Default: one fictional instance.
 * @property {string[] | null} [allowedToolCalls]  Calls outside this list are answered with an error and recorded as violations; null allows all.
 * @property {Record<string, unknown | ((args: Record<string, unknown>) => unknown)>} [toolResults]  `CallToolResult` per tool.
 * @property {'json' | 'sse'} [responseMode]
 */

/**
 * @typedef {object} UnityMcpToolFixture
 * @property {number} schemaVersion
 * @property {string} server
 * @property {string} serverVersion
 * @property {string} source          How names, shapes and size were derived.
 * @property {number} toolCount
 * @property {number} totalBytes      UTF-8 bytes of `JSON.stringify(tools)` (spec 18.3 E6: about 93 KB).
 * @property {string[]} exactShapeTools  Tools whose `inputSchema` follows the upstream parameters; the rest are placeholders.
 * @property {Record<string, string>} groups  Tool name to MCP for Unity tool group.
 * @property {McpTool[]} tools
 */

/** @type {UnityMcpToolFixture | null} */
let cachedFixture = null;

/**
 * @returns {UnityMcpToolFixture}
 */
export function loadUnityMcpToolFixture() {
  cachedFixture ??= JSON.parse(fs.readFileSync(UNITY_MCP_TOOLS_FIXTURE_URL, 'utf8'));
  return /** @type {UnityMcpToolFixture} */ (cachedFixture);
}

/**
 * @param {Record<string, McpEndpointOptions>} [endpoints]  Keyed by path; default one endpoint at `/mcp`.
 */
export function createMockMcpHub(endpoints = { [DEFAULT_MCP_PATH]: {} }) {
  /** @type {McpMessage[]} */
  const messages = [];
  /** @type {McpToolCall[]} */
  const toolCalls = [];
  /** @type {import('./mock-server.js').MockRequest[]} */
  const requests = [];

  /**
   * @param {string} endpoint
   * @param {McpEndpointOptions} options
   * @param {any} message
   * @param {string | null} sessionId
   */
  function answer(endpoint, options, message, sessionId) {
    const method = typeof message?.method === 'string' ? message.method : '';
    const isNotification = message?.id === undefined || message?.id === null;
    messages.push({ endpoint, sessionId, method, id: isNotification ? null : message.id, params: message?.params });
    if (isNotification) return null;
    const ok = (/** @type {unknown} */ result) => ({ jsonrpc: '2.0', id: message.id, result });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: 'mock-unity-mcp-hub', version: '10.1.0-mock' },
          instructions: options.instructions ?? MOCK_HUB_INSTRUCTIONS,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: options.tools ?? loadUnityMcpToolFixture().tools });
      case 'resources/list':
        return ok({
          resources: [
            { uri: INSTANCES_RESOURCE_URI, name: 'unity_instances', mimeType: 'application/json' },
            { uri: EDITOR_STATE_RESOURCE_URI, name: 'editor_state', mimeType: 'application/json' },
          ],
        });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      case 'resources/read':
        return ok({ contents: [readResource(String(message.params?.uri ?? ''), options)] });
      case 'tools/call':
        return ok(callTool(endpoint, options, message.params ?? {}, sessionId));
      default:
        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  /**
   * @param {string} endpoint
   * @param {McpEndpointOptions} options
   * @param {{ name?: unknown, arguments?: unknown }} params
   * @param {string | null} sessionId
   */
  function callTool(endpoint, options, params, sessionId) {
    const name = String(params.name ?? '');
    const args = /** @type {Record<string, unknown>} */ (params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
    const allowed = !options.allowedToolCalls || options.allowedToolCalls.includes(name);
    toolCalls.push({ endpoint, sessionId, name, arguments: args, allowed });
    if (!allowed) return { isError: true, content: [{ type: 'text', text: `mock hub: ${name} is not allowed in this test` }] };
    const planned = options.toolResults?.[name];
    if (typeof planned === 'function') return planned(args);
    return planned ?? { content: [{ type: 'text', text: JSON.stringify({ success: true, mock: true, tool: name }) }] };
  }

  return {
    name: 'mcp-hub',
    requests,
    messages,
    toolCalls,
    /** Calls to tools outside an endpoint's allow-list. */
    get violations() {
      return toolCalls.filter((call) => !call.allowed);
    },
    /** @param {string} method */
    getMessages(method) {
      return messages.filter((message) => message.method === method);
    },
    /**
     * @param {import('./mock-server.js').MockRequest} request
     * @param {import('node:http').ServerResponse} response
     */
    handle(request, response) {
      const options = endpoints[request.path];
      if (!options) return false;
      requests.push(request);
      if (request.method === 'DELETE') {
        response.writeHead(200).end();
        return true;
      }
      // No server-initiated stream: MCP clients treat 405 on GET as "not offered".
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST, DELETE' }).end();
        return true;
      }
      if (request.body === undefined) {
        sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return true;
      }
      const batch = Array.isArray(request.body) ? request.body : [request.body];
      /** @type {Record<string, string>} */
      const headers = {};
      let sessionId = request.headers['mcp-session-id'] ?? null;
      if (batch.some((message) => message?.method === 'initialize')) {
        sessionId = crypto.randomUUID();
        headers['mcp-session-id'] = sessionId;
      }
      const replies = batch.map((message) => answer(request.path, options, message, sessionId)).filter(Boolean);
      if (replies.length === 0) {
        response.writeHead(202, headers).end();
        return true;
      }
      const payload = Array.isArray(request.body) ? replies : replies[0];
      if (options.responseMode === 'sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
        response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        sendJson(response, 200, payload, headers);
      }
      return true;
    },
  };
}

/**
 * @param {{ endpoints?: Record<string, McpEndpointOptions>, port?: number }} [options]
 */
export async function startMockMcpHub({ endpoints, port } = {}) {
  const hub = createMockMcpHub(endpoints);
  const server = await startMockServer({ handlers: [hub], port });
  return { hub, server, url: server.url, mcpUrl: `${server.url}${DEFAULT_MCP_PATH}`, close: server.close };
}

/**
 * @param {string} uri
 * @param {McpEndpointOptions} options
 */
function readResource(uri, options) {
  if (uri === INSTANCES_RESOURCE_URI) {
    const instances = (options.instances ?? DEFAULT_UNITY_INSTANCES).map((instance) => ({
      id: `${instance.name}@${instance.hash}`,
      name: instance.name,
      hash: instance.hash,
      unity_version: instance.unityVersion ?? '6000.0.0f1',
      connected_at: '2026-01-01T00:00:00Z',
      session_id: `mock-session-${instance.hash}`,
    }));
    const text = JSON.stringify({ success: true, transport: 'http', instance_count: instances.length, instances });
    return { uri, mimeType: 'application/json', text };
  }
  return { uri, mimeType: 'application/json', text: JSON.stringify({ success: true, mock: true }) };
}
