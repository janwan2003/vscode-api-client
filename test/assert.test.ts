import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAssertion, runAssertions } from '../src/core/assert.ts';
import { parseHttpFile, replaceRequest, serializeRequest } from '../src/core/httpFile.ts';
import type { HttpResponse } from '../src/core/model.ts';

const res: HttpResponse = {
  status: 201,
  statusText: 'Created',
  headers: [['Content-Type', 'application/json; charset=utf-8'], ['Set-Cookie', 'a=1'], ['set-cookie', 'b=2'], ['X-Count', '12']],
  body: JSON.stringify({ id: 42, name: 'Ada', email: 'ada@example.com', tags: ['x', 'y'], empty: [], nested: { ok: true, nil: null }, 'a b': 1 }),
  bodyEncoding: 'utf8',
  size: 120,
  timeMs: 85,
  url: 'http://x/',
};

function results(lines: string[], r = res) {
  return runAssertions(lines, r).map((x) => [x.source, x.passed, x.message]);
}
const passes = (line: string, r = res) => runAssertions([line], r)[0].passed;

test('status, time, size subjects with comparison operators', () => {
  for (const l of ['status == 201', 'status != 200', 'status >= 200', 'status < 300', 'time < 500', 'time <= 85', 'size > 10', 'status == "201"', 'res.status eq 201', 'duration lt 1000']) {
    assert.equal(passes(l), true, l);
  }
  for (const l of ['status == 200', 'time > 500', 'status < 200']) assert.equal(passes(l), false, l);
  const [r] = runAssertions(['status == 200'], res);
  assert.equal(r.message, 'expected 200, got 201');
});

test('headers are case-insensitive and duplicates are joined', () => {
  assert.equal(passes('header content-type contains json'), true);
  assert.equal(passes('header Content-Type startsWith application/json'), true);
  assert.equal(passes('headers.x-count == 12'), true);
  assert.equal(passes('header set-cookie == "a=1, b=2"'), true);
  assert.equal(passes('header x-missing exists'), false);
  assert.equal(passes('header x-missing !exists'), true);
});

test('JSONPath subjects', () => {
  for (const l of [
    '$.id == 42', '$.id isNumber', '$.name == Ada', '$.name == "Ada"', '$.email matches /@example\\.com$/', '$.email endsWith .com',
    '$.tags contains y', '$.tags.length == 2', '$.tags[0] == x', '$.tags[-1] == y', '$.tags isArray', '$.nested isObject',
    '$.nested.ok == true', '$.nested.nil isNull', '$.empty isEmpty', '$.tags !isEmpty', "$['a b'] == 1", 'body.$.id > 40',
    '$.missing !exists', '$.id exists', '$.tags == ["x","y"]', '$.name not contains Bob',
  ]) {
    assert.equal(passes(l), true, l);
  }
  for (const l of ['$.id == 41', '$.missing exists', '$.missing == 1', '$.tags contains z', '$.name isNumber']) assert.equal(passes(l), false, l);
});

test('body subject and non-JSON bodies', () => {
  const text: HttpResponse = { ...res, headers: [['content-type', 'text/plain']], body: 'hello world' };
  assert.equal(passes('body contains world', text), true);
  assert.equal(passes('body == "hello world"', text), true);
  assert.equal(passes('body isJson', text), false);
  assert.equal(passes('body isJson'), true);
  assert.deepEqual(results(['$.id == 1'], text), [['$.id == 1', false, 'response body is not JSON']]);
  assert.equal(passes('$.id !exists', text), true);
});

test('syntax errors become failed results, never throw', () => {
  const r = runAssertions(['nonsense here', 'status', 'status == ', 'status bogus 1', 'status exists 5'], res);
  assert.ok(r.every((x) => !x.passed));
  assert.match(r[0].message, /Unknown assertion subject/);
  assert.match(r[1].message, /Missing operator/);
  assert.match(r[3].message, /Unknown operator/);
  assert.match(r[4].message, /takes no value/);
  assert.throws(() => parseAssertion('status'), /Missing operator/);
});

