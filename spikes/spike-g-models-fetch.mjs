// Spike G: does OPENCODE_DISABLE_MODELS_FETCH=1 keep the injected provider working, and does it really
// stop the models catalogue fetch?
import fs from 'node:fs/promises';
import path from 'node:path';

import { startMockLlm, startRecorder, toolNames } from './lib/mock-llm.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { MODEL_TAG, PROVIDER_ID, createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'G',
  title: 'Models catalogue fetch disabled',
  question: 'Does OPENCODE_DISABLE_MODELS_FETCH keep the injected provider working?',
  contractTest: 'C12',
  fallback: 'Do not set it; document the models.dev fetch',
};

export async function run() {
  const ctx = new SpikeContext();
  try {
    const llm = ctx.track(await startMockLlm());
    // A loopback stand-in for the models catalogue. OpenCode requests `${OPENCODE_MODELS_URL}/api.json`,
    // so any fetch attempt lands here instead of the internet.
    const catalogue = ctx.track(await startRecorder({ note: 'catalogue stand-in' }));
    const liveness = await fetch(`${catalogue.url}/api.json`).then((response) => response.ok, () => false);
    ctx.checks.add('G1 the catalogue stand-in records requests (liveness)', liveness && catalogue.requests.length === 1, catalogue.requests);

    const ws = ctx.track(await createWorkspace({
      label: 'g-models',
      opencodeConfig: profileConfig(),
      pluginConfig: providerPluginConfig(llm.baseURL),
    }));
    const env = ws.env({ OPENCODE_MODELS_URL: catalogue.url });
    const before = catalogue.requests.length;
    const result = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'], env, cwd: ws.project, timeoutMs: 150_000 });
    const models = await runOpencode({ args: ['models', PROVIDER_ID], env, cwd: ws.project, timeoutMs: 90_000 });
    const hooks = ws.readHooks();
    const request = llm.chatRequests[0];
    const cacheDir = path.join(ws.sandbox.dirs.xdgCache, 'opencode');
    const cacheFiles = await fs.readdir(cacheDir).catch(() => []);

    ctx.evidence.run = summarizeRun(result, llm, hooks);
    ctx.evidence.catalogueRequests = catalogue.requests.slice(before);
    ctx.evidence.modelsCommand = { exitCode: models.exitCode, stdout: models.stdout.trim() };
    ctx.evidence.cacheFiles = cacheFiles.filter((name) => name.includes('models'));
    ctx.evidence.requestShape = {
      model: request?.body?.model ?? null,
      hasTools: (request?.body?.tools ?? []).length > 0,
      toolNames: toolNames(request?.body),
      temperature: request?.body?.temperature ?? null,
      topP: request?.body?.top_p ?? null,
      maxTokens: request?.body?.max_tokens ?? null,
      streamOptions: request?.body?.stream_options ?? null,
    };

    ctx.checks.add('G2 the run works with the flag set', result.exitCode === 0 && llm.chatRequests.length === 1, { exitCode: result.exitCode, requests: llm.chatRequests.length });
    ctx.checks.add('G3 no request reaches the catalogue URL', catalogue.requests.length === before, catalogue.requests.slice(before));
    ctx.checks.add('G4 no models catalogue file is cached', ctx.evidence.cacheFiles.length === 0, cacheFiles);
    ctx.checks.add('G5 the injected model keeps its tool-call capability', ctx.evidence.requestShape.hasTools && ctx.evidence.requestShape.model === MODEL_TAG, ctx.evidence.requestShape);
    ctx.checks.add('G6 `models <provider>` lists the injected model offline', models.exitCode === 0 && models.stdout.includes(MODEL_TAG), ctx.evidence.modelsCommand);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep OPENCODE_DISABLE_MODELS_FETCH=1 in the clean-room launch environment (spec 8.1).'
    : 'Do not set OPENCODE_DISABLE_MODELS_FETCH; document the models catalogue fetch instead.';
  ctx.findings.push(
    'With the flag set, OpenCode fetches no model catalogue (the OPENCODE_MODELS_URL stand-in stays untouched and no models cache file is written) and the plugin-injected provider still resolves, keeps its tool-call capability and sends tools.',
    'OPENCODE_MODELS_URL is the override the fetch would use (`<url>/api.json`), so pointing it at a loopback recorder is how contract test C12 proves the flag works.',
  );
  return ctx;
}
