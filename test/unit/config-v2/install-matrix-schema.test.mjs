// schema/install-matrix.schema.json (amendment 34.2, D-M2): the rules the schema itself enforces on the one
// fact set every install surface is generated from. The matrix, its generators and its linter are later
// steps; this suite pins the schema they validate against, with the repository's own validator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { compileSchema } from '../../../plugin/opencode-unity-lib/json-schema.js';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../schema/install-matrix.schema.json', import.meta.url), 'utf8'));
const MANIFEST_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../schema/install-manifest.schema.json', import.meta.url), 'utf8'));
const validate = compileSchema(SCHEMA);

const SHELLS = Object.freeze([
  { id: 'powershell', os: 'win32', title: 'Windows - PowerShell 7 or Windows PowerShell 5.1', comment: '#', quote: 'single', cd: 'Set-Location -LiteralPath', forbid: ['&&', '||'], note: '5.1 has no && or ||' },
  { id: 'cmd', os: 'win32', title: 'Windows - Command Prompt', comment: 'REM', quote: 'double', cd: 'cd /d', forbid: ["'"] },
  { id: 'zsh', os: 'darwin', title: 'macOS - zsh', comment: '#', quote: 'double', cd: 'cd', forbid: ['set -e', '~"'] },
  { id: 'bash', os: 'linux', title: 'Linux - bash', comment: '#', quote: 'double', cd: 'cd', forbid: ['set -e', '~"'] },
]);

/**
 * @param {string} command
 * @returns {Record<string, string>}
 */
function everyShell(command) {
  return { powershell: command, cmd: command, zsh: command, bash: command };
}

/** The read-only step the amendment shows as its example. */
const CHECK_NODE = Object.freeze({
  id: 'check-node',
  phase: 'prerequisite',
  readOnly: true,
  title: 'Check Node.js',
  why: 'opencode-unity needs Node 22 or newer; it has no runtime dependencies.',
  expect: 'v22.0.0 or newer',
  commands: everyShell('node --version'),
  onFail: {
    all: 'Install Node 22+ from https://nodejs.org/en/download',
    zsh: 'brew install node@22   # keg-only: add its bin to PATH',
    bash: "Use your distribution's Node 22 package or a user-level version manager",
  },
  evidence: ['119'],
});

/** A step that writes: persistent, with its manifest kinds and an exact pin. */
const INSTALL_CLI = Object.freeze({
  id: 'install-cli',
  phase: 'install',
  readOnly: false,
  persistent: true,
  manifestKinds: ['npmGlobal'],
  pin: 'exact',
  title: 'Install opencode-unity and OpenCode',
  why: 'Installs the two command-line tools this product runs on.',
  expect: null,
  commands: everyShell('npm install --global opencode-unity@0.1.0 opencode-ai@1.18.31'),
});

/** A step that applies to three shells and says why not the fourth. */
const PRINT_SERVICE_OVERRIDE = Object.freeze({
  id: 'ollama-service-env',
  phase: 'configure',
  readOnly: true,
  title: 'Show the Ollama service override',
  why: 'Prints the service override for Ollama and changes nothing.',
  expect: 'The override text',
  commands: {
    powershell: { notApplicable: 'Windows runs Ollama as an application, not a service.' },
    cmd: { notApplicable: 'Windows runs Ollama as an application, not a service.' },
    zsh: 'opencode-unity setup --print-env',
    bash: 'opencode-unity setup --print-env',
  },
});

/**
 * @param {Array<Record<string, unknown>>} steps
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function matrix(steps, overrides = {}) {
  return {
    schemaVersion: 1,
    cliVersion: '0.1.0',
    pins: { opencodeUnity: 'latest', opencode: '1.18.31', ollama: '0.34.1', node: '>=22', modelBase: 'qwen3-coder:30b', modelDownloadGiB: 19 },
    shells: SHELLS,
    steps,
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} step
 * @returns {string}
 */
function stepProblems(step) {
  return validate(matrix([step])).map((problem) => `${problem.path} ${problem.message}`).join('\n');
}

