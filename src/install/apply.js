// Transactional apply (spec 14.1): every file is rendered into a staging directory first, moved into
// place one at a time, and the manifest is written last. Anything that fails - a write, an external
// command, or Ctrl+C - unwinds the operations that already ran, in reverse, and leaves the machine as it
// was found. Nothing here knows what setup installs; it executes the operation list a plan produced.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { sha256Hex } from '../core/hash.js';
import { createBackup, newTemplatePath, pathExists, restoreBackup, restoreBackupSync } from './backup.js';
import { findEntry, getKindSpec, saveManifest, upsertEntry } from './manifest.js';

/**
 * @typedef {'backup'|'preserve'|'skip'} ConflictPolicy
 * - backup:   an existing file is moved to `<file>.bak-<version>` and replaced (a fresh install).
 * - preserve: an existing file we did not write is kept and the new template lands beside it as
 *             `<file>.ocu-new` (the upgrade rule of spec 14.3 items 4 and 5).
 * - skip:     an existing file is left alone and nothing is recorded (`config.json`, spec 14.1 item 6).
 */

/**
 * @typedef {object} WriteFileOperation
 * @property {'writeFile'} op
 * @property {string} path
 * @property {string | Uint8Array} content
 * @property {ConflictPolicy} onConflict
 * @property {string} [recordedSha256]  What the manifest says we last wrote there; drives `preserve`.
 * @property {import('./manifest.js').ManifestEntry} [entry]  Recorded when the file ends up being ours.
 *
 * @typedef {object} MakeDirOperation
 * @property {'makeDir'} op
 * @property {string} path
 * @property {import('./manifest.js').ManifestEntry} [entry]
 *
 * @typedef {object} SetEnvOperation
 * @property {'setEnv'} op
 * @property {'userEnv'|'launchctlEnv'} kind
 * @property {string} name
 * @property {string} value
 *
 * @typedef {object} PullModelOperation
 * @property {'pullModel'} op
 * @property {string} model
 * @property {boolean} alreadyInstalled  True when the base model was already in the store.
 *
 * @typedef {object} CreateModelOperation
 * @property {'createModel'} op
 * @property {string} tag
 * @property {string} modelfilePath
 * @property {string} baseModel
 * @property {boolean} [alreadyInstalled]  The tag exists and was built from the same Modelfile, so only
 *   the record is refreshed; `ollama create` is not run again.
 *
 * @typedef {object} InstallNpmGlobalOperation
 * @property {'installNpmGlobal'} op
 * @property {string} name
 * @property {string} version
 *
 * @typedef {WriteFileOperation | MakeDirOperation | SetEnvOperation | PullModelOperation | CreateModelOperation | InstallNpmGlobalOperation} Operation
 */

/**
 * One step of the rollback. `undoSync` exists for filesystem changes only: Ctrl+C runs the cleanups
 * synchronously and exits in the same tick, so anything that needs a child process (a model tag, an
 * environment variable) can only be named for the user, not undone, on that path.
 * @typedef {object} Undo
 * @property {string} label
 * @property {() => Promise<void>} undo
 * @property {() => void} [undoSync]
 */

/**
 * @typedef {object} ApplyStep
 * @property {string} id
 * @property {string} title
 * @property {boolean} accepted
 * @property {readonly Operation[]} operations
 */

/**
 * @typedef {object} StepOutcome
 * @property {string} id
 * @property {'applied'|'unchanged'|'declined'|'skipped'} status
 * @property {string[]} details
 */

/**
 * @typedef {object} ApplyIo
 * @property {string} cliVersion
 * @property {string} manifestPath
 * @property {import('./manifest.js').Manifest} manifest
 * @property {string} stagingRoot                       Parent for the staging directory; must be writable.
 * @property {import('./user-env.js').UserEnvAdapter} [userEnv]
 * @property {import('./external.js').ModelInstaller} [models]
 * @property {import('./external.js').NpmInstaller} [npm]
 * @property {(operation: Operation, step: ApplyStep) => void | Promise<void>} [onOperation]
 *   Called before each operation. Throwing from it aborts the apply and triggers the rollback, which is
 *   how the tests inject a failure at an exact point without a mock filesystem.
 * @property {() => Date} [now]
 * @property {AbortSignal} [signal]
 * @property {(cleanup: () => string | void) => () => void} [addCleanup]
 *   The interrupt controller's registration. Ctrl+C runs it synchronously and exits, so it gets the
 *   synchronous half of the rollback.
 */

