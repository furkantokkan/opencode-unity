import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeTree } from '../helpers/fixture-fs.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';
import {
  UsageError,
  checkBannedPhrases,
  checkClaims,
  checkExperimentalLabels,
  checkMeasurementConfiguration,
  checkNumbersHaveEvidence,
  checkPreset,
  checkRelativeLinks,
  checkRequiredStatements,
  checkVerifiedRows,
  evidenceReferences,
  findEvidenceDir,
  hasMeasurement,
  isVerifiedRow,
  linkTargets,
  main,
  parseArgs,
  parseMarkdown,
  proseOf,
  resolveLinkTarget,
  splitTableRow,
} from '../../scripts/check-claims.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/check-claims.mjs', import.meta.url));

/** @param {string} text */
function blocksOf(text) {
  return parseMarkdown(text);
}

/** @param {Array<{ rule: string }>} findings */
function rulesOf(findings) {
  return findings.map((finding) => finding.rule);
}

/**
 * @param {{ release?: boolean, evidenceDir?: string | null, existing?: string[] }} [options]
 */
function evidenceContext({ release = false, evidenceDir = null, existing = [] } = {}) {
  const files = new Set(existing);
  return { release, evidenceDir, exists: (/** @type {string} */ relativePath) => files.has(relativePath) };
}

function captureStream() {
  /** @type {string[]} */
  const chunks = [];
  return { chunks, stream: /** @type {any} */ ({ write: (/** @type {string} */ text) => chunks.push(text) }) };
}

const COMPLIANT_README = `# opencode-unity

Unofficial. Not affiliated with OpenCode, Ollama or Unity Technologies.

## Safety

opencode-unity is not a sandbox. The GPU guard lowers the risk; it is not a guarantee.
\`dotnet build\` runs project MSBuild logic, so use it only on trusted projects.

## Measured evidence

Method and artifacts: [evidence](docs/evidence/v0.1/method.md).

| # | Measurement | Configuration when measured |
|---|---|---|
| E10 | Generation at 86.4 tok/s | 16K, q8_0 KV, native \`/api/chat\` |

## What you get

- The editor-check agent (experimental).
- Codex delegation (experimental).

## Support matrix

| Area | Verified |
|---|---|
| OS | Windows 11 x64 ([gate run](docs/evidence/v0.1/gate.md)) |
`;

describe('check-claims Markdown parsing', () => {
  it('splits blocks into headings, paragraphs, list items and table rows and drops fenced code', () => {
    const blocks = blocksOf([
      '# Title',
      'First line',
      'continues here.',
      '',
      '- item one',
      '  wrapped',
      '- item two',
      '',
      '```',
      '| not | a table |',
      '57 of 92 inside code',
      '```',
      '| A | B |',
      '|---|:---:|',
      '| 1 | 2 |',
      '## Next',
      'Tail.',
    ].join('\r\n'));
    assert.deepEqual(blocks.map((block) => [block.kind, block.line, block.section]), [
      ['heading', 1, 1],
      ['paragraph', 2, 1],
      ['list-item', 5, 1],
      ['list-item', 7, 1],
      ['table-row', 13, 1],
      ['table-row', 14, 1],
      ['table-row', 15, 1],
      ['heading', 16, 2],
      ['paragraph', 17, 2],
    ]);
    assert.equal(blocks[1].text, 'First line\ncontinues here.');
    assert.equal(blocks[2].text, '- item one\n  wrapped');
    assert.deepEqual(blocks.slice(4, 7).map((block) => block.table?.role), ['header', 'separator', 'row']);
    assert.deepEqual(blocks[6].table?.header, ['A', 'B']);
  });

  it('keeps pipes inside inline code and escaped pipes in one cell', () => {
    assert.deepEqual(splitTableRow('| `a | b` | c \\| d | e |'), ['`a | b`', 'c \\| d', 'e']);
    assert.deepEqual(splitTableRow('x | y'), ['x', 'y']);
  });

  it('removes comments, inline code and link targets from prose', () => {
    assert.equal(proseOf('a <!-- 10x --> `57 of 92` [text](docs/10x.md)').replace(/\s+/g, ' '), 'a [text]');
  });

  it('extracts inline links, images and reference definitions outside code', () => {
    const text = '[a](docs/a.md) ![img](img/b.png "title") `[c](c.md)`\n[ref]: <docs/ref.md>';
    assert.deepEqual(linkTargets(text), ['docs/a.md', 'img/b.png', 'docs/ref.md']);
  });
});

