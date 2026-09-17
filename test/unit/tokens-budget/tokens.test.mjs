import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CALIBRATED_CHARS_PER_TOKEN,
  checkPromptBudget,
  clampCalibration,
  estimateCharTokens,
  estimatePromptTokens,
  estimateTextTokens,
  getPromptBudget,
  getTruncationLimit,
  isTruncationSignature,
  updateCalibration,
} from '../../../plugin/opencode-unity-lib/tokens.js';

const SAMPLES = fileURLToPath(new URL('./samples/', import.meta.url));

describe('estimateTextTokens against real Qwen token counts', () => {
  it('stays within 5% on code, prompts, JSON and logs, and never under-counts them', async () => {
    const expected = JSON.parse(await fs.readFile(path.join(SAMPLES, 'expected.json'), 'utf8'));
    for (const [name, { chars, qwenTokens }] of Object.entries(expected.samples)) {
      const text = await fs.readFile(path.join(SAMPLES, name), 'utf8');
      assert.equal(text.length, chars, `${name}: fixture changed, re-count its real tokens`);
      const estimate = estimateTextTokens(text);
      const ratio = estimate / qwenTokens;
      // CJK text is over-counted on purpose: over-counting only compacts earlier, under-counting truncates.
      const upper = name.includes('cjk') ? 1.3 : 1.05;
      assert.ok(ratio >= 1 && ratio <= upper, `${name}: estimate ${estimate} vs real ${qwenTokens} (ratio ${ratio.toFixed(3)})`);
    }
  });

  it('is more conservative when charsPerToken is lower', () => {
    const text = 'private readonly List<IDamageable> m_targets = new List<IDamageable>(8);';
    const base = estimateTextTokens(text);
    assert.ok(estimateTextTokens(text, { charsPerToken: 3 }) > base);
    assert.ok(estimateTextTokens(text, { charsPerToken: 4 }) < base);
    assert.throws(() => estimateTextTokens(text, { charsPerToken: 0 }), /charsPerToken/);
  });

  it('counts every piece at least once, so indentation and punctuation are not free', () => {
    assert.equal(estimateTextTokens(''), 0);
    assert.equal(estimateTextTokens('a'), 1);
    assert.ok(estimateTextTokens('12:31:05.123') >= 8);
    assert.ok(estimateTextTokens('        ') >= 1);
    assert.ok(estimateTextTokens('\n\n\n') >= 1);
  });
});

describe('estimateCharTokens', () => {
  it('divides by charsPerToken and rounds up', () => {
    assert.equal(estimateCharTokens(3500), 1000);
    assert.equal(estimateCharTokens(1), 1);
    assert.equal(estimateCharTokens(0), 0);
    assert.equal(estimateCharTokens(-5), 0);
    assert.equal(estimateCharTokens(3500, { charsPerToken: 3.5 }), 1000);
    assert.equal(CALIBRATED_CHARS_PER_TOKEN, 3.5);
  });
});

describe('prompt budget math (spec 8.8)', () => {
  it('reproduces the 16K preset budget', () => {
    assert.equal(getPromptBudget({ context: 16384, output: 4096, reserveTokens: 512 }), 11_776);
    assert.equal(getPromptBudget({ context: 32768, output: 4096, reserveTokens: 512 }), 28_160);
    assert.throws(() => getPromptBudget({ context: -1, output: 0, reserveTokens: 0 }), /context/);
  });

  it('adds system, history and tool tokens, then the safety margin', () => {
    const estimate = estimatePromptTokens({ systemChars: 3500, historyChars: 7000, toolsTokens: 3400, safetyMargin: 0.1 });
    // (1000 + 2000) * 1.0 + 3400 = 6400, plus 10%.
    assert.equal(estimate, 7040);
    assert.equal(estimatePromptTokens({ systemChars: 3500, historyChars: 7000, toolsTokens: 3400, safetyMargin: 0 }), 6400);
  });

  it('applies the session calibration to the estimated part only', () => {
    const calibrated = estimatePromptTokens({ systemChars: 3500, historyChars: 0, toolsTokens: 1000, calibration: 1.4, safetyMargin: 0 });
    assert.equal(calibrated, 1400 + 1000);
    assert.throws(() => estimatePromptTokens({ systemChars: 10, calibration: 0 }), /calibration/);
  });

  it('reports how far a request is over the budget', () => {
    const within = checkPromptBudget({ systemChars: 3500, historyChars: 0, toolsTokens: 3400, promptBudget: 11_776 });
    assert.deepEqual(within, { estimate: 4840, promptBudget: 11_776, overBudget: false, overBy: 0 });
    const over = checkPromptBudget({ systemChars: 35_000, historyChars: 70_000, toolsTokens: 3400, promptBudget: 11_776 });
    assert.equal(over.overBudget, true);
    assert.equal(over.overBy, over.estimate - 11_776);
  });
});

describe('calibration', () => {
  it('keeps the factor inside the clamp', () => {
    assert.equal(clampCalibration(1), 1);
    assert.equal(clampCalibration(0.2), 0.7);
    assert.equal(clampCalibration(9), 1.4);
    assert.equal(clampCalibration(Number.NaN), 1);
    assert.equal(clampCalibration(2, [0.5, 3]), 2);
    assert.throws(() => clampCalibration(1, [1.4, 0.7]), /clamp/);
  });

  it('learns the ratio of real tokens to estimated tokens', () => {
    assert.equal(updateCalibration({ estimatedTokens: 5000, actualTokens: 5500 }), 1.1);
    assert.equal(updateCalibration({ estimatedTokens: 5000, actualTokens: 20_000 }), 1.4);
    assert.equal(updateCalibration({ estimatedTokens: 5000, actualTokens: 100 }), 0.7);
  });

  it('keeps the previous factor when usage is missing or nonsense', () => {
    assert.equal(updateCalibration({ estimatedTokens: 0, actualTokens: 5000, previous: 1.2 }), 1.2);
    assert.equal(updateCalibration({ estimatedTokens: 5000, actualTokens: 0, previous: 1.2 }), 1.2);
    assert.equal(updateCalibration({ estimatedTokens: Number.NaN, actualTokens: 10, previous: 9 }), 1.4);
  });
});

describe('Ollama truncation signature (spec 8.7, E1)', () => {
  it('matches the documented limit table', () => {
    assert.equal(getTruncationLimit(16_384, 4), 8194);
    assert.equal(getTruncationLimit(32_768, 4), 16_386);
    assert.equal(getTruncationLimit(8192, 0), 4096);
    assert.equal(getTruncationLimit(1, 0), 0);
    assert.equal(getTruncationLimit(2, 5), 1);
    assert.throws(() => getTruncationLimit(16_384.5, 4), /integers/);
  });

  it('flags a prompt count at the limit or at the edge of the window', () => {
    assert.equal(isTruncationSignature({ inputTokens: 8194, numCtx: 16_384, numKeep: 4 }), true);
    assert.equal(isTruncationSignature({ inputTokens: 16_383, numCtx: 16_384, numKeep: 4 }), true);
    assert.equal(isTruncationSignature({ inputTokens: 16_384, numCtx: 16_384, numKeep: 4 }), true);
    assert.equal(isTruncationSignature({ inputTokens: 5024, numCtx: 16_384, numKeep: 4 }), false);
    assert.equal(isTruncationSignature({ inputTokens: 0, numCtx: 16_384, numKeep: 4 }), false);
    assert.equal(isTruncationSignature({ inputTokens: 16_386, numCtx: 32_768, numKeep: 4 }), true);
  });
});
