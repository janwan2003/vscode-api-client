// Website converters (src/web): same results as the extension/CLI paths, plus the zip writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToHttp, httpToCode, parseEnvironment, CODE_TARGETS } from '../src/web/convert.ts';
import { crc32, zipFiles } from '../src/web/zip.ts';
import { attachEnvironments, collectionsToFiles, detectAndImport } from '../src/core/importers/index.ts';
import { previewRequest } from '../src/core/exec.ts';
import { generateCode } from '../src/core/codegen.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('convertToHttp matches the CLI import path for Postman + environment', () => {
  const inputs = [
    { name: 'postman-v21.json', text: fixture('postman-v21.json') },
    { name: 'postman-env.json', text: fixture('postman-env.json') },
  ];
  const r = convertToHttp(inputs);
  const expected = collectionsToFiles(attachEnvironments(inputs.flatMap((i) => detectAndImport(i.text, i.name))));
  assert.deepEqual(r.files, expected);
  assert.ok(r.requests > 0);
  assert.ok(r.files.some((f) => f.path.endsWith('http-client.env.json')));
  assert.deepEqual(r.errors, []);
});

test('convertToHttp: curl, blank and broken inputs', () => {
  const r = convertToHttp([{ text: `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '{"a":1}'` }]);
  assert.equal(r.requests, 1);
  assert.equal(r.files.length, 1);
  assert.match(r.files[0].content, /^POST https:\/\/api\.example\.com\/x/m);
  assert.deepEqual(convertToHttp([{ text: '   ' }]), { files: [], warnings: [], requests: 0, errors: [] });
  const bad = convertToHttp([{ name: 'a.json', text: '{"hello":1}' }, { name: 'b.json', text: fixture('thunder-collection.json') }]);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /^a\.json: .*not a recognized export/);
  assert.ok(bad.requests > 0, 'the good file is still converted');
});

test('httpToCode equals the extension\'s Copy as Code (previewRequest + generateCode)', async () => {
  const text = [
    '@host = https://api.example.com',
    '@id = 7',
    '### Get',
    'GET {{host}}/items/{{id}}?q={{term}}',
    'Authorization: Basic user:pa ss',
    '',
    '### Post form',
    'POST {{host}}/form',
    'Content-Type: application/x-www-form-urlencoded',
    '',
    'a=1',
    '&b={{token}}',
    '',
    '### GraphQL',
    'POST {{host}}/graphql',
    'X-REQUEST-TYPE: GraphQL',
    '',
    'query Q($n: Int) { items(n: $n) { id } }',
    '',
    '{ "n": 2 }',
    '',
    '### No scheme, chained',
    'GET localhost:8080/x',
    'X-Token: {{login.response.body.$.token}}',
  ].join('\n');
  const env = { token: 's3cret' };
  const host = { readHttpFile: async () => text, readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => env };
  for (const t of CODE_TARGETS) {
    const web = httpToCode(text, t.id, env);
    const reqs = parseHttpFile(text).requests;
    assert.equal(web.length, reqs.length);
    for (const [i, req] of reqs.entries()) {
      const p = await previewRequest(req, host, 'f.http');
      assert.equal(web[i].code, generateCode(t.id, p.request), `${t.id} #${i}`);
      assert.deepEqual(web[i].unresolved.sort(), p.unresolved.sort());
    }
  }
  const curl = httpToCode(text, 'curl', env);
  assert.deepEqual(curl[0].unresolved, ['term']);
  assert.match(curl[0].code, /dXNlcjpwYSBzcw==/); // Basic user:pa ss → base64("user:pa ss")
  assert.match(curl[1].code, /a=1&b=s3cret/);
  assert.match(curl[2].code, /\\"query\\"|"query"/);
  assert.match(curl[3].code, /http:\/\/localhost:8080\/x/);
});

test('parseEnvironment: http-client.env.json with $shared, flat JSON, KEY=value', () => {
  const env = JSON.stringify({ $shared: { v: '1' }, dev: { host: 'localhost' }, prod: { host: 'example.com', v: '2' } });
  assert.deepEqual(parseEnvironment(env), { vars: { v: '1', host: 'localhost' }, names: ['dev', 'prod'] });
  assert.deepEqual(parseEnvironment(env, 'prod').vars, { v: '2', host: 'example.com' });
  assert.deepEqual(parseEnvironment('{"a": 1, "b": "x"}'), { vars: { a: '1', b: 'x' }, names: [] });
  assert.deepEqual(parseEnvironment('token=abc\n# c\nexport host="h"').vars, { token: 'abc', host: 'h' });
  assert.deepEqual(parseEnvironment('  '), { vars: {}, names: [] });
});

test('zipFiles produces an archive Python\'s zipfile reads back exactly', (t) => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // standard CRC-32 check value
  const files = [
    { path: 'Shop API/Orders.http', content: 'GET https://x/\n' },
    { path: 'Shop API/Zażółć.http', content: 'POST https://x/\n\n{"ü": "ß"}\n' },
    { path: 'Shop API/http-client.env.json', content: '{}\n' },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'pwzip-'));
  try {
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, zipFiles(files, new Date(2026, 10, 20, 12, 30, 10)));
    const py = spawnSync('python3', ['-I', '-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, z.read(i).decode('utf-8'), list(i.date_time)] for i in z.infolist()]))`, zip], { encoding: 'utf8' });
    if (py.error) return t.skip('python3 not available');
    assert.equal(py.status, 0, py.stderr);
    const got = JSON.parse(py.stdout) as [string, string, number[]][];
    assert.deepEqual(got.map(([p, c]) => ({ path: p, content: c })), files);
    assert.deepEqual(got[0][2], [2026, 11, 20, 12, 30, 10]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