describe('check-claims measurements and evidence', () => {
  it('recognizes measured numbers and ignores versions, ids and ordinary counts', () => {
    for (const text of ['86.4 tok/s', '57 of 92 requests', '10/10 checks', '12.6 s cold load', '816 MiB', '19 GiB download', '45%', '5,000 tokens', '8K tokens']) {
      assert.equal(hasMeasurement(text), true, text);
    }
    for (const text of ['Node 22 or later', 'OpenCode 1.18.31', 'section 3.2', 'open 24/7', 'C1-C15', 'Windows 11 x64', 'v0.1', '`57 of 92`', 'exit code 130']) {
      assert.equal(hasMeasurement(text), false, text);
    }
  });

  it('finds evidence mentions and links resolved relative to the file', () => {
    assert.deepEqual(evidenceReferences('see `docs/evidence/v0.1/a.md` and [b](docs/evidence/v0.1/b.md)'), ['docs/evidence/v0.1/a.md', 'docs/evidence/v0.1/b.md']);
    assert.deepEqual(evidenceReferences('[run](evidence/v0.1/run.md)', 'docs/support-matrix.md'), ['docs/evidence/v0.1/run.md']);
    assert.deepEqual(evidenceReferences('[run](../docs/evidence/v0.1/run.md)', '.github/notes.md'), ['docs/evidence/v0.1/run.md']);
    assert.deepEqual(evidenceReferences('[other](docs/other.md) mydocs/evidence/x'), []);
  });

  it('requires evidence for numbers in the block or its section, unless marked claim-ok', () => {
    const findings = checkNumbersHaveEvidence('README.md', blocksOf([
      '# Numbers',
      'Prompts were cut to 8,194 tokens.',
      '',
      '# Linked section',
      'It generated 1,024 tokens at 86.4 tok/s.',
      '',
      'Method: [evidence](docs/evidence/v0.1/method.md).',
      '',
      '# Facts',
      'The download is 19 GiB. <!-- claim-ok: size from the model library page -->',
    ].join('\n')));
    assert.deepEqual(findings.map((finding) => [finding.line, finding.rule]), [[2, 'number-without-evidence']]);
  });

  it('checks that throughput and KV memory numbers carry their configuration', () => {
    const findings = checkMeasurementConfiguration('README.md', blocksOf([
      'Generation ran at 47.7 tok/s.',
      '',
      'Generation ran at 47.7 tok/s at 16K through native `/api/chat`.',
      '',
      'The KV cache used 816 MiB.',
      '',
      'The KV cache used 816 MiB at 16K with q8_0.',
      '',
      'Weights take 17,524 MiB.',
      '',
      '| Symptom | Configuration when measured |',
      '|---|---|',
      '| Truncation | - |',
      '| Sampling | `num_ctx 16384`, f16 KV |',
    ].join('\n')));
    assert.deepEqual(findings.map((finding) => [finding.line, finding.rule]), [
      [1, 'missing-configuration'],
      [5, 'missing-configuration'],
      [13, 'missing-configuration'],
    ]);
  });
});

