// `opencode-unity init [path]` (spec 5.4, section 9): scan a Unity project and write its facts.
//
// The scan is read-only on the project. Everything it produces goes to `<home>/projects/<id>/`:
// `facts.md` (the 1,600-character brief the session actually reads), `project.json` (the machine
// readable form, free of absolute paths and user names), and `local.json` (everything that identifies
// this computer). `--in-project` additionally exports the first two into `.opencode-unity/`, which is
// the one write this command may make inside a repository, and even then it only prints the ignore
// lines rather than editing anyone's ignore file (9.1, 9.7).
//
// Extension seams, in the order they land: S39 adds `--network` and `--derive`, S58 replaces the
// "this must be a Unity project" rule with workspace discovery and adds `--components`. Both edit this
// file; until then a directory that is not a Unity project exits 1, which is base spec 9.1.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAccepted } from '../cli/consent.js';
import { CliError, usageError } from '../cli/exit-codes.js';
import { runProcess } from '../core/exec.js';
import { sha256Hex, sha256Tree } from '../core/hash.js';
import { stringifyJson } from '../core/jsonc.js';
import { writeConfigFile } from '../core/config.js';
import { CURRENT_CONFIG_SCHEMA_VERSION } from '../core/migrations.js';
import { FACTS_GENERATOR_VERSION, getInputsHash } from '../facts/stale.js';
import { buildProjectJson, renderFacts, validateProjectJson } from '../facts/render.js';
import { IN_PROJECT_DIR, renderIgnoreGuidance } from '../facts/vcs-rules.js';
import { createManifest, createdBy, loadManifest, saveManifest, upsertEntry } from '../install/manifest.js';
import { refreshFragment } from '../install/wt-fragment.js';
import { buildEditorLocalRecord, isConfirmedHub, requireEditorAgent, resolveEditorAgent } from '../opencode/editor.js';
import { buildLocalState, recordProject, writeLocalState } from '../project/local.js';
import { checkProjectFreshness, loadSession, resolveProject } from '../project/session.js';
import { createNodeFsView } from '../unity/fs-view.js';
import { isUnityProjectRoot } from '../unity/root.js';
import { scanUnityProject } from '../unity/scan.js';

export const DOTNET_TIMEOUT_MS = 20_000;
export const IN_PROJECT_CONSENT_ID = 'in-project-files';
export const EDITOR_HUB_CONSENT_ID = 'editor-hub-url';

