// The four rules of the platform probe interface (amendment 33.6, expansion 11.5.1) and S-CP1:
//
// 1. No probe family imports another: a module named for one platform family (`win32.js`,
//    `processes-win32.js`, `linux-nvidia.js`, ...) imports nothing of another family, shared modules
//    import no family module, and only `probes/index.js` imports a family's entry module.
// 2. No probe module imports `decide.js`, `messages.js`, `collect.js`, `evaluate.js` or anything under
//    `src/` (the last two would be circular; `src/` is not copied into the rendered plugin).
// 3. Every command a probe starts gets the caller's AbortSignal and runs with `LC_ALL=C`: only
//    `run-command.js` spawns, every call of a runner passes `signal`, and each family, once selected,
//    is checked by running its readers against a recording runner.
// 4. A reader that throws, synchronously or not, answers with an error read instead.
// S-CP1: selection happens once, in `guard/collect.js`; the guard core never reads
// `process.platform` and never names a platform.
//
// Imports and calls are read from code only: comments are blanked first, so JSDoc type imports such
// as `@type {import('./index.js').Read}` are not imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBE_FAMILIES, catchReaderFailures, selectProbes } from '../../plugin/opencode-unity-lib/guard/probes/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GUARD_DIR = 'plugin/opencode-unity-lib/guard';
const PROBES_DIR = `${GUARD_DIR}/probes`;
const INDEX_MODULE = `${PROBES_DIR}/index.js`;
const RUN_COMMAND_MODULE = `${PROBES_DIR}/run-command.js`;
const COLLECT_MODULE = `${GUARD_DIR}/collect.js`;
const SHIPPED_ROOTS = Object.freeze(['src', 'plugin', 'bin']);

/** Every `process.platform` value Node documents, plus the fallback family. */
const FAMILY_NAMES = Object.freeze(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32', 'unsupported']);

/** Guard modules a probe may not import: the decision and its messages, and the modules above it. */
const FORBIDDEN_FOR_PROBES = Object.freeze(['decide.js', 'messages.js', 'collect.js', 'evaluate.js'].map((name) => `${GUARD_DIR}/${name}`));

/** Tokens after which a `/` opens a regular expression rather than dividing. */
const REGEX_PREFIX_PUNCTUATION = '(,=:[!&|?{};+-*%^~<>';
const REGEX_PREFIX_KEYWORD = /\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void)\s*$/;

/**
 * Blanks out comments and keeps strings, template literals and regular expressions, so a quote inside
 * a pattern cannot desynchronise the scan. Newlines survive.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  /** @type {'code' | 'line' | 'block' | '"' | "'" | '`'} */
  let state = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out += '  ';
        index += 2;
      } else if (char === '/' && next === '*') {
        state = 'block';
        out += '  ';
        index += 2;
      } else if (char === '/' && isRegexPosition(out)) {
        const end = regexEnd(source, index);
        const stop = end === -1 ? index + 1 : end + 1;
        out += source.slice(index, stop);
        index = stop;
      } else {
        if (char === '"' || char === "'" || char === '`') state = char;
        out += char;
        index += 1;
      }
    } else if (state === 'line' || state === 'block') {
      if (state === 'block' && char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 2;
        continue;
      }
      if (state === 'line' && char === '\n') state = 'code';
      out += char === '\n' ? char : ' ';
      index += 1;
    } else if (char === '\\') {
      out += char + (next ?? '');
      index += 2;
    } else {
      if (char === state) state = 'code';
      out += char;
      index += 1;
    }
  }
  return out;
}

/**
 * @param {string} emitted
 * @returns {boolean}
 */
function isRegexPosition(emitted) {
  const previous = emitted.trimEnd().at(-1);
  return previous === undefined || REGEX_PREFIX_PUNCTUATION.includes(previous) || REGEX_PREFIX_KEYWORD.test(emitted.slice(-12));
}

/**
 * @param {string} source
 * @param {number} start
 * @returns {number}  The closing `/`, or -1 when the line ends first (a division after all).
 */
function regexEnd(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\n') return -1;
    if (char === '\\') index += 2;
    else if (inClass) {
      if (char === ']') inClass = false;
      index += 1;
    } else if (char === '[') {
      inClass = true;
      index += 1;
    } else if (char === '/') return index;
    else index += 1;
  }
  return -1;
}

