#!/usr/bin/env node
// Repository hygiene (spec 2.6 principle 8, 16 P6, 31): fails when any text file that git would
// commit contains personal data.
//
// Built-in rules (no configuration needed):
//   windows-home  C:\Users\<name>, C:/Users/<name>, /c/Users/<name> with a real-looking name
//   posix-home    /home/<name>, /Users/<name>
//   email         any e-mail address outside reserved example domains
// Placeholders such as <home>, <user>, %USERNAME%, $HOME or fictional names (see PLACEHOLDER_NAMES)
// are allowed.
//
// Local denylist (real values are NEVER committed; template: scripts/personal-data-denylist.example):
//   - `.personal-data-denylist` in the repository root. It must be git-ignored; the check refuses to
//     run when git would commit it.
//   - or `--denylist <file>`, or the OPENCODE_UNITY_DENYLIST_FILE environment variable;
//   - and/or the OPENCODE_UNITY_DENYLIST environment variable with the same content (CI secret).
// Format, one entry per line:
//   # comment
//   Jane Placeholder            a real name, user name, machine name, game or studio name
//   allow: github.com/<owner>/opencode-unity   an exact public string removed before matching
// Terms match file contents and file paths as substrings, ignoring case and diacritics; `\` and `/`
// count as the same separator, so a path term matches in every spelling. Terms need at least 3
// characters. Findings name the denylist entry by its number, never by its value, so CI logs do not
// publish the list.
//
// Exit codes: 0 clean, 1 findings, 2 usage or configuration error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_DENYLIST_NAME = '.personal-data-denylist';
export const DENYLIST_ENV = 'OPENCODE_UNITY_DENYLIST';
export const DENYLIST_FILE_ENV = 'OPENCODE_UNITY_DENYLIST_FILE';

const MIN_TERM_LENGTH = 3;
const BINARY_SNIFF_BYTES = 8000;
const WALK_SKIPPED_DIRS = new Set(['.git', 'node_modules', 'coverage']);

// Fictional or well-known generic account names that may appear in docs and fixtures.
export const PLACEHOLDER_NAMES = new Set([
  'user', 'username', 'user1', 'user2', 'you', 'yourname', 'your-name', 'me', 'name', 'someone',
  'example', 'dev', 'developer', 'alice', 'bob', 'carol', 'jdoe', 'test', 'tester', 'ci', 'builder',
  'runner', 'runneradmin', 'public', 'default', 'default user', 'all users', 'shared', 'linuxbrew',
]);

const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'localhost'];
const RESERVED_EMAIL_SUFFIXES = ['.example', '.test', '.invalid', '.localhost'];
const GENERIC_EMAIL_ADDRESSES = new Set(['git@github.com', 'noreply@github.com']);

const NAME_CHARS = String.raw`[^\\/\s"'\x60<>|:*?,;()\[\]{}]+`;
const SEPARATOR = String.raw`(?:\\+|\/+)`;

/** @type {ReadonlyArray<{ rule: string, regex: RegExp }>} */
const HOME_PATH_RULES = [
  { rule: 'windows-home', regex: new RegExp(String.raw`\b[A-Za-z]:${SEPARATOR}Users${SEPARATOR}(${NAME_CHARS})`, 'gi') },
  { rule: 'windows-home', regex: new RegExp(String.raw`\/[A-Za-z]\/Users\/(${NAME_CHARS})`, 'gi') },
  { rule: 'posix-home', regex: new RegExp(String.raw`(?<![\w.:\-\/\\])\/(?:home|Users)\/(${NAME_CHARS})`, 'g') },
];

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

/**
 * @typedef {object} DenylistTerm
 * @property {number} entry        1-based entry number, printed instead of the value.
 * @property {string} source       Where the entry came from (file path or env variable name).
 * @property {string} normalized
 */

/**
 * @typedef {object} Denylist
 * @property {DenylistTerm[]} terms
 * @property {string[]} allows     Normalized exact strings removed before terms are matched.
 */

/**
 * @typedef {object} Finding
 * @property {string} file       Relative path with `/`.
 * @property {number} line       0 when the finding is about the file path itself.
 * @property {number | null} column
 * @property {string} rule
 * @property {string} detail
 */

export class ConfigError extends Error {}

/**
 * Lowercases, removes diacritics (so a name matches with or without accents) and folds every run of
 * `\` or `/` into one `/`.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[\\/]+/g, '/');
}

/**
 * @param {string} text
 * @param {string} source
 * @param {Denylist} [into]
 * @returns {Denylist}
 */
