// Installation checks: is opencode-unity set up here at all, and is what it wrote still valid?
//
// `setup.not-installed` is also the anchor of the engine's one lowering policy. On a machine where
// `setup` has never run there is no configuration to be wrong, so an ERROR about it would be a claim
// about something that does not exist; this check states that once, and every lowered finding points
// back at it.
import { error, info, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** @type {readonly CheckSpec[]} */
export const SETUP_CHECKS = Object.freeze([
  {
    id: 'setup.not-installed',
    group: 'setup',
    title: 'opencode-unity installed here',
    severities: ['info'],
    why: 'Without a config.json the report describes the machine rather than an installation, and findings that would be errors about a setup are reported one level lower.',
    fix: 'Run opencode-unity setup to install the profile and the model.',
    source: 'spec 6.1 and 14.1',
    run: (context) => {
      if (context.home.installed) return pass(`opencode-unity is set up in ${context.home.dir}`);
      return info('opencode-unity is not set up on this machine, so errors about its own configuration are reported as warnings', {
        details: [`no config at ${context.home.paths.config}`],
        data: { home: context.home.dir, configPath: context.home.paths.config },
      });
    },
  },
  {
    id: 'config.valid',
    group: 'setup',
    title: 'config.json parses and validates',
    severities: ['error', 'warn'],
    why: 'An unreadable or unknown key in config.json stops every command that needs the runtime profile, which is all of them except this one.',
    fix: 'Fix the reported key, or move config.json aside and run opencode-unity setup again.',
    source: 'spec 6.2 and schema/config.schema.json',
    run: (context) => {
      if (context.home.configError !== null) {
        return error(`config.json could not be loaded: ${context.home.configError}`, { data: { path: context.home.paths.config } });
      }
      if (!context.home.installed) return skip('there is no config.json to validate');
      if (context.home.configWarnings.length > 0) {
        return warn(`config.json has ${quantity(context.home.configWarnings.length, 'value')} to look at`, {
          details: [...context.home.configWarnings],
          data: { warnings: context.home.configWarnings },
        });
      }
      return pass('config.json parses and every value is known');
    },
  },
  {
    id: 'config.preset',
    group: 'setup',
    title: 'Preset usable on this machine',
    severities: ['error', 'warn'],
    why: 'The preset decides the model tag, the context size and the guard thresholds, so a preset that does not resolve leaves nothing else to check.',
    fix: 'Choose a shipped preset with opencode-unity setup --preset <id>, or pass --experimental to accept an experimental one.',
    source: 'spec 10.1 and amendment 33.4 preset gating',
    run: (context) => {
      const { presetId, presetError, presetRefusal, error: profileError } = context.profileInfo;
      if (presetError !== null) return error(`the configured preset '${presetId}' could not be loaded: ${presetError}`, { data: { presetId } });
      if (profileError !== null) return error(`the runtime profile could not be built: ${profileError}`, { data: { presetId } });
      if (presetRefusal !== null) {
        return warn(`preset '${presetId}' is not supported here without --experimental`, { details: [presetRefusal], data: { presetId } });
      }
      const runtime = context.profileInfo.runtime;
      return pass(`preset '${presetId}' resolves to ${runtime?.provider.modelTag ?? 'a model tag'} at ${runtime?.provider.numCtx ?? 0} context`, {
        data: { presetId, modelTag: runtime?.provider.modelTag ?? null, numCtx: runtime?.provider.numCtx ?? null },
      });
    },
  },
  {
    id: 'setup.profile-rendered',
    group: 'setup',
    title: 'Clean-room profile rendered for this version',
    severities: ['warn'],
    why: 'The launcher starts OpenCode against the profile rendered for the installed CLI version; an older one is not what this version expects.',
    fix: 'Run opencode-unity upgrade to render the profile for this version.',
    source: 'spec 6.1 and 14.3',
    run: (context) => {
      if (!context.home.installed) return skip('nothing is installed here yet');
      if (context.profileInfo.rendered) return pass(`the profile for ${context.cliVersion} is rendered`);
      return warn(`no rendered profile for version ${context.cliVersion}`, {
        details: [`expected ${context.profileInfo.renderedConfigPath}`],
        data: { path: context.profileInfo.renderedConfigPath, cliVersion: context.cliVersion },
      });
    },
  },
]);