/**
 * Module specifiers a module imports at run time: static imports, re-exports and dynamic imports.
 * @param {string} code  Comments already blanked.
 * @returns {string[]}
 */
export function findImports(code) {
  const patterns = [
    /(?:^|[;\s])import\s+(?:[^'";]*?\s*from\s*)?['"]([^'"\n]+)['"]/g,
    /(?:^|[;\s])export\s+[^'";]*?\s*from\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
}

/**
 * The argument text of every call of `name(...)` that is not its own declaration.
 * @param {string} code  Comments already blanked.
 * @param {string} name
 * @returns {string[]}
 */
export function findCallArguments(code, name) {
  const pattern = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
  /** @type {string[]} */
  const calls = [];
  for (const match of code.matchAll(pattern)) {
    if (/function\s*\*?\s*$/.test(code.slice(0, match.index))) continue;
    const open = /** @type {number} */ (match.index) + match[0].length;
    calls.push(code.slice(open, findClosingParen(code, open)));
  }
  return calls;
}

/**
 * @param {string} code
 * @param {number} start  Just after the opening parenthesis.
 * @returns {number}
 */
function findClosingParen(code, start) {
  let depth = 1;
  let index = start;
  /** @type {string | null} */
  let quote = null;
  while (index < code.length) {
    const char = code[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return code.length;
}

/**
 * @param {string} root  Repository-relative, posix spelling.
 * @returns {string[]}
 */
function listModules(root) {
  const absolute = path.join(REPO_ROOT, ...root.split('/'));
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${root}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listModules(child);
      return /\.(?:js|mjs|cjs)$/.test(entry.name) ? [child] : [];
    })
    .sort();
}

/**
 * @param {string} from       Repository-relative module path.
 * @param {string} specifier
 * @returns {string | null}   Repository-relative target for a relative specifier, else null.
 */
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
}

/**
 * The family a probe module belongs to, from its file name: `win32.js`, `processes-win32.js` and
 * `win32-probe.ps1` are win32's; a name without a family token is shared.
 * @param {string} modulePath
 * @returns {string | null}
 */
export function familyOf(modulePath) {
  const base = path.posix.basename(modulePath).replace(/\.[^.]+$/, '');
  const tokens = base.split('-');
  return FAMILY_NAMES.find((family) => tokens.includes(family)) ?? null;
}

/**
 * @param {string} modulePath
 * @returns {boolean}
 */
function isFamilyEntry(modulePath) {
  return modulePath.startsWith(`${PROBES_DIR}/`) && FAMILY_NAMES.includes(path.posix.basename(modulePath, '.js'));
}

/**
 * @param {string} relative
 * @returns {{ path: string, code: string, imports: Array<{ specifier: string, target: string | null }> }}
 */
function readModule(relative) {
  const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')), 'utf8'));
  return { path: relative, code, imports: findImports(code).map((specifier) => ({ specifier, target: resolveSpecifier(relative, specifier) })) };
}

/**
 * Rule 1 and rule 2 for one probe module.
 * @param {{ path: string, imports: Array<{ specifier: string, target: string | null }> }} module
 * @returns {string[]}
 */
export function checkProbeImports(module) {
  const family = familyOf(module.path);
  /** @type {string[]} */
  const problems = [];
  for (const { specifier, target } of module.imports) {
    if (target === null) continue;
    const where = `${module.path} imports ${specifier}`;
    if (target.startsWith('src/')) problems.push(`${where}: a probe never imports src/`);
    if (FORBIDDEN_FOR_PROBES.includes(target)) problems.push(`${where}: a probe never imports the guard above it`);
    if (target === INDEX_MODULE) problems.push(`${where}: only collect.js selects probes`);
    if (!target.startsWith(`${PROBES_DIR}/`)) continue;
    const targetFamily = familyOf(target);
    if (isFamilyEntry(target) && module.path !== INDEX_MODULE) problems.push(`${where}: only index.js imports a family entry`);
    else if (targetFamily !== null && targetFamily !== family && module.path !== INDEX_MODULE) {
      problems.push(`${where}: the ${family ?? 'shared'} code may not use the ${targetFamily} family`);
    }
  }
  return problems;
}

const probeModules = listModules(PROBES_DIR).map(readModule);
const shippedModules = SHIPPED_ROOTS.flatMap(listModules).map(readModule);

describe('the probe scanner', () => {
  it('finds static, re-exported and dynamic imports, and none in comments', () => {
    const code = stripComments([
      "import fs from 'node:fs';",
      "import {\n  a,\n  b,\n} from './multi.js';",
      "import './side-effect.js';",
      "export { c } from './re-export.js';",
      "const lazy = await import('./lazy.js');",
      "/** @type {import('./type-only.js').T} */",
      "const cast = /** @type {import('./cast.js').T} */ (value);",
      "// import x from './commented.js';",
      'const url = import.meta.url;',
    ].join('\n'));
    assert.deepEqual(findImports(code).sort(), ['./lazy.js', './multi.js', './re-export.js', './side-effect.js', 'node:fs'].sort());
  });

  it('is not thrown off by a quote inside a regular expression', () => {
    const code = stripComments("const row = /^\"([^\"]*)\",/.exec(text);\n// import x from './commented.js';\nimport y from './real.js';");
    assert.deepEqual(findImports(code), ['./real.js']);
  });

  it('reads call arguments across lines and skips declarations', () => {
    const code = stripComments("function run(file, args, options) {}\nrun('a', ['(x)'], {\n  timeoutMs,\n  signal,\n});");
    assert.deepEqual(findCallArguments(code, 'run').map((text) => text.replace(/\s+/g, ' ').trim()), ["'a', ['(x)'], { timeoutMs, signal, }"]);
  });

  it('names the family of a probe module from its file name', () => {
    assert.equal(familyOf(`${PROBES_DIR}/win32.js`), 'win32');
    assert.equal(familyOf(`${PROBES_DIR}/processes-win32.js`), 'win32');
    assert.equal(familyOf(`${PROBES_DIR}/linux-nvidia.js`), 'linux');
    assert.equal(familyOf(`${PROBES_DIR}/darwin-metal-cache.js`), 'darwin');
    assert.equal(familyOf(`${PROBES_DIR}/unsupported.js`), 'unsupported');
    assert.equal(familyOf(`${PROBES_DIR}/nvidia-smi.js`), null);
    assert.equal(familyOf(`${PROBES_DIR}/run-command.js`), null);
  });

  it('reports each kind of forbidden import', () => {
    const probe = (/** @type {string} */ file, /** @type {string[]} */ targets) => ({
      path: `${PROBES_DIR}/${file}`,
      imports: targets.map((target) => ({ specifier: target, target: resolveSpecifier(`${PROBES_DIR}/${file}`, target) })),
    });
    assert.deepEqual(checkProbeImports(probe('win32.js', ['./nvidia-smi.js', './processes-win32.js', '../unity-processes.js', 'node:fs'])), []);
    assert.equal(checkProbeImports(probe('linux.js', ['./win32.js'])).length, 1);
    assert.equal(checkProbeImports(probe('linux.js', ['./processes-win32.js'])).length, 1);
    assert.equal(checkProbeImports(probe('nvidia-smi.js', ['./processes-win32.js'])).length, 1);
    assert.equal(checkProbeImports(probe('win32.js', ['./index.js'])).length, 1);
    assert.equal(checkProbeImports(probe('win32.js', ['../decide.js'])).length, 1);
    assert.equal(checkProbeImports(probe('win32.js', ['../messages.js'])).length, 1);
    assert.equal(checkProbeImports(probe('win32.js', ['../../../../src/core/paths.js'])).length, 1);
    assert.deepEqual(checkProbeImports(probe('index.js', ['./win32.js', './unsupported.js', './run-command.js'])), []);
  });
});

describe('rule 1 and rule 2: what a probe module imports', () => {
  it('scans the probe directory that is actually there', () => {
    const paths = probeModules.map((module) => module.path);
    for (const expected of [INDEX_MODULE, `${PROBES_DIR}/win32.js`, `${PROBES_DIR}/unsupported.js`, RUN_COMMAND_MODULE]) assert.ok(paths.includes(expected), expected);
  });

  it('keeps every family to itself and away from the guard above it', () => {
    assert.deepEqual(probeModules.flatMap(checkProbeImports), []);
  });

  it('registers every family entry in index.js, and nothing else imports one', () => {
    const entries = probeModules.map((module) => module.path).filter(isFamilyEntry);
    const index = probeModules.find((module) => module.path === INDEX_MODULE);
    assert.deepEqual(index?.imports.map((entry) => entry.target).filter((target) => target !== null && isFamilyEntry(target)).sort(), entries.sort());
  });
});

describe('S-CP1: selection happens once, in collect.js', () => {
  it('lets nothing outside the probe directory reach a family, and only collect.js reach the selector', () => {
    const problems = shippedModules
      .filter((module) => !module.path.startsWith(`${PROBES_DIR}/`))
      .flatMap((module) =>
        module.imports.flatMap(({ specifier, target }) => {
          if (target === null || !target.startsWith(`${PROBES_DIR}/`)) return [];
          if (target === INDEX_MODULE) return module.path === COLLECT_MODULE ? [] : [`${module.path} imports ${specifier}: only collect.js selects probes`];
          return familyOf(target) === null ? [] : [`${module.path} imports ${specifier}: a family is reached through selectProbes`];
        }),
      );
    assert.deepEqual(problems, []);
  });

  it('keeps process.platform and platform names out of the guard core', () => {
    const core = shippedModules.filter((module) => module.path.startsWith(`${GUARD_DIR}/`) && !module.path.startsWith(`${PROBES_DIR}/`));
    assert.ok(core.some((module) => module.path === `${GUARD_DIR}/decide.js`));
    const names = new RegExp(`(['"\`])(?:${FAMILY_NAMES.filter((name) => name !== 'unsupported').join('|')})\\1`);
    /** @type {string[]} */
    const problems = [];
    for (const module of core) {
      const reads = (module.code.match(/\bprocess\.platform\b/g) ?? []).length;
      if (module.path === COLLECT_MODULE ? reads > 1 : reads > 0) problems.push(`${module.path} reads process.platform ${reads} time(s)`);
      if (names.test(module.code)) problems.push(`${module.path} names a platform`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('rule 3: every probe command is abortable and runs with the C locale', () => {
  it('spawns only in run-command.js', () => {
    const spawning = probeModules.filter((module) => module.imports.some(({ specifier }) => /^(?:node:)?child_process$/.test(specifier)));
    assert.deepEqual(spawning.map((module) => module.path), [RUN_COMMAND_MODULE]);
    const runCommand = probeModules.find((module) => module.path === RUN_COMMAND_MODULE);
    // The probe child, and the taskkill that ends a timed-out tree: it is the abort itself, and its
    // output is never read.
    const spawns = findCallArguments(runCommand?.code ?? '', 'spawn');
    assert.equal(spawns.length, 2);
    assert.ok(spawns.some((text) => /^\s*file\b/.test(text) && /\benv\b/.test(text)), 'the probe child gets the environment it was given');
    assert.ok(spawns.some((text) => /^\s*'taskkill'/.test(text)));
  });

  it('passes the caller signal at every runner call', () => {
    /** @type {string[]} */
    const problems = [];
    for (const module of probeModules) {
      for (const name of ['run', 'runCommand']) {
        for (const text of findCallArguments(module.code, name)) {
          // A wrapper that forwards the caller's own options forwards the signal with them.
          if (!/\bsignal\b/.test(text) && !/\.\.\.options\b/.test(text)) problems.push(`${module.path}: ${name}(${text.replace(/\s+/g, ' ').trim()})`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('keeps family entries on the runner selection hands them', () => {
    const entries = probeModules.filter((module) => isFamilyEntry(module.path));
    assert.deepEqual(entries.filter((module) => /\brunCommand\b/.test(module.code)).map((module) => module.path), []);
  });

  for (const platform of [...PROBE_FAMILIES, 'aix']) {
    it(`${platform}: every command a reader starts carries the signal, LC_ALL=C and LANG=C`, async () => {
      /** @type {Array<{ file: string, options: import('../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunOptions }>} */
      const calls = [];
      const run = async (/** @type {string} */ file, /** @type {readonly string[]} */ _args, /** @type {any} */ options) => {
        calls.push({ file, options });
        return { ok: false, exitCode: 1, stdout: '', stderr: '', error: 'exited with code 1', timedOut: false };
      };
      const probes = selectProbes({ platform, env: { SystemRoot: 'C:\\Windows', LANG: 'de_DE.UTF-8', lc_all: 'de_DE' }, run, now: () => 0 });
      const signal = new AbortController().signal;
      await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000, signal });
      await probes.readUnityPresence({ timeoutMs: 1000, signal });
      await probes.readProcessSnapshot({ patterns: ['AssetImportWorker'], sampleMs: 100, sampleCpu: true, timeoutMs: 1000, signal });
      if (platform === 'win32') assert.equal(calls.length, 3, 'nvidia-smi, tasklist and PowerShell each went through the selected runner');
      if (!PROBE_FAMILIES.includes(platform)) assert.equal(calls.length, 0, 'a platform without a family starts nothing');
      for (const call of calls) {
        assert.equal(call.options.signal, signal, call.file);
        assert.equal(call.options.env?.LC_ALL, 'C', call.file);
        assert.equal(call.options.env?.LANG, 'C', call.file);
      }
    });
  }
});

describe('an unknown platform', () => {
  it('selects unsupported.js, whose every capability and read is unavailable with reason no_probe', async () => {
    for (const platform of FAMILY_NAMES.filter((name) => !PROBE_FAMILIES.includes(name)).concat(['plan9', 'constructor'])) {
      const probes = selectProbes({ platform, env: {} });
      assert.equal(probes.id, 'unsupported', platform);
      assert.ok(Object.values(probes.capabilities).every((status) => status === 'unavailable'), platform);
      const accelerator = await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
      const reads = [
        accelerator.memory,
        accelerator.utilization,
        await probes.readUnityPresence({ timeoutMs: 1000 }),
        await probes.readProcessSnapshot({ patterns: [], sampleMs: 100, sampleCpu: false, timeoutMs: 1000 }),
      ];
      for (const read of reads) assert.equal(read.status === 'unavailable' && read.reason, 'no_probe', platform);
    }
  });
});

describe('rule 4: a throwing reader answers with an error read', () => {
  it('turns a synchronous throw and a rejection into error reads', async () => {
    const broken = catchReaderFailures({
      id: 'broken',
      platform: 'test',
      backend: 'none',
      capabilities: selectProbes({ platform: 'aix' }).capabilities,
      cpuTimeResolutionMs: null,
      readAccelerator: () => {
        throw new Error('synchronous');
      },
      readUnityPresence: () => Promise.reject(new TypeError('rejected')),
      readProcessSnapshot: () => {
        // A non-Error throw value must not escape either.
        throw 'a string';
      },
    });
    const accelerator = await broken.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
    assert.equal(accelerator.deviceCount, 0);
    assert.deepEqual([accelerator.memory.status, accelerator.utilization.status], ['error', 'error']);
    assert.match(accelerator.memory.status === 'error' ? accelerator.memory.detail : '', /broken probe failed unexpectedly \(Error: synchronous\)/);
    const presence = await broken.readUnityPresence({ timeoutMs: 1000 });
    assert.deepEqual(presence, { status: 'error', capability: 'process.enumerate', reason: 'probe_failed', detail: 'the broken probe failed unexpectedly (TypeError: rejected)' });
    const snapshot = await broken.readProcessSnapshot({ patterns: [], sampleMs: 100, sampleCpu: false, timeoutMs: 1000 });
    assert.equal(snapshot.status === 'error' && snapshot.detail, 'the broken probe failed unexpectedly (a string)');
  });

  for (const platform of [...PROBE_FAMILIES, 'aix']) {
    it(`${platform}: a runner that throws synchronously never escapes a reader`, async () => {
      const run = () => {
        throw new Error('the runner broke');
      };
      const probes = selectProbes({ platform, env: {}, run, now: () => 0 });
      const accelerator = await probes.readAccelerator({ nvidiaSmiCommand: 'nvidia-smi', timeoutMs: 1000 });
      const presence = await probes.readUnityPresence({ timeoutMs: 1000 });
      const snapshot = await probes.readProcessSnapshot({ patterns: [], sampleMs: 100, sampleCpu: false, timeoutMs: 1000 });
      for (const read of [accelerator.memory, accelerator.utilization, presence, snapshot]) assert.notEqual(read.status, 'ok');
      if (platform === 'win32') {
        for (const read of [accelerator.memory, presence, snapshot]) {
          assert.equal(read.status, 'error');
          assert.match(read.status === 'error' ? read.detail : '', /the runner broke/);
        }
      }
    });
  }
});
