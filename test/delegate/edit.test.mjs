// `delegate edit` (dry run) and `delegate apply <reviewId>` end to end (spec 12.2). The property under
// test throughout: what lands on disk is byte for byte what the reviewer read, or nothing at all.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { readLedger } from '../../src/delegate/ledger.js';
import { createHarness, editBlock, reply } from './helpers.mjs';

const SOURCE = 'public class Player {\n  int health = 100;\n}\n';

/**
 * Runs a dry run that changes `health` and returns its review id.
 * @param {import('./helpers.mjs').DelegateHarness} harness
 * @param {{ task?: string }} [options]
 */
async function dryRun(harness, { task = 'raise the health to 200' } = {}) {
  harness.ollama.enqueueChat(reply(editBlock('Player.cs', '  int health = 100;', '  int health = 200;')));
  return harness.run('edit', { options: { task, files: ['Player.cs'] } });
}

describe('delegate edit (dry run)', () => {
  it('validates the blocks, writes a diff and a review, and changes no file', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);

    const result = await dryRun(harness);

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.status, 'dry_run');
    assert.match(result.data.reviewId, /^\d{8}-\d{6}-edit-\d{6}\.[0-9a-f]{8}$/);
    assert.match(result.data.summary, /-  int health = 100;/);
    assert.match(result.data.summary, /\+  int health = 200;/);
    assert.equal(await harness.readFile('Player.cs'), SOURCE, 'a dry run never writes');
    const jobDir = path.join(harness.paths.delegateResults, result.data.jobId);
    assert.ok((await fs.stat(path.join(jobDir, 'review.json'))).isFile());
    assert.match(await fs.readFile(path.join(jobDir, 'proposed.diff'), 'utf8'), /^--- a\/Player\.cs/m);
  });

  it('tells the model the allow-list and sends the file as untrusted data', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    await dryRun(harness);
    const user = harness.ollama.chatRequests[0].messages[1].content;
    assert.match(user, /ALLOWED FILES:\n- Player\.cs/);
    assert.match(user, /UNTRUSTED DATA/);
  });

  it('retries once with the validation errors, then succeeds', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    harness.ollama.enqueueChat(
      reply(editBlock('Player.cs', 'int health = 999;', 'int health = 200;')),
      reply(editBlock('Player.cs', '  int health = 100;', '  int health = 200;')),
    );

    const result = await harness.run('edit', { options: { task: 'raise the health', files: ['Player.cs'] } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(harness.ollama.chatRequests.length, 2);
    assert.match(harness.ollama.chatRequests[1].messages[1].content, /PREVIOUS ATTEMPT FAILED VALIDATION/);
    const jobDir = path.join(harness.paths.delegateResults, result.data.jobId);
    assert.match(await fs.readFile(path.join(jobDir, 'attempt-1.errors.txt'), 'utf8'), /does not exist in the file/);
  });

  it('gives up after the retry with exit 4 and the reasons', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const bad = reply(editBlock('Player.cs', 'int health = 999;', 'int health = 200;'));
    harness.ollama.enqueueChat(bad, bad);

    const result = await harness.run('edit', { options: { task: 'raise the health', files: ['Player.cs'] } });

    assert.equal(result.exitCode, EXIT.VALIDATION);
    assert.equal(result.code, 'edit_invalid');
    assert.match(result.message, /failed validation after 2 attempt\(s\); nothing was applied/);
    assert.match(result.data.summary, /does not exist in the file/);
    assert.equal(await harness.readFile('Player.cs'), SOURCE);
  });

  it('throws the blocks away when the model saw a truncated prompt', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    harness.ollama.enqueueChat(reply(editBlock('Player.cs', '  int health = 100;', '  int health = 200;'), { promptTokens: 16_384 }));

    const result = await harness.run('edit', { options: { task: 'raise the health', files: ['Player.cs'] } });

    assert.equal(result.exitCode, EXIT.BUDGET);
    assert.equal(result.code, 'context_overflow');
    assert.equal(result.data.reviewId, undefined, 'nothing is saved for review');
    assert.equal(await harness.readFile('Player.cs'), SOURCE);
  });

  it('refuses a block for a file outside the allow-list', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    await harness.writeFile('Secret.cs', 'class Secret {}\n');
    const bad = reply(editBlock('Secret.cs', 'class Secret {}', 'class Secret { int x; }'));
    harness.ollama.enqueueChat(bad, bad);

    const result = await harness.run('edit', { options: { task: 'change it', files: ['Player.cs'] } });

    assert.equal(result.exitCode, EXIT.VALIDATION);
    assert.match(result.data.summary, /is not in the allow-list \(Player\.cs\)/);
    assert.equal(await harness.readFile('Secret.cs'), 'class Secret {}\n');
  });

  it('needs the exact files, not a glob', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const result = await harness.run('edit', { options: { task: 'change it', files: ['*.cs'] } });
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.match(result.message, /Globs are not allowed here/);
  });

  // Spec 12.2 validates every block against "target not a protected Unity file", and spec 15's S4
  // names the delegate validator as one of the three enforcement points. This lane writes with
  // `fs.writeFile`, so neither of the other two - permissions and the shell guard - ever sees it.
  it('refuses a protected Unity file before any GPU work, for every edit tuple of spec 8.5.4', async (t) => {
    const protectedPaths = [
      'Assets/Scenes/Main.unity',
      'Assets/UI/Menu.prefab',
      'Assets/Data/Config.asset',
      'Assets/Scripts/Player.cs.meta',
      'Assets/Game.asmdef',
      'Assembly-CSharp.csproj',
      'ProjectSettings/ProjectSettings.asset',
      'Packages/manifest.json',
    ];
    for (const relativePath of protectedPaths) {
      const harness = await createHarness(t);
      await harness.writeFile(relativePath, 'original\n');
      const result = await harness.run('edit', { options: { task: 'change it', files: [relativePath] } });
      assert.equal(result.exitCode, EXIT.USAGE, relativePath);
      assert.match(result.message, /is a protected Unity or project file/);
      assert.equal(harness.ollama.chatRequests.length, 0, `${relativePath} reached the model`);
      assert.equal(await harness.readFile(relativePath), 'original\n');
    }
  });

  it('refuses a block that names a protected file, whatever the allow-list holds', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    await harness.writeFile('Assets/Scenes/Main.unity', 'm_Name: Player\n');
    const bad = reply(editBlock('Assets/Scenes/Main.unity', 'm_Name: Player', 'm_Name: Pwned'));
    harness.ollama.enqueueChat(bad, bad);

    const result = await harness.run('edit', { options: { task: 'change it', files: ['Player.cs'] } });

    assert.equal(result.exitCode, EXIT.VALIDATION);
    assert.match(result.data.summary, /is a protected Unity or project file/);
    assert.equal(await harness.readFile('Assets/Scenes/Main.unity'), 'm_Name: Player\n');
  });

  it('refuses an unusable check command before any GPU work', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const result = await harness.run('edit', { options: { task: 'change it', files: ['Player.cs'], check: 'rm -rf /' } });
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.match(result.message, /--check refused/);
    assert.equal(harness.ollama.chatRequests.length, 0);
  });
});

