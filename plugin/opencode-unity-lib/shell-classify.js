// Shell command classification (spec 8.7.1, amendment 33.7 and 35.8). The plugin runs this from
// `tool.execute.before`, which fires for every shell call whether or not OpenCode's own permission
// layer produced a pattern for it, so it is the only boundary that holds on Windows.
//
// Three layers, in this order (D-M26):
//   1. deny-unmodelled, on every family including powershell and cmd: a string whose family grammar
//      we do not model is denied, and so is a string that yields zero command nodes, because that is
//      exactly the shape the permission layer never evaluates.
//   2. blocked first tokens, matched after basename normalisation (path segment, case-fold, trailing
//      .exe/.cmd/.bat/.ps1/.com removed). The wrappers, the VCS clients and the caller-supplied list
//      (the network tokens of S36) are checked here.
//   3. blocked substrings anywhere in the text, for constructs that defeat token matching.
//
// It is a guardrail, not a sandbox: an allowed command is still a program that can do anything.
// Everything here is pure, so it imports nothing but the VCS tables.
import { VCS_BINARIES, VCS_TABLES, isVcsKind } from './vcs-tables.js';

/**
 * @typedef {'posix' | 'powershell' | 'cmd'} ShellFamily
 * @typedef {'allow' | 'deny'} ShellDecision
 */

/**
 * @typedef {'shell_empty' | 'shell_unparsable' | 'shell_unmodelled' | 'shell_no_command_node'
 *   | 'shell_wrapper' | 'shell_encoded_command' | 'shell_vcs_write' | 'shell_recursive_delete'
 *   | 'shell_protected_write' | 'shell_network_hub' | 'shell_blocked_command'
 *   | 'shell_blocked_text'} ShellDenyCode
 */

/**
 * @typedef {object} ShellCommandNode
 * @property {string} name      First token as written.
 * @property {string} program   Basename-normalised first token, lowercased.
 * @property {string[]} args    Remaining tokens, quotes removed.
 * @property {string[]} writeTargets  Redirection targets of this node.
 */

/**
 * @typedef {object} ShellClassification
 * @property {ShellDecision} decision
 * @property {ShellFamily} family
 * @property {ShellDenyCode | null} code
 * @property {string | null} reason        English, safe to show the model; never quotes the command.
 * @property {ShellCommandNode[]} commands
 */

/** Interpreter wrappers: whatever they run is not visible to the permission layer. */
export const WRAPPER_PROGRAMS = Object.freeze(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'wsl', 'wsl2', 'busybox', 'env', 'nohup', 'xargs', 'start', 'sudo', 'doas', 'runas']);

/** Recursive-delete forms, per family, matched on the normalised program plus its flags. */
const DELETE_PROGRAMS = Object.freeze(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rmi', 'format', 'mkfs', 'diskpart']);
const RECURSIVE_FLAGS = Object.freeze(['-r', '-rf', '-fr', '-rd', '--recursive', '/s', '/q', '-recurse', '-force']);

/** Write-capable programs whose target is checked against the protected globs. */
const WRITE_PROGRAMS = Object.freeze(['set-content', 'sc', 'out-file', 'add-content', 'ac', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'xcopy', 'robocopy', 'cp', 'mv', 'tee', 'tee-object', 'truncate', 'install']);

/** Programs that speak HTTP; blocked when the target names the local MCP hub (spec 8.7.1). */
const HTTP_PROGRAMS = Object.freeze(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'httpie', 'http', 'aria2c']);

/** Executable suffixes removed before a first token is matched against a list. */
const PROGRAM_SUFFIXES = Object.freeze(['.exe', '.cmd', '.bat', '.ps1', '.com', '.msc']);

/**
 * @typedef {{ separators: ReadonlyArray<string>, unmodelled: ReadonlyArray<{ pattern: RegExp, what: string }> }} ShellGrammar
 */

