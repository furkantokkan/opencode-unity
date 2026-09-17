import assert from 'node:assert/strict';
import test from 'node:test';
import { getVcsRules, IN_PROJECT_DIR, OPENCODE_GENERATED_ENTRIES, renderIgnoreGuidance, renderVcsFactsClause } from '../../../src/facts/vcs-rules.js';

test('each VCS has its read-only allow-list, and every client is denied for writes', () => {
  const git = getVcsRules('git');
  assert.deepEqual(git.readOnlyAllow, ['git status *', 'git diff *', 'git log *', 'git show *', 'git blame *']);
  assert.deepEqual(git.writeDeny, ['git *', 'cm *', 'p4 *', 'svn *', 'hg *']);
  assert.equal(git.experimental, false);
  assert.deepEqual(getVcsRules('plastic').readOnlyAllow, ['cm status *']);
  assert.equal(getVcsRules('plastic').displayName, 'Unity Version Control');
  assert.equal(getVcsRules('perforce').experimental, true);
  assert.equal(getVcsRules('svn').experimental, true);
  assert.equal(getVcsRules('hg').experimental, true);
});

test('an unknown or missing VCS still denies every client', () => {
  for (const kind of [null, undefined, 'none', 'fossil']) {
    const rules = getVcsRules(kind);
    assert.equal(rules.kind, 'none');
    assert.deepEqual(rules.readOnlyAllow, []);
    assert.equal(rules.writeDeny.length, 5);
  }
});

test('the facts clause names what the agent may run', () => {
  assert.equal(renderVcsFactsClause('git'), 'git (writes denied; status/diff/log/show/blame allowed)');
  assert.equal(renderVcsFactsClause('plastic'), 'Unity Version Control (writes denied; status allowed)');
  assert.equal(
    renderVcsFactsClause('perforce'),
    'Perforce (writes denied; opened/status/diff allowed; experimental; files may be read-only until checked out)',
  );
  assert.equal(renderVcsFactsClause('hg'), 'Mercurial (writes denied; status/diff/log allowed; experimental)');
  assert.equal(renderVcsFactsClause('none'), 'none detected (VCS commands denied)');
});

test('ignore guidance is printed per VCS and never applied', () => {
  assert.deepEqual(renderIgnoreGuidance('git'), {
    mechanism: '.gitignore',
    lines: ['.opencode-unity/'],
    notes: ['Add these to .gitignore only if your team does not want to commit .opencode-unity/.'],
  });
  assert.deepEqual(renderIgnoreGuidance('plastic').lines, ['/.opencode-unity']);
  assert.deepEqual(renderIgnoreGuidance('perforce').mechanism, '.p4ignore');
  assert.deepEqual(renderIgnoreGuidance('hg').lines, ['re:^\\.opencode-unity/']);
  assert.match(renderIgnoreGuidance('svn').lines[0], /^svn propedit svn:ignore \./);
  assert.deepEqual(renderIgnoreGuidance('none'), {
    mechanism: 'none',
    lines: [],
    notes: ['No version control was detected, so there is nothing to ignore.'],
  });
  assert.equal(IN_PROJECT_DIR, '.opencode-unity');
});

test('an existing .opencode folder is called out per VCS', () => {
  const git = renderIgnoreGuidance('git', { opencodeDir: true });
  assert.deepEqual(git.lines, ['.opencode-unity/']);
  assert.match(git.notes[1], /OpenCode writes its own \.opencode\/\.gitignore/);
  const plastic = renderIgnoreGuidance('plastic', { opencodeDir: true });
  assert.deepEqual(plastic.lines, ['/.opencode-unity', ...OPENCODE_GENERATED_ENTRIES.map((entry) => `/.opencode/${entry}`)]);
  assert.match(plastic.notes[1], /at every start/);
  assert.equal(renderIgnoreGuidance('hg', { opencodeDir: true }).lines.length, 1 + OPENCODE_GENERATED_ENTRIES.length);
  assert.equal(renderIgnoreGuidance('svn', { opencodeDir: true }).lines.length, 1 + OPENCODE_GENERATED_ENTRIES.length);
});
