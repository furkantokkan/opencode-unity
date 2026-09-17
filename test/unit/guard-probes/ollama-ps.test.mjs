// Reading loaded models from /api/ps, and deciding whether the server is on this computer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackHost, parseOllamaBaseUrl, parseOllamaPs, readOllamaPs } from '../../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js';

const PS_BODY = {
  models: [
    {
      name: 'ocu-model-16k:latest',
      model: 'ocu-model-16k:latest',
      size: 20401094656,
      size_vram: 19398950912,
      expires_at: '2026-09-17T12:30:00.000Z',
      context_length: 16384,
      digest: 'sha256:0000',
    },
  ],
};

/**
 * @param {{ status?: number, body?: unknown, json?: () => Promise<unknown>, fail?: Error, delayMs?: number }} answer
 */
function fakeFetch(answer, calls = []) {
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (answer.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, answer.delayMs);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (answer.fail) throw answer.fail;
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: answer.json ?? (async () => answer.body ?? PS_BODY),
      };
    },
  };
}

describe('Ollama base URL', () => {
  it('normalizes the provider URL, with or without /v1', () => {
    assert.deepEqual(parseOllamaBaseUrl('http://127.0.0.1:11434'), { base: 'http://127.0.0.1:11434', hostname: '127.0.0.1' });
    assert.deepEqual(parseOllamaBaseUrl('http://127.0.0.1:11434/'), { base: 'http://127.0.0.1:11434', hostname: '127.0.0.1' });
    assert.deepEqual(parseOllamaBaseUrl('http://127.0.0.1:11434/v1'), { base: 'http://127.0.0.1:11434', hostname: '127.0.0.1' });
    assert.deepEqual(parseOllamaBaseUrl('  http://localhost:11434/v1/  '), { base: 'http://localhost:11434', hostname: 'localhost' });
    assert.equal(parseOllamaBaseUrl('http://127.0.0.1:11434/ollama/v1')?.base, 'http://127.0.0.1:11434/ollama');
  });

  it('refuses anything that is not a plain http(s) URL', () => {
    for (const value of ['', '127.0.0.1:11434', 'ftp://127.0.0.1', 'http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434/?debug=1', 'http://127.0.0.1:11434/#x', 42, null]) {
      assert.equal(parseOllamaBaseUrl(value), null, `expected ${String(value)} to be refused`);
    }
  });

  it('knows which hosts can only mean this computer', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ['0.0.0.0', '192.168.1.10', 'gpu-box.invalid', '[::ffff:7f00:1]', '127.0.0.256']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe('/api/ps answers', () => {
  it('reads name, context, expiry and video memory', () => {
    const reading = parseOllamaPs(PS_BODY);
    assert.equal(reading.ok, true);
    assert.deepEqual(reading.models[0], {
      name: 'ocu-model-16k:latest',
      model: 'ocu-model-16k:latest',
      contextLength: 16384,
      expiresAt: '2026-09-17T12:30:00.000Z',
      sizeVramBytes: 19398950912,
    });
  });

  it('keeps missing fields as null instead of guessing', () => {
    const reading = parseOllamaPs({ models: [{ name: 'other-model' }] });
    assert.deepEqual(reading.models[0], { name: 'other-model', model: 'other-model', contextLength: null, expiresAt: null, sizeVramBytes: null });
  });

  it('refuses an answer that is not a model list', () => {
    assert.match(parseOllamaPs({}).error, /no models list/);
    assert.match(parseOllamaPs(null).error, /no models list/);
    assert.match(parseOllamaPs({ models: [{ size: 1 }] }).error, /without a name/);
  });
});

describe('readOllamaPs', () => {
  it('asks for /api/ps on the normalized base URL', async () => {
    const fake = fakeFetch({});
    const reading = await readOllamaPs('http://127.0.0.1:11434/v1', { timeoutMs: 3000, fetchImpl: fake.fetchImpl });
    assert.equal(reading.ok, true);
    assert.equal(fake.calls[0].url, 'http://127.0.0.1:11434/api/ps');
    assert.equal(fake.calls[0].options.redirect, 'error');
  });

  it('refuses a base URL it cannot parse without asking anything', async () => {
    const fake = fakeFetch({});
    const reading = await readOllamaPs('not a url', { timeoutMs: 3000, fetchImpl: fake.fetchImpl });
    assert.equal(reading.ok, false);
    assert.equal(fake.calls.length, 0);
  });

  it('reports an HTTP error status', async () => {
    const reading = await readOllamaPs('http://127.0.0.1:11434', { timeoutMs: 3000, fetchImpl: fakeFetch({ status: 404 }).fetchImpl });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /HTTP status 404/);
  });

  it('reports an answer that is not JSON', async () => {
    const fetchImpl = fakeFetch({
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }).fetchImpl;
    const reading = await readOllamaPs('http://127.0.0.1:11434', { timeoutMs: 3000, fetchImpl });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /did not answer with JSON/);
  });

  it('reports a server that does not answer in time', async () => {
    const reading = await readOllamaPs('http://127.0.0.1:11434', { timeoutMs: 20, fetchImpl: fakeFetch({ delayMs: 5000 }).fetchImpl });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /gave no answer within 0 s|gave no answer within/);
  });

  it('reports a refused connection with its code', async () => {
    const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const reading = await readOllamaPs('http://127.0.0.1:11434', { timeoutMs: 3000, fetchImpl: fakeFetch({ fail: failure }).fetchImpl });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /ECONNREFUSED/);
  });

  it('answers when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = readOllamaPs('http://127.0.0.1:11434', { timeoutMs: 3000, fetchImpl: fakeFetch({ delayMs: 5000 }).fetchImpl, signal: controller.signal });
    controller.abort();
    const reading = await pending;
    assert.equal(reading.ok, false);
    assert.match(reading.error, /aborted/);
  });
});
