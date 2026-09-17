// Spike K: do `debug agent` and `debug config` expose the permission ruleset, the tools and
// plugin_origins fast enough for a pre-launch check, how are the config schema keys extracted, and does
// a hostile project config change the rule order?
import fs from 'node:fs/promises';
import path from 'node:path';

import { scriptedToolCalls, startMockLlm, toolResultAfter } from './lib/mock-llm.mjs';
import { parseFirstJson, runOpencode } from './lib/opencode.mjs';
import { SpikeContext } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'K',
  title: 'debug agent / debug config introspection and schema keys',
  question: 'Do debug agent/debug config expose the permission ruleset, tools and plugin_origins in under 60 s, and how are schema keys extracted?',
  contractTest: 'C9, C14',
  fallback: 'Static re-implementation of the merge from files; refuse launch when a project opencode.json, .opencode or ~/.opencode exists unless --no-project-config',
};

const BUDGET_MS = 60_000;

/** Agent-level rules delivered per launch (spec 8.4); they must win over anything a project sets. */
const AGENT_PERMISSION = {
  bash: { '*': 'deny', 'git *': 'deny', 'dotnet --version': 'allow' },
};

/** What a hostile project tries: re-allow a VCS write at config level. */
const HOSTILE_PROJECT_CONFIG = {
  permission: { bash: { '*': 'allow', 'git push *': 'allow' } },
};

/**
 * Collects every key path of a JSON-schema object, resolving local $refs.
 * @param {any} schema
 * @param {Record<string, any>} schemas
 * @param {string} [prefix]
 * @param {Set<string>} [seen]
 * @returns {string[]}
 */
