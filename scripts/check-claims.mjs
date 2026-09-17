#!/usr/bin/env node
// Claims discipline (spec 18.2, 21.3, S14). Checks the README, docs, changelog and presets:
//   number-without-evidence    README blocks with a measured number (tok/s, tokens, MiB, %, s, N/M,
//                              "N of M") need a docs/evidence/ reference in the block or its section
//   banned-phrase              "10x", "replaces Claude", unqualified "guarantee" and similar hype
//   experimental-unlabeled     experimental features carry "experimental" at their first README mention
//   verified-without-evidence  every verified table row or preset references docs/evidence/
//   missing-configuration      throughput numbers name a context size and an API path; KV cache
//                              memory numbers name a KV type and a context size; evidence tables
//                              fill their Configuration column
//   missing-statement          "not a sandbox", "not a guarantee" and the MSBuild trust statement
//   broken-link                relative Markdown links resolve (offline); fixture and template trees
//                              are skipped
// A block that states a fact rather than a measurement can opt out of the number rule with
// `<!-- claim-ok: reason -->`.
//
// --release additionally requires README.md, the docs/evidence/v<major>.<minor>/ (or v<version>/)
// directory, verified rows that point at existing files inside it, and no preset still labeled
// reference-tested (unresolved-label). Evidence links are only resolved in --release mode, because
// evidence is committed at the release gate.
//
// Exit codes: 0 clean, 1 findings, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listRepoFiles } from './check-no-personal-data.mjs';

/**
 * @typedef {object} TableInfo
 * @property {string[]} header
 * @property {string[]} cells
 * @property {'header' | 'separator' | 'row'} role
 */

/**
 * @typedef {object} Block
 * @property {'heading' | 'paragraph' | 'list-item' | 'table-row'} kind
 * @property {number} line
 * @property {string} text
 * @property {number} section
 * @property {TableInfo} [table]
 */

/**
 * @typedef {object} Finding
 * @property {string} file
 * @property {number} line
 * @property {string} rule
 * @property {string} detail
 */

export class UsageError extends Error {}

const EVIDENCE_PREFIX = 'docs/evidence/';
const CLAIM_OK_MARKER = /<!--\s*claim-ok\b/i;
const NEGATION = /\b(?:not|no|never|cannot|without|nor)\b|n't\b/i;
const CONTEXT_SIZE = /\b\d+K\b|\bnum_ctx\b/;
const KV_TYPE = /\b(?:f16|f32|q8_0|q5_1|q5_0|q4_1|q4_0|iq4_nl)\b/i;

// Data trees whose Markdown is test input or a template, not project documentation.
export const MARKDOWN_EXCLUDED_PREFIXES = ['node_modules/', 'test/fixtures/', 'templates/', 'src/bench/sample-project/', 'src/selftest/fixtures/'];

