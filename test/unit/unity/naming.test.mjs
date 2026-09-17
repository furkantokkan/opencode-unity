import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeSource,
  classifyFieldName,
  createNamingCollector,
  getNamingFolder,
  isGeneratedSource,
  MAX_NAMING_SAMPLE_FILES,
  parseEditorconfigNaming,
  selectNamingSample,
  summarizeCategory,
  tokenizeCSharp,
} from '../../../src/unity/naming.js';

/**
 * @param {string} source
 * @returns {string[]} `name:category:style` for every field found.
 */
function fieldsOf(source) {
  return analyzeSource(source).fields.map((field) => `${field.name}:${field.category}:${field.style}`);
}

test('strings, comments and preprocessor lines never reach the tokens', () => {
  const source = [
    '#if UNITY_EDITOR',
    'using UnityEngine; // trailing { comment',
    '/* block { comment',
    '   still a comment } */',
    'class A',
    '{',
    '    string a = "a { string with a brace";',
    '    string b = @"verbatim ""quoted"" { text";',
    '    string c = $"interpolated {a + "{nested}"} tail";',
    '    string d = """',
    '        raw { string',
    '        """;',
    "    char e = '}';",
    "    char f = '\\'';",
    '}',
    '#endif',
  ].join('\n');
  const tokens = tokenizeCSharp(source);
  const braces = tokens.filter((token) => token.value === '{' || token.value === '}');
  assert.equal(braces.length, 2, 'only the class body braces survive');
  assert.equal(tokens.some((token) => token.value === 'nested'), false);
  assert.equal(tokens.some((token) => token.value === 'UNITY_EDITOR'), false);
  assert.equal(tokens.at(-1)?.value, '}');
});

test('verbatim identifiers and unterminated literals do not break the tokenizer', () => {
  assert.deepEqual(
    tokenizeCSharp('int @class = 1;').map((token) => token.value),
    ['int', 'class', '=', '1', ';'],
  );
  assert.equal(tokenizeCSharp('string a = "unterminated').length, 3);
  assert.equal(tokenizeCSharp('string a = """unterminated raw').length, 3);
  assert.equal(tokenizeCSharp("char a = 'x").length, 3);
  assert.equal(tokenizeCSharp('/* unterminated block').length, 0);
});

test('class-scope fields are classified by access and modifiers', () => {
  const source = [
    'namespace Game',
    '{',
    '    public class Player : MonoBehaviour',
    '    {',
    '        [SerializeField] private float _speed = 1f;',
    '        [Header("Stats"), Tooltip("(text)")] private int m_Health;',
    '        private static int s_count;',
    '        private const int k_Max = 10;',
    '        public static readonly string DefaultName = "hero";',
    '        internal int Shared;',
    '        public int Score;',
    '        protected int Guarded;',
    '        private readonly System.Collections.Generic.List<int> _items = new();',
    '        private (int a, int b) _tuple;',
    '        private int[] _buffer = { 1, 2, 3 };',
    '        private int _first, _second;',
    '        public event System.Action Died;',
    '        public int Property { get; set; } = 5;',
    '        public int Expression => Score;',
    '        private void Move(int steps) { int local = steps; }',
    '        public Player(int score) { Score = score; }',
    '    }',
    '}',
  ].join('\n');
  assert.deepEqual(fieldsOf(source), [
    '_speed:privateInstance:_camel',
    'm_Health:privateInstance:m_Pascal',
    's_count:privateStatic:s_camel',
    'k_Max:constants:k_Pascal',
    'DefaultName:constants:Pascal',
    '_items:privateInstance:_camel',
    '_tuple:privateInstance:_camel',
    '_buffer:privateInstance:_camel',
    '_first:privateInstance:_camel',
    '_second:privateInstance:_camel',
  ]);
  const analysis = analyzeSource(source);
  assert.equal(analysis.serializedPrivate, 1);
  assert.equal(analysis.publicInstance, 1);
  assert.equal(analysis.namespaceUsed, true);
});

test('generic, nested and file-scoped declarations are handled', () => {
  const source = [
    'namespace Game;',
    'public struct Stats',
    '{',
    '    private System.Collections.Generic.Dictionary<string, int> _byName;',
    '    private int? _optional;',
    '    private System.Func<int, int> _factory = value => value;',
    '    public interface INested { }',
    '    private enum Mode { A, B }',
    '    private class Inner { private int _innerField; }',
    '}',
  ].join('\n');
  assert.deepEqual(fieldsOf(source), [
    '_byName:privateInstance:_camel',
    '_optional:privateInstance:_camel',
    '_factory:privateInstance:_camel',
    '_innerField:privateInstance:_camel',
  ]);
  assert.equal(analyzeSource(source).namespaceUsed, true);
});

