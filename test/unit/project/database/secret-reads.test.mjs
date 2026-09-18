// The detectors of S53, S55 and S56 against every secret-shaped file at once.
//
// Two properties, stated separately because they are proved differently:
//
// 1. A file that is secret **by its path** is never read into memory. The proof is a spying view that
//    records every path whose content is requested from the filesystem, below the read budget: if
//    `readText` is never called for a path, its content never entered this process. `stat` and
//    `readDir` return names and sizes only, so they carry no content.
// 2. A secret **inside** a configuration that has to be read - a `dbCredentials` block, a compose
//    `environment:` value, a template's value - never survives into the facts. The proof is a canary
//    in every such place and a substring search over everything the detectors return.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView, toPosix } from '../../../../src/unity/fs-view.js';
import { isProtectedReadPath } from '../../../../src/project/budget.js';
import { discoverComponents } from '../../../../src/project/discover.js';
import { detectContainerAndCiFiles, readComposeServices } from '../../../../src/project/compose.js';
import { readEnvExampleKeys } from '../../../../src/project/envexample.js';
import { detectNodeService } from '../../../../src/project/components/node-service.js';
import { detectDotnetService } from '../../../../src/project/components/dotnet-service.js';
import { detectDatabase } from '../../../../src/project/components/database.js';
import { detectGameServer } from '../../../../src/project/components/game-server.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\secret-read-tests' : '/secret-read-tests';

const CANARY = 'OCU-TEST-SECRET-READ';

/**
 * @param {import('../../../../src/unity/fs-view.js').FsView} inner
 * @param {string} root
 */
function spy(inner, root) {
  /** @type {string[]} */
  const contentReads = [];
  /** @type {import('../../../../src/unity/fs-view.js').FsView} */
  const view = {
    stat: (filePath) => inner.stat(filePath),
    readDir: (dirPath) => inner.readDir(dirPath),
    readText: (filePath, options) => {
      contentReads.push(toPosix(path.relative(root, filePath)));
      return inner.readText(filePath, options);
    },
  };
  return { view, contentReads };
}

/**
 * Every detector this step owns, driven the way the composer will drive them: one discovery, then
 * each detector over the components it found.
 * @param {import('../../../../src/unity/fs-view.js').FsView} view
 * @param {string} root
 */
function runEveryDetector(view, root) {
  const discovery = discoverComponents(view, root);
  const { files, dirs } = discovery.walk;
  const budget = discovery.budget;

  const nodeServices = discovery.anchors
    .filter((component) => component.kind === 'node-service')
    .map((component) => detectNodeService(budget, { dir: component.dir, declaredBy: component.declaredBy, manifest: component.manifest, files, workspaceRoot: discovery.workspaceRoot, view, root }));
  const dotnetServices = discovery.anchors
    .filter((component) => component.kind === 'dotnet-service')
    .map((component) => detectDotnetService(budget, { dir: component.dir, declaredBy: component.declaredBy, files }));
  const compose = readComposeServices(budget, { files });
  const databases = discovery.overlays
    .filter((component) => component.kind === 'database')
    .map((component) => detectDatabase(budget, { dir: component.dir, declaredBy: component.declaredBy, files, dirs, compose }));
  const container = detectContainerAndCiFiles(view, root, discovery.walk);
  const env = readEnvExampleKeys(budget, {});
  const gameServer = detectGameServer(budget, {
    nodeServices: nodeServices.map((service) => ({ id: `node:${service.dir}`, dir: service.dir, declaredBy: service.declaredBy, dependencyNames: service.dependencyNames, routes: service.routes })),
    compose,
    files,
    ciFiles: container.files,
  });

  return { discovery, facts: { nodeServices, dotnetServices, compose, databases, container, env, gameServer } };
}

/**
 * @param {Record<string, string>} tree
 */
function memoryWorkspace(tree) {
  return createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
}

