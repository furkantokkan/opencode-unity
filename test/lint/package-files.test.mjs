import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeTree } from '../helpers/fixture-fs.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';
import { listRepoFiles } from '../../scripts/check-no-personal-data.mjs';
import {
  FORBIDDEN_PACKED,
  RELEASE_REQUIRED_PACKED,
  UsageError,
  binTargets,
  checkForbiddenFiles,
  checkManifest,
  checkPackageFiles,
  checkReleaseMetadata,
  comparePackList,
  compileAllowList,
  compileFilesEntry,
  distTag,
  expectedPackFiles,
  extractChangelogSection,
  main,
  parseArgs,
  parsePackJson,
  resolveNpmInvocation,
  runNpmPackDryRun,
} from '../../scripts/check-package-files.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/check-package-files.mjs', import.meta.url));

const MANIFEST = {
  name: 'demo',
  version: '0.1.0',
  type: 'module',
  bin: { demo: './bin/demo.mjs' },
  files: ['bin/', 'src/', 'compat.json'],
  engines: { node: '>=22' },
  devDependencies: { typescript: '7.0.2' },
};

function captureStream() {
  /** @type {string[]} */
  const chunks = [];
  return { chunks, stream: /** @type {any} */ ({ write: (/** @type {string} */ text) => chunks.push(text) }) };
}

/** @param {Array<{ rule: string }>} findings */
function rulesOf(findings) {
  return findings.map((finding) => finding.rule);
}

describe('check-package-files allow-list matching', () => {
  it('treats directory entries as prefixes and supports simple globs and negation', () => {
    const { covers, unsupported } = compileAllowList(['bin/', 'src', 'presets/*.json', 'docs/**/*.md', '!src/dev-only.js', 'compat.json']);
    assert.deepEqual(unsupported, []);
    for (const file of ['bin/cli.mjs', 'bin/nested/x.js', 'src/a.js', 'src/deep/b.js', 'presets/p1.json', 'docs/a.md', 'docs/deep/b.md', 'compat.json']) {
      assert.equal(covers(file), true, file);
    }
    for (const file of ['test/a.js', 'presets/p1.json.bak', 'presets/deep/p.json', 'docs/a.txt', 'src/dev-only.js', 'compatXjson', 'binary/x.js']) {
      assert.equal(covers(file), false, file);
    }
  });

  it('reports entries it cannot check instead of matching them silently', () => {
    assert.deepEqual(compileAllowList(['{a,b}/', '  ', 'src/']).unsupported, [
      '{a,b}/: brace or character-class globs are not supported by this check',
      '  : empty entry',
    ]);
    assert.deepEqual(compileFilesEntry('!./lib/'), { negated: true, regex: /^lib(?:\/.*)?$/ });
  });

  it('reads bin targets in both manifest shapes', () => {
    assert.deepEqual(binTargets({ bin: './bin/a.mjs' }), ['bin/a.mjs']);
    assert.deepEqual(binTargets({ bin: { a: 'bin/a.mjs', b: './bin/b.mjs', c: 5 } }), ['bin/a.mjs', 'bin/b.mjs']);
    assert.deepEqual(binTargets({}), []);
  });
});

describe('check-package-files manifest rules', () => {
  it('accepts a clean manifest', () => {
    assert.deepEqual(checkManifest(MANIFEST, { repoFiles: ['bin/demo.mjs'] }), []);
  });

  it('rejects runtime dependencies in every field', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
      const manifest = { ...MANIFEST, [field]: field.endsWith('Dependencies') && field.startsWith('bundled') ? ['x'] : { x: '1.0.0' } };
      assert.deepEqual(rulesOf(checkManifest(manifest)), ['runtime-dependency'], field);
      assert.deepEqual(checkManifest({ ...MANIFEST, [field]: field.startsWith('bundled') ? [] : {} }), []);
    }
  });

  it('requires pinned dev dependencies, an allow-list, a module type, engines and bin', () => {
    assert.deepEqual(rulesOf(checkManifest({ ...MANIFEST, devDependencies: { a: '^1.0.0', b: '1.0.0', c: 'latest', d: 2 } })), [
      'unpinned-dev-dependency', 'unpinned-dev-dependency', 'unpinned-dev-dependency',
    ]);
    assert.deepEqual(checkManifest({ ...MANIFEST, devDependencies: { a: '1.0.0-rc.1' } }), []);
    assert.deepEqual(rulesOf(checkManifest({ ...MANIFEST, files: [] })), ['manifest']);
    assert.deepEqual(rulesOf(checkManifest({ ...MANIFEST, files: ['src/', 42] })), ['manifest']);
    assert.deepEqual(checkManifest({ ...MANIFEST, files: ['src/{a,b}'] }).map((finding) => finding.detail), [
      'files entry is not checkable: src/{a,b}: brace or character-class globs are not supported by this check',
    ]);
    assert.deepEqual(rulesOf(checkManifest({ ...MANIFEST, type: 'commonjs', engines: {}, bin: undefined })), ['manifest', 'manifest', 'manifest']);
    assert.deepEqual(checkManifest(MANIFEST, { repoFiles: [] }).map((finding) => finding.detail), [
      'bin target is missing from the repository: bin/demo.mjs',
    ]);
  });
});

