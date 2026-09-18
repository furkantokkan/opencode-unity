// Shell command classification (spec 8.7.1, amendment 33.7 and 35.8). The plugin runs this from
// `tool.execute.before`, which fires for every shell call whether or not OpenCode's own permission
// layer produced a pattern for it, so it is the only boundary that holds on Windows.
//
// Three layers, in this order (D-M26):
//   1. deny-unmodelled, on every family including powershell and cmd: a string whose family grammar
//      we do not model is denied, and so is a string that yields zero command nodes, because that is
//      exactly the shape the permission layer never evaluates. A command whose first token does not
//      reduce to a plain program name is denied here too, and so is one whose first token is a shell
//      keyword or an alias-defining construct: `if git push; then :; fi` and `Set-Alias g git; g push`
//      run git under a first word that is not git.
//   2. blocked first tokens, matched after basename normalisation (path segment, case-fold, trailing
//      .exe/.cmd/.bat/.ps1/.com removed). The wrappers, the VCS clients and the caller-supplied list
//      (the network tokens of S36) are checked here.
//   3. blocked substrings anywhere in the text, for constructs that defeat token matching.
//
// The families are data: `shell-families.json` holds the separators, the quoting rules, the switch
// prefixes and the metacharacter sets of each one, so a family is described rather than branched on.
// Every rule that used to ask "is this posix?" now asks the family for its own answer, which is what
// lets one tokenizer read three grammars without a second family silently inheriting the first one's
// quote handling.
//
// It is a guardrail, not a sandbox: an allowed command is still a program that can do anything.
import fs from 'node:fs';

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

/**
 * @typedef {object} ShellQuoting
 * @property {'backslash' | 'doubled'} escape        How a quote is escaped inside its own run.
 * @property {ReadonlyArray<string>} escapeInQuotes  The quote kinds that escape applies to.
 * @property {Readonly<Record<string, string>>} expands  Per quote kind, what still expands inside it.
 */

/**
 * @typedef {object} ShellGrammar
 * @property {string} id
 * @property {string} label
 * @property {ReadonlyArray<string>} separators
 * @property {ReadonlyArray<string>} switchPrefixes
 * @property {ReadonlyArray<string>} quoteChars
 * @property {ShellQuoting} quoting
 * @property {ReadonlyArray<{ pattern: RegExp, what: string }>} unmodelled
 */

export const SHELL_FAMILIES_URL = new URL('./shell-families.json', import.meta.url);

/** Executable suffixes removed before a first token is matched against a list. */
const PROGRAM_SUFFIXES = Object.freeze(['.exe', '.cmd', '.bat', '.ps1', '.com', '.msc']);

/**
 * What a first token has to look like once it is reduced to a basename. Anything else - a zsh
 * `=command` expansion, a leftover operator - is a way of naming a program this classifier cannot
 * follow, so it is denied in layer 1 rather than matched against lists it was never going to match
 * (amendment 35.8, layer 1 rule 3).
 */
const PLAIN_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * What the same token has to look like *before* it is reduced: a path and nothing else. The basename
 * on its own is not enough, because taking the last segment of `VAR=/tmp git push` leaves the plain
 * word `tmp` and hides an assignment prefix that makes the shell run the second word instead.
 */
const PLAIN_PROGRAM_NAME = /^[A-Za-z0-9 ._+:/\\-]+$/;

/** Recursive-delete forms, per family, matched on the normalised program plus its flags. */
const DELETE_PROGRAMS = Object.freeze(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rmi', 'format', 'mkfs', 'diskpart']);
const RECURSIVE_FLAGS = Object.freeze(['-r', '-rf', '-fr', '-rd', '--recursive', '/s', '/q', '-recurse', '-force']);

/** Write-capable programs whose target is checked against the protected globs. */
const WRITE_PROGRAMS = Object.freeze(['set-content', 'sc', 'out-file', 'add-content', 'ac', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'xcopy', 'robocopy', 'cp', 'mv', 'tee', 'tee-object', 'truncate', 'install']);

/** Programs that speak HTTP; blocked when the target names the local MCP hub (spec 8.7.1). */
const HTTP_PROGRAMS = Object.freeze(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'httpie', 'http', 'aria2c']);

