// The delegate command itself: health, ledger, restore, the refusals of amendment 36.6, and the
// `--check auto` path that reads the project facts (spec 12.2, 12.3, 9.3).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { assertDelegationEnabled } from '../../src/commands/delegate.js';
import { getProjectId } from '../../src/core/paths.js';
import { getCompileCommand } from '../../src/facts/compile-map.js';
import { appendLedger } from '../../src/delegate/ledger.js';
import { catchError } from '../helpers/catch-error.mjs';
import { MODEL_TAG, NUM_CTX, createHarness, editBlock, reply } from './helpers.mjs';

describe('delegate health', () => {
  it('reports a machine that is ready to take work', async (t) => {
    const harness = await createHarness(t);

    const result = await harness.run('health');

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.model, MODEL_TAG);
    assert.equal(result.data.numCtx, NUM_CTX);
    assert.equal(result.data.modelInstalled, true);
    assert.equal(result.data.modelLoaded, true);
    assert.equal(result.data.promptBudgetTokens, NUM_CTX - 2048 - 512);
    assert.equal(result.data.guard.verdict, 'pass');
    assert.equal(result.data.lock, 'free');
    assert.deepEqual(result.data.parameterMismatches, []);
    assert.match(result.message, /Ready: ocu-qwen3-coder-30b-16k at 16384 tokens/);
  });

  it('loads nothing while answering', async (t) => {
    const harness = await createHarness(t);
    await harness.run('health');
    assert.deepEqual(harness.ollama.loadRequests, []);
    assert.deepEqual(harness.ollama.requests.map((request) => request.path).sort(), ['/api/ps', '/api/show', '/api/tags', '/api/version']);
  });

  it('refuses with exit 2 when the model is not installed', async (t) => {
    const harness = await createHarness(t, { models: [], loaded: false });

    const result = await harness.run('health');

    assert.equal(result.exitCode, EXIT.BLOCKED);
    // Amendment 36.6 gives "Ollama unreachable, or preset tag missing" one row and one code.
    assert.equal(result.code, 'ollama_unreachable');
    assert.equal(result.data.orchestratorAction, 'do_it_yourself');
    assert.match(result.message, /opencode-unity setup/);
  });

  it('refuses with exit 2 when Ollama is not reachable', async (t) => {
    const harness = await createHarness(t);
    harness.ollama.overrideRoute('/api/version', { status: 500, body: { error: 'down' } });

    const result = await harness.run('health');

    assert.equal(result.exitCode, EXIT.RUNTIME);
    assert.match(result.message, /HTTP 500/);
  });

  it('refuses with exit 2 while the guard blocks, and says to do it yourself', async (t) => {
    const harness = await createHarness(t, { loaded: false });

    const result = await harness.run('health', { guardBlocked: true });

    assert.equal(result.exitCode, EXIT.BLOCKED);
    assert.equal(result.data.orchestratorAction, 'do_it_yourself');
    assert.match(result.message, /Do the work yourself/);
    assert.equal(result.data.guard.verdict, 'blocked');
  });

  it('warns when the installed model no longer matches the profile', async (t) => {
    const harness = await createHarness(t, {
      models: [{ name: `${MODEL_TAG}:latest`, parameters: { num_ctx: 8192, temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 } }],
    });

    const result = await harness.run('health');

    assert.equal(result.exitCode, EXIT.OK);
    assert.deepEqual(result.data.parameterMismatches, [{ id: 'num_ctx', expected: '16384', actual: '8192' }]);
    assert.ok(result.warnings.some((warning) => /does not match the profile/.test(warning)));
  });

  it('warns when the model is loaded at another context', async (t) => {
    const harness = await createHarness(t);
    harness.ollama.loadModel(`${MODEL_TAG}:latest`, { contextLength: 32_768 });
    const result = await harness.run('health');
    assert.ok(result.warnings.some((warning) => /loaded at context 32768/.test(warning)));
  });
});

describe('delegate ledger', () => {
  it('reports nothing when no job has run', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('ledger');
    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.jobs, 0);
    assert.match(result.message, /0 delegate jobs/);
  });

  it('summarizes the jobs that ran', async (t) => {
    const harness = await createHarness(t);
    harness.ollama.enqueueChat(reply('one'), reply('two'));
    await harness.run('ask', { options: { task: 'a' } });
    await harness.run('ask', { options: { task: 'b' } });

    const result = await harness.run('ledger');

    assert.equal(result.data.jobs, 2);
    assert.deepEqual(result.data.byStatus, { ok: 2 });
    assert.equal(result.data.estimatedInputTokensAvoided, 0, 'no source files were avoided');
    assert.ok(result.data.usableLocalTokens > 0);
    assert.match(result.data.estimateNote, /estimate/);
  });

  it('honours --since', async (t) => {
    const harness = await createHarness(t);
    await appendLedger(harness.paths.delegateLedger, {
      jobId: 'old', command: 'ask', cwd: harness.cwd, fileCount: 0, localInputChars: 0, summaryChars: 0,
      promptTokens: 10, outputTokens: 5, seconds: 1, status: 'ok', exitCode: 0, timestamp: '2026-01-01T00:00:00.000Z',
    });
    harness.ollama.enqueueChat(reply('now'));
    await harness.run('ask', { options: { task: 'a' } });

    assert.equal((await harness.run('ledger', { options: { since: '1d' } })).data.jobs, 1);
    assert.equal((await harness.run('ledger')).data.jobs, 2);
  });

  it('refuses a --since it cannot read', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('ledger', { options: { since: 'yesterday' } });
    assert.equal(result.exitCode, EXIT.USAGE);
  });
});

