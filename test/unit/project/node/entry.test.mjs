import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONVENTIONAL_ENTRIES, joinInsideWorkspace, mapCompiledPath, pathTokenOf, resolveEntry, resolveModulePath } from '../../../../src/project/entry.js';

/**
 * @param {Record<string, unknown>} manifest
 * @param {string[]} files
 * @param {{ dir?: string, typescript?: { outDir: string | null, rootDir: string | null } }} [options]
 */
function resolve(manifest, files, { dir = '', typescript } = {}) {
  return resolveEntry({ dir, manifest, files, ...(typescript === undefined ? {} : { typescript }) });
}

describe('the declaration order of 14.6.4', () => {
  it('prefers bin, as a string and as the first value of the object form', () => {
    assert.equal(resolve({ bin: './cli.js', main: 'index.js' }, ['cli.js', 'index.js']).path, 'cli.js');
    assert.equal(resolve({ bin: { tool: 'bin/tool.js' }, main: 'index.js' }, ['bin/tool.js', 'index.js']).source, 'bin');
  });

  it('takes the last path-looking token of scripts.start, never a flag', () => {
    const facts = resolve({ scripts: { start: 'node --enable-source-maps dist/server.js' } }, ['dist/server.js']);
    assert.equal(facts.path, 'dist/server.js');
    assert.equal(facts.source, 'scripts.start');
  });

  it('falls through to main and then to exports', () => {
    assert.equal(resolve({ main: 'lib/main.js' }, ['lib/main.js']).source, 'main');
    assert.equal(resolve({ exports: './src/index.js' }, ['src/index.js']).source, 'exports');
    assert.equal(resolve({ exports: { '.': { import: './src/index.js' } } }, ['src/index.js']).path, 'src/index.js');
    assert.equal(resolve({ exports: { default: './src/index.js' } }, ['src/index.js']).path, 'src/index.js');
  });

  it('falls back to convention in the documented order', () => {
    const facts = resolve({}, ['index.js', 'src/index.ts']);
    assert.equal(facts.path, 'src/index.ts');
    assert.equal(facts.source, 'convention');
    assert.equal(CONVENTIONAL_ENTRIES[0], 'src/index');
  });

  it('gives the next declaration, and then convention, their turn when one resolves to nothing', () => {
    const facts = resolve({ bin: './missing-cli.js', main: 'src/index.js' }, ['src/index.js']);
    assert.equal(facts.path, 'src/index.js');
    assert.equal(facts.source, 'main');
  });

  it('takes no entry from an exports object that names no condition it understands', () => {
    const facts = resolve({ exports: { '.': { types: './types/index.d.ts' } } }, ['src/index.js', 'types/index.d.ts']);
    assert.equal(facts.source, 'convention');
    assert.equal(facts.path, 'src/index.js');
  });

  it('reports nothing rather than guessing when no candidate exists', () => {
    const facts = resolve({}, ['README.md']);
    assert.deepEqual([facts.path, facts.declared, facts.source, facts.compiledOnly], [null, null, null, false]);
    assert.deepEqual(facts.evidence, []);
  });

  it('names the file behind the entry it states', () => {
    assert.deepEqual(resolve({ main: 'src/index.js' }, ['src/index.js']).evidence, [{ fact: 'entry', signature: 'spec:37.4', file: 'src/index.js' }]);
  });
});

