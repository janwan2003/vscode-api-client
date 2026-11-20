import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeThunderStore, isThunderBackupPath, looksLikeNedb, parseNedb, readThunderStore, type ThunderFile } from '../src/core/importers/thunderStore.ts';
import { detectAndImport } from '../src/core/importers/index.ts';
import { findThunderData, readThunderDir, thunderCandidateDirs } from '../src/core/thunderLocate.ts';
import type { ImportedCollection } from '../src/core/model.ts';

// Synthetic records in the shapes Thunder Client writes (field names as in real public thunder-tests
// folders and NeDB databases; see VENTURE.md session 17).
const COL = '72cfe652-0000-4e1c-825a-fe1e831f8e05';
const req = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  colId: COL,
  containerId: '',
  name,
  url: `{{host}}/${name.toLowerCase().replace(/\s+/g, '-')}`,
  method: 'GET',
  sortNum: 10000,
  created: '2024-03-01T10:00:00.000Z',
  modified: '2024-03-01T10:00:00.000Z',
  headers: [],
  params: [],
  tests: [],
  ...extra,
});
const nedb = (...docs: unknown[]) => docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
const titles = (c: ImportedCollection) => c.folders.flatMap((f) => f.requests.map((r) => `${f.name}|${r.title}`));
const count = (cs: ImportedCollection[]) => cs.reduce((n, c) => n + c.folders.reduce((m, f) => m + f.requests.length, 0), 0);

test('NeDB: later lines replace earlier ones, $$deleted removes, index lines ignored', () => {
  const docs = parseNedb(
    nedb(
      { $$indexCreated: { fieldName: 'colId' } },
      req('a', 'Old name'),
      req('b', 'Gone'),
      { ...req('a', 'New name'), sortNum: 20000 },
      { $$deleted: true, _id: 'b' },
    ),
  );
  assert.deepEqual(docs.map((d) => d.name), ['New name']);
  assert.equal(looksLikeNedb(nedb(req('a', 'x'), req('b', 'y'))), true);
  assert.equal(looksLikeNedb('{\n  "a": 1\n}'), false);
});

test('old NeDB storage (thunderclient.db + thunderCollection.db + thunderEnvironment.db + thunderActivity.db)', () => {
  const files: ThunderFile[] = [
    { path: 'thunderCollection.db', text: nedb({ _id: COL, colName: 'Album API', created: '2022-03-20T00:00:00.000Z', sortNum: 10000, folders: [{ _id: 'f1', name: 'Admin', containerId: '', created: '', sortNum: 1 }] }) },
    {
      path: 'thunderclient.db',
      text: nedb(
        req('r1', 'List albums', { sortNum: 20000 }),
        req('r2', 'Create album', { method: 'POST', sortNum: 10000, body: { type: 'json', raw: '{"title":"x"}', form: [] } }),
        req('r3', 'Delete all', { containerId: 'f1', method: 'DELETE' }),
        { ...req('r1', 'List albums', { sortNum: 20000 }), url: '{{host}}/albums?limit=5' },
      ),
    },
    { path: 'thunderEnvironment.db', text: nedb({ _id: 'e1', name: 'local', data: [{ name: 'host', value: 'http://localhost:8080' }], default: false }) },
    {
      path: 'thunderActivity.db',
      text: nedb(
        { ...req('h1', 'h', { colId: 'history', modified: '2024-03-02T00:00:00.000Z' }), url: 'http://localhost:8080/albums' },
        { ...req('h2', 'h', { colId: 'history', modified: '2024-03-03T00:00:00.000Z' }), url: 'http://localhost:8080/albums' },
        { ...req('h3', 'h', { colId: 'history', method: 'POST', modified: '2024-03-01T00:00:00.000Z' }), url: 'http://localhost:8080/login' },
      ),
    },
  ];
  const s = readThunderStore(files);
  assert.deepEqual(s.summary, { collections: 1, requests: 3, environments: 1, history: 2 });
  assert.equal(s.collections.length, 1);
  const [c] = s.collections;
  assert.equal(c.name, 'Album API');
  assert.deepEqual(titles(c), ['|Create album', '|List albums', 'Admin|Delete all']);
  const list = c.folders[0].requests.find((r) => r.title === 'List albums');
  assert.equal(list?.url, '{{host}}/albums?limit=5', 'the later NeDB line wins');
  assert.deepEqual(c.environments, { local: { host: 'http://localhost:8080' } });
  assert.equal(describeThunderStore(s.summary), '1 collection, 3 requests, 1 environment, 2 history entries');

  const withHistory = readThunderStore(files, { history: true });
  const h = withHistory.collections.find((x) => x.name === 'Thunder Client history');
  assert.ok(h, 'history collection');
  assert.deepEqual(h.folders[0].requests.map((r) => `${r.method} ${r.url}`), ['GET http://localhost:8080/albums', 'POST http://localhost:8080/login'], 'newest first, duplicates dropped');
  assert.equal(withHistory.summary.requests, 3, 'history is not counted as requests');
  assert.deepEqual(h.environments, { local: { host: 'http://localhost:8080' } });
});

