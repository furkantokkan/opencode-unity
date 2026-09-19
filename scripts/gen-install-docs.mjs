#!/usr/bin/env node
// Generate installation commands from the package/compat/preset pins and validate every product
// command against the actual registry. This script prints commands; it never runs an installer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSchema } from '../plugin/opencode-unity-lib/json-schema.js';
import { parseArgv } from '../src/cli/args.js';
import { DEFAULT_PRESET_ID } from '../src/core/config.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const OUTPUT_FILES = ['install/install-matrix.json', 'docs/install-matrix.md'];

export const SHELLS = [
  { id: 'powershell', os: 'win32', title: 'Windows PowerShell', comment: '#', quote: 'single', cd: 'Set-Location -LiteralPath', forbid: ['\r', '\n', '$(', '&&', '||'] },
  { id: 'cmd', os: 'win32', title: 'Windows Command Prompt', comment: 'REM', quote: 'double', cd: 'cd /d', forbid: ['\r', '\n', '%', '!', '&&', '||'] },
  { id: 'zsh', os: 'darwin', title: 'macOS zsh', comment: '#', quote: 'single', cd: 'cd --', forbid: ['\r', '\n', '$(', '&&', '||'], note: 'This page covers doctor, project facts and host skill files; it does not promise local model execution on macOS.' },
  { id: 'bash', os: 'linux', title: 'Linux bash', comment: '#', quote: 'single', cd: 'cd --', forbid: ['\r', '\n', '$(', '&&', '||'], note: 'This page covers doctor, project facts and host skill files; Linux GPU/runtime verification is separate.' },
];

