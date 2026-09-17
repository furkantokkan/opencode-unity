// Version control tables (spec 8.5.2, 8.5.3, 9.2, 9.7). Shared by the CLI (facts, permission render) and
// the plugin's shell guard, so it imports nothing and runs in Node and Bun alike.

/** @typedef {'git' | 'plastic' | 'perforce' | 'svn' | 'hg'} VcsKind */

/**
 * @typedef {object} VcsTable
 * @property {VcsKind} kind
 * @property {string} displayName
 * @property {string} binary                    Command-line client.
 * @property {ReadonlyArray<string>} readOnlySubcommands
 * @property {ReadonlyArray<string>} readOnlyAllow  OpenCode bash permission patterns.
 * @property {'reference-tested' | 'experimental'} status
 * @property {string} ignoreMechanism          Where a team adds ignore rules (printed, never applied).
 * @property {string | null} note              Extra fact for the agent, or null.
 */

/** Searched from the project root upward, nearest directory first; within one directory in this order. */
export const VCS_MARKERS = Object.freeze([
  Object.freeze({ kind: /** @type {VcsKind} */ ('git'), name: '.git', type: 'any' }),
  Object.freeze({ kind: /** @type {VcsKind} */ ('plastic'), name: '.plastic', type: 'dir' }),
  Object.freeze({ kind: /** @type {VcsKind} */ ('perforce'), name: '.p4config', type: 'file' }),
  Object.freeze({ kind: /** @type {VcsKind} */ ('svn'), name: '.svn', type: 'dir' }),
  Object.freeze({ kind: /** @type {VcsKind} */ ('hg'), name: '.hg', type: 'dir' }),
]);

/** @type {Readonly<Record<VcsKind, VcsTable>>} */
export const VCS_TABLES = Object.freeze({
  git: freezeTable({
    kind: 'git',
    displayName: 'git',
    binary: 'git',
    readOnlySubcommands: ['status', 'diff', 'log', 'show', 'blame'],
    status: 'reference-tested',
    ignoreMechanism: '.gitignore',
    note: null,
  }),
  plastic: freezeTable({
    kind: 'plastic',
    displayName: 'Unity Version Control',
    binary: 'cm',
    // `cm diff` can open a GUI and hang, so only status is allowed.
    readOnlySubcommands: ['status'],
    status: 'reference-tested',
    ignoreMechanism: 'ignore.conf',
    note: null,
  }),
  perforce: freezeTable({
    kind: 'perforce',
    displayName: 'Perforce',
    binary: 'p4',
    readOnlySubcommands: ['opened', 'status', 'diff'],
    status: 'experimental',
    ignoreMechanism: '.p4ignore',
    note: 'files may be read-only until checked out',
  }),
  svn: freezeTable({
    kind: 'svn',
    displayName: 'SVN',
    binary: 'svn',
    readOnlySubcommands: ['status', 'diff', 'log'],
    status: 'experimental',
    ignoreMechanism: 'svn:ignore property',
    note: null,
  }),
  hg: freezeTable({
    kind: 'hg',
    displayName: 'Mercurial',
    binary: 'hg',
    readOnlySubcommands: ['status', 'diff', 'log'],
    status: 'experimental',
    ignoreMechanism: '.hgignore',
    note: null,
  }),
});

export const VCS_KINDS = Object.freeze(/** @type {VcsKind[]} */ (Object.keys(VCS_TABLES)));

/** Every VCS client, whatever was detected. */
export const VCS_BINARIES = Object.freeze(VCS_KINDS.map((kind) => VCS_TABLES[kind].binary));

/** VCS_WRITE_DENY from spec 8.5.2: every client is denied first; read-only patterns are allowed after it. */
export const VCS_WRITE_DENY = Object.freeze(Object.fromEntries(VCS_BINARIES.map((binary) => [`${binary} *`, 'deny'])));

/**
 * @param {string | null | undefined} kind
 * @returns {kind is VcsKind}
 */
export function isVcsKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(VCS_TABLES, kind);
}

/**
 * @param {string | null | undefined} kind  A VCS kind, or `none`/null when nothing was detected.
 * @returns {string[]} Bash allow patterns in table order.
 */
export function getReadOnlyAllowPatterns(kind) {
  return isVcsKind(kind) ? [...VCS_TABLES[kind].readOnlyAllow] : [];
}

/**
 * @param {Omit<VcsTable, 'readOnlyAllow'>} table
 * @returns {VcsTable}
 */
function freezeTable(table) {
  return Object.freeze({
    ...table,
    readOnlySubcommands: Object.freeze([...table.readOnlySubcommands]),
    readOnlyAllow: Object.freeze(table.readOnlySubcommands.map((subcommand) => `${table.binary} ${subcommand} *`)),
  });
}
