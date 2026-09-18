import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget, DISCOVERY_LIMITS, isNeverOpenedFile, isProtectedReadPath, NEVER_OPENED_FILES, SCANNER_READ_DENY } from '../../../../src/project/budget.js';
import { readFirebaseFacts } from '../../../../src/project/components/firebase.js';
import { discoverComponents } from '../../../../src/project/discover.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\budget-tests' : '/budget-tests';
const CANARY = 'OCU-CANARY';

/**
 * @param {Record<string, string | null>} tree
 */
function viewOf(tree) {
  return createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
}

/**
 * Wraps a view so a test can prove which paths were handed to the filesystem at all.
 * @param {import('../../../../src/unity/fs-view.js').FsView} view
 */
function recordingView(view) {
  /** @type {string[]} */
  const reads = [];
  return {
    reads,
    view: /** @type {import('../../../../src/unity/fs-view.js').FsView} */ ({
      stat: (filePath) => view.stat(filePath),
      readDir: (dirPath) => view.readDir(dirPath),
      readText: (filePath, options) => {
        reads.push(filePath);
        return view.readText(filePath, options);
      },
    }),
  };
}

describe('the scanner read deny set', () => {
  it('covers SPEC 8.5.2 secrets and the amendment 37.9 backend additions', () => {
    for (const denied of ['.env', 'functions/.env.local', 'keys/server.pem', 'ci/id_rsa', 'app/google-services.json', 'ops/service-account.json', 'functions/.runtimeconfig.json', 'Api/appsettings.Production.json', 'infra/main.tfvars', 'ops/kubeconfig', 'deploy/secrets.yaml', 'client/Library/ScriptAssemblies/A.dll', 'web/dist/bundle.js', 'node_modules/left-pad/index.js', '.npmrc']) {
      assert.equal(isProtectedReadPath(denied), true, `${denied} must be denied`);
    }
  });

  it('lets the three .env template spellings through, because they are the scanner one exception', () => {
    for (const allowed of ['.env.example', 'functions/.env.sample', 'apps/api/.env.template']) {
      assert.equal(isProtectedReadPath(allowed), false, `${allowed} must be allowed`);
    }
    assert.equal(SCANNER_READ_DENY.at(-1)?.action, 'allow', 'the allow rows come last so they win');
  });

  it('matches case-insensitively, so a case-insensitive volume is not a way through', () => {
    assert.equal(isProtectedReadPath('.ENV'), true);
    assert.equal(isProtectedReadPath('Api/AppSettings.json'), true);
  });

  it('does not deny ordinary source or configuration', () => {
    for (const allowed of ['package.json', 'firebase.json', '.firebaserc', 'src/server.ts', 'Api/Api.csproj', 'drizzle.config.ts', 'compose.yaml']) {
      assert.equal(isProtectedReadPath(allowed), false, `${allowed} must be readable`);
    }
  });

  it('names every lock file as never opened, because the file name is the evidence', () => {
    assert.equal(isNeverOpenedFile('functions/package-lock.json'), true);
    assert.equal(isNeverOpenedFile('pnpm-lock.yaml'), true);
    assert.equal(isNeverOpenedFile('client/Packages/packages-lock.json'), true);
    assert.equal(isNeverOpenedFile('package.json'), false);
    assert.ok(NEVER_OPENED_FILES.includes('bun.lockb'));
  });
});

describe('createReadBudget refuses before it opens', () => {
  it('never hands a denied path to the filesystem at all', () => {
    const { view, reads } = recordingView(viewOf({ '.env': `TOKEN=${CANARY}-ENV`, 'service-account.json': `{"private_key":"${CANARY}-SA"}` }));
    const budget = createReadBudget(view, ROOT);

    const env = budget.readText('.env');
    const account = budget.readJson('service-account.json');

    assert.equal(env.status, 'denied');
    assert.equal(env.text, null);
    assert.equal(account.status, 'denied');
    assert.equal(account.value, undefined);
    assert.deepEqual(reads, [], 'no denied path reached the filesystem');
    assert.deepEqual(budget.state.opened, []);
    assert.deepEqual(budget.state.refused, ['denied .env', 'denied service-account.json']);
  });

  // The deny globs are workspace-relative patterns, so a path that leaves the root would be matched
  // against a string that no longer denotes the tree being scanned. A detector builds paths out of
  // untrusted repository content (S15), so containment is checked before the globs, not after.
  it('refuses a path that leaves the workspace root, before the deny globs are consulted', () => {
    const { view, reads } = recordingView(viewOf({ 'a.json': '{}' }));
    const budget = createReadBudget(view, ROOT);
    const outside = ['../private/package.json', '../../etc/passwd', 'sub/../../up.json', '/etc/passwd', 'C:/Windows/win.ini', 'a\\b.json', ''];

    for (const relativePath of outside) {
      assert.equal(budget.readText(relativePath).status, 'denied', relativePath);
      assert.equal(budget.readJson(relativePath).status, 'denied', relativePath);
    }

    assert.deepEqual(reads, [], 'no escaping path reached the filesystem');
    assert.deepEqual(budget.state.opened, []);
    assert.equal(budget.readText('a.json').status, 'ok');
  });

  it('refuses a lock file without opening it, whatever its size', () => {
    const { view, reads } = recordingView(viewOf({ 'package-lock.json': `{"x":"${'y'.repeat(2000)}"}` }));
    const budget = createReadBudget(view, ROOT);
    assert.equal(budget.readText('package-lock.json').status, 'never-opened');
    assert.deepEqual(reads, []);
    assert.equal(budget.state.bytesRead, 0);
  });

  it('reads .env.example, which is the one credential-adjacent file it may open', () => {
    const budget = createReadBudget(viewOf({ '.env.example': 'DATABASE_URL=\nAPI_TOKEN=\n' }), ROOT);
    const read = budget.readText('.env.example');
    assert.equal(read.status, 'ok');
    assert.match(read.text ?? '', /DATABASE_URL=/);
  });
});