describe('delegate apply', () => {
  it('applies exactly the reviewed diff, without another model call', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const review = await dryRun(harness);

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.status, 'applied');
    assert.equal(await harness.readFile('Player.cs'), 'public class Player {\n  int health = 200;\n}\n');
    assert.equal(harness.ollama.chatRequests.length, 1, 'apply never calls the model');
    assert.match(result.data.summary, /diff is not repeated .*Player\.cs \+1 -1/);
  });

  it('keeps a backup and records the applied files', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const review = await dryRun(harness);

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    const jobDir = path.join(harness.paths.delegateResults, result.data.jobId);
    assert.equal(await fs.readFile(path.join(jobDir, 'backup', 'Player.cs'), 'utf8'), SOURCE);
    assert.deepEqual(result.data.appliedFiles, ['Player.cs']);
  });

  it('refuses a review id it does not know', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run('apply', { args: { reviewId: '20260918-093000-edit-000001.deadbeef' } });
    assert.equal(result.exitCode, EXIT.VALIDATION);
    assert.equal(result.code, 'review_not_found');
  });

  it('refuses a review whose file changed since it was reviewed', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const review = await dryRun(harness);
    await harness.writeFile('Player.cs', 'public class Player {\n  int health = 150;\n}\n');

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    assert.equal(result.exitCode, EXIT.VALIDATION);
    assert.equal(result.code, 'review_stale');
    assert.match(result.message, /changed since dry run/);
    assert.equal(await harness.readFile('Player.cs'), 'public class Player {\n  int health = 150;\n}\n');
  });

  it('refuses to apply the same review twice', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const review = await dryRun(harness);
    await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    const second = await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    assert.equal(second.exitCode, EXIT.VALIDATION);
    assert.equal(second.code, 'review_stale');
  });

  it('runs the check command and keeps the edit when it passes', async (t) => {
    const harness = await createHarness(t, { config: { delegate: { checkCommandPrefixes: ['node '] } } });
    await harness.writeFile('Player.cs', SOURCE);
    await harness.writeFile('check.mjs', "process.stdout.write('build ok\\n');\n");
    const review = await dryRun(harness);

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId }, options: { check: 'node check.mjs' } });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.data.check, 'passed');
    assert.equal(await harness.readFile('Player.cs'), 'public class Player {\n  int health = 200;\n}\n');
  });

  it('restores every file and exits 5 when the check fails', async (t) => {
    const harness = await createHarness(t, { config: { delegate: { checkCommandPrefixes: ['node '] } } });
    await harness.writeFile('Player.cs', SOURCE);
    await harness.writeFile('check.mjs', "process.stderr.write('CS0103: the name does not exist\\n');\nprocess.exit(1);\n");
    const review = await dryRun(harness);

    const result = await harness.run('apply', { args: { reviewId: review.data.reviewId }, options: { check: 'node check.mjs' } });

    assert.equal(result.exitCode, EXIT.CHECK_FAILED);
    assert.equal(result.code, 'check_failed');
    assert.equal(result.data.status, 'check_failed_restored');
    assert.deepEqual(result.data.restored, ['Player.cs']);
    assert.equal(await harness.readFile('Player.cs'), SOURCE, 'a failed check leaves the tree as it was');
    assert.match(result.data.summary, /CHECK OUTPUT \(tail\)/);
    assert.match(result.data.summary, /CS0103/);
    const checkOutput = await fs.readFile(result.data.resultPath, 'utf8');
    assert.match(checkOutput, /\$ node check\.mjs/);
  });

  it('records the job in the ledger whatever happened', async (t) => {
    const harness = await createHarness(t);
    await harness.writeFile('Player.cs', SOURCE);
    const review = await dryRun(harness);
    await harness.run('apply', { args: { reviewId: review.data.reviewId } });

    const entries = await readLedger(harness.paths.delegateLedger);
    assert.deepEqual(entries.map((entry) => `${entry.command}:${entry.status}`), ['edit:dry_run', 'apply:applied']);
    assert.equal(entries[1].promptTokens, 0, 'apply spends no local tokens');
  });
});