/**
 * @typedef {object} InitDependencies
 * @property {import('../unity/fs-view.js').FsView} [view]
 * @property {(file: string, args: readonly string[], options: import('../core/exec.js').RunOptions) => Promise<import('../core/exec.js').RunResult>} [run]
 * @property {typeof refreshFragment} [refreshFragment]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {InitDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const view = dependencies.view ?? createNodeFsView();
  const project = await resolveProject(session, { path: readRequestedPath(cliContext), view });
  requireUnityProject(view, project.root);

  const printOnly = cliContext.options.print === true;
  const refresh = cliContext.options.refresh === true;
  const inProject = cliContext.options.inProject === true;
  const wantsEditor = cliContext.options.editor === true;
  const dryRun = cliContext.global.dryRun === true;

  // Fresh facts make a plain re-run a no-op, but not a run that asks for something the first one did
  // not do: `--editor` and `--in-project` are the usual second step after a first `init`.
  const asksForMore = inProject || wantsEditor;
  if (!printOnly && !refresh && !asksForMore && project.initialized && !checkProjectFreshness(project, { env: session.env, view }).stale) {
    return {
      message: `${project.name} is already scanned and its facts are fresh; run 'opencode-unity init --refresh' to scan again`,
      data: describeProject(project, { written: [] }),
      warnings: session.warnings,
    };
  }

  const sdks = await listDotnetSdks(cliContext, dependencies);
  const scan = scanUnityProject(view, project.root, { env: session.env, dotnetSdks: sdks });
  let editor = resolveInitEditor({ wantsEditor, project, scan, hubUrlConfirmed: isConfirmedHub(project.local?.editor, scan.local.hubUrl) });
  // `--editor` is offered only with MCP for Unity in the project (spec 11.1); asking for it without the
  // package stops, because a silent launch without the agent reads as "/ue does nothing".
  if (wantsEditor && editor.reason === 'package_missing') requireEditorAgent(editor);

  if (printOnly) {
    const facts = renderFacts(scan, { version: session.version, editorAgent: editor.enabled });
    cliContext.output.text(facts.text.trimEnd());
    return { message: `${facts.length} characters of facts for ${project.name} (nothing was written)`, data: { projectId: project.id, root: project.root, facts: facts.text }, warnings: [...session.warnings, ...scan.warnings, ...describeDroppedFacts(facts)] };
  }
  // `--dry-run` (spec 5.1): the plan and nothing else - no consent is asked and no file is written.
  if (dryRun) return describeInitPlan({ cliContext, session, project, scan, editor, inProject, wantsEditor });

  /** @type {import('../cli/consent.js').ConsentItem[]} */
  const consentItems = [];
  if (inProject) {
    consentItems.push({
      id: IN_PROJECT_CONSENT_ID,
      title: `Write ${IN_PROJECT_DIR}/facts.md and ${IN_PROJECT_DIR}/project.json inside ${project.root}`,
      detail: 'Two text files with no absolute paths and no user names. Nothing else in the project is touched, and no ignore file is edited.',
      recommended: true,
      preselected: true,
    });
  }
  if (wantsEditor && editor.reason === 'hub_unconfirmed') consentItems.push(buildHubConsentItem(scan.local));
  const decisions = consentItems.length > 0 ? await cliContext.consent.request(consentItems) : [];
  if (isAccepted(decisions, EDITOR_HUB_CONSENT_ID)) editor = resolveInitEditor({ wantsEditor, project, scan, hubUrlConfirmed: true });

  const facts = renderFacts(scan, { version: session.version, editorAgent: editor.enabled });
  const warnings = [...session.warnings, ...scan.warnings, ...describeDroppedFacts(facts)];
  // A project that chose the agent hears why it is off (a moved hub, say) even on a plain refresh.
  if (wantsEditor || project.settings.editor.enabled) warnings.push(...editor.warnings);

  const inputsHash = getInputsHash(view, project.root, { env: session.env });
  const projectJson = buildProjectJson(scan, { version: session.version, inputsHash });
  assertValidProjectJson(projectJson);

  /** @type {string[]} */
  const written = [];
  await fs.mkdir(project.paths.dir, { recursive: true });
  await writeTextFile(project.paths.facts, facts.text, written);
  await writeTextFile(project.paths.projectJson, stringifyJson(projectJson), written);
  await writeLocalState(project.paths.localJson, buildLocalState(scan, { editor: buildEditorLocalRecord(editor) }));
  written.push(project.paths.localJson);
  await recordProject(session.paths.projectsIndex, {
    id: project.id,
    name: scan.projectName,
    path: project.root,
    factsVersion: FACTS_GENERATOR_VERSION,
  });
  written.push(session.paths.projectsIndex);
  const fragment = await (dependencies.refreshFragment ?? refreshFragment)({ env: session.env, platform: cliContext.platform, paths: session.paths });
  written.push(...fragment.updated);
  warnings.push(...fragment.warnings);

  if (wantsEditor && !project.settings.editor.enabled) {
    await enableEditorAgent(session, project.id);
    written.push(session.paths.config);
  }

  const exported = inProject && isAccepted(decisions, IN_PROJECT_CONSENT_ID)
    ? await exportIntoProject(project.root, facts.text, projectJson)
    : [];
  if (inProject && exported.length === 0) warnings.push(`${IN_PROJECT_DIR}/ was not written because the change was declined.`);
  if (exported.length > 0) {
    for (const line of renderIgnoreLines(scan)) cliContext.output.text(line);
    const recorded = await recordInProjectExport(session, path.join(project.root, IN_PROJECT_DIR));
    if (recorded.warning) warnings.push(recorded.warning);
    else written.push(session.paths.installManifest);
  }

  return {
    message: `${scan.projectName} scanned: ${facts.length} characters of facts, ${scan.assemblies.definitions.length} assemblies, ${scan.sources.files} C# files`,
    data: {
      ...describeProject(project, { written: [...written, ...exported.map((file) => file.path)] }),
      // P21: this machine tells its own export from a copy by these hashes; the folder's tree hash is in
      // the install manifest, which is what `uninstall --projects` compares before removing it.
      exported,
      inputsHash,
      editorAgent: editor.enabled,
      editorReason: editor.reason,
      factsLength: facts.length,
      dropped: facts.dropped,
    },
    warnings,
  };
}

/**
 * What `init --dry-run` prints: every file the run would write and every question it would ask, in
 * that order. Nothing is asked and nothing is written, inside the project or in the product home.
 * @param {object} input
 * @param {import('../cli/main.js').CommandContext} input.cliContext
 * @param {import('../project/session.js').Session} input.session
 * @param {import('../project/session.js').ProjectContext} input.project
 * @param {import('../unity/scan.js').ScanResult} input.scan
 * @param {import('../opencode/editor.js').EditorAgentState} input.editor
 * @param {boolean} input.inProject
 * @param {boolean} input.wantsEditor
 * @returns {import('../cli/main.js').CommandResult}
 */