/**
 * The shipped family table. A file that does not describe a usable grammar is a build error rather
 * than a user error, so this throws: a plugin that cannot classify must fail to load, and the plugin
 * then injects nothing (spec 8.7, failure rule).
 * @param {URL} [url]
 * @returns {{ families: Readonly<Record<string, ShellGrammar>>, shells: Readonly<Record<string, string>>, commandPrefixes: ReadonlyArray<string>, unmodelledCommands: ReadonlyArray<string>, unmodelledArguments: ReadonlyArray<{ pattern: RegExp, what: string }> }}
 */
export function loadShellFamilies(url = SHELL_FAMILIES_URL) {
  const data = JSON.parse(fs.readFileSync(url, 'utf8'));
  if (data?.schemaVersion !== 1) throw new TypeError('shell-families.json: unsupported schemaVersion');
  const common = readUnmodelled(data.common?.unmodelled, 'common');
  const ids = Object.keys(data.families ?? {});
  if (ids.length === 0) throw new TypeError('shell-families.json: no families');

  /** @type {Record<string, ShellGrammar>} */
  const families = {};
  for (const id of ids) families[id] = compileFamily(id, data.families[id], common);
  return {
    families: Object.freeze(families),
    shells: Object.freeze(readShells(data.shells, families)),
    commandPrefixes: Object.freeze(readStrings(data.commandPrefixes, 'commandPrefixes')),
    unmodelledCommands: Object.freeze(readStrings(data.unmodelledCommands, 'unmodelledCommands').map((name) => name.toLowerCase())),
    unmodelledArguments: Object.freeze(readUnmodelled(data.common?.unmodelledArguments, 'common.unmodelledArguments')),
  };
}

const shipped = loadShellFamilies();

/**
 * Per-family grammar: `unmodelled` is everything the tokenizer refuses to read, and a string that
 * trips none of it is parsed with the separators and the quoting of the same entry.
 * @type {Readonly<Record<string, ShellGrammar>>}
 */
export const SHELL_FAMILIES = shipped.families;

/** @type {ReadonlyArray<string>} */
export const SHELL_FAMILY_IDS = Object.freeze(Object.keys(SHELL_FAMILIES));

/**
 * Shell program name to the family whose grammar reads its command strings. Family selection resolves
 * a configured shell against this map, and it is also why every one of these names is a wrapper: a
 * shell invoked as a program runs a command the permission rules never see.
 * @type {Readonly<Record<string, string>>}
 */
export const SHELL_PROGRAM_FAMILIES = shipped.shells;

/** Programs that run another program named in their arguments, on every family. */
export const COMMAND_PREFIXES = shipped.commandPrefixes;

/** Interpreter wrappers: whatever they run is not visible to the permission layer. */
export const WRAPPER_PROGRAMS = Object.freeze([...new Set([...Object.keys(SHELL_PROGRAM_FAMILIES), ...COMMAND_PREFIXES])]);

/**
 * First words that are not programs - reserved words, and constructs that bind a name to a program or
 * run a command later - so the command they carry never becomes a first word any list can see.
 */
export const UNMODELLED_COMMANDS = shipped.unmodelledCommands;

/** Argument shapes that do the same from inside an ordinary command, such as `New-Item alias:g`. */
export const UNMODELLED_ARGUMENTS = shipped.unmodelledArguments;

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
 * The family whose grammar reads command strings for a shell program, or null when the name is not
 * one this product models. What an unknown shell means is the caller's decision; nothing is guessed
 * here, because guessing it wrong is how a bash command gets read with PowerShell's rules.
 * @param {string | null | undefined} shell  A shell name or path, optionally with arguments.
 * @returns {ShellFamily | null}
 */