test('current storage folder (collections/tc_col_*.json, environments/tc_env_*.json), backups skipped', () => {
  const col = { _id: COL, colName: 'Shop', created: '', sortNum: 1, folders: [], settings: { options: { baseUrl: 'https://shop.test' } }, requests: [req('r1', 'Products', { url: '/products' })] };
  const files: ThunderFile[] = [
    { path: 'collections/tc_col_shop.json', text: JSON.stringify(col, null, 2) },
    { path: 'environments/tc_env_dev.json', text: JSON.stringify({ _id: 'e', name: 'dev', default: false, sortNum: 1, created: '', modified: '', data: [{ name: 'token', value: 'abc' }] }) },
    { path: 'backup/collections/tc_col_shop.json', text: JSON.stringify({ ...col, colName: 'Shop (old)' }) },
    { path: 'collections/tc_col_shop.json.tmp', text: '{' },
    { path: 'settings.json', text: '{"theme":"dark"}' },
    { path: 'broken.json', text: '{ nope' },
  ];
  const s = readThunderStore(files);
  assert.deepEqual(s.collections.map((c) => c.name), ['Shop']);
  assert.equal(s.collections[0].folders[0].requests[0].url, 'https://shop.test/products');
  assert.deepEqual(s.collections[0].environments, { dev: { token: 'abc' } });
  assert.equal(s.skipped.length, 2);
  assert.match(s.skipped.join('\n'), /settings\.json: no Thunder Client/);
  assert.match(s.skipped.join('\n'), /broken\.json: not valid JSON/);
  assert.equal(isThunderBackupPath('_db-backup/thunderclient.json'), true);
  assert.equal(isThunderBackupPath('collections/backup.json'), false, 'only folders named backup');
});

test('Thunder 2.39 array bodies and one file per request without colId (Database Format v4 guess)', () => {
  const files: ThunderFile[] = [
    { path: 'collections/shop/tc_col_shop.json', text: JSON.stringify({ _id: 'c1', colName: 'Shop', folders: [], sortNum: 1 }) },
    { path: 'collections/shop/requests/create.json', text: JSON.stringify({ ...req('r1', 'Create', { method: 'POST', body: { type: 'json', raw: ['{', '  "a": 1', '}'], form: [] } }), colId: undefined }) },
    { path: 'collections/billing/invoices.json', text: JSON.stringify({ ...req('r2', 'Invoices'), colId: undefined }) },
  ];
  const s = readThunderStore(files);
  const shop = s.collections.find((c) => c.name === 'Shop');
  assert.ok(shop);
  assert.equal(shop.folders[0].requests[0].body, '{\n  "a": 1\n}');
  const billing = s.collections.find((c) => c.name === 'billing');
  assert.ok(billing, 'requests without a collection record are grouped by their folder');
  assert.equal(count(s.collections), 2);
});

