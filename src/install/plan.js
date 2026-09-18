// The setup plan: spec 14.1 item by item, as data. Building it is pure - every file is already rendered
// and every path already resolved by the caller - so the same plan can be printed by `--dry-run`, turned
// into consent questions, and executed, without any of the three disagreeing about what setup does.
//
// Order matters twice. The platform block and its acknowledgement come before every other question
// (amendment 38.3), and the model pull is started before the profile render so a 19 GiB download overlaps
// the cheap steps (spec 14.1 item 4).
import { getPathApi } from '../core/paths.js';
import { createdBy } from './manifest.js';
import { needsTierAcknowledgement } from './platform-block.js';
import { renderEnvInstructions } from './user-env.js';

/** A 64-character placeholder; apply replaces it with the digest of what it actually wrote. */
const PLACEHOLDER_SHA = '0'.repeat(64);

/** Ids in the order they are asked and applied. Tests and docs name steps by these. */
export const SETUP_STEP_IDS = Object.freeze([
  'platform-acknowledge',
  'preflight',
  'opencode-install',
  'ollama-check',
  'preset',
  'model-pull',
  'model-create',
  'profile-render',
  'ollama-env',
  'terminal-fragment',
  'host-install',
  'sysmem-tip',
  'next-steps',
]);

/**
 * @typedef {object} PlanStep
 * @property {string} id
 * @property {string} title
 * @property {string} [detail]         Size, duration, paths, or how to undo it.
 * @property {'consent'|'note'} nature A note is printed and never asked about.
 * @property {boolean} recommended     The default answer (spec 5.1).
 * @property {boolean} [preselected]   A flag asked for this item.
 * @property {boolean} accepted        Set by applyDecisions; a note is accepted when it has work.
 * @property {import('./apply.js').Operation[]} operations
 * @property {string[]} lines          Extra text this step prints, such as a command to run by hand.
 */

/**
 * @typedef {object} SetupPlan
 * @property {PlanStep[]} steps
 * @property {string[]} platformBlock
 * @property {string[]} warnings
 */

/**
 * Everything the plan needs, already resolved. Keeping the I/O outside is what makes every branch here
 * testable without a filesystem, an Ollama server or a registry.
 * @typedef {object} SetupPlanInput
 * @property {string} cliVersion
 * @property {NodeJS.Platform} platform
 * @property {string[]} platformBlock
 * @property {import('../core/platform.js').TierResult} tier
 * @property {boolean} tierAcknowledged        `--experimental` already acknowledges it.
 * @property {import('../core/paths.js').HomePaths} paths
 * @property {import('../core/presets.js').Preset} preset
 * @property {string} presetStatus
 * @property {InstallFiles} files
 * @property {Preflight} preflight
 * @property {SetupFlags} flags
 * @property {import('./user-env.js').UserEnvAdapter} userEnv
 * @property {{ path: string } | null} fragment   Null when there is no fragment to write.
 * @property {readonly string[]} hostTargets
 */

/**
 * @typedef {object} InstallFiles
 * @property {string} profileDir
 * @property {string} modelfilePath
 * @property {string} modelfile
 * @property {Record<string, string | Uint8Array>} profileAssets  Path relative to the profile dir -> content.
 * @property {string | null} configText        Null when config.json must not be written.
 * @property {string} pointerText
 * @property {string | null} fragmentText
 */

/**
 * @typedef {object} Preflight
 * @property {string} node
 * @property {{ state: 'missing'|'tested'|'other'|'unreadable', version: string | null, tested: string }} opencode
 * @property {{ state: 'down'|'tested'|'older'|'newer', version: string | null, tested: string }} ollama
 * @property {{ name: string | null, totalVramMiB: number | null }} gpu
 * @property {boolean} windowsTerminal
 * @property {boolean} dotnetSdk
 * @property {boolean} baseModelInstalled
 * @property {boolean} taggedModelInstalled
 */

