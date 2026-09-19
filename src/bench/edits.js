// Text-only native Ollama benchmark. It never applies model output to a file. Expected replacements
// are compared byte for byte, so a textual claim of success does not count as a successful edit.
import { guardedChat } from '../ollama/guarded-chat.js';

export const EDIT_CASES = Object.freeze([
  { id: 'constant', source: 'public const int MaxLives = 3;\n', instruction: 'Change MaxLives from 3 to 5. Keep every other character unchanged.', expected: 'public const int MaxLives = 5;\n' },
  { id: 'operator', source: 'return score > target;\n', instruction: 'Change the comparison to greater than or equal. Keep every other character unchanged.', expected: 'return score >= target;\n' },
  { id: 'identifier', source: 'private float m_speed = 2f;\n', instruction: 'Rename m_speed to m_moveSpeed. Keep every other character unchanged.', expected: 'private float m_moveSpeed = 2f;\n' },
]);

/**
 * @param {object} options
 * @param {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} options.profile
 * @param {number} options.runs
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(cleanup: () => string | void) => () => void} [options.addCleanup]
 * @param {typeof guardedChat} [options.chat]
 */
export async function runEditBenchmark({ profile, runs, temperature, signal, platform, addCleanup, chat = guardedChat }) {
  const trials = [];
  for (let iteration = 1; iteration <= runs; iteration += 1) {
    for (const fixture of EDIT_CASES) {
      signal?.throwIfAborted();
      const result = await chat({
        profile, command: 'bench edits', platform, addCleanup, signal,
        timeoutMs: 120000, maxOutputTokens: 256,
        sampling: temperature === undefined ? undefined : { temperature },
        format: { type: 'object', properties: { replacement: { type: 'string' } }, required: ['replacement'], additionalProperties: false },
        messages: [
          { role: 'system', content: 'Apply exactly the requested change to the supplied source. Return only a JSON object with replacement containing the complete modified source, including its final newline.' },
          { role: 'user', content: JSON.stringify({ instruction: fixture.instruction, source: fixture.source }) },
        ],
      });
      let replacement;
      try { replacement = JSON.parse(result.response.content).replacement; } catch { replacement = undefined; }
      trials.push({
        id: fixture.id, iteration, ok: !result.truncated && replacement === fixture.expected,
        reason: result.truncated ? 'context_truncated' : replacement === fixture.expected ? 'exact_match' : 'replacement_mismatch',
        inputTokens: result.response.promptTokens, outputTokens: result.response.outputTokens,
        durationMs: result.durationMs, guard: result.guard.verdict,
      });
    }
  }
  const passed = trials.filter((trial) => trial.ok).length;
  return {
    schemaVersion: 1, suite: 'edits', mode: 'native-ollama-text', api: 'ollama-native-chat',
    model: profile.provider.modelTag, numCtx: profile.provider.numCtx,
    temperature: temperature ?? profile.provider.sampling.temperature,
    runs, trials, passed, total: trials.length, successRate: passed / trials.length,
    ok: passed === trials.length,
    inputTokens: trials.reduce((sum, trial) => sum + trial.inputTokens, 0),
    outputTokens: trials.reduce((sum, trial) => sum + trial.outputTokens, 0),
    limitations: ['Three synthetic exact replacements; no user files changed.', 'Does not measure OpenCode tool execution or general coding reliability.'],
  };
}
