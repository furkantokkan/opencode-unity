#!/usr/bin/env node
// Supply-chain hygiene for the published package (spec 16 P8, 20.2, 20.5, 21.1, 21.3).
//
// Manifest rules:
//   runtime-dependency        no dependencies, optionalDependencies, peerDependencies or bundled
//                             dependencies: the product ships with none
//   unpinned-dev-dependency   dev dependencies are exact versions, so CI and releases are repeatable
//   manifest                  files allow-list, bin targets, type and engines are present and sane
//
// Pack rules (`npm pack --dry-run --json`, the list npm would publish):
//   unexpected-file           packed although the allow-list does not cover it
//   missing-file              covered by the allow-list, in the repository, yet not packed
//   forbidden-file            tests, spikes, scripts, docs, workflows, logs, minified or map files,
//                             local secrets
//
// --release also requires README.md, LICENSE, NOTICE.md, CHANGELOG.md and compat.json in the
// tarball, `--tag v<version>` to match package.json, and a CHANGELOG section for that version;
// `--release-notes <file>` writes that section for the GitHub release.
//
// Exit codes: 0 clean, 1 findings, 2 usage or runtime error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listRepoFiles } from './check-no-personal-data.mjs';

export class UsageError extends Error {}

/** Files npm adds to every tarball regardless of the allow-list (matched at the root only). */
const ALWAYS_PACKED = /^(?:package\.json|readme(?:\.[^/]*)?|licen[cs]e(?:\.[^/]*)?)$/i;

