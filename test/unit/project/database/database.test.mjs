import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { discoverComponents, walkTree } from '../../../../src/project/discover.js';
import { readComposeServices } from '../../../../src/project/compose.js';
import { detectDatabase, findEfCoreDatabases, findPlainSqlDatabases, isDatabaseImage, withoutBlocks } from '../../../../src/project/components/database.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\db-tests' : '/db-tests';

/** Every credential-shaped value in the trees below, so a leak is a substring search away. */
const CANARY = 'OCU-TEST-DB-SECRET';

/**
 * @param {Record<string, string | null>} tree
 * @param {{ declaredBy: string, dir?: string, tool?: any, compose?: any, maxEnvKeys?: number }} options
 */
function detect(tree, { declaredBy, dir, tool, compose, maxEnvKeys }) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const walk = walkTree(view, ROOT);
  const budget = createReadBudget(view, ROOT);
  const resolvedDir = dir ?? (declaredBy.includes('/') ? declaredBy.slice(0, declaredBy.lastIndexOf('/')) : '');
  const facts = detectDatabase(budget, { dir: resolvedDir, declaredBy, tool, files: walk.files, dirs: walk.dirs, compose, ...(maxEnvKeys === undefined ? {} : { maxEnvKeys }) });
  return { facts, budget, walk };
}

describe('Prisma, both generations (claim B15)', () => {
  const schema = ['generator client {', '  provider = "client"', '}', '', 'datasource db {', '  provider = "postgresql"', `  url      = env("DATABASE_URL")`, '}', '', 'model Player {', '  id String @id', '}', '', 'model Season {', '  id String @id', '}'].join('\n');

  it('reads ORM 8 by its configuration and contract file', () => {
    const { facts } = detect({ 'prisma.config.ts': 'export default {};', 'contract.prisma': schema, 'prisma/migrations/0001_init/migration.sql': 'create table x();', 'prisma/migrations/0002_scores/migration.sql': 'create table y();' }, { declaredBy: 'prisma.config.ts' });
    assert.equal(facts.tool, 'prisma');
    assert.equal(facts.generation, '8');
    assert.equal(facts.modelCount, 2);
    assert.equal(facts.dialect, 'postgresql');
    assert.deepEqual([facts.migrations.count, facts.migrations.newest], [2, '0002_scores']);
  });

  it('reads the earlier generation by its schema file alone, with migrations beside the schema', () => {
    const { facts } = detect({ 'prisma/schema.prisma': schema, 'prisma/migrations/20240101_init/migration.sql': '', 'prisma/migrations/migration_lock.toml': '' }, { declaredBy: 'prisma/schema.prisma' });
    assert.equal(facts.generation, 'pre-8');
    assert.equal(facts.modelCount, 2);
    assert.deepEqual(facts.schemaFiles, ['prisma/schema.prisma']);
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['prisma/migrations', 1, '20240101_init']);
  });

  it('reports the conventional folder, with a count of zero, when no migrations exist yet', () => {
    const { facts } = detect({ 'schema.prisma': schema }, { declaredBy: 'schema.prisma' });
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['migrations', 0, null]);
  });

  it('records a count, never a model name', () => {
    const { facts } = detect({ 'contract.prisma': schema, 'prisma.config.ts': '' }, { declaredBy: 'contract.prisma' });
    assert.equal(JSON.stringify(facts).includes('Player'), false, 'a schema becomes counts, never DDL (D-B8)');
  });

  it('never copies the connection URL out of the datasource block', () => {
    const { facts } = detect({ 'schema.prisma': schema.replace('env("DATABASE_URL")', `"postgres://user:${CANARY}@host/db"`) }, { declaredBy: 'schema.prisma' });
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
    assert.equal(facts.dialect, 'postgresql');
  });
});