/** Every trap the detectors of this step could walk into, with the canary in each. */
const TRAPS = {
  // Secret by path: none of these may ever be read.
  '.env': `DATABASE_URL=postgres://user:${CANARY}@host/db`,
  '.env.local': `API_TOKEN=${CANARY}`,
  'api/.env.production': `API_TOKEN=${CANARY}`,
  '.npmrc': `//registry.example.invalid/:_authToken=${CANARY}`,
  'service-account.json': `{"private_key":"${CANARY}"}`,
  'functions/.runtimeconfig.json': `{"key":"${CANARY}"}`,
  'functions/sample-firebase-adminsdk-x.json': `{"private_key":"${CANARY}"}`,
  'Api/appsettings.json': `{"ConnectionStrings":{"Default":"${CANARY}"}}`,
  'Api/appsettings.Production.json': `{"ConnectionStrings":{"Default":"${CANARY}"}}`,
  'infra/prod.tfvars': `password = "${CANARY}"`,
  'k8s/secrets.yaml': `password: ${CANARY}`,
  // Secret inside a file that has to be read: the value must not survive.
  '.env.example': `DATABASE_URL=${CANARY}\nPORT=${CANARY}`,
  'api/package.json': JSON.stringify({ name: 'api', scripts: { start: 'node src/index.js' }, dependencies: { express: '5.2.1', colyseus: '0.18.6' } }),
  'api/src/index.js': "app.get('/health', handler);",
  'api/drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/schema.ts', dbCredentials: { url: 'postgres://user:${CANARY}@host/db', schema: '${CANARY}' } };`,
  'worker/package.json': JSON.stringify({ name: 'worker', main: 'index.js' }),
  'worker/index.js': 'export default {};',
  'worker/knexfile.js': `module.exports = { connection: { password: '${CANARY}', migrations: { directory: '${CANARY}' } } };`,
  'supabase/config.toml': `[api]\nport = 54321\n[auth.external.github]\nsecret = "${CANARY}"`,
  'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  'compose.yaml': ['services:', '  db:', '    image: postgres:17', '    environment:', `      POSTGRES_PASSWORD: ${CANARY}`, `      image: ${CANARY}`, '    ports:', '      - "54329:5432"'].join('\n'),
  'k8s/gameserver.yaml': 'kind: GameServer',
};

describe('a file that is secret by its path is never read into memory', () => {
  it('on a tree that holds every trap at once', () => {
    const { view, contentReads } = spy(memoryWorkspace(TRAPS), ROOT);
    runEveryDetector(view, ROOT);

    assert.ok(contentReads.length > 0, 'the detectors read nothing, so this test proves nothing');
    for (const read of contentReads) assert.equal(isProtectedReadPath(read), false, `${read} was read into memory`);
    for (const secret of ['.env', '.env.local', 'api/.env.production', '.npmrc', 'service-account.json', 'functions/.runtimeconfig.json', 'Api/appsettings.json', 'infra/prod.tfvars', 'k8s/secrets.yaml']) {
      assert.equal(contentReads.includes(secret), false, secret);
    }
  });

  it('on every committed workspace fixture', () => {
    for (const name of fs.readdirSync(WORKSPACES).sort()) {
      const root = path.join(WORKSPACES, name);
      const { view, contentReads } = spy(createNodeFsView(), root);
      runEveryDetector(view, root);
      for (const read of contentReads) assert.equal(isProtectedReadPath(read), false, `${name}: ${read} was read into memory`);
    }
  });
});

describe('a secret inside a file that has to be read never reaches the facts', () => {
  it('on a tree that holds every trap at once', () => {
    const { facts } = runEveryDetector(memoryWorkspace(TRAPS), ROOT);
    const serialized = JSON.stringify(facts);
    assert.equal(serialized.includes(CANARY), false);

    // The detectors did run on the files that hold the canaries, so the absence above is a property
    // of the parsers rather than of a detector that never looked.
    assert.deepEqual(facts.env.keys, ['DATABASE_URL', 'PORT']);
    assert.deepEqual(facts.compose.services.map((service) => [service.name, service.image, service.hasEnvironment]), [['db', 'postgres', true]]);
    assert.ok(facts.databases.some((database) => database.tool === 'drizzle' && database.dialect === 'postgresql'));
    assert.ok(facts.databases.some((database) => database.tool === 'supabase' && database.ports.api === 54321));
    assert.ok(facts.dotnetServices.some((service) => service.secretFiles.includes('Api/appsettings.Production.json')));
    assert.ok(facts.nodeServices.some((service) => service.secretFiles.includes('api/.env.production')));
  });

  it('on the committed hostile fixture, whose canaries are listed beside it', () => {
    const root = path.join(WORKSPACES, 'hostile-workspace');
    const canaries = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8')).canaries;
    const { facts } = runEveryDetector(createNodeFsView(), root);
    const serialized = JSON.stringify(facts);
    assert.ok(canaries.length > 0);
    for (const canary of canaries) assert.equal(serialized.includes(canary), false, canary);
  });

  it('keeps the budget audit trail consistent with the spy', () => {
    const { view, contentReads } = spy(memoryWorkspace(TRAPS), ROOT);
    const { discovery } = runEveryDetector(view, ROOT);
    // The budget records what it opened; the spy records what reached the filesystem. They must agree,
    // or some read went around the one read path every detector is given.
    assert.deepEqual([...discovery.budget.state.opened].sort(), [...contentReads].sort());
  });
});
