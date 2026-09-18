// Every check with a positive and a negative case (spec 20.2 `doctor/*`). The healthy baseline comes
// from helpers.mjs; each case changes one fact.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECKS, findCheck } from '../../src/doctor/checks/index.js';
import { isLoopbackHostValue } from '../../src/doctor/checks/ollama.js';
import { runChecks } from '../../src/doctor/engine.js';
import { DEEP_LAYER_PATH } from '../../src/doctor/layers.js';
import { emptySummary, healthyLayer, healthyScan, makeContext, passingVerdict, profilePermission, runOne } from './helpers.mjs';

/**
 * @param {string} id
 * @param {import('../../src/doctor/context.js').DoctorContext} context
 */
function outcome(id, context) {
  const check = findCheck(id);
  assert.ok(check, `no check '${id}'`);
  const findings = runOne(check, context);
  assert.equal(findings.length, 1, `${id} produced ${findings.length} findings`);
  return findings[0];
}

describe('the healthy baseline', () => {
  it('produces no error and no warning apart from the terminal host', () => {
    const report = runChecks(makeContext({ env: { WT_SESSION: 'test' } }), { checks: CHECKS });
    const loud = report.findings.filter((finding) => finding.severity === 'error' || finding.severity === 'warn');
    assert.deepEqual(loud.map((finding) => `${finding.id}: ${finding.message}`), []);
  });
});

describe('setup checks', () => {
  it('setup.not-installed is a note before setup and clean after', () => {
    assert.equal(outcome('setup.not-installed', makeContext({ home: { installed: false } })).severity, 'info');
    assert.equal(outcome('setup.not-installed', makeContext()).severity, 'pass');
  });

  it('config.valid reports a broken file as an error that the policy does not lower', () => {
    const finding = outcome('config.valid', makeContext({ home: { configError: 'Unexpected token' } }));
    assert.equal(finding.severity, 'error');
    assert.match(finding.message, /Unexpected token/);
  });

  it('config.valid warns about config values and skips when there is no file', () => {
    assert.equal(outcome('config.valid', makeContext({ home: { configWarnings: ['guard.x is replaced'] } })).severity, 'warn');
    assert.equal(outcome('config.valid', makeContext({ home: { installed: false } })).severity, 'skip');
    assert.equal(outcome('config.valid', makeContext()).severity, 'pass');
  });

  it('config.preset reports a missing preset, a failed profile and an experimental refusal', () => {
    assert.equal(outcome('config.preset', makeContext({ profileInfo: { presetError: 'no such preset' } })).severity, 'error');
    assert.equal(outcome('config.preset', makeContext({ profileInfo: { error: 'bad override' } })).severity, 'error');
    const refused = outcome('config.preset', makeContext({ profileInfo: { presetRefusal: 'experimental here' } }));
    assert.equal(refused.severity, 'warn');
    assert.deepEqual(refused.details, ['experimental here']);
    assert.equal(outcome('config.preset', makeContext()).severity, 'pass');
  });

  it('setup.profile-rendered warns when the installed version has no profile', () => {
    assert.equal(outcome('setup.profile-rendered', makeContext({ profileInfo: { rendered: false } })).severity, 'warn');
    assert.equal(outcome('setup.profile-rendered', makeContext({ home: { installed: false } })).severity, 'skip');
    assert.equal(outcome('setup.profile-rendered', makeContext()).severity, 'pass');
  });
});