describe('Drizzle: three keys, and dbCredentials is not one of them (claim B16)', () => {
  const config = [
    "import { defineConfig } from 'drizzle-kit';",
    'export default defineConfig({',
    "  dialect: 'postgresql',",
    "  schema: './src/db/schema.ts',",
    "  out: './drizzle',",
    `  dbCredentials: { url: 'postgres://user:${CANARY}@host/db', password: '${CANARY}' },`,
    '});',
  ].join('\n');
  const schema = ["export const players = pgTable('players', {});", "export const scores = pgTable('scores', {});", "export const helper = () => 1;"].join('\n');

  it('reads dialect, schema and out, and counts the tables', () => {
    const { facts } = detect({ 'drizzle.config.ts': config, 'src/db/schema.ts': schema, 'drizzle/0001_init.sql': '', 'drizzle/0009_add_season_scores.sql': '' }, { declaredBy: 'drizzle.config.ts' });
    assert.equal(facts.dialect, 'postgresql');
    assert.deepEqual(facts.schemaFiles, ['src/db/schema.ts']);
    assert.equal(facts.modelCount, 2);
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['drizzle', 2, '0009_add_season_scores.sql']);
  });

  it('copies nothing out of dbCredentials, in any form', () => {
    const { facts } = detect({ 'drizzle.config.ts': config }, { declaredBy: 'drizzle.config.ts' });
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
  });

  it('cannot see a requested key that sits inside dbCredentials', () => {
    const hostile = ['export default {', `  dbCredentials: { schema: '${CANARY}', ssl: { out: '${CANARY}' } },`, "  dialect: 'postgresql',", '};'].join('\n');
    const { facts } = detect({ 'drizzle.config.ts': hostile }, { declaredBy: 'drizzle.config.ts' });
    assert.equal(facts.dialect, 'postgresql');
    assert.deepEqual(facts.schemaFiles, []);
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
  });

  it('records the declaring file behind the summary', () => {
    const { facts } = detect({ 'drizzle.config.js': config }, { declaredBy: 'drizzle.config.js' });
    assert.ok(facts.evidence.some((entry) => entry.signature === 'db/overlay.drizzle-config' && entry.file === 'drizzle.config.js'));
  });
});

describe('credential blocks are cut out before any key is matched', () => {
  it('removes a nested block with its braces balanced, and every occurrence of it', () => {
    const text = "a: 1,\ndbCredentials: { url: 'x', ssl: { ca: 'y' } },\nb: 2,\ndbCredentials: { url: 'z' }\nc: 3";
    assert.equal(withoutBlocks(text, ['dbCredentials']), 'a: 1,\n,\nb: 2,\n\nc: 3');
  });

  it('removes a value that is not a block up to the end of its line', () => {
    assert.equal(withoutBlocks("connection: 'postgres://x',\nmigrations: { directory: './m' }", ['connection']), "\nmigrations: { directory: './m' }");
  });

  it('removes everything after a block that is never closed, which is the safe direction', () => {
    assert.equal(withoutBlocks("dialect: 'pg',\ndbCredentials: { url: 'x',\nschema: './s.ts'", ['dbCredentials']), "dialect: 'pg',\n");
  });

  it('leaves a key that only starts with a credential name alone', () => {
    assert.equal(withoutBlocks('connectionTimeout: 5,', ['connection']), 'connectionTimeout: 5,');
  });
});

describe('Knex: the migrations directory, and nothing under connection', () => {
  const knexfile = [
    'module.exports = {',
    '  development: {',
    "    client: 'pg',",
    `    connection: { host: 'db.internal', password: '${CANARY}' },`,
    "    migrations: { directory: './db/migrations' },",
    '  },',
    '};',
  ].join('\n');

  it('records the directory when it is a literal', () => {
    const { facts } = detect({ 'knexfile.js': knexfile, 'db/migrations/001_init.sql': '', 'db/migrations/002_scores.sql': '' }, { declaredBy: 'knexfile.js' });
    assert.equal(facts.tool, 'knex');
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['db/migrations', 2, '002_scores.sql']);
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
  });

  it('cannot see a migrations block nested inside connection, or a connection string on one line', () => {
    const hostile = ['module.exports = {', `  connection: { migrations: { directory: '${CANARY}' } },`, `  staging: { connection: 'postgres://user:${CANARY}@host/db' },`, '};'].join('\n');
    const { facts } = detect({ 'knexfile.js': hostile }, { declaredBy: 'knexfile.js' });
    assert.equal(facts.migrations.dir, 'migrations');
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
  });

  it('falls back to the default folder when the directory is not a literal', () => {
    const { facts } = detect({ 'knexfile.ts': 'export default { migrations: { directory: resolve(__dirname) } };', 'migrations/001_init.sql': '' }, { declaredBy: 'knexfile.ts' });
    assert.equal(facts.migrations.dir, 'migrations');
    assert.equal(facts.migrations.count, 1);
  });
});

