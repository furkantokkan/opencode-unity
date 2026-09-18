// `opencode-unity doctor` through the real CLI entry (`main`), with the doctor context's I/O injected.
// The first case is the in-process twin of the CI macos-smoke job: an unconfigured macOS machine,
// a fixture project, `--json`, exit 0 and the honest degraded tier.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../../src/cli/main.js';
import { COMMANDS } from '../../src/cli/registry.js';
import { DEEP_NOTICE, run as runDoctor } from '../../src/commands/doctor.js';
import { copyFixture } from '../helpers/fixture-fs.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';
import { MAC_FACTS, WINDOWS_FACTS } from './helpers.mjs';

/** @returns {{ write: (text: string) => void, text: () => string }} */
function collector() {
  let buffer = '';
  return { write: (text) => { buffer += text; }, text: () => buffer };
}

async function noProcess() {
  return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), durationMs: 0 };
}

function blockedProbes() {
  const error = 'Unity process checks are not implemented on this platform in this version';
  return {
    readOllamaPs: async () => ({ ok: false, error: 'fetch failed' }),
    readNvidiaSmi: async () => ({ ok: false, error: 'nvidia-smi was not found' }),
    processes: { platform: 'test', detect: async () => ({ ok: false, error }), sample: async () => ({ ok: false, error }) },
    sleep: async () => {},
    now: () => Date.parse('2026-09-18T10:00:00.000Z'),
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} options
 * @param {string[]} options.argv
 * @param {import('../../src/core/platform.js').PlatformFacts} [options.facts]
 * @param {Record<string, string>} [options.env]
 * @param {boolean} [options.installed]
 * @param {boolean} [options.interactive]
 * @param {Record<string, any>} [options.deps]
 * @param {(sandbox: import('../helpers/sandbox.mjs').Sandbox) => Promise<void>} [options.prepare]
 */
async function runCli(t, { argv, facts = MAC_FACTS, env = {}, installed = false, interactive = false, deps = {}, prepare }) {
  const sandbox = await useSandbox(t, 'doctor-command');
  const project = await copyFixture('unity-projects/u6-urp-ugui-git', sandbox.path('project'));
  await fs.mkdir(sandbox.productHome, { recursive: true });
  if (installed) await fs.writeFile(path.join(sandbox.productHome, 'config.json'), JSON.stringify({ schemaVersion: 1, ollama: { baseUrl: 'http://127.0.0.1:9' } }));
  await prepare?.(sandbox);
  const stdout = collector();
  const stderr = collector();
  const doctorDeps = {
    platformFacts: facts,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    run: noProcess,
    locate: () => null,
    probes: blockedProbes(),
    homedir: sandbox.dirs.home,
    readLogFile: async () => null,
    isWritable: () => true,
    ...deps,
  };
  const exitCode = await main(argv, {
    stdout,
    stderr,
    env: { ...sandbox.env, OPENCODE_UNITY_HOME: sandbox.productHome, ...env },
    cwd: project,
    platformFacts: facts,
    interactive,
    stdin: /** @type {any} */ (null),
    loadCommand: async () => ({ run: (/** @type {any} */ context) => runDoctor(context, { deps: doctorDeps }) }),
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text(), sandbox, project };
}

describe('doctor --json (the macos-smoke case)', () => {
  it('exits 0 on an unconfigured macOS machine and reports the degraded tier first', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--json'] });
    assert.equal(result.exitCode, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'doctor');
    assert.equal(envelope.data.platform.os, 'darwin');
    assert.equal(envelope.data.platform.tier, 'degraded');
    assert.deepEqual(envelope.data.platform.notMeasured, ['accelerator.utilization']);
    assert.equal(envelope.data.scope, 'not-installed');
    assert.equal(Object.keys(envelope.data)[0], 'platform');
    assert.equal(envelope.data.checks.filter((/** @type {any} */ check) => check.severity === 'error').length, 0);
    const reachable = envelope.data.checks.find((/** @type {any} */ check) => check.id === 'ollama.reachable');
    assert.equal(reachable.severity, 'warn');
    assert.equal(reachable.loweredBy, 'not-installed');
  });

  it('exits 5 on the same machine once it is set up, because the errors are real then', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--json'], installed: true });
    assert.equal(result.exitCode, 5);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 'check_failed');
    assert.equal(envelope.data.scope, 'installed');
    assert.ok(envelope.data.checks.some((/** @type {any} */ check) => check.id === 'ollama.reachable' && check.severity === 'error'));
  });

  it('exits 5 under --strict when warnings remain', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--json', '--strict'] });
    assert.equal(result.exitCode, 5);
  });

  it('keeps the WSL error even before setup (CP-D11)', async (t) => {
    const wsl = { ...MAC_FACTS, os: /** @type {NodeJS.Platform} */ ('linux'), arch: 'x64', virtualization: /** @type {'wsl'} */ ('wsl'), virtualizationSignals: ['WSL_DISTRO_NAME'], backend: /** @type {'nvidia-smi'} */ ('nvidia-smi') };
    const result = await runCli(t, { argv: ['doctor', '--json'], facts: wsl });
    assert.equal(result.exitCode, 5);
    const envelope = JSON.parse(result.stdout);
    assert.ok(envelope.data.checks.some((/** @type {any} */ check) => check.id === 'platform.virtualized-host' && check.severity === 'error'));
  });
});

