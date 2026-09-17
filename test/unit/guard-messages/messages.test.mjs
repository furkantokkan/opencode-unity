// Spec 7.6 and D9: every guard message is checked against the vendored copy of OpenCode 1.18.31's
// retry rules. Stop messages must never look retryable; retry messages must always look retryable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  GUARD_MESSAGE_PREFIX,
  RETRY_MARKER,
  createGuardError,
  formatGiB,
  formatGuardMessage,
  formatMessageCount,
  formatMessageCpu,
  formatMessageGiB,
  formatRetryMessage,
  formatStopMessage,
  formatVerdictSummary,
} from '../../../plugin/opencode-unity-lib/guard/messages.js';

const patternsFile = new URL('../../../src/opencode/retry-patterns-1.18.31.json', import.meta.url);
const RETRY_RULES = JSON.parse(fs.readFileSync(patternsFile, 'utf8'));
const PATTERNS = RETRY_RULES.retryableMessagePatterns.map((entry) => new RegExp(entry.source, entry.flags));
const SUBSTRINGS = RETRY_RULES.retryableLowercaseSubstrings.map((entry) => entry.value);
const CAPACITY_PATTERN = PATTERNS[PATTERNS.length - 1];

/**
 * @param {string} message
 * @returns {string[]}  The rules that would make OpenCode retry this message.
 */
function retryTriggers(message) {
  const lower = message.toLowerCase();
  return [
    ...SUBSTRINGS.filter((value) => lower.includes(value)).map((value) => `substring "${value}"`),
    ...PATTERNS.filter((pattern) => pattern.test(message)).map((pattern) => `pattern /${pattern.source}/`),
  ];
}

/**
 * @param {string} message
 */
function assertStopSafe(message) {
  const triggers = retryTriggers(message);
  assert.deepEqual(triggers, [], `stop message would be retried by ${triggers.join(', ')}: ${message}`);
  assert.ok(message.startsWith(GUARD_MESSAGE_PREFIX), message);
  assert.ok(message.endsWith('Details: opencode-unity guard'), message);
}

/**
 * @param {string} message
 */
function assertRetrySafe(message) {
  assert.match(message, CAPACITY_PATTERN, `retry message would not be retried: ${message}`);
  const lower = message.toLowerCase();
  for (const value of SUBSTRINGS) {
    assert.ok(!lower.includes(value), `retry message contains "${value}", which OpenCode replaces with its own text: ${message}`);
  }
}

/**
 * @param {'stop' | 'retry'} mode
 * @param {number} value
 */
function vramReason(mode, value, { min = 1500, model = 19000, free = 22000 } = {}) {
  return {
    id: 'vram_low',
    mode,
    detail: 'low',
    data: { freeMiB: free, reclaimableMiB: 0, availableMiB: free, modelVramMiB: model, freeAfterLoadMiB: value, minFreeVramAfterLoadMiB: min },
  };
}

/**
 * Every reason shape the guard can produce, over the value grid of spec 7.6.
 * @param {'stop' | 'retry'} mode
 * @returns {Array<import('../../../plugin/opencode-unity-lib/guard/decide.js').GuardReason>}
 */
