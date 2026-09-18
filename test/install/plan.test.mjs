// The setup plan (spec 14.1, 5.1; amendment 38.3, 38.11): the step table, the default answer of every
// item, and what --yes may and may not accept. Pure: no filesystem, no Ollama.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConsent, decideWithoutPrompt } from '../../src/cli/consent.js';
import { getHomePaths } from '../../src/core/paths.js';
import { loadPreset } from '../../src/core/presets.js';
import { resolveTier } from '../../src/core/platform.js';
import { SETUP_STEP_IDS, applyDecisions, buildSetupPlan, describeOperations, markSettledSteps, renderPlanText, toConsentItems } from '../../src/install/plan.js';
import { createPrintOnlyAdapter } from '../../src/install/user-env.js';
import { PassThrough } from 'node:stream';
import { createFakeUserEnv, platformFacts, preflightFacts } from './helpers.mjs';
import { withModelState } from '../../src/install/preflight.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\user\\AppData\\Local\\opencode-unity' : '/home/user/.local/share/opencode-unity';
const PATHS = getHomePaths(HOME, { platform: process.platform });
const PRESET = loadPreset('nvidia-24gb-qwen3-coder-30b-16k');

/**
 * @param {Partial<import('../../src/install/plan.js').SetupPlanInput> & { flags?: Partial<import('../../src/install/plan.js').SetupFlags> }} [overrides]
 * @returns {import('../../src/install/plan.js').SetupPlanInput}
 */
function input(overrides = {}) {
  const facts = platformFacts();
  const { flags, ...rest } = overrides;
  return {
    cliVersion: '0.1.0',
    platform: process.platform,
    platformBlock: ['Platform support'],
    tier: resolveTier('setup', facts),
    tierAcknowledged: false,
    paths: PATHS,
    preset: PRESET,
    presetStatus: 'reference-tested',
    files: {
      profileDir: PATHS.profile('0.1.0').dir,
      modelfilePath: `${PATHS.profile('0.1.0').dir}/Modelfile`,
      modelfile: 'FROM qwen3-coder:30b\n',
      profileAssets: { 'opencode.jsonc': '{}', 'agents/unity-code.md': '# agent' },
      configText: '{"schemaVersion":1}\n',
      pointerText: '{"version":"0.1.0","previous":null}\n',
      fragmentText: null,
    },
    preflight: withModelState(preflightFacts({ models: [] }), { base: 'qwen3-coder:30b', tag: 'ocu-qwen3-coder-30b-16k' }),
    flags: { noModel: false, ollamaEnv: false, terminal: false, experimental: false, host: [], ...flags },
    userEnv: createFakeUserEnv(),
    fragment: null,
    hostTargets: [],
    ...rest,
  };
}

describe('setup plan order', () => {
  it('follows the table of spec 14.1, and asks nothing about the platform on a full row', () => {
    const plan = buildSetupPlan(input());
    assert.deepEqual(plan.steps.map((step) => step.id), SETUP_STEP_IDS.filter((id) => id !== 'platform-acknowledge'));
  });

  it('puts the platform acknowledgement first on an experimental row', () => {
    const plan = buildSetupPlan(input({ tier: resolveTier('setup', platformFacts({ os: 'linux' })) }));
    assert.equal(plan.steps[0].id, 'platform-acknowledge');
    assert.equal(toConsentItems(plan)[0].id, 'platform-acknowledge');
  });

  it('starts the download before the profile render', () => {
    const ids = buildSetupPlan(input()).steps.map((step) => step.id);
    assert.ok(ids.indexOf('model-pull') < ids.indexOf('profile-render'));
  });

  it('renders the Modelfile in the step that runs ollama create', () => {
    const step = buildSetupPlan(input()).steps.find((candidate) => candidate.id === 'model-create');
    assert.deepEqual(step?.operations.map((operation) => operation.op), ['makeDir', 'writeFile', 'createModel']);
  });
});