describe('ollama and model checks', () => {
  it('ollama.reachable is an error when the server does not answer', () => {
    const finding = outcome('ollama.reachable', makeContext({ ollama: { reachable: false, error: 'ECONNREFUSED' } }));
    assert.equal(finding.severity, 'error');
    assert.deepEqual(finding.details, ['ECONNREFUSED']);
  });

  it('ollama.reachable is lowered to a warning before setup', () => {
    const finding = outcome('ollama.reachable', makeContext({ home: { installed: false }, ollama: { reachable: false, error: 'ECONNREFUSED' } }));
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.loweredBy, 'not-installed');
  });

  it('ollama.version warns on an older server and skips without one', () => {
    assert.equal(outcome('ollama.version', makeContext({ ollama: { version: '0.30.0' } })).severity, 'warn');
    assert.equal(outcome('ollama.version', makeContext({ ollama: { version: '9.0.0' } })).severity, 'pass');
    assert.equal(outcome('ollama.version', makeContext({ ollama: { version: null } })).severity, 'skip');
  });

  it('ollama.loopback warns on a remote endpoint', () => {
    const finding = outcome('ollama.loopback', makeContext({ ollama: { baseUrl: 'http://192.0.2.10:11434', loopback: false } }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.message, /not loopback/);
  });

  it('ollama.loopback warns when OLLAMA_HOST binds beyond this machine, in every accepted spelling', () => {
    for (const value of ['0.0.0.0', '0.0.0.0:11434', 'http://192.0.2.10:11434', '[::]:11434']) {
      const finding = outcome('ollama.loopback', makeContext({ env: { OLLAMA_HOST: value } }));
      assert.equal(finding.severity, 'warn', value);
      assert.match(finding.message, /OLLAMA_HOST/, value);
    }
    for (const value of ['127.0.0.1:11434', 'localhost', 'http://[::1]:11434', '']) {
      assert.equal(outcome('ollama.loopback', makeContext({ env: { OLLAMA_HOST: value } })).severity, 'pass', value);
    }
  });

  it('treats an OLLAMA_HOST that does not parse as not loopback', () => {
    assert.equal(isLoopbackHostValue('http://[not-an-address'), false);
    assert.equal(isLoopbackHostValue('127.0.0.1'), true);
  });

  it('ollama.loopback lists both problems when both apply', () => {
    const finding = outcome('ollama.loopback', makeContext({ env: { OLLAMA_HOST: '0.0.0.0' }, ollama: { baseUrl: 'http://192.0.2.10:11434', loopback: false } }));
    assert.equal(finding.details.length, 2);
  });

  it('model.installed is an error when the tag is missing', () => {
    const finding = outcome('model.installed', makeContext({ ollama: { models: [] } }));
    assert.equal(finding.severity, 'error');
    assert.equal(outcome('model.installed', makeContext({ ollama: { reachable: false } })).severity, 'skip');
    assert.equal(outcome('model.installed', makeContext()).severity, 'pass');
  });

  it('model.system-ignored warns on a baked-in SYSTEM prompt (E4)', () => {
    const context = makeContext();
    const show = { ...context.ollama.show, system: 'You are a helpful assistant.\nMore.' };
    const finding = outcome('model.system-ignored', makeContext({ ollama: { show } }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.details[0], /helpful assistant\.$/);
    assert.equal(outcome('model.system-ignored', makeContext({ ollama: { show: null } })).severity, 'skip');
  });

  it('model.num-ctx warns when num_ctx is absent or differs from the profile', () => {
    const context = makeContext();
    const absent = { ...context.ollama.show, parameters: {} };
    assert.match(outcome('model.num-ctx', makeContext({ ollama: { show: absent } })).message, /server default/);
    const other = { ...context.ollama.show, parameters: { num_ctx: [8192] } };
    assert.match(outcome('model.num-ctx', makeContext({ ollama: { show: other } })).message, /8192 while the profile expects/);
    assert.equal(outcome('model.num-ctx', context).severity, 'pass');
  });

  it('model.renderer warns when the renderer or the parser is wrong', () => {
    const context = makeContext();
    const wrong = { ...context.ollama.show, renderer: '', parser: 'other' };
    const finding = outcome('model.renderer', makeContext({ ollama: { show: wrong } }));
    assert.equal(finding.severity, 'warn');
    assert.deepEqual(finding.details, ["renderer is 'unset'", "parser is 'other'"]);
    assert.equal(outcome('model.renderer', context).severity, 'pass');
    assert.equal(outcome('model.renderer', makeContext({ profileInfo: { preset: null } })).severity, 'skip');
  });
});

describe('opencode checks', () => {
  it('opencode.version warns on an unreadable or untested version', () => {
    const missing = outcome('opencode.version', makeContext({ opencode: { binary: { path: null, version: null, error: "'opencode' is not on PATH" } } }));
    assert.equal(missing.severity, 'warn');
    assert.match(missing.message, /not on PATH/);
    assert.match(outcome('opencode.version', makeContext({ opencode: { binary: { path: 'x', version: '99.0.0', error: null } } })).message, /newer than/);
    assert.match(outcome('opencode.version', makeContext({ opencode: { binary: { path: 'x', version: '0.1.0', error: null } } })).message, /older than/);
    assert.equal(outcome('opencode.version', makeContext()).severity, 'pass');
  });

  it('opencode.no-limit is an error for a model entry without a limit (E7)', () => {
    const layer = healthyLayer({ provider: { ollama: { models: { 'qwen3-coder:30b': { temperature: true } } } } });
    const finding = outcome('opencode.no-limit', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.match(finding.details[0], /^ollama\/qwen3-coder:30b in /);
  });

  it('opencode.no-limit skips when no model entry exists', () => {
    const layer = { path: 'x', origin: 'user', value: {}, error: null };
    assert.equal(outcome('opencode.no-limit', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } })).severity, 'skip');
  });

  it('opencode.limit-exceeds-numctx compares with what the server reports', () => {
    const layer = healthyLayer({ provider: { p: { models: { m: { limit: { context: 32768, output: 4096 }, temperature: true } } } } });
    const finding = outcome('opencode.limit-exceeds-numctx', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.equal(finding.data.numCtx, 16384);
    assert.equal(outcome('opencode.limit-exceeds-numctx', makeContext()).severity, 'pass');
  });

  it('opencode.limit-exceeds-numctx falls back to the profile context size without /api/show', () => {
    const layer = healthyLayer({ provider: { p: { models: { m: { limit: { context: 20000, output: 4096 }, temperature: true } } } } });
    const finding = outcome('opencode.limit-exceeds-numctx', makeContext({ ollama: { show: null }, opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
  });

  it('opencode.limit-exceeds-numctx skips when nothing declares a limit', () => {
    const layer = healthyLayer({ provider: { p: { models: { m: { temperature: true } } } } });
    assert.equal(outcome('opencode.limit-exceeds-numctx', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } })).severity, 'skip');
    assert.equal(outcome('opencode.limit-exceeds-numctx', makeContext({ ollama: { show: null }, profileInfo: { runtime: null } })).severity, 'skip');
  });

  it('opencode.temperature-capability is an error without "temperature": true (E3)', () => {
    const layer = healthyLayer({ provider: { p: { models: { m: { limit: { context: 1, output: 0 } } } } } });
    assert.equal(outcome('opencode.temperature-capability', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } })).severity, 'error');
    assert.equal(outcome('opencode.temperature-capability', makeContext()).severity, 'pass');
  });

  it('opencode.config-unreadable warns about a file OpenCode would skip', () => {
    const broken = { path: 'broken.json', origin: 'user', value: null, error: 'Unexpected end' };
    const finding = outcome('opencode.config-unreadable', makeContext({ opencode: { config: { layers: [broken], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'warn');
    assert.equal(outcome('opencode.config-unreadable', makeContext({ opencode: { config: { layers: [], target: 'user', warnings: [] } } })).severity, 'skip');
  });

  it('prefers the merged configuration from --deep over the files', () => {
    const merged = { provider: { p: { models: { m: { limit: { context: 1, output: 0 } } } } } };
    const deep = { config: { label: 'debug config', args: [], exitCode: 0, value: merged, error: null }, agents: [], ok: true };
    const finding = outcome('opencode.temperature-capability', makeContext({ opencode: { deep } }));
    assert.equal(finding.severity, 'error');
    assert.match(finding.details[0], new RegExp(DEEP_LAYER_PATH));
  });
});

describe('instruction checks', () => {
  it('instructions.injected warns above the token threshold (E5)', () => {
    const scan = healthyScan({ instructionFiles: [{ path: '../AGENTS.md', scope: 'upward', chars: 7000, tokens: 2200 }] });
    const finding = outcome('instructions.injected', makeContext({ project: { scan } }));
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.data.tokens, 2200);
  });

  it('instructions.injected passes below the threshold and skips outside a project', () => {
    const scan = healthyScan({ instructionFiles: [{ path: 'AGENTS.md', scope: 'upward', chars: 700, tokens: 200 }] });
    assert.equal(outcome('instructions.injected', makeContext({ project: { scan } })).severity, 'pass');
    assert.equal(outcome('instructions.injected', makeContext({ project: { scan: null } })).severity, 'skip');
  });

  it('instructions.nested warns for every nested file', () => {
    const scan = healthyScan({ instructionFiles: [{ path: 'Assets/Game/AGENTS.md', scope: 'nested', chars: 100, tokens: 30 }] });
    assert.equal(outcome('instructions.nested', makeContext({ project: { scan } })).severity, 'warn');
    assert.equal(outcome('instructions.nested', makeContext()).severity, 'pass');
    assert.equal(outcome('instructions.nested', makeContext({ project: { scan: null } })).severity, 'skip');
  });

  it('unity.facts-cap is an error over the cap', () => {
    assert.equal(outcome('unity.facts-cap', makeContext({ project: { factsText: 'x'.repeat(1601), factsPath: 'facts.md' } })).severity, 'error');
    assert.equal(outcome('unity.facts-cap', makeContext({ project: { factsText: 'x'.repeat(1600) } })).severity, 'pass');
    assert.equal(outcome('unity.facts-cap', makeContext()).severity, 'skip');
  });
});

describe('tool and MCP checks', () => {
  it('tools.mcp-schema is an error for an enabled server with no deny rule', () => {
    const layer = healthyLayer({ mcp: { unityMCP: { type: 'remote', url: 'http://127.0.0.1:8080/mcp' } } });
    const finding = outcome('tools.mcp-schema', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.deepEqual(finding.data.exposed, ['unityMCP']);
    assert.ok(/** @type {number} */ (finding.data.estimatedTokensPerServer) > 0);
  });

  it('tools.mcp-schema passes when the server tools are denied, and ignores disabled servers', () => {
    const permission = { ...profilePermission(), 'unityMCP_*': 'deny' };
    const denied = healthyLayer({ mcp: { unityMCP: { url: 'http://127.0.0.1:8080/mcp' } }, permission });
    assert.equal(outcome('tools.mcp-schema', makeContext({ opencode: { config: { layers: [denied], target: 'user', warnings: [] } } })).severity, 'pass');
    const disabled = healthyLayer({ mcp: { unityMCP: { enabled: false } } });
    assert.equal(outcome('tools.mcp-schema', makeContext({ opencode: { config: { layers: [disabled], target: 'user', warnings: [] } } })).severity, 'skip');
  });

  it('mcp.duplicate-server finds case variants and repeated URLs', () => {
    const layer = healthyLayer({
      mcp: { unityMCP: { url: 'http://127.0.0.1:8080/mcp' }, UnityMcp: { url: 'http://127.0.0.1:9000/mcp' }, other: { url: 'HTTP://127.0.0.1:8080/MCP' } },
    });
    const finding = outcome('mcp.duplicate-server', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.equal(finding.details.length, 2);
  });

  it('mcp.duplicate-server passes one entry per server', () => {
    const layer = healthyLayer({ mcp: { unityMCP: { url: 'http://127.0.0.1:8080/mcp' } } });
    assert.equal(outcome('mcp.duplicate-server', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } })).severity, 'pass');
    assert.equal(outcome('mcp.duplicate-server', makeContext()).severity, 'skip');
  });

  it('mcp.hub-loopback warns on a remote hub', () => {
    const scan = healthyScan({ local: { hubUrl: 'http://192.0.2.5:8080/mcp', hubUrlSource: 'opencode-config', hubLoopback: false } });
    assert.equal(outcome('mcp.hub-loopback', makeContext({ project: { scan } })).severity, 'warn');
    assert.equal(outcome('mcp.hub-loopback', makeContext()).severity, 'pass');
  });
});

