// Minimal SSE reader for the mock-endpoint tests: it parses `data:` lines the way an OpenAI-compatible
// client does and folds the chunks back into one assistant turn.

/**
 * @param {Response} response
 * @returns {Promise<{ events: any[], done: boolean, raw: string }>}
 */
export async function readSseEvents(response) {
  const raw = await response.text();
  const events = [];
  let done = false;
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((part) => part.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    events.push(JSON.parse(payload));
  }
  return { events, done, raw };
}

/**
 * @param {any[]} events
 */
export function foldChunks(events) {
  let text = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let roleCount = 0;
  /** @type {Map<number, { id: string, name: string, arguments: string }>} */
  const toolCalls = new Map();
  for (const event of events) {
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.role) roleCount += 1;
    if (typeof delta.content === 'string') text += delta.content;
    if (delta.reasoning) reasoning += delta.reasoning;
    for (const call of delta.tool_calls ?? []) {
      const existing = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' };
      toolCalls.set(call.index, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        arguments: existing.arguments + (call.function?.arguments ?? ''),
      });
    }
  }
  return { text, reasoning, finishReason, usage, roleCount, toolCalls: [...toolCalls.values()] };
}

/**
 * @param {string} baseUrl  For example `http://127.0.0.1:1234/v1`.
 * @param {Record<string, unknown>} body
 * @returns {Promise<Response>}
 */
export function postChat(baseUrl, body) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
