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
//      dots and .exe/.cmd/.bat/.ps1/.com removed). The wrappers, the VCS clients, the product's own
//      bin names, the network list of 35.8 and the caller-supplied list are checked here.
//   3. blocked substrings anywhere in the text, for constructs that defeat token matching.
//
// The network half of layers 2 and 3 (S36) runs when the caller names a `network.bash` mode, which
// every product caller does: the plugin's shell guard passes the configured mode, `deny` unless the
// user opted into the experimental `ask`. The grammar tests of milestone 2 call the classifier with no
// mode to pin the other rules on their own. The product's own bin names are not part of that switch:
// `opencode-unity` is the consent path, and a session that could run it could grant itself network
// access, so those three names are refused on every call, in every mode, and a verify command never
// unlocks them (DN19, R27).
//
// The alias rule. A name in a command string means what this classifier reads it to mean only if the
// shell that runs it resolves the name the same way. OpenCode 1.18.31 runs the agent's commands as
// `<shell> -c <command>` for the POSIX shells and `-NoProfile -Command` for PowerShell, so no
// interactive rc file - and no alias a user keeps in one - is read; only the user's own `!` commands
// go through the login shell that sources `.bashrc` or `.zshrc`. The three ways a non-interactive shell
// still picks up user definitions are closed by the environment `buildAliasFreeShellEnv` returns for
// the `shell.env` hook, and every construct that would define, re-enable or rebind a name from inside
// the command itself is refused in layer 1. The rule this product ships is therefore: **the agent
// shell runs without the user's aliases**, and an unknown first word is a program on PATH, not a
// rewrite of a known one - the allow-list bash mode refuses it and the ask mode shows it to the human
// verbatim.
//
// The families are data: `shell-families.json` holds the separators, the quoting rules, the switch
// prefixes and the metacharacter sets of each one, so a family is described rather than branched on.
// Every rule that used to ask "is this posix?" now asks the family for its own answer, which is what
// lets one tokenizer read three grammars without a second family silently inheriting the first one's
// quote handling.
//
// It is a guardrail, not a sandbox: an allowed command is still a program that can do anything.
import fs from 'node:fs';
import path from 'node:path';

import { VCS_BINARIES, VCS_TABLES, isVcsKind } from './vcs-tables.js';

/**
 * @typedef {'posix' | 'powershell' | 'cmd'} ShellFamily
 * @typedef {'allow' | 'ask' | 'deny'} ShellDecision
 * @typedef {'deny' | 'ask'} NetworkBashMode
 */

/**
 * `shell_network_ask` is the one code an `ask` decision carries; every other code is a deny.
 * @typedef {'shell_empty' | 'shell_unparsable' | 'shell_unmodelled' | 'shell_no_command_node'
 *   | 'shell_wrapper' | 'shell_encoded_command' | 'shell_vcs_write' | 'shell_recursive_delete'
 *   | 'shell_protected_write' | 'shell_network_hub' | 'shell_blocked_command'
 *   | 'shell_blocked_text' | 'shell_network_ask'} ShellDenyCode
 */

/**
 * @typedef {object} ShellCommandNode
 * @property {string} name      First token as written.
 * @property {string} program   Basename-normalised first token, lowercased.
 * @property {string[]} args    Remaining tokens, quotes removed.
 * @property {string[]} writeTargets  Redirection targets of this node.
 * @property {boolean} [expression]   True when the family reads this element as an expression, which
 *   yields no command node in the parse OpenCode runs (a PowerShell string or number literal).
 * @property {boolean} [pipedInput]   True when the element reads the output of the one before it.
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
 * @typedef {object} ShellExpressions
 * @property {boolean} quotedFirstWord               A quoted first word starts an expression.
 * @property {{ pattern: RegExp, what: string } | null} firstWord  Unquoted first words that do too.
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
 * @property {ShellExpressions} expressions
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

/**
 * Write-capable programs whose file operands are checked against the protected globs. The second
 * block (S36) is the non-recursive half: creating, emptying, renaming, relinking, deleting or
 * re-permissioning one protected file changes it as surely as overwriting it does, and each PowerShell
 * cmdlet is listed with its built-in aliases because `-NoProfile` removes the user's aliases, not
 * these.
 */
const WRITE_PROGRAMS = Object.freeze([
  'set-content', 'sc', 'out-file', 'add-content', 'ac', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'xcopy', 'robocopy', 'cp', 'mv', 'tee', 'tee-object', 'truncate', 'install',
  'new-item', 'ni', 'md', 'mkdir', 'clear-content', 'clc', 'clear-item', 'cli', 'set-item', 'si',
  'rename-item', 'rni', 'ren', 'rename', 'remove-item', 'ri', 'rm', 'del', 'erase', 'unlink', 'shred',
  'touch', 'ln', 'mklink', 'patch', 'export-csv', 'epcsv', 'export-clixml', 'start-transcript',
  'set-itemproperty', 'sp', 'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'takeown',
]);