function buildReasonGrid(mode) {
  const reasons = [];
  for (let mib = -60000; mib <= 110000; mib += 137) {
    reasons.push(vramReason(mode, mib, { min: 1500, model: 19000, free: Math.max(0, mib + 19000) }));
  }
  for (const min of [0, 500, 1500, 2500, 102300, 524288, 1048576]) {
    reasons.push(vramReason(mode, -500, { min, model: 1048576, free: 0 }));
    reasons.push(vramReason(mode, 500, { min, model: 1, free: 502 }));
  }
  for (let percent = 0; percent <= 100; percent += 1) {
    reasons.push({ id: 'gpu_busy', mode, detail: 'busy', data: { samples: [percent, 100 - percent], maxGpuUtilPercent: Math.max(1, percent) } });
  }
  for (let cpu = 0; cpu <= 6400; cpu += 7) {
    reasons.push({ id: 'import_busy', mode, detail: 'import', data: { workers: { cpuPercent: cpu, limitPercent: 20, processCount: 2 }, editor: null } });
    reasons.push({ id: 'import_busy', mode, detail: 'import', data: { workers: null, editor: { cpuPercent: cpu, limitPercent: 60, processCount: 1 } } });
    reasons.push({
      id: 'import_busy',
      mode,
      detail: 'import',
      data: { workers: { cpuPercent: cpu, limitPercent: 102400, processCount: 3 }, editor: { cpuPercent: 6400 - cpu, limitPercent: 102400, processCount: 2 } },
    });
  }
  for (let editors = 0; editors <= 200; editors += 1) {
    reasons.push({ id: 'too_many_editors', mode, detail: 'editors', data: { editorCount: editors, maxUnityEditors: Math.min(editors, 64) } });
  }
  for (const probe of ['settings', 'nvidia-smi-memory', 'nvidia-smi-utilization', 'processes', 'guard']) {
    reasons.push({ id: 'probe_failed', mode, detail: 'ECONNREFUSED: the request timed out after 503 ms', data: { probe, error: 'ECONNREFUSED' } });
  }
  reasons.push({ id: 'ollama_unreachable', mode, detail: 'GET /api/ps failed (ECONNREFUSED)', data: { error: 'GET /api/ps failed (ECONNREFUSED)' } });
  reasons.push({ id: 'remote_unguarded', mode, detail: 'remote', data: { host: 'gpu-box.invalid' } });
  return reasons;
}

describe('guard message retry safety', () => {
  it('vendors the 1.18.31 patterns that decide retries', () => {
    assert.equal(RETRY_RULES.opencodeVersion, '1.18.31');
    assert.equal(PATTERNS.length, 7);
    assert.deepEqual(SUBSTRINGS, ['too_many_requests', 'exhausted', 'unavailable']);
    // The vendored copy must still classify OpenCode's own examples the way the source does.
    assert.ok(retryTriggers('Provider returned error 503').length > 0);
    assert.ok(retryTriggers('socket hang up').length > 0);
    assert.equal(retryTriggers('the model was not loaded').length, 0);
  });

  it('stop messages never match, for every reason over the value grid', () => {
    for (const path of ['remote', 'loaded', 'cold']) {
      for (const reason of buildReasonGrid('stop')) {
        assertStopSafe(formatStopMessage([reason], path));
      }
    }
  });

  it('stop messages stay safe when several reasons are joined', () => {
    const grid = buildReasonGrid('stop');
    for (let index = 0; index < grid.length; index += 1) {
      const pair = [grid[index], grid[(index * 7 + 3) % grid.length]];
      assertStopSafe(formatStopMessage(pair, 'cold'));
    }
  });

  it('retry messages always match and keep our own text', () => {
    const grid = buildReasonGrid('retry');
    for (let index = 0; index < grid.length; index += 1) {
      assertRetrySafe(formatRetryMessage([grid[index]]));
      assertRetrySafe(formatRetryMessage([grid[index], grid[(index * 5 + 1) % grid.length]]));
    }
  });

  it('prints the examples of spec 7.6', () => {
    const vram = formatStopMessage([vramReason('stop', 716, { min: 1536, model: 19000, free: 19716 })], 'cold');
    assert.match(vram, /the model was not loaded because free video memory would drop to 0\.7 GiB \(minimum 1\.5 GiB\)\./);
    assert.match(vram, /Close GPU-heavy apps or unload other models, then send the prompt again\./);
    assertStopSafe(vram);

    const importBusy = formatStopMessage([{ id: 'import_busy', mode: 'stop', detail: '', data: { workers: { cpuPercent: 63, limitPercent: 20, processCount: 2 }, editor: null } }], 'cold');
    assert.match(importBusy, /because Unity is importing assets \(import workers at 63% CPU\)\. Send the prompt again when Unity is idle\./);
    assertStopSafe(importBusy);

    const probe = formatStopMessage([{ id: 'probe_failed', mode: 'stop', detail: '', data: { probe: 'nvidia-smi-memory', error: 'exit 9' } }], 'cold');
    assert.match(probe, /nvidia-smi could not report GPU memory, so the load was refused to stay safe/);
    assertStopSafe(probe);
  });

  it('never repeats the same cause twice', () => {
    const reason = { id: 'import_busy', mode: 'stop', detail: '', data: { workers: { cpuPercent: 40, limitPercent: 20, processCount: 1 }, editor: null } };
    const message = formatStopMessage([reason, { ...reason }], 'cold');
    assert.equal(message.split('Unity is importing assets').length, 2);
  });

  it('says what the guard held back on the loaded path', () => {
    const reason = { id: 'too_many_editors', mode: 'stop', detail: '', data: { editorCount: 4, maxUnityEditors: 3 } };
    assert.match(formatStopMessage([reason], 'loaded'), /the request was held back because 4 Unity editors are open \(maximum 3\)/);
    assert.match(formatStopMessage([reason], 'cold'), /the model was not loaded because 4 Unity editors are open/);
  });
});