/**
 * Every metacharacter that means something in at least one of the three families and is not one of
 * that family's separators. One list for all of them, because a character that is inert on cmd has no
 * business in a plain command either, and a single list cannot drift per family. It is checked after
 * the family's own entries, so a family keeps its own wording for the shapes that matter most.
 * A wildcard is here because the command the classifier reads is not the command that runs once the
 * wildcard has expanded into file names it never saw.
 * @type {ReadonlyArray<{ pattern: RegExp, what: string }>}
 */
const COMMON_UNMODELLED = Object.freeze([
  { pattern: /[*?]/, what: 'a wildcard' },
  { pattern: /[[\]]/, what: 'a bracket expression' },
  { pattern: /~/, what: 'a home directory expansion' },
  // `%` is a variable on cmd, the ForEach-Object alias on PowerShell and a job reference on posix.
  { pattern: /%/, what: 'an expansion or job reference' },
  { pattern: /`/, what: 'a backtick' },
  { pattern: /!/, what: 'an expansion or negation operator' },
  { pattern: /\$/, what: 'a variable expansion' },
  { pattern: /[{}]/, what: 'a brace expression' },
  { pattern: /\^/, what: 'an escape character' },
  { pattern: /::/, what: 'a label or member operator' },
  { pattern: /[\r\v\f\x00-\x08\x0e-\x1f]/, what: 'a control character' },
]);

/**
 * What still expands inside a double-quoted run, per family. Double quotes suppress word splitting,
 * not expansion: `$(...)`, `${...}` and a backtick all still run inside them on posix and powershell,
 * and cmd has no literal quote at all, so `%VAR%` expands inside either of its quote characters.
 * These characters stay visible to the layer-1 scan while the rest of the run becomes filler, because
 * blanking a whole double-quoted run would let two characters step around the primary rule: 35.8's
 * `"$(git push)"` and `"$([Net.WebClient]::new())"` would read as a plain word.
 * @type {Readonly<Record<ShellFamily, string>>}
 */
const EXPANDS_INSIDE_QUOTES = Object.freeze({ posix: '$`', powershell: '$`', cmd: '%' });

/**
 * Per-family grammar: `unmodelled` is everything the tokenizer refuses to read, and a string that
 * trips none of it is parsed with the separators below. Kept as data so a family can be added without
 * touching the algorithm.
 * @type {Readonly<Record<ShellFamily, ShellGrammar>>}
 */
export const SHELL_FAMILIES = Object.freeze({
  posix: freezeFamily({
    separators: [';', '&&', '||', '|', '\n'],
    unmodelled: [
      { pattern: /\$/, what: 'a variable or command expansion' },
      // Every unquoted backslash: outside quotes it escapes the next character, which would join two
      // words this tokenizer reads as two.
      { pattern: /\\/, what: 'a backslash escape' },
      { pattern: /[()]/, what: 'a subshell' },
      { pattern: /[{}]/, what: 'a brace group or expansion' },
      { pattern: /(?:^|[^&|>])&(?!&)/, what: 'a background job' },
      { pattern: /^\s*#|\s#/, what: 'a comment' },
    ],
  }),
  powershell: freezeFamily({
    separators: [';', '&&', '||', '|', '\n'],
    unmodelled: [
      { pattern: /\[/, what: 'a type literal' },
      { pattern: /::/, what: 'the static member operator' },
      { pattern: /@[({]/, what: 'an array or hashtable expression' },
      { pattern: /\$/, what: 'a variable or subexpression' },
      { pattern: /[()]/, what: 'a grouping expression' },
      { pattern: /[{}]/, what: 'a script block' },
      { pattern: /(?:^|\s)\.(?=\s)/, what: 'the dot-source operator' },
      { pattern: /(?:^|\s)-(?:join|split|replace|as)(?=\s|$)/i, what: 'a string construction operator' },
      { pattern: /\+/, what: 'string concatenation' },
      { pattern: /(?:^|[^&|>])&(?!&)/, what: 'a call operator' },
    ],
  }),
  cmd: freezeFamily({
    separators: ['&&', '||', '&', '|', '\n'],
    unmodelled: [
      { pattern: /%/, what: 'an environment variable expansion' },
      { pattern: /\^/, what: 'a caret escape' },
      { pattern: /[()]/, what: 'a command group' },
    ],
  }),
});

/** Substrings that defeat token-level matching, checked over the whole text (layer 3). */
export const BLOCKED_TEXT = Object.freeze([
  { pattern: /-encodedcommand|-enc\b|-e\s+[A-Za-z0-9+/]{24,}={0,2}/i, what: 'an encoded command' },
  { pattern: /invoke-expression|(?:^|\s)iex(?:\s|$)/i, what: 'expression evaluation' },
  { pattern: /\/dev\/(?:tcp|udp)\//i, what: 'a socket redirection' },
]);

/**
 * @typedef {object} ClassifyOptions
 * @property {ShellFamily} [family]                  Defaults to the family of `platform`.
 * @property {string} [platform]                     `process.platform`; only used to pick a family.
 * @property {string | null} [vcsKind]               Detected VCS, or null/`none` when there is none.
 * @property {string[]} [protectedWriteGlobs]        Globs a redirection or copy may not target.
 * @property {{ host: string, port: string } | null} [mcpHub]  Local MCP hub, blocked for HTTP clients.
 * @property {string[]} [blockedPrograms]            Extra first tokens to deny (S36 fills this).
 * @property {string[]} [allowExactCommands]         Verify commands, allowed by full-string equality only.
 */

/**
 * @param {string} platform
 * @returns {ShellFamily}
 */
export function getDefaultFamily(platform) {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * The whole decision for one shell tool call.
 * @param {string} command
 * @param {ClassifyOptions} [options]
 * @returns {ShellClassification}
 */
export function classifyShellCommand(command, options = {}) {
  const family = options.family ?? getDefaultFamily(options.platform ?? process.platform);
  const text = typeof command === 'string' ? command : '';
  if (text.trim().length === 0) return deny(family, 'shell_empty', 'the command is empty', []);

  const exact = (options.allowExactCommands ?? []).includes(text);
  const parsed = parseShellCommand(text, family);
  if (!parsed.ok) return deny(family, parsed.code, parsed.reason, []);
  if (parsed.commands.length === 0) {
    return deny(family, 'shell_no_command_node', 'the command runs no program the permission rules can see', []);
  }

  const blockedText = BLOCKED_TEXT.find((entry) => entry.pattern.test(text));
  if (blockedText) return deny(family, 'shell_blocked_text', `the command contains ${blockedText.what}`, parsed.commands);

  for (const node of parsed.commands) {
    const verdict = checkCommandNode(node, { ...options, family, exact });
    if (verdict) return deny(family, verdict.code, verdict.reason, parsed.commands);
  }
  return { decision: 'allow', family, code: null, reason: null, commands: parsed.commands };
}

/**
 * Splits a command string into command nodes, refusing anything the family grammar does not model.
 * @param {string} text
 * @param {ShellFamily} family
 * @returns {{ ok: true, commands: ShellCommandNode[] } | { ok: false, code: ShellDenyCode, reason: string }}
 */
export function parseShellCommand(text, family) {
  const grammar = SHELL_FAMILIES[family];
  if (!grammar) return { ok: false, code: 'shell_unmodelled', reason: `shell family ${family} is not modelled` };
  if (text.includes('\0')) return { ok: false, code: 'shell_unmodelled', reason: 'the command contains a null byte' };

  const stripped = stripQuoted(text, family);
  if (!stripped.ok) return { ok: false, code: 'shell_unparsable', reason: 'the command has an unbalanced quote' };
  if (stripped.newlineInQuote) return { ok: false, code: 'shell_unmodelled', reason: 'the command contains a newline inside a quoted argument' };
  const unmodelled = grammar.unmodelled.find((entry) => entry.pattern.test(stripped.text));
  if (unmodelled) return { ok: false, code: 'shell_unmodelled', reason: `the command contains ${unmodelled.what}` };

  const tokens = tokenize(text, family);
  if (!tokens.ok) return { ok: false, code: 'shell_unparsable', reason: 'the command has an unbalanced quote' };
  return { ok: true, commands: buildNodes(tokens.tokens, grammar.separators) };
}

/**
 * Basename, lowercase, without an executable suffix: `C:\Windows\System32\curl.exe` -> `curl`.
 * @param {string} token
 * @returns {string}
 */
export function normalizeProgram(token) {
  const segments = token.split(/[\\/]/);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  for (const suffix of PROGRAM_SUFFIXES) {
    if (base.length > suffix.length && base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

/**
 * Case-insensitive glob match over a path, with `*` spanning separators, as OpenCode's wildcard
 * matcher does. Both separators are accepted so one glob list covers both platforms.
 * @param {string} value
 * @param {string} glob
 * @returns {boolean}
 */
export function matchesGlob(value, glob) {
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  const pattern = glob.replace(/\\/g, '/').toLowerCase();
  const source = pattern.split('*').map(escapeRegExp).join('[\\s\\S]*');
  return new RegExp(`^${source}$`).test(normalized);
}

/**
 * @param {ShellCommandNode} node
 * @param {ClassifyOptions & { family: ShellFamily, exact: boolean }} options
 * @returns {{ code: ShellDenyCode, reason: string } | null}
 */
function checkCommandNode(node, options) {
  const { program, args } = node;
  if (WRAPPER_PROGRAMS.includes(program)) {
    return { code: 'shell_wrapper', reason: `${program} runs another command that the permission rules cannot see` };
  }
  if (VCS_BINARIES.includes(program)) {
    const vcsProblem = checkVcs(program, args, options.vcsKind ?? null);
    if (vcsProblem) return vcsProblem;
  }
  if (isRecursiveDelete(program, args)) {
    return { code: 'shell_recursive_delete', reason: `${program} would delete a directory tree` };
  }
  const protectedTarget = findProtectedTarget(node, options.protectedWriteGlobs ?? [], options.family);
  if (protectedTarget) {
    return { code: 'shell_protected_write', reason: 'the command would write a protected Unity or project file' };
  }
  if (HTTP_PROGRAMS.includes(program) && options.mcpHub && argsReachHub(args, options.mcpHub)) {
    return { code: 'shell_network_hub', reason: `${program} would call the local Unity MCP hub, which only the editor agent may use` };
  }
  if (!options.exact && (options.blockedPrograms ?? []).includes(program)) {
    return { code: 'shell_blocked_command', reason: `${program} is not available to the agent` };
  }
  return null;
}

/**
 * A VCS client is allowed only for the read-only subcommands of the VCS this project actually uses.
 * @param {string} program
 * @param {string[]} args
 * @param {string | null} vcsKind
 * @returns {{ code: ShellDenyCode, reason: string } | null}
 */
function checkVcs(program, args, vcsKind) {
  if (!isVcsKind(vcsKind)) {
    return { code: 'shell_vcs_write', reason: `${program} is blocked because no ${program} working copy was detected for this project` };
  }
  const table = VCS_TABLES[vcsKind];
  if (table.binary !== program) {
    return { code: 'shell_vcs_write', reason: `${program} is blocked because this project uses ${table.displayName}` };
  }
  const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase() ?? '';
  if (!table.readOnlySubcommands.includes(subcommand)) {
    return { code: 'shell_vcs_write', reason: `${program} ${subcommand || '(no subcommand)'} can change version control, so it is blocked` };
  }
  return null;
}

/**
 * @param {string} program
 * @param {string[]} args
 * @returns {boolean}
 */
function isRecursiveDelete(program, args) {
  if (!DELETE_PROGRAMS.includes(program)) return false;
  if (program === 'format' || program === 'mkfs' || program === 'diskpart') return true;
  if (program === 'rmdir' || program === 'rd') return true;
  const flags = args.filter((arg) => arg.startsWith('-') || arg.startsWith('/')).map((arg) => arg.toLowerCase());
  return flags.some((flag) => RECURSIVE_FLAGS.includes(flag) || /^-[a-z]*r/.test(flag));
}

/**
 * Redirections and copying programs both write; both targets are checked against the protected globs.
 * @param {ShellCommandNode} node
 * @param {string[]} globs
 * @param {ShellFamily} family
 * @returns {string | null}
 */
function findProtectedTarget(node, globs, family) {
  if (globs.length === 0) return null;
  const candidates = [...node.writeTargets];
  if (WRITE_PROGRAMS.includes(node.program)) candidates.push(...node.args.filter((arg) => !isSwitchArgument(arg, family)));
  return candidates.find((target) => globs.some((glob) => matchesGlob(target, glob))) ?? null;
}

/** A Windows switch: `/s`, `/q`, `/MIR`, `/LOG:x`. One segment, so it can never be a path. */
const WINDOWS_SWITCH = /^\/[A-Za-z?][A-Za-z0-9]{0,7}(?::[^/\\]*)?$/;

/**
 * An argument that names a switch rather than a file, so it is not a write target. A leading `-` is a
 * switch on every family. A leading `/` is one on the Windows families only: on posix it is how an
 * absolute path starts, and dropping those let `cp blank.txt /project/Assets/Scenes/Main.unity` past
 * the check that the same write with a relative destination failed.
 * @param {string} arg
 * @param {ShellFamily} family
 * @returns {boolean}
 */
function isSwitchArgument(arg, family) {
  if (arg.startsWith('-')) return true;
  return family !== 'posix' && WINDOWS_SWITCH.test(arg);
}

/**
 * @param {string[]} args
 * @param {{ host: string, port: string }} hub
 * @returns {boolean}
 */
function argsReachHub(args, hub) {
  const host = hub.host.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  return args.some((arg) => {
    const value = arg.toLowerCase();
    if (!value.includes(`:${hub.port}`)) return false;
    if (value.includes(host)) return true;
    return loopback && /(?:^|\/\/|@)(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):/.test(value);
  });
}

/**
 * Replaces every quoted run with a placeholder so the unmodelled patterns only see shell syntax.
 * @param {string} text
 * @param {ShellFamily} family
 * @returns {{ ok: true, text: string, newlineInQuote: boolean } | { ok: false }}
 */
function stripQuoted(text, family) {
  let out = '';
  let index = 0;
  let newlineInQuote = false;
  while (index < text.length) {
    const char = text[index];
    if (char !== '"' && char !== "'") {
      out += char;
      index += 1;
      continue;
    }
    const end = findQuoteEnd(text, index, family);
    if (end < 0) return { ok: false };
    if (text.slice(index, end).includes('\n')) newlineInQuote = true;
    out += maskQuotedRun(text.slice(index + 1, end), char, family);
    index = end + 1;
  }
  return { ok: true, text: out, newlineInQuote };
}

/**
 * The filler one quoted run leaves behind for the layer-1 scan. A single-quoted run is literal on
 * posix and powershell, so none of it survives; every other run keeps the characters its family still
 * expands and turns the rest - spaces and separators included - into one filler letter each, so a
 * quoted word can never read as syntax and an expansion inside one can never read as a word.
 * @param {string} body       The run without its quotes.
 * @param {string} quote      The quote character that opened it.
 * @param {ShellFamily} family
 * @returns {string}
 */
function maskQuotedRun(body, quote, family) {
  if (body === '' || (quote === "'" && family !== 'cmd')) return 'Q';
  const expanding = EXPANDS_INSIDE_QUOTES[family];
  let out = '';
  for (const char of body) out += expanding.includes(char) ? char : 'Q';
  return out;
}

/**
 * @param {string} text
 * @param {number} start   Index of the opening quote.
 * @param {ShellFamily} family
 * @returns {number} Index of the closing quote, or -1.
 */
function findQuoteEnd(text, start, family) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && family === 'posix' && quote === '"') {
      index += 1;
      continue;
    }
    if (char !== quote) continue;
    // PowerShell and cmd double a quote to escape it inside the same kind of quoting.
    if (family !== 'posix' && text[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

/**
 * @typedef {{ kind: 'word', value: string } | { kind: 'separator', value: string } | { kind: 'redirect', value: string }} ShellToken
 */

/**
 * @param {string} text
 * @param {ShellFamily} family
 * @returns {{ ok: true, tokens: ShellToken[] } | { ok: false }}
 */
function tokenize(text, family) {
  const separators = SHELL_FAMILIES[family].separators;
  /** @type {ShellToken[]} */
  const tokens = [];
  let word = '';
  let index = 0;
  const flush = () => {
    if (word.length > 0) tokens.push({ kind: 'word', value: word });
    word = '';
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = findQuoteEnd(text, index, family);
      if (end < 0) return { ok: false };
      word += unquote(text.slice(index, end + 1), family);
      index = end + 1;
      continue;
    }
    const separator = separators.find((candidate) => text.startsWith(candidate, index));
    if (separator) {
      flush();
      tokens.push({ kind: 'separator', value: separator });
      index += separator.length;
      continue;
    }
    const redirect = matchRedirect(text, index);
    if (redirect) {
      flush();
      tokens.push({ kind: 'redirect', value: redirect });
      index += redirect.length;
      continue;
    }
    if (char === ' ' || char === '\t') {
      flush();
      index += 1;
      continue;
    }
    word += char;
    index += 1;
  }
  flush();
  return { ok: true, tokens };
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {string | null}
 */
function matchRedirect(text, index) {
  const match = /^\d?>>|^\d?>|^</.exec(text.slice(index, index + 3));
  return match ? match[0] : null;
}

/**
 * @param {string} token
 * @param {ShellFamily} family
 * @returns {string}
 */
function unquote(token, family) {
  const quote = token[0];
  const body = token.slice(1, -1);
  if (family === 'posix') return quote === "'" ? body : body.replace(/\\(["\\$`])/g, '$1');
  return body.split(`${quote}${quote}`).join(quote);
}

