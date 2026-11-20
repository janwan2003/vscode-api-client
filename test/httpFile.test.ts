import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendRequest, joinQuery, parseHttpFile, replaceRequest, serializeHttpFile, serializeRequest, splitQuery } from '../src/core/httpFile.ts';

const sample = readFileSync(new URL('./fixtures/sample.http', import.meta.url), 'utf8');

test('parses file variables and all requests', () => {
  const f = parseHttpFile(sample);
  assert.deepEqual(f.variables, [
    { name: 'host', value: 'https://api.example.com' },
    { name: 'token', value: 'abc123' },
  ]);
  assert.equal(f.requests.length, 4);
});

test('parses metadata, comments, query continuation and disabled headers', () => {
  const r = parseHttpFile(sample).requests[0];
  assert.equal(r.title, 'List users');
  assert.equal(r.name, 'listUsers');
  assert.deepEqual(r.comments, ['Returns the first page']);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, '{{host}}/users?page=2&size=10');
  assert.deepEqual(r.headers, [
    { name: 'Accept', value: 'application/json' },
    { name: 'X-Debug', value: '1', disabled: true },
  ]);
  assert.equal(r.body, undefined);
});

test('parses body, http version and keeps # inside body', () => {
  const r = parseHttpFile(sample).requests[1];
  assert.equal(r.method, 'POST');
  assert.equal(r.httpVersion, 'HTTP/1.1');
  assert.equal(r.body, '{\n  "name": "Ada",\n  "tags": ["#admin"]\n}');
  assert.equal(r.headers.length, 2);
});

test('method defaults to GET and // metadata works', () => {
  const r = parseHttpFile(sample).requests[2];
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://example.com/old');
  assert.deepEqual(r.meta, { 'no-redirect': '' });
});

test('request line positions point at the request line', () => {
  const lines = sample.split('\n');
  for (const r of parseHttpFile(sample).requests) {
    assert.match(lines[r.requestLine], /(GET|POST|https:)/);
  }
});

test('single request without separator', () => {
  const f = parseHttpFile('curl-less.example.com/ping\n');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'curl-less.example.com/ping');
});

test('CRLF files parse the same', () => {
  const a = parseHttpFile(sample).requests.map(({ method, url, headers, body }) => ({ method, url, headers, body }));
  const b = parseHttpFile(sample.replace(/\n/g, '\r\n')).requests.map(({ method, url, headers, body }) => ({ method, url, headers, body }));
  assert.deepEqual(b, a);
});

test('serialize → parse round trip preserves every request', () => {
  const f = parseHttpFile(sample);
  const strip = (r: object) => {
    const { startLine, endLine, requestLine, ...rest } = r as Record<string, unknown>;
    return rest;
  };
  const again = parseHttpFile(serializeHttpFile(f.variables, f.requests));
  assert.deepEqual(again.variables, f.variables);
  assert.deepEqual(again.requests.map(strip), f.requests.map(strip));
});

test('serializeRequest output is stable (canonical form is a fixed point)', () => {
  const r = parseHttpFile(sample).requests[1];
  const once = serializeRequest(r);
  assert.equal(serializeRequest(parseHttpFile(once).requests[0]), once);
});

test('replaceRequest edits one request and leaves the rest byte-for-byte', () => {
  const f = parseHttpFile(sample);
  const edited = { ...f.requests[1], url: '{{host}}/people', headers: [...f.requests[1].headers, { name: 'X-New', value: 'yes' }] };
  const out = replaceRequest(sample, 1, edited);
  const g = parseHttpFile(out);
  assert.equal(g.requests.length, 4);
  assert.equal(g.requests[1].url, '{{host}}/people');
  assert.equal(g.requests[1].headers.at(-1)?.name, 'X-New');
  // Untouched parts identical.
  const before = sample.split('\n');
  const after = out.split('\n');
  assert.deepEqual(after.slice(0, f.requests[1].startLine), before.slice(0, f.requests[1].startLine));
  assert.deepEqual(after.slice(-12), before.slice(-12));
});

test('replaceRequest on first request without ### keeps file variables', () => {
  const text = '@a = 1\nGET https://x.test/{{a}}\n\n### two\nGET https://y.test\n';
  const out = replaceRequest(text, 0, { method: 'POST', url: 'https://x.test/{{a}}', headers: [], body: '{}' });
  assert.equal(out, '@a = 1\nPOST https://x.test/{{a}}\n\n{}\n\n### two\nGET https://y.test\n');
});

test('appendRequest adds a separated block', () => {
  const out = appendRequest('GET https://a.test\n', { method: 'GET', url: 'https://b.test', headers: [], title: 'B' });
  assert.equal(out, 'GET https://a.test\n\n### B\nGET https://b.test\n');
  assert.equal(parseHttpFile(out).requests.length, 2);
});

test('splitQuery / joinQuery keep raw values', () => {
  const s = splitQuery('{{host}}/x?a=1&b={{v}}&flag');
  assert.equal(s.base, '{{host}}/x');
  assert.deepEqual(s.params, [
    { name: 'a', value: '1' },
    { name: 'b', value: '{{v}}' },
    { name: 'flag', value: '' },
  ]);
  assert.equal(joinQuery(s.base, s.params), '{{host}}/x?a=1&b={{v}}&flag');
});

test('non-standard methods round-trip', () => {
  const text = serializeHttpFile([], [{ method: 'PURGE', url: 'https://e.test/a', headers: [] }, { method: 'PROPFIND', url: '{{host}}/dav', headers: [] }]);
  const reqs = parseHttpFile(text).requests;
  assert.deepEqual(reqs.map((r) => [r.method, r.url]), [['PURGE', 'https://e.test/a'], ['PROPFIND', '{{host}}/dav']]);
});