describe('check-claims wording rules', () => {
  it('flags hype and replacement claims', () => {
    const cases = [
      ['It is 10x faster.', 'multiplier claim such as "10x"'],
      ['Up to 3 times faster than before.', 'multiplier claim such as "10x"'],
      ['This replaces Claude for daily work.', 'replacement claim'],
      ['Smarter than Copilot.', 'comparison claim'],
      ['A Cursor killer.', 'hype phrase'],
      ['It guarantees no data loss.', 'guarantee without a negation'],
      ['Your code is 100% private.', 'absolute safety claim'],
      ['Completely safe to run.', 'absolute safety claim'],
      ['Blazing fast and bulletproof.', 'hype phrase'],
    ];
    for (const [text, label] of cases) {
      assert.deepEqual(checkBannedPhrases('README.md', blocksOf(text)).map((finding) => finding.detail), [label], text);
    }
  });

  it('allows negated statements, code spans and ordinary text', () => {
    for (const text of [
      'The guard is not a guarantee.',
      'It gives no guarantee against driver hangs.',
      'It does not replace Claude or Codex.',
      'It is never completely safe to run untrusted MSBuild logic.',
      'Windows 11 x64 and `10x` inside code.',
      'Use a 0x10 offset.',
    ]) {
      assert.deepEqual(checkBannedPhrases('README.md', blocksOf(text)), [], text);
    }
  });

  it('requires the first mention of each experimental feature to carry the label', () => {
    const findings = checkExperimentalLabels('README.md', blocksOf([
      '# Features',
      '- Delegation to Codex.',
      '- Codex delegation (experimental).',
      '',
      '## The editor agent',
      'Experimental: it needs MCP for Unity.',
      '',
      'Use the 32K preset only with the guard.',
    ].join('\n')));
    assert.deepEqual(findings.map((finding) => [finding.line, finding.detail]), [
      [2, 'first mention of the Codex delegation is not labeled experimental'],
      [8, 'first mention of the 32K preset is not labeled experimental'],
    ]);
  });

  it('requires the not-a-sandbox, not-a-guarantee and MSBuild statements', () => {
    assert.deepEqual(checkRequiredStatements(new Map([['README.md', 'Nothing here.']])).map((finding) => finding.detail), [
      '"not a sandbox" is required in README.md',
      '"the guard is not a guarantee" is required in README.md',
      'MSBuild trust statement is required in README.md or docs/safety-model.md',
    ]);
    const texts = new Map([
      ['README.md', 'It is not a sandbox. The guard gives no guarantee.'],
      ['docs/safety-model.md', '`dotnet build` runs MSBuild logic from the project.'],
    ]);
    assert.deepEqual(checkRequiredStatements(texts), []);
  });
});

