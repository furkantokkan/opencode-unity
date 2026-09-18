// `delegate map` and its optional reduce (spec 12.2). One request per file is what keeps a 16K context
// useful over a tree, so the per-file failure modes matter as much as the happy path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { readLedger } from '../../src/delegate/ledger.js';
import { createHarness, reply } from './helpers.mjs';

/**
 * @param {import('./helpers.mjs').DelegateHarness} harness
 * @param {string} jobId
 * @param {string} name
 */
function jobFile(harness, jobId, name) {
  return path.join(harness.paths.delegateResults, jobId, name);
}

describe('delegate map', () => {
  it('sends one request per file and writes a note for each', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    await harness.writeFile('b.cs', 'class B {}\n');
    harness.ollama.enqueueChat(reply('A holds nothing.'), reply('B holds nothing.'));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs', 'b.cs'] } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.status, 'ok');
    assert.equal(harness.ollama.chatRequests.length, 2);
    assert.match(result.data.summary, /ok a\.cs: A holds nothing\./);
    assert.match(result.data.summary, /ok b\.cs: B holds nothing\./);
    const notes = await fs.readFile(jobFile(harness, result.data.jobId, 'map.md'), 'utf8');
    assert.match(notes, /## a\.cs \(ok\)\n\nA holds nothing\./);
    const index = JSON.parse(await fs.readFile(jobFile(harness, result.data.jobId, 'index.json'), 'utf8'));
    assert.deepEqual(index.files.map((/** @type {any} */ file) => file.file), ['a.cs', 'b.cs']);
    assert.equal(index.task, 'summarize');
  });

  it('gives each request exactly one file', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    await harness.writeFile('b.cs', 'class B {}\n');
    harness.ollama.enqueueChat(reply('one'), reply('two'));

    await harness.run('map', { options: { task: 'summarize', files: ['a.cs', 'b.cs'] } });

    for (const [index, body] of harness.ollama.chatRequests.entries()) {
      const user = body.messages[1].content;
      assert.equal((user.match(/^FILE: /gm) ?? []).length, 1, `request ${index} should carry one file`);
    }
  });

  it('expands a glob over the tree', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Assets/Game/A.cs', 'class A {}\n');
    await harness.writeFile('Assets/Game/deep/B.cs', 'class B {}\n');
    await harness.writeFile('Assets/Game/notes.md', 'not code\n');
    harness.ollama.enqueueChat(reply('one'), reply('two'));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['Assets/**/*.cs'] } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(harness.ollama.chatRequests.length, 2);
  });

  it('merges the notes when --reduce is given', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    await harness.writeFile('b.cs', 'class B {}\n');
    harness.ollama.enqueueChat(reply('A note'), reply('B note'), reply('Both classes are empty.'));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs', 'b.cs'], reduce: 'merge into one list' } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(harness.ollama.chatRequests.length, 3);
    assert.match(result.data.summary, /^=== reduce ===\nBoth classes are empty\./);
    assert.equal(await fs.readFile(jobFile(harness, result.data.jobId, 'reduce.md'), 'utf8'), 'Both classes are empty.');
    const reduceRequest = harness.ollama.chatRequests[2].messages[1].content;
    assert.match(reduceRequest, /<<<BEGIN NOTES>>>/);
    assert.match(reduceRequest, /\| A note/, 'every note line is prefixed, so a note cannot end the notes');
  });

  it('marks the files that are over budget and still answers for the rest', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('small.cs', 'class A {}\n');
    await harness.writeFile('huge.cs', 'x'.repeat(200_000));
    harness.ollama.enqueueChat(reply('A holds nothing.'));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['small.cs', 'huge.cs'] } });

    assert.equal(result.exitCode, EXIT.OK, 'a partial result is still useful');
    assert.equal(result.data.status, 'partial');
    assert.equal(harness.ollama.chatRequests.length, 1);
    assert.match(result.message, /1 of 2 files failed: huge\.cs \(context_budget_exceeded\)/);
    assert.match(result.data.summary, /context_budget_exceeded huge\.cs/);
  });

  it('refuses with exit 3 when no file fits', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('huge1.cs', 'x'.repeat(200_000));
    await harness.writeFile('huge2.cs', 'y'.repeat(200_000));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['huge1.cs', 'huge2.cs'] } });

    assert.equal(result.exitCode, EXIT.BUDGET);
    assert.equal(result.data.orchestratorAction, 'split_with_map');
    assert.match(result.message, /Every file was over the context budget/);
    assert.equal(harness.ollama.chatRequests.length, 0);
  });

  it('refuses a reduce instruction that leaves no room for notes', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs'], reduce: 'z'.repeat(60_000) } });

    assert.equal(result.exitCode, EXIT.BUDGET);
    assert.match(result.message, /leaves \d+ of the \d+-token prompt budget/);
    assert.equal(harness.ollama.chatRequests.length, 0, 'the budget is checked before the lock and before any request');
  });

  it('stops the whole job when the backend goes away mid-run', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    await harness.writeFile('b.cs', 'class B {}\n');
    harness.ollama.enqueueChat(reply('A note'));
    let requests = 0;
    const result = await harness.run('map', {
      options: { task: 'summarize', files: ['a.cs', 'b.cs'] },
      probes: {
        readOllamaPs: async () => {
          requests += 1;
          return requests > 1 ? { ok: false, error: 'connection refused' } : { ok: true, models: [] };
        },
      },
    });

    assert.equal(result.exitCode, EXIT.BLOCKED);
    assert.equal(result.data.orchestratorAction, 'do_it_yourself');
    const [entry] = await readLedger(harness.paths.delegateLedger);
    assert.equal(entry.command, 'map');
    assert.equal(entry.exitCode, EXIT.BLOCKED);
  });

  it('withholds the note of a file whose prompt was truncated', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    harness.ollama.enqueueChat(reply('truncated note', { promptTokens: 16_384 }));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs'] } });

    assert.equal(result.exitCode, EXIT.BUDGET);
    assert.match(result.data.summary, /context_overflow a\.cs/);
  });

  it('merges the notes in rounds when they do not fit one reduce request', async (t) => {
    const harness = await createHarness(t);
    for (const name of ['a.cs', 'b.cs', 'c.cs']) await harness.writeFile(name, `class ${name} {}\n`);
    // A long instruction leaves a small note budget, so three long notes need two groups and a second round.
    const reduceInstruction = 'merge these notes. '.repeat(1500);
    harness.ollama.enqueueChat(
      reply('n'.repeat(6000)),
      reply('n'.repeat(6000)),
      reply('n'.repeat(6000)),
      reply('partial one'),
      reply('partial two'),
      reply('the merged answer'),
    );

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs', 'b.cs', 'c.cs'], reduce: reduceInstruction } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(harness.ollama.chatRequests.length, 6, 'three files, two groups, then one final merge');
    assert.match(result.data.summary, /^=== reduce ===\nthe merged answer/);
    assert.ok((await fs.readFile(jobFile(harness, result.data.jobId, 'reduce-round-1.md'), 'utf8')).includes('partial one'));
  });

  it('withholds a reduce answer whose prompt was truncated', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('a.cs', 'class A {}\n');
    harness.ollama.enqueueChat(reply('A note'), reply('merged', { promptTokens: 16_384 }));

    const result = await harness.run('map', { options: { task: 'summarize', files: ['a.cs'], reduce: 'merge them' } });

    assert.equal(result.exitCode, EXIT.BUDGET);
    assert.equal(result.data.status, 'reduce_failed');
    assert.match(result.message, /filled the context window/);
    assert.match(result.data.summary, /ok a\.cs: A note/, 'the per-file notes still come back');
  });

  it('needs --files', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('map', { options: { task: 'summarize' } });
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.match(result.message, /needs --files/);
  });
});
