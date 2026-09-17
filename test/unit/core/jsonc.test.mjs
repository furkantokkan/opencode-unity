import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsonParseError, parseJsonc, stringifyJson, stripBom, stripJsonComments } from '../../../src/core/jsonc.js';

describe('parseJsonc', () => {
  it('reads the comment and trailing-comma style people write config.json in', () => {
    const text = `{
  // the preset to use
  "preset": "nvidia-24gb-qwen3-coder-30b-16k", /* inline */
  "guard": {
    "maxUnityEditors": 3,
  },
  "note": "keep // this and /* this */",
}`;
    assert.deepEqual(parseJsonc(text), {
      preset: 'nvidia-24gb-qwen3-coder-30b-16k',
      guard: { maxUnityEditors: 3 },
      note: 'keep // this and /* this */',
    });
  });

  it('keeps the original line and column in error messages', () => {
    const error = /** @type {JsonParseError} */ (
      (() => {
        try {
          parseJsonc('{\n  // comment\n  "a": 1\n  "b": 2\n}', 'config.json');
          return null;
        } catch (thrown) {
          return thrown;
        }
      })()
    );
    assert.ok(error instanceof JsonParseError);
    assert.equal(error.line, 4);
    assert.match(error.message, /^config\.json: invalid JSON at line 4, column \d+/);
  });

  it('reports an unterminated block comment', () => {
    assert.throws(() => parseJsonc('{ "a": 1 /* open'), /unterminated block comment at line 1/);
  });

  it('accepts a byte-order mark', () => {
    assert.deepEqual(parseJsonc('\uFEFF{"a":1}'), { a: 1 });
    assert.equal(stripBom('\uFEFFx'), 'x');
    assert.equal(stripBom('x'), 'x');
  });

  it('keeps escaped quotes and backslashes inside strings', () => {
    assert.deepEqual(parseJsonc('{"path": "C:\\\\dir\\\\file", "quote": "say \\"hi\\""}'), { path: 'C:\\dir\\file', quote: 'say "hi"' });
  });
});

describe('stripJsonComments', () => {
  it('replaces comments with spaces so positions do not move', () => {
    const text = '{"a": 1} // tail';
    const cleaned = stripJsonComments(text);
    assert.equal(cleaned.length, text.length);
    assert.equal(cleaned.trimEnd(), '{"a": 1}');
  });

  it('keeps line breaks inside block comments', () => {
    const cleaned = stripJsonComments('{\n/* two\nlines */\n"a": 1}');
    assert.equal(cleaned.split('\n').length, 4);
  });

  it('removes a trailing comma before a closing bracket only', () => {
    assert.deepEqual(JSON.parse(stripJsonComments('[1, 2, ]')), [1, 2]);
    assert.deepEqual(JSON.parse(stripJsonComments('{"a": [1,\n],\n}')), { a: [1] });
    assert.deepEqual(JSON.parse(stripJsonComments('{"a": "x,", "b": 1}')), { a: 'x,', b: 1 });
  });
});

describe('stringifyJson', () => {
  it('writes two-space indent and a final newline', () => {
    assert.equal(stringifyJson({ a: 1 }), '{\n  "a": 1\n}\n');
  });
});