describe('Supabase: local ports from the sections that have them (claims B17, B18)', () => {
  const config = [
    'project_id = "sample"',
    '[api]',
    'enabled = true',
    'port = 54321',
    '[db]',
    'port = 54322',
    '[studio]',
    'port = 54323',
    '[auth.external.github]',
    'enabled = true',
    'port = 9999',
    `secret = "${CANARY}"`,
  ].join('\n');

  it('reads the three local ports and ignores a port under any other section', () => {
    const { facts } = detect({ 'supabase/config.toml': config, 'supabase/migrations/20240101000000_init.sql': '', 'supabase/migrations/20240202000000_scores.sql': '' }, { declaredBy: 'supabase/config.toml', dir: '' });
    assert.deepEqual(facts.ports, { api: 54321, db: 54322, studio: 54323 });
    assert.equal(JSON.stringify(facts).includes('9999'), false, 'a port under an auth section is not a local development port');
    assert.equal(JSON.stringify(facts).includes(CANARY), false);
  });

  it('counts the migrations and names the newest, without opening one', () => {
    const { facts, budget } = detect({ 'supabase/config.toml': config, 'supabase/migrations/20240101000000_init.sql': 'create table x();', 'supabase/migrations/20240202000000_scores.sql': 'create table y();' }, { declaredBy: 'supabase/config.toml', dir: '' });
    assert.deepEqual([facts.migrations.count, facts.migrations.newest], [2, '20240202000000_scores.sql']);
    assert.deepEqual(budget.state.opened, ['supabase/config.toml']);
    assert.ok(facts.evidence.some((entry) => entry.signature === 'db/migrations.supabase'));
  });

  it('is local when it declares local ports', () => {
    const { facts } = detect({ 'supabase/config.toml': config }, { declaredBy: 'supabase/config.toml', dir: '' });
    assert.equal(facts.placement, 'local');
    assert.equal(facts.placementBasis, 'supabase/config.toml declares local ports');
  });
});

describe('EF Core: a Migrations folder beside a project that references it (claim B19)', () => {
  const tree = {
    'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'Api/Migrations/20240101_Init.cs': '',
    'Api/Migrations/20240101_Init.Designer.cs': '',
    'Api/Migrations/20240202_Scores.cs': '',
    'Api/Migrations/AppDbContextModelSnapshot.cs': '',
  };

  it('counts migrations without their designer partials or the model snapshot', () => {
    const { facts } = detect(tree, { declaredBy: 'Api/Migrations', dir: 'Api', tool: 'ef-core' });
    assert.deepEqual([facts.migrations.count, facts.migrations.newest], [2, '20240202_Scores.cs']);
    assert.ok(facts.evidence.some((entry) => entry.signature === 'dotnet/migrations.efcore'));
  });

  it('is declared only when the project actually references EF Core', () => {
    const { walk } = detect(tree, { declaredBy: 'Api/Migrations', dir: 'Api', tool: 'ef-core' });
    const withReference = findEfCoreDatabases({ files: walk.files, dirs: walk.dirs, projects: [{ dir: 'Api', declaredBy: 'Api/Api.csproj', efCore: true }] });
    const without = findEfCoreDatabases({ files: walk.files, dirs: walk.dirs, projects: [{ dir: 'Api', declaredBy: 'Api/Api.csproj', efCore: false }] });
    assert.deepEqual(withReference, [{ tool: 'ef-core', dir: 'Api', declaredBy: 'Api/Migrations', discriminator: 'ef-core', referencedBy: 'Api/Api.csproj' }]);
    assert.deepEqual(without, []);
  });

  it('returns several in a stable order, whatever order the projects arrive in', () => {
    const { walk } = detect({ 'B/Migrations/1_Init.cs': '', 'A/Migrations/1_Init.cs': '' }, { declaredBy: 'A/Migrations', dir: 'A', tool: 'ef-core' });
    const found = findEfCoreDatabases({ files: walk.files, dirs: walk.dirs, projects: [{ dir: 'B', declaredBy: 'B/B.csproj', efCore: true }, { dir: 'A', declaredBy: 'A/A.csproj', efCore: true }] });
    assert.deepEqual(found.map((entry) => entry.declaredBy), ['A/Migrations', 'B/Migrations']);
  });

  it('is not declared by an empty Migrations folder', () => {
    const { walk } = detect({ 'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />', 'Api/Migrations': null }, { declaredBy: 'Api/Migrations', dir: 'Api', tool: 'ef-core' });
    assert.deepEqual(findEfCoreDatabases({ files: walk.files, dirs: walk.dirs, projects: [{ dir: 'Api', declaredBy: 'Api/Api.csproj', efCore: true }] }), []);
  });
});