const MEASUREMENT_PATTERNS = [
  /\b\d[\d,]*(?:\.\d+)?K?\s?(?:tok\/s|tokens?|MiB|GiB|KB|MB|ms|seconds?|minutes?)(?![\w/])/i,
  /\b\d[\d,]*(?:\.\d+)?\s?%/,
  /\b\d+(?:\.\d+)?\s?s\b(?![\w'-])/,
];
const RATIO_PATTERNS = [/\b(\d+) (?:of|out of) (\d+)\b/g, /\b(\d+)\/(\d+)\b/g];
const MAX_RATIO_DENOMINATOR = 1000;

/** @type {ReadonlyArray<{ pattern: RegExp, label: string, negatable: boolean }>} */
export const BANNED_PHRASES = [
  {
    pattern: /\b[1-9]\d*(?:\.\d+)?[x×](?![\w-])|\b\d+(?:\.\d+)?\s?times\s+(?:faster|better|cheaper|smaller|more|fewer|less)\b/i,
    label: 'multiplier claim such as "10x"',
    negatable: false,
  },
  { pattern: /\breplac(?:e|es|ing)\s+(?:claude|codex|gpt|chatgpt|copilot|cursor|cloud models?|frontier(?: cloud)? models?)\b/i, label: 'replacement claim', negatable: true },
  { pattern: /\b(?:better|smarter|faster) than (?:claude|codex|gpt|chatgpt|copilot|cursor)\b/i, label: 'comparison claim', negatable: false },
  { pattern: /\b(?:claude|codex|gpt|copilot|cursor)[- ]killer\b/i, label: 'hype phrase', negatable: false },
  { pattern: /\bguarantee[sd]?\b/i, label: 'guarantee without a negation', negatable: true },
  { pattern: /\b100\s?% (?:safe|secure|private|reliable)\b/i, label: 'absolute safety claim', negatable: false },
  { pattern: /\b(?:completely|totally|fully|perfectly) (?:safe|secure)\b/i, label: 'absolute safety claim', negatable: true },
  { pattern: /\b(?:zero[- ]risk|bulletproof|unbreakable|blazing(?:ly)?[- ]fast)\b/i, label: 'hype phrase', negatable: false },
];

/** @type {ReadonlyArray<{ id: string, pattern: RegExp }>} */
export const EXPERIMENTAL_FEATURES = [
  { id: 'editor agent', pattern: /\beditor(?:-check)? agent\b|\bunity-editor\b/i },
  { id: 'Codex delegation', pattern: /\bCodex\b/ },
  { id: '32K preset', pattern: /\b32K preset\b|\bpreset P2\b|nvidia-24gb-qwen3-coder-30b-32k/i },
  { id: 'custom preset', pattern: /\bcustom preset\b/i },
];

/** @type {ReadonlyArray<{ id: string, pattern: RegExp, files: readonly string[] }>} */
export const REQUIRED_STATEMENTS = [
  { id: '"not a sandbox"', pattern: /\bnot a sandbox\b/i, files: ['README.md'] },
  { id: '"the guard is not a guarantee"', pattern: /\b(?:not a|no) guarantee\b/i, files: ['README.md'] },
  { id: 'MSBuild trust statement', pattern: /\bMSBuild\b/, files: ['README.md', 'docs/safety-model.md'] },
];

/**
 * @param {string} line
 * @returns {string[]}
 */
export function splitTableRow(line) {
  /** @type {string[]} */
  const cells = [];
  let cell = '';
  let inCode = false;
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode && trimmed[index - 1] !== '\\') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Splits Markdown into blocks: headings, paragraphs, list items and table rows. Fenced code is dropped.
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string | null} */
  let fence = null;
  /** @type {Block | null} */
  let current = null;
  /** @type {string[] | null} */
  let tableHeader = null;
  let section = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      current = null;
      tableHeader = null;
      return;
    }
    if (line.trim() === '') {
      current = null;
      tableHeader = null;
      return;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      section += 1;
      current = null;
      tableHeader = null;
      blocks.push({ kind: 'heading', line: lineNumber, text: line, section });
      return;
    }
    if (/^\s*\|/.test(line)) {
      current = null;
      const cells = splitTableRow(line);
      if (tableHeader === null) {
        tableHeader = cells;
        blocks.push({ kind: 'table-row', line: lineNumber, text: line, section, table: { header: cells, cells, role: 'header' } });
      } else {
        const role = cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? 'separator' : 'row';
        blocks.push({ kind: 'table-row', line: lineNumber, text: line, section, table: { header: tableHeader, cells, role } });
      }
      return;
    }
    tableHeader = null;
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      current = { kind: 'list-item', line: lineNumber, text: line, section };
      blocks.push(current);
    } else if (current !== null) {
      current.text += `\n${line}`;
    } else {
      current = { kind: 'paragraph', line: lineNumber, text: line, section };
      blocks.push(current);
    }
  });
  return blocks;
}

/**
 * Text for claim detection: inline code, HTML comments and link targets removed.
 * @param {string} text
 * @returns {string}
 */
export function proseOf(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']');
}

/**
 * @param {string} cell
 * @returns {string}
 */
