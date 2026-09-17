// Loaded models from Ollama's GET /api/ps (spec section 7.2; OL api/types.go L867-876). Read-only:
// this endpoint never loads a model. Unreadable answers are errors, and the guard blocks on them.

/**
 * @typedef {object} LoadedModelEntry
 * @property {string} name
 * @property {string} model
 * @property {number | null} contextLength
 * @property {string | null} expiresAt       RFC 3339 text as Ollama sent it.
 * @property {number | null} sizeVramBytes
 */

/**
 * @typedef {{ ok: true, models: LoadedModelEntry[] } | { ok: false, error: string }} OllamaPsReading
 */

/**
 * @typedef {object} OllamaBaseUrl
 * @property {string} base      Origin plus path, without a trailing slash or `/v1`.
 * @property {string} hostname  As `URL.hostname` reports it (IPv6 in brackets).
 */

/**
 * Normalizes an Ollama base URL: no trailing slash and no OpenAI-compatible `/v1` suffix, so the
 * provider baseURL from the runtime profile can be passed as is.
 * @param {unknown} value
 * @returns {OllamaBaseUrl | null}  Null when the value is not a plain http(s) URL.
 */
export function parseOllamaBaseUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  return { base: `${url.origin}${path}`, hostname: url.hostname };
}

/**
 * True for hosts that can only mean this computer: `localhost`, 127.0.0.0/8 and `::1`. A bind-all
 * address such as 0.0.0.0 is not accepted, because the guard cannot tell where it leads.
 * @param {string} hostname  `URL.hostname` (IPv6 in brackets).
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Validates an /api/ps body.
 * @param {unknown} body
 * @returns {OllamaPsReading}
 */
export function parseOllamaPs(body) {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    return { ok: false, error: '/api/ps answer has no models list' };
  }
  /** @type {LoadedModelEntry[]} */
  const models = [];
  for (const entry of body.models) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      return { ok: false, error: '/api/ps lists a model without a name' };
    }
    models.push({
      name: entry.name,
      model: typeof entry.model === 'string' ? entry.model : entry.name,
      contextLength: Number.isSafeInteger(entry.context_length) ? /** @type {number} */ (entry.context_length) : null,
      expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : null,
      sizeVramBytes: typeof entry.size_vram === 'number' && Number.isFinite(entry.size_vram) ? entry.size_vram : null,
    });
  }
  return { ok: true, models };
}

/**
 * @typedef {object} OllamaPsOptions
 * @property {number} timeoutMs
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 */

/**
 * Requests /api/ps. Never throws.
 * @param {string} baseUrl
 * @param {OllamaPsOptions} options
 * @returns {Promise<OllamaPsReading>}
 */
export async function readOllamaPs(baseUrl, { timeoutMs, fetchImpl = fetch, signal }) {
  const base = parseOllamaBaseUrl(baseUrl);
  if (!base) return { ok: false, error: 'the Ollama base URL is not a plain http(s) URL' };
  const url = `${base.base}/api/ps`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(onAbort, timeoutMs);
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) return { ok: false, error: `GET /api/ps answered HTTP status ${response.status}` };
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'GET /api/ps did not answer with JSON' };
    }
    return parseOllamaPs(body);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      return { ok: false, error: `GET /api/ps gave no answer within ${Math.round(timeoutMs / 100) / 10} s` };
    }
    if (signal?.aborted) return { ok: false, error: 'GET /api/ps was aborted' };
    return { ok: false, error: `GET /api/ps failed (${describeFetchError(error)})` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeFetchError(error) {
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
  if (cause && typeof cause.code === 'string') return cause.code;
  return error instanceof Error ? error.message : String(error);
}
