import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileSchema, formatSchemaErrors } from '../../../plugin/opencode-unity-lib/json-schema.js';

describe('compileSchema keyword support', () => {
  it('refuses a schema keyword it does not implement, so no rule is silently skipped', () => {
    assert.throws(() => compileSchema({ type: 'object', allOf: [] }), /Unsupported schema keyword 'allOf'/);
    assert.throws(() => compileSchema({ type: 'object', properties: { a: { oneOf: [] } } }), /Unsupported schema keyword 'oneOf'/);
    assert.throws(() => compileSchema({ type: 'string', pattern: '^a$', format: 'uri' }), /Unsupported schema keyword 'format'/);
    assert.throws(() => compileSchema({ $ref: '#/definitions/x' }), /Only local '#\/\$defs\/<name>' references/);
    assert.throws(() => compileSchema({ type: 'wat' })(1), /Unsupported schema type 'wat'/);
  });

  it('reports the dotted path of every problem', () => {
    const validate = compileSchema({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        list: { type: 'array', items: { type: 'integer', minimum: 0 } },
        nested: { type: 'object', properties: { flag: { type: 'boolean' } } },
      },
    });
    assert.deepEqual(validate({ name: 'x' }), []);
    assert.deepEqual(validate({}), [{ path: 'name', message: 'is required' }]);
    assert.deepEqual(validate({ name: '' }), [{ path: 'name', message: 'must not be empty' }]);
    assert.deepEqual(validate({ name: 'x', extra: 1 }), [{ path: 'extra', message: 'is not a known key' }]);
    assert.deepEqual(validate({ name: 'x', list: [1, -1] }), [{ path: 'list[1]', message: 'must be >= 0' }]);
    assert.deepEqual(validate({ name: 'x', nested: { flag: 'yes' } }), [{ path: 'nested.flag', message: 'must be true or false' }]);
  });

  it('checks types the way JSON Schema does', () => {
    const validate = compileSchema({ type: 'object', properties: { a: { type: 'integer' }, b: { type: ['string', 'null'] }, c: { type: 'number' } } });
    assert.deepEqual(validate({ a: 1.5 }), [{ path: 'a', message: 'must be an integer' }]);
    assert.deepEqual(validate({ b: null }), []);
    assert.deepEqual(validate({ b: 1 }), [{ path: 'b', message: 'must be a string or null' }]);
    assert.deepEqual(validate({ c: Number.POSITIVE_INFINITY }), [{ path: 'c', message: 'must be a number' }]);
  });

  it('checks enums, constants, patterns, lengths and uniqueness', () => {
    const validate = compileSchema({
      type: 'object',
      properties: {
        mode: { enum: ['wait', 'allow'] },
        version: { const: 1 },
        id: { type: 'string', pattern: '^[a-z-]+$', maxLength: 5 },
        tags: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 2, items: { type: 'string' } },
      },
    });
    assert.deepEqual(validate({ mode: 'later' }), [{ path: 'mode', message: 'must be one of: "wait", "allow"' }]);
    assert.deepEqual(validate({ version: 2 }), [{ path: 'version', message: 'must be 1' }]);
    assert.deepEqual(validate({ id: 'Abc' }), [{ path: 'id', message: 'must match ^[a-z-]+$' }]);
    assert.deepEqual(validate({ id: 'abcdef' }), [{ path: 'id', message: 'must have at most 5 characters' }]);
    assert.deepEqual(validate({ tags: ['a', 'a'] }), [{ path: 'tags', message: 'must not contain duplicates' }]);
    assert.deepEqual(validate({ tags: [] }), [{ path: 'tags', message: 'must have at least 1 item' }]);
  });

  it('follows $defs references and anyOf branches', () => {
    const validate = compileSchema({
      type: 'object',
      properties: {
        mode: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/mode' }] },
      },
      $defs: { mode: { enum: ['allowlist', 'ask'] } },
    });
    assert.deepEqual(validate({ mode: null }), []);
    assert.deepEqual(validate({ mode: 'ask' }), []);
    // Both branches fail, so both reasons are named.
    assert.deepEqual(validate({ mode: 'yolo' }), [{ path: 'mode', message: 'does not match any allowed form (must be null; must be one of: "allowlist", "ask")' }]);
  });

  it('checks property names and typed additional properties', () => {
    const validate = compileSchema({
      type: 'object',
      propertyNames: { pattern: '^[a-z]+-[0-9a-f]{2}$' },
      additionalProperties: { type: 'object', properties: { on: { type: 'boolean' } }, additionalProperties: false },
    });
    assert.deepEqual(validate({ 'demo-a1': { on: true } }), []);
    assert.deepEqual(validate({ 'Demo A1': {} }), [{ path: 'Demo A1', message: 'is not a valid key (must match ^[a-z]+-[0-9a-f]{2}$)' }]);
    assert.deepEqual(validate({ 'demo-a1': { off: true } }), [{ path: 'demo-a1.off', message: 'is not a known key' }]);
  });

  it('checks exclusive minimums and maximums', () => {
    const validate = compileSchema({ type: 'object', properties: { a: { type: 'number', exclusiveMinimum: 0, maximum: 10 } } });
    assert.deepEqual(validate({ a: 0 }), [{ path: 'a', message: 'must be > 0' }]);
    assert.deepEqual(validate({ a: 11 }), [{ path: 'a', message: 'must be <= 10' }]);
    assert.deepEqual(validate({ a: 0.1 }), []);
  });

  it('reports the root with an empty path', () => {
    assert.deepEqual(compileSchema({ type: 'object' })('text'), [{ path: '', message: 'must be an object' }]);
  });
});

describe('formatSchemaErrors', () => {
  it('shows the first problems and counts the rest', () => {
    const errors = Array.from({ length: 7 }, (_, index) => ({ path: `key${index}`, message: 'is required' }));
    const formatted = formatSchemaErrors(errors);
    assert.match(formatted, /^key0 is required; key1/);
    assert.match(formatted, /and 2 more$/);
    assert.equal(formatSchemaErrors([{ path: '', message: 'must be an object' }]), '(root) must be an object');
    assert.equal(formatSchemaErrors([]), '');
  });
});
