// `opencode-unity shape [<text> | @file | -]` (amendment 36.5): check a request, and only when it is
// unclear, rewrite it once into the short fixed form.
//
// The shaped request goes to stdout and the note to stderr, so `shape - > brief.txt` captures exactly the
// text. It launches nothing and writes nothing (S-SH4). The exit code is 0 in every shaping outcome,
// passthrough included - `shape` never refuses on quality, refusal is the delegate's channel (36.6) -
// and 1 only for usage: an empty request, an unreadable input, or a directory in which no workspace
// component resolves, which is the same condition `init` exits 1 on under D-B1.
import fs from 'node:fs/promises';
import path from 'node:path';
import { usageError } from '../cli/exit-codes.js';
import { probeCaseInsensitive } from '../core/case-sensitivity.js';
import { DEFAULT_MAX_FILE_BYTES, decodeTaskFile, normalizeInputPath, statOrNull } from '../delegate/files.js';
import { createSensitiveMatcher } from '../network/sensitive.js';
import { discoverWorkspace } from '../project/discover.js';
import { loadSession, resolveProject } from '../project/session.js';
import { resolveShapeSettings, shapeRequest } from '../shape/index.js';
import { readFactsRules } from '../shape/render.js';
import { assertShapeableText } from '../shape/verdict.js';
import { createNodeFsView, isProjectPath, joinProjectPath } from '../unity/fs-view.js';

/** The positional that reads the request from standard input. */
export const STDIN_ARGUMENT = '-';

/**
 * Test seams. The real command reads the node filesystem and `process.stdin`.
 * @typedef {object} ShapeDependencies
 * @property {import('../unity/fs-view.js').FsView} [view]
 * @property {AsyncIterable<Buffer | string>} [stdin]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {boolean} [caseInsensitive]
 * @property {() => number} [now]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {ShapeDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const text = await readRequest(cliContext, session, dependencies);
  // G-a before anything walks the project: an empty request is the one hard stop.
  assertShapeableText(text);

  const view = dependencies.view ?? createNodeFsView();
  const start = path.resolve(cliContext.cwd, cliContext.global.project ?? '.');
  const workspace = discoverWorkspace(view, start, { env: session.env });
  const components = [...workspace.anchors, ...workspace.overlays];
  if (components.length === 0) {
    throw usageError(`No workspace component was found in ${workspace.root}`, {
      code: 'no_workspace_component',
      data: { root: workspace.root },
      hint: 'Run shape inside a Unity project or a service folder, or pass --project <dir>.',
    });
  }
  const facts = await readProjectFacts(session, workspace, view);

  const result = await shapeRequest({
    text,
    settings: resolveShapeSettings(session.config),
    noModel: cliContext.options.noModel === true,
    project: {
      view,
      root: workspace.root,
      componentDirs: components.map((component) => component.dir),
      folders: facts.folders,
      caseInsensitive: dependencies.caseInsensitive ?? probeCaseInsensitive(workspace.root, { platform: cliContext.platform }).caseInsensitive,
      keep: facts.keep,
      extraProtectedEditGlobs: session.config.safety.extraProtectedEditGlobs,
    },
    profile: session.profile,
    lockPath: session.paths.gpuLock,
    addCleanup: (cleanup) => cliContext.interrupts.addCleanup(cleanup),
    probes: dependencies.probes,
    fetch: dependencies.fetchImpl,
    signal: cliContext.signal,
    now: dependencies.now,
  });
  // Setup and profile warnings concern the model; a request that never reached it does not need them.
  return present(cliContext, result, result.modelCall ? session.warnings : []);
}

/**
 * The envelope `data` of 36.6 plus the passthrough reason, and the human output: the request alone on
 * stdout, everything else on stderr.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {import('../shape/index.js').ShapeResult} result
 * @param {string[]} warnings
 * @returns {import('../cli/main.js').CommandResult}
 */
export function present(cliContext, result, warnings) {
  const data = {
    status: result.status,
    verdict: result.verdict,
    reason: result.reason,
    rule: result.rule,
    request: result.request,
    fields: result.fields,
    unresolved: result.unresolved,
    note: result.note,
    modelCall: result.modelCall,
    durationMs: result.durationMs,
    promptTokensActual: result.promptTokensActual,
    outputTokens: result.outputTokens,
  };
  if (cliContext.output.json) return { code: result.status, message: summarize(result), data, warnings };
  // One final newline on stdout whatever the request ends with, so a redirected file holds the text.
  cliContext.output.text(result.request.endsWith('\n') ? result.request.slice(0, -1) : result.request);
  return { code: result.status, message: '', data, warnings: result.note ? [...warnings, result.note] : warnings };
}

/**
 * @param {import('../shape/index.js').ShapeResult} result
 * @returns {string}
 */
export function summarize(result) {
  if (result.status === 'ready') return 'Ready as written; no model call.';
  if (result.status === 'shaped') {
    const count = result.fields?.open.length ?? 0;
    return `Rewritten once; ${count} open question${count === 1 ? '' : 's'}.`;
  }
  return `Passed on unchanged (${result.reason}).`;
}

/**
 * The positional as text, `@file`, or `-` for standard input. A file goes through the same sensitive-file
 * refusal as a delegate task: its text is echoed back in the envelope, and an orchestrator must never
 * receive a secret that way.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {import('../project/session.js').Session} session
 * @param {ShapeDependencies} dependencies
 * @returns {Promise<string>}
 */