test('legacy JSON files and an export dropped into the same folder', () => {
  const files: ThunderFile[] = [
    { path: 'thunder-tests/thunderCollection.json', text: JSON.stringify([{ _id: COL, colName: 'Legacy', folders: [] }]) },
    { path: 'thunder-tests/thunderclient.json', text: JSON.stringify([req('r1', 'One')]) },
    { path: 'export.json', text: JSON.stringify({ clientName: 'Thunder Client', collectionName: 'Exported', requests: [{ ...req('x', 'Exported one'), colId: 'other' }], folders: [] }) },
  ];
  const s = readThunderStore(files);
  assert.deepEqual(s.collections.map((c) => c.name).sort(), ['Exported', 'Legacy']);
  assert.equal(s.summary.requests, 2);
});

test('detectAndImport accepts a .db file and thunderActivity.json (website converter)', () => {
  const db = detectAndImport(nedb(req('r1', 'One'), req('r2', 'Two')), 'thunderclient.db');
  assert.equal(count(db), 2);
  const noName = detectAndImport(nedb(req('r1', 'One'), req('r2', 'Two')));
  assert.equal(count(noName), 2, 'NeDB text without a file name');
  const act = detectAndImport(JSON.stringify([{ ...req('h', 'h', { colId: 'history' }), url: 'https://x.test/a' }]), 'thunderActivity.json');
  assert.equal(act[0].name, 'Thunder Client history');
  assert.throws(() => detectAndImport(nedb({ a: 1 }, { b: 2 }), 'other.db'), /no Thunder Client requests/);
});

test('locator: candidate folders per OS and finding data in a fake home', () => {
  const linux = thunderCandidateDirs({ home: '/home/u', platform: 'linux', xdgConfig: '/home/u/.config' }).map((c) => c.dir);
  assert.ok(linux.includes('/home/u/.config/Code/User/globalStorage/rangav.vscode-thunder-client'));
  assert.ok(linux.includes('/home/u/.config/Cursor/User/globalStorage/rangav.vscode-thunder-client'));
  assert.ok(linux.includes('/home/u/.vscode-server/data/User/globalStorage/rangav.vscode-thunder-client'));
  const mac = thunderCandidateDirs({ home: '/Users/u', platform: 'darwin' }).map((c) => c.dir);
  assert.ok(mac.includes('/Users/u/Library/Application Support/Code/User/globalStorage/rangav.vscode-thunder-client'));

  const home = mkdtempSync(join(tmpdir(), 'pw-thunder-'));
  try {
    const cursor = join(home, '.config', 'Cursor', 'User', 'globalStorage', 'rangav.vscode-thunder-client');
    mkdirSync(join(cursor, 'collections'), { recursive: true });
    writeFileSync(join(cursor, 'collections', 'tc_col_a.json'), JSON.stringify({ _id: 'c', colName: 'A', folders: [], requests: [req('r', 'R', { colId: 'c' })] }));
    const empty = join(home, '.config', 'Code', 'User', 'globalStorage', 'rangav.vscode-thunder-client');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'thunderActivity.json'), '[]');
    const found = findThunderData([], { home, platform: 'linux', xdgConfig: join(home, '.config') });
    assert.deepEqual(found.map((f) => f.label), ['Cursor'], 'empty folders are not offered');
    assert.equal(found[0].summary.requests, 1);
    assert.deepEqual(readThunderDir(cursor).map((f) => f.path), ['collections/tc_col_a.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('website converter: Thunder data files dropped together keep their collection names', async () => {
  const { convertToHttp } = await import('../src/web/convert.ts');
  const out = convertToHttp([
    { name: 'thunderCollection.db', text: nedb({ _id: COL, colName: 'Album API', folders: [] }) },
    { name: 'thunderclient.db', text: nedb(req('r1', 'List albums')) },
    { name: 'thunderEnvironment.db', text: nedb({ _id: 'e', name: 'local', data: [{ name: 'host', value: 'http://localhost' }] }) },
  ]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.requests, 1);
  assert.ok(out.files.some((f) => f.path.startsWith('Album API/') && f.path.endsWith('.http')), out.files.map((f) => f.path).join(', '));
  assert.ok(out.files.some((f) => f.path.endsWith('http-client.env.json') && f.content.includes('http://localhost')));
});
