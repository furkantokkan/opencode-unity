import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoadedModelState, startMockBackend } from '../../../src/selftest/mock-backend.js';
import { foldChunks, postChat, readSseEvents } from './sse.mjs';

const profile = { modelTag: 'ocu-qwen3-coder-30b-16k', numCtx: 16384 };

test('mock backend: one port answers /v1 and /api, as a local Ollama does', async (t) => {
  const backend = await startMockBackend({
    openai: { turns: [{ text: 'SELFTEST_DONE' }] },
    ollama: createLoadedModelState(profile),
  });
  t.after(() => backend.close());

  const running = await (await fetch(`${backend.url}/api/ps`)).json();
  assert.equal(running.models[0].name, `${profile.modelTag}:latest`);
  assert.equal(running.models[0].context_length, 16384);
  assert.ok(Date.parse(running.models[0].expires_at) > Date.now(), 'the keep-alive reaches into the future');

  const turn = foldChunks((await readSseEvents(await postChat(backend.openAiBaseUrl, {
    model: profile.modelTag,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }))).events);
  assert.equal(turn.text, 'SELFTEST_DONE');

  assert.equal(backend.openai.chats.length, 1);
  assert.deepEqual(backend.ollama.loadRequests, [], 'nothing asked Ollama to load a model');
  assert.deepEqual(backend.server.requests.map((request) => `${request.method} ${request.path}`), [
    'GET /api/ps',
    'POST /v1/chat/completions',
  ]);
  assert.equal(backend.openAiBaseUrl, `${backend.url}/v1`);
});

test('mock backend: without the loaded state the guard would see a cold GPU', async (t) => {
  const backend = await startMockBackend();
  t.after(() => backend.close());

  assert.deepEqual((await (await fetch(`${backend.url}/api/ps`)).json()).models, []);
  assert.deepEqual(createLoadedModelState(profile), {
    models: [{ name: profile.modelTag, parameters: { num_ctx: 16384 } }],
    running: [{ name: profile.modelTag, contextLength: 16384, keepAliveSec: 3600 }],
  });
});
