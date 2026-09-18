// The `database` overlay detector (amendment 37.3-37.4, `D-B8`, `D-B14`, area 14.6.6, 14.9.5).
//
// One rule governs the whole module: **a schema becomes counts, never DDL** (`D-B8`). A forty-table
// schema is several thousand tokens and would evict the Unity facts it shares a 2,600-character budget
// with, so what survives a read here is a number, a folder name and the newest migration's name. The
// fuller listing exists, but only in `doctor --schema`, which prints to the terminal and never into a
// prompt.
//
// The second rule is negative and is what the canary test proves: a connection string is never read.
// Every configuration this module opens is opened for two or three named keys - Drizzle's `dialect`,
// `schema` and `out`, Knex's migrations `directory`, Supabase's local ports - and `dbCredentials`, a
// `connection` block, an `[auth.external.*]` section and `appsettings*.json` are never among them. The
// dialect a model needs is already in the ORM configuration, so there is no reason to open a `.env`
// for it (`D-B7`); `.env.example` key **names** are the one exception and they come from `envexample.js`.
//
// Migrations are listed and never opened, because the filesystem cannot tell whether one has been
// applied to any database (`D-B14`). That is also why `db.migrations-state-unknown` is emitted every
// time this overlay exists, rather than only when something looks wrong.
import { evidenceRow } from '../signatures.js';
import { readEnvExampleKeys } from '../envexample.js';
import { joinInsideWorkspace } from '../entry.js';

/** @typedef {'prisma' | 'drizzle' | 'knex' | 'supabase' | 'ef-core' | 'sql'} DatabaseTool */

/** The declaring file of each tool, and the signature row that names it. */
export const DATABASE_DECLARING_FILES = Object.freeze([
  { tool: /** @type {const} */ ('prisma'), fileName: 'prisma.config.ts', signature: 'db/overlay.prisma-config' },
  { tool: /** @type {const} */ ('prisma'), fileName: 'contract.prisma', signature: 'db/overlay.prisma-contract' },
  { tool: /** @type {const} */ ('prisma'), fileName: 'schema.prisma', signature: 'db/overlay.prisma-schema' },
  { tool: /** @type {const} */ ('drizzle'), fileName: 'drizzle.config.ts', signature: 'db/overlay.drizzle-config' },
  { tool: /** @type {const} */ ('drizzle'), fileName: 'drizzle.config.js', signature: 'db/overlay.drizzle-config' },
  { tool: /** @type {const} */ ('knex'), fileName: 'knexfile.js', signature: 'db/overlay.knexfile' },
  { tool: /** @type {const} */ ('knex'), fileName: 'knexfile.ts', signature: 'db/overlay.knexfile' },
  { tool: /** @type {const} */ ('supabase'), fileName: 'supabase/config.toml', signature: 'db/overlay.supabase-config' },
]);

/** Prisma ORM 8 renames the schema and moves configuration into `prisma.config.ts` (claim B15). */
export const PRISMA_8_FILES = Object.freeze(['prisma.config.ts', 'contract.prisma']);

/** Default migration folders, relative to the component, when the configuration names none. */
const DEFAULT_MIGRATION_DIRS = Object.freeze({
  prisma: 'prisma/migrations',
  drizzle: 'drizzle',
  knex: 'migrations',
  supabase: 'supabase/migrations',
  'ef-core': 'Migrations',
});

/** EF Core writes a designer partial per migration and one model snapshot; neither is a migration. */
const EF_CORE_NON_MIGRATIONS = /(\.Designer\.cs|ModelSnapshot\.cs)$/i;

/** Only these three keys are taken from a Drizzle configuration. `dbCredentials` is not one of them. */
const DRIZZLE_KEYS = Object.freeze(['dialect', 'schema', 'out']);

/**
 * Blocks that hold connection details. They are cut out of the text **before** any key is matched,
 * so a `schema` or a `directory` that happens to sit inside one - where a hostile or merely unusual
 * configuration could put a credential - is not a key this module can see at all.
 */
const CREDENTIAL_BLOCKS = Object.freeze(['dbCredentials', 'connection']);