describe('check-claims verified labels', () => {
  it('detects verified rows by status cell or Verified column', () => {
    const rows = blocksOf([
      '| Row | Status | Verified |',
      '|---|---|---|',
      '| verified | experimental | - |',
      '| P1 | **verified** (gate) | |',
      '| P2 | reference-tested | Windows 11 |',
      '| P3 | unverified | — |',
    ].join('\n')).filter((block) => block.table?.role === 'row');
    assert.deepEqual(rows.map(isVerifiedRow), [false, true, true, false]);
    assert.equal(isVerifiedRow(blocksOf('# Heading')[0]), false);
  });

  it('requires evidence for verified rows, and existing files for the release version in release mode', () => {
    const markdown = [
      '# Matrix',
      '| Area | Status |',
      '|---|---|',
      '| OS | verified ([run](evidence/v0.1/os.md)) |',
      '| GPU | verified |',
      '',
      '# Linked below',
      '| Area | Status |',
      '|---|---|',
      '| Node | verified |',
      '',
      'Runs: [all](evidence/v0.1/node.md)',
    ].join('\n');
    const blocks = blocksOf(markdown);
    const draft = checkVerifiedRows('docs/support-matrix.md', blocks, evidenceContext());
    assert.deepEqual(draft.map((finding) => [finding.line, finding.detail]), [[5, 'verified row has no docs/evidence/ reference']]);

    const release = checkVerifiedRows('docs/support-matrix.md', blocks, evidenceContext({
      release: true, evidenceDir: 'docs/evidence/v0.1/', existing: ['docs/evidence/v0.1/os.md'],
    }));
    assert.deepEqual(release.map((finding) => [finding.line, finding.detail]), [
      [5, 'verified row has no docs/evidence/ reference'],
      [10, 'verified row must reference an existing file under docs/evidence/v0.1/'],
    ]);
    const noDir = checkVerifiedRows('docs/support-matrix.md', blocksOf(markdown.split('\n').slice(0, 4).join('\n')), evidenceContext({ release: true }));
    assert.match(noDir[0].detail, /current version evidence directory/);
  });

  it('checks preset labels and evidence', () => {
    const verified = JSON.stringify({ status: 'verified', evidence: 'docs/evidence/v0.1/p1.md' });
    assert.deepEqual(checkPreset('presets/p1.json', verified, evidenceContext()), []);
    assert.deepEqual(checkPreset('presets/p1.json', verified, evidenceContext({ release: true, evidenceDir: 'docs/evidence/v0.1/', existing: ['docs/evidence/v0.1/p1.md'] })), []);
    assert.deepEqual(rulesOf(checkPreset('presets/p1.json', verified, evidenceContext({ release: true, evidenceDir: 'docs/evidence/v0.2/' }))), ['verified-without-evidence']);
    assert.deepEqual(rulesOf(checkPreset('presets/p1.json', JSON.stringify({ status: 'verified', evidence: null }), evidenceContext())), ['verified-without-evidence']);
    assert.deepEqual(rulesOf(checkPreset('presets/p1.json', '{ not json', evidenceContext())), ['verified-without-evidence']);
    const referenceTested = JSON.stringify({ status: 'reference-tested', evidence: 'docs/evidence/v0.1/p1.md' });
    assert.deepEqual(checkPreset('presets/p1.json', referenceTested, evidenceContext()), []);
    assert.deepEqual(rulesOf(checkPreset('presets/p1.json', referenceTested, evidenceContext({ release: true }))), ['unresolved-label']);
    assert.deepEqual(checkPreset('presets/custom.json', JSON.stringify({ status: 'experimental', evidence: null }), evidenceContext({ release: true })), []);
  });

  it('finds the evidence directory for a version', async (t) => {
    const sandbox = await useSandbox(t, 'claims');
    const root = sandbox.path('repo');
    await writeTree(root, { 'docs/evidence/v0.1.2/a.md': 'x', 'docs/evidence/v0.3/b.md': 'y' });
    assert.equal(findEvidenceDir(root, '0.3.0'), 'docs/evidence/v0.3/');
    assert.equal(findEvidenceDir(root, '0.1.2'), 'docs/evidence/v0.1.2/');
    assert.equal(findEvidenceDir(root, '0.2.0'), null);
  });
});

describe('check-claims links', () => {
  it('resolves relative link targets and skips external links, anchors and placeholders', () => {
    assert.equal(resolveLinkTarget('docs/guide.md', '../README.md#quick-start'), 'README.md');
    assert.equal(resolveLinkTarget('docs/guide.md', 'faq.md?plain=1'), 'docs/faq.md');
    assert.equal(resolveLinkTarget('docs/guide.md', '/docs/My%20File.md'), 'docs/My File.md');
    assert.equal(resolveLinkTarget('README.md', 'docs/'), 'docs');
    assert.equal(resolveLinkTarget('README.md', '%E0%A4%A.md'), '%E0%A4%A.md');
    for (const target of ['https://example.com/x', 'mailto:maintainers@example.com', '#anchor', '//cdn.example.com/x', 'docs/<version>/x.md', '?query']) {
      assert.equal(resolveLinkTarget('README.md', target), null, target);
    }
  });

  it('reports broken relative links and defers evidence links to release mode', () => {
    const text = [
      '[ok](docs/ok.md) [broken](docs/missing.md) [ext](https://example.com)',
      '`[code](nope.md)` ![img](assets/logo.png)',
      '[evidence](docs/evidence/v0.1/run.md)',
      '[ref]: docs/ref-missing.md',
    ].join('\n');
    const context = evidenceContext({ existing: ['docs/ok.md'] });
    assert.deepEqual(checkRelativeLinks('README.md', text, context).map((finding) => finding.detail), [
      'relative link target not found: docs/missing.md',
      'relative link target not found: assets/logo.png',
      'relative link target not found: docs/ref-missing.md',
    ]);
    const releaseFindings = checkRelativeLinks('README.md', text, { ...context, release: true });
    assert.ok(releaseFindings.some((finding) => finding.detail.endsWith('docs/evidence/v0.1/run.md')));
  });
});

