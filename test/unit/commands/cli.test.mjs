// The six session commands through the real binary: parser, registry, module and envelope together.
// Nothing here reaches Ollama or OpenCode; every run stops before either would be needed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readEnvelope, runCli } from '../../helpers/run-cli.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';
import { materializeFixtureProject } from '../unity/fixture-projects.mjs';

/**
 * An environment whose PATH finds nothing, so `init` cannot start a real `dotnet` and `start` cannot
 * find a real OpenCode. Every spelling of the variable is replaced, because Windows has two.
 * @param {import('../../helpers/sandbox.mjs').Sandbox} sandbox
 * @returns {Record<string, string | undefined>}
 */
function emptyPath(sandbox) {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const name of Object.keys(sandbox.env)) if (name.toUpperCase() === 'PATH') env[name] = sandbox.dirs.tmp;
  env.PATH = sandbox.dirs.tmp;
  return env;
}

describe('session commands through the binary', () => {
  it('refuses an auto-approval flag on start before anything runs', async (t) => {
    const sandbox = await useSandbox(t, 'cli-start-auto');
    const result = await runCli(['start', '--yolo', '--json'], { sandbox });
    assert.equal(result.code, 1);
    const envelope = readEnvelope(result);
    assert.equal(envelope.code, 'refused_option');
  });

  it('exits 1 with the init hint for a project without facts', async (t) => {
    const sandbox = await useSandbox(t, 'cli-start-uninit');
    const root = materializeFixtureProject('u6-hg-minimal', path.join(sandbox.root, 'project'));
    const result = await runCli(['start', root, '--json'], { sandbox, env: emptyPath(sandbox) });
    // The support matrix decides first; on a refused platform the answer is exit 8, which is also correct.
    const envelope = readEnvelope(result);
    if (envelope.exitCode === 8) return;
    assert.equal(envelope.exitCode, 1);
    assert.equal(envelope.code, 'project_not_initialized');
  });

  it('prints the facts with init --print and writes nothing', async (t) => {
    const sandbox = await useSandbox(t, 'cli-init-print');
    const root = materializeFixtureProject('u6-hg-minimal', path.join(sandbox.root, 'project'));
    const result = await runCli(['init', root, '--print', '--json'], { sandbox, env: emptyPath(sandbox) });
    const envelope = readEnvelope(result);
    assert.equal(envelope.exitCode, 0, result.stderr);
    assert.match(String(envelope.data.facts), /opencode-unity/);
    assert.match(envelope.message, /nothing was written/);
  });
});