function describeInitPlan({ cliContext, session, project, scan, editor, inProject, wantsEditor }) {
  const facts = renderFacts(scan, { version: session.version, editorAgent: editor.enabled });
  const wouldWrite = [project.paths.facts, project.paths.projectJson, project.paths.localJson, session.paths.projectsIndex];
  if (wantsEditor && !project.settings.editor.enabled) wouldWrite.push(session.paths.config);
  const directory = path.join(project.root, IN_PROJECT_DIR);
  const inProjectFiles = inProject ? [path.join(directory, 'facts.md'), path.join(directory, 'project.json'), session.paths.installManifest] : [];

  const lines = [`Dry run for ${project.name}: nothing is written. A real run writes:`, ...wouldWrite.map((file) => `  ${file}`)];
  if (inProject) lines.push(`and, once you agree to ${IN_PROJECT_DIR}/ inside the project:`, ...inProjectFiles.map((file) => `  ${file}`));
  if (wantsEditor && editor.reason === 'hub_unconfirmed') lines.push(`It asks you to confirm the MCP for Unity hub at ${scan.local.hubUrl}.`);
  for (const line of lines) cliContext.output.text(line);
  return {
    message: `${project.name} scanned: ${facts.length} characters of facts; dry run, nothing was written`,
    data: { projectId: project.id, root: project.root, dryRun: true, wouldWrite, inProject: inProjectFiles, factsLength: facts.length, editorAgent: editor.enabled, editorReason: editor.reason },
    warnings: [...session.warnings, ...scan.warnings, ...describeDroppedFacts(facts)],
  };
}

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @returns {string | undefined}
 */
export function readRequestedPath(cliContext) {
  const positional = typeof cliContext.args.path === 'string' && cliContext.args.path !== '' ? cliContext.args.path : undefined;
  return positional ?? cliContext.global.project ?? undefined;
}

/**
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root
 */
function requireUnityProject(view, root) {
  if (isUnityProjectRoot(view, root)) return;
  throw usageError(`${root} is not a Unity project; no Assets/ and ProjectSettings/ProjectVersion.txt were found here or above it`, {
    code: 'not_a_unity_project',
    data: { root },
    hint: 'Run init inside the Unity project folder, or pass its path.',
  });
}

/**
 * The editor agent as this scan sees it. `src/opencode/editor.js` owns the rules; this only supplies
 * the scan, the recorded confirmation and the user's choice, with `--editor` counting as that choice.
 * @param {{ wantsEditor: boolean, project: import('../project/session.js').ProjectContext, scan: import('../unity/scan.js').ScanResult, hubUrlConfirmed: boolean }} input
 * @returns {import('../opencode/editor.js').EditorAgentState}
 */
function resolveInitEditor({ wantsEditor, project, scan, hubUrlConfirmed }) {
  return resolveEditorAgent({
    mcp: scan.mcp,
    local: {
      hubUrl: scan.local.hubUrl,
      hubUrlSource: scan.local.hubUrlSource,
      hubUrlConfirmed,
      expectedInstanceId: scan.local.expectedInstanceId,
    },
    settings: wantsEditor ? { ...project.settings.editor, enabled: true } : project.settings.editor,
  });
}

/**
 * Spec 11.1: the user confirms the hub URL. M0 spike M is manual-pending, so its fallback holds: a URL
 * MCP for Unity wrote into the user's OpenCode config is the recommended answer, and the package
 * default is never confirmed by `--yes` - only by a person who compared it with the MCP for Unity window.
 * @param {import('../unity/scan.js').ScanResult['local']} local
 * @returns {import('../cli/consent.js').ConsentItem}
 */
function buildHubConsentItem(local) {
  const fromConfigurator = local.hubUrlSource === 'opencode-config';
  return {
    id: EDITOR_HUB_CONSENT_ID,
    title: `Use the MCP for Unity hub at ${local.hubUrl} for editor checks`,
    detail: fromConfigurator
      ? 'MCP for Unity wrote this URL into your OpenCode config. Compare it with the URL in the MCP for Unity window.'
      : 'This is the package default, not a URL MCP for Unity recorded on this machine. Compare it with the URL in the MCP for Unity window; the editor agent stays off until a URL is confirmed.',
    recommended: fromConfigurator,
  };
}

/**
 * @param {import('../project/session.js').Session} session
 * @param {string} projectId
 * @returns {Promise<void>}
 */