describe('check-claims repository scan', () => {
  it('passes a compliant tree and skips fixture and template Markdown', async (t) => {
    const sandbox = await useSandbox(t, 'claims');
    const root = sandbox.path('repo');
    await writeTree(root, {
      'package.json': JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Local Unity coding. Unofficial.' }),
      'README.md': COMPLIANT_README,
      'CHANGELOG.md': '# Changelog\n\n## [0.1.0]\n\n- First release.\n',
      'docs/support-matrix.md': '| Area | Status |\n|---|---|\n| OS | verified ([run](evidence/v0.1/gate.md)) |\n',
      'docs/evidence/v0.1/method.md': 'Method. This file may say 10x because evidence is not prose-checked.\n',
      'docs/evidence/v0.1/gate.md': 'Gate.\n',
      'presets/p1.json': JSON.stringify({ status: 'verified', evidence: 'docs/evidence/v0.1/gate.md' }),
      'test/fixtures/project/AGENTS.md': '[broken](nowhere.md) 10x faster\n',
      'templates/delegate/SKILL.md': '[placeholder]({{path}})\n',
    });
    const draft = checkClaims({ root });
    assert.deepEqual(draft.findings, []);
    assert.ok(draft.checkedFiles.includes('presets/p1.json'));
    assert.ok(!draft.checkedFiles.some((file) => file.startsWith('test/fixtures/') || file.startsWith('templates/')));
    assert.deepEqual(checkClaims({ root, release: true }).findings, []);
  });

  it('reports release blockers and package description hype', async (t) => {
    const sandbox = await useSandbox(t, 'claims');
    const root = sandbox.path('repo');
    await writeTree(root, {
      'package.json': JSON.stringify({ name: 'demo', version: '0.2.0', description: 'A Copilot killer.' }),
      'docs/guide.md': 'See [the matrix](support-matrix.md).\n',
      'presets/p1.json': JSON.stringify({ status: 'reference-tested', evidence: null }),
    });
    const release = checkClaims({ root, release: true });
    assert.deepEqual(release.findings.map((finding) => [finding.file, finding.rule]), [
      ['README.md', 'missing-statement'],
      ['docs/evidence', 'verified-without-evidence'],
      ['docs/guide.md', 'broken-link'],
      ['package.json', 'banned-phrase'],
      ['presets/p1.json', 'unresolved-label'],
    ]);
    const draft = checkClaims({ root, files: ['package.json', 'docs/guide.md', 'presets/p1.json'] });
    assert.deepEqual(rulesOf(draft.findings), ['broken-link', 'banned-phrase']);
  });

  it('parses arguments and maps results to exit codes', async (t) => {
    assert.deepEqual(parseArgs(['--root', 'x', '--release', '--json']), { root: 'x', release: true, json: true, help: false });
    assert.throws(() => parseArgs(['--root']), UsageError);
    assert.throws(() => parseArgs(['--bogus']), UsageError);

    const help = captureStream();
    assert.equal(main(['-h'], { stdout: help.stream }), 0);
    assert.match(help.chunks.join(''), /Usage:/);
    const usage = captureStream();
    assert.equal(main(['--bogus'], { stdout: captureStream().stream, stderr: usage.stream }), 2);
    assert.match(usage.chunks.join(''), /Unknown argument: --bogus/);

    const sandbox = await useSandbox(t, 'claims');
    const root = sandbox.path('repo');
    await writeTree(root, { 'docs/a.md': '[x](missing.md)\n' });
    const out = captureStream();
    const err = captureStream();
    assert.equal(main(['--root', root], { stdout: out.stream, stderr: err.stream }), 1);
    assert.equal(out.chunks.join(''), 'docs/a.md:1 broken-link: relative link target not found: missing.md\n');
    assert.match(err.chunks.join(''), /1 finding\(s\) in 1 file\(s\)/);

    const child = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, '--json'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    const parsed = JSON.parse(child.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.release, false);
    assert.equal(parsed.findings[0].rule, 'broken-link');
  });

  it('finds no claim violations in this repository', () => {
    assert.deepEqual(checkClaims({ root: REPO_ROOT }).findings, []);
  });
});
