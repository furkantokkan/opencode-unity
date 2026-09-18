// Toasts (spec 8.7). They are best-effort by design: a session must not fail because a notification
// could not be shown, and `opencode run` has no TUI to show one at all.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFirstLoadToast, buildTextToolCallToast, buildTruncationToast, createToaster } from '../../../plugin/opencode-unity-lib/toast.js';

function createClient() {
  /** @type {any[]} */
  const calls = [];
  return { calls, client: { tui: { showToast: async (input) => { calls.push(input); return true; } } } };
}

describe('toaster', () => {
  it('sends the toast body the TUI endpoint expects', () => {
    const { calls, client } = createClient();
    createToaster({ client }).show({ message: 'hello', variant: 'info' });
    assert.deepEqual(calls, [{ body: { message: 'hello', variant: 'info' } }]);
  });

  it('shows a keyed toast once per process', () => {
    const { calls, client } = createClient();
    const toaster = createToaster({ client });
    toaster.showOnce('first-load', { message: 'a', variant: 'info' });
    toaster.showOnce('first-load', { message: 'b', variant: 'info' });
    toaster.showOnce('other', { message: 'c', variant: 'info' });
    assert.deepEqual(calls.map((call) => call.body.message), ['a', 'c']);
  });

  it('does nothing when the client has no TUI, which is every `opencode run` session', () => {
    assert.doesNotThrow(() => createToaster({}).show({ message: 'x', variant: 'info' }));
    assert.doesNotThrow(() => createToaster({ client: {} }).show({ message: 'x', variant: 'info' }));
    assert.doesNotThrow(() => createToaster({ client: { tui: {} } }).show({ message: 'x', variant: 'info' }));
  });

  it('reports a throwing client instead of failing the caller', () => {
    /** @type {unknown[]} */
    const errors = [];
    const client = { tui: { showToast: () => { throw new Error('no tui'); } } };
    createToaster({ client, onError: (error) => errors.push(error) }).show({ message: 'x', variant: 'info' });
    assert.equal(errors.length, 1);
  });

  it('reports a rejected toast instead of leaving an unhandled rejection behind', async () => {
    /** @type {unknown[]} */
    const errors = [];
    const client = { tui: { showToast: async () => { throw new Error('offline'); } } };
    createToaster({ client, onError: (error) => errors.push(error) }).show({ message: 'x', variant: 'info' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  });
});

describe('toast texts', () => {
  it('names the model and the context on first load', () => {
    const toast = buildFirstLoadToast({ modelTag: 'ocu-model-16k', numCtx: 16384, presetStatus: 'verified' });
    assert.equal(toast.variant, 'info');
    assert.match(toast.message, /ocu-model-16k at 16K context/);
    assert.ok(!toast.message.includes('preset'));
  });

  it('says so when the preset is not a verified one, and carries the lines a later check adds', () => {
    const toast = buildFirstLoadToast({ modelTag: 'ocu-model-16k', numCtx: 16384, presetStatus: 'experimental', extraLines: ['guard: degraded'] });
    assert.match(toast.message, /experimental preset/);
    assert.match(toast.message, /guard: degraded/);
  });

  it('prints an unusual context length as a number', () => {
    assert.match(buildFirstLoadToast({ modelTag: 'ocu-x', numCtx: 12000 }).message, /at 12000 context/);
  });

  it('warns about a cut prompt and about a tool call written as text', () => {
    const truncation = buildTruncationToast({ inputTokens: 8194, numCtx: 16384 });
    assert.equal(truncation.variant, 'warning');
    assert.match(truncation.message, /8194 tokens/);
    assert.match(truncation.message, /new session/);
    assert.match(buildTextToolCallToast().message, /wrote a tool call as text/);
  });
});
