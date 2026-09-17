// One loopback server that answers like a local Ollama: the OpenAI-compatible `/v1` endpoint and the
// native `/api` endpoints on the same port. `doctor --capture` needs this so the guard sees the model
// as loaded while requests are recorded (spec 8.8); the self-test scenarios use it for every run.
import { createMockOllama } from './mock-ollama.js';
import { createMockOpenAi } from './mock-openai.js';
import { startMockServer } from './mock-server.js';

/**
 * @param {{ openai?: import('./mock-openai.js').MockOpenAiOptions, ollama?: import('./mock-ollama.js').MockOllamaOptions, port?: number }} [options]
 */
export async function startMockBackend({ openai, ollama, port } = {}) {
  const openAiMock = createMockOpenAi(openai);
  const ollamaMock = createMockOllama(ollama);
  const server = await startMockServer({ handlers: [openAiMock, ollamaMock], port });
  return {
    server,
    openai: openAiMock,
    ollama: ollamaMock,
    url: server.url,
    openAiBaseUrl: `${server.url}/v1`,
    close: server.close,
  };
}

/**
 * Ollama state in which `modelTag` is loaded at `numCtx` with a long keep-alive, so the guard takes
 * its loaded path.
 * @param {{ modelTag: string, numCtx: number }} profile
 * @returns {import('./mock-ollama.js').MockOllamaOptions}
 */
export function createLoadedModelState({ modelTag, numCtx }) {
  return {
    models: [{ name: modelTag, parameters: { num_ctx: numCtx } }],
    running: [{ name: modelTag, contextLength: numCtx, keepAliveSec: 3600 }],
  };
}