describe('guard message formatting', () => {
  it('formats GiB with one decimal and never three digits in a row', () => {
    assert.equal(formatGiB(716), '0.7 GiB');
    assert.equal(formatGiB(22528), '22.0 GiB');
    assert.equal(formatGiB(-16384), '-16.0 GiB');
    assert.equal(formatGiB(-10), '0.0 GiB');
    assert.equal(formatMessageGiB(716), '0.7 GiB');
    assert.equal(formatMessageGiB(-500), '0.0 GiB');
    assert.equal(formatMessageGiB(1048576), 'over 99 GiB');
    assert.equal(formatMessageGiB(102300), '99.9 GiB');
    assert.equal(formatMessageGiB(102400), 'over 99 GiB');
  });

  it('formats CPU use as percent up to one core and as cores above it', () => {
    assert.equal(formatMessageCpu(0), '0% CPU');
    assert.equal(formatMessageCpu(62.6), '63% CPU');
    assert.equal(formatMessageCpu(100), '100% CPU');
    assert.equal(formatMessageCpu(150), '1.5 CPU cores');
    assert.equal(formatMessageCpu(6400), '64.0 CPU cores');
    assert.equal(formatMessageCpu(102400), 'over 99 CPU cores');
    assert.equal(formatMessageCpu(-5), '0% CPU');
  });

  it('formats counts without three-digit runs', () => {
    assert.equal(formatMessageCount(3), '3');
    assert.equal(formatMessageCount(100), '100');
    assert.equal(formatMessageCount(504), 'over 99');
  });
});

describe('guard errors', () => {
  const blocked = {
    verdict: 'blocked',
    pass: false,
    path: 'cold',
    mode: 'stop',
    reasons: [vramReason('stop', 716)],
    notes: [],
    cacheSec: 0,
    checkedAt: '2026-09-17T12:00:00.000Z',
    target: { modelTag: 'ocu-model-16k', numCtx: 16384 },
    model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
    measurements: { gpu: null, unity: null, loadedModels: [] },
  };

  it('turns a blocked verdict into an Error with the message OpenCode reads', () => {
    const error = createGuardError(blocked);
    assert.ok(error instanceof Error);
    assert.equal(error.message, formatGuardMessage(blocked));
    assertStopSafe(error.message);
  });

  it('uses the retry wording when the verdict mode is retry', () => {
    const retry = { ...blocked, mode: 'retry', reasons: [vramReason('retry', 716)] };
    const message = formatGuardMessage(retry);
    assert.ok(message.includes(RETRY_MARKER));
    assertRetrySafe(message);
  });

  it('has no message and no error for a pass', () => {
    const pass = { ...blocked, verdict: 'pass', pass: true, mode: null, reasons: [] };
    assert.equal(formatGuardMessage(pass), null);
    assert.equal(createGuardError(pass), null);
  });

  it('summarizes a verdict for the CLI with the full probe detail', () => {
    assert.equal(formatVerdictSummary({ ...blocked, verdict: 'pass', pass: true, path: 'loaded', reasons: [] }), 'pass (model loaded)');
    assert.equal(formatVerdictSummary({ ...blocked, verdict: 'pass', pass: true, path: 'cold', reasons: [] }), 'pass (safe to load)');
    assert.equal(formatVerdictSummary({ ...blocked, verdict: 'pass', pass: true, path: 'remote', reasons: [] }), 'pass (unguarded remote Ollama)');
    assert.equal(formatVerdictSummary(blocked), 'blocked: vram_low (low)');
  });
});