/**
 * Groups tokens into command nodes: one per segment between separators, the way OpenCode's
 * tree-sitter pass produces one `command` node per pipeline element.
 * @param {ShellToken[]} tokens
 * @param {ReadonlyArray<string>} separators
 * @returns {ShellCommandNode[]}
 */
function buildNodes(tokens, separators) {
  /** @type {ShellCommandNode[]} */
  const nodes = [];
  /** @type {string[]} */
  let words = [];
  /** @type {string[]} */
  let writeTargets = [];
  let pendingRedirect = false;
  const end = () => {
    if (words.length > 0) {
      const [name, ...args] = words;
      nodes.push({ name, program: normalizeProgram(name), args, writeTargets });
    }
    words = [];
    writeTargets = [];
    pendingRedirect = false;
  };
  for (const token of tokens) {
    if (token.kind === 'separator' && separators.includes(token.value)) {
      end();
      continue;
    }
    if (token.kind === 'redirect') {
      pendingRedirect = token.value.includes('>');
      continue;
    }
    if (pendingRedirect) {
      writeTargets.push(token.value);
      pendingRedirect = false;
      continue;
    }
    words.push(token.value);
  }
  end();
  return nodes;
}

/**
 * @param {ShellFamily} family
 * @param {ShellDenyCode} code
 * @param {string} reason
 * @param {ShellCommandNode[]} commands
 * @returns {ShellClassification}
 */
function deny(family, code, reason, commands) {
  return { decision: 'deny', family, code, reason, commands };
}

/**
 * @param {{ separators: string[], unmodelled: Array<{ pattern: RegExp, what: string }> }} family
 * @returns {ShellGrammar}
 */
function freezeFamily(family) {
  return Object.freeze({
    // Longest first, so `&&` is never read as `&`.
    separators: Object.freeze([...family.separators].sort((left, right) => right.length - left.length)),
    unmodelled: Object.freeze([...family.unmodelled.map((entry) => Object.freeze(entry)), ...COMMON_UNMODELLED]),
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