describe('a plain SQL folder that no ORM claims', () => {
  it('is found, and only when it holds SQL', () => {
    const { walk } = detect({ 'db/migrations/001_init.sql': '', 'docs/notes/readme.md': '', 'sql/seed.sql': '' }, { declaredBy: 'db/migrations', dir: 'db', tool: 'sql' });
    assert.deepEqual(findPlainSqlDatabases({ files: walk.files, dirs: walk.dirs }), [
      { tool: 'sql', dir: 'db', declaredBy: 'db/migrations', discriminator: 'sql' },
      { tool: 'sql', dir: '', declaredBy: 'sql', discriminator: 'sql' },
    ]);
  });

  it('leaves a folder an ORM already owns alone', () => {
    const { walk } = detect({ 'drizzle/0001_init.sql': '', 'migrations/001_init.sql': '' }, { declaredBy: 'migrations', dir: '', tool: 'sql' });
    assert.deepEqual(findPlainSqlDatabases({ files: walk.files, dirs: walk.dirs, claimed: ['migrations'] }), []);
  });
});

describe('local, hosted or unknown - decided from these facts alone', () => {
  it('is local when a compose service runs a database image', () => {
    const tree = { 'drizzle.config.ts': "export default { dialect: 'postgresql' };", 'compose.yaml': ['services:', '  db:', '    image: postgres:17', '    ports:', '      - "54329:5432"'].join('\n') };
    const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
    const walk = walkTree(view, ROOT);
    const budget = createReadBudget(view, ROOT);
    const compose = readComposeServices(budget, { files: walk.files });
    const facts = detectDatabase(budget, { dir: '', declaredBy: 'drizzle.config.ts', files: walk.files, dirs: walk.dirs, compose });
    assert.equal(facts.placement, 'local');
    assert.equal(facts.placementBasis, 'compose service "db"');
  });

  it('is hosted when the only evidence is a connection key name', () => {
    const { facts } = detect({ 'drizzle.config.ts': "export default { dialect: 'postgresql' };", '.env.example': 'DATABASE_URL=\nPORT=' }, { declaredBy: 'drizzle.config.ts' });
    assert.equal(facts.placement, 'hosted');
    assert.deepEqual(facts.envKeys, ['DATABASE_URL', 'PORT']);
  });

  it('is unknown when nothing says either way', () => {
    const { facts } = detect({ 'drizzle.config.ts': "export default { dialect: 'sqlite' };", '.env.example': 'PORT=\nLOG_LEVEL=' }, { declaredBy: 'drizzle.config.ts' });
    assert.equal(facts.placement, 'unknown');
    assert.equal(facts.placementBasis, null);
  });

  it('recognises a database image through a registry prefix and a tag, and nothing else', () => {
    assert.equal(isDatabaseImage('postgres:17'), true);
    assert.equal(isDatabaseImage('mirror.example.test/library/postgres:17-alpine'), true);
    assert.equal(isDatabaseImage('redis'), true);
    assert.equal(isDatabaseImage('sample/gameserver:dev'), false);
    assert.equal(isDatabaseImage(null), false);
  });
});