describe('setup plan defaults', () => {
  it('recommends the download, the tag and the profile, and nothing else', () => {
    const items = toConsentItems(buildSetupPlan(input()));
    assert.deepEqual(
      items.map((item) => [item.id, item.recommended, item.preselected ?? false]),
      [
        ['model-pull', true, false],
        ['model-create', true, false],
        ['profile-render', true, false],
        ['ollama-env', false, false],
      ],
    );
  });

  it('lets --yes accept only the recommended items', () => {
    const decisions = decideWithoutPrompt(toConsentItems(buildSetupPlan(input())), { yes: true });
    assert.deepEqual(
      decisions.filter((decision) => decision.accepted).map((decision) => decision.id),
      ['model-pull', 'model-create', 'profile-render'],
    );
  });

  it('turns --ollama-env into a preselection that --yes then accepts', () => {
    const decisions = decideWithoutPrompt(toConsentItems(buildSetupPlan(input({ flags: { ollamaEnv: true } }))), { yes: true });
    assert.ok(decisions.find((decision) => decision.id === 'ollama-env')?.accepted);
  });

  it('never lets --yes acknowledge an experimental row', () => {
    const plan = buildSetupPlan(input({ tier: resolveTier('setup', platformFacts({ os: 'linux' })) }));
    const decisions = decideWithoutPrompt(toConsentItems(plan), { yes: true });
    assert.equal(decisions.find((decision) => decision.id === 'platform-acknowledge')?.accepted, false);
  });

  it('defaults the acknowledgement to No at the prompt, and a typed yes accepts it', async () => {
    const plan = buildSetupPlan(input({ tier: resolveTier('setup', platformFacts({ os: 'linux' })) }));
    const [item] = toConsentItems(plan);
    for (const [answer, expected] of /** @type {const} */ ([
      ['\n', false],
      ['y\n', true],
    ])) {
      const stdin = new PassThrough();
      stdin.end(answer);
      const consent = createConsent({ interactive: true, yes: false, getInput: () => stdin, prompts: new PassThrough() });
      const [decision] = await consent.request([item]);
      assert.equal(decision.accepted, expected);
    }
  });

  it('treats --experimental as the acknowledgement, so nothing is asked', () => {
    const plan = buildSetupPlan(input({ tier: resolveTier('setup', platformFacts({ os: 'linux' })), tierAcknowledged: true }));
    assert.equal(toConsentItems(plan).some((item) => item.id === 'platform-acknowledge'), false);
    assert.match(plan.steps[0].title, /acknowledged by --experimental/);
  });

  it('offers the OpenCode install only when it is missing, and warns on another version', () => {
    const missing = buildSetupPlan(input({ preflight: withModelState(preflightFacts({ opencode: 'missing' }), { base: 'x', tag: 'y' }) }));
    assert.equal(toConsentItems(missing)[0].id, 'opencode-install');
    const other = buildSetupPlan(input({ preflight: withModelState(preflightFacts({ opencode: 'other' }), { base: 'x', tag: 'y' }) }));
    assert.equal(toConsentItems(other).some((item) => item.id === 'opencode-install'), false);
    assert.match(other.warnings[0], /1\.17\.0 is installed/);
  });

  it('warns about an experimental preset without --experimental', () => {
    const plan = buildSetupPlan(input({ presetStatus: 'experimental' }));
    assert.match(plan.warnings[0], /is experimental on this platform/);
  });
});

describe('setup plan platform split', () => {
  it('prints the Ollama variables on Linux and writes nothing', () => {
    const plan = buildSetupPlan(input({ userEnv: createPrintOnlyAdapter() }));
    const step = plan.steps.find((candidate) => candidate.id === 'ollama-env');
    assert.equal(step?.nature, 'note');
    assert.deepEqual(step?.operations, []);
    assert.ok(step?.lines.includes('  Environment="OLLAMA_KV_CACHE_TYPE=q8_0"'), step?.lines.join('\n'));
    assert.ok(step?.lines.some((line) => line.startsWith('sudo systemctl edit ollama')));
  });

  it('records launchctl variables on macOS under their own kind', () => {
    const userEnv = { ...createFakeUserEnv(), kind: /** @type {const} */ ('launchctlEnv') };
    const step = buildSetupPlan(input({ userEnv })).steps.find((candidate) => candidate.id === 'ollama-env');
    assert.ok(step?.operations.every((operation) => operation.op === 'setEnv' && operation.kind === 'launchctlEnv'));
  });

  it('adds the fragment only when there is one to write, recommended', () => {
    const files = { ...input().files, fragmentText: '{"profiles":[]}\n' };
    const plan = buildSetupPlan(input({ files, fragment: { path: 'C:\\x\\profiles.json' } }));
    const item = toConsentItems(plan).find((candidate) => candidate.id === 'terminal-fragment');
    assert.equal(item?.recommended, true);
    const none = buildSetupPlan(input()).steps.find((candidate) => candidate.id === 'terminal-fragment');
    assert.equal(none?.nature, 'note');
  });

  it('names the planned host command and the preview host files instead of writing a host integration itself', () => {
    const step = buildSetupPlan(input({ hostTargets: ['claude', 'codex'] })).steps.find((candidate) => candidate.id === 'host-install');
    assert.equal(step?.nature, 'note');
    assert.deepEqual(step?.operations, []);
    assert.equal(step?.lines[0], 'Planned: opencode-unity host install --host claude,codex. The host command group is not in this preview.');
    assert.match(step?.lines[1] ?? '', /hosts\/ folder of this package/);
  });

  it('skips both model steps with --no-model', () => {
    const items = toConsentItems(buildSetupPlan(input({ flags: { noModel: true } })));
    assert.deepEqual(items.map((item) => item.id), ['profile-render', 'ollama-env']);
  });

  it('never writes config.json when it exists already', () => {
    const files = { ...input().files, configText: null };
    const step = buildSetupPlan(input({ files })).steps.find((candidate) => candidate.id === 'profile-render');
    assert.equal(step?.operations.some((operation) => operation.op === 'writeFile' && operation.path === PATHS.config), false);
  });
});

