// Builders for the guarded chat tests: a valid runtime profile and guard probes that answer without a
// GPU, Unity or a real Ollama. The probes are always stubs, because the shipped process probe answers
// "not implemented" off Windows, and a test whose verdict depends on the host is not a test.
import os from 'node:os';
import path from 'node:path';

import { GUARD_DEFAULTS } from '../../../plugin/opencode-unity-lib/guard/config.js';
import { validateRuntimeProfile } from '../../../plugin/opencode-unity-lib/runtime-profile.js';
import { catchAsync } from '../../helpers/catch-error.mjs';

export const MODEL_TAG = 'ocu-test-16k';
export const NUM_CTX = 16384;
export const NOW_MS = Date.parse('2026-09-17T12:00:00.000Z');

/**
 * @param {{ baseUrl: string, home?: string, numCtx?: number, output?: number, keepAlive?: string, guard?: Record<string, unknown>, budget?: Record<string, unknown> }} options
 * @returns {import('../../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile}
 */
export function makeProfile({ baseUrl, home = path.join(os.tmpdir(), 'opencode-unity-tests', 'guarded-chat-home'), numCtx = NUM_CTX, output = 4096, keepAlive = '15m', guard = {}, budget = {} }) {
  const profile = {
    schemaVersion: 1,
    cliVersion: '0.1.0',
    presetId: 'test-preset',
    presetStatus: /** @type {const} */ ('experimental'),
    custom: false,
    overriddenPaths: [],
    provider: {
      id: 'opencode-unity',
      npm: '@ai-sdk/openai-compatible',
      name: 'Local model (opencode-unity)',
      baseURL: `${baseUrl}/v1`,
      modelTag: MODEL_TAG,
      numCtx,
      limit: { context: numCtx, output },
      sampling: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.05 },
      numKeep: 4,
      keepAlive,
    },
    ollama: { baseUrl },
    guard: { ...GUARD_DEFAULTS, assetImportProcessPatterns: [...GUARD_DEFAULTS.assetImportProcessPatterns], modelVramMiB: 19000, kvType: 'q8_0', kvTypeSource: 'server-log', ...guard },
    budget: {
      promptBudget: numCtx - output - 512,
      toolsTokens: { 'unity-code': 3400, 'unity-editor': 3000 },
      toolsTokensSource: 'default-allowance',
      reserveTokens: 512,
      charsPerToken: 3.5,
      safetyMargin: 0.1,
      calibrationClamp: [0.7, 1.4],
      prefixTargetTokens: { 'unity-code': 5000, 'unity-editor': 7000 },
      prefixFailTokens: { 'unity-code': 6000, 'unity-editor': 8000 },
      ...budget,
    },
    safety: { bashMode: /** @type {const} */ ('allowlist'), readLimitLines: 200, extraProtectedEditGlobs: [], extraProtectedReadGlobs: [] },
    home,
    compat: { opencode: '1.18.31', ollama: '0.34.1' },
  };
  const problems = validateRuntimeProfile(profile);
  if (problems.length > 0) throw new Error(`the test profile is invalid: ${problems.join('; ')}`);
  return profile;
}

/**
 * Probes whose default answer is the loaded fast path: our model at our context, with time left and no
 * Unity running. Each test overrides only the probe it is about.
 * @param {Partial<import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes> & { loadedMiB?: number, freeMiB?: number, utilPercent?: number, loaded?: boolean }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes}
 */
export function makeProbes({ loadedMiB = 18500, freeMiB = 22000, utilPercent = 2, loaded = true, ...overrides } = {}) {
  const entry = {
    name: `${MODEL_TAG}:latest`,
    model: `${MODEL_TAG}:latest`,
    contextLength: NUM_CTX,
    expiresAt: new Date(NOW_MS + 1800 * 1000).toISOString(),
    sizeVramBytes: loadedMiB * 1048576,
  };
  return {
    readOllamaPs: async () => ({ ok: true, models: loaded ? [entry] : [] }),
    readNvidiaSmi: async () => ({ ok: true, gpuCount: 1, memory: { ok: true, totalMiB: 24576, freeMiB }, utilization: { ok: true, percent: utilPercent } }),
    processes: {
      platform: 'test',
      detect: async () => ({ ok: true, running: false, count: 0 }),
      sample: async () => ({ ok: false, error: 'no Unity process in this test' }),
    },
    sleep: async () => {},
    now: () => NOW_MS,
    ...overrides,
  };
}

// Re-exported so the guarded-chat suites keep importing everything they need from one fixture module.
export { catchAsync };
