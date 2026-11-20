import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importPostman, importPostmanEnvironment } from '../src/core/importers/postman.ts';
import { MULTIPART_BOUNDARY } from '../src/core/curl.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
import { toGraphqlHttp } from '../src/core/graphql.ts';
import type { HttpRequest, ImportedCollection } from '../src/core/model.ts';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const col = importPostman(load('postman-v21.json'));
const find = (c: ImportedCollection, title: string): HttpRequest => {
  for (const f of c.folders) for (const r of f.requests) if (r.title === title) return r;
  throw new Error(`no request ${title}`);
};

test('collection name, variables and flattened folders', () => {
  assert.equal(col.name, 'Pet Store API');
  assert.deepEqual(col.variables, [
    { name: 'baseUrl', value: 'https://petstore.example.com/v2' },
    { name: 'accessToken', value: 'dev-token-123' },
  ]);
  assert.deepEqual(
    col.folders.map((f) => [f.name, f.requests.map((r) => r.title)]),
    [
      ['', ['Health check', 'Quick ping']],
      ['Pets', ['List pets', 'Create pet']],
      ['Pets / Admin', ['Delete pet', 'Upload photo']],
      ['Auth', ['Login', 'Me (API key in query)']],
      ['GraphQL', ['Pet by id']],
    ],
  );
  assert.deepEqual(col.environments, {});
});

test('noauth and string request', () => {
  assert.deepEqual(find(col, 'Health check'), { title: 'Health check', method: 'GET', url: '{{baseUrl}}/health', headers: [] });
  assert.deepEqual(find(col, 'Quick ping'), {
    title: 'Quick ping',
    method: 'GET',
    url: 'https://petstore.example.com/ping',
    headers: [{ name: 'Authorization', value: 'Bearer {{accessToken}}' }],
  });
});

test('disabled headers kept as disabled, disabled query params dropped, collection auth inherited', () => {
  const r = find(col, 'List pets');
  assert.equal(r.url, '{{baseUrl}}/pets?limit=20&status=available');
  assert.deepEqual(r.headers, [
    { name: 'Accept', value: 'application/json' },
    { name: 'X-Debug', value: '1', disabled: true },
    { name: 'Authorization', value: 'Bearer {{accessToken}}' },
  ]);
});

test('raw JSON body gets a Content-Type', () => {
  const r = find(col, 'Create pet');
  assert.equal(r.method, 'POST');
  assert.equal(r.body, '{\n  "name": "Rex",\n  "tag": "dog"\n}');
  assert.deepEqual(r.headers[0], { name: 'Content-Type', value: 'application/json' });
});

test('folder auth overrides collection auth; path variables substituted', () => {
  const r = find(col, 'Delete pet');
  assert.equal(r.method, 'DELETE');
  assert.equal(r.url, '{{baseUrl}}/pets/42');
  assert.deepEqual(r.headers, [{ name: 'Authorization', value: `Basic ${b64('admin:s3cret')}` }]);
});

test('formdata: text fields, file field as reference + warning, disabled field dropped', () => {
  const r = find(col, 'Upload photo');
  assert.equal(r.url, '{{baseUrl}}/pets/{{petId}}/photo');
  assert.equal(r.headers[0].value, `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`);
  assert.match(r.body!, /name="caption"\n\nRex at the beach\n/);
  assert.match(r.body!, /name="photo"; filename="rex.jpg"\n\n< \.\/photos\/rex\.jpg\n/);
  assert.doesNotMatch(r.body!, /draft/);
  assert.ok(col.warnings.some((w) => w.includes('Upload photo') && w.includes('photos/rex.jpg')));
});

test('urlencoded body is encoded, disabled fields dropped', () => {
  const r = find(col, 'Login');
  assert.equal(r.body, 'username=jane%40example.com&password=p%40ss%20word%261');
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
});

test('apikey in query; URL rebuilt from host/path', () => {
  const r = find(col, 'Me (API key in query)');
  assert.equal(r.url, 'https://api.example.com/v1/me?api_key={{apiKey}}');
  assert.deepEqual(r.headers, []);
});

