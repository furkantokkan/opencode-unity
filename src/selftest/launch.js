// Real OpenCode, a temporary clean-room profile and loopback mock endpoints. Never uses the user's
// installed profile, Ollama server, project files or model. The shipped plugin is copied verbatim.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../core/config.js';
import { runProcess } from '../core/exec.js';
import { loadPreset } from '../core/presets.js';
import { buildRuntimeProfile } from '../core/profile.js';
import { renderProfileFiles } from '../install/profile.js';
import { buildLaunchContent, renderLaunchContentEnv } from '../opencode/content.js';
import { buildLaunchEnv } from '../opencode/launch-env.js';
import { buildUnityCodePermission, buildUnityEditorPermission } from '../opencode/render.js';
import { FACTS_MARKER } from './scenarios.js';

/**
 * @param {{ binary: string, cliVersion: string, env?: Record<string, string | undefined>, run?: typeof runProcess,
 *   renderFiles?: typeof renderProfileFiles,
 *   configureLaunch?: (input: { setup: import('./scenarios.js').ScenarioSetup, env: Record<string, string>, content: Record<string, any> }) => void | Promise<void>
 * }} options
 * @returns {(request: import('./scenarios.js').LaunchRequest) => Promise<import('./scenarios.js').LaunchResult>}
 */
export function createSelftestLauncher({ binary, cliVersion, env = process.env, run = runProcess, renderFiles = renderProfileFiles, configureLaunch }) {
  return async ({ setup, run: scenarioRun, timeoutMs, signal }) => {
    const home = path.join(setup.root, 'product');
    const profileDir = path.join(home, 'profile', cliVersion);
    const config = { ...structuredClone(DEFAULT_CONFIG), overrides: { guard: { importWhileLoaded: 'allow', maxUnityEditors: 0, assetImportCpuPercent: 102400 } } };
    config.ollama.baseUrl = setup.backend.url;
    config.guard.nvidiaSmiCommand = setup.nvidiaSmiCommand;
    // These scenarios test GPU admission and prompt contracts, not real Unity process activity.
    // Only this temporary profile receives these settings; the endpoint cannot load a real model.
    Object.assign(config.guard, { importWhileLoaded: 'allow', maxUnityEditors: 0, editorImportCpuPercent: 0, assetImportCpuPercent: 102400 });
    const { profile } = buildRuntimeProfile({ config, preset: loadPreset(config.preset), cliVersion, home });
    const files = await renderFiles({ profile, config, cliVersion, editorAgent: setup.hubUrl !== null });
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(profileDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const factsPath = path.join(home, 'facts.md');
    await fs.writeFile(factsPath, `# Self-test fixture\n\n${FACTS_MARKER}\n`);
    const content = buildLaunchContent({
      factsPath,
      unityCodePermission: buildUnityCodePermission(),
      editorAgent: setup.hubUrl !== null,
      ...(setup.hubUrl ? { hubUrl: setup.hubUrl, unityEditorPermission: buildUnityEditorPermission({ trust: true }) } : {}),
    });
    const clean = buildLaunchEnv({
      env: { ...env, ...setup.env }, home, profileDir,
      xdgConfigDir: path.join(home, 'xdg-config'), projectId: 'selftest',
      configContent: renderLaunchContentEnv(content), disableProjectConfig: true,
    }).env;
    Object.assign(clean, {
      npm_config_fetch_retries: '0', npm_config_registry: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost', OPENCODE_MODELS_URL: 'http://127.0.0.1:9',
      ...scenarioRun.env,
    });
    // Explicit dependency seam for integration contracts (for example a bounded network tool policy).
    // No user/environment switch can activate it in the shipped diagnostic command.
    await configureLaunch?.({ setup, env: clean, content });
    clean.OPENCODE_CONFIG_CONTENT = renderLaunchContentEnv(content);
    const plugin = path.join(profileDir, 'plugins', 'opencode-unity.js');
    if (scenarioRun.plugin === 'deleted') await fs.rm(plugin);
    if (scenarioRun.plugin === 'syntax-error') await fs.writeFile(path.join(profileDir, 'plugins', 'opencode-unity-lib', 'provider.js'), 'this is deliberately invalid JavaScript !!!\n');
    const result = await run(binary, ['run', '--print-logs', '--log-level', 'ERROR', '--format', 'json', '--agent', scenarioRun.agent, scenarioRun.prompt], {
      // Stop the process slightly before the scenario deadline, leaving time for tree termination
      // and pipe closure before the scenario removes its temporary directory.
      cwd: setup.projectDir, env: clean, timeoutMs: Math.max(1, timeoutMs - 2000), signal, maxOutputBytes: 256 * 1024,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.error?.message ?? result.stderr, timedOut: result.timedOut };
  };
}