export function parseDenylist(text, source, into = { terms: [], allows: [] }) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const allow = /^allow:\s*(.*)$/i.exec(line);
    if (allow) {
      if (allow[1].trim() !== '') into.allows.push(normalizeForMatch(allow[1].trim()));
      continue;
    }
    const entry = into.terms.length + 1;
    if (line.length < MIN_TERM_LENGTH) {
      throw new ConfigError(`Denylist entry ${entry} in ${source} is shorter than ${MIN_TERM_LENGTH} characters.`);
    }
    into.terms.push({ entry, source, normalized: normalizeForMatch(line) });
  }
  return into;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isPlaceholderName(name) {
  const lower = name.toLowerCase();
  return PLACEHOLDER_NAMES.has(lower) || /^[%$]/.test(name) || lower === '...' || lower === '…';
}

/**
 * @param {string} address
 * @param {string} domain
 * @returns {boolean}
 */
function isAllowedEmail(address, domain) {
  const lowerDomain = domain.toLowerCase();
  if (/^\d/.test(lowerDomain)) return true; // package specifiers such as pkg@1.2.3-beta.rc
  if (GENERIC_EMAIL_ADDRESSES.has(address.toLowerCase())) return true;
  if (RESERVED_EMAIL_DOMAINS.some((reserved) => lowerDomain === reserved || lowerDomain.endsWith(`.${reserved}`))) return true;
  return RESERVED_EMAIL_SUFFIXES.some((suffix) => lowerDomain.endsWith(suffix));
}

/**
 * Keeps two characters so a finding is recognizable without repeating the value in logs.
 * @param {string} value
 * @returns {string}
 */
export function maskValue(value) {
  return value.length <= 2 ? '***' : `${value.slice(0, 2)}***`;
}

/**
 * @param {string} line
 * @returns {Array<{ column: number, rule: string, detail: string }>}
 */
export function findBuiltInMatches(line) {
  /** @type {Array<{ column: number, rule: string, detail: string }>} */
  const matches = [];
  for (const { rule, regex } of HOME_PATH_RULES) {
    for (const match of line.matchAll(regex)) {
      if (isPlaceholderName(match[1])) continue;
      matches.push({ column: (match.index ?? 0) + 1, rule, detail: `home path for user "${maskValue(match[1])}"; use <home> or a placeholder` });
    }
  }
  for (const match of line.matchAll(EMAIL_REGEX)) {
    if (isAllowedEmail(match[0], match[1])) continue;
    matches.push({ column: (match.index ?? 0) + 1, rule: 'email', detail: `e-mail address "${maskValue(match[0])}"; use an example.com address` });
  }
  return matches.sort((a, b) => a.column - b.column);
}

/**
 * @param {string} line
 * @param {Denylist} denylist
 * @returns {DenylistTerm[]}
 */
export function findDenylistMatches(line, denylist) {
  if (denylist.terms.length === 0) return [];
  let normalized = normalizeForMatch(line);
  for (const allowed of denylist.allows) normalized = normalized.split(allowed).join(' ');
  return denylist.terms.filter((term) => normalized.includes(term.normalized));
}

/**
 * @param {string} text
 * @param {string} file
 * @param {Denylist} denylist
 * @returns {Finding[]}
 */
export function scanText(text, file, denylist) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of findBuiltInMatches(line)) {
      findings.push({ file, line: index + 1, column: match.column, rule: match.rule, detail: match.detail });
    }
    for (const term of findDenylistMatches(line, denylist)) {
      findings.push({ file, line: index + 1, column: null, rule: 'denylist', detail: `matches denylist entry ${term.entry} (${term.source})` });
    }
  });
  return findings;
}

/**
 * A fixture folder or file named after a real project leaks as much as its content.
 * @param {string} file
 * @param {Denylist} denylist
 * @returns {Finding[]}
 */
export function scanPath(file, denylist) {
  return findDenylistMatches(file, denylist).map((term) => ({
    file, line: 0, column: null, rule: 'denylist', detail: `file path matches denylist entry ${term.entry} (${term.source})`,
  }));
}

/**
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  const location = finding.line === 0 ? finding.file
    : finding.column === null ? `${finding.file}:${finding.line}` : `${finding.file}:${finding.line}:${finding.column}`;
  return `${location} ${finding.rule}: ${finding.detail}`;
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Files git would commit (tracked plus untracked, not ignored). Falls back to a directory walk
 * outside a git work tree.
 * @param {string} root
 * @param {{ useGit?: boolean }} [options]
 * @returns {{ files: string[], viaGit: boolean }}
 */
export function listRepoFiles(root, { useGit = true } = {}) {
  if (useGit) {
    const files = listGitFiles(root);
    if (files) return { files: files.filter((file) => isFile(path.join(root, file))), viaGit: true };
  }
  return { files: walkFiles(root, ''), viaGit: false };
}

/**
 * @param {string} root
 * @returns {string[] | null}
 */