describe('createReadBudget meters what it opens', () => {
  it('stops a component at its file cap and reports it as unbudgeted', () => {
    const tree = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`file${index}.json`, '{}']));
    const budget = createReadBudget(viewOf(tree), ROOT, { limits: { filesPerComponent: 3 } });
    for (let index = 0; index < 6; index += 1) budget.readText(`file${index}.json`, { component: 'node:api' });

    assert.equal(budget.filesOpenedFor('node:api'), 3);
    assert.equal(budget.statusFor('node:api'), 'unbudgeted');
    assert.equal(budget.statusFor('node:other'), 'ok');
  });

  it('cuts a file at the byte cap and at the line cap, and says it truncated', () => {
    const budget = createReadBudget(viewOf({ 'big.txt': 'x'.repeat(100), 'long.txt': Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n') }), ROOT);

    const big = budget.readText('big.txt', { maxBytes: 10 });
    assert.equal(big.truncated, true);
    assert.equal(big.text?.length, 10);
    assert.equal(big.size, 100);

    const long = budget.readText('long.txt', { maxLines: 5 });
    assert.equal(long.truncated, true);
    assert.equal(long.text?.split('\n').length, 5);
  });

  it('stops the whole workspace at the byte budget and keeps every later read unbudgeted', () => {
    const tree = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`file${index}.txt`, 'x'.repeat(100)]));
    const budget = createReadBudget(viewOf(tree), ROOT, { limits: { workspaceBytes: 250 } });

    assert.equal(budget.readText('file0.txt', { component: 'a' }).status, 'ok');
    assert.equal(budget.readText('file1.txt', { component: 'b' }).status, 'ok');
    assert.equal(budget.readText('file2.txt', { component: 'c' }).status, 'unbudgeted');
    assert.equal(budget.state.exhausted, true);
    assert.equal(budget.statusFor('d'), 'unbudgeted');
    assert.equal(budget.readText('file3.txt', { component: 'd' }).status, 'unbudgeted');
  });

  it('reports a missing file and a malformed one differently', () => {
    const budget = createReadBudget(viewOf({ 'broken.json': '{ not json' }), ROOT);
    assert.equal(budget.readJson('absent.json').status, 'missing');
    const broken = budget.readJson('broken.json');
    assert.equal(broken.status, 'ok');
    assert.equal(broken.value, undefined);
    assert.match(broken.error ?? '', /broken\.json/);
  });

  it('ships the limits the amendment states', () => {
    assert.deepEqual({ ...DISCOVERY_LIMITS }, { walkEntryCap: 50_000, maxDepth: 12, filesPerComponent: 24, bytesPerFile: 262_144, linesPerFile: 400, workspaceBytes: 6_291_456 });
  });
});

describe('the canary rule over the hostile workspace', () => {
  const root = path.join(WORKSPACES, 'hostile-workspace');

  it('opens no protected path during discovery and the Firebase read', () => {
    const { view, reads } = recordingView(createNodeFsView());
    const discovery = discoverComponents(view, root);
    const firebase = readFirebaseFacts(discovery.budget);

    assert.equal(firebase.status, 'ok');
    for (const filePath of reads) {
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      assert.equal(isProtectedReadPath(relative), false, `${relative} must never be opened`);
      assert.equal(isNeverOpenedFile(relative), false, `${relative} must never be opened`);
    }
    assert.ok(reads.length > 0, 'the scan did open something, so the assertion above is not vacuous');
  });

  it('carries no canary into the discovery result or the Firebase facts', () => {
    const discovery = discoverComponents(createNodeFsView(), root);
    const firebase = readFirebaseFacts(discovery.budget);
    const rendered = JSON.stringify({
      anchors: discovery.anchors,
      overlays: discovery.overlays,
      workspaceRoot: discovery.workspaceRoot,
      notes: discovery.notes,
      opened: discovery.budget.state.opened,
      refused: discovery.budget.state.refused,
      firebase,
    });

    assert.equal(rendered.includes(CANARY), false, 'a canary reached an output');
    assert.equal(rendered.includes('production'), false, 'a live project id reached an output');
  });
});
