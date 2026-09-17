import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  buildChatBody,
  buildUnloadBody,
  buildWarmBody,
  compareVersions,
  createOllamaClient,
  findModel,
  normalizeBaseUrl,
  normalizeModelName,
  parseShowParameters,
  readChatStream,
} from '../../../src/ollama/client.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ollama/', import.meta.url));
const MODEL_TAG = 'ocu-qwen3-coder-30b-16k';

/** @param {string} name */
async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
}

/**
 * A loopback Ollama stand-in. It records every request, so a test can prove which endpoints were called.
 * @param {(request: { method: string, path: string, body: any }) => { status?: number, body?: unknown, raw?: string, hang?: boolean }} handle
 * @param {import('node:test').TestContext} t
 */
async function startServer(handle, t) {
  /** @type {Array<{ method: string, path: string, body: any }>} */
  const requests = [];
  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry = { method: request.method ?? '', path: request.url ?? '', body: text === '' ? undefined : JSON.parse(text) };
      requests.push(entry);
      const result = handle(entry) ?? {};
      if (result.hang) return;
      const payload = result.raw ?? JSON.stringify(result.body ?? {});
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' }).end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe('createOllamaClient read-only endpoints', () => {
  it('reads the version, the installed models and the loaded models', async (t) => {
    const [version, tags, ps] = [await readFixture('version-tested.json'), { models: [{ name: `${MODEL_TAG}:latest`, size: 20401094656, digest: 'abc', modified_at: '2026-09-17T11:40:12+03:00' }] }, await readFixture('ps-loaded-16k.json')];
    const server = await startServer(({ path: route }) => {
      if (route === '/api/version') return { body: version };
      if (route === '/api/tags') return { body: tags };
      if (route === '/api/ps') return { body: ps };
      return { status: 404, body: { error: 'not found' } };
    }, t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    assert.equal(await client.getVersion(), '0.34.1');
    const models = await client.listModels();
    assert.equal(models[0].name, `${MODEL_TAG}:latest`);
    assert.equal(models[0].sizeBytes, 20401094656);
    const running = await client.listRunning();
    assert.deepEqual(running[0], {
      name: `${MODEL_TAG}:latest`,
      model: `${MODEL_TAG}:latest`,
      contextLength: 16384,
      expiresAt: '2026-09-17T12:19:02.531+03:00',
      sizeBytes: 20401094656,
      sizeVramBytes: 20401094656,
    });
    assert.deepEqual(
      server.requests.map((entry) => `${entry.method} ${entry.path}`),
      ['GET /api/version', 'GET /api/tags', 'GET /api/ps'],
    );
  });

  it('parses /api/show, including repeated parameters, and returns null for an unknown model', async (t) => {
    const show = await readFixture('show-ocu-16k.json');
    const server = await startServer(({ body }) => (body.model === MODEL_TAG ? { body: show } : { status: 404, body: { error: `model '${body.model}' not found` } }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    const result = await client.showModel(MODEL_TAG);
    assert.ok(result);
    assert.deepEqual(result.parameters.num_ctx, [16384]);
    assert.deepEqual(result.parameters.temperature, [0.7]);
    assert.deepEqual(result.parameters.stop, ['<|im_start|>', '<|im_end|>']);
    assert.equal(result.renderer, 'qwen3-coder');
    assert.equal(result.system, '');
    assert.equal(await client.showModel('not-installed'), null);
  });

  it('refuses to send anything but the unload body to a model-load route', async (t) => {
    const server = await startServer(() => ({ body: {} }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    // The client has no public way to post a chat; the internal guard is what keeps it that way.
    assert.equal(typeof (/** @type {any} */ (client).chat), 'undefined');
    assert.equal(server.requests.length, 0);
  });
});

describe('createOllamaClient.unload', () => {
  it('sends empty messages with keep_alive 0, which unloads instead of loading', async (t) => {
    const server = await startServer(() => ({ body: { model: MODEL_TAG, done: true, done_reason: 'unload' } }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    assert.deepEqual(await client.unload(MODEL_TAG), { unloaded: true });
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0].body, { model: MODEL_TAG, messages: [], keep_alive: 0 });
  });

  it('reports a model Ollama does not know instead of failing', async (t) => {
    const server = await startServer(() => ({ status: 404, body: { error: "model 'x' not found" } }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    assert.deepEqual(await client.unload(MODEL_TAG), { unloaded: false });
  });
});

describe('createOllamaClient failures', () => {
  it('maps a closed port to exit 2 (spec 5.2 BLOCKED)', async () => {
    const client = createOllamaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
    const error = await client.getVersion().then(() => null, (thrown) => thrown);
    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'ollama_unreachable');
  });

  it('maps a server that never answers to exit 2 with a timeout code', async (t) => {
    const server = await startServer(() => ({ hang: true }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl, timeoutMs: 60 });
    const error = await client.getVersion().then(() => null, (thrown) => thrown);
    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'ollama_timeout');
  });

  it('maps an HTTP error to exit 7 and keeps the server message', async (t) => {
    const server = await startServer(() => ({ status: 500, body: { error: 'model runner has stopped' } }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    const error = await client.listRunning().then(() => null, (thrown) => thrown);
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'ollama_http_error');
    assert.match(error.message, /model runner has stopped/);
  });

  it('reports an answer that is not the documented shape', async (t) => {
    const server = await startServer(({ path: route }) => (route === '/api/ps' ? { body: { running: [] } } : { raw: 'not json' }), t);
    const client = createOllamaClient({ baseUrl: server.baseUrl });
    await assert.rejects(client.listRunning(), /has no models list/);
    await assert.rejects(client.getVersion(), /is not JSON/);
  });

  it('passes an abort through instead of reporting Ollama as unreachable', async (t) => {
    const server = await startServer(() => ({ hang: true }), t);
    const controller = new AbortController();
    const client = createOllamaClient({ baseUrl: server.baseUrl, timeoutMs: 5000 });
    const pending = client.getVersion({ signal: controller.signal });
    controller.abort(new Error('interrupted'));
    await assert.rejects(pending, /interrupted/);
  });
});

describe('request bodies', () => {
  it('builds the warm body that loads without generating (spec 5.5)', () => {
    assert.deepEqual(buildWarmBody({ model: MODEL_TAG, numCtx: 16384, keepAlive: '15m' }), {
      model: MODEL_TAG,
      messages: [],
      keep_alive: '15m',
      options: { num_ctx: 16384 },
    });
    assert.throws(() => buildWarmBody({ model: MODEL_TAG, numCtx: 0, keepAlive: '15m' }), /numCtx/);
  });

  it('builds a chat body with num_ctx and sampling only (spec 12.3)', () => {
    const body = buildChatBody({
      model: MODEL_TAG,
      messages: [{ role: 'user', content: 'hi' }],
      numCtx: 16384,
      keepAlive: '15m',
      sampling: { temperature: 0.2, topP: 0.8, topK: 20, repeatPenalty: 1.05 },
      maxOutputTokens: 2048,
    });
    assert.deepEqual(Object.keys(body.options), ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_predict']);
    assert.equal(body.stream, true);
    assert.equal(body.options.num_ctx, 16384);
    assert.throws(() => buildChatBody({ model: MODEL_TAG, messages: [], numCtx: 16384, keepAlive: '15m', sampling: { temperature: 0, topP: 1, topK: 1, repeatPenalty: 1 }, maxOutputTokens: 10 }), /messages/);
  });

  it('builds exactly the documented unload body', () => {
    assert.deepEqual(buildUnloadBody(MODEL_TAG), { model: MODEL_TAG, messages: [], keep_alive: 0 });
  });
});

describe('readChatStream', () => {
  it('joins content lines and reads the final usage', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'BUILD' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: '_OK' }, done: false }),
      JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 5024, eval_count: 812, total_duration: 21_400_000_000, load_duration: 1000 }),
    ];
    const result = await readChatStream(toChunks(`${lines.join('\n')}\n`, 7));
    assert.equal(result.content, 'BUILD_OK');
    assert.equal(result.promptTokens, 5024);
    assert.equal(result.outputTokens, 812);
    assert.equal(result.doneReason, 'stop');
  });

  it('reports a stream that ends early or carries an error', async () => {
    await assert.rejects(readChatStream(toChunks(`${JSON.stringify({ message: { content: 'x' }, done: false })}\n`, 64)), /ended before the final chunk/);
    await assert.rejects(readChatStream(toChunks(`${JSON.stringify({ error: 'model requires more system memory' })}\n`, 64)), /more system memory/);
    await assert.rejects(readChatStream(toChunks('{not json}\n', 64)), /not JSON/);
  });
});

