import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULTIPART_BOUNDARY, parseCurl, toCurl, tokenizeShell } from '../src/core/curl.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
import type { HttpRequest } from '../src/core/model.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('simple GET', () => {
  assert.deepEqual(parseCurl('curl https://api.example.com/users'), {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
  });
});

test('multi-line bash command from browser "Copy as cURL"', () => {
  const cmd = `curl 'https://api.example.com/v1/items?page=2' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc.def' \\
  -H "x-quote: it's \\"fine\\"" \\
  --data-raw '{"name":"it'\\''s"}' \\
  --compressed`;
  const r = parseCurl(cmd);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/v1/items?page=2');
  assert.deepEqual(r.headers, [
    { name: 'accept', value: 'application/json' },
    { name: 'authorization', value: 'Bearer abc.def' },
    { name: 'x-quote', value: `it's "fine"` },
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
  ]);
  assert.equal(r.body, `{"name":"it's"}`);
});

test('CRLF continuations and $\'...\' ANSI-C quoting', () => {
  const r = parseCurl("curl -X PUT \\\r\n  $'https://x.test/a' \\\r\n  -d $'line1\\nline2\\t\\x41\\''");
  assert.equal(r.method, 'PUT');
  assert.equal(r.url, 'https://x.test/a');
  assert.equal(r.body, "line1\nline2\tA'");
});

test('Windows cmd flavour with ^ continuations and ^" quoting', () => {
  const cmd = [
    'curl ^"https://api.example.com/v1/items^" ^',
    '  -H ^"accept: application/json^" ^',
    '  -H ^"content-type: application/json^" ^',
    '  --data-raw ^"^{^\\^"a^\\^":1^}^"',
  ].join('\r\n');
  const r = parseCurl(cmd);
  assert.equal(r.url, 'https://api.example.com/v1/items');
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, [
    { name: 'accept', value: 'application/json' },
    { name: 'content-type', value: 'application/json' },
  ]);
  assert.equal(r.body, '{"a":1}');
});

test('-X, combined short flags, attached values, --url', () => {
  const r = parseCurl(`curl -sSLk -XPATCH -H'X-A: 1' --url https://e.test/p -o /dev/null -w '%{http_code}'`);
  assert.equal(r.method, 'PATCH');
  assert.equal(r.url, 'https://e.test/p');
  assert.deepEqual(r.headers, [{ name: 'X-A', value: '1' }]);
});

test('multiple -d are joined with & and default to POST + form content type', () => {
  const r = parseCurl(`curl https://e.test/login -d user=jane -d 'pass=a b' --data-urlencode 'note=hi & bye'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body, 'user=jane&pass=a b&note=hi%20%26%20bye');
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
});

test('explicit Content-Type is kept and not duplicated; @file data becomes a file reference', () => {
  const r = parseCurl(`curl -H 'Content-Type: application/json' --data-binary @payload.json https://e.test/`);
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: 'application/json' }]);
  assert.equal(r.body, '< ./payload.json');
});

test('--json sets JSON content type and accept', () => {
  const r = parseCurl(`curl --json '{"a":1}' https://e.test/j`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body, '{"a":1}');
  assert.deepEqual(r.headers, [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ]);
});

test('-u, -A, -b, -e map to headers', () => {
  const r = parseCurl(`curl -u 'jane:p@ss:word' -A 'MyAgent/1.0' -b 'sid=1; theme=dark' -e 'https://ref.test/;auto' https://e.test`);
  assert.equal(r.url, 'https://e.test');
  assert.deepEqual(r.headers, [
    { name: 'User-Agent', value: 'MyAgent/1.0' },
    { name: 'Cookie', value: 'sid=1; theme=dark' },
    { name: 'Referer', value: 'https://ref.test/' },
    { name: 'Authorization', value: `Basic ${b64('jane:p@ss:word')}` },
  ]);
});

test('-u with {{variables}} keeps the plain user:password form', () => {
  const r = parseCurl(`curl -u '{{user}}:{{pass}}' https://e.test`);
  assert.deepEqual(r.headers, [{ name: 'Authorization', value: 'Basic {{user}}:{{pass}}' }]);
});

test('-G moves data into the query string', () => {
  const r = parseCurl(`curl -G https://e.test/search?x=1 -d q=cats --data-urlencode 'lang=en us'`);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://e.test/search?x=1&q=cats&lang=en%20us');
  assert.equal(r.body, undefined);
  assert.deepEqual(r.headers, []);
});