describe('doctor [path] and --project', () => {
  it('judges the directory given by --project instead of the working directory', async (t) => {
    const elsewhere = await useSandbox(t, 'doctor-elsewhere');
    const result = await runCli(t, { argv: ['doctor', '--json', '--project', elsewhere.dirs.tmp] });
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.project.root, null);
    assert.equal(path.resolve(envelope.data.project.path), path.resolve(elsewhere.dirs.tmp));
  });

  it('prefers the positional path over --project', async (t) => {
    const elsewhere = await useSandbox(t, 'doctor-positional');
    const result = await runCli(t, { argv: ['doctor', elsewhere.dirs.tmp, '--json', '--project', '.'] });
    assert.equal(path.resolve(JSON.parse(result.stdout).data.project.path), path.resolve(elsewhere.dirs.tmp));
  });
});

describe('doctor text report', () => {
  it('prints the platform block as the first section and the summary last', async (t) => {
    const result = await runCli(t, { argv: ['doctor'], facts: WINDOWS_FACTS });
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'Platform support');
    assert.match(lines.at(-1) ?? '', /^\d+ errors?, \d+ warnings?, \d+ notes? \(/);
    assert.match(result.stdout, /reported as warn because opencode-unity is not set up/);
    assert.match(result.stdout, /Next steps/);
  });

  it('shows clean and skipped checks with --verbose', async (t) => {
    const quiet = await runCli(t, { argv: ['doctor'] });
    const verbose = await runCli(t, { argv: ['doctor', '--verbose'] });
    assert.doesNotMatch(quiet.stdout, / skipped +platform\.virtualized-host/);
    assert.match(verbose.stdout, /skipped +platform\.virtualized-host/);
  });
});

