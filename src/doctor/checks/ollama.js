// Ollama server and model checks (spec 5.4).
//
// Every endpoint used here is read-only: version, tags, show and ps. Nothing in this file can load a
// model, which is the invariant spec 5.4 states and `test/doctor/invariant` asserts against a mock.
import { compareVersions, findModel } from '../../ollama/client.js';
import { isLoopbackHost } from '../../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js';
import { error, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/**
 * `OLLAMA_HOST` is a bind address as often as a URL: `0.0.0.0`, `0.0.0.0:11434`, `[::]:11434` or
 * `http://host:port` are all accepted by Ollama, so it is parsed as a URL only after adding a scheme.
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackHostValue(value) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** @type {readonly CheckSpec[]} */
export const OLLAMA_CHECKS = Object.freeze([
  {
    id: 'ollama.reachable',
    group: 'ollama',
    title: 'Ollama answers',
    severities: ['error'],
    why: 'Every model call goes to this endpoint; when it does not answer, nothing about the model, its context size or its parameters can be checked.',
    fix: 'Start Ollama, or point ollama.baseUrl in config.json at the server you use.',
    source: 'spec 4.5 and 6.2',
    run: (context) => {
      if (context.ollama.reachable) return pass(`Ollama answered at ${context.ollama.baseUrl}`);
      return error(`Ollama did not answer at ${context.ollama.baseUrl}`, {
        details: [context.ollama.error ?? 'no reason reported'],
        data: { baseUrl: context.ollama.baseUrl, error: context.ollama.error },
      });
    },
  },
  {
    id: 'ollama.version',
    group: 'ollama',
    title: 'Ollama version tested',
    severities: ['warn'],
    why: 'The log parser, the truncation limits and the unload behaviour were read from one Ollama version; an older one behaves differently in ways this report would not notice.',
    fix: 'Update Ollama to the tested version, or accept that findings from the server log may be wrong.',
    source: 'compat.json and spec 3.2',
    run: (context) => {
      const { version, testedVersion } = context.ollama;
      if (version === null) return skip('the server did not report a version');
      if (compareVersions(version, testedVersion) >= 0) return pass(`Ollama ${version} is at or above the tested version`);
      return warn(`Ollama ${version} is older than the tested ${testedVersion}`, { data: { version, testedVersion } });
    },
  },
  {
    id: 'ollama.loopback',
    group: 'ollama',
    title: 'Ollama endpoint is loopback',
    severities: ['warn'],
    why: 'A remote endpoint means the GPU guard measures this machine and the model runs on another, so the guard protects nothing and prompts leave the machine.',
    fix: 'Point ollama.baseUrl at a loopback address, or set guard.remote deliberately and accept that the guard cannot see that machine.',
    source: 'spec P11 and 7.3',
    run: (context) => {
      const hostVariable = context.env.OLLAMA_HOST?.trim() ?? '';
      const exposedHost = hostVariable !== '' && !isLoopbackHostValue(hostVariable) ? hostVariable : null;
      /** @type {string[]} */
      const problems = [
        ...(context.ollama.loopback ? [] : [`the endpoint ${context.ollama.baseUrl} is not loopback (guard.remote is '${context.home.config.guard.remote}')`]),
        ...(exposedHost === null ? [] : [`OLLAMA_HOST is '${exposedHost}', so a server started from this environment listens beyond this machine`]),
      ];
      if (problems.length === 0) return pass(`the endpoint ${context.ollama.baseUrl} is loopback`);
      return warn(problems.length === 1 ? problems[0] : 'the Ollama endpoint and OLLAMA_HOST are not loopback', {
        details: problems.length === 1 ? [] : problems,
        data: { baseUrl: context.ollama.baseUrl, loopback: context.ollama.loopback, ollamaHost: exposedHost, remote: context.home.config.guard.remote },
      });
    },
  },
  {
    id: 'model.installed',
    group: 'model',
    title: 'Configured model installed',
    severities: ['error'],
    why: 'The launcher pins one model tag; when Ollama does not have it, the first request fails with a provider error rather than a useful message.',
    fix: 'Run opencode-unity setup to create the model tag from the preset.',
    source: 'spec 10.3 and 14.1',
    run: (context) => {
      const modelTag = context.profileInfo.runtime?.provider.modelTag ?? null;
      if (!context.ollama.reachable || modelTag === null) return skip('the model tag or the server is unknown');
      if (findModel(context.ollama.models, modelTag) !== undefined) return pass(`${modelTag} is installed`);
      return error(`the configured model '${modelTag}' is not installed`, {
        details: [`Ollama has ${quantity(context.ollama.models.length, 'model tag')}`],
        data: { modelTag, installed: context.ollama.models.map((model) => model.name) },
      });
    },
  },
  {
    id: 'model.system-ignored',
    group: 'model',
    title: 'Modelfile SYSTEM prompt',
    severities: ['warn'],
    why: 'A SYSTEM line baked into the model is dropped as soon as the client sends its own system message, so it reads like configuration that is doing nothing.',
    fix: 'Recreate the model tag from the shipped Modelfile, which has no SYSTEM line.',
    source: 'spec 10.3 and evidence E4',
    run: (context) => {
      const show = context.ollama.show;
      if (show === null) return skip('the model could not be described');
      const system = show.system.trim();
      if (system === '') return pass('the model has no baked-in SYSTEM prompt');
      return warn('the model carries a SYSTEM prompt that the client message replaces at every request', {
        details: [`first line: ${system.split(/\r?\n/, 1)[0] ?? ''}`],
        data: { systemChars: system.length },
      });
    },
  },
  {
    id: 'model.num-ctx',
    group: 'model',
    title: 'Model context size pinned',
    severities: ['warn'],
    why: 'Without num_ctx in the model parameters the server falls back to its own default, which is usually far smaller than the profile assumes, and prompts are cut.',
    fix: 'Recreate the model tag from the preset so the Modelfile sets num_ctx.',
    source: 'spec 10.3 and evidence E1',
    run: (context) => {
      const show = context.ollama.show;
      const expected = context.profileInfo.runtime?.provider.numCtx ?? null;
      if (show === null) return skip('the model could not be described');
      const values = show.parameters.num_ctx ?? [];
      if (values.length === 0) {
        return warn('the model parameters do not set num_ctx, so the server default applies', { data: { expected } });
      }
      const actual = Number(values.at(-1));
      if (expected === null || actual === expected) return pass(`the model pins num_ctx to ${actual}`);
      return warn(`the model pins num_ctx to ${actual} while the profile expects ${expected}`, { data: { actual, expected } });
    },
  },
  {
    id: 'model.renderer',
    group: 'model',
    title: 'Renderer and parser match the model family',
    severities: ['warn'],
    why: 'A qwen3-coder model whose renderer or parser is something else emits tool calls as text, which the agent then cannot execute.',
    fix: 'Recreate the model tag from the preset, which sets the renderer and the parser.',
    source: 'spec 10.1 and 10.3',
    run: (context) => {
      const show = context.ollama.show;
      const preset = context.profileInfo.preset;
      if (show === null || preset === null) return skip('the model could not be described');
      const expected = preset.model.renderer;
      const wrong = [
        ...(show.renderer === expected ? [] : [`renderer is '${show.renderer || 'unset'}'`]),
        ...(show.parser === preset.model.parser ? [] : [`parser is '${show.parser || 'unset'}'`]),
      ];
      if (wrong.length === 0) return pass(`renderer and parser are '${expected}'`);
      return warn(`the model does not use the '${expected}' renderer and parser`, {
        details: wrong,
        data: { expected, renderer: show.renderer, parser: show.parser },
      });
    },
  },
]);