function listGitFiles(root) {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const topLevel = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim();
    // A root below the work tree top still lists paths relative to the root.
    if (topLevel !== '') return null;
    return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

/**
 * @param {string} absolutePath
 * @returns {boolean}
 */
function isFile(absolutePath) {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {string} relativeDir
 * @returns {string[]}
 */
function walkFiles(root, relativeDir) {
  /** @type {string[]} */
  const files = [];
  const entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // byte order, like git
  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!WALK_SKIPPED_DIRS.has(entry.name)) files.push(...walkFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * @param {{ root: string, env: Record<string, string | undefined>, denylistPath?: string }} options
 * @returns {{ denylist: Denylist, denylistFile: string | null }}
 */
export function loadDenylist({ root, env, denylistPath }) {
  /** @type {Denylist} */
  const denylist = { terms: [], allows: [] };
  const explicitPath = denylistPath ?? env[DENYLIST_FILE_ENV];
  const filePath = explicitPath ? path.resolve(root, explicitPath) : path.join(root, DEFAULT_DENYLIST_NAME);
  /** @type {string | null} */
  let denylistFile = null;
  if (isFile(filePath)) {
    parseDenylist(fs.readFileSync(filePath, 'utf8'), path.basename(filePath), denylist);
    denylistFile = filePath;
  } else if (explicitPath) {
    throw new ConfigError(`Denylist file not found: ${explicitPath}`);
  }
  const inline = env[DENYLIST_ENV];
  if (inline && inline.trim() !== '') parseDenylist(inline, DENYLIST_ENV, denylist);
  return { denylist, denylistFile };
}

/**
 * @param {{ root: string, env?: Record<string, string | undefined>, denylistPath?: string, useGit?: boolean }} options
 * @returns {{ scannedFiles: number, denylistTerms: number, findings: Finding[] }}
 */
export function checkNoPersonalData({ root, env = {}, denylistPath, useGit = true }) {
  const absoluteRoot = path.resolve(root);
  const { denylist, denylistFile } = loadDenylist({ root: absoluteRoot, env, denylistPath });
  const { files, viaGit } = listRepoFiles(absoluteRoot, { useGit });
  const denylistRelative = denylistFile ? toRelative(absoluteRoot, denylistFile) : null;
  if (viaGit && denylistRelative && files.includes(denylistRelative)) {
    throw new ConfigError(`${denylistRelative} would be committed. Add it to .gitignore before running this check.`);
  }
  /** @type {Finding[]} */
  const findings = [];
  let scannedFiles = 0;
  for (const file of files) {
    if (file === denylistRelative) continue;
    findings.push(...scanPath(file, denylist));
    const buffer = fs.readFileSync(path.join(absoluteRoot, file));
    if (isBinary(buffer)) continue;
    scannedFiles += 1;
    findings.push(...scanText(buffer.toString('utf8'), file, denylist));
  }
  return { scannedFiles, denylistTerms: denylist.terms.length, findings };
}

/**
 * @param {string} root
 * @param {string} absolutePath
 * @returns {string | null}
 */
function toRelative(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

const USAGE = `Usage: node scripts/check-no-personal-data.mjs [--root <dir>] [--denylist <file>] [--json]

Fails on user home paths, e-mail addresses and local denylist terms in the content and paths of
files git would commit.
Denylist: ${DEFAULT_DENYLIST_NAME} (git-ignored) in the root, --denylist <file>, ${DENYLIST_FILE_ENV},
or ${DENYLIST_ENV} (inline content). One term per line, '#' comments, 'allow: <exact public string>'.
Template: scripts/personal-data-denylist.example.
Exit codes: 0 clean, 1 findings, 2 usage or configuration error.`;

/**
 * @param {string[]} argv
 * @returns {{ root: string, denylistPath?: string, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ root: string, denylistPath?: string, json: boolean, help: boolean }} */
  const options = { root: process.cwd(), json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root' || argument === '--denylist') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ConfigError(`${argument} needs a value.`);
      if (argument === '--root') options.root = value;
      else options.denylistPath = value;
      index += 1;
    } else {
      throw new ConfigError(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {number} Exit code.
 */
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const result = checkNoPersonalData({ root: options.root, env, denylistPath: options.denylistPath });
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: result.findings.length === 0, ...result })}\n`);
    } else {
      for (const finding of result.findings) stdout.write(`${formatFinding(finding)}\n`);
      const summary = `check-no-personal-data: ${result.findings.length} finding(s) in ${result.scannedFiles} file(s); ${result.denylistTerms} denylist term(s) loaded.`;
      (result.findings.length === 0 ? stdout : stderr).write(`${summary}\n`);
    }
    return result.findings.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`check-no-personal-data: ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