/** @type {ReadonlyArray<{ pattern: RegExp, reason: string }>} */
export const FORBIDDEN_PACKED = [
  { pattern: /^(?:test|spikes|scripts|docs|\.github)\//, reason: 'development-only directory' },
  { pattern: /(?:^|\/)node_modules\//, reason: 'dependency tree' },
  { pattern: /(?:^|\/)coverage\//, reason: 'coverage output' },
  { pattern: /\.(?:tgz|log|map)$/i, reason: 'build or log artifact' },
  { pattern: /\.min\.(?:js|mjs|cjs)$/i, reason: 'minified code (the plugin ships readable)' },
  { pattern: /(?:^|\/)(?:\.env[^/]*|\.npmrc|\.personal-data-denylist)$/i, reason: 'local secret or credential file' },
  { pattern: /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/i, reason: 'operating system junk' },
];

export const RELEASE_REQUIRED_PACKED = ['README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'compat.json'];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

/**
 * @typedef {object} Finding
 * @property {string} file
 * @property {string} rule
 * @property {string} detail
 */

/**
 * @param {string} entry  One `files` entry.
 * @returns {{ negated: boolean, regex: RegExp } | { unsupported: string }}
 */
export function compileFilesEntry(entry) {
  let pattern = entry.trim();
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (pattern === '') return { unsupported: 'empty entry' };
  if (/[{}[\]()]/.test(pattern)) return { unsupported: 'brace or character-class globs are not supported by this check' };
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^$|\\]/g, '\\$&');
  }
  // A directory entry covers everything below it.
  return { negated, regex: new RegExp(`^${source}(?:/.*)?$`) };
}

/**
 * @param {string[]} entries  The `files` allow-list.
 * @returns {{ covers: (relativePath: string) => boolean, unsupported: string[] }}
 */
export function compileAllowList(entries) {
  /** @type {string[]} */
  const unsupported = [];
  /** @type {Array<{ negated: boolean, regex: RegExp }>} */
  const matchers = [];
  for (const entry of entries) {
    const compiled = compileFilesEntry(entry);
    if ('unsupported' in compiled) unsupported.push(`${entry}: ${compiled.unsupported}`);
    else matchers.push(compiled);
  }
  return {
    unsupported,
    covers: (relativePath) => matchers.reduce(
      (covered, matcher) => (matcher.regex.test(relativePath) ? !matcher.negated : covered),
      false,
    ),
  };
}

/**
 * @param {any} manifest
 * @returns {string[]}  Repository-relative paths of the bin scripts.
 */
export function binTargets(manifest) {
  const bin = manifest?.bin;
  if (typeof bin === 'string') return [bin.replace(/^\.\//, '')];
  if (bin && typeof bin === 'object') return Object.values(bin).filter((value) => typeof value === 'string').map((value) => value.replace(/^\.\//, ''));
  return [];
}

/**
 * @param {any} manifest
 * @param {{ repoFiles?: string[] }} [options]
 * @returns {Finding[]}
 */
export function checkManifest(manifest, { repoFiles } = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {string} */ rule, /** @type {string} */ detail) => findings.push({ file: 'package.json', rule, detail });
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest?.[field];
    const empty = value === undefined || (Array.isArray(value) ? value.length === 0 : Object.keys(value ?? {}).length === 0);
    if (!empty) add('runtime-dependency', `${field} must stay empty: opencode-unity ships with zero runtime dependencies`);
  }
  for (const [name, version] of Object.entries(manifest?.devDependencies ?? {})) {
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      add('unpinned-dev-dependency', `${name} must be pinned to an exact version, found "${String(version)}"`);
    }
  }
  const files = manifest?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((entry) => typeof entry !== 'string')) {
    add('manifest', 'files must be a non-empty allow-list of strings');
  } else {
    for (const problem of compileAllowList(files).unsupported) add('manifest', `files entry is not checkable: ${problem}`);
  }
  if (manifest?.type !== 'module') add('manifest', 'type must be "module"');
  if (typeof manifest?.engines?.node !== 'string') add('manifest', 'engines.node must state the minimum Node version');
  const targets = binTargets(manifest);
  if (targets.length === 0) add('manifest', 'bin must name the CLI entry point');
  if (repoFiles) {
    for (const target of targets.filter((target) => !repoFiles.includes(target))) {
      add('manifest', `bin target is missing from the repository: ${target}`);
    }
  }
  return findings;
}

/**
 * @param {{ manifest: any, repoFiles: string[] }} options
 * @returns {string[]}  Sorted paths the tarball should contain.
 */
export function expectedPackFiles({ manifest, repoFiles }) {
  const { covers } = compileAllowList(Array.isArray(manifest?.files) ? manifest.files.filter((entry) => typeof entry === 'string') : []);
  const targets = new Set([...binTargets(manifest), ...(typeof manifest?.main === 'string' ? [manifest.main.replace(/^\.\//, '')] : [])]);
  return repoFiles
    .filter((file) => covers(file) || targets.has(file) || (!file.includes('/') && ALWAYS_PACKED.test(file)))
    .sort();
}

/**
 * @param {{ expected: string[], packed: string[] }} options
 * @returns {Finding[]}
 */
export function comparePackList({ expected, packed }) {
  const expectedSet = new Set(expected);
  const packedSet = new Set(packed);
  return [
    ...packed.filter((file) => !expectedSet.has(file))
      .map((file) => ({ file, rule: 'unexpected-file', detail: 'packed although the files allow-list does not cover it' })),
    ...expected.filter((file) => !packedSet.has(file))
      .map((file) => ({ file, rule: 'missing-file', detail: 'covered by the files allow-list but not packed' })),
  ];
}

/**
 * @param {string[]} packed
 * @returns {Finding[]}
 */
export function checkForbiddenFiles(packed) {
  return packed.flatMap((file) => FORBIDDEN_PACKED
    .filter((forbidden) => forbidden.pattern.test(file))
    .map((forbidden) => ({ file, rule: 'forbidden-file', detail: `${forbidden.reason} must not be published` })));
}

/**
 * @param {string} stdout  Output of `npm pack --dry-run --json`.
 * @returns {string[]}  Packed paths with `/` separators.
 */
export function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  if (start === -1) throw new UsageError('npm pack --json printed no JSON.');
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (error) {
    throw new UsageError(`npm pack --json output could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) throw new UsageError('npm pack --json output has no file list.');
  return files.map((entry) => String(entry.path).split(path.sep).join('/')).sort();
}

/**
 * npm is a JavaScript file next to the running Node, so no shell is needed; the `npm` command on the
 * PATH is the last resort.
 * @param {{ env?: Record<string, string | undefined>, execPath?: string, platform?: NodeJS.Platform, exists?: (filePath: string) => boolean }} [options]
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
export function resolveNpmInvocation({ env = {}, execPath = process.execPath, platform = process.platform, exists = fs.existsSync } = {}) {
  const fromEnv = env.npm_execpath;
  const nodeDir = path.dirname(execPath);
  const candidates = [
    ...(fromEnv && fromEnv.endsWith('.js') ? [fromEnv] : []),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const script = candidates.find((candidate) => exists(candidate));
  if (script) return { file: execPath, args: [script], shell: false };
  return { file: platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: platform === 'win32' };
}

/**
 * @param {{ root: string, env?: Record<string, string | undefined> }} options
 * @returns {string[]}
 */
export function runNpmPackDryRun({ root, env = process.env }) {
  const { file, args, shell } = resolveNpmInvocation({ env });
  try {
    const stdout = execFileSync(file, [...args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      shell,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parsePackJson(stdout);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const stderr = /** @type {any} */ (error)?.stderr;
    throw new UsageError(`npm pack --dry-run failed: ${typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(error)}`);
  }
}

/**
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}  The section body without its heading and link definitions.
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&');
  const heading = new RegExp(String.raw`^##\s+\[?v?${escaped}\]?(?:\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
    .join('\n')
    .trim();
}

/**
 * @param {{ version: string, tag?: string, changelog: string | null, compatPresent: boolean }} options
 * @returns {{ findings: Finding[], notes: string | null }}
 */
export function checkReleaseMetadata({ version, tag, changelog, compatPresent }) {
  /** @type {Finding[]} */
  const findings = [];
  if (tag !== undefined && tag !== `v${version}` && tag !== version) {
    findings.push({ file: 'package.json', rule: 'tag-mismatch', detail: `tag ${tag} does not match version ${version}` });
  }
  if (!compatPresent) findings.push({ file: 'compat.json', rule: 'missing-release-file', detail: 'compat.json must state the tested set for the release' });
  if (changelog === null) {
    findings.push({ file: 'CHANGELOG.md', rule: 'missing-release-file', detail: 'CHANGELOG.md is required for a release' });
    return { findings, notes: null };
  }
  const notes = extractChangelogSection(changelog, version);
  if (notes === null || notes === '') {
    findings.push({ file: 'CHANGELOG.md', rule: 'changelog-section', detail: `CHANGELOG.md has no content under a "## [${version}]" heading` });
  }
  return { findings, notes: notes === '' ? null : notes };
}

/**
 * @param {string} version
 * @returns {'latest' | 'next'}  npm dist-tag: pre-releases never become the default install.
 */
export function distTag(version) {
  return version.includes('-') ? 'next' : 'latest';
}

/**
 * @typedef {object} PackageCheckResult
 * @property {string[]} packedFiles
 * @property {Finding[]} findings
 * @property {string | null} notes     Release notes from the changelog, in release mode.
 * @property {string} version
 * @property {'latest' | 'next'} distTag
 */

/**
 * @param {{ root: string, release?: boolean, tag?: string, env?: Record<string, string | undefined>,
 *   packList?: (options: { root: string, env?: Record<string, string | undefined> }) => string[],
 *   repoFiles?: string[] }} options
 * @returns {PackageCheckResult}
 */
export function checkPackageFiles({ root, release = false, tag, env = process.env, packList = runNpmPackDryRun, repoFiles }) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) throw new UsageError(`No package.json in ${absoluteRoot}`);
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new UsageError(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = repoFiles ?? listRepoFiles(absoluteRoot).files;
  const packedFiles = packList({ root: absoluteRoot, env });
  /** @type {Finding[]} */
  const findings = [
    ...checkManifest(manifest, { repoFiles: files }),
    ...comparePackList({ expected: expectedPackFiles({ manifest, repoFiles: files }), packed: packedFiles }),
    ...checkForbiddenFiles(packedFiles),
  ];
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (version === '') findings.push({ file: 'package.json', rule: 'manifest', detail: 'version is missing' });
  /** @type {string | null} */
  let notes = null;
  if (release) {
    const changelogPath = path.join(absoluteRoot, 'CHANGELOG.md');
    const metadata = checkReleaseMetadata({
      version,
      tag,
      changelog: fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : null,
      compatPresent: fs.existsSync(path.join(absoluteRoot, 'compat.json')),
    });
    notes = metadata.notes;
    findings.push(...metadata.findings);
    const packedSet = new Set(packedFiles);
    for (const required of RELEASE_REQUIRED_PACKED.filter((file) => !packedSet.has(file))) {
      findings.push({ file: required, rule: 'missing-release-file', detail: 'must be part of the published tarball' });
    }
  }
  findings.sort((a, b) => (a.file === b.file ? a.rule.localeCompare(b.rule) : a.file < b.file ? -1 : 1));
  return { packedFiles, findings, notes, version, distTag: distTag(version) };
}

const USAGE = `Usage: node scripts/check-package-files.mjs [--root <dir>] [--release [--tag <vX.Y.Z>]]
                                           [--release-notes <file>] [--json]

Compares the \`npm pack --dry-run\` file list with the package.json files allow-list and checks
supply-chain rules (no runtime dependencies, pinned dev dependencies, nothing private published).
Exit codes: 0 clean, 1 findings, 2 usage or runtime error.`;

/**
 * @param {string[]} argv
 * @returns {{ root: string, release: boolean, tag?: string, notesPath?: string, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ root: string, release: boolean, tag?: string, notesPath?: string, json: boolean, help: boolean }} */
  const options = { root: process.cwd(), release: false, json: false, help: false };
  const valueFlags = new Set(['--root', '--tag', '--release-notes']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') options.release = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${argument} needs a value.`);
      if (argument === '--root') options.root = value;
      else if (argument === '--tag') options.tag = value;
      else options.notesPath = value;
      index += 1;
    } else {
      throw new UsageError(`Unknown argument: ${argument}`);
    }
  }
  if (options.tag !== undefined && !options.release) throw new UsageError('--tag requires --release.');
  return options;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream,
 *   packList?: (options: { root: string, env?: Record<string, string | undefined> }) => string[],
 *   writeFile?: (filePath: string, content: string) => void }} [io]
 * @returns {number}
 */
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, packList, writeFile } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const result = checkPackageFiles({ root: options.root, release: options.release, tag: options.tag, env, packList });
    if (options.notesPath !== undefined && result.notes !== null) {
      (writeFile ?? ((filePath, content) => fs.writeFileSync(filePath, content)))(options.notesPath, `${result.notes}\n`);
    }
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: result.findings.length === 0, release: options.release, ...result })}\n`);
    } else {
      for (const finding of result.findings) stdout.write(`${finding.file} ${finding.rule}: ${finding.detail}\n`);
      const summary = `check-package-files${options.release ? ' --release' : ''}: ${result.findings.length} finding(s); ${result.packedFiles.length} packed file(s).`;
      (result.findings.length === 0 ? stdout : stderr).write(`${summary}\n`);
    }
    return result.findings.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`check-package-files: ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