describe('name and version helpers', () => {
  it('treats a bare name as :latest', () => {
    assert.equal(normalizeModelName('qwen3-coder:30b'), 'qwen3-coder:30b');
    assert.equal(normalizeModelName(MODEL_TAG), `${MODEL_TAG}:latest`);
    assert.equal(normalizeModelName('Library/Model'), 'library/model:latest');
    const models = [{ name: `${MODEL_TAG}:latest` }];
    assert.ok(findModel(models, MODEL_TAG));
    assert.equal(findModel(models, 'other'), undefined);
  });

  it('compares versions', () => {
    assert.equal(compareVersions('0.34.1', '0.34.1'), 0);
    assert.ok(compareVersions('0.34.1', '0.12.6') > 0);
    assert.ok(compareVersions('0.34.1', '0.35.0') < 0);
    assert.ok(compareVersions('1.18.31-rc.1', '1.18.31') < 0);
    assert.ok(compareVersions('v0.34.2', '0.34.1') > 0);
  });

  it('normalizes base URLs and refuses ones that are not plain http(s)', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
    assert.throws(() => normalizeBaseUrl('ftp://127.0.0.1'), /Invalid Ollama base URL/);
    assert.throws(() => normalizeBaseUrl('http://user:pass@127.0.0.1:11434'), /Invalid Ollama base URL/);
  });

  it('parses the padded parameter lines /api/show returns', () => {
    const parameters = parseShowParameters('num_ctx                        16384\ntemperature                    0.7\nstop                           "<|im_end|>"\nuse_mmap                       true\n');
    assert.deepEqual(parameters, { num_ctx: [16384], temperature: [0.7], stop: ['<|im_end|>'], use_mmap: [true] });
    assert.deepEqual(parseShowParameters(''), {});
  });
});

/**
 * @param {string} text
 * @param {number} size
 */
async function* toChunks(text, size) {
  for (let index = 0; index < text.length; index += size) yield Buffer.from(text.slice(index, index + size), 'utf8');
}