describe('install-matrix.schema.json', () => {
  it('compiles with the repository validator, so no rule is a silently skipped keyword', () => {
    assert.equal(typeof validate, 'function');
    assert.equal(SCHEMA.properties.schemaVersion.const, 1);
  });

  it('accepts the amendment example, a writing step and a step that does not apply to every shell', () => {
    assert.deepEqual(validate(matrix([CHECK_NODE, INSTALL_CLI, PRINT_SERVICE_OVERRIDE])), []);
  });

  it('accepts an exact opencode-unity pin as well as latest', () => {
    assert.deepEqual(validate(matrix([CHECK_NODE], { pins: { ...matrix([]).pins, opencodeUnity: '0.1.0' } })), []);
  });

  it('refuses a step that leaves a shell out without saying why', () => {
    const { bash, ...threeShells } = CHECK_NODE.commands;
    assert.match(stepProblems({ ...CHECK_NODE, commands: threeShells }), /steps\[0\]\.commands\.bash is required/);
    assert.match(stepProblems({ ...CHECK_NODE, commands: { ...threeShells, bash: { notApplicable: '' } } }), /steps\[0\]\.commands\.bash/);
    assert.match(stepProblems({ ...CHECK_NODE, commands: { ...CHECK_NODE.commands, fish: 'node --version' } }), /commands\.fish is not a known key/);
  });

  it('refuses a command a human cannot paste as one line', () => {
    for (const command of ['node --version\nnpm --version', 'npm install --global \\', 'npm install --global `', 'npm install ^', '']) {
      assert.match(stepProblems({ ...CHECK_NODE, commands: everyShell(command) }), /steps\[0\]\.commands\.powershell/, JSON.stringify(command));
    }
  });

  it('requires a persistent flag, manifest kinds and an exact pin on a step that writes (D-M28, D-M31)', () => {
    const { persistent, ...noPersistent } = INSTALL_CLI;
    assert.match(stepProblems(noPersistent), /steps\[0\]\.persistent is required/);
    const { manifestKinds, ...noKinds } = INSTALL_CLI;
    assert.match(stepProblems(noKinds), /steps\[0\]\.manifestKinds is required/);
    assert.match(stepProblems({ ...INSTALL_CLI, pin: 'range' }), /steps\[0\]\.pin must be "exact"/);
    assert.match(stepProblems({ ...INSTALL_CLI, manifestKinds: [] }), /steps\[0\]\.manifestKinds must have at least 1 item/);
    assert.match(stepProblems({ ...INSTALL_CLI, manifestKinds: ['Npm Global'] }), /steps\[0\]\.manifestKinds\[0\] must match/);
  });

  it('refuses a read-only step that claims to write', () => {
    assert.match(stepProblems({ ...CHECK_NODE, persistent: true }), /steps\[0\]\.persistent must be false/);
    assert.match(stepProblems({ ...CHECK_NODE, manifestKinds: ['file'] }), /steps\[0\]\.manifestKinds is not allowed/);
    assert.deepEqual(validate(matrix([{ ...CHECK_NODE, persistent: false, pin: 'range' }])), [], 'a read-only step may name a range, such as a version check');
  });

  it('requires the vendor page on a privileged step, and nowhere else (CP-D15)', () => {
    assert.match(stepProblems({ ...INSTALL_CLI, privileged: true }), /steps\[0\]\.vendorDocumented is required/);
    assert.match(stepProblems({ ...INSTALL_CLI, privileged: true, vendorDocumented: 'http://vendor.example.test/docs' }), /vendorDocumented must match/);
    assert.deepEqual(validate(matrix([{ ...INSTALL_CLI, privileged: true, vendorDocumented: 'https://vendor.example.test/docs/install' }])), []);
    assert.match(stepProblems({ ...INSTALL_CLI, vendorDocumented: 'https://vendor.example.test/docs/install' }), /steps\[0\]\.privileged is required/);
  });

  it('states expect explicitly, even when there is nothing to observe', () => {
    const { expect: omitted, ...noExpect } = CHECK_NODE;
    assert.match(stepProblems(noExpect), /steps\[0\]\.expect is required/);
    assert.deepEqual(validate(matrix([{ ...CHECK_NODE, expect: null }])), []);
  });

  it('keeps why to one sentence', () => {
    for (const why of ['Checks Node. Then checks npm.', 'Checks Node', 'Checks Node.\nThen npm.', '']) {
      assert.match(stepProblems({ ...CHECK_NODE, why }), /steps\[0\]\.why must match/, JSON.stringify(why));
    }
  });

  it('names the phase from its fixed list and the step id in lower-case words', () => {
    assert.match(stepProblems({ ...CHECK_NODE, phase: 'cleanup' }), /steps\[0\]\.phase must be one of/);
    assert.match(stepProblems({ ...CHECK_NODE, id: 'Check_Node' }), /steps\[0\]\.id must match/);
    assert.match(stepProblems({ ...CHECK_NODE, onFail: {} }), /steps\[0\]\.onFail\.all is required/);
    assert.match(stepProblems({ ...CHECK_NODE, retries: 2 }), /steps\[0\]\.retries is not a known key/);
  });

  it('checks the pins and the shell list', () => {
    const pins = /** @type {Record<string, unknown>} */ (matrix([]).pins);
    assert.notEqual(validate(matrix([CHECK_NODE], { pins: { ...pins, opencode: '^1.18.0' } })).length, 0);
    assert.notEqual(validate(matrix([CHECK_NODE], { pins: { ...pins, node: '22' } })).length, 0);
    assert.notEqual(validate(matrix([CHECK_NODE], { shells: SHELLS.slice(0, 3) })).length, 0);
    assert.notEqual(validate(matrix([CHECK_NODE], { shells: [...SHELLS.slice(0, 3), { ...SHELLS[3], id: 'fish' }] })).length, 0);
    assert.notEqual(validate(matrix([CHECK_NODE], { steps: [] })).length, 0);
  });

  it('accepts every kind the install manifest records as a manifest kind', () => {
    const kinds = MANIFEST_SCHEMA.$defs.entry.properties.kind.enum;
    assert.ok(kinds.length > 0);
    assert.deepEqual(validate(matrix([{ ...INSTALL_CLI, manifestKinds: kinds }])), []);
  });
});
