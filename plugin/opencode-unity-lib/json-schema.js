// A small JSON Schema validator for the keyword subset our own schema files use. It runs in Node (CLI)
// and in Bun (plugin), so it imports nothing. An unsupported keyword is a compile error, never a silently
// skipped rule, so a schema can never look stricter than it is.

const ANNOTATION_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
]);

const VALIDATION_KEYWORDS = new Set([
  '$defs',
  '$ref',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
]);

const TYPE_NAMES = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  number: 'a number',
  integer: 'an integer',
  boolean: 'true or false',
  null: 'null',
};

/**
 * @typedef {object} SchemaError
 * @property {string} path     Dotted path such as `guard.maxGpuUtilPercent` or `list[0]`; '' is the root.
 * @property {string} message
 */

/**
 * @callback SchemaValidator
 * @param {unknown} value
 * @returns {SchemaError[]}
 */

/**
 * Checks the schema once and returns a validator.
 * @param {Record<string, any>} schema
 * @returns {SchemaValidator}
 */
export function compileSchema(schema) {
  checkKeywords(schema, '#');
  /** @type {Map<string, RegExp>} */
  const patterns = new Map();
  const context = { root: schema, patterns };
  return (value) => {
    /** @type {SchemaError[]} */
    const errors = [];
    validateNode(schema, value, '', errors, context);
    return errors;
  };
}

/**
 * @param {SchemaError[]} errors
 * @param {number} [limit]
 * @returns {string}
 */
export function formatSchemaErrors(errors, limit = 5) {
  const shown = errors.slice(0, limit).map((error) => `${error.path || '(root)'} ${error.message}`);
  const hidden = errors.length - shown.length;
  return hidden > 0 ? `${shown.join('; ')}; and ${hidden} more` : shown.join('; ');
}

/**
 * @param {unknown} schema
 * @param {string} location
 */
function checkKeywords(schema, location) {
  if (typeof schema === 'boolean') return;
  if (!isPlainObject(schema)) throw new TypeError(`Schema at ${location} must be an object or a boolean`);
  const node = /** @type {Record<string, any>} */ (schema);
  for (const keyword of Object.keys(node)) {
    if (!ANNOTATION_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
      throw new TypeError(`Unsupported schema keyword '${keyword}' at ${location}`);
    }
  }
  for (const key of ['properties', '$defs']) {
    for (const [name, child] of Object.entries(node[key] ?? {})) checkKeywords(child, `${location}/${key}/${name}`);
  }
  for (const key of ['items', 'additionalProperties', 'propertyNames']) {
    if (node[key] !== undefined) checkKeywords(node[key], `${location}/${key}`);
  }
  (node.anyOf ?? []).forEach((/** @type {unknown} */ child, /** @type {number} */ index) => checkKeywords(child, `${location}/anyOf/${index}`));
  if (node.$ref !== undefined && !/^#\/\$defs\/[^/]+$/.test(node.$ref)) {
    throw new TypeError(`Only local '#/$defs/<name>' references are supported, got '${node.$ref}' at ${location}`);
  }
}

/**
 * @param {Record<string, any> | boolean} schema
 * @param {unknown} value
 * @param {string} path
 * @param {SchemaError[]} errors
 * @param {{ root: Record<string, any>, patterns: Map<string, RegExp> }} context
 */
function validateNode(schema, value, path, errors, context) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: 'is not allowed' });
    return;
  }
  if (schema.$ref !== undefined) {
    const target = context.root.$defs?.[schema.$ref.slice('#/$defs/'.length)];
    if (target === undefined) throw new TypeError(`Unresolved schema reference '${schema.$ref}'`);
    validateNode(target, value, path, errors, context);
  }
  if (schema.anyOf !== undefined) {
    validateAnyOf(schema.anyOf, value, path, errors, context);
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push({ path, message: `must be ${describeTypes(schema.type)}` });
    return;
  }
  if (schema.const !== undefined && !isSameValue(schema.const, value)) {
    errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((/** @type {unknown} */ option) => isSameValue(option, value))) {
    errors.push({ path, message: `must be one of: ${schema.enum.map((/** @type {unknown} */ option) => JSON.stringify(option)).join(', ')}` });
  }
  if (typeof value === 'number') validateNumber(schema, value, path, errors);
  if (typeof value === 'string') validateString(schema, value, path, errors, context);
  if (Array.isArray(value)) validateArray(schema, value, path, errors, context);
  if (isPlainObject(value)) validateObject(schema, /** @type {Record<string, unknown>} */ (value), path, errors, context);
}

/**
 * @param {Array<Record<string, any> | boolean>} branches
 * @param {unknown} value
 * @param {string} path
 * @param {SchemaError[]} errors
 * @param {{ root: Record<string, any>, patterns: Map<string, RegExp> }} context
 */