test('-I is HEAD; -X wins over inferred method; URL without scheme gets http://', () => {
  assert.equal(parseCurl('curl -I example.com').method, 'HEAD');
  assert.equal(parseCurl('curl -I example.com').url, 'http://example.com');
  assert.equal(parseCurl('curl -X GET -d a=1 https://e.test').method, 'GET');
});

test('-F builds a multipart body with file references', () => {
  const r = parseCurl(`curl -F 'title=Holiday' -F 'photo=@images/beach.png;type=image/png' --form-string 'raw=@not-a-file' https://e.test/upload`);
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` }]);
  assert.equal(
    r.body,
    [
      `--${MULTIPART_BOUNDARY}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'Holiday',
      `--${MULTIPART_BOUNDARY}`,
      'Content-Disposition: form-data; name="photo"; filename="beach.png"',
      'Content-Type: image/png',
      '',
      '< ./images/beach.png',
      `--${MULTIPART_BOUNDARY}`,
      'Content-Disposition: form-data; name="raw"',
      '',
      '@not-a-file',
      `--${MULTIPART_BOUNDARY}--`,
    ].join('\n'),
  );
});

test('header removal ("Name:") and empty header ("Name;")', () => {
  const r = parseCurl(`curl -H 'X-Empty;' -H 'Accept:' https://e.test`);
  assert.deepEqual(r.headers, [{ name: 'X-Empty', value: '' }]);
});

test('stops at a pipe and ignores shell prompt', () => {
  const r = parseCurl(`$ curl -s https://e.test/a | jq .`);
  assert.equal(r.url, 'https://e.test/a');
});

test('rejects text that is not a curl command', () => {
  assert.throws(() => parseCurl('wget https://e.test'), /Not a curl command/);
  assert.throws(() => parseCurl('GET https://e.test'), /Not a curl command/);
  assert.throws(() => parseCurl('curl -s'), /no URL/);
  assert.throws(() => parseCurl("curl 'https://e.test"), /Unterminated/);
});

test('tokenizer handles adjacent quoted segments', () => {
  assert.deepEqual(tokenizeShell(`curl "a"'b'c\\ d`), ['curl', 'abc d']);
});

test('toCurl renders one arg per line, escapes quotes, skips disabled headers', () => {
  const req: HttpRequest = {
    method: 'POST',
    url: 'https://e.test/x?a=1&b=2',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Off', value: '1', disabled: true },
    ],
    body: `{"msg":"it's"}`,
  };
  assert.equal(
    toCurl(req),
    [
      `curl 'https://e.test/x?a=1&b=2' \\`,
      `  -X POST \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  --data-raw '{"msg":"it'\\''s"}'`,
    ].join('\n'),
  );
});

test('toCurl -> parseCurl round trip', () => {
  const reqs: HttpRequest[] = [
    { method: 'GET', url: 'https://e.test/a', headers: [{ name: 'Accept', value: '*/*' }] },
    { method: 'HEAD', url: 'https://e.test/h', headers: [] },
    {
      method: 'PUT',
      url: 'https://e.test/p',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      body: "multi\nline 'quoted' $HOME `x`",
    },
    { method: 'POST', url: 'https://e.test/f', headers: [{ name: 'Content-Type', value: 'image/png' }], body: '< ./img.png' },
    { method: 'GET', url: 'https://e.test/g', headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{}' },
  ];
  for (const r of reqs) assert.deepEqual(parseCurl(toCurl(r)), r, toCurl(r));
});

test('parsed curl requests survive serializeHttpFile -> parseHttpFile', () => {
  const cmds = [
    `curl https://e.test/login -d user=jane -H 'X-Off: 1'`,
    `curl --json '{"a":\n  1}' https://e.test/j`,
    `curl -F a=1 -F f=@x.bin https://e.test/u`,
    `curl -I https://e.test/`,
  ];
  const reqs = cmds.map((c) => parseCurl(c));
  const parsed = parseHttpFile(serializeHttpFile([], reqs)).requests;
  assert.equal(parsed.length, reqs.length);
  reqs.forEach((r, i) => {
    assert.equal(parsed[i].method, r.method);
    assert.equal(parsed[i].url, r.url);
    assert.deepEqual(parsed[i].headers, r.headers);
    assert.equal(parsed[i].body, r.body);
  });
});
