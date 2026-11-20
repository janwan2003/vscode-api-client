import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHttpFile } from '../src/core/httpFile.ts';
import { chainedNames, deleteRequest, duplicateRequest, insertBlock, moveRequest, moveRequests, moveRequestToFile, renameRequest, requestBlock } from '../src/core/organize.ts';
import { buildFolderTree, findFolder, invalidName, parentFolder } from '../src/core/folders.ts';

const file = [
  '@host = https://api.example.com',
  '# Users API',
  '',
  'GET {{host}}/users',
  '',
  '### Create user',
  '# @name create',
  'POST {{host}}/users',
  'Content-Type: application/json',
  '',
  '{',
  '  "name": "a"',
  '',
  '',
  '',
  '}',
  '',
  '?? status == 201',
  '',
  '### Get created',
  '@id = {{create.response.body.$.id}}',
  'GET {{host}}/users/{{id}}',
  '',
].join('\n');

const urls = (t: string) => parseHttpFile(t).requests.map((r) => r.url);

test('requestBlock: verbatim block with ###, file variables left out', () => {
  assert.deepEqual(requestBlock(file, 0), ['###', '# Users API', '', 'GET {{host}}/users']);
  assert.deepEqual(requestBlock(file, 2), ['### Get created', 'GET {{host}}/users/{{id}}']);
  const b = requestBlock(file, 1);
  assert.equal(b[0], '### Create user');
  assert.equal(b.at(-1), '?? status == 201');
  assert.equal(b.filter((l) => l === '').length, 5, 'blank lines inside the body are kept');
});