/** @param {string} value @param {string} shell */
export function quoteLiteral(value, shell) {
  if (/[\r\n\0]/.test(value)) throw new Error('A command argument cannot contain a line break or NUL');
  if (shell === 'cmd') {
    if (/["%!^]/.test(value)) throw new Error('CMD literal contains an unsupported expansion or quoting character');
    return `"${value}"`;
  }
  if (shell === 'powershell') return `'${value.replaceAll("'", "''")}'`;
  if (shell === 'bash' || shell === 'zsh') return `'${value.replaceAll("'", "'\\''")}'`;
  throw new Error(`Unknown shell ${shell}`);
}

/** @param {string} root */
export async function readInstallInputs(root = ROOT) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const registry = await import(pathToFileURL(path.join(root, 'src/cli/registry.js')).href);
  return { packageJson: read('package.json'), compat: read('compat.json'), preset: read(`presets/${DEFAULT_PRESET_ID}.json`),
    schema: read('schema/install-matrix.schema.json'), commands: registry.COMMANDS, isAvailable: registry.isCommandAvailable };
}

/** @param {Awaited<ReturnType<typeof readInstallInputs>>} inputs */
export function buildInstallMatrix(inputs) {
  const { packageJson, compat, preset } = inputs;
  const version = packageJson.version;
  const repository = String(packageJson.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('The release repository must be an exact GitHub HTTPS repository');
  if (packageJson.engines.node !== `>=${compat.node.min}`) throw new Error('package.json and compat.json disagree on the Node minimum');
  const pins = { opencodeUnity: version, opencode: compat.opencode.tested, ollama: compat.ollama.tested,
    node: packageJson.engines.node, modelBase: preset.model.base, modelDownloadGiB: preset.model.downloadGiB };
  const tarball = `${repository}/releases/download/v${version}/${packageJson.name}-${version}.tgz`;
  const all = (render) => Object.fromEntries(SHELLS.map((shell) => [shell.id, render(shell.id)]));
  const windows = (line) => Object.fromEntries(SHELLS.map((shell) => [shell.id, shell.os === 'win32' ? line : { notApplicable: 'Full setup is documented here only for the Windows reference preset; use doctor and init on this platform.' }]));
  const readOnly = (id, phase, title, why, expect, commands, extra = {}) => ({ id, phase, title, why, readOnly: true, persistent: false, expect, commands, ...extra });
  const writes = (id, phase, title, why, expect, commands, manifestKinds, extra = {}) => ({ id, phase, title, why, readOnly: false, persistent: true, manifestKinds, expect, commands, ...extra });
  const steps = [
    readOnly('check-node', 'prerequisite', 'Check Node', 'Confirm that Node meets the package runtime requirement.', `Node ${pins.node}; install a supported Node release before continuing if needed`, all(() => 'node --version')),
    writes('install-cli', 'install', 'Install the exact CLI release', 'Install the versioned GitHub release tarball through npm.', `opencode-unity ${version}; npm owns this bootstrap installation, not the product install manifest`, all((shell) => `npm install -g ${quoteLiteral(tarball, shell)}`), ['npmGlobal'], { pin: 'exact', onFail: { all: 'Confirm the release asset exists and review the npm error; do not silently substitute another version.' } }),
    readOnly('check-cli', 'verify', 'Check the installed CLI', 'Confirm the executable matches this documented release.', version, all(() => 'opencode-unity --version')),
    readOnly('diagnose', 'verify', 'Run static diagnostics', 'Inspect prerequisites and platform support before configuring the runtime.', 'Review every finding; a missing prerequisite is a diagnostic result, not a successful runtime test', all(() => 'opencode-unity doctor --json')),
    readOnly('preview-setup', 'configure', 'Preview Windows setup', 'Review setup operations before approving persistent changes.', 'A dry-run plan with no files, environment changes, package installs or model pulls applied', windows('opencode-unity setup --dry-run')),
    writes('configure-runtime', 'configure', 'Configure Windows runtime', 'Configure the reference preset after reviewing each setup consent.', `Review the ${pins.modelDownloadGiB} GiB base-model download and each requested change before accepting`, windows('opencode-unity setup'), ['dir', 'file', 'userEnv', 'ollamaModel', 'npmGlobal']),
    writes('install-hosts', 'host', 'Install Claude and Codex skills', 'Install the managed delegation instructions into the selected hosts.', 'Host skill files match this CLI version; open a new host session after installation', all(() => 'opencode-unity host install --host claude,codex'), ['skillCopy'], { optional: true }),
    readOnly('verify-hosts', 'host', 'Verify host skills', 'Check host file ownership and content without replacing user edits.', 'Both selected host files are current; inspect missing or modified files before using them', all(() => 'opencode-unity host verify --host claude,codex'), { optional: true }),
    readOnly('preview-project', 'project', 'Preview project facts', 'Inspect the generated brief without changing the project or product home.', 'Facts are printed and no files are written; replace the example project path first', all((shell) => `opencode-unity init ${quoteLiteral('./Your project', shell)} --print`)),
    writes('initialize-project', 'project', 'Save project facts', 'Save the scanned project facts in the product home.', 'Facts and machine-local state exist under the product home; the repository is unchanged', all((shell) => `opencode-unity init ${quoteLiteral('./Your project', shell)}`), ['file']),
    writes('update-hosts', 'host', 'Update managed host skills', 'Refresh host templates while keeping modified files for review.', 'Current files verify; any preserved edit has a separate candidate to review', all(() => 'opencode-unity host update --host claude,codex'), ['skillCopy'], { optional: true }),
    readOnly('preview-removal', 'uninstall', 'Preview managed removal', 'Review which recorded changes uninstall can safely remove.', 'A removal plan with no persistent changes', all(() => 'opencode-unity uninstall --dry-run'), { optional: true }),
    writes('remove-hosts', 'uninstall', 'Remove managed host skills', 'Remove only unchanged recorded host skills after confirming the scoped plan.', 'Modified or unmanaged files are retained and reported', all(() => 'opencode-unity host uninstall --host claude,codex'), ['skillCopy'], { optional: true }),
  ];
  const matrix = { schemaVersion: 1, cliVersion: version, pins, shells: SHELLS, steps };
  validateInstallMatrix(matrix, inputs);
  return matrix;
}

/** @param {Record<string, any>} matrix @param {Awaited<ReturnType<typeof readInstallInputs>>} inputs */
export function validateInstallMatrix(matrix, inputs) {
  const errors = compileSchema(inputs.schema)(matrix);
  if (errors.length > 0) throw new Error(`Invalid install matrix: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
  if (matrix.cliVersion !== matrix.pins.opencodeUnity) throw new Error('CLI version and package pin disagree');
  const seen = new Set();
  for (const step of matrix.steps) {
    if (seen.has(step.id)) throw new Error(`Duplicate install step ${step.id}`);
    seen.add(step.id);
    for (const shell of matrix.shells) {
      const line = step.commands[shell.id];
      if (typeof line !== 'string') continue;
      if (shell.forbid.some((text) => line.includes(text))) throw new Error(`Forbidden shell syntax in ${step.id}/${shell.id}`);
      if (!line.startsWith('opencode-unity ')) continue;
      // The generated lines use only plain words and a single simple quoted path; this tokenizer is
      // deliberately narrower than a shell and is never used to run the resulting text.
      const argv = (line.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).slice(1).map((word) => /^["']/.test(word) ? word.slice(1, -1) : word);
      const parsed = parseArgv(argv, { commands: inputs.commands });
      if (parsed.kind === 'command' && !inputs.isAvailable(parsed.command)) throw new Error(`Command ${parsed.command.name} is not implemented`);
    }
  }
}

/** @param {Record<string, any>} matrix */
export function renderInstallReference(matrix) {
  const { pins } = matrix;
  const lines = ['<!-- Generated by scripts/gen-install-docs.mjs from package.json, compat.json, the default preset, and the CLI registry. Do not edit by hand. -->', '', '# Installation matrix', '',
    `This page targets **opencode-unity ${matrix.cliVersion}**. Commands are generated and checked against the shipped CLI registry.`, '',
    '| Input | Pin |', '|---|---|', `| CLI | ${pins.opencodeUnity} |`, `| OpenCode tested version | ${pins.opencode} |`, `| Ollama tested version | ${pins.ollama} |`, `| Node requirement | ${pins.node} |`, `| Base model | ${pins.modelBase} |`, `| Base model download | approximately ${pins.modelDownloadGiB} GiB |`, '',
    'The Windows setup path uses the reference preset. macOS and Linux examples cover diagnostics, facts and host skill files; they do not establish local-model runtime support. See the CLI support matrix for platform gates.', '',
    'Run one step at a time. Read-only steps write nothing. Persistent steps require your approval or the CLI consent flow; these examples do not use `--yes`. The initial npm bootstrap is owned by npm and is not recorded in the product install manifest. Its `npmGlobal` category describes its side effect; product uninstall does not remove the CLI package. Project facts are product-home data, while setup and host installation record their managed changes for removal.', '',
    'Replace `./Your project` with the intended project path. The quotes preserve paths containing spaces. Verify host files, then open a new Claude or Codex session to load the installed skill. Host verification checks files; it is not a local-model inference test.', ''];
  lines.push('## Step effects', '', '| Step | Effect | What to check |', '|---|---|---|');
  for (const step of matrix.steps) lines.push(`| ${step.title}${step.optional ? ' (optional)' : ''} | ${step.readOnly ? 'Read-only' : 'Persistent'} | ${step.expect ?? 'No observable result is specified.'} |`);
  lines.push('');
  const maintenance = new Set(['update-hosts', 'preview-removal', 'remove-hosts']);
  for (const shell of matrix.shells) {
    lines.push(`## ${shell.title}`, '');
    if (shell.note) lines.push(shell.note, '');
    lines.push(`\`\`\`${shell.id === 'powershell' ? 'powershell' : shell.id === 'cmd' ? 'bat' : 'sh'}`);
    for (const step of matrix.steps) {
      if (maintenance.has(step.id)) continue;
      const command = step.commands[shell.id];
      if (typeof command === 'string') lines.push(`${shell.comment} ${step.title}${step.optional ? ' (optional)' : ''}: ${step.readOnly ? 'read-only' : 'persistent change; approve before running'}`, command, '');
      else lines.push(`${shell.comment} ${step.title}: not applicable on this platform`, '');
    }
    lines.push('```', '');
  }
  lines.push('## Optional maintenance', '', 'These separate operations are not installation steps; run them only when updating or removing an existing installation. The command spelling is identical in all four shells.', '');
  for (const step of matrix.steps.filter((entry) => maintenance.has(entry.id))) lines.push(`### ${step.title}`, '', step.why, '', `**${step.readOnly ? 'Read-only' : 'Persistent change; review the consent prompt'}**.`, '', '```text', step.commands.powershell, '```', '');
  lines.push('If bootstrap fails, confirm the exact release asset exists and review the npm error; do not silently substitute a different version.', '');
  lines.push('## Regeneration', '', 'Run `node scripts/gen-install-docs.mjs` after changing version pins or command definitions. CI can run `node scripts/gen-install-docs.mjs --check`; it compares both generated files and writes nothing.', '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** @param {{ sourceRoot?: string, outputRoot?: string, check?: boolean, log?: (line: string) => void }} [options] */
export async function generateInstallArtifacts({ sourceRoot = ROOT, outputRoot = ROOT, check = false, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const matrix = buildInstallMatrix(await readInstallInputs(sourceRoot));
  const outputs = [`${JSON.stringify(matrix, null, 2)}\n`, renderInstallReference(matrix)];
  let stale = false;
  for (let index = 0; index < OUTPUT_FILES.length; index += 1) {
    const name = OUTPUT_FILES[index];
    const target = path.join(outputRoot, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === outputs[index]) { log(`${name} is current`); continue; }
    stale = true;
    if (check) { log(`${name} differs; run node scripts/gen-install-docs.mjs`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, outputs[index], 'utf8');
    log(`${name} written`);
  }
  return check && stale ? 1 : 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  let sourceRoot = ROOT;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') check = true;
    else if (argv[index] === '--source-root' && argv[index + 1]) sourceRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete generator argument: ${argv[index]}`);
  }
  return generateInstallArtifacts({ sourceRoot, check });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
