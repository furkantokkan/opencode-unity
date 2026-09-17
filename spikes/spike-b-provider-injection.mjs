// Spike B: does the config-hook provider injection resolve the model, and do a missing plugin, a broken
// lib module, a throwing config hook and OPENCODE_PURE all fail closed with 0 requests?
import fs from 'node:fs/promises';
import path from 'node:path';

import { startMockLlm } from './lib/mock-llm.mjs';
import { parseFirstJson, runOpencode } from './lib/opencode.mjs';
import { SpikeContext, runOutputText, summarizeRun } from './lib/spike.mjs';
import { MODEL_TAG, PROVIDER_ID, createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'B',
  title: 'Fail-closed provider injection through the plugin config hook',
  question: 'Does the config-hook provider injection resolve the model, and do a missing or broken plugin and OPENCODE_PURE give 0 requests?',
  contractTest: 'C7',
  fallback: 'Build the loopback gate with a closed-port static provider (spec 8.10)',
};

const RUN_ARGS = ['run', '--print-logs', '--format', 'json', '--agent', 'unity-code', 'Say OK'];
const MODEL_NOT_FOUND = /Model not found: opencode-unity/;

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {object} options
 * @param {boolean} [options.withPlugin]
 * @param {Record<string, unknown>} [options.pluginExtra]  Merged into the provider section of the plugin config.
 * @param {(ws: Awaited<ReturnType<typeof createWorkspace>>) => Promise<void>} [options.prepare]
 * @param {Record<string, string | null>} [options.envOverrides]
 * @param {string[]} [options.extraArgs]
 */