test('variables in expected values are resolved first', () => {
  const r = runAssertions(['$.id == {{id}}'], res, (s) => s.replace('{{id}}', '42'));
  assert.equal(r[0].passed, true);
  const bad = runAssertions(['$.id == {{id}}'], res, () => {
    throw new Error('Variable id is not defined');
  });
  assert.deepEqual([bad[0].passed, bad[0].message], [false, 'Variable id is not defined']);
});

test('httpYac ?? lines: every translated form', () => {
  const sha256 = createHash('sha256').update(res.body).digest('base64');
  const md5hex = createHash('md5').update(res.body).digest('hex');
  for (const l of [
    '?? status == 201', '?? status >= 200', '??   status   <   300', '?? duration < 500',
    '?? header content-type includes json', '?? header content-type contains json', '?? header Content-Type startsWith application/json',
    '?? header x-count == 12', '?? header x-count > 10', '?? header x-missing !exists',
    '?? body includes Ada', '?? body $.id exists', '?? body $.name == "Ada"', '?? body $.tags[1] == y',
    '?? js response.parsedBody.name == "Ada"', '?? js response.parsedBody.name == Ada', '?? js response.parsedBody.tags.length == 2',
    '?? js response.parsedBody.tags[0] == x', "?? js response.parsedBody['a b'] == 1", '?? js response.parsedBody["a b"] == 1',
    '?? js response.parsedBody.nested.ok isTrue', '?? js response.parsedBody.nested.ok isBoolean', '?? js response.parsedBody.nested.nil isNull',
    '?? js response.parsedBody.tags isArray', '?? js response.parsedBody.name isString', '?? js response.parsedBody.id isNumber',
    '?? js response.parsedBody.email matches @example\\.com$', '?? js response.parsedBody.email endsWith .com',
    '?? js response.parsedBody.email startsWith ada', '?? js response.parsedBody.id != 41', '?? js response.parsedBody.id <= 42',
    '?? js response.parsedBody exists', '?? js response.body.id isNumber', '?? js response.body includes "email"',
    '?? js response.statusCode == 201', "?? js response.headers['content-type'] includes json", '?? js response.headers["x-count"] == 12',
    '?? js response.headers.connection !exists',
    `?? body sha256 ${sha256}`, `?? body md5 ${md5hex}`, `?? js response.parsedBody.name sha512 ${createHash('sha512').update('Ada').digest('base64')}`,
  ]) {
    const [r] = runAssertions([l], res);
    assert.equal(r.passed, true, `${l}: ${r.message}`);
    assert.equal(r.source, l);
  }
  for (const l of ['?? status == 200', '?? js response.parsedBody.nested.ok isFalse', '?? js response.parsedBody.missing exists', '?? body sha256 AAAA', '?? duration > 1000']) {
    assert.equal(passes(l), false, l);
  }
  assert.equal(runAssertions(['?? status == 200'], res)[0].message, 'expected 200, got 201');
  // isTrue / isFalse also work in # @assert lines (true/false and the strings "true"/"false" only).
  assert.equal(passes('$.nested.ok isTrue'), true);
  assert.equal(passes('$.id isTrue'), false);
});