/**
 * Cmdlets that bind the items they change from the pipeline (`Get-ChildItem -Recurse | Remove-Item`),
 * so a piped element names no target this classifier could check. The content writers - Set-Content,
 * Add-Content, Out-File, Tee-Object - take their *content* from the pipeline and their path from an
 * argument, so they are not here.
 */
const PIPELINE_TARGET_PROGRAMS = Object.freeze([
  'remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'clear-content', 'clc', 'clear-item', 'cli',
  'move-item', 'mi', 'move', 'mv', 'rename-item', 'rni', 'ren', 'copy-item', 'cpi', 'copy', 'cp',
  'set-item', 'si', 'set-itemproperty', 'sp', 'new-item', 'ni',
]);

/** Programs that change the directory a later relative path is resolved against. */
const DIRECTORY_PROGRAMS = Object.freeze(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const DIRECTORY_RESTORE_PROGRAMS = Object.freeze(['popd', 'pop-location']);

/** Programs that speak HTTP; blocked when the target names the local MCP hub (spec 8.7.1). */
const HTTP_PROGRAMS = Object.freeze(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'httpie', 'http', 'aria2c']);

/**
 * @template T
 * @param {Record<string, T[]>} groups
 * @returns {Readonly<Record<string, ReadonlyArray<T>>>}
 */
function freezeGroups(groups) {
  return Object.freeze(Object.fromEntries(Object.entries(groups).map(([key, names]) => [key, Object.freeze([...names])])));
}

/**
 * The blocked first tokens of amendment 35.8 layer 2, grouped by the reason they are blocked, in the
 * normalised spelling the classifier compares (lowercase, no suffix). This is the one shared constant
 * of D-M19: `PM_DENY` (37.6) is rendered from it rather than restating it, so the inspectable
 * permission rules and the load-bearing classifier cannot drift apart.
 *
 * Every group except `product` belongs to the network half and applies when a `network.bash` mode is
 * named. `product` applies always. Four groups were added by S36 beyond the list of 35.8, each for the
 * reason 35.8 gives for the lines it already has: `migrations` so that every first word of `PM_DENY`
 * is here too; `reachability` because `ping` and `tracert` resolve and reach an attacker-chosen name
 * exactly as the resolvers do; `installers` because a package manager outside Node installs from the
 * network as surely as npm (S-BM-5); and `scriptHosts` because each of them runs script or remote
 * content the permission layer cannot see into.
 */
