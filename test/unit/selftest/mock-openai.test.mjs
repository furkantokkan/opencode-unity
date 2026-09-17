import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyChatRequest,
  COMPACTION_PROMPT_MARKER,
  createContextOverflowTurn,
  createServiceUnavailableTurn,
  createTextToolCallTurn,
  estimatePromptTokens,
  OPENAI_CHAT_PATH,
  startMockOpenAi,
  TITLE_PROMPT_PREFIX,
} from '../../../src/selftest/mock-openai.js';
import { foldChunks, postChat, readSseEvents } from './sse.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../../../src/selftest/mock-openai.js').MockOpenAiOptions} [options]
 */
async function serve(t, options) {
  const started = await startMockOpenAi(options);
  t.after(() => started.close());
  return started;
}

const userMessage = { role: 'user', content: 'hello' };
const streamBody = { model: 'mock-model', messages: [userMessage], stream: true };

test('mock OpenAI: streams role, text, a finish chunk and [DONE], and adds usage only when asked', async (t) => {
  const { mock, baseUrl } = await serve(t, { turns: [{ text: 'hello there' }] });

  const withoutUsage = await readSseEvents(await postChat(baseUrl, streamBody));
  const plain = foldChunks(withoutUsage.events);

  assert.equal(withoutUsage.done, true, 'the stream must end with [DONE]');
  assert.equal(plain.text, 'hello there');
  assert.equal(plain.roleCount, 1, 'only the first chunk carries the role');
  assert.equal(plain.finishReason, 'stop');
  assert.equal(plain.usage, null);
  for (const event of withoutUsage.events) {
    assert.equal(event.object, 'chat.completion.chunk');
    assert.equal(event.system_fingerprint, 'fp_ollama');
    assert.equal(event.model, 'mock-model');
  }
  // The finish chunk has an empty delta, as OpenAI and Ollama send it (OL `openai/openai.go` FinishChunk).
  assert.deepEqual(withoutUsage.events.at(-1).choices[0].delta, {});

  mock.setScript([{ text: 'again', usage: { promptTokens: 8194, completionTokens: 7, cachedTokens: 12 } }]);
  const withUsage = foldChunks((await readSseEvents(await postChat(baseUrl, { ...streamBody, stream_options: { include_usage: true } }))).events);

  assert.deepEqual(withUsage.usage, {
    prompt_tokens: 8194,
    completion_tokens: 7,
    total_tokens: 8201,
    prompt_tokens_details: { cached_tokens: 12 },
  });
});

test('mock OpenAI: streams tool calls whole or in pieces and finishes with tool_calls', async (t) => {
  const { mock, baseUrl } = await serve(t, {
    turns: [{ toolCalls: [{ name: 'read', arguments: { filePath: 'Assets/Player.cs' } }] }],
  });

  const folded = foldChunks((await readSseEvents(await postChat(baseUrl, streamBody))).events);

  assert.equal(folded.finishReason, 'tool_calls');
  assert.equal(folded.toolCalls.length, 1);
  assert.equal(folded.toolCalls[0].name, 'read');
  assert.deepEqual(JSON.parse(folded.toolCalls[0].arguments), { filePath: 'Assets/Player.cs' });

  mock.setScript([{ toolCalls: [{ name: 'edit', arguments: { filePath: 'Assets/Player.cs', oldString: 'a', newString: 'b' } }], splitArguments: true }]);
  const split = await readSseEvents(await postChat(baseUrl, streamBody));
  const foldedSplit = foldChunks(split.events);

  assert.ok(split.events.filter((event) => event.choices[0]?.delta?.tool_calls).length > 1, 'arguments arrive in pieces');
  assert.deepEqual(JSON.parse(foldedSplit.arguments ?? foldedSplit.toolCalls[0].arguments), { filePath: 'Assets/Player.cs', oldString: 'a', newString: 'b' });
});

test('mock OpenAI: answers without streaming when the request does not ask for it', async (t) => {
  const { baseUrl } = await serve(t, { turns: [{ text: 'done', reasoning: 'thinking' }] });

  const answer = await (await postChat(baseUrl, { model: 'mock-model', messages: [userMessage] })).json();

  assert.equal(answer.object, 'chat.completion');
  assert.equal(answer.choices[0].message.content, 'done');
  assert.equal(answer.choices[0].message.reasoning, 'thinking');
  assert.equal(answer.choices[0].finish_reason, 'stop');
  assert.ok(answer.usage.prompt_tokens > 0);
});

test('mock OpenAI: serves 503 with Retry-After and 413 with context_length_exceeded', async (t) => {
  const { baseUrl } = await serve(t, {
    turns: [createServiceUnavailableTurn({ retryAfterSec: 30 }), createContextOverflowTurn()],
  });

  const busy = await postChat(baseUrl, streamBody);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '30');
  assert.equal((await busy.json()).error.type, 'gpu_guard_blocked');

  const overflow = await postChat(baseUrl, streamBody);
  assert.equal(overflow.status, 413);
  const body = await overflow.json();
  assert.equal(body.error.code, 'context_length_exceeded');
  assert.equal(body.error.param, null, 'Ollama sends param and code on every /v1 error (OL openai.go Error)');
});