describe('check-package-files pack list', () => {
  const repoFiles = ['LICENSE', 'README.md', 'bin/demo.mjs', 'compat.json', 'package-lock.json', 'package.json', 'scripts/gen.mjs', 'src/a.js', 'test/a.test.mjs'];

  it('expects allow-listed files plus the files npm always adds', () => {
    assert.deepEqual(expectedPackFiles({ manifest: MANIFEST, repoFiles }), [
      'LICENSE', 'README.md', 'bin/demo.mjs', 'compat.json', 'package.json', 'src/a.js',
    ]);
    assert.deepEqual(expectedPackFiles({ manifest: { files: [], main: 'lib/index.js' }, repoFiles: ['lib/index.js', 'lib/other.js'] }), ['lib/index.js']);
  });

  it('reports files packed outside the allow-list and allow-listed files that are not packed', () => {
    const findings = comparePackList({
      expected: ['bin/demo.mjs', 'package.json', 'src/a.js'],
      packed: ['bin/demo.mjs', 'package.json', 'src/generated.js'],
    });
    assert.deepEqual(findings.map((finding) => [finding.file, finding.rule]), [
      ['src/generated.js', 'unexpected-file'],
      ['src/a.js', 'missing-file'],
    ]);
  });

  it('refuses development, secret and minified files in the tarball', () => {
    const packed = [
      'test/a.test.mjs', 'spikes/run.mjs', 'scripts/gen.mjs', 'docs/a.md', '.github/workflows/ci.yml',
      'src/node_modules/x/index.js', 'coverage/lcov.info', 'demo-0.1.0.tgz', 'src/debug.log', 'src/a.js.map',
      'plugin/lib.min.js', '.env.local', 'src/.npmrc', '.personal-data-denylist', 'src/.DS_Store', 'src/a.js',
    ];
    const findings = checkForbiddenFiles(packed);
    assert.deepEqual(findings.map((finding) => finding.file), packed.slice(0, -1));
    assert.ok(FORBIDDEN_PACKED.length > 0);
    assert.deepEqual(checkForbiddenFiles(['src/a.js', 'plugin/opencode-unity.js']), []);
  });

  it('parses the npm pack JSON report and rejects unusable output', () => {
    // A report packed on Windows carries `\` separators and must read the same on every platform.
    const report = JSON.stringify([{ files: [{ path: 'src\\a.js' }, { path: 'bin/demo.mjs' }] }]);
    assert.deepEqual(parsePackJson(`npm notice\n${report}\n`), ['bin/demo.mjs', 'src/a.js']);
    assert.throws(() => parsePackJson('no json here'), UsageError);
    assert.throws(() => parsePackJson('[{'), UsageError);
    assert.throws(() => parsePackJson('[{"name":"demo"}]'), UsageError);
  });

  it('runs npm through Node when npm-cli.js is next to the binary, and falls back to the command', () => {
    const nodeDir = path.dirname('/opt/node/bin/node');
    assert.deepEqual(resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      exists: (filePath) => filePath === path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    }), { file: '/opt/node/bin/node', args: [path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')], shell: false });
    assert.deepEqual(resolveNpmInvocation({
      env: { npm_execpath: '/custom/npm-cli.js' },
      execPath: '/opt/node/bin/node',
      exists: (filePath) => filePath === '/custom/npm-cli.js',
    }), { file: '/opt/node/bin/node', args: ['/custom/npm-cli.js'], shell: false });
    assert.deepEqual(resolveNpmInvocation({ execPath: '/opt/node/bin/node', platform: 'linux', exists: () => false }), { file: 'npm', args: [], shell: false });
    assert.deepEqual(resolveNpmInvocation({ execPath: 'C:/node/node.exe', platform: 'win32', exists: () => false }), { file: 'npm.cmd', args: [], shell: true });
  });
});

describe('check-package-files release metadata', () => {
  it('extracts the changelog section for the version', () => {
    const changelog = [
      '# Changelog', '',
      '## [Unreleased]', '', '- nothing', '',
      '## [0.2.0] - 2026-10-01', '', '### Added', '- A feature.', '',
      '## [0.1.0] - 2026-09-01', '', '- First release.', '',
      '[0.2.0]: https://example.com/2', '[0.1.0]: https://example.com/1',
    ].join('\n');
    assert.equal(extractChangelogSection(changelog, '0.2.0'), '### Added\n- A feature.');
    assert.equal(extractChangelogSection(changelog, '0.1.0'), '- First release.');
    assert.equal(extractChangelogSection(changelog, '0.3.0'), null);
    assert.equal(extractChangelogSection('## v1.0.0\n\n- Released.\n', '1.0.0'), '- Released.');
    assert.equal(extractChangelogSection('## [0.1.0]\n\n## [0.0.9]\n- old\n', '0.1.0'), '');
  });

  it('checks the tag, compat.json and the changelog section', () => {
    const changelog = '## [0.1.0]\n\n- First release.\n';
    assert.deepEqual(checkReleaseMetadata({ version: '0.1.0', tag: 'v0.1.0', changelog, compatPresent: true }), {
      findings: [], notes: '- First release.',
    });
    assert.deepEqual(checkReleaseMetadata({ version: '0.1.0', tag: '0.1.0', changelog, compatPresent: true }).findings, []);
    assert.deepEqual(rulesOf(checkReleaseMetadata({ version: '0.1.0', tag: 'v0.2.0', changelog, compatPresent: true }).findings), ['tag-mismatch']);
    assert.deepEqual(rulesOf(checkReleaseMetadata({ version: '0.1.0', changelog: null, compatPresent: false }).findings), ['missing-release-file', 'missing-release-file']);
    assert.deepEqual(rulesOf(checkReleaseMetadata({ version: '0.1.0', changelog: '# Changelog\n', compatPresent: true }).findings), ['changelog-section']);
  });

  it('maps pre-release versions to the next dist-tag', () => {
    assert.equal(distTag('0.1.0'), 'latest');
    assert.equal(distTag('0.2.0-rc.1'), 'next');
    assert.deepEqual(RELEASE_REQUIRED_PACKED, ['README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'compat.json']);
  });
});

describe('check-package-files end to end', () => {
  /**
   * @param {import('node:test').TestContext} t
   * @param {Record<string, string>} extraFiles
   */
  async function makePackage(t, extraFiles = {}) {
    const sandbox = await useSandbox(t, 'package-files');
    const root = sandbox.path('pkg');
    await writeTree(root, {
      'package.json': `${JSON.stringify({ ...MANIFEST, name: 'demo-package', files: ['bin/', 'src/'] }, null, 2)}\n`,
      'bin/demo.mjs': '#!/usr/bin/env node\nconsole.log("demo");\n',
      'src/a.js': 'export const a = 1;\n',
      'README.md': '# Demo\n',
      'LICENSE': 'MIT\n',
      'test/a.test.mjs': 'import "node:test";\n',
      ...extraFiles,
    });
    return { sandbox, root };
  }

  it('matches the real npm pack list of a clean package', async (t) => {
    const { sandbox, root } = await makePackage(t);
    const packed = runNpmPackDryRun({ root, env: sandbox.env });
    assert.deepEqual(packed, ['LICENSE', 'README.md', 'bin/demo.mjs', 'package.json', 'src/a.js']);
    const result = checkPackageFiles({ root, env: sandbox.env });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.packedFiles, packed);
    assert.equal(result.distTag, 'latest');
  });

  it('flags an allow-list that publishes the test suite', async (t) => {
    const { sandbox, root } = await makePackage(t, {
      'package.json': `${JSON.stringify({ ...MANIFEST, name: 'demo-package', files: ['bin/', 'src/', 'test/'] }, null, 2)}\n`,
    });
    const findings = checkPackageFiles({ root, env: sandbox.env }).findings;
    assert.deepEqual(findings.map((finding) => [finding.file, finding.rule]), [['test/a.test.mjs', 'forbidden-file']]);
  });

  it('reports release blockers and writes the release notes', async (t) => {
    const { sandbox, root } = await makePackage(t, {
      'CHANGELOG.md': '# Changelog\n\n## [0.1.0] - 2026-09-01\n\n- First release.\n',
      'compat.json': '{}\n',
      'package.json': `${JSON.stringify({ ...MANIFEST, name: 'demo-package', files: ['bin/', 'src/', 'CHANGELOG.md', 'compat.json'] }, null, 2)}\n`,
    });
    const result = checkPackageFiles({ root, release: true, tag: 'v0.2.0', env: sandbox.env });
    assert.deepEqual(result.findings.map((finding) => [finding.file, finding.rule]), [
      ['NOTICE.md', 'missing-release-file'],
      ['package.json', 'tag-mismatch'],
    ]);
    assert.equal(result.notes, '- First release.');

    /** @type {Array<[string, string]>} */
    const written = [];
    const out = captureStream();
    const exitCode = main(['--root', root, '--release', '--tag', 'v0.1.0', '--release-notes', 'notes.md', '--json'], {
      env: sandbox.env, stdout: out.stream, stderr: captureStream().stream, writeFile: (filePath, content) => written.push([filePath, content]),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(written, [['notes.md', '- First release.\n']]);
    const parsed = JSON.parse(out.chunks.join(''));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.release, true);
    assert.deepEqual(parsed.findings.map((/** @type {{ rule: string }} */ finding) => finding.rule), ['missing-release-file']);
  });

  it('parses arguments, prints findings and reports usage errors', async (t) => {
    assert.deepEqual(parseArgs(['--root', 'x', '--release', '--tag', 'v1.0.0', '--release-notes', 'n.md', '--json']), {
      root: 'x', release: true, tag: 'v1.0.0', notesPath: 'n.md', json: true, help: false,
    });
    assert.throws(() => parseArgs(['--root']), UsageError);
    assert.throws(() => parseArgs(['--tag', 'v1.0.0']), UsageError);
    assert.throws(() => parseArgs(['--what']), UsageError);

    const help = captureStream();
    assert.equal(main(['--help'], { stdout: help.stream }), 0);
    assert.match(help.chunks.join(''), /Usage:/);
    const usageErr = captureStream();
    assert.equal(main(['--what'], { stdout: captureStream().stream, stderr: usageErr.stream }), 2);
    assert.match(usageErr.chunks.join(''), /Unknown argument/);

    const sandbox = await useSandbox(t, 'package-files');
    const missing = sandbox.path('no-package');
    await fs.mkdir(missing, { recursive: true });
    const noManifest = captureStream();
    assert.equal(main(['--root', missing], { env: sandbox.env, stdout: captureStream().stream, stderr: noManifest.stream, packList: () => [] }), 2);
    assert.match(noManifest.chunks.join(''), /No package\.json/);
    await fs.writeFile(path.join(missing, 'package.json'), '{ broken');
    assert.throws(() => checkPackageFiles({ root: missing, packList: () => [] }), UsageError);

    const { root } = await makePackage(t);
    const out = captureStream();
    const err = captureStream();
    assert.equal(main(['--root', root], { stdout: out.stream, stderr: err.stream, packList: () => ['package.json', 'test/a.test.mjs'] }), 1);
    assert.equal(out.chunks.join(''), [
      'LICENSE missing-file: covered by the files allow-list but not packed',
      'README.md missing-file: covered by the files allow-list but not packed',
      'bin/demo.mjs missing-file: covered by the files allow-list but not packed',
      'src/a.js missing-file: covered by the files allow-list but not packed',
      'test/a.test.mjs forbidden-file: development-only directory must not be published',
      'test/a.test.mjs unexpected-file: packed although the files allow-list does not cover it',
      '',
    ].join('\n'));
    assert.match(err.chunks.join(''), /2 packed file\(s\)/);
  });

  it('reports a failing npm run as a usage error', async (t) => {
    const sandbox = await useSandbox(t, 'package-files');
    const root = sandbox.path('empty');
    await fs.mkdir(root, { recursive: true });
    assert.throws(() => runNpmPackDryRun({ root, env: sandbox.env }), UsageError);
  });

  it('packs this repository exactly as the allow-list describes', async (t) => {
    const before = listRepoFiles(REPO_ROOT).files;
    const result = checkPackageFiles({ root: REPO_ROOT, repoFiles: before });
    // Parallel work on the repository would race with npm pack; only judge a stable tree.
    if (listRepoFiles(REPO_ROOT).files.join('\n') !== before.join('\n')) {
      t.skip('the working tree changed while npm pack ran');
      return;
    }
    assert.deepEqual(result.findings, []);
    assert.ok(result.packedFiles.includes('bin/opencode-unity.mjs'));
  });

  it('runs as a script and exits 0 on a clean package', async (t) => {
    const { sandbox, root } = await makePackage(t);
    const child = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, '--json'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).ok, true);
  });
});