describe('setup plan decisions and settling', () => {
  it('copies each decision onto its step', () => {
    const plan = applyDecisions(buildSetupPlan(input()), [{ id: 'profile-render', accepted: true, source: 'answer' }]);
    assert.equal(plan.steps.find((step) => step.id === 'profile-render')?.accepted, true);
    assert.equal(plan.steps.find((step) => step.id === 'model-pull')?.accepted, false);
  });

  it('settles a step whose files and models are already in place, and never re-creates the tag', async () => {
    const plan = buildSetupPlan(input());
    const settled = await markSettledSteps(plan, {
      fileDigest: async () => 'same',
      digest: () => 'same',
      hasModel: async () => true,
      readEnv: async () => null,
    });
    const create = settled.steps.find((step) => step.id === 'model-create');
    assert.equal(create?.accepted, true);
    assert.ok(create?.operations.some((operation) => operation.op === 'createModel' && operation.alreadyInstalled === true));
    assert.deepEqual(toConsentItems(settled).map((item) => item.id), ['ollama-env']);
  });

  it('does not settle a step with one file out of date', async () => {
    const plan = buildSetupPlan(input());
    const settled = await markSettledSteps(plan, {
      fileDigest: async (target) => (target.endsWith('unity-code.md') ? 'old' : 'same'),
      digest: () => 'same',
      hasModel: async () => true,
      readEnv: async () => null,
    });
    assert.equal(settled.steps.find((step) => step.id === 'profile-render')?.accepted, false);
  });

  it('settles the environment only when every variable already holds its value', async () => {
    const values = /** @type {Record<string, string>} */ (PRESET.ollamaServerEnv);
    const probe = { fileDigest: async () => null, digest: () => 'x', hasModel: async () => false };
    const all = await markSettledSteps(buildSetupPlan(input()), { ...probe, readEnv: async (name) => values[name] });
    const some = await markSettledSteps(buildSetupPlan(input()), { ...probe, readEnv: async (name) => (name === 'OLLAMA_KEEP_ALIVE' ? null : values[name]) });
    assert.equal(all.steps.find((step) => step.id === 'ollama-env')?.accepted, true);
    assert.equal(some.steps.find((step) => step.id === 'ollama-env')?.accepted, false);
  });

  it('settles config.json once it exists, whatever it holds', async () => {
    const plan = buildSetupPlan(input());
    const settled = await markSettledSteps(plan, {
      fileDigest: async (target) => (target === PATHS.config ? 'user edited' : 'same'),
      digest: () => 'same',
      hasModel: async () => true,
      readEnv: async () => null,
    });
    assert.equal(settled.steps.find((step) => step.id === 'profile-render')?.accepted, true);
  });

  it('never settles a global npm install', async () => {
    const plan = buildSetupPlan(input({ preflight: withModelState(preflightFacts({ opencode: 'missing' }), { base: 'x', tag: 'y' }) }));
    const settled = await markSettledSteps(plan, { fileDigest: async () => 'x', digest: () => 'x', hasModel: async () => true, readEnv: async () => null });
    assert.equal(settled.steps.find((step) => step.id === 'opencode-install')?.accepted, false);
  });
});

describe('setup plan text', () => {
  it('prints the platform block first, then every step with what it changes', () => {
    const lines = renderPlanText(buildSetupPlan(input()));
    assert.equal(lines[0], 'Platform support');
    assert.ok(lines.includes('+ Download the base model qwen3-coder:30b'));
    assert.ok(lines.some((line) => /^\? Set 5 Ollama server variables/.test(line)));
    assert.ok(lines.some((line) => /only when it does not exist/.test(line)));
  });

  it('describes every operation in one line', () => {
    assert.deepEqual(
      describeOperations([
        { op: 'makeDir', path: '/a' },
        { op: 'setEnv', kind: 'userEnv', name: 'A', value: '1' },
        { op: 'pullModel', model: 'm', alreadyInstalled: true },
        { op: 'pullModel', model: 'm', alreadyInstalled: false },
        { op: 'createModel', tag: 't', modelfilePath: '/M', baseModel: 'm' },
        { op: 'installNpmGlobal', name: 'opencode-ai', version: '1.18.31' },
        /** @type {any} */ ({ op: 'mystery' }),
      ]),
      ['create /a', 'set A=1', 'record m (already present)', 'download m', 'create model tag t', 'npm install --global opencode-ai@1.18.31', 'unknown operation'],
    );
  });
});