test('mock OpenAI: records requests, classifies them and keeps the script position', async (t) => {
  const { mock, baseUrl } = await serve(t, { turns: [{ text: 'first' }, { text: 'second' }], defaultTurn: { text: 'fallback' } });

  await postChat(baseUrl, streamBody);
  await postChat(baseUrl, { ...streamBody, messages: [{ role: 'user', content: `${TITLE_PROMPT_PREFIX}\n` }] });
  await postChat(baseUrl, { ...streamBody, messages: [{ role: 'user', content: `${COMPACTION_PROMPT_MARKER} history` }] });
  await postChat(baseUrl, streamBody);
  await postChat(baseUrl, streamBody);

  assert.deepEqual(mock.chats.map((chat) => chat.kind), ['chat', 'title', 'compaction', 'chat', 'chat']);
  assert.equal(mock.servedTurns, 2, 'title and compaction requests do not consume the script');
  assert.equal(mock.remainingTurns, 0);
  assert.deepEqual(mock.chats.map((chat) => chat.turnIndex), [0, null, null, 1, null]);
  assert.equal(mock.getChatBodies('chat').length, 3);
  assert.equal(mock.requests.length, 5);
  assert.equal(mock.chats[0].request.path, OPENAI_CHAT_PATH);
});

test('mock OpenAI: a turn can be a function of the request, and enqueue extends the script', async (t) => {
  const seen = [];
  const { mock, baseUrl } = await serve(t, {
    turns: [(body, context) => ({ text: `${context.kind}:${body.messages.length}:${context.index}` })],
    onChat: (body) => seen.push(body.model),
  });
  mock.enqueue({ text: 'second' });

  const first = foldChunks((await readSseEvents(await postChat(baseUrl, streamBody))).events);
  const second = foldChunks((await readSseEvents(await postChat(baseUrl, streamBody))).events);

  assert.equal(first.text, 'chat:1:0');
  assert.equal(second.text, 'second');
  assert.deepEqual(seen, ['mock-model', 'mock-model']);
});

test('mock OpenAI: models are listed and every other /v1 path is a 404', async (t) => {
  const { url, baseUrl } = await serve(t, { models: ['ocu-qwen3-coder-30b-16k'] });

  const models = await (await fetch(`${baseUrl}/models`)).json();
  assert.deepEqual(models.data.map((entry) => entry.id), ['ocu-qwen3-coder-30b-16k']);

  const missing = await fetch(`${url}/v1/embeddings`, { method: 'POST', body: '{}' });
  assert.equal(missing.status, 404);

  const invalid = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(invalid.status, 400);
});

test('mock OpenAI: a hanging or dropped turn leaves the stream unfinished', async (t) => {
  const { mock, baseUrl, server } = await serve(t, { turns: [{ text: 'partial', dropConnection: true }] });

  await assert.rejects(() => postChat(baseUrl, streamBody).then((response) => response.text()));

  mock.setScript([{ text: 'hangs', hang: true }]);
  const controller = new AbortController();
  const hanging = fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(streamBody),
    signal: controller.signal,
  }).then((response) => response.text());
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(() => hanging);
  await server.waitFor((requests) => requests.at(-1)?.aborted === true, { timeoutMs: 1000 });
  assert.equal(mock.chats.at(-1).request.aborted, true);
});

test('mock OpenAI: helpers for classification, estimation and text-form tool calls', () => {
  assert.equal(classifyChatRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `${TITLE_PROMPT_PREFIX}\n` }] }] }), 'title');
  assert.equal(classifyChatRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{ function: { name: 'read' } }] }), 'chat');
  assert.equal(classifyChatRequest({ messages: [{ role: 'user', content: `${COMPACTION_PROMPT_MARKER}` }], tools: [] }), 'compaction');

  // 350 characters of text plus the two characters of an empty tools array, at 3.5 characters per token.
  const small = estimatePromptTokens({ messages: [{ role: 'user', content: 'a'.repeat(350) }] });
  assert.equal(small, 101);
  assert.ok(estimatePromptTokens({ messages: [{ role: 'user', content: 'a'.repeat(350) }], tools: [{ function: { name: 'read' } }] }) > small);

  const plain = createTextToolCallTurn('read', { filePath: 'Assets/Player.cs' });
  assert.match(plain.text, /^<function=read>/);
  assert.doesNotMatch(plain.text, /<tool_call>/);
  assert.match(createTextToolCallTurn('read', {}, { withToolCallTag: true }).text, /<tool_call>/);
});