/**
 * @typedef {object} SetupFlags
 * @property {boolean} noModel
 * @property {boolean} ollamaEnv
 * @property {boolean} terminal
 * @property {boolean} experimental
 * @property {readonly string[]} host
 */

/**
 * @param {SetupPlanInput} input
 * @returns {SetupPlan}
 */
export function buildSetupPlan(input) {
  /** @type {PlanStep[]} */
  const steps = [];
  /** @type {string[]} */
  const warnings = [];
  const by = createdBy('setup', input.cliVersion);

  if (needsTierAcknowledgement(input.tier)) steps.push(buildAcknowledgeStep(input));
  steps.push(buildPreflightStep(input));
  steps.push(buildOpencodeStep(input, warnings));
  steps.push(buildOllamaCheckStep(input));
  steps.push(buildPresetStep(input, warnings));
  steps.push(buildModelPullStep(input));
  steps.push(buildModelCreateStep(input, by));
  steps.push(buildProfileStep(input, by));
  steps.push(buildEnvStep(input));
  steps.push(buildFragmentStep(input, by));
  steps.push(buildHostStep(input));
  steps.push(buildSysmemStep(input));
  steps.push(buildNextStepsStep());

  return { steps, platformBlock: input.platformBlock, warnings };
}

/**
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildAcknowledgeStep(input) {
  const needed = !input.tierAcknowledged;
  return {
    id: 'platform-acknowledge',
    // Not a persistent change, so it carries no operation; it is a question that gates the rest.
    title: needed ? 'Continue on an experimental platform row' : 'Experimental platform row, acknowledged by --experimental',
    detail: input.tier.message ?? `${input.tier.rowLabel} is experimental: it is not covered by the reference measurements.`,
    nature: needed ? 'consent' : 'note',
    // Never recommended, which is also what keeps --yes from answering it (amendment 38.3).
    recommended: false,
    accepted: !needed,
    operations: [],
    lines: [],
  };
}

/**
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildPreflightStep(input) {
  const { preflight } = input;
  const lines = [
    `node ${preflight.node}`,
    `opencode ${describeOpencode(preflight.opencode)}`,
    `ollama ${preflight.ollama.version ?? 'not reachable'}`,
    `gpu ${preflight.gpu.name ?? 'not detected'}${preflight.gpu.totalVramMiB ? ` (${preflight.gpu.totalVramMiB} MiB)` : ''}`,
  ];
  if (input.platform === 'win32') lines.push(`windows terminal ${preflight.windowsTerminal ? 'found' : 'not found'}`);
  lines.push(`.NET SDK ${preflight.dotnetSdk ? 'found' : 'not found (compile checks will be unavailable)'}`);
  return { id: 'preflight', title: 'Detected', nature: 'note', recommended: false, accepted: true, operations: [], lines };
}

/**
 * @param {SetupPlanInput} input
 * @param {string[]} warnings
 * @returns {PlanStep}
 */