describe('doctor --markdown and --redact', () => {
  it('produces an issue-ready report with the planted private values removed', async (t) => {
    const secret = 'sk-proj-PLANTEDSECRETVALUE0123456789';
    const email = 'reporter@example.com';
    // Two MCP entries with one URL make mcp.duplicate-server print that URL, so the markers reach the
    // report and the redactor has something real to remove.
    const url = `http://127.0.0.1:8080/mcp?owner=${email}&key=${secret}`;
    const plantMarkers = async (/** @type {import('../helpers/sandbox.mjs').Sandbox} */ sandbox) => {
      await fs.writeFile(sandbox.path('project', 'opencode.json'), JSON.stringify({ mcp: { first: { url }, second: { url } } }));
    };
    const plain = await runCli(t, { argv: ['doctor'], prepare: plantMarkers });
    assert.ok(plain.stdout.includes(secret), 'the marker never reached the report, so the redaction case proves nothing');

    const result = await runCli(t, { argv: ['doctor', '--markdown'], env: { OPENAI_API_KEY: secret }, prepare: plantMarkers });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^# opencode-unity doctor /);
    assert.match(result.stdout, /## Platform/);
    assert.match(result.stdout, /\| Doctor tier \| degraded/);
    assert.ok(!result.stdout.includes(secret), 'the key value leaked');
    assert.ok(!result.stdout.includes(email), 'the email leaked');
    assert.ok(!result.stdout.includes(result.sandbox.dirs.home), 'the home path leaked');
    assert.ok(!result.stdout.includes(result.project), 'the project path leaked');
    assert.match(result.stdout, /<home>/);
    assert.match(result.stdout, /<email>/);
  });

  it('adds the markdown to the JSON envelope, redacted', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--markdown', '--json'] });
    const envelope = JSON.parse(result.stdout);
    assert.equal(typeof envelope.data.markdown, 'string');
    assert.ok(!JSON.stringify(envelope).includes(result.project), 'the project path leaked into the envelope');
  });

  it('redacts the JSON data with --redact alone', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--json', '--redact'] });
    const envelope = JSON.parse(result.stdout);
    assert.ok(!JSON.stringify(envelope.data).includes(result.sandbox.dirs.home));
  });

  it('reports a base URL with a password in it as a finding, and never prints the password (P5)', async (t) => {
    const password = 'PLANTEDBASEURLPASSWORD0123';
    const plantUrl = async (/** @type {import('../helpers/sandbox.mjs').Sandbox} */ sandbox) => {
      await fs.writeFile(path.join(sandbox.productHome, 'config.json'), JSON.stringify({ schemaVersion: 1, ollama: { baseUrl: `http://admin:${password}@127.0.0.1:9` } }));
    };
    for (const argv of [['doctor', '--markdown'], ['doctor', '--json', '--redact'], ['doctor', '--json'], ['doctor']]) {
      const result = await runCli(t, { argv, prepare: plantUrl });
      assert.ok(!`${result.stdout}${result.stderr}`.includes(password), `${argv.join(' ')} printed the password`);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('admin:'), `${argv.join(' ')} printed the user`);
      assert.equal(result.exitCode, 5, `${argv.join(' ')}: a full report with the error, not an abort: ${result.stderr}`);
    }
    const json = JSON.parse((await runCli(t, { argv: ['doctor', '--json'], prepare: plantUrl })).stdout);
    const reachable = json.data.checks.find((/** @type {{ id: string }} */ check) => check.id === 'ollama.reachable');
    assert.equal(reachable.severity, 'error');
    assert.match(JSON.stringify(reachable), /user name, password, query or fragment is not allowed/);
  });
});

describe('doctor --explain', () => {
  it('prints one check with its range, rationale, fix and source', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--explain', 'logs.truncation'] });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^logs\.truncation {2}Prompts the server truncated/);
    assert.match(result.stdout, /reports +ERROR or WARN/);
    assert.match(result.stdout, /source +Ollama/);
  });

  it('returns the same fields in JSON', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--explain', 'platform.virtualized-host', '--json'] });
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.id, 'platform.virtualized-host');
    assert.equal(envelope.data.alwaysSevere, true);
  });

  it('exits 1 for an unknown check id', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--explain', 'no.such-check', '--json'] });
    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 'unknown_check');
    assert.ok(envelope.data.known.includes('ollama.reachable'));
  });
});

describe('doctor modes that need a later step', () => {
  for (const flag of ['--capture', '--selftest']) {
    it(`${flag} exits 8 and names what is missing`, async (t) => {
      const result = await runCli(t, { argv: ['doctor', flag, '--json'] });
      assert.equal(result.exitCode, 8);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.code, 'prerequisite_missing');
      assert.match(envelope.message, /not available in this build/);
    });
  }
});