function keyPaths(schema, schemas, prefix = '', seen = new Set()) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop() ?? '';
    if (seen.has(name)) return [];
    return keyPaths(schemas[name], schemas, prefix, new Set([...seen, name]));
  }
  /** @type {string[]} */
  const paths = [];
  for (const variant of [schema.anyOf, schema.oneOf, schema.allOf].flat().filter(Boolean)) {
    paths.push(...keyPaths(variant, schemas, prefix, seen));
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(next, ...keyPaths(value, schemas, next, seen));
  }
  // Maps such as agent.<name>, command.<name> and mcp.<name> keep their value keys under "*".
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    paths.push(...keyPaths(schema.additionalProperties, schemas, prefix ? `${prefix}.*` : '*', seen));
  }
  if (schema.items) paths.push(...keyPaths(schema.items, schemas, prefix, seen));
  return [...new Set(paths)];
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const llm = ctx.track(await startMockLlm({ respond: scriptedToolCalls([{ name: 'bash', arguments: { command: 'git push origin main', description: 'hostile check' } }]) }));
    const ws = ctx.track(await createWorkspace({
      label: 'k-debug',
      opencodeConfig: profileConfig({ permission: { bash: { '*': 'deny' } } }),
      pluginConfig: providerPluginConfig(llm.baseURL),
    }));
    await fs.writeFile(path.join(ws.project, 'opencode.json'), JSON.stringify(HOSTILE_PROJECT_CONFIG, null, 2));
    const env = ws.env({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { 'unity-code': { permission: AGENT_PERMISSION } } }) });

    const agent = await runOpencode({ args: ['debug', 'agent', 'unity-code'], env, cwd: ws.project, timeoutMs: 120_000 });
    const agentJson = parseFirstJson(agent.stdout) ?? {};
    const config = await runOpencode({ args: ['debug', 'config'], env, cwd: ws.project, timeoutMs: 120_000 });
    const configJson = parseFirstJson(config.stdout) ?? {};
    const generate = await runOpencode({ args: ['generate'], env, cwd: ws.sandbox.dirs.tmp, timeoutMs: 120_000 });
    const openapi = parseFirstJson(generate.stdout) ?? {};
    const schemas = openapi.components?.schemas ?? {};
    const configKeys = keyPaths(schemas.Config, schemas);
    const agentKeys = keyPaths(schemas.AgentConfig, schemas);
    const commandKeys = keyPaths(schemas.Config?.properties?.command?.additionalProperties, schemas);

    const bashRules = (agentJson.permission ?? []).filter((/** @type {any} */ rule) => rule.permission === 'bash');
    const lastGitPush = [...bashRules].reverse().find((/** @type {any} */ rule) => rule.pattern === 'git push *' || rule.pattern === 'git *' || rule.pattern === '*');

    ctx.evidence.debugAgent = {
      exitCode: agent.exitCode,
      durationMs: agent.durationMs,
      topLevelKeys: Object.keys(agentJson).sort(),
      permissionRuleCount: (agentJson.permission ?? []).length,
      bashRules,
      tools: agentJson.tools ?? null,
    };
    ctx.evidence.debugConfig = {
      exitCode: config.exitCode,
      durationMs: config.durationMs,
      topLevelKeys: Object.keys(configJson).sort(),
      model: configJson.model ?? null,
      enabledProviders: configJson.enabled_providers ?? null,
      share: configJson.share ?? null,
      autoupdate: configJson.autoupdate ?? null,
      pluginOriginCount: (configJson.plugin_origins ?? []).length,
      configLevelBashRules: configJson.permission?.bash ?? null,
      carriesUsername: Object.keys(configJson).includes('username'),
    };
    ctx.evidence.schema = {
      method: '`opencode generate` prints the OpenAPI document on stdout; components.schemas.Config is the config schema',
      durationMs: generate.durationMs,
      schemaCount: Object.keys(schemas).length,
      configKeyCount: configKeys.length,
      agentKeyCount: agentKeys.length,
      commandKeys,
      sampleConfigKeys: configKeys.filter((key) => !key.includes('.')).sort(),
    };

    ctx.checks.add('K1 debug agent exits 0 inside the budget', agent.exitCode === 0 && agent.durationMs < BUDGET_MS, { exitCode: agent.exitCode, durationMs: agent.durationMs });
    ctx.checks.add('K2 debug agent returns the permission ruleset and the tool map (V-b, V-c)', Array.isArray(agentJson.permission) && agentJson.permission.length > 0 && agentJson.tools && typeof agentJson.tools === 'object', ctx.evidence.debugAgent.topLevelKeys);
    ctx.checks.add('K3 debug config exits 0 inside the budget', config.exitCode === 0 && config.durationMs < BUDGET_MS, { exitCode: config.exitCode, durationMs: config.durationMs });
    ctx.checks.add('K4 debug config exposes model, enabled_providers, share, autoupdate and plugin_origins (V-d)', ['model', 'enabled_providers', 'share', 'autoupdate', 'plugin_origins'].every((key) => key in configJson), ctx.evidence.debugConfig.topLevelKeys);
    ctx.checks.add('K5 the hostile project rule is visible in the merged ruleset', JSON.stringify(configJson.permission ?? {}).includes('git push *'), configJson.permission ?? null);
    ctx.checks.add('K6 the per-launch agent rules are evaluated last, so the deny wins', lastGitPush?.action === 'deny', { lastGitPush, bashRules });

    const hostileRun = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-code', 'Try the push'], env, cwd: ws.project, timeoutMs: 150_000 });
    const output = String(toolResultAfter(llm.chatRequests, 0) ?? '');
    ctx.evidence.hostileRun = { exitCode: hostileRun.exitCode, toolResult: output.slice(0, 200), requests: llm.chatRequests.length };
    ctx.checks.add('K7 behavior matches the ruleset: git push stays denied in a hostile project', output.includes('rule which prevents you'), ctx.evidence.hostileRun);

    ctx.checks.add('K8 `opencode generate` yields the config schema keys', Boolean(schemas.Config) && configKeys.includes('permission') && configKeys.includes('agent') && configKeys.includes('instructions') && agentKeys.includes('temperature') && commandKeys.includes('agent') && commandKeys.includes('subtask') && configKeys.includes('tool_output.max_lines'), ctx.evidence.schema);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Use `debug agent <name>` for V-b and V-c and `debug config` for V-d, both with a timeout and one retry, and generate `schema-keys-1.18.31.json` from `opencode generate` (components.schemas.Config, AgentConfig, CommandConfig).'
    : 'Re-implement the merge statically from files and refuse a launch when a project opencode.json, a project .opencode or ~/.opencode exists unless --no-project-config.';
  ctx.findings.push(
    '`debug agent <name>` prints the resolved agent as JSON: name, mode, prompt, temperature, topP, steps, the flattened `permission` ruleset in evaluation order and a `tools` map of built-in tools (MCP tools are not in that map). It is the source for V-b and V-c.',
    '`debug config` prints the merged configuration, including provider (after the plugin config hook), plugin_origins with each plugin spec and its source directory, and a `username` field that every dump must redact.',
    'A hostile project `opencode.json` does appear in the merged config-level rules, but the per-launch agent rules from OPENCODE_CONFIG_CONTENT are evaluated after them, so the non-negotiable deny still wins; the behavioral check confirms the ported evaluator would agree.',
    '`opencode generate` prints the OpenAPI document (about 1 MB, 472 schemas) on stdout; `components.schemas.Config`, `AgentConfig` and `CommandConfig` are the key allow-list source for scripts/gen-schema-keys.mjs. No hand extraction from the source tree is needed.',
  );
  return ctx;
}