function buildOpencodeStep(input, warnings) {
  const { opencode } = input.preflight;
  if (opencode.state === 'missing') {
    return {
      id: 'opencode-install',
      title: `Install OpenCode ${opencode.tested} globally`,
      detail: `npm install --global opencode-ai@${opencode.tested}. Undo: npm rm -g opencode-ai.`,
      nature: 'consent',
      recommended: true,
      accepted: false,
      operations: [{ op: 'installNpmGlobal', name: 'opencode-ai', version: opencode.tested }],
      lines: [],
    };
  }
  if (opencode.state === 'other') {
    warnings.push(`OpenCode ${opencode.version} is installed and ${opencode.tested} is the tested version; this setup is experimental until they match.`);
    return {
      id: 'opencode-install',
      title: 'OpenCode is installed at another version',
      nature: 'note',
      recommended: false,
      accepted: true,
      operations: [],
      lines: [`Your version stays as it is. To match the tested one: npm install --global opencode-ai@${opencode.tested}`],
    };
  }
  if (opencode.state === 'unreadable') {
    // Installed, but `--version` could not be run or read. A failed probe is never a reason to install
    // over whatever the user has (spec 14.1, 5.1), so this is a note, not a consent item.
    warnings.push(`OpenCode is installed but its version could not be read; this setup is experimental until 'opencode --version' prints ${opencode.tested}.`);
    return {
      id: 'opencode-install',
      title: 'OpenCode is installed, but its version could not be read',
      nature: 'note',
      recommended: false,
      accepted: true,
      operations: [],
      lines: [`Your install stays as it is. To install the tested version: npm install --global opencode-ai@${opencode.tested}`],
    };
  }
  return { id: 'opencode-install', title: `OpenCode ${opencode.version} is installed`, nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
}

/**
 * Never downloads an installer, on any platform (spec 14.1 item 2 and safety rule S13).
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildOllamaCheckStep(input) {
  const { ollama } = input.preflight;
  if (ollama.state === 'tested') return { id: 'ollama-check', title: `Ollama ${ollama.version} answers`, nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  const lines =
    ollama.state === 'down'
      ? ['Ollama did not answer. Start it, or install it from https://ollama.com/download, then run setup again.']
      : [`Ollama ${ollama.version} is outside the tested set (${ollama.tested}). Nothing is downloaded for you; see https://ollama.com/download.`];
  return { id: 'ollama-check', title: 'Ollama', nature: 'note', recommended: false, accepted: true, operations: [], lines };
}

/**
 * @param {SetupPlanInput} input
 * @param {string[]} warnings
 * @returns {PlanStep}
 */
function buildPresetStep(input, warnings) {
  const { preset, presetStatus } = input;
  if (presetStatus === 'experimental' && !input.flags.experimental) {
    warnings.push(`Preset '${preset.id}' is experimental on this platform; re-run with --experimental to use it.`);
  }
  const vram = input.preflight.gpu.totalVramMiB;
  return {
    id: 'preset',
    title: `Preset ${preset.id} (${presetStatus})`,
    nature: 'note',
    recommended: false,
    accepted: true,
    operations: [],
    lines: [
      `model ${preset.model.base} at ${preset.model.numCtx} tokens, tag ${preset.model.tag}`,
      vram === null ? 'VRAM was not measured, so this is the configured preset, not a recommendation.' : `chosen for ${vram} MiB of total VRAM`,
    ],
  };
}

/**
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildModelPullStep(input) {
  const { preset, preflight, flags } = input;
  if (flags.noModel) return { id: 'model-pull', title: 'Model download skipped (--no-model)', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  const already = preflight.baseModelInstalled;
  return {
    id: 'model-pull',
    title: already ? `Record the base model ${preset.model.base}` : `Download the base model ${preset.model.base}`,
    detail: already ? 'It is already in your Ollama store, so nothing is downloaded.' : `About ${preset.model.downloadGiB} GiB. It stays in your Ollama store; uninstall removes it only with --remove-base-model.`,
    nature: 'consent',
    recommended: true,
    accepted: false,
    operations: [{ op: 'pullModel', model: /** @type {string} */ (preset.model.base), alreadyInstalled: already }],
    lines: [],
  };
}

/**
 * The Modelfile is rendered here rather than with the rest of the profile, because `ollama create` reads
 * it from disk in the same step (spec 14.1 item 5).
 * @param {SetupPlanInput} input
 * @param {string} by
 * @returns {PlanStep}
 */
