import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importOpenApi } from '../src/core/importers/openapi.ts';
import { collectionsToFiles, detectAndImport } from '../src/core/importers/index.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';
import { MULTIPART_BOUNDARY } from '../src/core/curl.ts';
import type { HttpRequest, ImportedCollection } from '../src/core/model.ts';

const text = (f: string) => readFileSync(new URL(`./fixtures/openapi/${f}`, import.meta.url), 'utf8');
const shop = importOpenApi(JSON.parse(text('shop-3.1.json')));
const legacy = importOpenApi(JSON.parse(text('legacy-2.0.json')));
const find = (c: ImportedCollection, title: string): HttpRequest => {
  for (const f of c.folders) for (const r of f.requests) if (r.title === title) return r;
  throw new Error(`no request ${title}`);
};

test('OpenAPI 3.1: name, folders by tag or first path segment, environments per server', () => {
  assert.equal(shop.name, 'Shop API');
  assert.deepEqual(shop.folders.map((f) => [f.name, f.requests.map((r) => r.title)]), [
    ['Orders', ['List orders', 'Create order', 'deleteOrder', 'Update order']],
    ['files', ['Upload']],
    ['oauth', ['Me']],
  ]);
  assert.deepEqual(Object.keys(shop.environments), ['$shared', 'production', 'staging-eu']);
  assert.equal(shop.environments.$shared.baseUrl, 'https://eu.shop.example.com/v1');
  assert.deepEqual(shop.environments['staging-eu'], { baseUrl: 'https://staging.shop.example.com/v1' });
  assert.equal(shop.environments.$shared.order_id, '42');
  assert.equal(shop.environments.$shared.token, '');
});

test('required query/header params, optional ones in a comment, HTML stripped, single 2xx assert', () => {
  const r = find(shop, 'List orders');
  assert.equal(r.url, '{{baseUrl}}/orders?status=open');
  assert.deepEqual(r.headers, [
    { name: 'X-Tenant', value: 'acme' },
    { name: 'Authorization', value: 'Bearer {{token}}' },
  ]);
  assert.deepEqual(r.comments, ['Returns orders, newest first & paged.', 'Optional query: limit']);
  assert.equal(r.name, 'listOrders');
  assert.deepEqual(r.asserts, ['status == 200']);
});

test('JSON body from schema: allOf merged, readOnly skipped, $ref + recursion, nullable types, oneOf', () => {
  const r = find(shop, 'Create order');
  assert.equal(r.asserts, undefined); // two 2xx codes: no guess
  assert.deepEqual(r.headers[0], { name: 'Content-Type', value: 'application/json' });
  assert.deepEqual(JSON.parse(r.body!), {
    email: 'user@example.com',
    total: { amount: 9.5, currency: 'EUR' },
    items: [{ sku: 'string', qty: 1 }],
    note: 'string',
    ship: { at: '2025-01-01T00:00:00Z' },
  });
});

test('path variable names sanitised, apiKey in query, deprecated, duplicate operationId not reused', () => {
  const del = find(shop, 'deleteOrder');
  assert.equal(del.url, '{{baseUrl}}/orders/{{order_id}}?api_key={{apiKeyQuery}}');
  assert.deepEqual(del.comments, ['Deprecated.']);
  assert.deepEqual(del.asserts, ['status == 204']);
  const patch = find(shop, 'Update order');
  assert.equal(patch.name, undefined);
  assert.deepEqual(patch.headers, [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]); // security: [{}]
  assert.equal(patch.body, 'note=fragile%20%26%20heavy&address[city]=Krak%C3%B3w');
});

