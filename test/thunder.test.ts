import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importThunder, importThunderWorkspace } from '../src/core/importers/thunder.ts';
import { MULTIPART_BOUNDARY } from '../src/core/curl.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
import { toGraphqlHttp } from '../src/core/graphql.ts';
import type { HttpRequest, ImportedCollection } from '../src/core/model.ts';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const find = (c: ImportedCollection, title: string): HttpRequest => {
  for (const f of c.folders) for (const r of f.requests) if (r.title === title) return r;
  throw new Error(`no request ${title}`);
};

const col = importThunder(load('thunder-collection.json'));

test('collection export: name, nested folders, sortNum order', () => {
  assert.equal(col.name, 'Shop API');
  assert.deepEqual(
    col.folders.map((f) => [f.name, f.requests.map((r) => r.title)]),
    [
      ['', ['Status', 'Products (GraphQL)']],
      ['Users', ['Get me', 'Upload avatar']],
      ['Orders', ['List orders', 'Create order']],
      ['Orders / Refunds', ['Refund order']],
    ],
  );
  assert.deepEqual(col.variables, []);
});

test('json body, disabled header, collection bearer inherited, tests converted', () => {
  const r = find(col, 'Create order');
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '{{baseUrl}}/orders');
  assert.equal(r.body, '{\n  "sku": "ABC-1",\n  "qty": 2\n}');
  assert.deepEqual(r.headers, [
    { name: 'Accept', value: 'application/json' },
    { name: 'X-Trace', value: 'on', disabled: true },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer {{token}}' },
  ]);
  // res-code converts to an @assert; set-env-var cannot and is reported.
  assert.deepEqual(r.asserts, ['status == 201']);
  assert.ok(col.warnings.some((w) => w.startsWith('"Orders / Create order": 1 test(s) not converted') && w.includes('set-env-var')));
  // Empty tests arrays do not warn.
  assert.ok(!col.warnings.some((w) => w.includes('List orders')));
});

test('URL kept as is (query already in URL)', () => {
  assert.equal(find(col, 'List orders').url, '{{baseUrl}}/orders?page=1');
});

test('form-encoded body, custom bearer prefix, path params left in URL with a warning', () => {
  const r = find(col, 'Refund order');
  assert.equal(r.url, '{{baseUrl}}/orders/{orderId}/refund');
  assert.equal(r.body, 'reason=damaged%20item');
  assert.deepEqual(r.headers, [
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { name: 'Authorization', value: 'Token {{adminToken}}' },
  ]);
  assert.ok(col.warnings.some((w) => w.includes('Refund order') && w.includes('orderId')));
});

