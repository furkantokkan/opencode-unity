// VRAM estimate for a preset at its context size (spec 7.4). One formula, fed by preset numbers that were
// measured in Ollama load logs, so the guard, the banner and doctor all agree.

// Bytes per KV element relative to f16: q8_0 stores 34 bytes per 32 elements, q4_0 stores 18.
export const KV_CACHE_FACTORS = Object.freeze({ f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 });

// The guard rounds up to this step before adding the preset margin.
export const VRAM_ROUNDING_MIB = 500;

/** @typedef {keyof typeof KV_CACHE_FACTORS} KvCacheType */
/** @typedef {'server-log' | 'env' | 'default'} KvCacheTypeSource */

/**
 * @typedef {object} VramInputs
 * @property {number} weightsMiB
 * @property {number} computeMiB
 * @property {number} kvMiBPerTokenF16
 * @property {number} marginMiB
 */

/**
 * @typedef {object} VramEstimate
 * @property {number} kvMiB
 * @property {number} rawMiB
 * @property {number} modelVramMiB
 * @property {KvCacheType} kvType
 */

/**
 * @param {VramInputs} vram
 * @param {number} numCtx
 * @param {KvCacheType} kvType
 * @returns {VramEstimate}
 */
export function estimateModelVram(vram, numCtx, kvType) {
  const factor = KV_CACHE_FACTORS[kvType];
  if (factor === undefined) throw new TypeError(`Unknown KV cache type '${kvType}'`);
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0) throw new TypeError(`numCtx must be a positive integer, got ${numCtx}`);
  const kvMiB = vram.kvMiBPerTokenF16 * numCtx * factor;
  const rawMiB = vram.weightsMiB + kvMiB + vram.computeMiB;
  const modelVramMiB = Math.ceil(rawMiB / VRAM_ROUNDING_MIB) * VRAM_ROUNDING_MIB + vram.marginMiB;
  return { kvMiB, rawMiB, modelVramMiB, kvType };
}

/**
 * Accepts the spellings Ollama logs and environment variables use. Unknown values return null.
 * @param {unknown} value
 * @returns {KvCacheType | null}
 */
export function normalizeKvCacheType(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fp16') return 'f16';
  return Object.hasOwn(KV_CACHE_FACTORS, normalized) ? /** @type {KvCacheType} */ (normalized) : null;
}

/**
 * The server log shows what Ollama actually allocated, so it wins. Otherwise the user's
 * OLLAMA_KV_CACHE_TYPE is used, and when neither is known f16, the largest cache, is assumed.
 * @param {{ serverLogKvType?: string | null, env?: Record<string, string | undefined> }} inputs
 * @returns {{ kvType: KvCacheType, source: KvCacheTypeSource }}
 */
export function resolveKvCacheType({ serverLogKvType = null, env = {} }) {
  const fromLog = normalizeKvCacheType(serverLogKvType);
  if (fromLog) return { kvType: fromLog, source: 'server-log' };
  const fromEnv = normalizeKvCacheType(env.OLLAMA_KV_CACHE_TYPE);
  if (fromEnv) return { kvType: fromEnv, source: 'env' };
  return { kvType: 'f16', source: 'default' };
}

// GiB with one decimal, the unit guard messages use so no three-digit MiB value looks like a status
// code. The guard ships this formatter inside the profile, so there is one implementation per rule.
export { formatGiB } from '../../plugin/opencode-unity-lib/guard/messages.js';