test('multipart with a file part, basic + cookie API key, operation-level server, OAuth warning once', () => {
  const up = find(shop, 'Upload');
  assert.deepEqual(up.headers, [
    { name: 'Content-Type', value: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
    { name: 'Authorization', value: 'Basic {{username}}:{{password}}' },
    { name: 'Cookie', value: 'sid={{apiKeyCookie}}' },
  ]);
  assert.match(up.body!, /name="file"; filename="file.bin"\n\n< \.\/file\.bin\n/);
  assert.match(up.body!, /name="label"\n\ninvoice\n/);
  const me = find(shop, 'Me');
  assert.equal(me.url, 'https://auth.example.com/oauth/me');
  assert.deepEqual(me.headers, [{ name: 'Authorization', value: 'Bearer {{accessToken}}' }]);
  assert.equal(shop.warnings.filter((w) => w.includes('OAuth 2.0')).length, 1);
});

test('Swagger 2.0: host + basePath, x-example, array default, body param, formData, external $ref warning', () => {
  assert.equal(legacy.environments.$shared.baseUrl, 'https://api.legacy.example.com/api');
  const get = find(legacy, 'Get user');
  assert.equal(get.url, '{{baseUrl}}/v2/users/{{id}}?fields=a%2Cb');
  assert.deepEqual(get.headers, [{ name: 'X-Key', value: '{{key}}' }]);
  assert.equal(legacy.environments.$shared.id, '7');
  assert.deepEqual(JSON.parse(find(legacy, 'Replace user').body!), { name: 'Ada' });
  assert.ok(legacy.warnings.some((w) => w.includes('External $ref other.json')));
  const av = find(legacy, 'Avatar');
  assert.match(av.body!, /name="image"; filename="image.bin"\n\n< \.\/image\.bin/);
  assert.match(av.body!, /name="alt"\n\nme\n/);
  const login = find(legacy, 'Login');
  assert.equal(login.body, 'user=string');
  assert.deepEqual(login.headers, [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  assert.deepEqual(legacy.folders.map((f) => f.name), ['users', 'avatar', 'login']);
});

test('detectAndImport recognises OpenAPI JSON and the files re-parse to the same requests', () => {
  const cs = detectAndImport(text('shop-3.1.json'), 'shop.json');
  const files = collectionsToFiles(cs);
  assert.deepEqual(files.map((f) => f.path), ['Shop API/Orders.http', 'Shop API/files.http', 'Shop API/oauth.http', 'Shop API/http-client.env.json']);
  const reparsed = parseHttpFile(files[0].content).requests;
  assert.equal(reparsed.length, 4);
  assert.deepEqual(reparsed[0].comments, ['Returns orders, newest first & paged.', 'Optional query: limit']);
  assert.deepEqual(reparsed[0].asserts, ['status == 200']);
  assert.equal(reparsed[3].body, 'note=fragile%20%26%20heavy&address[city]=Krak%C3%B3w');
});

test('not OpenAPI: readable error', () => {
  assert.throws(() => importOpenApi({ openapi: '3.0.0' }), /Not an OpenAPI/);
});

test('YAML definitions are detected and give the same result as JSON', () => {
  const yaml = [
    'openapi: 3.0.3',
    'info:',
    '  title: Pets API',
    '  version: "1"',
    'servers:',
    '  - url: https://api.example.com/v1',
    'paths:',
    '  /pets/{petId}:',
    '    get:',
    '      tags: [pets]',
    '      summary: Get a pet',
    '      operationId: getPet',
    '      parameters:',
    '        - { name: petId, in: path, required: true, schema: { type: integer, example: 7 } }',
    "      responses: { '200': { description: ok } }",
  ].join('\n');
  const [c] = detectAndImport(yaml, 'pets.yaml');
  assert.equal(c.name, 'Pets API');
  assert.equal(c.folders[0].requests[0].url, '{{baseUrl}}/pets/{{petId}}');
  assert.deepEqual(c.environments, { $shared: { baseUrl: 'https://api.example.com/v1', petId: '7' } });
  assert.throws(() => detectAndImport('openapi: 3.0.0\npaths: [\n', 'x.yaml'), /x\.yaml is not valid YAML: .*line/);
  assert.throws(() => detectAndImport('name: x\n', 'x.yml'), /not an OpenAPI/);
});

test('YAML alias bombs are rejected instead of hanging', () => {
  const lines = ['openapi: 3.0.0', 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 1; i <= 9; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
  lines.push('paths: {}');
  const t0 = Date.now();
  assert.throws(() => detectAndImport(lines.join('\n'), 'bomb.yaml'), /too much data/);
  assert.ok(Date.now() - t0 < 5000);
});

test('operations in other files: method + path kept, one summary warning; <param> segments are not folder names', () => {
  const c = importOpenApi({
    openapi: '3.0.0',
    info: { title: 'Split' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/v2/droplets/{id}': { get: { $ref: 'resources/droplets/get.yml' }, delete: { $ref: '#/components/x/del' } },
      '/<upload_url>': { put: { summary: 'Upload', responses: {} } },
    },
    components: { x: { del: { summary: 'Delete droplet', tags: ['Droplets'], responses: { 204: { description: 'gone' } } } } },
  });
  assert.deepEqual(c.folders.map((f) => [f.name, f.requests.map((r) => `${r.method} ${r.url} ${r.title}`)]), [
    ['droplets', ['GET {{baseUrl}}/v2/droplets/{{id}} GET /v2/droplets/{id}']],
    ['Droplets', ['DELETE {{baseUrl}}/v2/droplets/{{id}} Delete droplet']],
    ['', ['PUT {{baseUrl}}/<upload_url> Upload']],
  ]);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /^1 operation\(s\) are defined in other files.*bundle/i);
});