test('graphql body becomes a REST Client GraphQL request (query, blank line, variables)', () => {
  const r = find(col, 'Pet by id');
  assert.equal(r.body, 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}\n\n{\n  "id": "42"\n}');
  assert.deepEqual(r.headers, [
    { name: 'X-Request-Id', value: 'abc' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-REQUEST-TYPE', value: 'GraphQL' },
    { name: 'Authorization', value: 'Bearer {{accessToken}}' },
  ]);
  // Written to .http and read back, it is sent as the JSON body GraphQL servers expect.
  const back = parseHttpFile(serializeHttpFile([], [r])).requests[0];
  assert.deepEqual(JSON.parse(toGraphqlHttp(back).body!), { query: 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}', variables: { id: '42' }, operationName: 'Pet' });
  // Variables given as an object, or with {{placeholders}} that are not JSON yet; empty variables are left out.
  const gq = (graphql: unknown) =>
    importPostman({ info: { name: 'G', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'q', request: { method: 'POST', url: 'https://x.test/gql', body: { mode: 'graphql', graphql } } }] }).folders[0].requests[0].body;
  assert.equal(gq({ query: '{ a }', variables: { n: 1 } }), '{ a }\n\n{\n  "n": 1\n}');
  assert.equal(gq({ query: '{ a }', variables: '{"n": {{n}}}' }), '{ a }\n\n{"n": {{n}}}');
  assert.equal(gq({ query: '{ a }', variables: '{}' }), '{ a }');
});

test('one warning per request with scripts; empty collection script ignored', () => {
  const scriptWarnings = col.warnings.filter((w) => /script/.test(w));
  // List pets' one-line `pm.test('200', () => pm.response.to.have.status(200));` now converts fully.
  assert.deepEqual(scriptWarnings, ['"Auth / Login": pre-request script and test script skipped.']);
  assert.deepEqual(find(col, 'List pets').asserts, ['status == 200']);
});

test('v2.0 object-style auth, header string, unsupported auth warning', () => {
  const c = importPostman({
    info: { name: 'v2.0', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
    item: [
      { name: 'a', request: { method: 'GET', url: 'https://e.test/a', header: 'Accept: text/plain\nX-B: 2', auth: { type: 'bearer', bearer: { token: 'T' } } } },
      { name: 'b', request: { method: 'GET', url: 'https://e.test/b', auth: { type: 'digest', digest: {} } } },
      { name: 'c', request: { method: 'GET', url: '' } },
    ],
  });
  assert.deepEqual(c.folders[0].requests[0].headers, [
    { name: 'Accept', value: 'text/plain' },
    { name: 'X-B', value: '2' },
    { name: 'Authorization', value: 'Bearer T' },
  ]);
  assert.equal(c.folders[0].requests.length, 2);
  assert.ok(c.warnings.some((w) => w.includes('digest auth')));
  assert.ok(c.warnings.some((w) => w.includes('"c"') && w.includes('no URL')));
});

test('rejects non-collections', () => {
  assert.throws(() => importPostman({ foo: 1 }), /Not a Postman collection/);
  assert.throws(() => importPostman({ id: 'x', name: 'old', order: [], requests: [] }), /v1/);
});

test('environment import skips disabled values', () => {
  assert.deepEqual(importPostmanEnvironment(load('postman-env.json')), {
    Staging: { baseUrl: 'https://staging.petstore.example.com/v2', accessToken: 'staging-token' },
  });
  assert.throws(() => importPostmanEnvironment({ info: {} }), /Not a Postman environment/);
});

test('every request round-trips through serializeHttpFile/parseHttpFile', () => {
  for (const f of col.folders) {
    const parsed = parseHttpFile(serializeHttpFile(col.variables, f.requests));
    assert.deepEqual(parsed.variables, col.variables);
    assert.equal(parsed.requests.length, f.requests.length);
    f.requests.forEach((r, i) => {
      const p = parsed.requests[i];
      assert.equal(p.title, r.title);
      assert.equal(p.method, r.method);
      assert.equal(p.url, r.url);
      assert.deepEqual(p.headers, r.headers);
      assert.equal(p.body, r.body);
    });
  }
});

// Fixture shapes taken from real public collections (trimmed and anonymised): whole tests on one
// line, `pm.expect([..]).to.include(pm.response.code)`, collection OAuth 2.0 without a stored token.
test('one-line pm.test wrappers, status lists, negated text include, above; oauth2 warned once', () => {
  const c = importPostman(load('postman-real-tests.json'));
  const login = find(c, 'Login');
  assert.deepEqual(login.asserts, [
    'status == 200',
    'body isJson',
    'status matches /^(200|201|403)$/',
    'body !contains "<script>"',
    '$.items.length > 1',
    '$.total == 2',
  ]);
  // The check inside the if-block is not converted (an @assert has no condition) and is named;
  // pm.environment.set is counted as a script statement. Everything about one request is one line.
  assert.deepEqual(c.warnings.filter((w) => w.startsWith('"Auth / Login"')), [
    '"Auth / Login": test script converted to 6 # @assert check(s); not converted: 1 check inside if/loop/callback/try ' +
      "(1 in 'conditional'), 1 other script statement(s); dynamic variable(s) {{$randomUserName}} have no Plainwire " +
      'equivalent; define them as variables or replace them.',
  ]);
  assert.equal(c.warnings.filter((w) => w.includes('OAuth 2.0')).length, 1);
  assert.ok(c.warnings.includes('Collection auth: OAuth 2.0 auth has no stored access token; not imported.'));
});

// Conditional checks: an @assert always runs, so a check that Postman only runs under a condition
// or in a loop must not become an unconditional @assert.
test('Postman checks inside if/else, loops, callbacks, try and ternaries are skipped and named', async () => {
  const { convertPostmanTests } = await import('../src/core/importers/tests.ts');
  const code = [
    'var jsonData = pm.response.json();',
    'pm.test("Status code is 200", function () {',
    '    pm.response.to.have.status(200);',
    '});',
    'pm.test("Body matches when OK", function () {',
    '    if (pm.response.code === 200) {',
    '        pm.expect(jsonData.status).to.eql("active");',
    '        if (jsonData.items) { pm.expect(jsonData.items).to.have.lengthOf(2); }',
    '    } else {',
    '        pm.expect(jsonData.error).to.exist;',
    '    }',
    '    pm.expect(jsonData.id).to.be.a("number");',
    '});',
    'pm.test("each item", () => {',
    '    jsonData.items.forEach(function (item) {',
    '        pm.expect(jsonData.total).to.be.above(0);',
    '    });',
    '    for (let i = 0; i < 3; i++) { pm.expect(jsonData.total).to.be.above(i); }',
    '});',
    'pm.test("one-liners", function () {',
    '    if (jsonData.debug) pm.expect(jsonData.trace).to.exist;',
    '    if (jsonData.debug)',
    '        pm.expect(jsonData.trace).to.be.a("string");',
    '    else pm.expect(jsonData.trace).to.not.be.undefined;',
    '    jsonData.legacy ? pm.expect(jsonData.v).to.eql(1) : pm.expect(jsonData.v).to.eql(2);',
    '    jsonData.strict && pm.expect(jsonData.name).to.eql("x");',
    '    pm.expect(jsonData.name).to.eql("Ada"); // the only unconditional one',
    '});',
    'if (pm.response.code !== 204) { pm.expect(pm.response.text()).to.include("{"); }',
    'pm.test("swallowed", () => { try { pm.expect(jsonData.x).to.eql(1); } catch (e) { console.log(e); } });',
    'pm.test("braces in strings and regexes", () => {',
    '    pm.expect(jsonData.code).to.eql("a{b");',
    '    pm.expect(jsonData.code).to.match(/^a\\{/);',
    '});',
    '/* if (x) { */',
    'pm.expect(pm.response.responseTime).to.be.below(500);',
  ].join('\n');
  const r = convertPostmanTests(code);
  assert.deepEqual(r.asserts, ['status == 200', '$.id isNumber', '$.name == "Ada"', '$.code == "a{b"', 'time < 500']);
  assert.deepEqual(r.skipped, [
    // One entry for all of them (the ternary is one statement).
    "12 checks inside if/loop/callback/try (3 in 'Body matches when OK', 2 in 'each item', 5 in 'one-liners', " +
      "1 outside any pm.test, 1 in 'swallowed')",
    // console.log in the catch block, and the regex match (no @assert form for it).
    '2 other script statement(s)',
  ]);
  assert.equal(r.conditional, 12);
});

test('Postman import warns per request with the conditional test name; unconditional checks kept', () => {
  const c = importPostman({
    info: { name: 'cond', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Get user',
        request: { method: 'GET', url: 'https://e.test/user' },
        event: [{ listen: 'test', script: { exec: [
          'pm.test("ok", function () {',
          '  pm.response.to.have.status(200);',
          '});',
          'pm.test("admin fields", function () {',
          '  const body = pm.response.json();',
          '  if (body.role === "admin") {',
          '    pm.expect(body.permissions).to.be.an("array");',
          '  }',
          '});',
        ] } }],
      },
      {
        name: 'Only conditional',
        request: { method: 'GET', url: 'https://e.test/x' },
        event: [{ listen: 'test', script: { exec: ['if (pm.response.code === 200) { pm.expect(pm.response.json().ok).to.eql(true); }'] } }],
      },
    ],
  });
  assert.deepEqual(find(c, 'Get user').asserts, ['status == 200']);
  assert.deepEqual(c.warnings, [
    `"Get user": test script converted to 1 # @assert check(s); not converted: 1 check inside if/loop/callback/try (1 in 'admin fields').`,
    '"Only conditional": test script not converted: 1 check inside if/loop/callback/try (1 outside any pm.test).',
  ]);
  assert.equal(find(c, 'Only conditional').asserts, undefined);
});

test('Postman import reports at most one warning line per request, and keeps every reason', () => {
  for (const f of ['postman-v21.json', 'postman-real-tests.json']) {
    const c = importPostman(load(f));
    const labels = c.warnings.filter((w) => w.startsWith('"')).map((w) => w.slice(0, w.indexOf('": ') + 1));
    assert.equal(new Set(labels).size, labels.length, `${f}:\n${c.warnings.join('\n')}`);
  }
  // A request with a body file, a skipped pre-request script and a conditional check: one line.
  const c = importPostman({
    info: { name: 'many', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'Upload',
      request: { method: 'POST', url: 'https://e.test/u', body: { mode: 'file', file: { src: 'a.bin' } } },
      event: [
        { listen: 'prerequest', script: { exec: ['pm.variables.set("x", 1);'] } },
        { listen: 'test', script: { exec: ['pm.response.to.have.status(201);', 'if (pm.response.code === 201) { pm.expect(pm.response.json().id).to.exist; }'] } },
      ],
    }],
  });
  assert.deepEqual(c.warnings, [
    '"Upload": body is the file "a.bin"; check that the path exists relative to the .http file; test script converted to 1 # @assert ' +
      'check(s); not converted: 1 check inside if/loop/callback/try (1 outside any pm.test); pre-request script skipped.',
  ]);
});