async function runVariant(ctx, label, { withPlugin = true, pluginExtra = {}, prepare, envOverrides = {}, extraArgs = [] }) {
  const llm = ctx.track(await startMockLlm());
  const base = providerPluginConfig(llm.baseURL);
  const pluginConfig = { ...base, provider: { ...base.provider, ...pluginExtra } };
  const ws = ctx.track(await createWorkspace({ label: `b-${label}`, opencodeConfig: profileConfig(), withPlugin, pluginConfig }));
  if (prepare) await prepare(ws);
  const env = ws.env(envOverrides);
  const args = [RUN_ARGS[0], ...extraArgs, ...RUN_ARGS.slice(1)];
  const run = await runOpencode({ args, env, cwd: ws.project, timeoutMs: 120_000 });
  const models = await runOpencode({ args: ['models', ...extraArgs, PROVIDER_ID], env, cwd: ws.project, timeoutMs: 90_000 });
  const debugConfig = await runOpencode({ args: ['debug', 'config', ...extraArgs], env, cwd: ws.project, timeoutMs: 90_000 });
  const config = parseFirstJson(debugConfig.stdout) ?? {};
  const hooks = ws.readHooks();
  return {
    llm,
    run,
    models,
    hooks,
    summary: {
      run: summarizeRun(run, llm, hooks),
      requestModel: llm.chatRequests[0]?.body?.model ?? null,
      models: { exitCode: models.exitCode, stdout: models.stdout.trim(), stderrTail: models.stderr.trim().slice(-200) },
      debugConfig: {
        exitCode: debugConfig.exitCode,
        providerIds: Object.keys(config.provider ?? {}),
        pluginOriginCount: (config.plugin_origins ?? []).length,
        enabledProviders: config.enabled_providers ?? null,
        model: config.model ?? null,
      },
    },
  };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const injected = await runVariant(ctx, 'injected', {});
    ctx.evidence.injected = injected.summary;
    ctx.checks.add('B1 injected provider: exactly one request reaches the mock', injected.llm.chatRequests.length === 1, injected.llm.chatRequests.length);
    ctx.checks.add('B1 injected provider: request uses the preset model tag', injected.summary.requestModel === MODEL_TAG, injected.summary.requestModel);
    ctx.checks.add('B1 injected provider: run exits 0', injected.run.exitCode === 0, injected.run.exitCode);
    ctx.checks.add('B1 profile has no provider block before the hook runs', injected.hooks.find((entry) => entry.hook === 'config')?.hadProvider === false, injected.hooks.find((entry) => entry.hook === 'config'));
    ctx.checks.add('B1 debug config shows the injected provider and our plugin origin', injected.summary.debugConfig.providerIds.join(',') === PROVIDER_ID && injected.summary.debugConfig.pluginOriginCount === 1, injected.summary.debugConfig);
    ctx.checks.add('B1 `models <provider>` lists the model (V-a signal)', injected.models.exitCode === 0 && injected.models.stdout.includes(MODEL_TAG), injected.summary.models);

    const missing = await runVariant(ctx, 'missing', { withPlugin: false });
    ctx.evidence.pluginMissing = missing.summary;
    addFailClosedChecks(ctx, 'B2 plugin file missing', missing);

    const broken = await runVariant(ctx, 'broken-lib', {
      prepare: (ws) => fs.writeFile(path.join(ws.profile, 'plugins', 'spike-lib', 'log.js'), 'export function appendLog( {\n'),
    });
    ctx.evidence.brokenLib = broken.summary;
    addFailClosedChecks(ctx, 'B3 syntax error in a lib module', broken);

    const throwing = await runVariant(ctx, 'config-throws', { pluginExtra: { throwInConfig: true } });
    ctx.evidence.configHookThrows = throwing.summary;
    addFailClosedChecks(ctx, 'B4 config hook throws', throwing);
    ctx.checks.add('B4 config hook throws: the plugin itself loaded, the error is ignored', throwing.hooks.some((entry) => entry.hook === 'server'), throwing.summary.run.hookCounts);

    const pureEnv = await runVariant(ctx, 'pure-env', { envOverrides: { OPENCODE_PURE: '1' } });
    ctx.evidence.opencodePureEnv = { ...pureEnv.summary, pluginLoaded: pureEnv.hooks.some((entry) => entry.hook === 'server') };
    addFailClosedChecks(ctx, 'B5 OPENCODE_PURE=1', pureEnv);

    const pureFlag = await runVariant(ctx, 'pure-flag', { extraArgs: ['--pure'] });
    ctx.evidence.pureFlag = { ...pureFlag.summary, pluginLoaded: pureFlag.hooks.some((entry) => entry.hook === 'server') };
    addFailClosedChecks(ctx, 'B6 --pure flag', pureFlag);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep the fail-closed plugin-injected provider (D3): no provider block in the profile, and no loopback gate for provider resolution.'
    : 'Fail-closed injection is not reliable: build the loopback gate with a closed-port static provider (S20).';
  ctx.findings.push(
    `The plugin config hook adds provider "${PROVIDER_ID}" and pins enabled_providers; the model then resolves and requests reach the configured baseURL.`,
    'Without the injection (plugin missing, lib import error, config hook error, pure mode) OpenCode resolves no model and sends nothing.',
    'The user-facing run error is only "Unexpected server error. Check server logs for details."; the real reason ("Model not found: <provider>/<tag>") appears in the log stream, so `start` must verify before launching instead of relying on the TUI error.',
    '`opencode debug agent <name>` exits 0 even when the provider is missing, because the configured model id is used as given. `opencode models <provider>` is the cheap fail-closed signal: exit 1 with "Provider not found" when the plugin did not inject. `debug config` also shows the injected provider and `plugin_origins`.',
    '`debug config` output contains a `username` key, so every doctor or spike dump of it must be redacted.',
  );
  return ctx;
}

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {Awaited<ReturnType<typeof runVariant>>} variant
 */
function addFailClosedChecks(ctx, label, variant) {
  ctx.checks.add(`${label}: 0 requests reach the mock`, variant.llm.chatRequests.length === 0, variant.llm.chatRequests.length);
  ctx.checks.add(`${label}: run exits non-zero`, variant.run.exitCode !== 0 && variant.run.exitCode !== null, variant.run.exitCode);
  ctx.checks.add(`${label}: the log names the unresolved model`, MODEL_NOT_FOUND.test(runOutputText(variant.run)), variant.summary.run.runErrorEvents);
  ctx.checks.add(`${label}: \`models <provider>\` fails (V-a signal)`, variant.models.exitCode !== 0, variant.summary.models);
  ctx.checks.add(`${label}: debug config has no provider block`, variant.summary.debugConfig.providerIds.length === 0, variant.summary.debugConfig.providerIds);
}