test('httpYac ?? lines that are not translated fail with "unsupported httpYac assertion", never throw or pass', () => {
  const lines = [
    '?? js response.parsedBody.tags.map(t => t.toUpperCase()).includes("X") isTrue',
    '?? js JSON.stringify(response.parsedBody) includes Ada',
    '?? js response.parsedBody.name.toLowerCase() == ada',
    '?? js process.exit(1)',
    '?? js',
    '?? xpath /root/id exists',
    '?? md5 == abc',
    '?? $.id exists',
    '?? status bogus 1',
    '?? status ==',
    '?? header',
    '??',
  ];
  const r = runAssertions(lines, res);
  assert.equal(r.length, lines.length);
  for (const [i, x] of r.entries()) {
    assert.equal(x.passed, false, lines[i]);
    assert.equal(x.source, lines[i]);
    assert.ok(x.message.startsWith(`unsupported httpYac assertion "${lines[i].trim()}": `), x.message);
  }
  assert.match(r[0].message, /JavaScript is never evaluated/);
  assert.match(r[5].message, /xpath is not supported/);
  assert.match(r[8].message, /Unknown operator "bogus"/);
  assert.throws(() => parseAssertion('?? xpath //a exists'), /unsupported httpYac assertion/);
  // `??x` is not an httpYac line; it goes through the normal parser.
  assert.match(runAssertions(['??x'], res)[0].message, /Unknown assertion subject/);
});

test('httpYac ?? body property paths and the other forms seen in real httpYac files', () => {
  // httpYac reads `?? body <value>` as (response.parsedBody || response.body).<value>: a property path.
  const subjects: [string, unknown][] = [
    ['?? body name == Ada', { kind: 'json', path: '$.name' }],
    ['?? body nested.ok isTrue', { kind: 'json', path: '$.nested.ok' }],
    ['?? body tags[1] == y', { kind: 'json', path: '$.tags[1]' }],
    ["?? body nested['ok'] exists", { kind: 'json', path: "$.nested['ok']" }],
    ['?? body data?.items?.[0]?.id isNumber', { kind: 'json', path: '$.data.items[0].id' }],
    ['?? js response.parsedBody?.name == Ada', { kind: 'json', path: '$.name' }],
    ['?? js response.parsedBody.items[3]?.nameDe == Salt', { kind: 'json', path: '$.items[3].nameDe' }],
    ['?? body contains Ada', { kind: 'body' }],
    ['?? body == {}', { kind: 'body' }],
    ['?? duration total < 500', { kind: 'time' }],
    ['?? body matches == x', { kind: 'json', path: '$.matches' }],
  ];
  for (const [line, subject] of subjects) assert.deepEqual(parseAssertion(line).subject, subject, line);
  for (const l of [
    '?? body name == Ada', '?? body id isNumber', '?? body tags isArray', '?? body tags isarray', '?? body nested.ok isTrue',
    '?? body tags contains x', '?? body tags includes y', '?? body email endsWith .com', '?? body name equals Ada',
    '?? body name not equals Bob', '?? body id === 42', '?? body id !== 41', '?? status ==201', '?? js response.parsedBody?.name == Ada',
    '?? body tags !contains z', '?? body empty isEmpty', '?? duration total < 500',
  ]) {
    const [r] = runAssertions([l], res);
    assert.equal(r.passed, true, `${l}: ${r.message}`);
  }
  for (const l of ['?? body name == Bob', '?? body missing exists', '?? body tags !contains x']) assert.equal(passes(l), false, l);
  // Unary predicates ignore trailing text, as in httpYac.
  assert.equal(parseAssertion('?? body id isNumber yes').expected, undefined);
  // `not equals` after a value (httpYac's greedy split would read `name not` + `equals`).
  assert.equal(parseAssertion('?? status not equals 200').op, '!=');
  assert.deepEqual(parseAssertion('?? body name not equals Bob').subject, { kind: 'json', path: '$.name' });
});

test('httpYac ?? lines are split as httpYac splits them: the last predicate wins', () => {
  // The value before the last predicate is JavaScript here, so it is never translated.
  for (const l of [
    '?? js response.statusCode == 404 || response.statusCode == 405',
    '?? js response.parsedBody.starts_on === today == true',
    '?? body name == a > b',
  ]) {
    const [r] = runAssertions([l], res);
    assert.equal(r.passed, false, l);
    assert.match(r.message, /^unsupported httpYac assertion/, l);
  }
  // No later predicate: the expected text keeps its spaces and symbols.
  assert.equal(parseAssertion('?? js response.parsedBody.exchangeType == USD => EUR').expected, 'USD => EUR');
  assert.equal(parseAssertion('?? body description == Plain text, with commas').expected, 'Plain text, with commas');
});

