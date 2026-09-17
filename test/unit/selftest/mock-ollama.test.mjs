import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatShowParameters,
  MOCK_OLLAMA_VERSION,
  NATIVE_LOAD_PATHS,
  normalizeModelName,
  startMockOllama,
} from '../../../src/selftest/mock-ollama.js';

const MODEL = 'ocu-qwen3-coder-30b-16k';

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../../../src/selftest/mock-ollama.js').MockOllamaOptions} [options]
 */
async function serve(t, options) {
  const started = await startMockOllama(options);
  t.after(() => started.close());
  return started;
}

/**
 * @param {string} url
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [method]
 */
function call(url, path, body, method = 'POST') {
  return fetch(`${url}${path}`, {
    method: body === undefined && method === 'POST' ? 'GET' : method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('mock Ollama: version, tags and show follow the 0.34.1 shapes', async (t) => {
  const { url } = await serve(t, {
    models: [{ name: MODEL, parameters: { num_ctx: 16384, temperature: 0.7, stop: ['<|im_end|>'] }, renderer: 'qwen3-coder', parser: 'qwen3-coder' }],
  });

  assert.deepEqual(await (await fetch(`${url}/api/version`)).json(), { version: MOCK_OLLAMA_VERSION });

  const tags = await (await fetch(`${url}/api/tags`)).json();
  assert.deepEqual(tags.models.map((entry) => entry.name), [`${MODEL}:latest`]);
  assert.equal(tags.models[0].details.quantization_level, 'Q4_K_M');

  const show = await (await call(url, '/api/show', { model: MODEL })).json();
  assert.equal(show.renderer, 'qwen3-coder');
  assert.equal(show.parser, 'qwen3-coder');
  assert.match(show.parameters, /^num_ctx {24}16384$/m, 'Ollama pads parameter names to 30 columns');
  assert.match(show.parameters, /^stop {27}"<\|im_end\|>"$/m);
  assert.equal(show.system, undefined, 'a Modelfile without SYSTEM shows none');

  assert.equal((await call(url, '/api/show', { model: 'missing' })).status, 404);
});

test('mock Ollama: /api/ps reports the loaded model with context_length, size_vram and expires_at', async (t) => {
  const now = () => Date.parse('2026-01-01T00:00:00.000Z');
  const { url, mock } = await serve(t, {
    now,
    models: [MODEL, 'other-model'],
    running: [
      { name: MODEL, contextLength: 16384, sizeVramMiB: 19000, keepAliveSec: 900 },
      { name: 'other-model', contextLength: 4096, keepAliveSec: 60 },
    ],
  });

  const { models } = await (await fetch(`${url}/api/ps`)).json();

  assert.deepEqual(models.map((entry) => entry.name), [`${MODEL}:latest`, 'other-model:latest'], 'the longest keep-alive is listed first');
  assert.equal(models[0].context_length, 16384);
  assert.equal(models[0].size_vram, 19000 * 1024 * 1024);
  assert.equal(models[0].expires_at, '2026-01-01T00:15:00.000Z');

  mock.unloadModel(MODEL);
  assert.deepEqual((await (await fetch(`${url}/api/ps`)).json()).models.map((entry) => entry.name), ['other-model:latest']);

  mock.loadModel(MODEL, { contextLength: 32768 });
  assert.equal((await (await fetch(`${url}/api/ps`)).json()).models.find((entry) => entry.name === `${MODEL}:latest`).context_length, 32768);
});

test('mock Ollama: empty messages load, keep_alive 0 unloads, and both are recorded as load paths', async (t) => {
  const { url, mock } = await serve(t, { models: [{ name: MODEL, parameters: { num_ctx: 16384 } }] });

  const warm = await (await call(url, '/api/chat', { model: MODEL, messages: [], options: { num_ctx: 16384 } })).json();
  assert.equal(warm.done_reason, 'load');
  assert.equal((await (await fetch(`${url}/api/ps`)).json()).models[0].context_length, 16384);

  const stop = await (await call(url, '/api/chat', { model: MODEL, messages: [], keep_alive: 0 })).json();
  assert.equal(stop.done_reason, 'unload');
  assert.deepEqual((await (await fetch(`${url}/api/ps`)).json()).models, []);

  assert.deepEqual(mock.loadRequests.map((request) => request.path), ['/api/chat', '/api/chat']);
  assert.deepEqual(NATIVE_LOAD_PATHS, ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);
});

test('mock Ollama: chat streams NDJSON across partial writes and ends with a final line', async (t) => {
  const { url, mock } = await serve(t, { models: [MODEL] });
  mock.enqueueChat({ content: 'hello from the mock', promptTokens: 8194, outputTokens: 12 });

  const answer = await call(url, '/api/chat', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
  const lines = (await answer.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(answer.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(lines.filter((line) => !line.done).map((line) => line.message.content).join(''), 'hello from the mock');
  const final = lines.at(-1);
  assert.equal(final.done, true);
  assert.equal(final.done_reason, 'stop');
  assert.equal(final.prompt_eval_count, 8194);
  assert.equal(final.eval_count, 12);
  assert.equal(mock.chatRequests.length, 1);
});

test('mock Ollama: a scripted chat reply can fail, break the stream or omit the final line', async (t) => {
  const { url, mock } = await serve(t, { models: [MODEL] });
  mock.enqueueChat(
    { httpStatus: 500, httpBody: { error: 'mock failure' } },
    { content: 'partial', omitFinal: true, malformed: true },
    (body, index) => ({ content: `${body.messages.length}:${index}` }),
  );

  const ask = () => call(url, '/api/chat', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await ask()).status, 500);
  const broken = (await (await ask()).text()).split('\n').filter(Boolean);
  assert.ok(broken.some((line) => line === '{not json}'));
  assert.ok(!broken.some((line) => line.includes('"done":true')));
  const scripted = (await (await ask()).text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(scripted.filter((line) => !line.done).map((line) => line.message.content).join(''), '1:2');
});

test('mock Ollama: a route override answers a planned sequence and then falls back', async (t) => {
  const { url, mock } = await serve(t, { models: [MODEL] });

  mock.overrideRoute('/api/ps', [{ status: 500, body: { error: 'boom' } }, { status: 200, body: 'not json at all' }]);
  assert.equal((await fetch(`${url}/api/ps`)).status, 500);
  const text = await (await fetch(`${url}/api/ps`));
  assert.equal(await text.text(), 'not json at all');
  assert.equal((await fetch(`${url}/api/ps`)).status, 200, 'the last planned answer repeats');

  mock.overrideRoute('/api/ps', null);
  assert.deepEqual((await (await fetch(`${url}/api/ps`)).json()).models, []);
});

test('mock Ollama: pull and create register a model, delete removes it, unknown paths are 404', async (t) => {
  const { url, mock } = await serve(t);

  const pull = await call(url, '/api/pull', { model: MODEL, stream: false });
  assert.deepEqual(await pull.json(), { status: 'success' });

  await call(url, '/api/create', { model: 'ocu-derived', from: MODEL, parameters: { num_ctx: 16384 }, renderer: 'qwen3-coder' });
  assert.equal(mock.getNumCtx('ocu-derived'), 16384);

  assert.equal((await call(url, '/api/delete', { model: 'ocu-derived' }, 'DELETE')).status, 200);
  assert.equal((await call(url, '/api/delete', { model: 'ocu-derived' }, 'DELETE')).status, 404);
  assert.equal((await fetch(`${url}/api/unknown`)).status, 404);
});

test('mock Ollama: helpers normalize model names and format show parameters', () => {
  assert.equal(normalizeModelName('qwen3-coder'), 'qwen3-coder:latest');
  assert.equal(normalizeModelName('library/qwen3-coder:30b'), 'library/qwen3-coder:30b');
  assert.equal(formatShowParameters({ num_ctx: 16384, stop: ['a', 'b'] }), `num_ctx${' '.repeat(23)} 16384\nstop${' '.repeat(26)} "a"\nstop${' '.repeat(26)} "b"`);
});