function buildModelCreateStep(input, by) {
  const { preset, files, flags } = input;
  if (flags.noModel) return { id: 'model-create', title: 'Model tag skipped (--no-model)', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  return {
    id: 'model-create',
    title: `Create the model tag ${preset.model.tag}`,
    detail: `From a Modelfile with num_ctx ${preset.model.numCtx} and the preset's sampling. Undo: ollama rm ${preset.model.tag}.`,
    nature: 'consent',
    recommended: true,
    accepted: false,
    operations: [
      { op: 'makeDir', path: files.profileDir, entry: { kind: 'dir', path: files.profileDir, createdBy: by } },
      { op: 'writeFile', path: files.modelfilePath, content: files.modelfile, onConflict: 'backup', entry: { kind: 'file', path: files.modelfilePath, sha256: PLACEHOLDER_SHA, createdBy: by } },
      { op: 'createModel', tag: /** @type {string} */ (preset.model.tag), modelfilePath: files.modelfilePath, baseModel: /** @type {string} */ (preset.model.base) },
    ],
    lines: [],
  };
}

/**
 * @param {SetupPlanInput} input
 * @param {string} by
 * @returns {PlanStep}
 */
function buildProfileStep(input, by) {
  const { paths, files, cliVersion } = input;
  const api = getPathApi(input.platform);
  /** @type {import('./apply.js').Operation[]} */
  const operations = [
    { op: 'makeDir', path: files.profileDir, entry: { kind: 'dir', path: files.profileDir, createdBy: by } },
    { op: 'makeDir', path: paths.xdgConfig, entry: { kind: 'dir', path: paths.xdgConfig, createdBy: by } },
  ];
  for (const [relative, content] of Object.entries(files.profileAssets)) {
    const target = api.join(files.profileDir, ...relative.split('/'));
    operations.push({ op: 'writeFile', path: target, content, onConflict: 'backup', entry: { kind: 'file', path: target, sha256: PLACEHOLDER_SHA, createdBy: by } });
  }
  if (files.configText !== null) {
    // Only when absent (spec 14.1 item 6): an existing config.json is the user's and is never replaced.
    operations.push({ op: 'writeFile', path: paths.config, content: files.configText, onConflict: 'skip', entry: { kind: 'file', path: paths.config, sha256: PLACEHOLDER_SHA, createdBy: by } });
  }
  operations.push({ op: 'writeFile', path: paths.profileCurrent, content: files.pointerText, onConflict: 'backup', entry: { kind: 'file', path: paths.profileCurrent, sha256: PLACEHOLDER_SHA, createdBy: by } });
  return {
    id: 'profile-render',
    title: `Write the clean-room profile for ${cliVersion}`,
    detail: `${files.profileDir} and ${paths.xdgConfig}. Nothing outside ${paths.home} is touched, and your own OpenCode configuration is not read during a session.`,
    nature: 'consent',
    recommended: true,
    accepted: false,
    operations,
    lines: [],
  };
}

/**
 * Item 7 of spec 14.1, with the platform split of amendment 38.11: written on Windows and macOS, printed
 * on Linux because the Ollama service reads its environment from a unit file the package manager owns.
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildEnvStep(input) {
  const values = /** @type {Record<string, string>} */ (input.preset.ollamaServerEnv ?? {});
  const names = Object.keys(values);
  if (names.length === 0) return { id: 'ollama-env', title: 'No Ollama server environment to set', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  if (input.userEnv.kind === 'print') {
    return {
      id: 'ollama-env',
      title: 'Ollama server environment (printed, not written)',
      nature: 'note',
      recommended: false,
      accepted: true,
      operations: [],
      // The print-only adapter is the Linux one (CP-D15), so the instructions are a systemd drop-in.
      lines: [`This platform's Ollama service owns its environment, so setup changes nothing. To set it yourself:`, ...renderEnvInstructions(values, 'linux')],
    };
  }
  return {
    id: 'ollama-env',
    title: `Set ${names.length} Ollama server variables (${names.join(', ')})`,
    detail: `In ${input.userEnv.scope}. Restart Ollama afterwards for them to take effect; uninstall restores the previous values.`,
    nature: 'consent',
    // Environment changes default to No (spec 5.1); only --ollama-env preselects them.
    recommended: false,
    preselected: input.flags.ollamaEnv,
    accepted: false,
    operations: names.map((name) => ({ op: 'setEnv', kind: /** @type {'userEnv'|'launchctlEnv'} */ (input.userEnv.kind), name, value: values[name] })),
    lines: [],
  };
}

/**
 * @param {SetupPlanInput} input
 * @param {string} by
 * @returns {PlanStep}
 */
function buildFragmentStep(input, by) {
  const { fragment, files } = input;
  if (fragment === null || files.fragmentText === null) {
    return { id: 'terminal-fragment', title: 'No Windows Terminal fragment for this machine', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  }
  return {
    id: 'terminal-fragment',
    title: 'Add a Windows Terminal profile per initialized project',
    detail: `${fragment.path}. A fragment file of our own; your settings.json is never opened.`,
    nature: 'consent',
    recommended: true,
    preselected: input.flags.terminal,
    accepted: false,
    operations: [
      { op: 'writeFile', path: fragment.path, content: files.fragmentText, onConflict: 'backup', entry: { kind: 'wtFragment', path: fragment.path, sha256: PLACEHOLDER_SHA, createdBy: by } },
    ],
    lines: [],
  };
}

/**
 * The `host` command group owns the host files, the settings merge and the permission printers. Until it
 * ships, setup names the planned command and points at the preview host files instead of writing half
 * of a host integration here.
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildHostStep(input) {
  if (input.hostTargets.length === 0) return { id: 'host-install', title: 'No host integration requested', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  return {
    id: 'host-install',
    title: `Host integration for ${input.hostTargets.join(', ')}`,
    nature: 'note',
    recommended: false,
    accepted: true,
    operations: [],
    lines: [
      `Planned: opencode-unity host install --host ${input.hostTargets.join(',')}. The host command group is not in this preview.`,
      'For now, copy the preview host files from the hosts/ folder of this package by hand; the README shows the command for each tool.',
    ],
  };
}

/**
 * @param {SetupPlanInput} input
 * @returns {PlanStep}
 */
function buildSysmemStep(input) {
  if (input.platform !== 'win32' || input.preflight.gpu.name === null) {
    return { id: 'sysmem-tip', title: 'No driver tip for this machine', nature: 'note', recommended: false, accepted: true, operations: [], lines: [] };
  }
  return {
    id: 'sysmem-tip',
    title: 'Optional driver setting (documentation only)',
    nature: 'note',
    recommended: false,
    accepted: true,
    operations: [],
    lines: [
      "NVIDIA Control Panel, Manage 3D settings, program settings for Ollama's llama-server program:",
      '  CUDA - Sysmem Fallback Policy: Prefer No Sysmem Fallback',
      'Its effect on hangs is unverified, and setup changes no driver setting.',
    ],
  };
}

/**
 * @returns {PlanStep}
 */
function buildNextStepsStep() {
  return {
    id: 'next-steps',
    title: 'Next',
    nature: 'note',
    recommended: false,
    accepted: true,
    operations: [],
    lines: ['opencode-unity doctor --profile', 'cd <your Unity project>', 'opencode-unity init', 'opencode-unity start'],
  };
}

/**
 * The questions to ask, in order. A step with nothing left to do is not asked about, which is what makes
 * a second `setup` on an unchanged machine silent.
 * @param {SetupPlan} plan
 * @returns {import('../cli/consent.js').ConsentItem[]}
 */
export function toConsentItems(plan) {
  return plan.steps
    .filter((step) => step.nature === 'consent' && !step.accepted)
    .map((step) => ({ id: step.id, title: step.title, detail: step.detail, recommended: step.recommended, preselected: step.preselected }));
}

/**
 * @param {SetupPlan} plan
 * @param {readonly import('../cli/consent.js').ConsentDecision[]} decisions
 * @returns {SetupPlan}
 */
export function applyDecisions(plan, decisions) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  return {
    ...plan,
    steps: plan.steps.map((step) => (byId.has(step.id) ? { ...step, accepted: /** @type {import('../cli/consent.js').ConsentDecision} */ (byId.get(step.id)).accepted } : step)),
  };
}

/**
 * Marks consent steps whose work is already done, so a re-run asks nothing and changes nothing. A step is
 * settled only when every one of its operations is settled.
 * @param {SetupPlan} plan
 * @param {{ fileDigest: (path: string) => Promise<string | null>, hasModel: (name: string) => Promise<boolean>, readEnv: (name: string) => Promise<string | null>, digest: (content: string | Uint8Array) => string }} probe
 * @returns {Promise<SetupPlan>}
 */
export async function markSettledSteps(plan, probe) {
  /** @type {PlanStep[]} */
  const steps = [];
  for (const step of plan.steps) {
    if (step.nature !== 'consent' || step.operations.length === 0) {
      steps.push(step);
      continue;
    }
    const settled = await isStepSettled(step, probe);
    steps.push(settled ? settleStep(step) : step);
  }
  return { ...plan, steps };
}

/**
 * A settled step still runs, so its manifest entries are refreshed, but none of its operations may redo
 * outside work: a tag built from an identical Modelfile is not created a second time.
 * @param {PlanStep} step
 * @returns {PlanStep}
 */
function settleStep(step) {
  return {
    ...step,
    accepted: true,
    lines: [...step.lines, 'already done'],
    operations: step.operations.map((operation) => (operation.op === 'createModel' ? { ...operation, alreadyInstalled: true } : operation)),
  };
}

/**
 * @param {PlanStep} step
 * @param {{ fileDigest: (path: string) => Promise<string | null>, hasModel: (name: string) => Promise<boolean>, readEnv: (name: string) => Promise<string | null>, digest: (content: string | Uint8Array) => string }} probe
 * @returns {Promise<boolean>}
 */
async function isStepSettled(step, probe) {
  for (const operation of step.operations) {
    switch (operation.op) {
      case 'makeDir':
        break;
      case 'writeFile': {
        const current = await probe.fileDigest(operation.path);
        if (operation.onConflict === 'skip') {
          if (current === null) return false;
          break;
        }
        if (current !== probe.digest(operation.content)) return false;
        break;
      }
      case 'setEnv':
        if ((await probe.readEnv(operation.name)) !== operation.value) return false;
        break;
      case 'pullModel':
        if (!(await probe.hasModel(operation.model))) return false;
        break;
      case 'createModel':
        if (!(await probe.hasModel(operation.tag))) return false;
        break;
      case 'installNpmGlobal':
        return false;
      default:
        return false;
    }
  }
  return true;
}

/**
 * The `--dry-run` text: the platform block, then every step with what it would change.
 * @param {SetupPlan} plan
 * @returns {string[]}
 */
export function renderPlanText(plan) {
  /** @type {string[]} */
  const lines = [...plan.platformBlock, ''];
  for (const step of plan.steps) {
    const marker = step.nature === 'note' ? '-' : step.recommended || step.preselected ? '+' : '?';
    lines.push(`${marker} ${step.title}`);
    if (step.detail) lines.push(`    ${step.detail}`);
    for (const line of step.lines) lines.push(`    ${line}`);
    for (const line of describeOperations(step.operations)) lines.push(`    ${line}`);
  }
  return lines;
}

/**
 * @param {readonly import('./apply.js').Operation[]} operations
 * @returns {string[]}
 */
export function describeOperations(operations) {
  return operations.map((operation) => {
    switch (operation.op) {
      case 'writeFile':
        return `write ${operation.path}${operation.onConflict === 'skip' ? ' (only when it does not exist)' : ''}`;
      case 'makeDir':
        return `create ${operation.path}`;
      case 'setEnv':
        return `set ${operation.name}=${operation.value}`;
      case 'pullModel':
        return operation.alreadyInstalled ? `record ${operation.model} (already present)` : `download ${operation.model}`;
      case 'createModel':
        return `create model tag ${operation.tag}`;
      case 'installNpmGlobal':
        return `npm install --global ${operation.name}@${operation.version}`;
      default:
        return 'unknown operation';
    }
  });
}

/**
 * @param {Preflight['opencode']} opencode
 * @returns {string}
 */
function describeOpencode(opencode) {
  if (opencode.state === 'missing') return 'not installed';
  if (opencode.state === 'unreadable') return 'installed, version unreadable';
  return opencode.state === 'tested' ? `${opencode.version} (tested)` : `${opencode.version} (tested is ${opencode.tested})`;
}

