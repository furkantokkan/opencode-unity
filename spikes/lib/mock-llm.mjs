// A loopback OpenAI-compatible endpoint for spikes. It records every request and answers
// /v1/chat/completions with scripted streaming replies: text, tool calls or an HTTP error.
import http from 'node:http';

/**
 * @typedef {{ text: string, usage?: { prompt_tokens: number, completion_tokens: number } }} TextReply
 * @typedef {{ toolCalls: Array<{ name: string, arguments: Record<string, unknown> }>, usage?: { prompt_tokens: number, completion_tokens: number } }} ToolReply
 * @typedef {{ status: number, json: unknown, headers?: Record<string, string> }} ErrorReply
 * @typedef {TextReply | ToolReply | ErrorReply} Reply
 * @typedef {{ method: string, url: string, headers: Record<string, string | string[] | undefined>, body: any, at: number }} RecordedRequest
 * @typedef {(body: any, index: number, all: RecordedRequest[]) => Reply} Responder
 */

/**
 * @param {object} [options]
 * @param {Responder} [options.respond]  Called for each chat request; default replies with text "OK".
 */
export async function startMockLlm({ respond } = {}) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {RecordedRequest[]} */
  const chatRequests = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsed: raw.slice(0, 2000) };
    }
    /** @type {RecordedRequest} */
    const record = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, at: Date.now() };
    requests.push(record);
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      chatRequests.push(record);
      const reply = respond ? respond(body, chatRequests.length - 1, chatRequests) : { text: 'OK' };
      writeReply(res, reply, body?.model ?? 'mock');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseURL: `${origin}/v1`,
    requests,
    chatRequests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
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

/**
 * @param {http.ServerResponse} res
 * @param {Reply} reply
 * @param {string} model
 */
function writeReply(res, reply, model) {
  if ('status' in reply) {
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    res.end(JSON.stringify(reply.json));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (/** @type {any} */ choice) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [choice] })}\n\n`;
  const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 5 };
  if ('text' in reply) {
    res.write(chunk({ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }));
    res.write(chunk({ index: 0, delta: {}, finish_reason: 'stop' }));
  } else {
    reply.toolCalls.forEach((call, index) => {
      res.write(chunk({
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index,
            id: `call_${index}_${Date.now()}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: null,
      }));
    });
    res.write(chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' }));
  }
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * The system prompt text of a recorded chat request.
 * @param {any} body
 * @returns {string}
 */
export function systemText(body) {
  return (body?.messages ?? [])
    .filter((/** @type {any} */ message) => message.role === 'system')
    .map((/** @type {any} */ message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}

/**
 * Tool result messages (role "tool") of a recorded chat request.
 * @param {any} body
 * @returns {Array<{ id: string, content: string }>}
 */
export function toolResults(body) {
  return (body?.messages ?? [])
    .filter((/** @type {any} */ message) => message.role === 'tool')
    .map((/** @type {any} */ message) => ({
      id: message.tool_call_id,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    }));
}

/**
 * Tool names offered in a recorded chat request.
 * @param {any} body
 * @returns {string[]}
 */
export function toolNames(body) {
  return (body?.tools ?? []).map((/** @type {any} */ tool) => tool.function?.name ?? tool.name).sort();
}

/**
 * A responder that answers the n-th chat request with the n-th scripted tool call (one call per
 * request), then with a final text reply.
 * @param {Array<{ name: string, arguments: Record<string, unknown> }>} calls
 * @param {string} [finalText]
 * @returns {Responder}
 */
export function scriptedToolCalls(calls, finalText = 'done') {
  return (_body, index) => (index < calls.length ? { toolCalls: [calls[index]] } : { text: finalText });
}

/**
 * Finds the tool result for the tool call id the mock issued at request `index`, by looking at the
 * following request (which carries the result).
 * @param {RecordedRequest[]} chatRequests
 * @param {number} index
 * @returns {string | null}
 */
export function toolResultAfter(chatRequests, index) {
  const next = chatRequests[index + 1];
  if (!next) return null;
  const results = toolResults(next.body);
  return results.length ? results[results.length - 1].content : null;
}

/**
 * A loopback HTTP server that records every request and answers with a fixed JSON body. Used as a
 * decoy for URLs OpenCode must not fetch (for example OPENCODE_MODELS_URL).
 * @param {unknown} [body]
 */
export async function startRecorder(body = {}) {
  /** @type {Array<{ method: string, url: string }>} */
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}
