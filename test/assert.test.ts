import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(r.skipped, ['1 script statement(s)']);
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
