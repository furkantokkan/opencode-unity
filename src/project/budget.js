// Discovery budgets and the one read path every detector uses (amendment 37.4, D-B7, S-BM-1).
//
// Two jobs, deliberately in one module because they are the same decision made twice: what a detector
// is allowed to open, and how much of it. Detection is metered - 24 files, 256 KB and 400 lines per
// component, 6 MB per workspace - and the single most important property is negative: the scanner
// never opens a path the read deny set covers. Not because the model must not see it, but because
// anything the scanner reads can land in facts.md, project.json, a doctor report a user pastes into an
// issue, or the session log. `.env.example` and its two spellings are the one exception, and only
// their key names are ever kept.
import { PROTECTED_READ_ALLOW_GLOB, PROTECTED_READ_GLOBS } from '../../plugin/opencode-unity-lib/protected-paths.js';
import { isProjectPath, joinProjectPath } from '../unity/fs-view.js';

/**
 * @typedef {object} DiscoveryLimits
 * @property {number} walkEntryCap      Directory entries visited for the whole workspace.
 * @property {number} maxDepth          Directory levels below the workspace root.
 * @property {number} filesPerComponent
 * @property {number} bytesPerFile
 * @property {number} linesPerFile
 * @property {number} workspaceBytes    Hard stop; later detectors then report `unbudgeted`.
 */

/** @type {DiscoveryLimits} */
export const DISCOVERY_LIMITS = Object.freeze({
  walkEntryCap: 50_000,
  maxDepth: 12,
  filesPerComponent: 24,
  bytesPerFile: 256 * 1024,
  linesPerFile: 400,
  workspaceBytes: 6 * 1024 * 1024,
});

/**
 * Names whose content is never useful and often enormous: the file's name is the evidence (D-B7,
 * 37.4). A detector asks `isNeverOpened` before it reaches for one.
 */
export const NEVER_OPENED_FILES = Object.freeze([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'packages-lock.json',
  'Gemfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'composer.lock',
]);

/**
 * @typedef {object} ReadRule
 * @property {string} pattern
 * @property {'deny' | 'allow'} action
 */

/**
 * The scanner's read deny set: SPEC 8.5.2's `PROTECTED_READ` plus amendment 37.9's
 * `BACKEND_READ_DENY`. Evaluated in order with the **last** match winning, which is what lets the
 * three `.env.example` spellings at the end beat the `*.env.*` deny above them.
 *
 * `*` matches any characters including `/`, exactly as the rendered permission tables spell these
 * globs, and matching is case-insensitive: a Windows volume would otherwise let `.ENV` through a
 * scanner that a POSIX volume refuses.
 * @type {ReadonlyArray<ReadRule>}
 */
export const SCANNER_READ_DENY = Object.freeze(
  [
    // SPEC 8.5.2 PROTECTED_READ, from the same table the rendered permission rules deny: one list, so
    // a pattern added for the model is never missing from the scanner.
    ...PROTECTED_READ_GLOBS,
    // Amendment 37.9 BACKEND_READ_DENY. The last four are budget, not secrecy: a scanner that reads a
    // bundled file has spent its budget on generated text.
    '*.runtimeconfig.json',
    '*firebase-adminsdk*.json',
    '*appsettings*.json',
    '*.tfvars',
    '*terraform.tfstate*',
    '*kubeconfig*',
    '*.kube/config',
    '*secrets*.yml',
    '*secrets*.yaml',
    '*.dbpass',
    '*.pgpass',
    '*node_modules/*',
    '*dist/*',
    '*build/*',
    '*coverage/*',
  ]
    .map((pattern) => /** @type {ReadRule} */ ({ pattern, action: 'deny' }))
    // Last, so they win: a template by construction, and the scanner's one credential-adjacent read.
    .concat([
      { pattern: PROTECTED_READ_ALLOW_GLOB, action: 'allow' },
      { pattern: '*.env.sample', action: 'allow' },
      { pattern: '*.env.template', action: 'allow' },
    ]),
);

/** @type {Map<string, RegExp>} */
const patternCache = new Map();

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let regex = patternCache.get(pattern);
  if (!regex) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    regex = new RegExp(`^${source}$`, 'i');
    patternCache.set(pattern, regex);
  }
  return regex;
}

/**
 * @param {string} relativePath  POSIX, relative to the workspace root.
 * @param {ReadonlyArray<ReadRule>} [rules]
 * @returns {boolean}
 */