describe('doctor --deep', () => {
  it('prints the side-effect notice on stderr, keeping stdout a single envelope', async (t) => {
    const result = await runCli(t, { argv: ['doctor', '--deep', '--json'], deps: { runDeep: async () => ({ config: { label: 'debug config', args: [], exitCode: 1, value: null, error: 'x' }, agents: [], ok: false }) } });
    assert.ok(result.stderr.includes(DEEP_NOTICE));
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  });

  it('does not start OpenCode without the flag', async (t) => {
    let calls = 0;
    await runCli(t, { argv: ['doctor', '--json'], deps: { runDeep: async () => { calls += 1; return /** @type {any} */ ({}); } } });
    assert.equal(calls, 0);
  });

  it('runs the deep probes and reports them in the envelope', async (t) => {
    let calls = 0;
    const runDeep = async () => {
      calls += 1;
      return { config: { label: 'debug config', args: [], exitCode: 0, value: { permission: { bash: 'allow' } }, error: null }, agents: [], ok: true };
    };
    const result = await runCli(t, { argv: ['doctor', '--deep', '--json'], deps: { runDeep } });
    assert.equal(calls, 1);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.data.opencode.deep, { ok: true });
    const vcs = envelope.data.checks.find((/** @type {any} */ check) => check.id === 'permissions.vcs-writes');
    assert.equal(vcs.declaredSeverity, 'error');
    assert.equal(vcs.data.merged, true);
  });

  it('probes the clean-room launch environment with --profile, and the caller\'s own without it (spec 5.4, 8.1)', async (t) => {
    /** @type {Array<Record<string, string | undefined>>} */
    const seen = [];
    const runDeep = async (/** @type {{ env: Record<string, string | undefined> }} */ input) => {
      seen.push(input.env);
      return { config: { label: 'debug config', args: [], exitCode: 0, value: {}, error: null }, agents: [], ok: true };
    };
    const env = { OPENAI_API_KEY: 'sk-planted-not-forwarded', OPENCODE_PERMISSION: '{"bash":"allow"}' };
    const profiled = await runCli(t, { argv: ['doctor', '--deep', '--profile', '--json'], env, deps: { runDeep } });
    const own = await runCli(t, { argv: ['doctor', '--deep', '--json'], env, deps: { runDeep } });
    assert.equal(seen.length, 2);

    const [clean, caller] = seen;
    const home = profiled.sandbox.productHome;
    assert.equal(clean.OPENCODE_UNITY_HOME, home);
    assert.equal(path.relative(home, /** @type {string} */ (clean.OPENCODE_CONFIG_DIR)).split(path.sep)[0], 'profile');
    assert.equal(path.relative(home, /** @type {string} */ (clean.XDG_CONFIG_HOME)), 'xdg-config');
    assert.equal(clean.OPENCODE_DISABLE_CLAUDE_CODE, '1');
    assert.equal(clean.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(clean.OPENAI_API_KEY, undefined, 'a cloud key never reaches the probe');
    assert.equal(clean.OPENCODE_PERMISSION, undefined, 'an inherited permission override is dropped');

    assert.equal(caller.OPENAI_API_KEY, 'sk-planted-not-forwarded', 'without the profile the user\'s own setup is probed as it is');
    assert.equal(caller.OPENCODE_CONFIG_DIR, undefined);
    assert.equal(own.exitCode, profiled.exitCode);
  });
});

describe('the registry entry', () => {
  it('names only the exit codes the command can produce', () => {
    const doctor = COMMANDS.find((command) => command.name === 'doctor');
    assert.ok(doctor);
    // 8 is --capture and --selftest reporting `prerequisite_missing` until they land.
    for (const code of [0, 1, 5, 7, 8]) assert.ok(doctor.exitCodes.includes(code), `exit ${code}`);
  });
});
