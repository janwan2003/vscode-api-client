import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectionToFiles, collectionsToFiles, detectAndImport, safeName } from '../src/core/importers/index.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';
import type { ImportedCollection } from '../src/core/model.ts';

const read = (f: string): string => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('detects Postman collection', () => {
  const [c] = detectAndImport(read('postman-v21.json'), 'Pet Store.postman_collection.json');
  assert.equal(c.name, 'Pet Store API');
  assert.equal(c.folders.length, 5);
});

test('detects Postman environment', () => {
  const cs = detectAndImport(read('postman-env.json'), '/tmp/Staging.postman_environment.json');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].name, 'Staging');
  assert.deepEqual(cs[0].folders, []);
  assert.deepEqual(Object.keys(cs[0].environments), ['Staging']);
});

test('detects Thunder collection export and legacy arrays', () => {
  assert.equal(detectAndImport(read('thunder-collection.json'))[0].name, 'Shop API');
  const cols = detectAndImport(read('thunder-legacy/thunderCollection.json'));
  assert.deepEqual(cols.map((c) => c.name), ['Billing', 'Misc/Tools']);
  const reqs = detectAndImport(read('thunder-legacy/thunderclient.json'));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].folders[0].requests.length, 4); // 5 objects, one without a URL
  const envs = detectAndImport(read('thunder-legacy/thunderEnvironment.json'), 'thunderEnvironment.json');
  assert.deepEqual(Object.keys(envs[0].environments), ['Local', 'Production']);
});

test('detects a curl command', () => {
  const [c] = detectAndImport("curl -X DELETE 'https://e.test/x/1'");
  assert.equal(c.name, 'curl');
  assert.deepEqual(c.folders[0].requests[0], { method: 'DELETE', url: 'https://e.test/x/1', headers: [], title: 'DELETE https://e.test/x/1' });
});

test('clear errors for unknown input', () => {
  assert.throws(() => detectAndImport('not json', 'x.txt'), /x\.txt is not valid JSON/);
  assert.throws(() => detectAndImport('{"hello":1}', 'x.json'), /not a recognized export/);
  assert.throws(() => detectAndImport('{"id":"1","name":"old","order":[],"requests":[]}'), /v1/);
});

test('safeName', () => {
  assert.equal(safeName('Pets / Admin', 'f'), 'Pets - Admin');
  assert.equal(safeName('..', 'f'), 'f');
  assert.equal(safeName('  ../etc  ', 'f'), '-etc');
  assert.equal(safeName('Zażółć API v1.2', 'f'), 'Zażółć API v1.2');
  assert.equal(safeName('CON', 'f'), 'CON-');
  assert.equal(safeName('', 'collection'), 'collection');
});

test('collectionToFiles: one file per folder, variables on top, env file', () => {
  const [c] = detectAndImport(read('postman-v21.json'));
  c.environments = { dev: { baseUrl: 'http://localhost' } };
  const files = collectionToFiles(c);
  assert.deepEqual(files.map((f) => f.path), [
    'Pet Store API/requests.http',
    'Pet Store API/Pets.http',
    'Pet Store API/Pets - Admin.http',
    'Pet Store API/Auth.http',
    'Pet Store API/GraphQL.http',
    'Pet Store API/http-client.env.json',
  ]);
  const pets = files[1].content;
  assert.ok(pets.startsWith('@baseUrl = https://petstore.example.com/v2\n@accessToken = dev-token-123\n\n### List pets\n'));
  assert.equal(files[5].content, '{\n  "dev": {\n    "baseUrl": "http://localhost"\n  }\n}\n');
  // Every .http file parses back to the same requests.
  for (const f of files.filter((x) => x.path.endsWith('.http'))) {
    const folder = c.folders.find((x) => f.path.endsWith(`/${x.name === '' ? 'requests' : safeName(x.name, 'folder')}.http`))!;
    const parsed = parseHttpFile(f.content);
    assert.deepEqual(parsed.variables, c.variables);
    assert.deepEqual(parsed.requests.map((r) => [r.method, r.url, r.headers, r.body]), folder.requests.map((r) => [r.method, r.url, r.headers, r.body]));
  }
});

test('collectionToFiles de-duplicates folder and collection names', () => {
  const req = { method: 'GET', url: 'https://e.test', headers: [] };
  const c: ImportedCollection = {
    name: 'A/B',
    folders: [
      { name: '', requests: [req] },
      { name: 'requests', requests: [req] },
      { name: 'x?y', requests: [req] },
      { name: 'x*y', requests: [req] },
      { name: 'empty', requests: [] },
    ],
    variables: [],
    environments: {},
    warnings: [],
  };
  assert.deepEqual(collectionToFiles(c).map((f) => f.path), ['A-B/requests.http', 'A-B/requests-2.http', 'A-B/x-y.http', 'A-B/x-y-2.http']);
  assert.deepEqual(
    collectionsToFiles([c, { ...c, name: 'A?B', folders: [{ name: '', requests: [req] }] }]).map((f) => f.path).slice(-1),
    ['A-B-2/requests.http'],
  );
});