test('interfaces and enums contribute no fields', () => {
  assert.deepEqual(fieldsOf('public interface IThing { int Value { get; } }'), []);
  assert.deepEqual(fieldsOf('public enum Mode { First, Second }'), []);
  assert.deepEqual(fieldsOf('public class Empty { }'), []);
});

test('field name styles are classified', () => {
  const styles = {
    m_speed: 'm_camel',
    m_Speed: 'm_Pascal',
    s_count: 's_camel',
    s_Count: 's_Pascal',
    k_Max: 'k_Pascal',
    k_max: 'k_camel',
    MAX_SIZE: 'UPPER_SNAKE',
    MAX: 'UPPER_SNAKE',
    _speed: '_camel',
    speed: 'camel',
    Speed: 'Pascal',
    ID: 'Pascal',
    __weird: 'other',
    max_speed: 'other',
  };
  for (const [name, style] of Object.entries(styles)) assert.equal(classifyFieldName(name), style, name);
});

test('brace style counts full blocks only', () => {
  const allman = analyzeSource('class A\n{\n    void M()\n    {\n        int x = 1;\n    }\n}\n');
  assert.equal(allman.allman >= 2 && allman.knr === 0, true);
  const knr = analyzeSource('class A {\n    void M() {\n        int x = 1;\n    }\n}\n');
  assert.equal(knr.knr >= 2 && knr.allman === 0, true);
  const oneLine = analyzeSource('class A { public int P { get; set; } }\n');
  assert.equal(oneLine.allman + oneLine.knr, 0);
});

test('a known distribution produces the expected shares', () => {
  const collector = createNamingCollector();
  const file = (folder, fields) => collector.add(`Assets/${folder}/File.cs`, `namespace N { class C { ${fields.join(' ')} } }`);
  file('Game', Array.from({ length: 30 }, (_, index) => `private int _field${index};`));
  file('Vendor', Array.from({ length: 10 }, (_, index) => `private int m_Field${index};`));
  const result = collector.result();
  assert.equal(result.files, 2);
  assert.deepEqual(result.categories.privateInstance, {
    dominant: '_camel',
    label: '_camelCase',
    topStyle: '_camel',
    share: 0.75,
    sampleSize: 40,
    source: 'sample',
  });
  assert.deepEqual(result.folders, [
    { folder: 'Assets/Game', files: 1, dominant: '_camel', label: '_camelCase', share: 1, sampleSize: 30 },
    { folder: 'Assets/Vendor', files: 1, dominant: 'mixed', label: 'mixed', share: 1, sampleSize: 10 },
  ]);
  assert.deepEqual(result.namespaces, { files: 2, share: 1 });
});

test('a small or split sample stays mixed', () => {
  const small = createNamingCollector();
  small.add('Assets/A/File.cs', `class C { ${Array.from({ length: 29 }, (_, index) => `private int _f${index};`).join('')} }`);
  assert.equal(small.result().categories.privateInstance.dominant, 'mixed');
  const split = createNamingCollector();
  const half = Array.from({ length: 20 }, (_, index) => `private int _f${index};`).join('');
  const other = Array.from({ length: 20 }, (_, index) => `private int m_F${index};`).join('');
  split.add('Assets/A/File.cs', `class C { ${half}${other} }`);
  const category = split.result().categories.privateInstance;
  assert.equal(category.sampleSize, 40);
  assert.equal(category.share, 0.5);
  assert.equal(category.dominant, 'mixed');
  assert.equal(summarizeCategory(new Map()).dominant, 'mixed');
});

test('the [SerializeField] share compares with public fields', () => {
  const collector = createNamingCollector();
  collector.add('Assets/A/File.cs', 'class C { [SerializeField] private int _a; [SerializeField] private int _b; public int C; }');
  assert.deepEqual(collector.result().serializeField, { serialized: 2, publicFields: 1, share: 0.667 });
  const none = createNamingCollector();
  none.add('Assets/A/File.cs', 'class C { private int _a; }');
  assert.equal(none.result().serializeField.share, null);
});

