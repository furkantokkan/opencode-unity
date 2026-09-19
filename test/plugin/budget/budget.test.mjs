// The prompt budget preflight and the overflow path (spec 8.7, 8.8). The behaviour under test is the
// one the spike measured: OpenCode reads the thrown *shape* — an object with
// `code: "context_length_exceeded"` becomes a compaction, a plain Error halts the session.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPACTION_AGENT,
  OVERFLOW_ERROR_CODE,
  SESSION_TOO_LARGE_MESSAGE,
  createBudgetTracker,
  createOverflowError,
  createSessionTooLargeError,
  measureHistory,
  measureSystem,
  resolveToolsTokens,
} from '../../../plugin/opencode-unity-lib/budget.js';
import { buildTestProfile } from '../helpers/profile.mjs';

const profile = buildTestProfile();

/** Characters that safely exceed the prompt budget once estimated. */
const HUGE = profile.budget.promptBudget * profile.budget.charsPerToken * 2;

function createTracker() {
  return createBudgetTracker({ profile });
}

describe('budget preflight', () => {
  it('passes a small prompt and reports what it measured', () => {
    const tracker = createTracker();
    tracker.recordSystemChars('s1', 4000);
    tracker.recordHistoryChars('s1', 2000);
    const decision = tracker.preflight({ sessionId: 's1', agent: 'unity-code' });
    assert.equal(decision.action, 'pass');
    assert.equal(decision.promptBudget, profile.budget.promptBudget);
    assert.equal(decision.toolsTokens, profile.budget.toolsTokens['unity-code']);
    assert.ok(decision.estimate > 0 && decision.estimate < decision.promptBudget);
    assert.equal(decision.overBy, 0);
  });

  it('counts the tools of the agent that is asking', () => {
    const tracker = createTracker();
    const code = tracker.preflight({ sessionId: 'a', agent: 'unity-code' });
    const editor = tracker.preflight({ sessionId: 'b', agent: 'unity-editor' });
    assert.equal(code.toolsTokens, profile.budget.toolsTokens['unity-code']);
    assert.equal(editor.toolsTokens, profile.budget.toolsTokens['unity-editor']);
  });

  it('charges an unmeasured agent the largest measured allowance', () => {
    const largest = Math.max(...Object.values(profile.budget.toolsTokens));
    assert.equal(resolveToolsTokens(profile.budget.toolsTokens, 'plan'), largest);
    assert.equal(resolveToolsTokens(/** @type {any} */ ({}), 'plan'), 0);
    assert.equal(resolveToolsTokens(/** @type {any} */ ({ 'unity-code': 'x' }), 'unity-code'), 0);
  });

  it('keeps each session apart', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('big', HUGE);
    tracker.recordHistoryChars('small', 500);
    assert.equal(tracker.preflight({ sessionId: 'big', agent: 'unity-code' }).action, 'overflow');
    assert.equal(tracker.preflight({ sessionId: 'small', agent: 'unity-code' }).action, 'pass');
  });

  it('ignores a measurement that is not a usable count', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('s', 1000);
    for (const value of [Number.NaN, -1, Infinity]) {
      tracker.recordHistoryChars('s', value);
      tracker.recordSystemChars('s', value);
    }
    assert.equal(tracker.get('s').historyChars, 1000);
    assert.equal(tracker.get('s').systemChars, 0);
  });

  it('forgets the oldest sessions instead of growing without a bound', () => {
    const tracker = createTracker();
    for (let index = 0; index < 200; index += 1) tracker.preflight({ sessionId: `s${index}`, agent: 'unity-code' });
    assert.ok(tracker.size() <= 64, `kept ${tracker.size()} sessions`);
  });
});

