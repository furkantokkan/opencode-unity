// Checks about the machine around the session: credentials in the environment, the terminal host, and
// the legacy Codex skill directory (spec 5.4, 13.5, D18).
import { info, pass, quantity, skip, warn } from '../finding.js';
import { listCloudCredentialNames } from '../cloud-keys.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Windows Terminal sets this for every session it hosts. */
const WINDOWS_TERMINAL_ENV = 'WT_SESSION';

/** @type {readonly CheckSpec[]} */
export const ENVIRONMENT_CHECKS = Object.freeze([
  {
    id: 'privacy.cloud-keys',
    group: 'privacy',
    title: 'Cloud credentials in the environment',
    severities: ['warn'],
    why: 'A credential in the environment is one configuration mistake away from a provider the session was never meant to reach.',
    fix: 'Remove the variables you do not need in this shell; the launcher already removes them from the session it starts.',
    source: 'spec 8.1 and P5',
    run: (context) => {
      const names = listCloudCredentialNames(context.env);
      if (names.length === 0) return pass('no cloud credential is set in this environment');
      return warn(`${quantity(names.length, 'cloud credential')} set in this environment`, {
        details: [`names only: ${names.join(', ')}`],
        data: { names },
      });
    },
  },
  {
    id: 'terminal.host',
    group: 'terminal',
    title: 'Terminal host',
    severities: ['warn'],
    why: 'The full-screen interface was built and measured against one terminal; elsewhere on Windows the rendering and the key handling are not what the sessions were tested with.',
    fix: 'Run the launcher from Windows Terminal.',
    source: 'spec 13.5',
    run: (context) => {
      if (context.platformInfo.facts.os !== 'win32') return skip('this check is about the Windows terminal host');
      if ((context.env[WINDOWS_TERMINAL_ENV] ?? '') !== '') return pass('this session runs in Windows Terminal');
      return warn('this session does not run in Windows Terminal', { data: { variable: WINDOWS_TERMINAL_ENV } });
    },
  },
  {
    id: 'delegate.codex-legacy-path',
    group: 'delegate',
    title: 'Legacy Codex skill copies',
    severities: ['info'],
    why: 'The Codex delegation add-on is experimental and its skill directory moved; a copy left in the old place is read by nothing and drifts from the installed one.',
    fix: 'Remove the old directory once the skill is installed in the documented location.',
    source: 'spec D18',
    run: (context) => {
      const legacy = context.delegate.legacySkillsPath;
      if (legacy === null) return pass('no legacy Codex skill directory was found');
      return info('a legacy Codex skill directory is present and is not read by anything', {
        details: [legacy],
        data: { path: legacy },
      });
    },
  },
]);