function plainCell(cell) {
  return cell.replace(/[*_`]/g, '').trim().toLowerCase();
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasMeasurement(text) {
  const prose = proseOf(text);
  if (MEASUREMENT_PATTERNS.some((pattern) => pattern.test(prose))) return true;
  return RATIO_PATTERNS.some((pattern) => [...prose.matchAll(pattern)].some((match) => {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    return denominator > 0 && numerator <= denominator && denominator <= MAX_RATIO_DENOMINATOR;
  }));
}

/**
 * @param {string} text
 * @returns {string[]}  Markdown link targets (inline links and reference definitions) outside inline code.
 */
export function linkTargets(text) {
  const withoutCode = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/`[^`]*`/g, ' ');
  return [
    ...[...withoutCode.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1]),
    ...[...withoutCode.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((match) => match[1]),
  ];
}

/**
 * @param {string} text
 * @param {string} [file]  Repository-relative path of the Markdown file, for resolving relative links.
 * @returns {string[]}  Repository-relative evidence paths: plain `docs/evidence/...` mentions (text or
 *   inline code) and links from `file` that resolve under docs/evidence/.
 */
export function evidenceReferences(text, file = 'README.md') {
  const mentioned = [...text.matchAll(/(?:^|[\s(`'"[<])(?:\.\/)?(docs\/evidence\/[^\s)`'"\]>#]*)/g)].map((match) => match[1]);
  const linked = linkTargets(text)
    .map((target) => resolveLinkTarget(file, target))
    .filter((resolved) => resolved !== null && `${resolved}/`.startsWith(EVIDENCE_PREFIX));
  return [...new Set([...mentioned, .../** @type {string[]} */ (linked)])];
}

/**
 * @param {Block[]} blocks
 * @param {{ proseOnly?: boolean }} [options]  proseOnly leaves table rows out, so one row's evidence
 *   link cannot cover its neighbours.
 * @returns {Map<number, string>}  Section number to the joined text of its blocks.
 */
function sectionTexts(blocks, { proseOnly = false } = {}) {
  /** @type {Map<number, string>} */
  const texts = new Map();
  for (const block of blocks) {
    if (proseOnly && block.kind === 'table-row') continue;
    texts.set(block.section, `${texts.get(block.section) ?? ''}\n${block.text}`);
  }
  return texts;
}

/**
 * @param {string} file
 * @param {Block[]} blocks
 * @returns {Finding[]}
 */
export function checkNumbersHaveEvidence(file, blocks) {
  const sections = sectionTexts(blocks);
  return blocks
    .filter((block) => block.kind !== 'heading' && block.table?.role !== 'separator')
    .filter((block) => !CLAIM_OK_MARKER.test(block.text) && hasMeasurement(block.text))
    .filter((block) => evidenceReferences(block.text, file).length === 0
      && evidenceReferences(sections.get(block.section) ?? '', file).length === 0)
    .map((block) => ({ file, line: block.line, rule: 'number-without-evidence', detail: 'measured number without a docs/evidence/ reference in the block or its section; add one or mark a non-measurement with <!-- claim-ok: reason -->' }));
}

/**
 * @param {string} file
 * @param {Block[]} blocks
 * @returns {Finding[]}
 */
export function checkBannedPhrases(file, blocks) {
  /** @type {Finding[]} */
  const findings = [];
  for (const block of blocks) {
    const sentences = proseOf(block.text).split(/(?<=[.!?])\s+/);
    for (const { pattern, label, negatable } of BANNED_PHRASES) {
      if (sentences.some((sentence) => isBannedIn(sentence, pattern, negatable))) {
        findings.push({ file, line: block.line, rule: 'banned-phrase', detail: label });
      }
    }
  }
  return findings;
}

/**
 * A negatable phrase is allowed only when a negation comes before it in the same sentence, so
 * "not a guarantee" passes and "guarantees no data loss" does not.
 * @param {string} sentence
 * @param {RegExp} pattern
 * @param {boolean} negatable
 * @returns {boolean}
 */
function isBannedIn(sentence, pattern, negatable) {
  const match = pattern.exec(sentence);
  if (match === null) return false;
  return !(negatable && NEGATION.test(sentence.slice(0, match.index)));
}

/**
 * @param {string} file
 * @param {Block[]} blocks
 * @returns {Finding[]}
 */
export function checkExperimentalLabels(file, blocks) {
  /** @type {Finding[]} */
  const findings = [];
  for (const feature of EXPERIMENTAL_FEATURES) {
    const index = blocks.findIndex((block) => feature.pattern.test(block.text));
    if (index === -1) continue;
    const block = blocks[index];
    const labelText = block.kind === 'heading' ? `${block.text}\n${blocks[index + 1]?.text ?? ''}` : block.text;
    if (!/\bexperimental\b/i.test(labelText)) {
      findings.push({ file, line: block.line, rule: 'experimental-unlabeled', detail: `first mention of the ${feature.id} is not labeled experimental` });
    }
  }
  return findings;
}

/**
 * @param {Block} block
 * @returns {boolean}
 */
export function isVerifiedRow(block) {
  if (!block.table || block.table.role !== 'row') return false;
  const { header, cells } = block.table;
  return cells.some((cell, column) => {
    const plain = plainCell(cell);
    if (column > 0 && /^verified(?:$|[\s(:;,])/.test(plain)) return true;
    return plainCell(header[column] ?? '') === 'verified' && plain !== '' && plain !== '-' && plain !== '—';
  });
}

/**
 * @typedef {object} EvidenceContext
 * @property {boolean} release
 * @property {string | null} evidenceDir   Repository-relative current-version evidence dir with a trailing `/`.
 * @property {(relativePath: string) => boolean} exists
 */

/**
 * @param {string} file
 * @param {number} line
 * @param {string[]} references
 * @param {string} subject
 * @param {EvidenceContext} context
 * @returns {Finding[]}
 */
function checkEvidenceReferences(file, line, references, subject, context) {
  if (references.length === 0) {
    return [{ file, line, rule: 'verified-without-evidence', detail: `${subject} has no docs/evidence/ reference` }];
  }
  if (!context.release) return [];
  const { evidenceDir } = context;
  const valid = references.some((reference) => evidenceDir !== null && reference.startsWith(evidenceDir)
    && !reference.includes('<') && context.exists(reference));
  return valid ? [] : [{ file, line, rule: 'verified-without-evidence', detail: `${subject} must reference an existing file under ${evidenceDir ?? 'the current version evidence directory'}` }];
}

/**
 * @param {string} file
 * @param {Block[]} blocks
 * @param {EvidenceContext} context
 * @returns {Finding[]}
 */
export function checkVerifiedRows(file, blocks, context) {
  const sections = sectionTexts(blocks, { proseOnly: true });
  return blocks.filter(isVerifiedRow).flatMap((block) => {
    const references = evidenceReferences(block.text, file);
    const inScope = references.length > 0 ? references : evidenceReferences(sections.get(block.section) ?? '', file);
    return checkEvidenceReferences(file, block.line, inScope, 'verified row', context);
  });
}

/**
 * @param {string} file
 * @param {string} text
 * @param {EvidenceContext} context
 * @returns {Finding[]}
 */
export function checkPreset(file, text, context) {
  /** @type {any} */
  let preset;
  try {
    preset = JSON.parse(text);
  } catch {
    return [{ file, line: 1, rule: 'verified-without-evidence', detail: 'preset is not valid JSON' }];
  }
  if (context.release && preset?.status === 'reference-tested') {
    return [{ file, line: 1, rule: 'unresolved-label', detail: 'a reference-tested preset must become verified or experimental at release (spec 3.1)' }];
  }
  if (preset?.status !== 'verified') return [];
  const evidence = typeof preset.evidence === 'string' ? evidenceReferences(` ${preset.evidence}`) : [];
  return checkEvidenceReferences(file, 1, evidence, 'verified preset', context);
}

/**
 * @param {string} file
 * @param {Block[]} blocks
 * @returns {Finding[]}
 */
export function checkMeasurementConfiguration(file, blocks) {
  /** @type {Finding[]} */
  const findings = [];
  for (const block of blocks) {
    if (block.table?.role === 'row') {
      const column = block.table.header.findIndex((cell) => /^configuration\b/.test(plainCell(cell)));
      const value = column === -1 ? null : plainCell(block.table.cells[column] ?? '');
      if (value !== null && (value === '' || value === '-' || value === '—')) {
        findings.push({ file, line: block.line, rule: 'missing-configuration', detail: 'evidence row has an empty Configuration cell' });
      }
    }
    const prose = proseOf(block.text);
    const hasContext = CONTEXT_SIZE.test(block.text);
    if (/tok\/s/i.test(prose)) {
      const hasApiPath = /\/api\/chat|\/v1\b|\bOpenCode\b/.test(block.text);
      if (!hasContext || !hasApiPath) {
        findings.push({ file, line: block.line, rule: 'missing-configuration', detail: 'throughput number must name the context size (for example 16K) and the API path (/api/chat, /v1 or OpenCode)' });
      }
    }
    if (/\bKV\b/.test(block.text) && /\b\d[\d,]*(?:\.\d+)?\s?[MG]iB\b/.test(prose)) {
      if (!hasContext || !KV_TYPE.test(block.text)) {
        findings.push({ file, line: block.line, rule: 'missing-configuration', detail: 'KV cache memory number must name the KV type (for example q8_0) and the context size (for example 16K)' });
      }
    }
  }
  return findings;
}

/**
 * @param {Map<string, string>} texts  Repository-relative path to content for the files that exist.
 * @returns {Finding[]}
 */
export function checkRequiredStatements(texts) {
  return REQUIRED_STATEMENTS
    .filter((statement) => !statement.files.some((file) => statement.pattern.test(texts.get(file) ?? '')))
    .map((statement) => ({ file: statement.files[0], line: 1, rule: 'missing-statement', detail: `${statement.id} is required in ${statement.files.join(' or ')}` }));
}

/**
 * @param {string} file
 * @param {string} text
 * @param {EvidenceContext} context
 * @returns {Finding[]}
 */
export function checkRelativeLinks(file, text, context) {
  /** @type {Finding[]} */
  const findings = [];
  const blocks = parseMarkdown(text);
  for (const block of blocks) {
    for (const target of linkTargets(block.text)) {
      const resolved = resolveLinkTarget(file, target);
      if (resolved === null) continue;
      if (!context.release && resolved.startsWith(EVIDENCE_PREFIX)) continue;
      if (!context.exists(resolved)) {
        findings.push({ file, line: block.line, rule: 'broken-link', detail: `relative link target not found: ${target}` });
      }
    }
  }
  return findings;
}

/**
 * @param {string} file
 * @param {string} target
 * @returns {string | null}  Repository-relative path, or null for external links, anchors and placeholders.
 */
export function resolveLinkTarget(file, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//') || target.includes('<')) return null;
  const withoutAnchor = target.replace(/[?#].*$/, '');
  if (withoutAnchor === '') return null;
  let decoded = withoutAnchor;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    // Keep the raw target; a malformed escape is reported as not found.
  }
  const base = decoded.startsWith('/') ? '' : path.posix.dirname(file);
  const joined = path.posix.normalize(path.posix.join(base, decoded.replace(/^\/+/, '')));
  return joined.replace(/\/$/, '') || '.';
}

/**
 * @param {string} root
 * @param {string} version
 * @returns {string | null}
 */
export function findEvidenceDir(root, version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  const candidates = [match ? `v${match[1]}.${match[2]}` : null, `v${version}`].filter(Boolean);
  for (const candidate of candidates) {
    const relative = `${EVIDENCE_PREFIX}${candidate}/`;
    if (fs.existsSync(path.join(root, relative))) return relative;
  }
  return null;
}

/**
 * @param {{ root: string, release?: boolean, files?: string[] }} options
 * @returns {{ checkedFiles: string[], findings: Finding[] }}
 */
export function checkClaims({ root, release = false, files }) {
  const absoluteRoot = path.resolve(root);
  const repoFiles = files ?? listRepoFiles(absoluteRoot).files;
  const fileSet = new Set(repoFiles);
  const read = (/** @type {string} */ file) => fs.readFileSync(path.join(absoluteRoot, file), 'utf8');
  /** @type {EvidenceContext} */
  const context = {
    release,
    evidenceDir: null,
    exists: (relativePath) => fs.existsSync(path.join(absoluteRoot, relativePath)),
  };
  /** @type {Finding[]} */
  const findings = [];
  if (release) {
    const version = readPackageVersion(absoluteRoot);
    context.evidenceDir = findEvidenceDir(absoluteRoot, version);
    if (context.evidenceDir === null) {
      findings.push({ file: 'docs/evidence', line: 1, rule: 'verified-without-evidence', detail: `release ${version} needs docs/evidence/v<major>.<minor>/ or docs/evidence/v${version}/` });
    }
    if (!fileSet.has('README.md')) findings.push({ file: 'README.md', line: 1, rule: 'missing-statement', detail: 'README.md is required for a release' });
  }

  const markdownFiles = repoFiles.filter((file) => file.toLowerCase().endsWith('.md')
    && !MARKDOWN_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));
  /** @type {Map<string, string>} */
  const texts = new Map(markdownFiles.map((file) => [file, read(file)]));
  const checkedFiles = new Set(markdownFiles);

  const readme = texts.get('README.md');
  if (readme !== undefined) {
    const blocks = parseMarkdown(readme);
    findings.push(...checkNumbersHaveEvidence('README.md', blocks), ...checkExperimentalLabels('README.md', blocks),
      ...checkMeasurementConfiguration('README.md', blocks), ...checkRequiredStatements(texts));
  }
  for (const [file, text] of texts) {
    const isProse = file === 'README.md' || file === 'CHANGELOG.md' || (file.startsWith('docs/') && !file.startsWith(EVIDENCE_PREFIX));
    if (isProse) findings.push(...checkBannedPhrases(file, parseMarkdown(text)));
    if (file === 'README.md' || file === 'docs/support-matrix.md') findings.push(...checkVerifiedRows(file, parseMarkdown(text), context));
    findings.push(...checkRelativeLinks(file, text, context));
  }
  for (const file of repoFiles.filter((name) => /^presets\/[^/]+\.json$/.test(name))) {
    checkedFiles.add(file);
    findings.push(...checkPreset(file, read(file), context));
  }
  if (fileSet.has('package.json')) {
    const description = JSON.parse(read('package.json')).description;
    if (typeof description === 'string') {
      findings.push(...checkBannedPhrases('package.json', [{ kind: 'paragraph', line: 1, text: description, section: 0 }]));
    }
  }
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { checkedFiles: [...checkedFiles].sort(), findings };
}

/**
 * @param {string} root
 * @returns {string}
 */
function readPackageVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string') throw new UsageError('package.json has no version.');
  return version;
}

const USAGE = `Usage: node scripts/check-claims.mjs [--root <dir>] [--release] [--json]

Checks README, docs, changelog and presets against the claims rules (spec 18.2).
Exit codes: 0 clean, 1 findings, 2 usage error.`;

/**
 * @param {string[]} argv
 * @returns {{ root: string, release: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { root: process.cwd(), release: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') options.release = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--root needs a value.');
      options.root = value;
      index += 1;
    } else {
      throw new UsageError(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {number}
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const result = checkClaims({ root: options.root, release: options.release });
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: result.findings.length === 0, release: options.release, ...result })}\n`);
    } else {
      for (const finding of result.findings) stdout.write(`${finding.file}:${finding.line} ${finding.rule}: ${finding.detail}\n`);
      const summary = `check-claims${options.release ? ' --release' : ''}: ${result.findings.length} finding(s) in ${result.checkedFiles.length} file(s).`;
      (result.findings.length === 0 ? stdout : stderr).write(`${summary}\n`);
    }
    return result.findings.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`check-claims: ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
