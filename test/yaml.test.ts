import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../src/core/yaml.ts';

const fixture = (f: string): unknown => parseYaml(readFileSync(new URL(`./fixtures/yaml/${f}`, import.meta.url), 'utf8'));
const y = (...lines: string[]): unknown => parseYaml(lines.join('\n') + '\n');
/** A backslash, so escape sequences in YAML input stay visible as text in this file. */
const BS = '\\';

test('block mappings keep insertion order and nest', () => {
  const v = y('openapi: 3.0.3', 'info:', '  title: Pet Store', '  version: 1.0.0', 'zeta: 1', 'alpha: 2');
  assert.deepEqual(v, { openapi: '3.0.3', info: { title: 'Pet Store', version: '1.0.0' }, zeta: 1, alpha: 2 });
  assert.deepEqual(Object.keys(v as object), ['openapi', 'info', 'zeta', 'alpha']);
  assert.deepEqual(y('a:', '    deep:', '        deeper: x', 'b: y'), { a: { deep: { deeper: 'x' } }, b: 'y' });
});

test('sequences: indented, at the key indentation, nested and with compact mappings', () => {
  assert.deepEqual(y('tags:', '  - pets', '  - store'), { tags: ['pets', 'store'] });
  assert.deepEqual(y('tags:', '- pets', '- store', 'next: 1'), { tags: ['pets', 'store'], next: 1 });
  assert.deepEqual(
    y('parameters:', '- name: id', '  in: path', '  required: true', '- name: q', '  schema:', '    type: string'),
    { parameters: [{ name: 'id', in: 'path', required: true }, { name: 'q', schema: { type: 'string' } }] },
  );
  assert.deepEqual(y('- - a', '  - b', '- -   c', '-', '- ', '  x: 1'), [['a', 'b'], ['c'], null, { x: 1 }]);
  assert.deepEqual(y('security:', '  - api_key: []', '    oauth: [read, write]'), {
    security: [{ api_key: [], oauth: ['read', 'write'] }],
  });
});

test('keys: paths, spaces, quotes, numbers stay strings', () => {
  const v = y(
    'paths:',
    '  /pets/{petId}/photos:',
    '    get:',
    '      responses:',
    '        200:',
    '          description: OK',
    "        '404': {description: Missing}",
    '        default : {}',
    '  "/a: b": 1',
    '  key with spaces: 2',
    '  1.50: three',
    '  true: four',
    '  x-tag#1: five',
  );
  assert.deepEqual(v, {
    paths: {
      '/pets/{petId}/photos': { get: { responses: { 200: { description: 'OK' }, 404: { description: 'Missing' }, default: {} } } },
      '/a: b': 1,
      'key with spaces': 2,
      '1.50': 'three',
      true: 'four',
      'x-tag#1': 'five',
    },
  });
  const responses = (v as any).paths['/pets/{petId}/photos'].get.responses;
  assert.deepEqual(Object.keys(responses), ['200', '404', 'default']);
});

test('plain scalars: colons in URLs, hashes, indicators inside, trailing comments', () => {
  assert.deepEqual(
    y(
      'url: http://x:8080/a?b=c#frag',
      'time: 12:30',
      'pattern: ^[a-z]+$ # comment',
      'odd: a#b',
      'dash: -x',
      'q: ?x',
      'brackets: a[0]{1}, b',
      'quote: it\'s "fine"',
      '# full-line comment',
      'tabbed:\tvalue\t',
    ),
    {
      url: 'http://x:8080/a?b=c#frag',
      time: '12:30',
      pattern: '^[a-z]+$',
      odd: 'a#b',
      dash: '-x',
      q: '?x',
      brackets: 'a[0]{1}, b',
      quote: 'it\'s "fine"',
      tabbed: 'value',
    },
  );
});

test('multi-line plain scalars fold', () => {
  assert.deepEqual(y('description: This is', '  a long', '', '  text  ', '    more', 'next: x'), {
    description: 'This is a long\ntext more',
    next: 'x',
  });
  assert.deepEqual(y('- one', '  two', '- three'), ['one two', 'three']);
});

test('single-quoted scalars: doubled quotes and folding', () => {
  assert.deepEqual(y("a: 'it''s'", "b: ''", "c: 'line one", '   line two', '', "   para'", "d: '# not a comment'"), {
    a: "it's",
    b: '',
    c: 'line one line two\npara',
    d: '# not a comment',
  });
});

test('double-quoted scalars: escapes, folding, escaped line breaks', () => {
  const esc = ['n', 't', '"', BS, '/', 'x41', 'u00e9', 'U0001F600', '0', 'e', 'N', '_', 'L'].map((e) => BS + e).join('');
  assert.deepEqual(parseYaml(`k: "${esc}"`), {
    k: '\n\t"\\/A' + String.fromCodePoint(0xe9, 0x1f600) + '\0\x1b\x85\xa0' + String.fromCodePoint(0x2028),
  });
  assert.deepEqual(y('a: "one', '  two  ', '', '  three"'), { a: 'one two\nthree' });
  assert.deepEqual(y(`a: "abc${BS}`, `   def ${BS}`, `   ghi"`), { a: 'abcdef ghi' });
  assert.deepEqual(y(`a: "trailing ${BS} "`), { a: 'trailing  ' });
});

