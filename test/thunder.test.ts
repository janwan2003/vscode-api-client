import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importThunder, importThunderWorkspace } from '../src/core/importers/thunder.ts';
import { MULTIPART_BOUNDARY } from '../src/core/curl.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
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

test('json body, disabled header, collection bearer inherited, tests warned', () => {
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
  assert.ok(col.warnings.includes('"Orders / Create order": tests skipped.'));
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
  assert.deepEqual(JSON.parse(g.body!), { query: '{ products { id title } }', variables: {} });
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
  assert.ok(billing.warnings.some((w) => w.includes('Download PDF') && w.includes('tests')));
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