describe('overflow path', () => {
  it('asks OpenCode to compact on the first overflow and halts on the next one without progress', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('s1', HUGE);
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'overflow');
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'stop');
    assert.equal(tracker.get('s1').overflows, 2);
  });

  it('halts as soon as the compaction itself does not fit', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('s1', HUGE);
    assert.equal(tracker.preflight({ sessionId: 's1', agent: COMPACTION_AGENT }).action, 'stop');
  });

  it('treats a finished step as progress, so a later overflow compacts again', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('s1', HUGE);
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'overflow');
    tracker.recordUsage({ sessionId: 's1', inputTokens: 5000, agent: 'unity-code' });
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'overflow');
  });

  it('does not treat a compaction summary as progress', () => {
    const tracker = createTracker();
    tracker.recordHistoryChars('s1', HUGE);
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'overflow');
    tracker.recordUsage({ sessionId: 's1', inputTokens: 5000, agent: COMPACTION_AGENT });
    assert.equal(tracker.preflight({ sessionId: 's1', agent: 'unity-code' }).action, 'stop');
  });

  it('builds the exact error shape OpenCode classifies as a context overflow', () => {
    const value = createOverflowError({ action: 'overflow', estimate: 12000, promptBudget: 11776, overBy: 224, toolsTokens: 1200, calibration: 1 });
    assert.equal(value.type, 'error');
    assert.equal(value.error.code, OVERFLOW_ERROR_CODE);
    assert.match(value.error.message, /12000 tokens/);
    assert.ok(!(value instanceof Error));
  });

  it('builds a plain Error with no digits for the session that cannot be rescued', () => {
    const error = createSessionTooLargeError();
    assert.ok(error instanceof Error);
    assert.equal(error.message, SESSION_TOO_LARGE_MESSAGE);
    assert.ok(!/\d/.test(error.message));
    assert.ok(!/exhausted|unavailable|temporarily at capacity/i.test(error.message));
  });
});

describe('calibration', () => {
  it('learns the real cost of a session from the tokens the response reports', () => {
    const tracker = createTracker();
    tracker.recordSystemChars('s1', 7000);
    const first = tracker.preflight({ sessionId: 's1', agent: 'unity-code' });
    const factor = tracker.recordUsage({ sessionId: 's1', inputTokens: Math.round(first.estimate * 1.2), agent: 'unity-code' });
    assert.ok(factor > 1 && factor <= 1.4);
    const second = tracker.preflight({ sessionId: 's1', agent: 'unity-code' });
    assert.ok(second.estimate > first.estimate);
    assert.equal(second.calibration, factor);
  });

  it('stays inside the clamp however far off the estimate was', () => {
    const [low, high] = profile.budget.calibrationClamp;
    const tracker = createTracker();
    tracker.recordSystemChars('s1', 7000);
    tracker.preflight({ sessionId: 's1', agent: 'unity-code' });
    assert.equal(tracker.recordUsage({ sessionId: 's1', inputTokens: 1000000, agent: 'unity-code' }), high);
    tracker.preflight({ sessionId: 's1', agent: 'unity-code' });
    assert.equal(tracker.recordUsage({ sessionId: 's1', inputTokens: 1, agent: 'unity-code' }), low);
  });

  it('keeps the previous factor when there is nothing to learn from', () => {
    const tracker = createTracker();
    assert.equal(tracker.recordUsage({ sessionId: 'fresh', inputTokens: 4000, agent: 'unity-code' }), 1);
  });
});

describe('measurements', () => {
  it('reads the session id and estimates model-facing content without bookkeeping', () => {
    const messages = [{ info: { sessionID: 'ses1' }, parts: [{ text: 'hello' }] }, { info: { sessionID: 'ses1' } }];
    const measured = measureHistory(messages);
    assert.equal(measured.sessionId, 'ses1');
    assert.equal(measured.chars, JSON.stringify(messages).length);
  });

  it('survives a history it cannot serialize or read', () => {
    const cyclic = /** @type {any} */ ({ info: { sessionID: 'ses1' }, parts: [] });
    cyclic.parts.push(cyclic);
    assert.deepEqual(measureHistory([cyclic]), { sessionId: 'ses1', chars: 0 });
    assert.deepEqual(measureHistory(/** @type {any} */ (null)), { sessionId: null, chars: 0 });
    assert.deepEqual(measureHistory([]), { sessionId: null, chars: '[]'.length });
    assert.deepEqual(measureHistory([{ info: { sessionID: 7 } }]).sessionId, null);
  });

  it('counts tool content once when OpenCode repeats it in UI metadata', () => {
    const output = 'Large read output\n'.repeat(100);
    const base = { type: 'tool', tool: 'read', callID: 'call-1', state: { input: { filePath: '/fixture.cs' }, output } };
    const withMetadata = structuredClone(base);
    withMetadata.state.metadata = { preview: output, filediff: { before: output, after: output } };
    const measure = (part) => measureHistory([{ info: { sessionID: 's' }, parts: [part] }]).chars;
    assert.equal(measure(base), measure(withMetadata));
    assert.ok(measure(base) >= output.length);
    assert.equal(resolveToolsTokens(profile.budget.toolsTokens, COMPACTION_AGENT), 0);
  });

  it('adds up every system part, so more than one is never undercounted', () => {
    assert.equal(measureSystem(['abc', 'de']), 5);
    assert.equal(measureSystem([]), 0);
    assert.equal(measureSystem(/** @type {any} */ ([null, 'ab', 3])), 2);
    assert.equal(measureSystem(/** @type {any} */ ('abc')), 0);
  });
});