export async function readRequest(cliContext, session, dependencies) {
  const value = cliContext.args.text;
  if (value === undefined) {
    throw usageError('shape needs a request: text, @file, or - to read standard input', { hint: "Run 'opencode-unity help shape'." });
  }
  if (value === STDIN_ARGUMENT) return readStream(dependencies.stdin ?? process.stdin, cliContext.signal);
  if (!value.startsWith('@')) return value;

  const target = normalizeInputPath(value.slice(1), { platform: cliContext.platform, env: cliContext.env });
  const absolutePath = path.resolve(cliContext.cwd, target);
  const stat = await statOrNull(absolutePath);
  if (!stat?.isFile()) throw usageError(`Request file not found: ${target} (resolved against ${cliContext.cwd})`);
  const matcher = createSensitiveMatcher({ extraPatterns: session.config.delegate.extraSensitivePatterns, platform: cliContext.platform });
  const pattern = matcher.find(absolutePath, cliContext.cwd);
  if (pattern) {
    throw usageError(`Refusing a request file that looks sensitive: ${target} (matches '${pattern}')`, { code: 'sensitive_file_refused', data: { refused: [target] } });
  }
  if (stat.size > DEFAULT_MAX_FILE_BYTES) throw usageError(`Request file ${target} is ${stat.size} bytes, above the ${DEFAULT_MAX_FILE_BYTES}-byte limit`);
  return decodeTaskFile(await fs.readFile(absolutePath), `request file ${target}`);
}

/**
 * @param {AsyncIterable<Buffer | string>} stream
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function readStream(stream, signal) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    size += bytes.length;
    if (size > DEFAULT_MAX_FILE_BYTES) throw usageError(`The request on standard input is above the ${DEFAULT_MAX_FILE_BYTES}-byte limit`);
    chunks.push(bytes);
  }
  return decodeTaskFile(Buffer.concat(chunks), 'standard input');
}

/**
 * What the product already knows about the Unity clients in the workspace: the UI and input rules
 * `init` wrote into facts.md (for `Keep:`), and the assembly folders and compile-map prefixes of
 * project.json (for rule 4). A client that was never initialised contributes nothing, which is not an
 * error. Every folder read out of project.json is checked to stay inside the workspace before use.
 * @param {import('../project/session.js').Session} session
 * @param {import('../project/discover.js').WorkspaceDiscovery} workspace
 * @param {import('../unity/fs-view.js').FsView} view
 * @returns {Promise<{ folders: import('../shape/anchors.js').FolderAnchorSource[], keep: import('../shape/render.js').KeepFacts }>}
 */
async function readProjectFacts(session, workspace, view) {
  /** @type {import('../shape/anchors.js').FolderAnchorSource[]} */
  const folders = [];
  /** @type {{ uiRule: string | null, inputRule: string | null }} */
  let rules = { uiRule: null, inputRule: null };
  let vcsKind = workspace.vcsKind;
  for (const client of workspace.anchors.filter((anchor) => anchor.kind === 'unity-client')) {
    const project = await resolveProject(session, { path: joinProjectPath(workspace.root, client.dir), view });
    if (rules.uiRule === null && rules.inputRule === null) rules = readFactsRules(await readTextOrNull(project.paths.facts));
    vcsKind ??= typeof project.projectJson?.vcs?.kind === 'string' ? project.projectJson.vcs.kind : null;
    folders.push(...readFolderAnchors(project.projectJson, client.dir));
  }
  return { folders, keep: { vcsKind, ...rules } };
}

/**
 * Rule 4's sources from one project.json: assembly folders, and compile-map prefixes with the assembly
 * each one compiles into. project.json paths are relative to the Unity root, so they are re-rooted at
 * the workspace.
 * @param {Record<string, any> | null} projectJson
 * @param {string} clientDir
 * @returns {import('../shape/anchors.js').FolderAnchorSource[]}
 */
export function readFolderAnchors(projectJson, clientDir) {
  /** @type {import('../shape/anchors.js').FolderAnchorSource[]} */
  const sources = [];
  for (const assembly of Array.isArray(projectJson?.assemblies) ? projectJson.assemblies : []) {
    const folder = toWorkspaceFolder(clientDir, assembly?.folder);
    if (folder !== null && typeof assembly?.name === 'string' && assembly.name !== '') sources.push({ name: assembly.name, folder });
  }
  for (const row of Array.isArray(projectJson?.compileMap) ? projectJson.compileMap : []) {
    const folder = toWorkspaceFolder(clientDir, row?.prefix);
    if (folder === null) continue;
    sources.push({ name: '', folder });
    if (typeof row?.assembly === 'string' && row.assembly !== '') sources.push({ name: row.assembly, folder });
  }
  return sources;
}

/**
 * @param {string} clientDir
 * @param {unknown} value
 * @returns {string | null}
 */
function toWorkspaceFolder(clientDir, value) {
  if (typeof value !== 'string') return null;
  const folder = value.replace(/\/+$/, '');
  if (folder === '') return clientDir === '' ? null : clientDir;
  if (!isProjectPath(folder)) return null;
  return clientDir === '' ? folder : `${clientDir}/${folder}`;
}

/**
 * @param {string} file
 * @returns {Promise<string | null>}
 */
async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
