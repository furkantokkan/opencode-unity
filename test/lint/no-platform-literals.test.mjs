// A platform-specific location must be computed by src/core/paths.js or measured by a guard probe,
// never spelled inline (amendment 33.8). This lint fails the build when one appears in code anywhere
// else under src/ or plugin/, so a second copy of "where Ollama keeps its log" cannot drift from the
// first one.
//
// Only code is scanned: comments and JSDoc may name a path while explaining why. Scanning is limited
// to .js, .mjs, .cjs and .json because the comment and escape rules below are JavaScript's; the one
// PowerShell asset in the tree belongs to the win32 probe, which is allowed to spell Windows paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED_ROOTS = ['src', 'plugin'];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);

/**
 * Modules that may spell a platform literal, with the reason each one is allowed to.
 * @type {ReadonlyArray<{ pathPrefix: string, reason: string }>}
 */
export const ALLOWED = [
  { pathPrefix: 'src/core/paths.js', reason: 'the one module that computes well-known locations' },
  { pathPrefix: 'src/core/platform.js', reason: 'platform detection and the support matrix' },
  { pathPrefix: 'src/core/exec.js', reason: 'PATH and PATHEXT resolution, which is what an executable extension means' },
  { pathPrefix: 'plugin/opencode-unity-lib/guard/probes/', reason: 'the probe layer measures one platform each (CP-D2)' },
  { pathPrefix: 'plugin/opencode-unity-lib/shell-classify.js', reason: 'the Windows shell grammar, which has to name executable suffixes to deny them' },
  // S23 moves the Windows image-name rule into the win32 probe; drop this entry with that step.
  { pathPrefix: 'plugin/opencode-unity-lib/guard/unity-processes.js', reason: 'the win32 process-name rule, until S23 moves it behind the probe interface' },
];

/** @type {ReadonlyArray<{ rule: string, pattern: RegExp }>} */
export const RULES = [
  { rule: 'windows-env-dir', pattern: /%(?:LOCALAPPDATA|APPDATA|USERPROFILE|HOMEPATH)%/gi },
  // A drive letter is a single letter, so `FILE:\s` and `spec:\d` in a pattern are not one.
  { rule: 'windows-drive-path', pattern: /(?<![A-Za-z0-9_$])[A-Za-z]:\\/g },
  { rule: 'windows-executable', pattern: /\.exe\b/gi },
  { rule: 'macos-applications', pattern: /\/Applications\//g },
  { rule: 'macos-library', pattern: /~\/Library/g },
  { rule: 'linux-ollama-share', pattern: /\/usr\/share\/ollama/g },
];

/** Tokens after which a `/` opens a regular expression rather than dividing. */
const REGEX_PREFIX_PUNCTUATION = '(,=:[!&|?{};+-*%^~<>';
const REGEX_PREFIX_KEYWORD = /\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void)\s*$/;

/**
 * The index of the `/` that closes the regular expression opened at `start`, or -1 when the line ends
 * first, which means this `/` was a division after all.
 * @param {string} source
 * @param {number} start
 * @returns {number}
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
 * Blanks out line and block comments, keeping every newline and every string literal, so a finding
 * still reports the line it is on. String escapes are copied through, because `'C:\\x'` is exactly the
 * spelling this lint exists to catch, and a regular expression is copied whole so a quote inside one
 * cannot desynchronise the scan.
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
        if (end === -1) {
          out += char;
          index += 1;
        } else {
          out += source.slice(index, end + 1);
          index = end + 1;
        }
      } else {
        if (char === '"' || char === "'" || char === '`') state = char;
        out += char;
        index += 1;
      }
    } else if (state === 'line') {
      out += char === '\n' ? char : ' ';
      if (char === '\n') state = 'code';
      index += 1;
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 2;
      } else {
        out += char === '\n' ? char : ' ';
        index += 1;
      }
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
 * @param {string} emitted  The code produced so far.
 * @returns {boolean}
 */
function isRegexPosition(emitted) {
  const previous = emitted.trimEnd().at(-1);
  return previous === undefined || REGEX_PREFIX_PUNCTUATION.includes(previous) || REGEX_PREFIX_KEYWORD.test(emitted.slice(-12));
}

/**
 * @param {string} source
 * @returns {Array<{ line: number, rule: string, text: string }>}
 */
export function findPlatformLiterals(source) {
  const lines = stripComments(source).split(/\r?\n/);
  return lines.flatMap((line, index) =>
    RULES.flatMap(({ rule, pattern }) => [...line.matchAll(pattern)].map((match) => ({ line: index + 1, rule, text: match[0] }))),
  );
}

/**
 * @param {string} relativePath  Repository-relative, with forward slashes.
 * @returns {boolean}
 */
export function isAllowed(relativePath) {
  return ALLOWED.some((entry) => relativePath === entry.pathPrefix || relativePath.startsWith(entry.pathPrefix));
}

/**
 * @param {string[]} files  Repository-relative paths.
 * @param {(relativePath: string) => string} readFile
 * @returns {string[]} One message per violation, ready to print.
 */
export function scanFiles(files, readFile) {
  return files.flatMap((file) =>
    isAllowed(file)
      ? []
      : findPlatformLiterals(readFile(file)).map(
          (finding) => `${file}:${finding.line} ${finding.rule} '${finding.text}' — compute it through src/core/paths.js`,
        ),
  );
}