export function isProtectedReadPath(relativePath, rules = SCANNER_READ_DENY) {
  let denied = false;
  for (const rule of rules) {
    if (globToRegExp(rule.pattern).test(relativePath)) denied = rule.action === 'deny';
  }
  return denied;
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isNeverOpenedFile(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return NEVER_OPENED_FILES.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

/**
 * @typedef {object} ReadResult
 * @property {'ok' | 'missing' | 'denied' | 'never-opened' | 'unbudgeted' | 'too-large'} status
 * @property {string | null} text        Null unless `status` is `ok`.
 * @property {boolean} truncated         The byte or line cap cut the content.
 * @property {number} size               Full size in bytes; 0 when nothing was opened.
 */

/**
 * @typedef {object} BudgetState
 * @property {number} bytesRead
 * @property {number} filesOpened
 * @property {boolean} exhausted
 * @property {string[]} opened           Relative paths actually opened, in order. The audit trail.
 * @property {string[]} refused          Relative paths refused, in order, as `<status> <path>`.
 */

/**
 * @typedef {object} ReadBudget
 * @property {(relativePath: string, options?: { component?: string, maxBytes?: number, maxLines?: number }) => ReadResult} readText
 * @property {(relativePath: string, options?: { component?: string }) => { status: ReadResult['status'], value: unknown, error: string | null }} readJson
 * @property {(component: string) => number} filesOpenedFor
 * @property {(component: string) => 'ok' | 'unbudgeted'} statusFor
 * @property {BudgetState} state
 */

/**
 * The budget-accounted, deny-checked read view every detector is given. A detector never sees the raw
 * `FsView`, so the deny set cannot be bypassed by forgetting to call a helper.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root  Absolute workspace root.
 * @param {{ limits?: Partial<DiscoveryLimits>, rules?: ReadonlyArray<ReadRule> }} [options]
 * @returns {ReadBudget}
 */
export function createReadBudget(view, root, { limits = {}, rules = SCANNER_READ_DENY } = {}) {
  const caps = { ...DISCOVERY_LIMITS, ...limits };
  /** @type {BudgetState} */
  const state = { bytesRead: 0, filesOpened: 0, exhausted: false, opened: [], refused: [] };
  /** @type {Map<string, number>} */
  const perComponent = new Map();

  /**
   * @param {string} relativePath
   * @param {string} status
   * @returns {ReadResult}
   */
  const refuse = (relativePath, status) => {
    state.refused.push(`${status} ${relativePath}`);
    return { status: /** @type {ReadResult['status']} */ (status), text: null, truncated: false, size: 0 };
  };

  /** @type {ReadBudget['readText']} */
  const readText = (relativePath, { component = 'workspace', maxBytes = caps.bytesPerFile, maxLines = caps.linesPerFile } = {}) => {
    // First, before the deny globs: those are workspace-relative patterns, so a path that leaves the
    // root is matched against a string that no longer denotes the tree being scanned, and D-B7's
    // "the scanner never opens a PROTECTED_READ path" stops being a property of anything. Detectors
    // build paths out of untrusted repository content (S15), so no detector may steer a read out.
    if (!isProjectPath(relativePath)) return refuse(relativePath, 'denied');
    if (isProtectedReadPath(relativePath, rules)) return refuse(relativePath, 'denied');
    if (isNeverOpenedFile(relativePath)) return refuse(relativePath, 'never-opened');
    if (state.exhausted) return refuse(relativePath, 'unbudgeted');
    if ((perComponent.get(component) ?? 0) >= caps.filesPerComponent) return refuse(relativePath, 'unbudgeted');

    const stat = view.stat(joinProjectPath(root, relativePath));
    if (!stat?.isFile) return refuse(relativePath, 'missing');
    const wouldRead = Math.min(stat.size, maxBytes, caps.bytesPerFile);
    if (state.bytesRead + wouldRead > caps.workspaceBytes) {
      state.exhausted = true;
      return refuse(relativePath, 'unbudgeted');
    }

    const read = view.readText(joinProjectPath(root, relativePath), { maxBytes: Math.min(maxBytes, caps.bytesPerFile) });
    if (!read) return refuse(relativePath, 'missing');

    perComponent.set(component, (perComponent.get(component) ?? 0) + 1);
    state.filesOpened += 1;
    state.bytesRead += Math.min(read.size, maxBytes, caps.bytesPerFile);
    state.opened.push(relativePath);

    const lines = read.text.split('\n');
    const lineTruncated = lines.length > maxLines;
    return {
      status: 'ok',
      text: lineTruncated ? lines.slice(0, maxLines).join('\n') : read.text,
      truncated: read.truncated || lineTruncated,
      size: read.size,
    };
  };

  /** @type {ReadBudget['readJson']} */
  const readJson = (relativePath, { component = 'workspace' } = {}) => {
    const read = readText(relativePath, { component, maxLines: Number.MAX_SAFE_INTEGER });
    if (read.status !== 'ok') return { status: read.status, value: undefined, error: null };
    // The text is already in hand and inside the budget, so it is parsed without a second read.
    if (read.truncated) return { status: 'too-large', value: undefined, error: 'file too large' };
    const parsed = parseJsonText(read.text ?? '', relativePath);
    return { status: 'ok', value: parsed.value, error: parsed.error };
  };

  return {
    state,
    readText,
    readJson,
    filesOpenedFor: (component) => perComponent.get(component) ?? 0,
    statusFor: (component) => (state.exhausted || (perComponent.get(component) ?? 0) >= caps.filesPerComponent ? 'unbudgeted' : 'ok'),
  };
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {{ value: unknown, error: string | null }}
 */
function parseJsonText(text, source) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: undefined, error: `${source}: ${/** @type {Error} */ (error).message}` };
  }
}
