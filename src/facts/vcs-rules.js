// VCS rules for the facts file, the permission render and the `--in-project` printout (spec 8.5.3, 9.7).
import { getReadOnlyAllowPatterns, isVcsKind, VCS_TABLES, VCS_WRITE_DENY } from '../../plugin/opencode-unity-lib/vcs-tables.js';

export const IN_PROJECT_DIR = '.opencode-unity';
export const OPENCODE_DIR = '.opencode';

// Files OpenCode itself writes into a config directory at every start (OC config/config.ts).
export const OPENCODE_GENERATED_ENTRIES = Object.freeze(['node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore']);

/**
 * @typedef {object} VcsRules
 * @property {string} kind                       A VCS kind, or `none`.
 * @property {string} displayName
 * @property {string[]} readOnlyAllow            Bash patterns the agent may run.
 * @property {string[]} writeDeny                Bash patterns denied for every client.
 * @property {boolean} experimental
 * @property {string | null} note
 */

/**
 * @param {string | null | undefined} kind
 * @returns {VcsRules}
 */
export function getVcsRules(kind) {
  const writeDeny = Object.keys(VCS_WRITE_DENY);
  if (!isVcsKind(kind)) {
    return { kind: 'none', displayName: 'none detected', readOnlyAllow: [], writeDeny, experimental: false, note: null };
  }
  const table = VCS_TABLES[kind];
  return {
    kind,
    displayName: table.displayName,
    readOnlyAllow: getReadOnlyAllowPatterns(kind),
    writeDeny,
    experimental: table.status === 'experimental',
    note: table.note,
  };
}

/**
 * The one-line VCS clause in facts.md, for example
 * `git (writes denied; status/diff/log/show/blame allowed)`.
 * @param {string | null | undefined} kind
 * @returns {string}
 */
export function renderVcsFactsClause(kind) {
  const rules = getVcsRules(kind);
  if (rules.kind === 'none') return 'none detected (VCS commands denied)';
  const table = VCS_TABLES[/** @type {import('../../plugin/opencode-unity-lib/vcs-tables.js').VcsKind} */ (rules.kind)];
  const allowed = table.readOnlySubcommands.join('/');
  const parts = [`writes denied; ${allowed} allowed`];
  if (rules.experimental) parts.push('experimental');
  if (rules.note) parts.push(rules.note);
  return `${rules.displayName} (${parts.join('; ')})`;
}

/**
 * @typedef {object} IgnoreGuidance
 * @property {string} mechanism         Where the rules go, for example `.gitignore`.
 * @property {string[]} lines           Lines to add, or commands to run for property-based systems.
 * @property {string[]} notes
 */

/**
 * What to ignore after `init --in-project`. Printed, never applied (spec 9.7).
 * @param {string | null | undefined} kind
 * @param {{ opencodeDir?: boolean }} [options]
 * @returns {IgnoreGuidance}
 */
export function renderIgnoreGuidance(kind, { opencodeDir = false } = {}) {
  const rules = getVcsRules(kind);
  if (rules.kind === 'none') {
    return { mechanism: 'none', lines: [], notes: ['No version control was detected, so there is nothing to ignore.'] };
  }
  const style = IGNORE_STYLES[rules.kind];
  /** @type {string[]} */
  const notes = [`Add these to ${style.mechanism} only if your team does not want to commit ${IN_PROJECT_DIR}/.`];
  const lines = [style.directory(IN_PROJECT_DIR)];
  if (opencodeDir && rules.kind === 'git') {
    notes.push(`${OPENCODE_DIR}/ exists: OpenCode writes its own ${OPENCODE_DIR}/.gitignore for the files it generates there.`);
  } else if (opencodeDir) {
    notes.push(`${OPENCODE_DIR}/ exists: OpenCode installs these into it at every start.`);
    lines.push(...OPENCODE_GENERATED_ENTRIES.map((entry) => style.path(`${OPENCODE_DIR}/${entry}`)));
  }
  return { mechanism: style.mechanism, lines, notes };
}

/** @type {Record<string, { mechanism: string, directory: (name: string) => string, path: (value: string) => string }>} */
const IGNORE_STYLES = {
  git: { mechanism: '.gitignore', directory: (name) => `${name}/`, path: (value) => `/${value}` },
  plastic: { mechanism: 'ignore.conf', directory: (name) => `/${name}`, path: (value) => `/${value}` },
  perforce: { mechanism: '.p4ignore', directory: (name) => `${name}/`, path: (value) => `${value}` },
  // svn:ignore is a property, so the guidance is a command the user runs.
  svn: {
    mechanism: 'the svn:ignore property',
    directory: (name) => `svn propedit svn:ignore .   # add a line: ${name}`,
    path: (value) => `svn propedit svn:ignore ${value.split('/').slice(0, -1).join('/')}   # add a line: ${value.split('/').pop()}`,
  },
  // `re:` works whether the file is in regexp or glob syntax.
  hg: { mechanism: '.hgignore', directory: (name) => `re:^${name.replace(/\./g, '\\.')}/`, path: (value) => `re:^${value.replace(/\./g, '\\.')}$` },
};
