import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { walkTree } from '../../../../src/project/discover.js';
import { COMPOSE_FILE_NAMES, CONTAINER_AND_CI_LINE, detectContainerAndCiFiles, findComposeFile, imageName, parseComposeServices, readComposeServices } from '../../../../src/project/compose.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\compose-tests' : '/compose-tests';

/**
 * @param {Record<string, string | null>} tree
 */
function workspace(tree) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const walk = walkTree(view, ROOT);
  return { view, walk, budget: createReadBudget(view, ROOT) };
}

/**
 * @param {Record<string, string | null>} tree
 * @param {{ dir?: string }} [options]
 */
function read(tree, { dir = '' } = {}) {
  const { budget, walk } = workspace(tree);
  return { facts: readComposeServices(budget, { dir, files: walk.files }), budget };
}

describe('the published-port scan', () => {
  it('reads the short syntax in every published spelling', () => {
    const { services } = parseComposeServices(
      ['services:', '  db:', '    ports:', '      - "54329:5432"', '      - 6000:6000', '      - "127.0.0.1:8080:80"', '      - "9000:9000/udp"', '      - "5432"'].join('\n'),
    );
    assert.deepEqual(services[0].publishedPorts, [6000, 8080, 9000, 54329]);
  });

  it('reads the long syntax', () => {
    const { services } = parseComposeServices(['services:', '  api:', '    ports:', '      - target: 80', '        published: "8080"', '        protocol: tcp'].join('\n'));
    assert.deepEqual(services[0].publishedPorts, [8080]);
  });

  it('reads the long syntax whatever order its keys come in', () => {
    const { services } = parseComposeServices(
      ['services:', '  api:', '    ports:', '      - target: 80', '        host_ip: 127.0.0.1', '        published: "8080"', '      - published: 8443', '        target: 443', '    image: sample/api:dev'].join('\n'),
    );
    assert.deepEqual(services[0].publishedPorts, [8080, 8443]);
    assert.equal(services[0].image, 'api');
  });

  it('reads a sequence written at its parent key indent, which YAML allows', () => {
    const { services } = parseComposeServices(['services:', '  api:', '    ports:', '    - "3000:3000"', '    image: sample/api:dev'].join('\n'));
    assert.deepEqual(services[0].publishedPorts, [3000]);
  });

  it('reads the flow form on one line', () => {
    const { services } = parseComposeServices(['services:', '  api:', '    ports: ["3000:3000", "3001:3001"]'].join('\n'));
    assert.deepEqual(services[0].publishedPorts, [3000, 3001]);
  });

  it('records nothing for a range, which names more than one entry', () => {
    const { services } = parseComposeServices(['services:', '  api:', '    ports:', '      - "3000-3005:3000-3005"'].join('\n'));
    assert.deepEqual(services[0].publishedPorts, []);
  });

  it('ignores a port that is not a usable integer', () => {
    const { services } = parseComposeServices(['services:', '  api:', '    ports:', '      - "0:80"', '      - "70000:80"', '      - "${PORT}:80"'].join('\n'));
    assert.deepEqual(services[0].publishedPorts, []);
  });

  it('keeps the services apart, sorted by name, and stops reading at a top-level key', () => {
    const { services } = parseComposeServices(
      ['services:', '  web:', '    image: sample/web:dev', '    ports:', '      - "8080:80"', '  db:', '    image: postgres:17', '    ports:', '      - "54329:5432"', 'volumes:', '  data:', '    ports:', '      - "1:1"'].join('\n'),
    );
    assert.deepEqual(services.map((service) => service.name), ['db', 'web']);
    assert.deepEqual(services.map((service) => service.publishedPorts), [[54329], [8080]]);
  });
});

describe('an image is recorded by its name alone', () => {
  it('drops the registry, the namespace, the tag and the digest', () => {
    assert.equal(imageName('postgres:17'), 'postgres');
    assert.equal(imageName('"registry.example.test:5000/team/api:1.2@sha256:abc"'), 'api');
    assert.equal(imageName('sample/gameserver'), 'gameserver');
    assert.equal(imageName(''), null);
  });
});

describe('the environment is a key, never a value (S-BM-2)', () => {
  const canary = 'OCU-TEST-COMPOSE-SECRET';
  const text = ['services:', '  db:', '    image: postgres:17', '    environment:', `      POSTGRES_PASSWORD: ${canary}`, `      POSTGRES_USER: ${canary}`, '    env_file:', '      - .env', '    ports:', '      - "54329:5432"'].join('\n');

  it('records that the keys exist and nothing that is under them', () => {
    const { facts } = read({ 'compose.yaml': text });
    assert.deepEqual(facts.services, [{ name: 'db', image: 'postgres', publishedPorts: [54329], hasEnvironment: true, hasEnvFile: true }]);
    assert.equal(JSON.stringify(facts).includes(canary), false);
  });

  it('does not read a variable named like a service key as that key', () => {
    const hostile = ['services:', '  db:', '    environment:', `      image: ${canary}`, `      ports: ${canary}`, '    image: postgres:17'].join('\n');
    const { facts } = read({ 'compose.yaml': hostile });
    assert.equal(facts.services[0].image, 'postgres');
    assert.deepEqual(facts.services[0].publishedPorts, []);
    assert.equal(JSON.stringify(facts).includes(canary), false);
  });

  it('does not let a value reach the facts through the flow form of environment', () => {
    const hostile = ['services:', '  db:', `    environment: { POSTGRES_PASSWORD: ${canary} }`, `    env_file: [ ${canary}.env ]`].join('\n');
    const { facts } = read({ 'compose.yaml': hostile });
    assert.deepEqual([facts.services[0].hasEnvironment, facts.services[0].hasEnvFile], [true, true]);
    assert.equal(JSON.stringify(facts).includes(canary), false);
  });

  it('records no value from the committed hostile fixture either', () => {
    const root = path.join(WORKSPACES, 'hostile-workspace');
    const view = createNodeFsView();
    const walk = walkTree(view, root);
    const facts = readComposeServices(createReadBudget(view, root), { files: walk.files });
    assert.equal(facts.services.length, 1);
    assert.deepEqual(facts.services[0].publishedPorts, [54330]);
    assert.equal(JSON.stringify(facts).includes('OCU-CANARY'), false);
  });
});