export const SHELL_BLOCKED_PROGRAM_GROUPS = freezeGroups({
  networkClients: [
    'curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'bitsadmin',
    'certutil', 'test-netconnection', 'tnc', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'tftp',
    'openssl', 'socat', 'aria2c', 'httpie', 'http', 'https',
  ],
  resolvers: ['resolve-dnsname', 'nslookup', 'dig', 'host'],
  reachability: ['ping', 'test-connection', 'tracert', 'traceroute', 'pathping'],
  remoteShells: ['ssh', 'scp', 'sftp', 'rsync'],
  packageManagers: ['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'corepack'],
  installers: ['pip', 'pip3', 'pipx', 'uv', 'uvx', 'poetry', 'conda', 'gem', 'composer', 'brew', 'winget', 'choco', 'scoop', 'nuget'],
  interpreters: ['node', 'bun', 'deno', 'tsx', 'ts-node', 'python', 'python3', 'py', 'perl', 'ruby', 'php'],
  scriptHosts: ['cscript', 'wscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'wmic'],
  cloud: ['firebase', 'gcloud', 'gsutil', 'bq', 'aws', 'az', 'supabase', 'vercel', 'netlify', 'heroku', 'gh', 'glab'],
  containers: ['docker', 'podman', 'kubectl', 'helm', 'terraform'],
  databases: ['psql', 'mysql', 'mongosh', 'redis-cli', 'sqlite3'],
  migrations: ['prisma', 'drizzle-kit', 'knex'],
  product: ['opencode-unity', 'opencode', 'ollama'],
});

/** Every blocked first token, flattened. */
export const SHELL_BLOCKED_PROGRAMS = Object.freeze([...new Set(Object.values(SHELL_BLOCKED_PROGRAM_GROUPS).flat())]);

/**
 * The product's own bin name, OpenCode and Ollama: refused in every mode, whatever else the caller
 * passes. They are not networking, they are privilege - the consent path, a second unprofiled session,
 * and a model load outside the GPU guard (35.8, SPEC S1).
 */
export const SHELL_PRODUCT_PROGRAMS = SHELL_BLOCKED_PROGRAM_GROUPS.product;

/**
 * The groups the experimental `network.bash: "ask"` mode turns into a permission ask (12.10.4). Only
 * clients that reach a host without carrying the user's identity are here: the remote shells sign in
 * with the user's keys and the cloud CLIs with the user's account, both of which the network decisions
 * put in the prohibited tier, and every package manager, interpreter and container tool stays denied in
 * any mode (S-BM-5, D-B12).
 */
export const NETWORK_ASK_GROUPS = Object.freeze(['networkClients', 'resolvers', 'reachability']);

/** The first tokens the `ask` mode asks about instead of refusing. */
export const NETWORK_ASK_PROGRAMS = Object.freeze(NETWORK_ASK_GROUPS.flatMap((group) => SHELL_BLOCKED_PROGRAM_GROUPS[group]));

/**
 * Subcommands refused on a program the agent otherwise keeps. The first three are the `dotnet` rows of
 * `PM_DENY`; the rest install, add, remove or publish a package, run an arbitrary assembly, or change the
 * machine's certificate trust, and `dotnet build` and `dotnet test` stay allowed (S-NET-13).
 */
export const SHELL_BLOCKED_SUBCOMMANDS = freezeGroups({
  dotnet: ['ef', 'run', 'publish', 'exec', 'tool', 'nuget', 'add', 'remove', 'workload', 'dev-certs'],
});

/** The values `network.bash` may take (35.7). */
export const NETWORK_BASH_MODES = Object.freeze(['deny', 'ask']);

/**
 * `find` runs another program for every file it visits, deletes them, or writes a list of them, all
 * from arguments that look like ordinary flags.
 */
const FIND_RUNS_PROGRAM = Object.freeze(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_WRITES_FILE = Object.freeze(['-fprint', '-fprint0', '-fprintf', '-fls']);

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
 * The network half of layer 3 (35.8): .NET and COM network types, matched as substrings because a
 * type name can arrive inside a quoted string another construct later evaluates. Layer 1 already
 * refuses the type literal and `New-Object` that would use one; these catch the same names by text.
 * `WebRequest` is matched only where it is not the tail of the `Invoke-WebRequest` cmdlet, which is a
 * layer-2 first token that the `ask` mode may ask about, and not the tail of `UnityWebRequest`, Unity's
 * own HTTP class, which no shell can load and which a Unity project names in every networking script.
 */
export const NETWORK_BLOCKED_TEXT = Object.freeze([
  {
    pattern: /(?:System\.)?Net\.(?:WebClient|Sockets|Dns|HttpListener)|System\.Net\.Http|HttpClient|(?<!invoke-|unity)WebRequest|XMLHTTP|WinHttp\.?WinHttpRequest/i,
    what: 'a .NET or COM network type',
  },
]);

/**
 * A URL: any scheme followed by two slashes of either kind, because .NET's URI parser accepts
 * `http:\\host` as readily as `http://host`. The scheme has at least two characters so a drive path
 * such as `C:\\Users` is not one.
 */
const URL_SCHEME = /[a-z][a-z0-9+.-]+:[\\/]{2}/i;

/** A network path: `//host/x`, and the Windows UNC form `\\host\share`, which opens an SMB session. */
const NETWORK_PATH = /^[\\/]{2}[^\s\\/]/;

/** Flags that turn off certificate checks or route through a proxy (35.8), as standalone tokens. */
const NETWORK_FLAGS = Object.freeze(['--proxy', '-proxy', '-skipcertificatecheck', '--insecure', '-k']);

/**
 * @typedef {object} ClassifyOptions
 * @property {ShellFamily} [family]                  Defaults to the family of `platform`.
 * @property {string} [platform]                     `process.platform`; only used to pick a family.
 * @property {string | null} [vcsKind]               Detected VCS, or null/`none` when there is none.
 * @property {string[]} [protectedWriteGlobs]        Globs a redirection or copy may not target.
 * @property {{ host: string, port: string } | null} [mcpHub]  Local MCP hub, blocked for HTTP clients.
 * @property {string[]} [blockedPrograms]            Extra first tokens to deny, on top of the shipped lists.
 * @property {string[]} [allowExactCommands]         Verify commands, allowed by full-string equality only.
 * @property {NetworkBashMode | null} [networkBash]  `network.bash` (35.7): turns on the network layers.
 *   Every product caller passes it; a value that is neither mode is read as `deny`.
 * @property {string | null} [workdir]               The directory the command runs in, when the tool call
 *   names one; relative write targets are resolved against it.
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
  const commands = parsed.commands;
  if (commands.length === 0) {
    return deny(family, 'shell_no_command_node', 'the command runs no program the permission rules can see', []);
  }

  const blockedText = BLOCKED_TEXT.find((entry) => entry.pattern.test(text));
  if (blockedText) return deny(family, 'shell_blocked_text', `the command contains ${blockedText.what}`, commands);
  const encoded = commands.some((node) => readWords(node).some(isEncodedCommandShaped));
  if (encoded) return deny(family, 'shell_blocked_text', 'the command contains an encoded command', commands);

  const networkBash = readNetworkBash(options.networkBash);
  if (networkBash) {
    const networkText = findNetworkText(text, commands);
    if (networkText) return deny(family, 'shell_blocked_text', `the command contains ${networkText}`, commands);
  }

  const grammar = SHELL_FAMILIES[family];
  /** @type {NodeContext} */
  const context = { ...options, grammar, exact, networkBash, directory: readWorkdir(options.workdir) };
  /** @type {NodeVerdict | null} */
  let ask = null;
  for (const node of commands) {
    const verdict = checkCommandNode(node, context);
    if (verdict?.decision === 'deny') return deny(family, verdict.code, verdict.reason, commands);
    ask ??= verdict;
    context.directory = nextDirectory(node, context.directory, grammar);
  }

  // Checked after the lists, so a quoted client such as PowerShell's `"git" push` still reports the
  // rule that names it; the element is refused either way.
  const expressions = commands.filter((node) => node.expression);
  if (expressions.length === commands.length) {
    return deny(family, 'shell_no_command_node', 'the command is an expression that runs no program the permission rules can see', commands);
  }
  if (expressions.length > 0) {
    return deny(family, 'shell_unmodelled', 'the command contains an expression statement, which the permission rules never see', commands);
  }
  if (ask) return { decision: 'ask', family, code: ask.code, reason: ask.reason, commands };
  return { decision: 'allow', family, code: null, reason: null, commands };
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
  const commands = buildNodes(tokens.tokens, grammar);
  if (commands.some((node) => !node.expression && (!PLAIN_PROGRAM_NAME.test(node.name) || !PLAIN_PROGRAM.test(node.program)))) {
    return { ok: false, code: 'shell_unmodelled', reason: 'the command names a program in a form that cannot be checked' };
  }
  const keyword = commands.find((node) => !node.expression && UNMODELLED_COMMANDS.includes(node.program));
  if (keyword) {
    return { ok: false, code: 'shell_unmodelled', reason: `the command starts with ${keyword.program}, a shell keyword or a construct that changes what a later name runs, whose command the rules cannot see` };
  }
  const argument = UNMODELLED_ARGUMENTS.find((entry) => commands.some((node) => node.args.some((arg) => entry.pattern.test(arg))));
  if (argument) return { ok: false, code: 'shell_unmodelled', reason: `the command contains ${argument.what}` };
  return { ok: true, commands };
}

/**
 * Basename, lowercase, without trailing dots or an executable suffix: `C:\Windows\System32\curl.exe`
 * -> `curl`. Windows drops trailing dots and spaces from a file name before it opens the file, so
 * `curl.exe.` starts the same program `curl.exe` does.
 * @param {string} token
 * @returns {string}
 */
export function normalizeProgram(token) {
  const segments = token.split(/[\\/]/);
  const base = (segments[segments.length - 1] ?? '').toLowerCase().replace(/(?<=[^. ])[. ]+$/, '');
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
 * Whether a program is on a blocked list: by its normalised name, or with a trailing version removed,
 * because `python3.12`, `pip3.11` and `node22` are the same interpreters under another file name.
 * @param {string} program
 * @param {ReadonlyArray<string>} list
 * @returns {boolean}
 */
export function isListedProgram(program, list) {
  if (list.includes(program)) return true;
  const unversioned = program.replace(/[\d.]+$/, '');
  return unversioned.length > 0 && unversioned !== program && list.includes(unversioned);
}

/**
 * Environment values for the `shell.env` hook that keep the user's own shell definitions out of the
 * agent shell (the alias rule in the header). A non-interactive shell still reads three things a user
 * can put aliases or functions in: bash's `BASH_ENV` file, bash functions exported through
 * `BASH_FUNC_<name>%%` variables, and zsh's `$ZDOTDIR/.zshenv`. The first two are blanked - bash only
 * imports a function whose value starts with `() {` - and `ZDOTDIR` points at a directory that holds no
 * startup file. `ENV` is blanked too, for the POSIX shells that read it. OpenCode merges these over its
 * own environment, so each override reuses the spelling the parent environment already has on Windows,
 * where one variable can arrive as `Path` or `PATH`.
 * @param {object} [input]
 * @param {Record<string, string | undefined>} [input.env]      The environment OpenCode passes on.
 * @param {string | null} [input.startupDirectory]  A directory with no shell startup file in it; it need
 *   not exist. Without one, zsh's `.zshenv` is left as it is.
 * @param {string} [input.platform]
 * @returns {Record<string, string>}
 */
export function buildAliasFreeShellEnv({ env = process.env, startupDirectory = null, platform = process.platform } = {}) {
  const names = Object.keys(env);
  const spell = (/** @type {string} */ name) => (platform === 'win32' ? names.find((existing) => existing.toUpperCase() === name) ?? name : name);
  /** @type {Record<string, string>} */
  const out = { [spell('BASH_ENV')]: '', [spell('ENV')]: '' };
  if (typeof startupDirectory === 'string' && startupDirectory.length > 0) out[spell('ZDOTDIR')] = startupDirectory;
  const functionPrefix = 'BASH_FUNC_';
  for (const name of names) {
    const exported = platform === 'win32' ? name.toUpperCase().startsWith(functionPrefix) : name.startsWith(functionPrefix);
    if (exported) out[name] = '';
  }
  return out;
}

/**
 * @typedef {ClassifyOptions & { grammar: ShellGrammar, exact: boolean, networkBash: NetworkBashMode | null, directory: string | null }} NodeContext
 * @typedef {{ decision: 'deny' | 'ask', code: ShellDenyCode, reason: string }} NodeVerdict
 */

/**
 * @param {ShellCommandNode} node
 * @param {NodeContext} context
 * @returns {NodeVerdict | null}
 */
function checkCommandNode(node, context) {
  const { program, args } = node;
  if (WRAPPER_PROGRAMS.includes(program) || (program === 'find' && args.some((arg) => FIND_RUNS_PROGRAM.includes(arg.toLowerCase())))) {
    const inner = findBlockedInside(args, context);
    if (inner) return refuse('shell_blocked_command', `${program} runs ${inner}, which is not available to the agent`);
    return refuse('shell_wrapper', `${program} runs another command that the permission rules cannot see`);
  }
  if (VCS_BINARIES.includes(program)) {
    const vcsProblem = checkVcs(program, args, context.vcsKind ?? null);
    if (vcsProblem) return vcsProblem;
  }
  if (isRecursiveDelete(program, args)) {
    return refuse('shell_recursive_delete', `${program} would delete a directory tree`);
  }
  const writeProblem = checkProtectedWrite(node, context);
  if (writeProblem) return writeProblem;
  if (HTTP_PROGRAMS.includes(program) && context.mcpHub && argsReachHub(args, context.mcpHub)) {
    return refuse('shell_network_hub', `${program} would call the local Unity MCP hub, which only the editor agent may use`);
  }
  if (isListedProgram(program, SHELL_PRODUCT_PROGRAMS)) {
    return refuse('shell_blocked_command', `${program} is this product's own control path or model runtime, which the agent may never run`);
  }
  if (context.networkBash && !context.exact) {
    const networkProblem = checkNetworkProgram(node, context.networkBash);
    if (networkProblem) return networkProblem;
  }
  if (!context.exact && (context.blockedPrograms ?? []).includes(program)) {
    return refuse('shell_blocked_command', `${program} is not available to the agent`);
  }
  return null;
}

/**
 * Layer 2 of the network half: the shared list, the `ask` mode's subset, and the refused subcommands.
 * @param {ShellCommandNode} node
 * @param {NetworkBashMode} mode
 * @returns {NodeVerdict | null}
 */
function checkNetworkProgram(node, mode) {
  const { program, args } = node;
  if (isListedProgram(program, SHELL_BLOCKED_PROGRAMS)) {
    if (mode === 'ask' && isListedProgram(program, NETWORK_ASK_PROGRAMS)) {
      return { decision: 'ask', code: 'shell_network_ask', reason: `${program} reaches the network, so OpenCode asks before it runs (network.bash is ask)` };
    }
    return refuse('shell_blocked_command', `${program} reaches the network or runs code the permission rules cannot see, so it is not available to the agent`);
  }
  const refused = SHELL_BLOCKED_SUBCOMMANDS[program];
  if (!refused) return null;
  const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase() ?? '';
  if (refused.includes(subcommand) || subcommand.endsWith('.dll')) {
    return refuse('shell_blocked_command', `${program} ${subcommand} installs, publishes or runs code outside the build, so it is not available to the agent`);
  }
  return null;
}

/**
 * The program a wrapper would run, when it is one the agent may not run itself: every word of every
 * argument is read as a possible first token, because `cmd /c curl x`, `bash -c "curl x"` and
 * `env curl x` all carry it in a different position. The wrapper is refused either way; this only
 * names the reason (35.8: the list is checked inside every already-blocked wrapper).
 * @param {string[]} args
 * @param {NodeContext} context
 * @returns {string | null}
 */
function findBlockedInside(args, context) {
  for (const arg of args) {
    for (const word of arg.split(/[\s;&|]+/)) {
      const program = normalizeProgram(word);
      if (isListedProgram(program, SHELL_PRODUCT_PROGRAMS)) return program;
      if (context.networkBash && isListedProgram(program, SHELL_BLOCKED_PROGRAMS)) return program;
    }
  }
  return null;
}

/**
 * A VCS client is allowed only for the read-only subcommands of the VCS this project actually uses.
 * @param {string} program
 * @param {string[]} args
 * @param {string | null} vcsKind
 * @returns {NodeVerdict | null}
 */
function checkVcs(program, args, vcsKind) {
  if (!isVcsKind(vcsKind)) {
    return refuse('shell_vcs_write', `${program} is blocked because no ${program} working copy was detected for this project`);
  }
  const table = VCS_TABLES[vcsKind];
  if (table.binary !== program) {
    return refuse('shell_vcs_write', `${program} is blocked because this project uses ${table.displayName}`);
  }
  const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase() ?? '';
  if (!table.readOnlySubcommands.includes(subcommand)) {
    return refuse('shell_vcs_write', `${program} ${subcommand || '(no subcommand)'} can change version control, so it is blocked`);
  }
  return null;
}

/**
 * @param {string} program
 * @param {string[]} args
 * @returns {boolean}
 */
function isRecursiveDelete(program, args) {
  if (program === 'find') return args.some((arg) => arg.toLowerCase() === '-delete');
  if (!DELETE_PROGRAMS.includes(program)) return false;
  if (program === 'format' || program === 'mkfs' || program === 'diskpart') return true;
  if (program === 'rmdir' || program === 'rd') return true;
  const flags = args.filter((arg) => arg.startsWith('-') || arg.startsWith('/')).map((arg) => arg.toLowerCase());
  return flags.some((flag) => RECURSIVE_FLAGS.includes(flag) || /^-[a-z]*r/.test(flag));
}

/**
 * Redirections and write-capable programs both write; every target they name is checked against the
 * protected globs, in every spelling that reaches the same file.
 * @param {ShellCommandNode} node
 * @param {NodeContext} context
 * @returns {NodeVerdict | null}
 */
function checkProtectedWrite(node, context) {
  const globs = context.protectedWriteGlobs ?? [];
  if (globs.length === 0) return null;
  if (node.pipedInput && PIPELINE_TARGET_PROGRAMS.includes(node.program)) {
    return refuse('shell_protected_write', `${node.program} takes the files it changes from the pipeline, which the rules cannot check against the protected files`);
  }
  for (const target of listWriteTargets(node, context.grammar)) {
    if (/[*?[\]]/.test(target)) {
      return refuse('shell_protected_write', 'the command writes to a wildcard target, which the rules cannot check against the protected files');
    }
    if (context.directory === null && !isAbsolutePath(target)) {
      return refuse('shell_protected_write', 'the command writes to a relative path after a directory change the rules cannot follow');
    }
    if (spellTarget(target, context.directory).some((spelling) => globs.some((glob) => matchesGlob(spelling, glob)))) {
      return refuse('shell_protected_write', 'the command would write a protected Unity or project file');
    }
  }
  return null;
}

/**
 * Every path one command node writes, deletes or relinks.
 * @param {ShellCommandNode} node
 * @param {ShellGrammar} grammar
 * @returns {string[]}
 */
function listWriteTargets(node, grammar) {
  const { program, args } = node;
  const targets = [...node.writeTargets];
  if (WRITE_PROGRAMS.includes(program) || isInPlaceEdit(program, args)) {
    for (const arg of args) {
      const value = isSwitchArgument(arg, grammar) ? readSwitchValue(arg) : arg;
      if (value !== null) targets.push(value);
    }
  }
  if (program === 'dd') {
    for (const arg of args) if (arg.toLowerCase().startsWith('of=')) targets.push(arg.slice(3));
  }
  if (program === 'find') {
    args.forEach((arg, index) => {
      if (FIND_WRITES_FILE.includes(arg.toLowerCase()) && index + 1 < args.length) targets.push(args[index + 1]);
    });
  }
  // PowerShell reads `a,b` as an array and cmd reads `,` and `;` as argument separators, so each piece
  // is a target of its own.
  return targets.flatMap((target) => target.split(/[,;]/)).filter((target) => target.length > 0);
}

/**
 * `sed -i`, `sed --in-place`, `perl -pi` and their clustered spellings rewrite the files they read.
 * @param {string} program
 * @param {string[]} args
 * @returns {boolean}
 */
function isInPlaceEdit(program, args) {
  if (program === 'sed') return args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'));
  if (program === 'perl') return args.some((arg) => /^-[A-Za-z0-9]*i/.test(arg));
  return false;
}

/**
 * The value a switch carries in the same token: PowerShell's `-Path:x` and the GNU `--output=x`.
 * @param {string} arg
 * @returns {string | null}
 */
function readSwitchValue(arg) {
  const match = /^-{1,2}[A-Za-z][A-Za-z0-9-]*[:=](.+)$/.exec(arg);
  return match ? match[1] : null;
}

/**
 * The spellings of one target that can name the same file: as written; resolved against the directory
 * the command runs in; with `.` and `..` resolved; and with what Windows drops from a file name before
 * opening it - trailing dots and spaces, and an alternate data stream after a colon. A target that
 * names a directory is also tried as the directory's contents, so renaming `Library` itself is caught
 * by the glob that protects `Library/*`. Matching is monotone: every glob starts with `*`, so a longer
 * spelling can add a match and never remove one.
 * @param {string} target
 * @param {string | null} directory
 * @returns {string[]}
 */
function spellTarget(target, directory) {
  const slashed = target.replace(/\\/g, '/');
  const bases = [slashed];
  if (directory && !isAbsolutePath(slashed)) bases.push(`${directory.replace(/\\/g, '/').replace(/\/+$/, '')}/${slashed}`);
  const spellings = new Set();
  for (const base of bases) {
    for (const value of [base, path.posix.normalize(base)]) {
      for (const name of [value, trimWindowsName(value)]) {
        spellings.add(name);
        spellings.add(`${name.replace(/\/+$/, '')}/`);
      }
    }
  }
  return [...spellings];
}

/**
 * @param {string} value  A path with forward slashes.
 * @returns {string}
 */
function trimWindowsName(value) {
  const segments = value.split('/');
  return segments
    .map((segment, index) => {
      let out = segment;
      if (index === segments.length - 1) {
        const from = index === 0 && /^[A-Za-z]:/.test(out) ? 2 : 0;
        const colon = out.indexOf(':', from);
        if (colon >= 0) out = out.slice(0, colon);
      }
      return out === '.' || out === '..' ? out : out.replace(/[. ]+$/, '');
    })
    .join('/');
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isAbsolutePath(value) {
  return /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

/**
 * The directory the next node runs in. A change the classifier can follow is joined on; one it cannot -
 * no argument, `-`, a return to a pushed directory - leaves it unknown, and a later relative write is
 * refused rather than guessed.
 * @param {ShellCommandNode} node
 * @param {string | null} directory
 * @param {ShellGrammar} grammar
 * @returns {string | null}
 */
function nextDirectory(node, directory, grammar) {
  if (DIRECTORY_RESTORE_PROGRAMS.includes(node.program)) return null;
  if (!DIRECTORY_PROGRAMS.includes(node.program)) return directory;
  const target = node.args.map((arg) => (isSwitchArgument(arg, grammar) ? readSwitchValue(arg) : arg)).find((arg) => arg !== null && arg !== '-');
  if (!target) return null;
  const slashed = target.replace(/\\/g, '/');
  if (isAbsolutePath(slashed)) return slashed;
  if (directory === null) return null;
  return directory === '' ? slashed : `${directory}/${slashed}`;
}

/**
 * @param {string | null | undefined} workdir
 * @returns {string}
 */
function readWorkdir(workdir) {
  return typeof workdir === 'string' ? workdir.replace(/\\/g, '/') : '';
}

/**
 * @param {unknown} value
 * @returns {NetworkBashMode | null}
 */
function readNetworkBash(value) {
  if (value === undefined || value === null) return null;
  return value === 'ask' ? 'ask' : 'deny';
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

/**
 * Every word a node carries, the program name and the redirection targets included.
 * @param {ShellCommandNode} node
 * @returns {string[]}
 */
function readWords(node) {
  return [node.name, ...node.args, ...node.writeTargets];
}

/**
 * The network half of layer 3. The URL and network-path checks run on every word after its quotes are
 * removed as well as on the raw text, because `ht'tp'://x` reaches the program as `http://x`; each word
 * is also split at `=`, `,`, `;` and a PowerShell `-Name:` prefix, which is where an address hides in
 * `--url=http://x`, `-Uri:http://x` and `a.txt,\\host\share\x`.
 * @param {string} text
 * @param {ShellCommandNode[]} commands
 * @returns {string | null} What was found, for the reason, or null.
 */
function findNetworkText(text, commands) {
  const type = NETWORK_BLOCKED_TEXT.find((entry) => entry.pattern.test(text));
  if (type) return type.what;
  // Also reject quote-obfuscated URL text. PowerShell doubled quotes can leave a literal quote;
  // this is a conservative text rule, not a claim that every shell concatenates those pieces.
  if (URL_SCHEME.test(text) || URL_SCHEME.test(text.replace(/["']/g, ''))) return 'a URL';
  for (const node of commands) {
    for (const word of readWords(node)) {
      const pieces = [word, ...word.split(/[=,;]/), readSwitchValue(word) ?? ''];
      if (pieces.some((piece) => URL_SCHEME.test(piece))) return 'a URL';
      if (pieces.some((piece) => NETWORK_PATH.test(piece))) return 'a network path';
    }
    const flag = node.args.find((arg) => {
      const lower = arg.toLowerCase();
      return NETWORK_FLAGS.some((name) => lower === name || lower.startsWith(`${name}=`) || lower.startsWith(`${name}:`));
    });
    if (flag) return 'a proxy or certificate-check flag';
  }
  return null;
}

/**
 * PowerShell's `-EncodedCommand` takes base64 of UTF-16LE text, and every unambiguous prefix of the
 * switch works, so the switch spelling alone is not enough to catch it. A word that decodes to UTF-16LE
 * is refused wherever it appears. A hash, a path or an identifier never decodes that way, which is why
 * this does not refuse every base64-shaped word.
 * @param {string} word
 * @returns {boolean}
 */
function isEncodedCommandShaped(word) {
  if (word.length < 8 || word.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(word)) return false;
  const bytes = Buffer.from(word, 'base64');
  if (bytes.length < 6 || bytes.length % 2 !== 0) return false;
  for (let index = 1; index < bytes.length; index += 2) {
    if (bytes[index] !== 0) return false;
  }
  return true;
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
 * @typedef {{ kind: 'word', value: string, quoted: boolean } | { kind: 'separator', value: string } | { kind: 'redirect', value: string }} ShellToken
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
  // Whether the word being read opened with a quote, which is what makes a PowerShell element an
  // expression rather than a command.
  let quoted = false;
  let started = false;
  const flush = () => {
    if (word.length > 0) tokens.push({ kind: 'word', value: word, quoted });
    word = '';
    quoted = false;
    started = false;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (grammar.quoteChars.includes(char)) {
      const end = findQuoteEnd(text, index, grammar);
      if (end < 0) return { ok: false };
      if (!started) quoted = true;
      started = true;
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
    started = true;
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
 * tree-sitter pass produces one `command` node per pipeline element. An element the family reads as
 * an expression is kept and marked, so the lists still see its first word and the caller can refuse
 * what the permission layer would never evaluate.
 * @param {ShellToken[]} tokens
 * @param {ShellGrammar} grammar
 * @returns {ShellCommandNode[]}
 */
function buildNodes(tokens, grammar) {
  /** @type {ShellCommandNode[]} */
  const nodes = [];
  /** @type {string[]} */
  let words = [];
  /** @type {string[]} */
  let writeTargets = [];
  let pendingRedirect = false;
  let firstQuoted = false;
  let pipedInput = false;
  const end = () => {
    if (words.length > 0) {
      const [name, ...args] = words;
      nodes.push({ name, program: normalizeProgram(name), args, writeTargets, expression: isExpression(name, firstQuoted, grammar), pipedInput });
    }
    words = [];
    writeTargets = [];
    pendingRedirect = false;
    firstQuoted = false;
  };
  for (const token of tokens) {
    if (token.kind === 'separator') {
      end();
      pipedInput = token.value === '|';
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
    if (words.length === 0) firstQuoted = token.quoted;
    words.push(token.value);
  }
  end();
  return nodes;
}

/**
 * @param {string} name
 * @param {boolean} quoted
 * @param {ShellGrammar} grammar
 * @returns {boolean}
 */
function isExpression(name, quoted, grammar) {
  const { quotedFirstWord, firstWord } = grammar.expressions;
  if (quoted) return quotedFirstWord;
  return firstWord !== null && firstWord.pattern.test(name);
}

/**
 * @param {ShellDenyCode} code
 * @param {string} reason
 * @returns {NodeVerdict}
 */
function refuse(code, reason) {
  return { decision: 'deny', code, reason };
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
    expressions: readExpressions(id, entry?.expressions),
  });
}

/**
 * A family with no `expressions` entry reads every element as a command, which is what the POSIX
 * shells and cmd do with a quoted first word.
 * @param {string} id
 * @param {any} value
 * @returns {ShellExpressions}
 */
function readExpressions(id, value) {
  if (value === undefined) return Object.freeze({ quotedFirstWord: false, firstWord: null });
  if (value === null || typeof value !== 'object' || typeof value.quotedFirstWord !== 'boolean') {
    throw new TypeError(`shell-families.json: ${id}.expressions needs a quotedFirstWord flag`);
  }
  const firstWord = value.firstWord === undefined ? null : readUnmodelled([value.firstWord], `${id}.expressions.firstWord`)[0];
  return Object.freeze({ quotedFirstWord: value.quotedFirstWord, firstWord });
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