/**
 * @param {string} root  Absolute.
 * @returns {string[]} Repository-relative paths with forward slashes, sorted.
 */
function listFiles(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) found.push(path.relative(REPO_ROOT, absolute).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found;
}

const scanned = SCANNED_ROOTS.flatMap((root) => listFiles(path.join(REPO_ROOT, root)));

describe('stripComments', () => {
  it('blanks comments but keeps line numbers', () => {
    assert.deepEqual(stripComments('a\n// C:\\x\nb').split('\n').length, 3);
    assert.equal(findPlatformLiterals('// the log lives in %LOCALAPPDATA%\\Ollama').length, 0);
    assert.equal(findPlatformLiterals('/*\n * /Applications/Ollama.app\n */').length, 0);
  });

  it('keeps string contents, including escaped backslashes', () => {
    assert.deepEqual(findPlatformLiterals("const p = 'C:\\\\Temp';"), [{ line: 1, rule: 'windows-drive-path', text: 'C:\\' }]);
    assert.equal(findPlatformLiterals('const p = "/Applications/Ollama.app";')[0].rule, 'macos-applications');
    assert.equal(findPlatformLiterals('const p = `/usr/share/ollama/.ollama`;')[0].rule, 'linux-ollama-share');
  });

  it('does not mistake a URL inside a string for a comment', () => {
    assert.equal(findPlatformLiterals("const u = 'http://127.0.0.1:11434'; const p = '~/Library/Logs';").length, 1);
  });

  it('does not end a string on an escaped quote', () => {
    assert.equal(findPlatformLiterals("const a = 'it\\'s'; // ~/Library\n").length, 0);
  });

  it('copies a regular expression whole, so a quote inside one cannot desynchronise the scan', () => {
    assert.equal(findPlatformLiterals("const q = /['\"]/;\n// %APPDATA% in a comment\n").length, 0);
    assert.deepEqual(findPlatformLiterals('const exe = /\\.exe$/;').map((finding) => finding.rule), ['windows-executable']);
  });

  it('treats a division as a division, so the comment after it is still a comment', () => {
    assert.equal(findPlatformLiterals('const half = total / 2; // ~/Library/Logs\n').length, 0);
  });

  it('does not read a drive letter out of a pattern such as FILE:\\s', () => {
    assert.equal(findPlatformLiterals('const m = /^FILE:\\s*(.+)$/;').length, 0);
    assert.equal(findPlatformLiterals('const t = `TASK:\\n${task}`;').length, 0);
  });
});

describe('the rules', () => {
  it('names every platform literal amendment 33.8 lists', () => {
    const rules = (/** @type {string} */ text) => findPlatformLiterals(text).map((finding) => finding.rule);
    assert.deepEqual(rules('x = "%LOCALAPPDATA%"'), ['windows-env-dir']);
    assert.deepEqual(rules('x = "%APPDATA%"'), ['windows-env-dir']);
    assert.deepEqual(rules('x = "D:\\\\Games"'), ['windows-drive-path']);
    assert.deepEqual(rules('x = "ollama app.exe"'), ['windows-executable']);
    assert.deepEqual(rules('x = "/Applications/Ollama.app"'), ['macos-applications']);
    assert.deepEqual(rules('x = "~/Library/Logs/ollama"'), ['macos-library']);
    assert.deepEqual(rules('x = "/usr/share/ollama/.ollama/models"'), ['linux-ollama-share']);
  });

  it('reports the line a violation is on', () => {
    assert.deepEqual(findPlatformLiterals('const a = 1;\nconst b = 2;\nconst c = "Ollama.exe";'), [{ line: 3, rule: 'windows-executable', text: '.exe' }]);
  });
});

describe('the allow-list', () => {
  it('names only files that exist, so a moved module cannot keep its exemption', () => {
    for (const entry of ALLOWED) assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.pathPrefix)), entry.pathPrefix);
  });

  it('matches a directory prefix and an exact file, and nothing else', () => {
    assert.equal(isAllowed('src/core/paths.js'), true);
    assert.equal(isAllowed('plugin/opencode-unity-lib/guard/probes/processes-win32.js'), true);
    assert.equal(isAllowed('plugin/opencode-unity-lib/guard/collect.js'), false);
    assert.equal(isAllowed('src/core/config.js'), false);
  });
});

describe('src/ and plugin/', () => {
  it('scans a tree that is actually there', () => {
    assert.ok(scanned.length > 50, `scanned ${scanned.length} files`);
    assert.ok(scanned.includes('src/core/platform.js'));
    assert.ok(scanned.includes('src/core/tiers.json'));
  });

  it('spells no platform literal outside paths.js, platform.js, exec.js and the probes', () => {
    assert.deepEqual(scanFiles(scanned, (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')), []);
  });

  it('fails the build when a module outside that list spells one, and stays quiet when an allowed one does', () => {
    const sources = {
      'src/commands/setup.js': 'const log = "%LOCALAPPDATA%\\\\Ollama\\\\server.log";\n',
      'src/core/paths.js': 'const log = "%LOCALAPPDATA%\\\\Ollama\\\\server.log";\n',
    };
    assert.deepEqual(scanFiles(Object.keys(sources), (file) => sources[/** @type {keyof typeof sources} */ (file)]), [
      "src/commands/setup.js:1 windows-env-dir '%LOCALAPPDATA%' — compute it through src/core/paths.js",
    ]);
  });
});