describe('delegate restore', () => {
  it('puts the files of an apply job back', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', 'int health = 100;\n');
    harness.ollama.enqueueChat(reply(editBlock('Player.cs', 'int health = 100;', 'int health = 200;')));
    const review = await harness.run('edit', { options: { task: 'raise it', files: ['Player.cs'] } });
    const applied = await harness.run('apply', { args: { reviewId: review.data.reviewId } });
    assert.equal(await harness.readFile('Player.cs'), 'int health = 200;\n');

    const result = await harness.run('restore', { args: { jobId: applied.data.jobId } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.deepEqual(result.data.restored, ['Player.cs']);
    assert.equal(await harness.readFile('Player.cs'), 'int health = 100;\n');
  });

  it('refuses a job id that applied nothing', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('restore', { args: { jobId: '20260918-093000-apply-000001' } });
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.equal(result.code, 'job_not_found');
  });
});

describe('refusals of the whole lane', () => {
  it('exits 8 with do_it_yourself when delegation is switched off', () => {
    // `delegate.enabled` is not in the config schema yet (S32/S04 request in the step report), so the
    // switch is exercised where it is decided rather than through config.json.
    const error = catchError(() => assertDelegationEnabled(/** @type {any} */ ({ delegate: { enabled: false } })));
    assert.equal(error.exitCode, EXIT.UNSUPPORTED);
    assert.equal(error.code, 'delegate_unsupported');
    assert.equal(error.data.orchestratorAction, 'do_it_yourself');
    assert.match(error.hint, /Do this task yourself/);
  });

  it('exits 6 with retry_later when another command holds the GPU lock', async (t) => {
    const harness = await createHarness(t, { config: { delegate: { lockTimeoutSec: 0 } } });
    await fs.mkdir(path.dirname(harness.paths.gpuLock), { recursive: true });
    const stamp = new Date().toISOString();
    await fs.writeFile(
      harness.paths.gpuLock,
      JSON.stringify({ pid: process.pid, command: 'warm', startedAt: stamp, heartbeatAt: stamp, timeoutSec: 600, token: 'held-by-another-command' }),
      'utf8',
    );

    const result = await harness.run('ask', { options: { task: 'a' } });

    assert.equal(result.exitCode, EXIT.LOCK_TIMEOUT);
    assert.equal(result.code, 'lock_timeout');
    assert.equal(result.data.orchestratorAction, 'retry_later');
    assert.equal(harness.ollama.chatRequests.length, 0);
  });

  it('runs when the switch is absent or on', () => {
    assert.doesNotThrow(() => assertDelegationEnabled(/** @type {any} */ ({ delegate: {} })));
    assert.doesNotThrow(() => assertDelegationEnabled(/** @type {any} */ ({ delegate: { enabled: true } })));
  });

  it('refuses an unknown subcommand', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('nonsense', { options: {} });
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.match(result.message, /Unknown delegate subcommand/);
  });

  it('works before setup has rendered a profile, and says the values came from config.json', async (t) => {
    const harness = await createHarness(t, { renderProfile: false });
    harness.ollama.enqueueChat(reply('ok'));

    const result = await harness.run('ask', { options: { task: 'a' } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.ok(result.warnings.some((warning) => /no rendered profile/i.test(warning)));
  });

  it('refuses a profile file that cannot be used', async (t) => {
    const harness = await createHarness(t);
    await fs.writeFile(harness.paths.profile((await import('../../src/cli/version.js')).CLI_VERSION).runtimeProfile, '{ not json', 'utf8');
    const result = await harness.run('health');
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.equal(result.code, 'profile_invalid');
  });
});

describe('--check auto', () => {
  /**
   * @param {import('./helpers.mjs').DelegateHarness} harness
   */
  async function writeProjectFacts(harness) {
    await harness.writeFile('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.30f1\n');
    await harness.writeFile('Assets/Game/Player.cs', 'int health = 100;\n');
    const projectDir = harness.paths.project(getProjectId(harness.cwd)).dir;
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        compileMap: [
          { prefix: 'Assets/Game/', assembly: 'Game', csproj: 'Game.csproj', command: getCompileCommand('Game.csproj'), source: 'asmdef', generated: true },
          { prefix: 'Assets/', assembly: 'Assembly-CSharp', csproj: 'Assembly-CSharp.csproj', command: getCompileCommand('Assembly-CSharp.csproj'), source: 'default', generated: true },
        ],
      }),
      'utf8',
    );
  }

  it('resolves the compile command of the edited assembly', async (t) => {
    const harness = await createHarness(t);
    await writeProjectFacts(harness);
    harness.ollama.enqueueChat(reply(editBlock('Assets/Game/Player.cs', 'int health = 100;', 'int health = 200;')));
    const review = await harness.run('edit', { options: { task: 'raise it', files: ['Assets/Game/Player.cs'] } });

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId }, options: { check: 'auto' } });

    // dotnet is not installed in the sandbox, so the check cannot start; what matters is which command
    // was chosen and that a failed check puts the file back.
    assert.equal(result.exitCode, EXIT.CHECK_FAILED);
    assert.match(result.message, /dotnet build Game\.csproj/);
    assert.equal(await harness.readFile('Assets/Game/Player.cs'), 'int health = 100;\n');
  });

  it('refuses when the project has no facts yet', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', 'int health = 100;\n');
    harness.ollama.enqueueChat(reply(editBlock('Player.cs', 'int health = 100;', 'int health = 200;')));
    const review = await harness.run('edit', { options: { task: 'raise it', files: ['Player.cs'] } });

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId }, options: { check: 'auto' } });

    assert.equal(result.exitCode, EXIT.USAGE);
    assert.match(result.message, /needs the project facts/);
    assert.equal(await harness.readFile('Player.cs'), 'int health = 100;\n', 'nothing is applied when the check cannot be resolved');
  });
});