test('httpYac ?? lines httpYac itself ignores, and duration phases, fail with a clear reason', () => {
  for (const l of ['?? status 200', '?? header Content-Type ~= application/json', '?? status in [401, 403, 404]', '?? body type ping']) {
    const [r] = runAssertions([l], res);
    assert.equal(r.passed, false, l);
    assert.match(r.message, /^unsupported httpYac assertion .*httpYac itself does not read this line as a test/, l);
  }
  assert.match(runAssertions(['?? duration firstByte < 100'], res)[0].message, /firstByte timing phase is not measured/);
  assert.match(runAssertions(['?? status foo == 200'], res)[0].message, /unexpected "foo" after "status"/);
});

test('the ?? lines of a real httpYac layout run against responses: pass, fail, or unsupported', async () => {
  const { readFileSync } = await import('node:fs');
  const reqs = parseHttpFile(readFileSync(new URL('./fixtures/httpyac-real.http', import.meta.url), 'utf8')).requests;
  const reply = (status: number, body: unknown): HttpResponse => ({
    ...res, status, headers: [['Content-Type', 'application/json']], body: JSON.stringify(body), timeMs: 40,
  });
  const run = (i: number, r: HttpResponse) => runAssertions(reqs[i].asserts ?? [], r).map((x) => x.passed);
  assert.deepEqual(run(0, reply(200, { status: 'UP' })), [true, true, true, true]);
  assert.deepEqual(run(0, reply(503, { status: 'DOWN' })), [false, true, true, false]);
  assert.deepEqual(run(1, reply(201, { key: 'key-1', tags: ['tag-2'] })), [true, true, true, true]);
  assert.deepEqual(run(1, reply(201, { key: 'key-1', tags: ['tag-1'] })), [true, true, true, false]);
  // JavaScript with `||` and a line httpYac itself does not read as a test: failed, never passed.
  const random = runAssertions(reqs[2].asserts ?? [], reply(200, { items: [{ name: 'Salt' }] }));
  assert.deepEqual(random.map((x) => x.passed), [true, true, false, false]);
  assert.match(random[2].message, /^unsupported httpYac assertion/);
  assert.match(random[3].message, /httpYac itself does not read this line as a test/);
  assert.deepEqual(run(3, reply(200, { '@odata.count': 5, value: [{ name: 'First report' }] })), [true, true]);
  assert.deepEqual(run(6, reply(201, {})), [true, false]); // the xpath line is unsupported
});