test('formdata with file; inherit picks folder basic auth; none means no auth', () => {
  const r = find(col, 'Upload avatar');
  assert.equal(r.method, 'PUT');
  assert.deepEqual(r.headers, [
    { name: 'Content-Type', value: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
    { name: 'Authorization', value: `Basic ${b64('admin:hunter2')}` },
  ]);
  assert.match(r.body!, /name="alt"\n\nMy face\n/);
  assert.match(r.body!, /name="file"; filename="avatar.png"\n\n< \.\/avatar\.png\n/);
  assert.deepEqual(find(col, 'Get me').headers, [{ name: 'Accept', value: 'application/json' }]);
});

test('graphql body; lower-case method normalized; unknown fields ignored', () => {
  const g = find(col, 'Products (GraphQL)');
  // REST Client GraphQL form; empty variables are left out.
  assert.equal(g.body, '{ products { id title } }');
  assert.ok(g.headers.some((h) => h.name === 'X-REQUEST-TYPE' && h.value === 'GraphQL'), JSON.stringify(g.headers));
  assert.deepEqual(JSON.parse(toGraphqlHttp(g).body!), { query: '{ products { id title } }', variables: {} });
  const s = find(col, 'Status');
  assert.equal(s.method, 'GET');
  assert.equal(s.body, undefined);
});

test('rejects input that is not a Thunder export; tolerates partial data', () => {
  assert.throws(() => importThunder({ info: { schema: 'x' }, item: [] }), /Not a Thunder Client collection/);
  assert.throws(() => importThunder([1, 2]), /Not a Thunder Client collection/);
  const partial = importThunder({ collectionName: 'P', requests: [null, 7, { url: 'https://e.test', containerId: 'missing-folder' }, { name: 'no url' }] });
  assert.deepEqual(partial.folders, [{ name: '', requests: [{ method: 'GET', url: 'https://e.test', headers: [], title: 'Untitled' }] }]);
  assert.ok(partial.warnings.some((w) => w.includes('"no url"')));
});

test('legacy workspace layout: collections, requests by colId, environments', () => {
  const dir = 'thunder-legacy';
  const cols = importThunderWorkspace({
    collections: load(`${dir}/thunderCollection.json`),
    requests: load(`${dir}/thunderclient.json`),
    environments: load(`${dir}/thunderEnvironment.json`),
  });
  assert.deepEqual(cols.map((c) => c.name), ['Billing', 'Misc/Tools', 'Thunder Client (no collection)']);
  const billing = cols[0];
  assert.deepEqual(
    billing.folders.map((f) => [f.name, f.requests.map((r) => r.title)]),
    [
      ['Invoices', ['List invoices']],
      ['Invoices / PDF', ['Download PDF']],
    ],
  );
  assert.deepEqual(find(billing, 'Download PDF').headers, [
    { name: 'Accept', value: 'application/pdf' },
    { name: 'Authorization', value: 'Bearer {{billingToken}}' },
  ]);
  assert.equal(find(billing, 'Download PDF').url, '{{host}}/invoices/:id/pdf');
  assert.deepEqual(find(billing, 'Download PDF').asserts, ['status == 200']);
  assert.equal(find(cols[1], 'Echo').body, 'hello\nworld');
  assert.ok(cols[1].warnings.some((w) => w.includes('no URL')));
  assert.equal(find(cols[2], 'Orphan').method, 'DELETE');
  for (const c of cols) {
    assert.deepEqual(c.environments, {
      Local: { host: 'http://localhost:8080', billingToken: 'local-token' },
      Production: { host: 'https://billing.example.com' },
    });
  }
  assert.throws(() => importThunderWorkspace({}), /No Thunder Client data/);
});

test('every request round-trips through serializeHttpFile/parseHttpFile', () => {
  const legacy = importThunderWorkspace({
    collections: load('thunder-legacy/thunderCollection.json'),
    requests: load('thunder-legacy/thunderclient.json'),
  });
  for (const c of [col, ...legacy]) {
    for (const f of c.folders) {
      const parsed = parseHttpFile(serializeHttpFile(c.variables, f.requests)).requests;
      assert.equal(parsed.length, f.requests.length);
      f.requests.forEach((r, i) => {
        assert.equal(parsed[i].title, r.title);
        assert.equal(parsed[i].method, r.method);
        assert.equal(parsed[i].url, r.url);
        assert.deepEqual(parsed[i].headers, r.headers);
        assert.equal(parsed[i].body, r.body);
      });
    }
  }
});

// Shapes below were checked against real Thunder Client files on GitHub (fixtures are trimmed
// and anonymised copies): the split thunder-tests/collections/tc_col_*.json layout, collection
// settings.options.baseUrl with relative request URLs, collection/folder settings.headers, quoted
// res-body values and {{#...}} dynamic variables.
test('split layout tc_col_*.json: baseUrl, inherited headers, auth none, quoted test value, dynamic variables', () => {
  const shop = importThunder(load('thunder-split/tc_col_shop.json'));
  assert.equal(shop.name, 'Shop');
  const login = find(shop, '/auth/login');
  assert.equal(login.url, 'https://api.example.com/v1/auth/login');
  // Request header first, then the collection's (disabled ones dropped); auth "none" adds nothing.
  assert.deepEqual(login.headers, [
    { name: 'X-Request-Id', value: '{{$guid}}' },
    { name: 'X-API-Key', value: '{{apiKey}}' },
    { name: 'Content-Type', value: 'application/json' },
  ]);
  // Thunder matches the quotes literally, so they must survive as part of the expected value.
  assert.deepEqual(login.asserts, ['status == 200', 'body contains "\\"LOGIN_SUCCESS\\""']);
  assert.ok(shop.warnings.some((w) => w.startsWith('"Auth / /auth/login": dynamic variable(s) {{#email}}')));

  const users = find(shop, 'List users');
  assert.equal(users.url, 'https://api.example.com/v1/users?limit=20');
  // Own header wins over the folder's; folder X-API-Key wins over the collection's; then bearer.
  assert.deepEqual(users.headers, [
    { name: 'X-Admin', value: '2' },
    { name: 'X-API-Key', value: '{{adminKey}}' },
    { name: 'Authorization', value: 'Bearer {{token}}' },
  ]);
  assert.equal(find(shop, 'Health').url, 'https://status.example.com/health');
  assert.equal(find(shop, 'Local').url, 'localhost:3000/ping');
  assert.equal(find(shop, 'Other host').url, '{{otherHost}}/status');
});

test('inherited auth that cannot be converted is reported once, not per request', () => {
  const erp = importThunder(load('thunder-split/tc_col_oauth.json'));
  assert.deepEqual(erp.folders[0].requests.map((r) => r.url), ['https://erp.example.com/{{tenant}}/api/customers', 'https://erp.example.com/{{tenant}}/api/items']);
  assert.deepEqual(erp.warnings, ['Collection auth: OAuth 2.0 auth has no stored access token; not imported.']);
});

test('legacy workspace: a leftover request without colId or URL does not create an extra collection', () => {
  const cols = importThunderWorkspace({
    collections: [{ _id: 'c1', colName: 'Api', folders: [] }],
    requests: [{ _id: 'r1', colId: 'c1', name: 'Ping', url: 'https://api.example.com/ping', method: 'GET' }, { _id: 'r2', colId: null, name: '', url: '' }],
    environments: [{ name: 'Dev', data: [{ name: 'host', value: 'http://localhost' }] }],
  });
  assert.deepEqual(cols.map((c) => c.name), ['Api']);
  assert.ok(cols[0].warnings.includes('1 request(s) did not belong to a known collection.'));
});