function validateAnyOf(branches, value, path, errors, context) {
  /** @type {SchemaError[][]} */
  const failures = [];
  for (const branch of branches) {
    /** @type {SchemaError[]} */
    const branchErrors = [];
    validateNode(branch, value, path, branchErrors, context);
    if (branchErrors.length === 0) return;
    failures.push(branchErrors);
  }
  // Every branch failed. When each one has a single complaint about this value, name them all: with two
  // branches "must be null" alone would hide the interesting half.
  if (failures.length > 0 && failures.every((branchErrors) => branchErrors.length === 1 && branchErrors[0].path === path)) {
    const messages = [...new Set(failures.map((branchErrors) => branchErrors[0].message))];
    errors.push({ path, message: messages.length === 1 ? messages[0] : `does not match any allowed form (${messages.join('; ')})` });
    return;
  }
  const closest = failures.reduce((/** @type {SchemaError[] | undefined} */ best, branchErrors) => (!best || branchErrors.length < best.length ? branchErrors : best), undefined);
  errors.push(...(closest ?? [{ path, message: 'does not match any allowed form' }]));
}

/**
 * @param {Record<string, any>} schema
 * @param {number} value
 * @param {string} path
 * @param {SchemaError[]} errors
 */
function validateNumber(schema, value, path, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
  if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
  }
}

/**
 * @param {Record<string, any>} schema
 * @param {string} value
 * @param {string} path
 * @param {SchemaError[]} errors
 * @param {{ patterns: Map<string, RegExp> }} context
 */
function validateString(schema, value, path, errors, context) {
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    errors.push({ path, message: schema.minLength === 1 ? 'must not be empty' : `must have at least ${schema.minLength} characters` });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    errors.push({ path, message: `must have at most ${schema.maxLength} characters` });
  }
  if (schema.pattern !== undefined && !getPattern(schema.pattern, context).test(value)) {
    errors.push({ path, message: `must match ${schema.pattern}` });
  }
}

/**
 * @param {Record<string, any>} schema
 * @param {unknown[]} value
 * @param {string} path
 * @param {SchemaError[]} errors
 * @param {{ root: Record<string, any>, patterns: Map<string, RegExp> }} context
 */
function validateArray(schema, value, path, errors, context) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: `must have at most ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}` });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => JSON.stringify(item)));
    if (seen.size !== value.length) errors.push({ path, message: 'must not contain duplicates' });
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors, context));
  }
}

/**
 * @param {Record<string, any>} schema
 * @param {Record<string, unknown>} value
 * @param {string} path
 * @param {SchemaError[]} errors
 * @param {{ root: Record<string, any>, patterns: Map<string, RegExp> }} context
 */
function validateObject(schema, value, path, errors, context) {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) errors.push({ path: joinPath(path, key), message: 'is required' });
  }
  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = joinPath(path, key);
    if (schema.propertyNames !== undefined) {
      /** @type {SchemaError[]} */
      const nameErrors = [];
      validateNode(schema.propertyNames, key, childPath, nameErrors, context);
      if (nameErrors.length > 0) {
        errors.push({ path: childPath, message: `is not a valid key (${nameErrors[0].message})` });
        continue;
      }
    }
    if (Object.hasOwn(properties, key)) {
      validateNode(properties[key], child, childPath, errors, context);
    } else if (schema.additionalProperties === false) {
      errors.push({ path: childPath, message: 'is not a known key' });
    } else if (schema.additionalProperties !== undefined) {
      validateNode(schema.additionalProperties, child, childPath, errors, context);
    }
  }
}

/**
 * @param {string | string[]} types
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(types, value) {
  const list = Array.isArray(types) ? types : [types];
  return list.some((type) => {
    switch (type) {
      case 'object':
        return isPlainObject(value);
      case 'array':
        return Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'integer':
        return Number.isSafeInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      default:
        throw new TypeError(`Unsupported schema type '${type}'`);
    }
  });
}

/**
 * @param {string | string[]} types
 * @returns {string}
 */
function describeTypes(types) {
  const list = Array.isArray(types) ? types : [types];
  return list.map((type) => TYPE_NAMES[/** @type {keyof typeof TYPE_NAMES} */ (type)] ?? type).join(' or ');
}

/**
 * @param {string} pattern
 * @param {{ patterns: Map<string, RegExp> }} context
 * @returns {RegExp}
 */
function getPattern(pattern, context) {
  let regex = context.patterns.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern, 'u');
    context.patterns.set(pattern, regex);
  }
  return regex;
}

/**
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {boolean}
 */
function isSameValue(expected, actual) {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/**
 * @param {string} parent
 * @param {string} key
 * @returns {string}
 */
function joinPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
