// Structural checks for the GitHub Actions workflows and Dependabot config (spec 16 P8, 20.1, 21).
// There is no YAML dependency, so the rules are line based: pinned action SHAs, least privilege,
// concurrency, and no test job that could reach a real Ollama server or Unity MCP hub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const WORKFLOW_NAMES = ['ci.yml', 'contract-latest.yml', 'release.yml'];

/** @type {Map<string, string>} */
const workflows = new Map(WORKFLOW_NAMES.map((name) => [name, fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8')]));
const dependabot = fs.readFileSync(path.join(REPO_ROOT, '.github', 'dependabot.yml'), 'utf8');

/**
 * @param {string} text
 * @returns {Array<{ line: number, action: string, ref: string, comment: string | null }>}
 */
function usesEntries(text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?$/.exec(line);
    if (match === null) return [];
    const [action, ref = ''] = match[1].split('@');
    return [{ line: index + 1, action, ref, comment: match[2] ?? null }];
  });
}

/**
 * @param {string} text
 * @returns {string[]}  Job ids, in file order.
 */
function jobIds(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) return [];
  /** @type {string[]} */
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim() !== '') break;
    const match = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * @param {string} text
 * @param {string} jobId
 * @returns {string}  The job block, without the following jobs.
 */
function jobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(start, -1, `job ${jobId} not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('workflow hygiene', () => {
  it('pins every action to a full commit SHA with the version in a comment', () => {
    for (const [name, text] of workflows) {
      for (const entry of usesEntries(text)) {
        if (entry.action.startsWith('./')) {
          assert.equal(entry.ref, '', `${name}:${entry.line} a local reusable workflow takes no ref`);
          assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.action.slice(2))), `${name}:${entry.line} ${entry.action} does not exist`);
          continue;
        }
        assert.match(entry.ref, /^[0-9a-f]{40}$/, `${name}:${entry.line} ${entry.action} must be pinned by commit SHA`);
        assert.match(entry.comment ?? '', /^v\d+\.\d+\.\d+$/, `${name}:${entry.line} ${entry.action} must name its version in a comment`);
      }
    }
  });

  it('pins one SHA per action version across all workflows', () => {
    /** @type {Map<string, string>} */
    const pins = new Map();
    for (const text of workflows.values()) {
      for (const entry of usesEntries(text).filter((candidate) => !candidate.action.startsWith('./'))) {
        const key = `${entry.action} ${entry.comment}`;
        const known = pins.get(key);
        if (known === undefined) pins.set(key, entry.ref);
        else assert.equal(entry.ref, known, `${key} is pinned to two different commits`);
      }
    }
    assert.ok(pins.size >= 4);
  });

  it('checks out without persisting credentials', () => {
    for (const [name, text] of workflows) {
      const checkouts = usesEntries(text).filter((entry) => entry.action === 'actions/checkout');
      assert.ok(checkouts.length > 0, `${name} never checks out`);
      const blocks = text.split(/uses: actions\/checkout@/).slice(1);
      for (const block of blocks) {
        assert.match(block.split(/\n\s*- /)[0], /persist-credentials: false/, `${name} must check out with persist-credentials: false`);
      }
    }
  });

  it('defaults to read-only permissions and cancels superseded runs', () => {
    for (const [name, text] of workflows) {
      assert.match(text, /^permissions:\n {2}contents: read$/m, `${name} must default to contents: read`);
      assert.match(text, /^concurrency:\n {2}group: /m, `${name} must set a concurrency group`);
      // A workflow-level group that repeats the caller's group would deadlock the reusable call.
      assert.doesNotMatch(text, /group: \$\{\{ github\.workflow \}\}/, `${name} must not group by github.workflow`);
    }
  });

  it('grants write permissions only where the release and drift jobs need them', () => {
    const writeUses = [...workflows].flatMap(([name, text]) => text.split(/\r?\n/)
      .map((line, index) => ({ name, line: index + 1, text: line.trim() }))
      .filter((entry) => /^(?:id-token|issues|contents|packages|actions|pull-requests):\s*write$/.test(entry.text)));
    assert.deepEqual(writeUses.map((entry) => `${entry.name} ${entry.text}`), [
      'contract-latest.yml issues: write',
      'release.yml id-token: write',
      'release.yml contents: write',
    ]);
    assert.match(jobBlock(workflows.get('release.yml') ?? '', 'publish'), /id-token: write/);
    assert.match(jobBlock(workflows.get('release.yml') ?? '', 'github-release'), /contents: write/);
  });

  it('keeps every job away from a real Ollama server, npm registry mirror or Unity MCP hub', () => {
    for (const [name, text] of workflows) {
      assert.doesNotMatch(text, /:(?:11434|8081)\b/, `${name} must not name a real service port`);
      if (name === 'release.yml') continue;
      assert.match(text, /OLLAMA_HOST: http:\/\/127\.0\.0\.1:9/, `${name} must point OLLAMA_HOST at the closed port`);
      for (const flag of ['OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_CLAUDE_CODE']) {
        assert.match(text, new RegExp(`${flag}: "1"`), `${name} must set ${flag}`);
      }
    }
  });

  it('names test suites with quoted globs, because node --test rejects directories', () => {
    for (const [name, text] of workflows) {
      for (const [, argument] of text.matchAll(/node --test\s+([^\n]*)/g)) {
        assert.doesNotMatch(argument, /(?:^|\s)test\/[^"']*(?:\s|$)/, `${name} must quote test globs: ${argument}`);
      }
      assert.doesNotMatch(text, /--auto\b|--yolo\b|--dangerously-skip-permissions\b/, `${name} must never pass an auto-approval flag`);
    }
  });

  it('ends every workflow with a newline and uses spaces only', () => {
    for (const [name, text] of [...workflows, ['dependabot.yml', dependabot]]) {
      assert.ok(text.endsWith('\n'), `${name} must end with a newline`);
      assert.doesNotMatch(text, /\t/, `${name} must not contain tabs`);
      assert.doesNotMatch(text, /\r/, `${name} must use LF line endings`);
    }
  });
});

describe('ci.yml jobs', () => {
  const ci = workflows.get('ci.yml') ?? '';

  it('runs the required jobs on the runners the spec names', () => {
    assert.deepEqual(jobIds(ci), ['lint', 'unit', 'contract', 'package', 'macos-smoke']);
    assert.match(jobBlock(ci, 'lint'), /runs-on: ubuntu-latest/);
    assert.match(jobBlock(ci, 'contract'), /runs-on: windows-latest/);
    assert.match(jobBlock(ci, 'package'), /runs-on: windows-latest/);
    assert.match(jobBlock(ci, 'macos-smoke'), /runs-on: macos-latest/);
    for (const job of ['contract', 'package']) assert.match(jobBlock(ci, job), /needs: unit/);
    assert.match(jobBlock(ci, 'macos-smoke'), /continue-on-error: true/);
    assert.doesNotMatch(jobBlock(ci, 'lint'), /continue-on-error/);
  });

  it('runs the unit suites on both operating systems and both Node versions', () => {
    const unit = jobBlock(ci, 'unit');
    assert.match(unit, /os: \[windows-latest, ubuntu-latest\]/);
    assert.match(unit, /node: \["22", "24"\]/);
    assert.match(unit, /fail-fast: false/);
    for (const suite of ['unit', 'plugin', 'doctor', 'install', 'delegate', 'bench', 'lint']) {
      assert.ok(unit.includes(`"test/${suite}/**/*.test.mjs"`), `the unit job must run the ${suite} suite`);
    }
    assert.match(unit, /--test-coverage-lines=90/);
    const gatedPaths = [
      'plugin/opencode-unity-lib/guard/**',
      'src/opencode/permission-eval.js',
      'src/facts/**',
      'src/unity/**',
      // The workspace scanner and the one path that may load a model: both decide what leaves the
      // machine, so an untested branch in either is exactly what this gate exists to catch.
      'src/project/**',
      'src/ollama/guarded-chat.js',
      // Amendment 38.16: the network lane, whose every branch decides whether a request leaves.
      'plugin/opencode-unity-lib/net/**',
      'src/network/**',
      // The editor argument policy is the one gate between the model and a mutating Editor tool.
      'plugin/opencode-unity-lib/mcp-args.js',
    ];
    for (const gated of gatedPaths) {
      assert.ok(unit.includes(`--test-coverage-include="${gated}"`), `the coverage gate must include ${gated}`);
    }
  });

  it('runs every hygiene script in the lint job', () => {
    const lint = jobBlock(ci, 'lint');
    for (const script of ['check-no-personal-data', 'check-claims', 'check-package-files']) {
      assert.ok(lint.includes(`node scripts/${script}.mjs`), `the lint job must run ${script}`);
      assert.ok(fs.existsSync(path.join(REPO_ROOT, 'scripts', `${script}.mjs`)), `scripts/${script}.mjs must exist`);
    }
    assert.match(lint, /npx tsc -p jsconfig\.json --noEmit/);
    assert.match(lint, /OPENCODE_UNITY_DENYLIST: \$\{\{ secrets\.PERSONAL_DATA_DENYLIST \}\}/);
    assert.match(lint, /git status --porcelain/);
  });

  it('installs the tested OpenCode version for the contract job and keeps its artifacts', () => {
    const contract = jobBlock(ci, 'contract');
    assert.match(contract, /opencode-ai@1\.18\.31/);
    assert.match(contract, /uses: actions\/cache@/);
    assert.match(contract, /OPENCODE_UNITY_TEST_OPENCODE: /);
    assert.match(contract, /if: failure\(\)\n\s+uses: actions\/upload-artifact@/);
  });

  it('can be called by the release workflow', () => {
    assert.match(ci, /^on:\n(?:.*\n)*? {2}workflow_call:/m);
    assert.match(ci, /PERSONAL_DATA_DENYLIST:\n\s+description:/);
  });
});

describe('release.yml', () => {
  const release = workflows.get('release.yml') ?? '';

  it('runs only on version tags and reuses ci.yml first', () => {
    assert.match(release, /tags: \["v\*\.\*\.\*"\]/);
    assert.deepEqual(jobIds(release), ['ci', 'verify', 'publish', 'github-release']);
    assert.match(jobBlock(release, 'ci'), /uses: \.\/\.github\/workflows\/ci\.yml/);
    assert.match(jobBlock(release, 'verify'), /needs: ci/);
    assert.match(jobBlock(release, 'publish'), /needs: verify/);
    assert.match(jobBlock(release, 'github-release'), /needs: publish/);
    assert.doesNotMatch(release, /cancel-in-progress: true/);
  });

  it('verifies the release metadata before publishing', () => {
    const verify = jobBlock(release, 'verify');
    assert.match(verify, /check-package-files\.mjs --release --tag "\$GITHUB_REF_NAME"/);
    assert.match(verify, /check-claims\.mjs --release/);
    assert.match(verify, /check-no-personal-data\.mjs/);
  });

  it('publishes the packed bytes with provenance and attaches them to the release', () => {
    const publish = jobBlock(release, 'publish');
    assert.match(publish, /registry-url: https:\/\/registry\.npmjs\.org/);
    assert.match(publish, /npm pack --ignore-scripts/);
    assert.match(publish, /sha256sum/);
    assert.match(publish, /npm publish "\$\{\{ steps\.pack\.outputs\.tarball \}\}" --provenance --access public --tag/);
    assert.doesNotMatch(publish, /NODE_AUTH_TOKEN|NPM_TOKEN/);
    const githubRelease = jobBlock(release, 'github-release');
    assert.match(githubRelease, /uses: actions\/download-artifact@/);
    assert.match(githubRelease, /--release-notes/);
    assert.match(githubRelease, /gh release create "\$GITHUB_REF_NAME"/);
    assert.match(githubRelease, /SHA256SUMS/);
    assert.match(githubRelease, /--prerelease/);
  });
});

describe('contract-latest.yml', () => {
  const drift = workflows.get('contract-latest.yml') ?? '';

  it('runs weekly on Monday 04:00 UTC and on demand', () => {
    assert.match(drift, /cron: "0 4 \* \* 1"/);
    assert.match(drift, /workflow_dispatch:/);
    assert.doesNotMatch(drift, /pull_request:|push:/);
  });

  it('keeps going on failure and files one issue per drifting version', () => {
    const job = jobBlock(drift, 'drift');
    assert.match(job, /id: contract\n\s+continue-on-error: true/);
    assert.match(job, /id: fixtures\n\s+continue-on-error: true/);
    assert.match(job, /refresh-opencode-fixtures\.mjs/);
    assert.match(job, /if: steps\.contract\.outcome == 'failure' \|\| steps\.fixtures\.outcome == 'failure'/);
    assert.match(job, /gh issue comment/);
    assert.match(job, /gh issue create --title \$title/);
    assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  });
});

describe('dependabot.yml', () => {
  it('updates actions and development dependencies weekly and keeps runtime dependencies out', () => {
    assert.match(dependabot, /^version: 2$/m);
    assert.match(dependabot, /package-ecosystem: github-actions/);
    assert.match(dependabot, /package-ecosystem: npm/);
    assert.equal((dependabot.match(/interval: weekly/g) ?? []).length, 2);
    assert.match(dependabot, /allow:\n\s+- dependency-type: development/);
    assert.match(dependabot, /versioning-strategy: increase/);
    assert.match(dependabot, /dependency-name: "@opencode-ai\/plugin"/);
  });
});