async function enableEditorAgent(session, projectId) {
  // The user document, not the resolved one: config.json holds only choices, never defaults (6.2).
  const user = session.configUser;
  const projects = /** @type {Record<string, any>} */ (user.projects ?? {});
  const previous = /** @type {Record<string, any>} */ (projects[projectId] ?? {});
  await writeConfigFile(session.paths.config, {
    ...user,
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    projects: { ...projects, [projectId]: { ...previous, editor: { ...previous.editor, enabled: true } } },
  });
}

/**
 * `uninstall --projects` removes an in-project folder only while it is still exactly the export (spec
 * 14.4, P21), so the folder and its tree hash are recorded in the install manifest. `init` may run
 * before `setup`; the folder exists either way, so a manifest is started when there is none. A record
 * that cannot be read is not overwritten: the export stands, and the warning says it is not tracked.
 * @param {import('../project/session.js').Session} session
 * @param {string} directory
 * @returns {Promise<{ warning: string | null }>}
 */
async function recordInProjectExport(session, directory) {
  const manifestPath = session.paths.installManifest;
  try {
    const { manifest } = await loadManifest(manifestPath);
    const entry = { kind: /** @type {const} */ ('projectDir'), path: directory, sha256Tree: await sha256Tree(directory), createdBy: createdBy('init', session.version) };
    await saveManifest(manifestPath, upsertEntry(manifest ?? createManifest(session.version), entry));
    return { warning: null };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { warning: `${directory} was written but not recorded in ${manifestPath} (${error.message}); uninstall --projects will not remove it.` };
  }
}

/**
 * @param {string} root
 * @param {string} factsText
 * @param {Record<string, any>} projectJson
 * @returns {Promise<Array<{ path: string, sha256: string }>>}
 */
async function exportIntoProject(root, factsText, projectJson) {
  const directory = path.join(root, IN_PROJECT_DIR);
  await fs.mkdir(directory, { recursive: true });
  /** @type {Array<{ path: string, sha256: string }>} */
  const exported = [];
  for (const [name, text] of [['facts.md', factsText], ['project.json', stringifyJson(projectJson)]]) {
    const file = path.join(directory, name);
    await fs.writeFile(file, text, 'utf8');
    exported.push({ path: file, sha256: sha256Hex(text) });
  }
  return exported;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string[]}
 */
function renderIgnoreLines(scan) {
  const guidance = renderIgnoreGuidance(scan.vcs.kind, { opencodeDir: scan.opencodeDir });
  if (guidance.mechanism === 'none') return guidance.notes;
  return [`${IN_PROJECT_DIR}/ was written. Ignore rules for ${guidance.mechanism} (printed only, nothing was edited):`, ...guidance.lines.map((line) => `  ${line}`), ...guidance.notes];
}

/**
 * `dotnet --list-sdks` tells the compile map whether `dotnet build` can run at all. A missing dotnet is
 * a fact, not a failure: the scan records "not present" and the facts say so.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {InitDependencies} dependencies
 * @returns {Promise<string[] | null>}
 */
async function listDotnetSdks(cliContext, dependencies) {
  const run = dependencies.run ?? runProcess;
  const result = await run('dotnet', ['--list-sdks'], {
    timeoutMs: DOTNET_TIMEOUT_MS,
    env: cliContext.env,
    cwd: cliContext.cwd,
    signal: cliContext.signal,
    platform: cliContext.platform,
  });
  if (result.error || result.timedOut || result.exitCode !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * @param {import('../facts/render.js').FactsRender} facts
 * @returns {string[]}
 */
function describeDroppedFacts(facts) {
  /** @type {string[]} */
  const warnings = [];
  if (facts.dropped.length > 0) warnings.push(`The facts did not fit, so these were left out: ${facts.dropped.join(', ')}.`);
  if (facts.truncated) warnings.push('The facts were cut at the character cap even after dropping optional blocks.');
  return warnings;
}

/**
 * @param {Record<string, any>} projectJson
 */
function assertValidProjectJson(projectJson) {
  const errors = validateProjectJson(projectJson);
  if (errors.length === 0) return;
  // A schema failure here is this product's defect, not the user's, so it is exit 7 and not exit 1.
  throw new CliError(`The scan produced a project.json the schema rejects: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`, {
    code: 'project_json_invalid',
  });
}

/**
 * @param {import('../project/session.js').ProjectContext} project
 * @param {{ written: string[] }} extra
 * @returns {Record<string, unknown>}
 */
function describeProject(project, extra) {
  return { projectId: project.id, root: project.root, factsPath: project.paths.facts, written: extra.written };
}

/**
 * @param {string} file
 * @param {string} text
 * @param {string[]} written
 * @returns {Promise<void>}
 */
async function writeTextFile(file, text, written) {
  await fs.writeFile(file, text, 'utf8');
  written.push(file);
}