/** Supabase sections whose `port` is a local development port (claim B17). */
const SUPABASE_PORT_SECTIONS = Object.freeze(['api', 'db', 'studio']);

/** `model Name {` in a Prisma schema; the count is the fact, the names are not. */
const PRISMA_MODEL_PATTERN = /^\s*model\s+[A-Za-z_][\w]*\s*\{/;

/** A Drizzle table declaration, for the same count-only summary. */
const DRIZZLE_TABLE_PATTERN = /\b(?:pg|mysql|sqlite)Table\s*\(/g;

/**
 * Environment **key names** that mean "this database lives somewhere else". Names only: a value is
 * never read, so a host name is never known, never resolved and never written to a fact.
 */
const HOSTED_KEY_PATTERNS = Object.freeze([/^DATABASE_URL$/, /^DIRECT_URL$/, /^POSTGRES_/, /^PG[A-Z_]*$/, /^MYSQL_/, /^MONGO/, /^REDIS_URL$/, /^SUPABASE_/]);

/**
 * Docker Official Image names, used for one purpose: deciding that a compose service is a local
 * database. No version, API or behaviour is claimed about any of them, and nothing is read out of the
 * service beyond its image name and its published port.
 */
export const DATABASE_IMAGE_PREFIXES = Object.freeze(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);

/**
 * @typedef {object} MigrationSummary
 * @property {string | null} dir
 * @property {number} count
 * @property {string | null} newest   The newest entry's name. Listed, never opened.
 */

/**
 * @typedef {object} DatabaseFacts
 * @property {'ok' | 'unreadable' | 'unbudgeted'} status
 * @property {string} dir
 * @property {string} declaredBy
 * @property {DatabaseTool} tool
 * @property {string | null} generation   Prisma only: `8` or `pre-8` (claim B15).
 * @property {string | null} dialect
 * @property {string[]} schemaFiles       Paths the configuration names, resolved inside the workspace.
 * @property {number | null} modelCount   A count, never a model name (`D-B8`).
 * @property {MigrationSummary} migrations
 * @property {Record<string, number>} ports  Local development ports the configuration declares.
 * @property {string[]} envKeys           `.env.example` key names, at most the configured cap.
 * @property {number} envKeyTotal
 * @property {string | null} envFile
 * @property {'local' | 'hosted' | 'unknown'} placement
 * @property {string | null} placementBasis  What decided the verdict, in one phrase.
 * @property {import('../signatures.js').EvidenceEntry[]} evidence
 * @property {string[]} warnings
 */

/**
 * @param {string} dir
 * @param {string} declaredBy
 * @param {DatabaseTool} tool
 * @returns {DatabaseFacts}
 */
function emptyFacts(dir, declaredBy, tool) {
  return {
    status: 'ok',
    dir,
    declaredBy,
    tool,
    generation: null,
    dialect: null,
    schemaFiles: [],
    modelCount: null,
    migrations: { dir: null, count: 0, newest: null },
    ports: {},
    envKeys: [],
    envKeyTotal: 0,
    envFile: null,
    placement: 'unknown',
    placementBasis: null,
    // Always, whenever this overlay exists: the filesystem cannot know what has been applied to any
    // database, and mtime is not a fact about one (`D-B14`).
    warnings: ['db.migrations-state-unknown'],
    evidence: [],
  };
}

/**
 * @param {import('../budget.js').ReadBudget} budget
 * @param {object} options
 * @param {string} options.dir                 The component folder, relative to the workspace root.
 * @param {string} options.declaredBy          The declaring file, relative to the workspace root.
 * @param {DatabaseTool} [options.tool]        Derived from `declaredBy` when omitted.
 * @param {readonly string[]} [options.files]
 * @param {readonly string[]} [options.dirs]
 * @param {import('../compose.js').ComposeFacts} [options.compose]
 * @param {string} [options.component]
 * @param {number} [options.maxEnvKeys]
 * @returns {DatabaseFacts}
 */
export function detectDatabase(budget, { dir, declaredBy, tool, files = [], dirs = [], compose, component = `db:${dir}`, maxEnvKeys }) {
  const declaring = DATABASE_DECLARING_FILES.find((row) => declaredBy.endsWith(row.fileName));
  const resolvedTool = tool ?? declaring?.tool ?? 'sql';
  const facts = emptyFacts(dir, declaredBy, resolvedTool);
  if (declaring !== undefined) facts.evidence.push(evidenceRow('overlay', declaring.signature, declaredBy));
  else facts.evidence.push(evidenceRow('overlay', 'spec:37.3', declaredBy));

  // P7: a component whose declaring file cannot be read is dropped, not guessed - it gets no rules and
  // never falls back to another kind's.
  const read = readConfiguration(facts, budget, files, component);
  if (read === 'unreadable' || read === 'unbudgeted') {
    facts.status = read;
    if (read === 'unreadable') facts.warnings.unshift('component.unreadable');
    return facts;
  }

  if (facts.migrations.dir === null) facts.migrations.dir = migrationsDirFor(facts, dirs);
  summariseMigrations(facts, files, dirs);

  const env = readEnvExampleKeys(budget, { dir, component, ...(maxEnvKeys === undefined ? {} : { maxKeys: maxEnvKeys }) });
  facts.envKeys = env.keys;
  facts.envKeyTotal = env.total;
  facts.envFile = env.file;
  facts.evidence.push(...env.evidence);

  decidePlacement(facts, compose);
  return facts;
}

/**
 * The one configuration read each tool needs. An EF Core or plain-SQL overlay is declared by a folder,
 * so there is nothing to read and nothing to fail to read.
 * @param {DatabaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} files
 * @param {string} component
 * @returns {ReadOutcome}
 */
function readConfiguration(facts, budget, files, component) {
  switch (facts.tool) {
    case 'prisma':
      return readPrisma(facts, budget, files, component);
    case 'drizzle':
      return readDrizzle(facts, budget, files, component);
    case 'knex':
      return readKnex(facts, budget, component);
    case 'supabase':
      return readSupabase(facts, budget, component);
    default:
      return 'ok';
  }
}

/**
 * Both generations (claim B15). The schema is opened for one number - how many models it declares -
 * and nothing that is in it is copied out.
 * @param {DatabaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} files
 * @param {string} component
 * @returns {ReadOutcome}
 */
function readPrisma(facts, budget, files, component) {
  const modern = PRISMA_8_FILES.some((name) => files.includes(joinRelative(facts.dir, name)) || facts.declaredBy.endsWith(name));
  facts.generation = modern ? '8' : 'pre-8';

  for (const candidate of [joinRelative(facts.dir, 'contract.prisma'), joinRelative(facts.dir, 'schema.prisma'), joinRelative(facts.dir, 'prisma/schema.prisma'), facts.declaredBy]) {
    if (!candidate.endsWith('.prisma') || !files.includes(candidate) || facts.schemaFiles.includes(candidate)) continue;
    facts.schemaFiles.push(candidate);
  }
  facts.schemaFiles.sort();

  const schema = facts.schemaFiles[0];
  // ORM 8 declares the component with `prisma.config.ts`, which this product does not execute and
  // does not read: the schema beside it is where the counts come from.
  if (schema === undefined) return facts.declaredBy.endsWith('.prisma') ? 'unreadable' : 'ok';
  const read = budget.readText(schema, { component });
  if (read.status !== 'ok') return outcomeOf(read.status);
  facts.modelCount = countLines(read.text ?? '', PRISMA_MODEL_PATTERN);
  facts.dialect = providerOf(read.text ?? '');
  facts.evidence.push(evidenceRow('schema', 'spec:37.4', schema));
  return 'ok';
}

/**
 * The `datasource` block's `provider` is a literal dialect name, not a credential; the `url` beside it
 * is a credential and is never matched. The block is found first, because a `generator` block also
 * has a `provider` and it names a client, not a database.
 * @param {string} text
 * @returns {string | null}
 */
function providerOf(text) {
  const block = /^\s*datasource\s+\w+\s*\{([^}]*)\}/m.exec(text)?.[1];
  if (block === undefined) return null;
  return /^\s*provider\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(block)?.[1] ?? null;
}

/**
 * `dialect`, `schema` and `out` (claim B16), read key by key so that `dbCredentials` cannot be
 * reached even by accident.
 * @param {DatabaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} files
 * @param {string} component
 * @returns {ReadOutcome}
 */
function readDrizzle(facts, budget, files, component) {
  const read = budget.readText(facts.declaredBy, { component });
  if (read.status !== 'ok') return outcomeOf(read.status);
  const text = withoutBlocks(read.text ?? '', CREDENTIAL_BLOCKS);

  const values = Object.fromEntries(DRIZZLE_KEYS.map((key) => [key, literalValue(text, key)]));
  facts.dialect = values.dialect;
  const schema = values.schema === null ? null : joinInsideWorkspace(facts.dir, values.schema);
  if (schema !== null) facts.schemaFiles.push(schema);
  const out = values.out === null ? null : joinInsideWorkspace(facts.dir, values.out);
  if (out !== null) facts.migrations.dir = out;

  if (schema !== null && files.includes(schema)) {
    const schemaRead = budget.readText(schema, { component });
    if (schemaRead.status === 'ok') facts.modelCount = countMatches(schemaRead.text ?? '', DRIZZLE_TABLE_PATTERN);
  }
  facts.evidence.push(evidenceRow('schema', 'spec:37.4', facts.declaredBy));
  return 'ok';
}

/**
 * That Knex is in use, and the migrations directory when it is a literal. Every value under
 * `connection` is ignored, which is why the pattern is anchored to the `migrations` block.
 * @param {DatabaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {string} component
 * @returns {ReadOutcome}
 */
function readKnex(facts, budget, component) {
  const read = budget.readText(facts.declaredBy, { component });
  if (read.status !== 'ok') return outcomeOf(read.status);
  const text = withoutBlocks(read.text ?? '', CREDENTIAL_BLOCKS);
  const directory = /migrations\s*:\s*\{[^{}]*directory\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
  if (directory === undefined) return 'ok';
  const resolved = joinInsideWorkspace(facts.dir, directory);
  if (resolved !== null) facts.migrations.dir = resolved;
  return 'ok';
}

/**
 * The local ports `supabase init` writes (claim B17). The section header decides what is read, so a
 * `port` under `[auth.external.github]` - or under any section that is not one of the three - is not
 * matched at all, and no other key is ever taken.
 * @param {DatabaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {string} component
 * @returns {ReadOutcome}
 */
function readSupabase(facts, budget, component) {
  const read = budget.readText(facts.declaredBy, { component });
  if (read.status !== 'ok') return outcomeOf(read.status);

  let section = '';
  for (const rawLine of (read.text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header !== null) {
      section = header[1].trim();
      continue;
    }
    if (!SUPABASE_PORT_SECTIONS.includes(section)) continue;
    const port = /^port\s*=\s*(\d{1,5})\b/.exec(line)?.[1];
    if (port === undefined) continue;
    const value = Number(port);
    if (value > 0 && value < 65_536) facts.ports[section] = value;
  }
  if (Object.keys(facts.ports).length > 0) facts.evidence.push(evidenceRow('port', 'db/overlay.supabase-config', facts.declaredBy));
  return 'ok';
}

/** @typedef {'ok' | 'unreadable' | 'unbudgeted'} ReadOutcome */

/**
 * @param {import('../budget.js').ReadResult['status']} status  Anything but `ok`.
 * @returns {ReadOutcome}
 */
function outcomeOf(status) {
  return status === 'unbudgeted' ? 'unbudgeted' : 'unreadable';
}

/**
 * The migrations folder when the configuration names none, or names it somewhere this module does
 * not read (`prisma.config.ts` is TypeScript and is never executed).
 * @param {DatabaseFacts} facts
 * @param {readonly string[]} dirs
 * @returns {string}
 */
function migrationsDirFor(facts, dirs) {
  // A plain SQL overlay is declared by the folder of migrations itself.
  if (facts.tool === 'sql') return facts.declaredBy;
  if (facts.tool !== 'prisma') return joinRelative(facts.dir, DEFAULT_MIGRATION_DIRS[facts.tool]);

  // Prisma keeps `migrations/` beside the schema file, and the schema conventionally lives in
  // `prisma/` - so the first folder that exists wins, and the conventional one is reported otherwise.
  const schema = facts.schemaFiles[0] ?? facts.declaredBy;
  const schemaFolder = schema.includes('/') ? schema.slice(0, schema.lastIndexOf('/')) : '';
  const candidates = [...new Set([joinRelative(schemaFolder, 'migrations'), joinRelative(facts.dir, DEFAULT_MIGRATION_DIRS.prisma), joinRelative(facts.dir, 'migrations')])];
  return candidates.find((candidate) => dirs.includes(candidate)) ?? candidates[0];
}

/**
 * Count, and the newest entry's name. Migration files live in one folder as either `.sql` files or, in
 * the Prisma layout, one folder per migration; both are listed from the walk and neither is opened.
 * @param {DatabaseFacts} facts
 * @param {readonly string[]} files
 * @param {readonly string[]} dirs
 */
function summariseMigrations(facts, files, dirs) {
  const dir = facts.migrations.dir;
  if (dir === null) return;

  const names = childNames(files, dir).filter((name) => (facts.tool === 'ef-core' ? name.toLowerCase().endsWith('.cs') && !EF_CORE_NON_MIGRATIONS.test(name) : name.toLowerCase().endsWith('.sql')));
  const folders = names.length > 0 ? [] : childNames(dirs, dir);
  const entries = (names.length > 0 ? names : folders).sort();

  facts.migrations.count = entries.length;
  facts.migrations.newest = entries.at(-1) ?? null;
  if (entries.length > 0) facts.evidence.push(evidenceRow('migrations', migrationSignature(facts.tool), dir));
}

/**
 * @param {DatabaseTool} tool
 * @returns {string}
 */
function migrationSignature(tool) {
  if (tool === 'supabase') return 'db/migrations.supabase';
  if (tool === 'drizzle') return 'db/migrations.drizzle';
  if (tool === 'ef-core') return 'dotnet/migrations.efcore';
  return 'spec:37.4';
}

/**
 * A local database is one this repository defines: a Supabase local stack, or a compose service on a
 * database image. Otherwise, an environment **key name** that asks for a connection string means the
 * database is somewhere else, and nothing else here can tell - which is what `unknown` is for.
 * @param {DatabaseFacts} facts
 * @param {import('../compose.js').ComposeFacts | undefined} compose
 */
function decidePlacement(facts, compose) {
  if (facts.tool === 'supabase' && Object.keys(facts.ports).length > 0) {
    facts.placement = 'local';
    facts.placementBasis = 'supabase/config.toml declares local ports';
    return;
  }

  const service = (compose?.services ?? []).find((entry) => isDatabaseImage(entry.image));
  if (service !== undefined) {
    facts.placement = 'local';
    facts.placementBasis = `compose service "${service.name}"`;
    return;
  }

  if (facts.envKeys.some((key) => HOSTED_KEY_PATTERNS.some((pattern) => pattern.test(key)))) {
    facts.placement = 'hosted';
    facts.placementBasis = 'a connection key name, with no local definition';
  }
}

/**
 * @param {string | null} image
 * @returns {boolean}
 */
export function isDatabaseImage(image) {
  if (image === null) return false;
  const name = image.split('/').at(-1)?.split(':')[0]?.toLowerCase() ?? '';
  return DATABASE_IMAGE_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
}

/**
 * The EF Core case of 37.3: a `Migrations/` folder beside a project that references EF Core. It is
 * the one database overlay no single file declares, so discovery cannot find it by name and the
 * composer asks for it here.
 * @param {object} options
 * @param {readonly string[]} options.files
 * @param {readonly string[]} options.dirs
 * @param {ReadonlyArray<{ dir: string, declaredBy: string, efCore: boolean }>} options.projects
 * @returns {Array<{ tool: 'ef-core', dir: string, declaredBy: string, discriminator: string, referencedBy: string }>}
 */
export function findEfCoreDatabases({ files, dirs, projects }) {
  /** @type {Array<{ tool: 'ef-core', dir: string, declaredBy: string, discriminator: string, referencedBy: string }>} */
  const found = [];
  for (const project of projects) {
    if (!project.efCore) continue;
    const migrations = joinRelative(project.dir, 'Migrations');
    if (!dirs.includes(migrations)) continue;
    if (childNames(files, migrations).length === 0) continue;
    found.push({ tool: 'ef-core', dir: project.dir, declaredBy: migrations, discriminator: 'ef-core', referencedBy: project.declaredBy });
  }
  return found.sort((a, b) => (a.declaredBy < b.declaredBy ? -1 : a.declaredBy > b.declaredBy ? 1 : 0));
}

/**
 * A folder of `.sql` files that no ORM configuration claims: a hand-run migration set, which is
 * deny-edit for exactly the reason an ORM's is (`*.sql` is denied wholesale, 37.9).
 * @param {object} options
 * @param {readonly string[]} options.files
 * @param {readonly string[]} options.dirs
 * @param {readonly string[]} [options.claimed]  Migration folders an ORM overlay already owns.
 * @param {number} [options.maxFolders]
 * @returns {Array<{ tool: 'sql', dir: string, declaredBy: string, discriminator: string }>}
 */
export function findPlainSqlDatabases({ files, dirs, claimed = [], maxFolders = 4 }) {
  /** @type {Array<{ tool: 'sql', dir: string, declaredBy: string, discriminator: string }>} */
  const found = [];
  for (const dir of dirs) {
    if (found.length >= maxFolders) break;
    const name = dir.slice(dir.lastIndexOf('/') + 1).toLowerCase();
    if (name !== 'migrations' && name !== 'sql') continue;
    if (claimed.includes(dir)) continue;
    if (childNames(files, dir).filter((child) => child.toLowerCase().endsWith('.sql')).length === 0) continue;
    found.push({ tool: 'sql', dir: dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '', declaredBy: dir, discriminator: 'sql' });
  }
  return found;
}

/**
 * @param {readonly string[]} paths
 * @param {string} dir
 * @returns {string[]} Immediate children of `dir`, by name.
 */
function childNames(paths, dir) {
  const prefix = dir === '' ? '' : `${dir}/`;
  /** @type {string[]} */
  const names = [];
  for (const entry of paths) {
    if (!entry.startsWith(prefix)) continue;
    const name = entry.slice(prefix.length);
    if (name === '' || name.includes('/')) continue;
    names.push(name);
  }
  return names;
}

/**
 * Removes every `<key>: { ... }` block, braces balanced, and a `<key>: <value>` that is not a block up
 * to the end of its line. Linear in the text, and a block left unclosed removes everything after it -
 * the safe direction for a scan whose job is not to see what is inside.
 * @param {string} text
 * @param {readonly string[]} keys
 * @returns {string}
 */
export function withoutBlocks(text, keys) {
  let result = text;
  for (const key of keys) {
    const pattern = new RegExp(`\\b${key}\\s*:`, 'g');
    let output = '';
    let cursor = 0;
    for (let match = pattern.exec(result); match !== null; match = pattern.exec(result)) {
      if (match.index < cursor) continue;
      output += result.slice(cursor, match.index);
      cursor = endOfValue(result, match.index + match[0].length);
      pattern.lastIndex = cursor;
    }
    result = output + result.slice(cursor);
  }
  return result;
}

/**
 * @param {string} text
 * @param {number} start  Just after the key's colon.
 * @returns {number}      The index just after the value.
 */
function endOfValue(text, start) {
  let index = start;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
  if (text[index] !== '{') {
    const newline = text.indexOf('\n', index);
    return newline === -1 ? text.length : newline;
  }
  let depth = 0;
  for (; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/**
 * One key, one string literal. Nothing else in the file is matched, and the credential blocks are gone
 * before this runs, which together keep `dbCredentials` and `connection` unread.
 * @param {string} text
 * @param {string} key
 * @returns {string | null}
 */
function literalValue(text, key) {
  return new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`, 'm').exec(text)?.[1] ?? null;
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {number}
 */
function countLines(text, pattern) {
  let count = 0;
  for (const line of text.split('\n')) if (pattern.test(line)) count += 1;
  return count;
}

/**
 * @param {string} text
 * @param {RegExp} pattern  Global.
 * @returns {number}
 */
function countMatches(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function joinRelative(dir, name) {
  return dir === '' ? name : `${dir}/${name}`;
}