describe('budget checks', () => {
  it('budget.fixed-prefix passes with the default allowance and no facts', () => {
    const finding = outcome('budget.fixed-prefix', makeContext());
    assert.equal(finding.severity, 'pass');
    assert.equal(finding.data.measured, false);
  });

  it('budget.fixed-prefix warns over the target and errors over the fail threshold', () => {
    const near = makeContext({ project: { factsText: 'x'.repeat(Math.ceil(2000 * 3.5)) } });
    assert.equal(outcome('budget.fixed-prefix', near).severity, 'warn');
    const over = makeContext({ project: { factsText: 'x'.repeat(Math.ceil(3000 * 3.5)) } });
    assert.equal(outcome('budget.fixed-prefix', over).severity, 'error');
  });

  it('budget.truncation-limit is an error when the plan does not fit the server window', () => {
    const context = makeContext();
    const show = { ...context.ollama.show, parameters: { num_ctx: [8192] } };
    assert.equal(outcome('budget.truncation-limit', makeContext({ ollama: { show } })).severity, 'error');
    assert.equal(outcome('budget.truncation-limit', context).severity, 'pass');
    assert.equal(outcome('budget.truncation-limit', makeContext({ profileInfo: { runtime: null } })).severity, 'skip');
  });
});

describe('log checks', () => {
  it('logs.truncation reports not checked as a warning and never as a pass (R22)', () => {
    const logs = { read: false, summary: null, recent: null, unreadableReason: 'permission denied', source: { kind: 'journal', unit: 'ollama', command: ['journalctl'] } };
    const finding = outcome('logs.truncation', makeContext({ logs }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.message, /not checked: the systemd journal \(unit ollama\) could not be read/);
    assert.equal(finding.data.checked, false);
    const none = outcome('logs.truncation', makeContext({ logs: { read: false, summary: null, source: { kind: 'none' }, unreadableReason: 'x' } }));
    assert.match(none.message, /not checked: no Ollama server log was found/);
  });

  it('logs.truncation is an error for a recent truncation and a warning for an old one (E1)', () => {
    const summary = { ...emptySummary(), truncations: 3, truncatedPromptTokens: { min: 17000, median: 18000, max: 20000 }, truncationLimits: [16384] };
    assert.equal(outcome('logs.truncation', makeContext({ logs: { summary, recent: { ...summary, truncations: 1 } } })).severity, 'error');
    assert.equal(outcome('logs.truncation', makeContext({ logs: { summary, recent: emptySummary() } })).severity, 'warn');
    assert.equal(outcome('logs.truncation', makeContext()).severity, 'pass');
  });

  it('logs.sampling-default warns on requests at the sampler defaults (E3)', () => {
    const summary = { ...emptySummary(), samplers: 10, defaultSamplers: 4 };
    assert.match(outcome('logs.sampling-default', makeContext({ logs: { summary } })).message, /^4 of 10/);
    assert.equal(outcome('logs.sampling-default', makeContext({ logs: { summary: { ...emptySummary(), samplers: 3 } } })).severity, 'pass');
    assert.equal(outcome('logs.sampling-default', makeContext({ logs: { read: false, summary: null } })).severity, 'skip');
  });
});

describe('gpu checks', () => {
  it('vram.headroom is an error below the minimum and a warning just above it', () => {
    const needed = makeContext().profileInfo.vram?.modelVramMiB ?? 0;
    assert.equal(outcome('vram.headroom', makeContext({ gpu: { verdict: passingVerdict({ freeMiB: needed + 500 }) } })).severity, 'error');
    assert.equal(outcome('vram.headroom', makeContext({ gpu: { verdict: passingVerdict({ freeMiB: needed + 1800 }) } })).severity, 'warn');
    assert.equal(outcome('vram.headroom', makeContext({ gpu: { verdict: passingVerdict({ freeMiB: needed + 5000 }) } })).severity, 'pass');
  });

  it('vram.headroom skips without a reading', () => {
    assert.equal(outcome('vram.headroom', makeContext({ gpu: { verdict: null } })).severity, 'skip');
    const unread = passingVerdict();
    unread.measurements.gpu = /** @type {any} */ ({ memory: { ok: false, error: 'driver' } });
    assert.match(outcome('vram.headroom', makeContext({ gpu: { verdict: unread } })).message, /driver/);
    assert.equal(outcome('vram.headroom', makeContext({ profileInfo: { vram: null } })).severity, 'skip');
  });

  it('gpu.guard is a note on a pass and an error on a block', () => {
    assert.equal(outcome('gpu.guard', makeContext()).severity, 'info');
    const blocked = { ...passingVerdict(), verdict: 'blocked', pass: false, mode: 'stop', reasons: [{ id: 'import_busy', mode: 'stop', detail: 'Unity is importing', data: {} }] };
    const finding = outcome('gpu.guard', makeContext({ gpu: { verdict: blocked } }));
    assert.equal(finding.severity, 'error');
    assert.match(finding.message, /import_busy/);
    assert.equal(outcome('gpu.guard', makeContext({ gpu: { verdict: null, error: 'no profile' } })).message, 'no profile');
  });

  it('gpu.driver-resets warns on recent resets and only runs on Windows', () => {
    assert.equal(outcome('gpu.driver-resets', makeContext({ gpu: { driverResets: { checked: true, events: 2, since: 'x', error: null } } })).severity, 'warn');
    assert.equal(outcome('gpu.driver-resets', makeContext({ gpu: { driverResets: { checked: false, events: 0, since: null, error: 'timed out' } } })).message, 'timed out');
    assert.equal(outcome('gpu.driver-resets', makeContext()).severity, 'pass');
  });

  it('gpu.lock reports a holder as a note and an unreadable lock as a warning', () => {
    const held = { state: 'held', holder: { pid: 1, command: 'warm', startedAt: 'now', heartbeatAt: 'now', timeoutSec: 1 } };
    assert.equal(outcome('gpu.lock', makeContext({ gpu: { lock: held } })).severity, 'info');
    assert.equal(outcome('gpu.lock', makeContext({ gpu: { lock: { state: 'stale', holder: null, reason: 'gone' } } })).severity, 'info');
    assert.equal(outcome('gpu.lock', makeContext({ gpu: { lock: { state: 'unreadable', ageMs: 0 } } })).severity, 'warn');
    assert.equal(outcome('gpu.lock', makeContext()).severity, 'pass');
  });
});

describe('permission checks', () => {
  it('permissions.serialized-assets is an error when a protected file is editable', () => {
    const permission = { ...profilePermission(), edit: 'allow' };
    const layer = healthyLayer({ permission });
    const finding = outcome('permissions.serialized-assets', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.ok(finding.details.some((detail) => detail.includes('Assets/Scenes/Main.unity')));
  });

  it('permissions.vcs-writes is an error when bash allows a push', () => {
    const permission = { ...profilePermission(), bash: 'allow' };
    const finding = outcome('permissions.vcs-writes', makeContext({ opencode: { config: { layers: [healthyLayer({ permission })], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.ok(finding.details.some((detail) => detail.startsWith('bash git push origin main')));
  });

  it('a later layer that re-allows wins, as it does in OpenCode', () => {
    const later = { path: 'project/opencode.json', origin: 'project', value: { permission: { bash: { 'git push *': 'allow' } } }, error: null };
    const finding = outcome('permissions.vcs-writes', makeContext({ opencode: { config: { layers: [healthyLayer(), later], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'error');
    assert.ok(finding.details.some((detail) => detail.includes('project/opencode.json')));
  });

  it('permissions.* pass on the profile rules and skip without any permission block', () => {
    assert.equal(outcome('permissions.serialized-assets', makeContext()).severity, 'pass');
    assert.equal(outcome('permissions.vcs-writes', makeContext()).severity, 'pass');
    const bare = { path: 'x', origin: 'user', value: {}, error: null };
    const context = makeContext({ opencode: { config: { layers: [bare], target: 'user', warnings: [] } } });
    assert.equal(outcome('permissions.serialized-assets', context).severity, 'skip');
    assert.equal(outcome('permissions.auto-approve-risk', context).severity, 'skip');
  });

  it('permissions.auto-approve-risk warns on blanket allows, per agent too', () => {
    const layer = healthyLayer({ permission: { ...profilePermission(), webfetch: 'allow' }, agent: { build: { permission: { bash: 'allow' } } } });
    const finding = outcome('permissions.auto-approve-risk', makeContext({ opencode: { config: { layers: [layer], target: 'user', warnings: [] } } }));
    assert.equal(finding.severity, 'warn');
    assert.ok(finding.details.some((detail) => detail.includes('for agent build')));
    assert.equal(outcome('permissions.auto-approve-risk', makeContext()).severity, 'pass');
  });
});

describe('environment checks', () => {
  it('privacy.cloud-keys reports names only', () => {
    const finding = outcome('privacy.cloud-keys', makeContext({ env: { OPENAI_API_KEY: 'sk-planted-value-0000', AWS_REGION: 'x', EMPTY_API_KEY: '' } }));
    assert.equal(finding.severity, 'warn');
    assert.deepEqual(finding.data.names, ['AWS_REGION', 'OPENAI_API_KEY']);
    assert.doesNotMatch(JSON.stringify(finding), /sk-planted-value/);
    assert.equal(outcome('privacy.cloud-keys', makeContext()).severity, 'pass');
  });

  it('terminal.host warns outside Windows Terminal and only on Windows', () => {
    assert.equal(outcome('terminal.host', makeContext()).severity, 'warn');
    assert.equal(outcome('terminal.host', makeContext({ env: { WT_SESSION: 'id' } })).severity, 'pass');
  });

  it('delegate.codex-legacy-path is a note when the old directory exists', () => {
    assert.equal(outcome('delegate.codex-legacy-path', makeContext({ delegate: { legacySkillsPath: '/h/.codex/skills' } })).severity, 'info');
    assert.equal(outcome('delegate.codex-legacy-path', makeContext()).severity, 'pass');
  });
});

describe('unity checks', () => {
  it('unity.compile-check warns without project files, without an SDK and with stale files', () => {
    const scan = healthyScan({
      projectFiles: { generated: false, csproj: [] },
      dotnet: { checked: true, present: false, sdks: [] },
      staleness: { stale: true, count: 2, examples: ['Assets/A.cs'], missingScripts: 2, missingAssemblies: 0 },
    });
    const finding = outcome('unity.compile-check', makeContext({ project: { scan } }));
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.details.length, 3);
    const unchecked = healthyScan({ dotnet: { checked: false, present: false, sdks: [] } });
    assert.match(outcome('unity.compile-check', makeContext({ project: { scan: unchecked } })).details[0], /not checked/);
    assert.equal(outcome('unity.compile-check', makeContext()).severity, 'pass');
  });

  it('unity.facts-stale warns when the inputs changed', () => {
    const projectJson = { inputsHash: 'old', generator: { factsVersion: 1 } };
    const finding = outcome('unity.facts-stale', makeContext({ project: { initialized: true, projectJson, inputsHash: 'new' } }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.message, /has changed/);
    assert.equal(outcome('unity.facts-stale', makeContext({ project: { initialized: true, projectJson, inputsHash: 'old' } })).severity, 'pass');
    assert.equal(outcome('unity.facts-stale', makeContext()).severity, 'skip');
  });

  it('unity.opencode-dir warns when the project has an .opencode folder', () => {
    assert.equal(outcome('unity.opencode-dir', makeContext({ project: { scan: healthyScan({ opencodeDir: true }) } })).severity, 'warn');
    assert.equal(outcome('unity.opencode-dir', makeContext()).severity, 'pass');
  });

  it('unity.project-found says when there is no project, and when the scan failed', () => {
    assert.equal(outcome('unity.project-found', makeContext({ project: { root: null, scan: null } })).severity, 'info');
    assert.equal(outcome('unity.project-found', makeContext({ project: { scanError: 'EACCES' } })).severity, 'warn');
    assert.match(outcome('unity.project-found', makeContext()).message, /6000\.0\.23f1/);
  });
});
