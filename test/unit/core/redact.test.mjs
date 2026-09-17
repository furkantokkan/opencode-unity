import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLACEHOLDERS, createRedactor, getLocalRedactionTargets } from '../../../src/core/redact.js';

// Markers are assembled at runtime, so this file never contains a value that looks like real data.
const USER = ['pl', 'anted', 'user'].join('');
const MACHINE = ['DESK', 'TOP', '-PL4NTED'].join('');
const PROJECT = ['Planted', 'Game'].join('');
const EMAIL = `${USER}@${['example', 'invalid'].join('.')}`;
const BACKSLASH = '\\';
const WINDOWS_HOME = ['C:', 'Users', USER].join(BACKSLASH);
const POSIX_HOME = `/home/${USER}`;
const PROJECT_PATH = [WINDOWS_HOME, 'Repos', PROJECT].join(BACKSLASH);

function createTestRedactor() {
  return createRedactor({
    homeDirs: [WINDOWS_HOME, POSIX_HOME],
    userNames: [USER],
    machineNames: [MACHINE],
    projectNames: [PROJECT],
    projectPaths: [PROJECT_PATH],
    secrets: ['s3cret-value-from-env'],
  });
}

describe('createRedactor (spec 5.4 --redact, P5)', () => {
  it('replaces home paths in every separator spelling', () => {
    const { redactText } = createTestRedactor();
    assert.equal(redactText(`${WINDOWS_HOME}${BACKSLASH}AppData`), `${PLACEHOLDERS.home}${BACKSLASH}AppData`);
    assert.equal(redactText(`${WINDOWS_HOME.replace(/\\/g, '/')}/AppData`), `${PLACEHOLDERS.home}/AppData`);
    // A path inside JSON carries doubled separators.
    const escaped = `${WINDOWS_HOME}${BACKSLASH}x`.replaceAll(BACKSLASH, BACKSLASH + BACKSLASH);
    assert.equal(redactText(escaped), `${PLACEHOLDERS.home}${BACKSLASH}${BACKSLASH}x`);
    assert.equal(redactText(`${POSIX_HOME}/.config/opencode`), `${PLACEHOLDERS.home}/.config/opencode`);
  });

  it('replaces the project path before the home path it sits in', () => {
    const { redactText } = createTestRedactor();
    assert.equal(redactText(`${PROJECT_PATH}${BACKSLASH}Assets`), `${PLACEHOLDERS.projectPath}${BACKSLASH}Assets`);
  });

  it('replaces the user name, machine name and project name as whole words', () => {
    const { redactText } = createTestRedactor();
    assert.equal(redactText(`user ${USER} on ${MACHINE} builds ${PROJECT}`), `user ${PLACEHOLDERS.user} on ${PLACEHOLDERS.machine} builds ${PLACEHOLDERS.project}`);
    assert.equal(redactText(`${USER.toUpperCase()} again`), `${PLACEHOLDERS.user} again`);
    assert.equal(redactText(`${PROJECT}Runtime.csproj`), `${PROJECT}Runtime.csproj`, 'a longer identifier is left alone');
  });

  it('replaces emails and key values', () => {
    const { redactText } = createTestRedactor();
    assert.equal(redactText(`mail ${EMAIL}`), `mail ${PLACEHOLDERS.email}`);
    assert.equal(redactText('s3cret-value-from-env'), PLACEHOLDERS.secret);
    assert.equal(redactText('"apiKey": "sk-abcdefghijklmnopqrstuvwx"'), `"apiKey": "${PLACEHOLDERS.secret}"`);
    assert.equal(redactText('ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrst'), `ANTHROPIC_API_KEY=${PLACEHOLDERS.secret}`);
    assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /Authorization: <redacted>/);
    assert.equal(redactText("password = 'hunter2hunter2'"), `password = '${PLACEHOLDERS.secret}'`);
    assert.match(redactText(`token ${['ghp', '_', 'A'.repeat(36)].join('')}`), /token <redacted>/);
  });

  it('keeps the numbers and names a report is about', () => {
    const { redactText } = createTestRedactor();
    const line = 'requests 92, truncations 57, maxOutputTokens 4096, "toolsTokensSource": "capture:2026-09-17", model ocu-qwen3-coder-30b-16k';
    assert.equal(redactText(line), line);
    assert.equal(redactText('guard blocked: free VRAM 0.7 GiB (minimum 1.5 GiB)'), 'guard blocked: free VRAM 0.7 GiB (minimum 1.5 GiB)');
  });

  it('replaces any other user home path it meets', () => {
    const { redactText } = createRedactor({});
    assert.equal(redactText(['D:', 'Users', 'someone', 'Repos'].join(BACKSLASH)), ['D:', 'Users', PLACEHOLDERS.user, 'Repos'].join(BACKSLASH));
    assert.equal(redactText('/Users/someone/Library'), `/Users/${PLACEHOLDERS.user}/Library`);
    assert.equal(redactText(`/home/runner/work`), '/home/runner/work', 'CI accounts are not personal');
    assert.equal(redactText(['C:', 'Users', 'Public', 'Documents'].join(BACKSLASH)), ['C:', 'Users', 'Public', 'Documents'].join(BACKSLASH));
    assert.equal(redactText(['C:', 'Users', '<user>', 'x'].join(BACKSLASH)), ['C:', 'Users', '<user>', 'x'].join(BACKSLASH), 'a placeholder stays a placeholder');
  });

  it('redacts values and keys inside a JSON report', () => {
    const { redactValue } = createTestRedactor();
    const redacted = redactValue({
      home: `${WINDOWS_HOME}${BACKSLASH}AppData${BACKSLASH}Local`,
      projects: [{ name: PROJECT, contact: EMAIL }],
      counts: { requests: 12, truncations: 0 },
      flag: true,
      nothing: null,
    });
    assert.deepEqual(redacted, {
      home: `${PLACEHOLDERS.home}${BACKSLASH}AppData${BACKSLASH}Local`,
      projects: [{ name: PLACEHOLDERS.project, contact: PLACEHOLDERS.email }],
      counts: { requests: 12, truncations: 0 },
      flag: true,
      nothing: null,
    });
  });

  it('ignores targets that are too short or too generic to replace safely', () => {
    const { redactText } = createRedactor({ userNames: ['ab', 'user'], projectNames: ['Game'], homeDirs: ['/'] });
    assert.equal(redactText('ab is a user of Game in /tmp'), 'ab is a user of Game in /tmp');
  });
});

describe('getLocalRedactionTargets', () => {
  it('collects the home, user, machine and credential values of this machine', () => {
    const targets = getLocalRedactionTargets({
      env: { USERPROFILE: WINDOWS_HOME, USERNAME: USER, COMPUTERNAME: MACHINE, ANTHROPIC_API_KEY: 'sk-ant-value', PATH: 'C:\\bin' },
      homedir: WINDOWS_HOME,
      hostname: MACHINE,
      username: USER,
      projectNames: [PROJECT],
      projectPaths: [PROJECT_PATH],
    });
    assert.deepEqual(targets.homeDirs, [WINDOWS_HOME]);
    assert.deepEqual(targets.userNames, [USER]);
    assert.deepEqual(targets.machineNames, [MACHINE]);
    assert.deepEqual(targets.secrets, ['sk-ant-value']);
    assert.deepEqual(targets.projectPaths, [PROJECT_PATH]);
  });

  it('works with an empty environment', () => {
    const targets = getLocalRedactionTargets({ env: {}, homedir: POSIX_HOME, hostname: MACHINE, username: USER });
    assert.deepEqual(targets.secrets, []);
    assert.deepEqual(targets.homeDirs, [POSIX_HOME]);
  });
});