describe('an overlay that cannot be described is dropped, not guessed (P7)', () => {
  it('is unreadable, with nothing else stated, when its declaring file cannot be opened', () => {
    for (const declaredBy of ['drizzle.config.ts', 'knexfile.js', 'supabase/config.toml', 'schema.prisma']) {
      const view = createMemoryFsView({ [path.join(ROOT, 'drizzle/0001_init.sql')]: '' });
      const budget = createReadBudget(view, ROOT);
      const facts = detectDatabase(budget, { dir: '', declaredBy, files: ['drizzle/0001_init.sql'], dirs: ['drizzle'] });
      assert.equal(facts.status, 'unreadable', declaredBy);
      assert.deepEqual(facts.warnings, ['component.unreadable', 'db.migrations-state-unknown'], declaredBy);
      assert.deepEqual([facts.migrations.count, facts.envKeys, facts.placement], [0, [], 'unknown'], declaredBy);
    }
  });

  it('is unbudgeted, not unreadable, when the workspace budget is spent', () => {
    const view = createMemoryFsView({ [path.join(ROOT, 'drizzle.config.ts')]: "export default { dialect: 'postgresql' };" });
    const budget = createReadBudget(view, ROOT, { limits: { filesPerComponent: 0 } });
    const facts = detectDatabase(budget, { dir: '', declaredBy: 'drizzle.config.ts', files: ['drizzle.config.ts'] });
    assert.equal(facts.status, 'unbudgeted');
    assert.deepEqual(facts.warnings, ['db.migrations-state-unknown']);
  });

  it('is described from the listing alone when a folder declares it', () => {
    const { facts, budget } = detect({ 'sql/001_init.sql': 'create table x();', 'sql/002_scores.sql': 'create table y();' }, { declaredBy: 'sql', dir: '', tool: 'sql' });
    assert.equal(facts.status, 'ok');
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['sql', 2, '002_scores.sql']);
    assert.deepEqual(budget.state.opened, []);
  });
});

describe('the state of a migration is never assumed', () => {
  it('reports db.migrations-state-unknown whenever the overlay exists (D-B14)', () => {
    for (const declaredBy of ['schema.prisma', 'drizzle.config.ts', 'knexfile.js']) {
      const { facts } = detect({ [declaredBy]: '' }, { declaredBy });
      assert.ok(facts.warnings.includes('db.migrations-state-unknown'), declaredBy);
    }
  });
});

describe('the committed fixture', () => {
  it('describes the Drizzle overlay of the standalone service', () => {
    const root = path.join(WORKSPACES, 'standalone-node-service');
    const discovery = discoverComponents(createNodeFsView(), root);
    const overlay = discovery.overlays.find((component) => component.kind === 'database');
    assert.ok(overlay);

    const compose = readComposeServices(discovery.budget, { files: discovery.walk.files });
    const facts = detectDatabase(discovery.budget, { dir: overlay.dir, declaredBy: overlay.declaredBy, files: discovery.walk.files, dirs: discovery.walk.dirs, compose });

    assert.equal(facts.tool, 'drizzle');
    assert.equal(facts.dialect, 'postgresql');
    assert.deepEqual(facts.schemaFiles, ['src/db/schema.ts']);
    assert.deepEqual([facts.migrations.dir, facts.migrations.count, facts.migrations.newest], ['drizzle', 2, '0009_add_season_scores.sql']);
    assert.deepEqual(facts.envKeys, ['DATABASE_URL', 'DIRECT_URL', 'FEATURE_FLAGS', 'LOG_LEVEL', 'PORT', 'SEASON_ID']);
    assert.equal(facts.placement, 'local');
    assert.equal(JSON.stringify(facts).includes('CANARY'), false);
    for (const opened of discovery.budget.state.opened) assert.doesNotMatch(opened, /\.env$|\.sql$/i, `${opened} must not be opened`);
  });
});