test('literal and folded block scalars with chomping and indentation indicators', () => {
  const doc = y(
    'literal: |',
    '  line 1',
    '    indented',
    '',
    '  line 3',
    '',
    'strip: |-',
    '  text',
    '',
    'keep: |+',
    '  text',
    '',
    '',
    'folded: >',
    '  one',
    '  two',
    '',
    '  three',
    '    more indented',
    '  four',
    'folded_strip: >-',
    '  a',
    '  b',
    'explicit: |2',
    '    four spaces',
    '  two spaces',
    'comment_inside: |',
    '  # not a comment',
    'empty: |',
    'after: x',
  );
  assert.deepEqual(doc, {
    literal: 'line 1\n  indented\n\nline 3\n',
    strip: 'text',
    keep: 'text\n\n\n',
    folded: 'one two\nthree\n  more indented\nfour\n',
    folded_strip: 'a b',
    explicit: '  four spaces\ntwo spaces\n',
    comment_inside: '# not a comment\n',
    empty: '',
    after: 'x',
  });
  assert.deepEqual(y('- |', '  in a list', '- >-', '  folded', '  item'), ['in a list\n', 'folded item']);
  assert.deepEqual(parseYaml('a: |\n  no final newline'), { a: 'no final newline' });
  assert.deepEqual(parseYaml('a: >+\n  kept\n'), { a: 'kept\n' });
});

test('flow collections: nested, multi-line, JSON style, trailing commas', () => {
  assert.deepEqual(y('a: [1, two, "three", {x: 1, y: [true, null]}, []]'), {
    a: [1, 'two', 'three', { x: 1, y: [true, null] }, []],
  });
  assert.deepEqual(y('enum: [', '  red,   # comment', '  green,', '  blue,', ']', 'obj: {', '  a: 1,', '  b', '}'), {
    enum: ['red', 'green', 'blue'],
    obj: { a: 1, b: null },
  });
  assert.deepEqual(y('{"a":1, "b": [ "c", {"d" :null}], e: http://x:80/y}'), {
    a: 1,
    b: ['c', { d: null }],
    e: 'http://x:80/y',
  });
  assert.deepEqual(y('- [a: 1, b]', '- {}'), [[{ a: 1 }, 'b'], {}]);
  assert.deepEqual(y('[multi', '  word, x]'), ['multi word', 'x']);
});

test('documents: markers, directives, comments, empty input', () => {
  assert.deepEqual(y('%YAML 1.2', '---', 'a: 1', '...', 'ignored: [', ''), { a: 1 });
  assert.deepEqual(y('# header', '---', 'a: 1', '---', 'b: 2'), { a: 1 });
  assert.deepEqual(y('--- # comment', '- x'), ['x']);
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# only a comment\n'), null);
  assert.equal(parseYaml('--- plain'), 'plain');
  assert.deepEqual(parseYaml('\uFEFFa: 1\r\nb:\r\n  - 2\r\n'), { a: 1, b: [2] });
});

test('YAML 1.2 core schema resolution', () => {
  const v = y(
    'nulls: [~, null, Null, NULL, ""]',
    'empty:',
    'bools: [true, True, TRUE, false, False, FALSE]',
    'yaml11: [yes, no, on, off, y, n]',
    'ints: [0, -12, +7, 0x1F, 0o17, 082338]',
    'floats: [1.5, -0.5, .5, 1e3, 2.5E-2, 6.]',
    'special: [.inf, -.Inf, +.INF]',
    'strings: [1.2.3, 0x, 0o8, 1_000, 2024-01-02, "123", 12:30:00, .infinity]',
  ) as Record<string, unknown[]>;
  assert.deepEqual(v.nulls, [null, null, null, null, '']);
  assert.equal(v.empty, null);
  assert.deepEqual(v.bools, [true, true, true, false, false, false]);
  assert.deepEqual(v.yaml11, ['yes', 'no', 'on', 'off', 'y', 'n']);
  assert.deepEqual(v.ints, [0, -12, 7, 31, 15, 82338]);
  assert.deepEqual(v.floats, [1.5, -0.5, 0.5, 1000, 0.025, 6]);
  assert.deepEqual(v.special, [Infinity, -Infinity, Infinity]);
  assert.deepEqual(v.strings, ['1.2.3', '0x', '0o8', '1_000', '2024-01-02', '123', '12:30:00', '.infinity']);
  assert.ok(Number.isNaN(parseYaml('.nan')));
});