test('.http files: @assert lines parse in order and round-trip', () => {
  const text = '### Create\n# @name create\n# @assert status == 201\n# @assert $.id exists\n// @assert header content-type contains json\nPOST http://x/items\nContent-Type: application/json\n\n{"a":1}\n';
  const [req] = parseHttpFile(text).requests;
  assert.deepEqual(req.asserts, ['status == 201', '$.id exists', 'header content-type contains json']);
  assert.equal(req.meta, undefined);
  const out = serializeRequest(req);
  assert.match(out, /# @assert status == 201\n# @assert \$\.id exists\n# @assert header content-type contains json\nPOST/);
  assert.deepEqual(parseHttpFile(out).requests[0].asserts, req.asserts);
  // Editing the checks through the GUI rewrites only that block.
  const edited = replaceRequest(text + '\n### Other\nGET http://x/other\n', 0, { ...req, asserts: ['status == 200'] });
  assert.match(edited, /# @assert status == 200\nPOST/);
  assert.doesNotMatch(edited, /\$\.id exists/);
  assert.match(edited, /### Other\nGET http:\/\/x\/other/);
});

test('Thunder Client tests convert to @assert lines', async () => {
  const { convertThunderTests } = await import('../src/core/importers/tests.ts');
  const r = convertThunderTests([
    { type: 'res-code', custom: '', action: 'equal', value: '200' },
    { type: 'res-time', custom: '', action: '<', value: '500' },
    { type: 'res-body', custom: '', action: 'contains', value: 'ok' },
    { type: 'res-body', custom: '', action: 'isjson', value: '' },
    { type: 'json-query', custom: 'json.data[0].id', action: 'equal', value: '7' },
    { type: 'json-query', custom: 'json.items', action: 'count', value: '3' },
    { type: 'json-query', custom: 'json.name', action: 'type', value: 'string' },
    { type: 'Content-Type', custom: '', action: 'contains', value: 'json' },
    { type: 'header', custom: 'x-rate-limit', action: 'notequal', value: '0' },
    { type: 'json-query', custom: 'json.email', action: 'regex', value: '@x\\.com$' },
    { type: 'set-env-var', custom: 'json.token', action: 'setto', value: '{{token}}' },
    { type: 'cookie', custom: 'sid', action: 'equal', value: '1' },
  ]);
  assert.deepEqual(r.asserts, [
    'status == 200', 'time < 500', 'body contains ok', 'body isJson', '$.data[0].id == 7', '$.items.length == 3',
    '$.name isString', 'header Content-Type contains json', 'header x-rate-limit != 0', '$.email matches /@x\\.com$/',
  ]);
  assert.equal(r.skipped.length, 2);
  // Every converted line parses.
  for (const a of r.asserts) parseAssertion(a);
});

test('Postman snippet tests convert to @assert lines', async () => {
  const { convertPostmanTests } = await import('../src/core/importers/tests.ts');
  const code = [
    'pm.test("Status code is 200", function () {',
    '    pm.response.to.have.status(200);',
    '});',
    'pm.test("Response time is less than 200ms", function () {',
    '    pm.expect(pm.response.responseTime).to.be.below(200);',
    '});',
    'var jsonData = pm.response.json();',
    'pm.test("Your test name", () => {',
    '    pm.expect(jsonData.value).to.eql(100);',
    '    pm.expect(pm.response.json().user.name).to.eql("Ada");',
    '    pm.expect(jsonData.items).to.have.lengthOf(2);',
    '});',
    'pm.test("Content-Type is present", function () {',
    '    pm.response.to.have.header("Content-Type");',
    '});',
    'pm.expect(pm.response.text()).to.include("string_you_want_to_search");',
    'pm.environment.set("token", jsonData.token);',
  ].join('\n');
  const r = convertPostmanTests(code);
  assert.deepEqual(r.asserts, [
    'status == 200', 'time < 200', '$.value == 100', '$.user.name == "Ada"', '$.items.length == 2',
    'header Content-Type exists', 'body contains "string_you_want_to_search"',
  ]);
  assert.deepEqual(r.skipped, ['1 other script statement(s)']);
  for (const a of r.asserts) parseAssertion(a);
});

test('Postman one-line tests are unwrapped and split into statements', async () => {
  const { convertPostmanTests } = await import('../src/core/importers/tests.ts');
  const r = convertPostmanTests([
    'pm.test("ok", () => pm.response.to.have.status(200));',
    'pm.test("ok", function () { pm.expect(pm.response.code).to.eql(201); });',
    "pm.test('a;b', () => { pm.response.to.have.header('Content-Type', 'a;b'); pm.response.to.be.json; })",
    'pm.test("arrow", async () => { pm.expect(pm.response.responseTime).to.be.below(300) });',
  ].join('\n'));
  assert.deepEqual(r.asserts, ['status == 200', 'status == 201', 'header Content-Type == "a;b"', 'body isJson', 'time < 300']);
  assert.deepEqual(r.skipped, []);
  for (const a of r.asserts) parseAssertion(a);
});