describe('which compose file is read (claim B32)', () => {
  it('prefers compose.yaml over every other spelling', () => {
    assert.deepEqual(COMPOSE_FILE_NAMES, ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
    assert.equal(findComposeFile(['docker-compose.yml', 'compose.yaml', 'compose.yml']), 'compose.yaml');
    assert.equal(findComposeFile(['docker-compose.yml', 'docker-compose.yaml']), 'docker-compose.yaml');
    assert.equal(findComposeFile(['api/compose.yaml'], 'api'), 'api/compose.yaml');
  });

  it('is absent, not an error, when there is none', () => {
    const { facts, budget } = read({ 'package.json': '{}' });
    assert.equal(facts.status, 'absent');
    assert.deepEqual(budget.state.opened, []);
  });

  it('is unreadable, with no services, when the file cannot be opened', () => {
    const { budget } = workspace({ 'package.json': '{}' });
    const facts = readComposeServices(budget, { files: ['compose.yaml'] });
    assert.equal(facts.status, 'unreadable');
    assert.deepEqual(facts.services, []);
  });

  it('stops at the service cap and says so', () => {
    const lines = ['services:'];
    for (let index = 0; index < 30; index += 1) lines.push(`  service-${index}:`, '    ports:', `      - "${4000 + index}:80"`);
    const { services, truncated } = parseComposeServices(lines.join('\n'));
    assert.equal(services.length, 24);
    assert.equal(truncated, true);
  });

  it('names the row behind a published port, and only when there is one', () => {
    assert.deepEqual(read({ 'compose.yaml': ['services:', '  api:', '    ports:', '      - "3000:3000"'].join('\n') }).facts.evidence, [{ fact: 'port', signature: 'game-server/port.compose', file: 'compose.yaml' }]);
    assert.deepEqual(read({ 'compose.yaml': ['services:', '  api:', '    image: sample/api:dev'].join('\n') }).facts.evidence, []);
  });
});

describe('the one-line container and CI fact (D-B23)', () => {
  it('finds the visible files through the walk and the hidden ones by name', () => {
    const { view, walk } = workspace({
      'Dockerfile': 'FROM node:22',
      'compose.yaml': 'services:',
      'k8s/gameserver.yaml': 'kind: GameServer',
      'infra/main.tf': 'resource "x" "y" {}',
      '.github/workflows/ci.yml': 'name: ci',
      '.gitlab-ci.yml': 'stages: []',
    });
    const facts = detectContainerAndCiFiles(view, ROOT, walk);

    assert.equal(facts.present, true);
    assert.equal(facts.line, CONTAINER_AND_CI_LINE);
    assert.deepEqual(facts.categories, ['CI workflows', 'container', 'deployment']);
    assert.deepEqual(facts.files, ['.github/workflows', '.github/workflows/ci.yml', '.gitlab-ci.yml', 'Dockerfile', 'compose.yaml', 'infra/main.tf', 'k8s']);
    assert.equal(facts.evidence.length, 1);
  });

  it('says nothing when the workspace has none of them', () => {
    const { view, walk } = workspace({ 'package.json': '{}', 'src/index.js': '' });
    const facts = detectContainerAndCiFiles(view, ROOT, walk);
    assert.deepEqual([facts.present, facts.line, facts.categories, facts.files], [false, '', [], []]);
  });

  it('lists the workflow files so a later detector can look inside one', () => {
    const { view, walk } = workspace({ '.github/workflows/build.yml': 'run: x', '.github/workflows/ci.yml': 'name: ci' });
    const facts = detectContainerAndCiFiles(view, ROOT, walk);
    assert.deepEqual(facts.files, ['.github/workflows', '.github/workflows/build.yml', '.github/workflows/ci.yml']);
  });

  it('finds the same files on the committed fixtures', () => {
    const view = createNodeFsView();
    for (const [name, expected] of [['monorepo-workspaces', ['.github/workflows', '.github/workflows/ci.yml']], ['unity-plus-dedicated-server', ['compose.yaml', 'k8s']]]) {
      const root = path.join(WORKSPACES, String(name));
      const facts = detectContainerAndCiFiles(view, root, walkTree(view, root));
      assert.deepEqual(facts.files, expected, String(name));
      assert.equal(facts.line, CONTAINER_AND_CI_LINE);
    }
  });
});