test('deleteRequest keeps everything else byte for byte, and file variables', () => {
  const t = deleteRequest(file, 1);
  assert.deepEqual(urls(t), ['{{host}}/users', '{{host}}/users/{{id}}']);
  assert.equal(t, file.replace(/### Create user[\s\S]*?\?\? status == 201\n\n/, ''));
  const t2 = deleteRequest(file, 2);
  assert.ok(t2.includes('@id = {{create.response.body.$.id}}'), 'the variable stays in the file');
  assert.deepEqual(parseHttpFile(t2).variables.map((v) => v.name), ['host', 'id']);
  assert.ok(t2.endsWith('\n') && !t2.endsWith('\n\n\n'));
  const t0 = deleteRequest(file, 0);
  assert.ok(t0.startsWith('@host = https://api.example.com\n\n### Create user'));
  assert.deepEqual(urls(t0), ['{{host}}/users', '{{host}}/users/{{id}}']);
  assert.equal(deleteRequest('GET https://a\n', 0), '');
});

test('moveRequest reorders within a file and keeps blocks intact', () => {
  const down = moveRequest(file, 0); // to the end
  assert.deepEqual(urls(down), ['{{host}}/users', '{{host}}/users/{{id}}', '{{host}}/users']);
  assert.equal(parseHttpFile(down).requests[0].title, 'Create user');
  assert.ok(down.startsWith('@host = https://api.example.com\n'), 'file variable stays at the top');
  const up = moveRequest(file, 2, 0);
  assert.deepEqual(parseHttpFile(up).requests.map((r) => r.title ?? ''), ['Get created', '', 'Create user']);
  assert.ok(up.startsWith('@host = https://api.example.com\n\n### Get created\n'), up);
  assert.equal(parseHttpFile(up).requests[1].comments?.[0], 'Users API');
  const mid = moveRequest(file, 0, 2);
  assert.deepEqual(parseHttpFile(mid).requests.map((r) => r.title ?? ''), ['Create user', '', 'Get created']);
  assert.equal(moveRequest(file, 1, 1), file);
  assert.equal(moveRequest(file, 1, 2), file);
  // The body with its blank lines and the ?? check survive the round trip.
  const req = parseHttpFile(up).requests.find((r) => r.name === 'create')!;
  assert.equal(req.body, '{\n  "name": "a"\n\n\n\n}');
  assert.deepEqual(req.asserts, ['?? status == 201']);
});

test('moveRequestToFile moves the block to another file (append or before a request)', () => {
  const other = '### Health\nGET https://x/health\n';
  const r = moveRequestToFile(file, 1, other);
  assert.deepEqual(urls(r.from), ['{{host}}/users', '{{host}}/users/{{id}}']);
  assert.deepEqual(urls(r.to), ['https://x/health', '{{host}}/users']);
  assert.ok(r.to.startsWith('### Health\nGET https://x/health\n\n### Create user\n# @name create\n'));
  assert.ok(r.to.endsWith('?? status == 201\n'));
  const before = moveRequestToFile(file, 0, other, 0);
  assert.deepEqual(urls(before.to), ['{{host}}/users', 'https://x/health']);
  assert.ok(before.to.startsWith('###\n# Users API\n'));
  const empty = moveRequestToFile(file, 2, '');
  assert.equal(empty.to, '### Get created\nGET {{host}}/users/{{id}}\n');
});

test('insertBlock before a first request without ### keeps the file variables on top', () => {
  const t = insertBlock('@a = 1\n\nGET https://x/one\n', ['### Two', 'GET https://x/two'], 0);
  assert.equal(t, '@a = 1\n\n### Two\nGET https://x/two\n\n###\nGET https://x/one\n');
});

test('CRLF files stay CRLF', () => {
  const crlf = file.replace(/\n/g, '\r\n');
  for (const t of [moveRequest(crlf, 0), deleteRequest(crlf, 1), duplicateRequest(crlf, 1), renameRequest(crlf, 0, 'List')]) {
    assert.ok(!/[^\r]\n/.test(t), 'no bare LF');
  }
  assert.deepEqual(urls(moveRequest(crlf, 0)), urls(moveRequest(file, 0)));
});

test('duplicateRequest: copy after the original, title and @name made unique', () => {
  const t = duplicateRequest(file, 1);
  const reqs = parseHttpFile(t).requests;
  assert.deepEqual(reqs.map((r) => r.title ?? ''), ['', 'Create user', 'Create user (copy)', 'Get created']);
  assert.deepEqual(reqs.map((r) => r.name ?? ''), ['', 'create', 'create2', '']);
  assert.equal(reqs[2].body, reqs[1].body);
  const last = parseHttpFile(duplicateRequest(file, 0)).requests;
  assert.equal(last[1].title, 'GET {{host}}/users (copy)');
  assert.equal(parseHttpFile(duplicateRequest(t, 2)).requests[3].name, 'create3');
  assert.equal(parseHttpFile(duplicateRequest(file, 1, ['create2'])).requests[2].name, 'create3');
});

test('renameRequest edits the ### line only', () => {
  const t = renameRequest(file, 1, 'Add user');
  assert.equal(t, file.replace('### Create user', '### Add user'));
  assert.equal(renameRequest(file, 1, ''), file.replace('### Create user', '###'));
  const first = renameRequest(file, 0, 'List users');
  assert.ok(first.startsWith('@host = https://api.example.com\n### List users\n# Users API\n'), first);
  assert.equal(parseHttpFile(first).requests[0].title, 'List users');
  assert.equal(parseHttpFile(first).requests.length, 3);
});

test('chainedNames finds {{name.response…}} references', () => {
  assert.deepEqual([...chainedNames(file)], ['create']);
  assert.deepEqual([...chainedNames('{{ login.request.headers.X }} {{a.b}}')], ['login']);
});

test('buildFolderTree groups files into folders and compacts single-child chains', () => {
  const t = buildFolderTree(['b.http', 'api/v2/users/list.http', 'api/v2/users/admin.http', 'api/v2/orders.http', 'a.http', 'tools/x/y.http']);
  assert.deepEqual(t.files, ['a.http', 'b.http']);
  assert.deepEqual(t.folders.map((f) => [f.label, f.path]), [['api/v2', 'api/v2'], ['tools/x', 'tools/x']]);
  const v2 = t.folders[0];
  assert.deepEqual(v2.files, ['api/v2/orders.http']);
  assert.deepEqual(v2.folders.map((f) => f.label), ['users']);
  assert.deepEqual(v2.folders[0].files, ['api/v2/users/admin.http', 'api/v2/users/list.http']);
  const flat = buildFolderTree(['api/v2/orders.http'], false);
  assert.deepEqual(flat.folders.map((f) => f.label), ['api']);
  assert.equal(findFolder(t, 'api/v2/users')?.label, 'users');
  assert.equal(findFolder(t, 'nope'), undefined);
});

test('invalidName rejects names that break on some OS', () => {
  assert.equal(invalidName('users'), undefined);
  assert.ok(invalidName('a/b'));
  assert.ok(invalidName('..'));
  assert.ok(invalidName('con'));
  assert.ok(invalidName('x.'));
  assert.ok(invalidName('  '));
});

test('every move, delete and duplicate on real files keeps each request unchanged', () => {
  const strip = (t: string) =>
    parseHttpFile(t).requests.map(({ startLine, endLine, requestLine, title, ...r }) => JSON.stringify(r));
  for (const name of ['sample.http', 'httpyac-real.http']) {
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const orig = strip(text);
    const n = orig.length;
    assert.ok(n >= 3, name);
    const vars = JSON.stringify(parseHttpFile(text).variables.map((v) => v.name).sort());
    for (let from = 0; from < n; from++) {
      for (let to = 0; to <= n; to++) {
        const moved = moveRequest(text, from, to === n ? undefined : to);
        const expect = [...orig];
        const [x] = expect.splice(from, 1);
        expect.splice(to > from ? to - 1 : to, 0, x);
        assert.deepEqual(strip(moved), expect, `${name}: move ${from} before ${to}`);
        assert.equal(JSON.stringify(parseHttpFile(moved).variables.map((v) => v.name).sort()), vars, `${name}: variables after move ${from}→${to}`);
      }
      const del = strip(deleteRequest(text, from));
      assert.deepEqual(del, orig.filter((_, i) => i !== from), `${name}: delete ${from}`);
      assert.equal(strip(duplicateRequest(text, from)).length, n + 1);
    }
  }
});

test('moveRequests: several requests from two files, kept in order', () => {
  const a = '### A1\nGET https://a/1\n\n### A2\nGET https://a/2\n\n### A3\nGET https://a/3\n';
  const b = '### B1\nGET https://b/1\n\n### B2\nGET https://b/2\n';
  const texts = new Map([['a', a], ['b', b]]);
  const r = moveRequests(texts, [{ file: 'b', index: 1 }, { file: 'a', index: 2 }, { file: 'a', index: 0 }], { file: 'a', before: 1 });
  assert.deepEqual(parseHttpFile(r.get('b')!).requests.map((x) => x.title), ['B1']);
  // Order: files in selection order of first appearance (b, then a), by index within a file.
  const titles = parseHttpFile(r.get('a')!).requests.map((x) => x.title);
  assert.deepEqual(titles, ['B2', 'A1', 'A3', 'A2']);
  assert.equal(moveRequests(texts, [{ file: 'a', index: 1 }], { file: 'a', before: 1 }).size, 0);
  const end = moveRequests(texts, [{ file: 'a', index: 0 }, { file: 'a', index: 1 }], { file: 'a' });
  assert.deepEqual(parseHttpFile(end.get('a')!).requests.map((x) => x.title), ['A3', 'A1', 'A2']);
  assert.equal(moveRequests(texts, [{ file: 'a', index: 2 }], { file: 'a' }).size, 0, 'already last: nothing changes');
});

test('parentFolder finds the containing (compacted) folder', () => {
  const t = buildFolderTree(['a.http', 'api/v2/orders.http', 'api/v2/users/list.http']);
  assert.equal(parentFolder(t, 'a.http'), undefined);
  assert.equal(parentFolder(t, 'api/v2/orders.http')?.path, 'api/v2');
  assert.equal(parentFolder(t, 'api/v2/users/list.http')?.path, 'api/v2/users');
  assert.equal(parentFolder(t, 'api/v2/users')?.path, 'api/v2');
  assert.equal(parentFolder(t, 'api/v2'), undefined);
});