test('anchors, aliases and merge keys', () => {
  const v = y(
    'base: &base',
    '  type: object',
    '  required: [id]',
    'other: &other {nullable: true, type: string}',
    'derived:',
    '  <<: *base',
    '  type: array',
    'both:',
    '  <<: [*other, *base]',
    'list:',
    '  - &item x',
    '  - *item',
    '  - *base',
    '"<<": quoted merge key is an ordinary key',
  ) as any;
  assert.deepEqual(v.derived, { type: 'array', required: ['id'] });
  assert.deepEqual(v.both, { nullable: true, type: 'string', required: ['id'] });
  assert.deepEqual(v.list, ['x', 'x', { type: 'object', required: ['id'] }]);
  assert.equal(v['<<'], 'quoted merge key is an ordinary key');
  assert.deepEqual(y('a: &x', '  k: v', 'b: *x', 'c: &y', '- 1', 'd: *y'), { a: { k: 'v' }, b: { k: 'v' }, c: [1], d: [1] });
});

test('tags: !!str honoured, others ignored, properties before a key', () => {
  assert.deepEqual(y('a: !!str 123', 'b: !!str true', 'c: !custom 5', 'd: !Ref name', 'e: ! 12', 'f: !!str', 'g: !<tag:yaml.org,2002:str> 1'), {
    a: '123',
    b: 'true',
    c: 5,
    d: 'name',
    e: 12,
    f: '',
    g: '1',
  });
  assert.deepEqual(fixture('tagged-keys.yaml'), {
    paths: {
      '/transactions/build': {
        post: {
          responses: {
            200: { description: 'A list of transaction templates ' + String.fromCodePoint(0x2014) + ' one per request.' },
            default: { description: 'Unexpected error' },
          },
          'x-codes': ['default', '404'],
        },
      },
    },
  });
});

test('explicit "? key" entries, as emitters write for long keys (block and flow)', () => {
  const long = 'api.v1.account.incoming_thing.incoming_thing_assigned_extra.incoming_thing_assigned_extra_extension_detail_record_entry';
  const path = '/v1/Accounts/{AccountSid}/IncomingThings/{ResourceSid}/AssignedExtras/{AssignedExtraSid}/Extensions/{ExtensionSid}/Details.json';
  const block = fixture('explicit-long-keys.yaml') as any;
  assert.deepEqual(Object.keys(block.paths), ['/v1/Accounts/{AccountSid}/Things.json', path]);
  assert.deepEqual(block.paths[path], {
    servers: [{ url: 'https://api.example.com' }],
    description: '',
    get: { operationId: 'FetchDetail' },
  });
  assert.deepEqual(block.components.schemas[long], {
    type: 'object',
    properties: { sid: { pattern: '^XF[0-9a-fA-F]{32}$', nullable: true } },
  });
  const flow = fixture('flow-style.yaml') as any;
  assert.equal(flow.openapi, '3.0.1');
  assert.deepEqual(Object.keys(flow.components.schemas), ['account', long]);
  assert.equal(flow.components.schemas.account.properties.sid.description, 'The unique string that identifies the resource.');
  assert.deepEqual(flow.components.schemas[long].properties.account_sid, {
    description: 'The SID of the [Account](https://www.example.com/docs/account) that created the resource.',
    maxLength: 34,
    minLength: 34,
    pattern: '^AC[0-9a-fA-F]{32}$',
  });
  assert.deepEqual(y('? a', ': 1', '? b', 'c: 2'), { a: 1, b: null, c: 2 });
  assert.deepEqual(y('[? a : b, ? c]'), [{ a: 'b' }, { c: null }]);
});

test('a "__proto__" key is an ordinary own property', () => {
  const v = y('__proto__:', '  polluted: true') as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ['__proto__']);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(v['__proto__'], { polluted: true });
});

test('errors carry a 1-based line number', () => {
  const cases: [string, RegExp][] = [
    ['a: 1\nb: "unterminated\n', /line 2: unterminated quoted string/],
    ['a:\n  b: 1\n c: 2\n', /line 3: .*indentation/],
    ['a:\n\tb: 1\n', /line 2: tabs are not allowed/],
    ['a: *nope\n', /line 1: unknown alias "\*nope"/],
    ['a: b: c\n', /line 1: unexpected ":"/],
    ['a: [1, 2\n', /line 1: unterminated flow collection/],
    ['a: [1, "x" y]\n', /line 1: expected "," or "]", found "y"/],
    [`a: "${BS}q"\n`, /line 1: invalid escape/],
    ['x: 1\n[a]: 1\n', /line 2: collections as mapping keys/],
    ['[a]: 1\n', /line 1: unexpected ":"/],
    ['a: 1\nplain text\n', /line 2: expected ":" after mapping key "plain text"/],
    ['a: - b\n', /line 1: a sequence cannot start/],
    ['? [a]\n: 1\n', /line 1: collections as mapping keys/],
    ['a: |x\n  b\n', /line 1: invalid block scalar header/],
    ['a: 1\n- b\n', /line 2:/],
    ['a: 1\n  b: 2\n', /line 2:/],
  ];
  for (const [src, re] of cases) {
    assert.throws(() => parseYaml(src), (e: unknown) => e instanceof Error && re.test(e.message), JSON.stringify(src));
  }
});
