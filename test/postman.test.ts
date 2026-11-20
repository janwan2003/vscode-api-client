import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importPostman, importPostmanEnvironment } from '../src/core/importers/postman.ts';
import { MULTIPART_BOUNDARY } from '../src/core/curl.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
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

test('graphql body becomes JSON', () => {
  const r = find(col, 'Pet by id');
  assert.deepEqual(JSON.parse(r.body!), { query: 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}', variables: { id: '42' } });
  assert.deepEqual(r.headers, [
    { name: 'X-Request-Id', value: 'abc' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer {{accessToken}}' },
  ]);
});

test('one warning per request with scripts; empty collection script ignored', () => {
  const scriptWarnings = col.warnings.filter((w) => /script/.test(w));
  assert.deepEqual(scriptWarnings, [
    '"Pets / List pets": test script skipped.',
    '"Auth / Login": pre-request script and test script skipped.',
  ]);
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