/**
 * @typedef {object} ApplyResult
 * @property {import('./manifest.js').Manifest} manifest
 * @property {StepOutcome[]} steps
 * @property {import('./backup.js').Backup[]} backups
 * @property {string[]} newTemplates
 * @property {string[]} notes
 */

/**
 * @param {readonly ApplyStep[]} steps
 * @param {ApplyIo} io
 * @returns {Promise<ApplyResult>}
 */
export async function applyPlan(steps, io) {
  const now = io.now ?? (() => new Date());
  const staging = await fs.mkdtemp(path.join(io.stagingRoot, '.staging-'));
  /** @type {Undo[]} */
  const undoStack = [];
  /** @type {ApplyResult} */
  const result = { manifest: io.manifest, steps: [], backups: [], newTemplates: [], notes: [] };
  /** @type {import('./manifest.js').ManifestEntry[]} Base models this run downloaded; kept on a rollback. */
  const kept = [];
  let counter = 0;
  const removeCleanup = io.addCleanup?.(() => unwindSync(undoStack, [staging, `${io.manifestPath}.tmp-${process.pid}`], kept.map((entry) => String(entry.name))));

  try {
    for (const step of steps) {
      if (!step.accepted) {
        result.steps.push({ id: step.id, status: 'declined', details: [] });
        continue;
      }
      /** @type {StepOutcome} */
      const outcome = { id: step.id, status: 'unchanged', details: [] };
      for (const operation of step.operations ?? []) {
        assertNotAborted(io.signal);
        await io.onOperation?.(operation, step);
        counter += 1;
        const changed = await runOperation(operation, { io, staging, slot: counter, undoStack, result, now, kept });
        if (changed) outcome.status = 'applied';
      }
      if ((step.operations ?? []).length === 0) outcome.status = 'skipped';
      result.steps.push(outcome);
    }
    assertNotAborted(io.signal);
    await saveManifest(io.manifestPath, result.manifest, { now });
    return result;
  } catch (error) {
    const rollbackProblems = await unwind(undoStack);
    await recordKeptModels(io, kept, now, rollbackProblems);
    throw describeFailure(error, rollbackProblems, kept.map((entry) => String(entry.name)));
  } finally {
    removeCleanup?.();
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * The Ctrl+C rollback: every filesystem change is undone before the process exits; the rest is named so
 * the user can finish it. The stack is emptied as it goes, so an asynchronous rollback that still gets to
 * run afterwards cannot undo anything a second time - removing a file this one has just put back.
 * @param {Undo[]} undoStack
 * @param {readonly string[]} scratch  Staging directory and temp files to remove as well.
 * @param {readonly string[]} [keptModels]  Base models this run downloaded, which a rollback keeps.
 * @returns {string}  One note for the interrupt message.
 */
export function unwindSync(undoStack, scratch, keptModels = []) {
  /** @type {string[]} */
  const left = [];
  for (const step of undoStack.splice(0).reverse()) {
    if (!step.undoSync) {
      left.push(step.label);
      continue;
    }
    try {
      step.undoSync();
    } catch (error) {
      left.push(`${step.label} (${/** @type {Error} */ (error).message})`);
    }
  }
  for (const target of scratch) fsSync.rmSync(target, { recursive: true, force: true });
  const note = left.length === 0 ? 'rolled back the install' : `rolled back the files; still to do by hand: ${left.join('; ')}`;
  // An interrupt cannot wait for the manifest write, so the kept download is named instead of recorded.
  return keptModels.length === 0 ? note : `${note}; kept the downloaded ${keptModels.join(', ')} (ollama rm removes it)`;
}

/**
 * A base model this run finished downloading is kept when a later step fails: the transactional
 * rollback covers staged files (spec 14.1), and a base model is removed only with
 * `--remove-base-model` and a second confirmation (14.4). It is recorded as pulled by setup, so the
 * next run does not download it again and `uninstall --remove-base-model` still knows it is ours.
 * @param {ApplyIo} io
 * @param {readonly import('./manifest.js').ManifestEntry[]} kept
 * @param {() => Date} now
 * @param {string[]} rollbackProblems  Receives the reason when the record cannot be written.
 * @returns {Promise<void>}
 */
async function recordKeptModels(io, kept, now, rollbackProblems) {
  if (kept.length === 0) return;
  try {
    await saveManifest(io.manifestPath, kept.reduce((manifest, entry) => upsertEntry(manifest, entry), io.manifest), { now });
  } catch (error) {
    rollbackProblems.push(`record the kept ${kept.map((entry) => entry.name).join(', ')}: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * @param {Operation} operation
 * @param {{ io: ApplyIo, staging: string, slot: number, undoStack: Undo[], result: ApplyResult, now: () => Date, kept: import('./manifest.js').ManifestEntry[] }} context
 * @returns {Promise<boolean>} True when something on the machine changed.
 */
async function runOperation(operation, context) {
  switch (operation.op) {
    case 'writeFile':
      return writeFileOperation(operation, context);
    case 'makeDir':
      return makeDirOperation(operation, context);
    case 'setEnv':
      return setEnvOperation(operation, context);
    case 'pullModel':
      return pullModelOperation(operation, context);
    case 'createModel':
      return createModelOperation(operation, context);
    case 'installNpmGlobal':
      return installNpmGlobalOperation(operation, context);
    default:
      throw new TypeError(`Unknown install operation '${/** @type {{ op: string }} */ (operation).op}'`);
  }
}

/**
 * @param {WriteFileOperation} operation
 * @param {{ io: ApplyIo, staging: string, slot: number, undoStack: Undo[], result: ApplyResult }} context
 * @returns {Promise<boolean>}
 */
async function writeFileOperation(operation, { io, staging, slot, undoStack, result }) {
  const content = toBuffer(operation.content);
  const digest = sha256Hex(content);
  const existing = await readIfPresent(operation.path);

  if (existing !== null && operation.onConflict === 'skip') {
    result.notes.push(`${operation.path} exists already and was left as it is`);
    return false;
  }
  const existingDigest = existing === null ? null : sha256Hex(existing);
  if (existingDigest === digest) {
    recordFile(result, operation, digest, null);
    return false;
  }
  // "Ours" means byte-for-byte what the manifest says we last wrote: replacing it loses nothing of the
  // user's, so it gets no `.bak` file - which would otherwise be residue after every upgrade.
  const ours = existingDigest !== null && existingDigest === recordedDigest(result.manifest, operation);
  if (existing !== null && operation.onConflict === 'preserve' && !ours) {
    const sidePath = newTemplatePath(operation.path);
    await stageInto(sidePath, content, { staging, slot, undoStack });
    result.newTemplates.push(sidePath);
    result.notes.push(`${operation.path} was edited after it was written, so the new version is beside it as ${path.basename(sidePath)}`);
    return true;
  }
  if (existing !== null && operation.onConflict === 'backup' && !ours) {
    const backup = await createBackup(operation.path, { cliVersion: io.cliVersion });
    if (backup) {
      result.backups.push(backup);
      undoStack.push({ label: `restore ${backup.source}`, undo: () => restoreBackup(backup), undoSync: () => restoreBackupSync(backup) });
    }
  } else if (existing !== null) {
    // Pushed before the write, so on rollback it runs after the new file is removed.
    const previousBytes = existing;
    undoStack.push({
      label: `restore ${operation.path}`,
      undo: () => fs.writeFile(operation.path, previousBytes),
      undoSync: () => fsSync.writeFileSync(operation.path, previousBytes),
    });
  }
  const createdRoot = await stageInto(operation.path, content, { staging, slot, undoStack });
  recordFile(result, operation, digest, createdRoot);
  return true;
}

/**
 * Records a written file. A file outside the product home also remembers the topmost directory made for
 * it, so uninstall can take that directory away again; a re-run that created nothing keeps what the
 * first run recorded.
 * @param {ApplyResult} result
 * @param {WriteFileOperation} operation
 * @param {string} digest
 * @param {string | null} createdRoot
 */
function recordFile(result, operation, digest, createdRoot) {
  if (!operation.entry) return;
  const entry = withDigest(operation.entry, digest);
  if (!OUTSIDE_HOME_KINDS.has(entry.kind)) {
    result.manifest = upsertEntry(result.manifest, entry);
    return;
  }
  const root = createdRoot ?? findEntry(result.manifest, entry)?.createdRoot;
  result.manifest = upsertEntry(result.manifest, root ? { ...entry, createdRoot: root } : entry);
}

/** Kinds whose files live outside the product home, where a directory we created is not ours to keep. */
const OUTSIDE_HOME_KINDS = new Set(['wtFragment', 'skillCopy']);

/**
 * @param {import('./manifest.js').Manifest} manifest
 * @param {WriteFileOperation} operation
 * @returns {string | undefined}
 */
function recordedDigest(manifest, operation) {
  if (operation.recordedSha256 !== undefined) return operation.recordedSha256;
  const key = operation.entry ?? { kind: /** @type {const} */ ('file'), path: operation.path };
  return findEntry(manifest, key)?.sha256;
}

/**
 * A hashed kind carries the digest of what was actually written; the others have no hash field at all and
 * must not grow one, because the schema rejects unknown keys.
 * @param {import('./manifest.js').ManifestEntry} entry
 * @param {string} digest
 * @returns {import('./manifest.js').ManifestEntry}
 */
function withDigest(entry, digest) {
  return getKindSpec(entry.kind).verify === 'file' ? { ...entry, sha256: digest } : entry;
}

/**
 * @param {MakeDirOperation} operation
 * @param {{ io: ApplyIo, undoStack: Undo[], result: ApplyResult }} context
 * @returns {Promise<boolean>}
 */
async function makeDirOperation(operation, { undoStack, result }) {
  const existed = await pathExists(operation.path);
  await ensureDirectory(operation.path, undoStack);
  if (operation.entry) result.manifest = upsertEntry(result.manifest, operation.entry);
  return !existed;
}

/**
 * Creates a directory and every missing parent, and registers the *topmost* one it had to create for the
 * rollback. Undoing only the leaf would leave empty parents behind, which the residue check counts.
 * @param {string} directory
 * @param {Undo[]} undoStack
 * @returns {Promise<string | null>} The topmost directory it created, or null when it created none.
 */
async function ensureDirectory(directory, undoStack) {
  if (await pathExists(directory)) return null;
  let topMissing = directory;
  for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if (await pathExists(parent)) break;
    topMissing = parent;
  }
  await fs.mkdir(directory, { recursive: true });
  undoStack.push({
    label: `remove ${topMissing}`,
    undo: () => fs.rm(topMissing, { recursive: true, force: true }),
    undoSync: () => fsSync.rmSync(topMissing, { recursive: true, force: true }),
  });
  return topMissing;
}

/**
 * @param {SetEnvOperation} operation
 * @param {{ io: ApplyIo, undoStack: Undo[], result: ApplyResult }} context
 * @returns {Promise<boolean>}
 */
async function setEnvOperation(operation, { io, undoStack, result }) {
  const adapter = io.userEnv;
  if (!adapter) throw new TypeError('An environment operation needs a user-env adapter');
  const recorded = findEntry(result.manifest, { kind: operation.kind, name: operation.name });
  const current = await adapter.read(operation.name);
  if (current === operation.value) {
    // Already set. A value we set earlier keeps its record, including what was there before us; a value
    // the user set themselves is theirs, so nothing is recorded and uninstall will leave it alone.
    if (recorded) result.manifest = upsertEntry(result.manifest, { ...recorded, createdBy: `setup@${io.cliVersion}` });
    return false;
  }
  await adapter.write(operation.name, operation.value);
  undoStack.push({ label: `restore ${operation.name}`, undo: () => adapter.restore(operation.name, current) });
  result.manifest = upsertEntry(result.manifest, {
    kind: operation.kind,
    name: operation.name,
    value: operation.value,
    // "Previous" means before this product first touched it, so a second setup does not forget it.
    previous: recorded ? recorded.previous ?? null : current,
    createdBy: `setup@${io.cliVersion}`,
  });
  return true;
}

/**
 * @param {PullModelOperation} operation
 * @param {{ io: ApplyIo, result: ApplyResult, kept: import('./manifest.js').ManifestEntry[] }} context
 * @returns {Promise<boolean>}
 */
async function pullModelOperation(operation, { io, result, kept }) {
  const models = requireModels(io);
  // A finished download is never undone: a later, unrelated failure must not delete a model the user
  // agreed to download (about 19 GiB) and force it again. `recordKeptModels` records it instead.
  if (!operation.alreadyInstalled) await models.pull(operation.model);
  // A re-run finds the model it pulled last time "already installed"; the record must still say who
  // downloaded it, or uninstall --remove-base-model would refuse a model that is ours.
  const recorded = findEntry(result.manifest, { kind: 'ollamaModel', name: operation.model });
  /** @type {import('./manifest.js').ManifestEntry} */
  const entry = {
    kind: 'ollamaModel',
    name: operation.model,
    pulledBySetup: !operation.alreadyInstalled || recorded?.pulledBySetup === true,
    derived: false,
    createdBy: `setup@${io.cliVersion}`,
  };
  result.manifest = upsertEntry(result.manifest, entry);
  if (!operation.alreadyInstalled) kept.push(entry);
  return !operation.alreadyInstalled;
}

/**
 * @param {CreateModelOperation} operation
 * @param {{ io: ApplyIo, undoStack: Undo[], result: ApplyResult }} context
 * @returns {Promise<boolean>}
 */
async function createModelOperation(operation, { io, undoStack, result }) {
  if (!operation.alreadyInstalled) {
    const models = requireModels(io);
    await models.create(operation.tag, operation.modelfilePath);
    undoStack.push({ label: `remove ${operation.tag}`, undo: () => models.remove(operation.tag) });
  }
  result.manifest = upsertEntry(result.manifest, {
    kind: 'ollamaModel',
    name: operation.tag,
    pulledBySetup: false,
    derived: true,
    baseModel: operation.baseModel,
    createdBy: `setup@${io.cliVersion}`,
  });
  return !operation.alreadyInstalled;
}

/**
 * @param {InstallNpmGlobalOperation} operation
 * @param {{ io: ApplyIo, result: ApplyResult }} context
 * @returns {Promise<boolean>}
 */
async function installNpmGlobalOperation(operation, { io, result }) {
  if (!io.npm) throw new TypeError('A global npm operation needs an npm installer');
  await io.npm.installGlobal(operation.name, operation.version);
  // Deliberately no compensation: removing a global package another tool may be using is worse than
  // leaving it. Uninstall prints the removal command for the same reason (spec 14.4 item 5).
  result.manifest = upsertEntry(result.manifest, {
    kind: 'npmGlobal',
    name: operation.name,
    version: operation.version,
    createdBy: `setup@${io.cliVersion}`,
  });
  return true;
}

/**
 * Writes into the staging directory, then moves the file into place, so a partial write is never visible
 * at the target path.
 * @param {string} target
 * @param {Buffer} content
 * @param {{ staging: string, slot: number, undoStack: Undo[] }} context
 * @returns {Promise<string | null>} The topmost directory created to hold the file, if any.
 */
async function stageInto(target, content, { staging, slot, undoStack }) {
  const staged = path.join(staging, `${slot}-${path.basename(target)}`);
  await fs.writeFile(staged, content);
  const createdRoot = await ensureDirectory(path.dirname(target), undoStack);
  await moveFile(staged, target);
  undoStack.push({ label: `remove ${target}`, undo: () => fs.rm(target, { force: true }), undoSync: () => fsSync.rmSync(target, { force: true }) });
  return createdRoot;
}

/**
 * `rename` fails with EXDEV when the staging directory and the target are on different volumes, which
 * happens for a fragment or a skill copy under another drive. Copy and unlink is the documented fallback.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') throw error;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

/**
 * @param {Undo[]} undoStack
 * @returns {Promise<string[]>} Compensations that themselves failed.
 */
async function unwind(undoStack) {
  /** @type {string[]} */
  const problems = [];
  for (let index = undoStack.length - 1; index >= 0; index -= 1) {
    const step = undoStack[index];
    try {
      await step.undo();
    } catch (error) {
      problems.push(`${step.label}: ${/** @type {Error} */ (error).message}`);
    }
  }
  return problems;
}

/**
 * @param {unknown} error
 * @param {string[]} rollbackProblems
 * @param {readonly string[]} [keptModels]  Downloaded base models the rollback kept and recorded.
 * @returns {CliError}
 */
function describeFailure(error, rollbackProblems, keptModels = []) {
  const cause = error instanceof Error ? error : new Error(String(error));
  const base = error instanceof CliError ? error : null;
  const rolledBack = rollbackProblems.length === 0;
  const kept = keptModels.length === 0 ? '' : `; the downloaded ${keptModels.join(', ')} was kept, so the next run does not download it again`;
  const message = rolledBack
    ? `${cause.message} - the install was rolled back${kept === '' ? ' and nothing was changed' : kept}`
    : `${cause.message} - the rollback did not finish: ${rollbackProblems.join('; ')}${kept}`;
  return new CliError(message, {
    exitCode: base?.exitCode ?? EXIT.RUNTIME,
    code: base?.code ?? 'install_failed',
    data: { ...base?.data, rolledBack, rollbackProblems, keptModels: [...keptModels] },
    hint: rolledBack ? 'Fix the reason above and run setup again.' : 'Run doctor and remove the listed leftovers by hand before running setup again.',
    cause,
  });
}

/**
 * @param {ApplyIo} io
 * @returns {import('./external.js').ModelInstaller}
 */
function requireModels(io) {
  if (!io.models) throw new TypeError('A model operation needs a model installer');
  return io.models;
}

/**
 * @param {AbortSignal | undefined} signal
 */
function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  throw new CliError('Interrupted', { exitCode: EXIT.INTERRUPTED, code: 'interrupted' });
}

/**
 * @param {string} target
 * @returns {Promise<Buffer | null>}
 */
async function readIfPresent(target) {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string | Uint8Array} content
 * @returns {Buffer}
 */
function toBuffer(content) {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}