export function familyForShell(shell) {
  if (typeof shell !== 'string') return null;
  const value = shell.trim();
  if (value.length === 0) return null;
  // A shell arrives as a bare name, as a path that may itself contain spaces, or as a path followed
  // by arguments, so the whole string is tried before its first word. A login shell is spelled with a
  // leading dash by convention, and it is the same program.
  for (const candidate of [value, value.split(/\s+/)[0]]) {
    const program = normalizeProgram(candidate.replace(/^["']|["']$/g, '').replace(/^-+/, ''));
    const family = SHELL_PROGRAM_FAMILIES[program];
    if (family) return /** @type {ShellFamily} */ (family);
  }
  return null;
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
    const verdict = checkCommandNode(node, { ...options, grammar: SHELL_FAMILIES[family], exact });
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

  const stripped = stripQuoted(text, grammar);
  if (!stripped.ok) return { ok: false, code: 'shell_unparsable', reason: 'the command has an unbalanced quote' };
  if (stripped.newlineInQuote) return { ok: false, code: 'shell_unmodelled', reason: 'the command contains a newline inside a quoted argument' };
  const unmodelled = grammar.unmodelled.find((entry) => entry.pattern.test(stripped.text));
  if (unmodelled) return { ok: false, code: 'shell_unmodelled', reason: `the command contains ${unmodelled.what}` };

  const tokens = tokenize(text, grammar);
  if (!tokens.ok) return { ok: false, code: 'shell_unparsable', reason: 'the command has an unbalanced quote' };
  const commands = buildNodes(tokens.tokens, grammar.separators);
  if (commands.some((node) => !PLAIN_PROGRAM_NAME.test(node.name) || !PLAIN_PROGRAM.test(node.program))) {
    return { ok: false, code: 'shell_unmodelled', reason: 'the command names a program in a form that cannot be checked' };
  }
  const keyword = commands.find((node) => UNMODELLED_COMMANDS.includes(node.program));
  if (keyword) {
    return { ok: false, code: 'shell_unmodelled', reason: `the command starts with ${keyword.program}, a shell keyword or alias construct whose command the rules cannot see` };
  }
  const argument = UNMODELLED_ARGUMENTS.find((entry) => commands.some((node) => node.args.some((arg) => entry.pattern.test(arg))));
  if (argument) return { ok: false, code: 'shell_unmodelled', reason: `the command contains ${argument.what}` };
  return { ok: true, commands };
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
 * @param {ClassifyOptions & { grammar: ShellGrammar, exact: boolean }} options
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
  const protectedTarget = findProtectedTarget(node, options.protectedWriteGlobs ?? [], options.grammar);
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
 * @param {ShellGrammar} grammar
 * @returns {string | null}
 */
function findProtectedTarget(node, globs, grammar) {
  if (globs.length === 0) return null;
  const candidates = [...node.writeTargets];
  if (WRITE_PROGRAMS.includes(node.program)) candidates.push(...node.args.filter((arg) => !isSwitchArgument(arg, grammar)));
  return candidates.find((target) => globs.some((glob) => matchesGlob(target, glob))) ?? null;
}

/** A Windows switch: `/s`, `/q`, `/MIR`, `/LOG:x`. One segment, so it can never be a path. */
const WINDOWS_SWITCH = /^\/[A-Za-z?][A-Za-z0-9]{0,7}(?::[^/\\]*)?$/;

/**
 * An argument that names a switch rather than a file, so it is not a write target. A leading `-` is a
 * switch on every family. A leading `/` is one only on the families whose `switchPrefixes` say so: on
 * posix it is how an absolute path starts, and dropping those let
 * `cp blank.txt /project/Assets/Scenes/Main.unity` past the check that the same write with a relative
 * destination failed.
 * @param {string} arg
 * @param {ShellGrammar} grammar
 * @returns {boolean}
 */
function isSwitchArgument(arg, grammar) {
  if (arg.startsWith('-')) return true;
  return grammar.switchPrefixes.includes('/') && WINDOWS_SWITCH.test(arg);
}

/** The port a URL goes to when it names none. */
const DEFAULT_PORTS = Object.freeze({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' });

/**
 * Whether any argument addresses the hub. Hosts are compared after the WHATWG URL parser has reduced
 * them, because an HTTP client resolves `127.1`, `2130706433` and `0x7f.1` to the same loopback address
 * a textual comparison would miss. A loopback hub is reached by every loopback spelling on its port.
 * Arguments that carry a host and a port outside a URL - curl's `--resolve` and `--connect-to` - are
 * read field by field, so a name pinned to the hub's address is refused too.
 * @param {string[]} args
 * @param {{ host: string, port: string }} hub
 * @returns {boolean}
 */
function argsReachHub(args, hub) {
  const hubHost = normalizeHost(hub.host) ?? hub.host.toLowerCase();
  const port = String(hub.port);
  const isHub = (/** @type {string | null} */ host) => host !== null && (isLoopbackHost(hubHost) ? isLoopbackHost(host) : host === hubHost);
  return args.some((arg) => {
    const target = readUrlTarget(arg);
    if (target) return target.port === port && isHub(target.host);
    const fields = arg.split(/[:/@=,]+/);
    return fields.includes(port) && fields.some((field) => field !== port && isHub(normalizeHost(field)));
  });
}

/**
 * The host and port an argument names as a URL, or as a bare `host:port` the way curl accepts one.
 * @param {string} arg
 * @returns {{ host: string, port: string } | null}
 */
function readUrlTarget(arg) {
  const scheme = /[a-z][a-z0-9+.-]*:\/\//i.exec(arg);
  const candidate = scheme ? arg.slice(scheme.index) : /^[^\s/:@]+:\d+(?:[/?#]|$)/.test(arg) ? `http://${arg}` : null;
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    const port = url.port || DEFAULT_PORTS[/** @type {keyof typeof DEFAULT_PORTS} */ (url.protocol)] || '';
    const host = normalizeHost(url.hostname);
    return host === null ? null : { host, port };
  } catch {
    return null;
  }
}

/**
 * A host as an HTTP client would resolve it: lowercased, IPv4 shorthand expanded, trailing dot dropped.
 * @param {string} value
 * @returns {string | null}
 */
function normalizeHost(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const hostname = new URL(`http://${value.includes(':') && !value.startsWith('[') ? `[${value}]` : value}`).hostname;
    return hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * @param {string} host  A host already reduced by `normalizeHost`.
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 loopback, the unspecified address, and IPv4-mapped loopback, as the URL parser prints them.
  return host === '[::1]' || host === '[::]' || /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host);
}

/**
 * Replaces every quoted run with a placeholder so the unmodelled patterns only see shell syntax.
 * @param {string} text
 * @param {ShellGrammar} grammar
 * @returns {{ ok: true, text: string, newlineInQuote: boolean } | { ok: false }}
 */
function stripQuoted(text, grammar) {
  let out = '';
  let index = 0;
  let newlineInQuote = false;
  while (index < text.length) {
    const char = text[index];
    if (!grammar.quoteChars.includes(char)) {
      out += char;
      index += 1;
      continue;
    }
    const end = findQuoteEnd(text, index, grammar);
    if (end < 0) return { ok: false };
    if (text.slice(index, end).includes('\n')) newlineInQuote = true;
    out += maskQuotedRun(text.slice(index + 1, end), char, grammar);
    index = end + 1;
  }
  return { ok: true, text: out, newlineInQuote };
}

/**
 * The filler one quoted run leaves behind for the layer-1 scan. A run keeps the characters its family
 * still expands inside that quote kind and turns the rest - spaces and separators included - into one
 * filler letter each, so a quoted word can never read as syntax and an expansion inside one can never
 * read as a word. A quote kind that expands nothing is therefore masked completely, and cmd, which has
 * no literal quote at all, keeps `%` visible inside both of its quote characters. Blanking a run
 * outright would let two characters step around the primary rule: 35.8's `"$(git push)"` and
 * `"$([Net.WebClient]::new())"` would read as plain words.
 * @param {string} body       The run without its quotes.
 * @param {string} quote      The quote character that opened it.
 * @param {ShellGrammar} grammar
 * @returns {string}
 */
function maskQuotedRun(body, quote, grammar) {
  // An empty run still leaves one filler behind, so `&''&` cannot read as the separator `&&`.
  if (body === '') return 'Q';
  const expanding = grammar.quoting.expands[quote] ?? '';
  let out = '';
  for (const char of body) out += expanding.includes(char) ? char : 'Q';
  return out;
}

/**
 * @param {string} text
 * @param {number} start   Index of the opening quote.
 * @param {ShellGrammar} grammar
 * @returns {number} Index of the closing quote, or -1.
 */
function findQuoteEnd(text, start, grammar) {
  const quote = text[start];
  const escapes = grammar.quoting.escapeInQuotes.includes(quote);
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escapes && grammar.quoting.escape === 'backslash' && char === '\\') {
      index += 1;
      continue;
    }
    if (char !== quote) continue;
    // PowerShell and cmd double a quote to escape it inside the same kind of quoting.
    if (escapes && grammar.quoting.escape === 'doubled' && text[index + 1] === quote) {
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
 * @param {ShellGrammar} grammar
 * @returns {{ ok: true, tokens: ShellToken[] } | { ok: false }}
 */
function tokenize(text, grammar) {
  const separators = grammar.separators;
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
    if (grammar.quoteChars.includes(char)) {
      const end = findQuoteEnd(text, index, grammar);
      if (end < 0) return { ok: false };
      word += unquote(text.slice(index, end + 1), grammar);
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
 * @param {ShellGrammar} grammar
 * @returns {string}
 */
function unquote(token, grammar) {
  const quote = token[0];
  const body = token.slice(1, -1);
  if (!grammar.quoting.escapeInQuotes.includes(quote)) return body;
  if (grammar.quoting.escape === 'backslash') return body.replace(/\\(["\\$`])/g, '$1');
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
 * @param {string} id
 * @param {any} entry
 * @param {ReadonlyArray<{ pattern: RegExp, what: string }>} common
 * @returns {ShellGrammar}
 */
function compileFamily(id, entry, common) {
  const separators = readStrings(entry?.separators, `${id}.separators`);
  if (separators.length === 0) throw new TypeError(`shell-families.json: ${id} has no separators`);
  const quoting = readQuoting(id, entry?.quoting);
  return Object.freeze({
    id,
    label: readLabel(id, entry?.label),
    // Longest first, so `&&` is never read as `&`.
    separators: Object.freeze([...separators].sort((left, right) => right.length - left.length)),
    switchPrefixes: Object.freeze(readStrings(entry?.switchPrefixes, `${id}.switchPrefixes`)),
    quoteChars: Object.freeze(Object.keys(quoting.expands)),
    quoting,
    unmodelled: Object.freeze([...readUnmodelled(entry?.unmodelled, id), ...common]),
  });
}

/**
 * @param {string} id
 * @param {any} value
 * @returns {ShellQuoting}
 */
function readQuoting(id, value) {
  if (value?.escape !== 'backslash' && value?.escape !== 'doubled') {
    throw new TypeError(`shell-families.json: ${id}.quoting.escape must be backslash or doubled`);
  }
  const expands = value.expands;
  const quotes = Object.keys(expands ?? {});
  if (quotes.length === 0 || quotes.some((quote) => typeof expands[quote] !== 'string')) {
    throw new TypeError(`shell-families.json: ${id}.quoting.expands must map every quote to its expansions`);
  }
  return Object.freeze({
    escape: value.escape,
    escapeInQuotes: Object.freeze(readStrings(value.escapeInQuotes, `${id}.quoting.escapeInQuotes`)),
    expands: Object.freeze({ ...expands }),
  });
}

/**
 * @param {any} value
 * @param {string} where
 * @returns {Array<{ pattern: RegExp, what: string }>}
 */
function readUnmodelled(value, where) {
  if (!Array.isArray(value)) throw new TypeError(`shell-families.json: ${where}.unmodelled must be an array`);
  return value.map((entry) => {
    if (typeof entry?.pattern !== 'string' || typeof entry?.what !== 'string') {
      throw new TypeError(`shell-families.json: ${where}.unmodelled needs a pattern and a description`);
    }
    return Object.freeze({ pattern: new RegExp(entry.pattern, entry.flags ?? ''), what: entry.what });
  });
}

/**
 * @param {any} value
 * @param {Readonly<Record<string, ShellGrammar>>} families
 * @returns {Record<string, string>}
 */
function readShells(value, families) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('shell-families.json: shells must be an object');
  }
  /** @type {Record<string, string>} */
  const shells = {};
  for (const [name, id] of Object.entries(value)) {
    if (typeof id !== 'string' || !Object.hasOwn(families, id)) {
      throw new TypeError(`shell-families.json: shell ${name} names a family that does not exist`);
    }
    shells[name] = id;
  }
  return shells;
}

/**
 * @param {any} value
 * @param {string} where
 * @returns {string[]}
 */
function readStrings(value, where) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`shell-families.json: ${where} must be an array of strings`);
  }
  return [...value];
}

/**
 * @param {string} id
 * @param {any} value
 * @returns {string}
 */
function readLabel(id, value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`shell-families.json: ${id} has no label`);
  return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