describe('the compiled entry, mapped back to its source (claim B35)', () => {
  const files = ['functions/src/index.ts', 'functions/package.json'];
  const typescript = { outDir: 'lib', rootDir: 'src' };

  it('maps outDir to rootDir and the compiled extension to the source one', () => {
    const facts = resolveEntry({ dir: 'functions', manifest: { main: 'lib/index.js' }, files, typescript });
    assert.equal(facts.path, 'functions/src/index.ts');
    assert.equal(facts.mapped, true);
    assert.equal(facts.compiledOnly, false);
  });

  it('accepts the ./ and trailing-slash spellings of both folders', () => {
    const facts = resolveEntry({ dir: 'functions', manifest: { main: './lib/index.js' }, files, typescript: { outDir: './lib/', rootDir: './src' } });
    assert.equal(facts.path, 'functions/src/index.ts');
  });

  it('records a compiled-only entry rather than a source that does not exist', () => {
    const facts = resolveEntry({ dir: 'functions', manifest: { main: 'lib/worker.js' }, files, typescript });
    assert.equal(facts.path, null);
    assert.equal(facts.compiledOnly, true);
    assert.equal(facts.declared, 'functions/lib/worker.js');
  });

  it('does not map when the configuration names only one of the two folders', () => {
    assert.equal(mapCompiledPath('functions', 'lib/index.js', { outDir: 'lib', rootDir: null }), null);
    assert.equal(mapCompiledPath('functions', 'lib/index.js', { outDir: null, rootDir: 'src' }), null);
    assert.equal(mapCompiledPath('functions', 'src/index.ts', { outDir: 'lib', rootDir: 'src' }), null);
  });

  it('maps a rootDir of . to the component folder itself', () => {
    assert.equal(mapCompiledPath('api', 'dist/server.js', { outDir: 'dist', rootDir: '.' }), './server.js');
  });
});

describe('a specifier is repository content, so it is bounded before it is used (S15)', () => {
  it('refuses a path that climbs above the workspace root', () => {
    assert.equal(joinInsideWorkspace('api', '../../elsewhere/index.js'), null);
    assert.equal(resolve({ main: '../../elsewhere/index.js' }, ['index.js'], { dir: 'api' }).path, null);
  });

  it('resolves a .. that stays inside the workspace', () => {
    assert.equal(joinInsideWorkspace('apps/api/src', '../shared/db.js'), 'apps/api/shared/db.js');
  });

  it('refuses an absolute path in every spelling', () => {
    assert.equal(joinInsideWorkspace('', '/etc/hosts'), null);
    assert.equal(joinInsideWorkspace('', 'C:/Windows/system.ini'), null);
    assert.equal(joinInsideWorkspace('', '\\\\server\\share\\x.js'), null);
  });

  it('reads a declaration written with backslashes', () => {
    assert.equal(resolve({ main: 'src\\index.js' }, ['src/index.js']).path, 'src/index.js');
  });
});

describe('module resolution against the walk, with no read and no stat', () => {
  const files = ['src/index.ts', 'src/routes/game.js', 'src/lib/index.mjs'];

  it('resolves an extensionless specifier and a folder index', () => {
    assert.equal(resolveModulePath(files, '', './src/index'), 'src/index.ts');
    assert.equal(resolveModulePath(files, '', './src/lib'), 'src/lib/index.mjs');
  });

  it('resolves a compiled spelling to its source sibling, and only for the compiled extensions', () => {
    assert.equal(resolveModulePath(['src/a.ts'], '', './src/a.js'), 'src/a.ts');
    assert.equal(resolveModulePath(['src/a.mts'], '', './src/a.mjs'), 'src/a.mts');
    assert.equal(resolveModulePath(['src/a.ts'], '', './src/a.json'), null);
  });

  it('returns null rather than the nearest thing when nothing matches', () => {
    assert.equal(resolveModulePath(files, '', './src/missing'), null);
  });
});

describe('the start-script token rule', () => {
  it('takes a token with a separator or a module extension, and never a flag', () => {
    assert.equal(pathTokenOf('node dist/server.js'), 'dist/server.js');
    assert.equal(pathTokenOf('tsx src/main.ts'), 'src/main.ts');
    assert.equal(pathTokenOf('node --watch server.mjs'), 'server.mjs');
    assert.equal(pathTokenOf('nodemon --watch src'), null);
    assert.equal(pathTokenOf('npm run build'), null);
  });

  it('normalises a Windows-spelled token', () => {
    assert.equal(pathTokenOf('node dist\\server.js'), 'dist/server.js');
  });
});
