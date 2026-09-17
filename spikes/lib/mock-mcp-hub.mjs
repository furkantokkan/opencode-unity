// A loopback MCP server speaking the streamable HTTP transport (JSON responses, no SSE stream), shaped
// like the MCP for Unity hub: a few of its tool names, one instances resource and server instructions.
// It records every JSON-RPC message so spikes can see exactly which arguments reached the hub.
import http from 'node:http';

export const HUB_INSTRUCTIONS_MARKER = 'MOCK_HUB_INSTRUCTIONS_MARKER';
export const INSTANCES_URI = 'mcpforunity://instances';

/** Tool names taken from the MCP for Unity 10.1.0 tool list (a subset). */
export const HUB_TOOL_NAMES = Object.freeze([
  'read_console',
  'find_gameobjects',
  'get_test_job',
  'refresh_unity',
  'run_tests',
  'manage_script',
  'manage_scene',
]);

/**
 * @typedef {{ method: string, id: unknown, params: any, at: number }} RpcRecord
 */

/**
 * @param {object} [options]
 * @param {string} [options.path]           Endpoint path, "/mcp" like the hub.
 * @param {string} [options.instructions]
 * @param {string} [options.instanceId]     Reported by the instances resource.
 */
export async function startMockMcpHub({ path = '/mcp', instructions = `${HUB_INSTRUCTIONS_MARKER}: check the Unity instance first.`, instanceId = 'SampleGame@0123456789abcdef' } = {}) {
  /** @type {RpcRecord[]} */
  const messages = [];
  /** @type {Array<{ method: string, url: string }>} */
  const httpRequests = [];
  const server = http.createServer(async (req, res) => {
    httpRequests.push({ method: req.method ?? '', url: req.url ?? '' });
    if (!req.url?.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET') {
      // No server-initiated SSE stream; the client treats 405 as "not offered".
      res.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const batch = Array.isArray(payload) ? payload : [payload];
    const replies = [];
    for (const message of batch) {
      messages.push({ method: message.method, id: message.id, params: message.params, at: Date.now() });
      if (message.id === undefined || message.id === null) continue;
      replies.push(answer(message, { instructions, instanceId }));
    }
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-hub-session' });
    res.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    messages,
    httpRequests,
    /** @param {string} name */
    toolCalls: (name) => messages.filter((message) => message.method === 'tools/call' && (!name || message.params?.name === name)),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

/**
 * @param {any} message
 * @param {{ instructions: string, instanceId: string }} options
 */
function answer(message, { instructions, instanceId }) {
  const ok = (/** @type {unknown} */ result) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return ok({
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'mock-unity-hub', version: '0.0.0' },
        instructions,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: HUB_TOOL_NAMES.map(toolDefinition) });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: `mock hub ran ${message.params?.name} with ${JSON.stringify(message.params?.arguments ?? {})}` }] });
    case 'resources/list':
      return ok({ resources: [{ uri: INSTANCES_URI, name: 'unity_instances', mimeType: 'application/json' }] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'resources/read':
      return ok({ contents: [{ uri: message.params?.uri, mimeType: 'application/json', text: JSON.stringify({ instances: [{ id: instanceId }] }) }] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } };
  }
}

/**
 * @param {string} name
 */
function toolDefinition(name) {
  return {
    name,
    description: `Mock of the MCP for Unity ${name} tool.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        unity_instance: { type: 'string' },
        mode: { type: 'string' },
        count: { type: 'integer' },
      },
    },
  };
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}