test('.editorconfig naming rules override the sample', () => {
  const text = [
    '[*.cs]',
    'dotnet_naming_rule.fields.symbols = field_symbols',
    'dotnet_naming_rule.fields.style = m_pascal',
    'dotnet_naming_rule.fields.severity = warning',
    'dotnet_naming_symbols.field_symbols.applicable_kinds = field',
    'dotnet_naming_symbols.field_symbols.applicable_accessibilities = private',
    'dotnet_naming_style.m_pascal.required_prefix = m_',
    'dotnet_naming_style.m_pascal.capitalization = pascal_case',
    'dotnet_naming_rule.constants.symbols = const_symbols',
    'dotnet_naming_rule.constants.style = upper',
    'dotnet_naming_symbols.const_symbols.applicable_kinds = field',
    'dotnet_naming_symbols.const_symbols.applicable_accessibilities = *',
    'dotnet_naming_symbols.const_symbols.required_modifiers = const',
    'dotnet_naming_style.upper.capitalization = all_upper',
    'dotnet_naming_style.upper.word_separator = _',
  ].join('\n');
  const naming = parseEditorconfigNaming(text);
  assert.deepEqual(naming.privateInstance, { style: 'm_Pascal', label: 'm_PascalCase', rule: 'fields' });
  assert.deepEqual(naming.privateStatic, { style: 'm_Pascal', label: 'm_PascalCase', rule: 'fields' });
  assert.deepEqual(naming.constants, { style: 'UPPER_SNAKE', label: 'UPPER_SNAKE_CASE', rule: 'constants' });

  const collector = createNamingCollector();
  collector.add('Assets/A/File.cs', 'class C { private int _a; }');
  const category = collector.result({ editorconfig: naming }).categories.privateInstance;
  assert.equal(category.dominant, 'm_Pascal');
  assert.equal(category.source, 'editorconfig');
  assert.equal(category.topStyle, '_camel', 'the sample is still reported next to the rule');
});

test('.editorconfig sections, severities and unknown styles are handled', () => {
  assert.deepEqual(parseEditorconfigNaming('[*.vb]\ndotnet_naming_rule.x.symbols = s\n'), {});
  assert.deepEqual(
    parseEditorconfigNaming(
      [
        '# comment',
        '[*.{cs,vb}]',
        'dotnet_naming_rule.x.symbols = s',
        'dotnet_naming_rule.x.style = t',
        'dotnet_naming_rule.x.severity = none',
        'dotnet_naming_symbols.s.applicable_kinds = field',
        'dotnet_naming_style.t.capitalization = camel_case',
      ].join('\n'),
    ),
    {},
    'a disabled rule is ignored',
  );
  const unusual = parseEditorconfigNaming(
    [
      '[*]',
      'dotnet_naming_rule.x.symbols = s',
      'dotnet_naming_rule.x.style = t',
      'dotnet_naming_symbols.s.applicable_kinds = field',
      'dotnet_naming_symbols.s.applicable_accessibilities = private',
      'dotnet_naming_symbols.s.required_modifiers = readonly',
      'dotnet_naming_style.t.required_prefix = x_',
      'dotnet_naming_style.t.capitalization = camel_case',
    ].join('\n'),
  );
  assert.deepEqual(unusual.privateInstance, { style: 'other', label: 'x_ + camel_case', rule: 'x' });
  assert.equal(unusual.constants, undefined);
  assert.deepEqual(
    parseEditorconfigNaming(
      ['[*.cs]', 'dotnet_naming_rule.x.symbols = s', 'dotnet_naming_rule.x.style = t', 'dotnet_naming_symbols.s.applicable_kinds = method'].join('\n'),
    ),
    {},
  );
});

test('the sample is capped and spread across the sorted files', () => {
  const paths = Array.from({ length: 1000 }, (_, index) => `Assets/File${String(index).padStart(4, '0')}.cs`);
  const sample = selectNamingSample(paths);
  assert.equal(sample.length, MAX_NAMING_SAMPLE_FILES);
  assert.equal(sample[0], paths[0]);
  assert.equal(new Set(sample).size, MAX_NAMING_SAMPLE_FILES);
  assert.ok(sample.includes(paths[997]) || sample.includes(paths[999]), 'the tail is represented');
  assert.deepEqual(selectNamingSample(paths.slice(0, 3)), paths.slice(0, 3));
});

test('generated files and folder keys', () => {
  assert.equal(isGeneratedSource('// <auto-generated />\nclass A { }'), true);
  assert.equal(isGeneratedSource('// This code was generated by a tool.\nclass A { }'), true);
  assert.equal(isGeneratedSource('class A { }'), false);
  assert.equal(getNamingFolder('Assets/Game/Combat/Weapons/Sword.cs'), 'Assets/Game/Combat');
  assert.equal(getNamingFolder('Assets/Player.cs'), 'Assets');
});
