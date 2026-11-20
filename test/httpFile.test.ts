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

// httpYac test lines. httpYac recognises `?? ...` by its prefix anywhere in a request; REST Client
// has no such syntax (it would send them as body text).
const yacFile = [
  '### Directly after the request line',
  'GET http://x.test/a',
  '  ?page=2',
  '?? status == 200',
  '',
  '### After headers, no blank line',
  '# @assert time < 500',
  'GET http://x.test/b',
  'Accept: application/json',
  '?? header content-type includes json',
  "?? js response.headers['x-a'] == \"b:c\"",
  '',
  '### After the body, blank line between',
  'POST http://x.test/c',
  'Content-Type: application/json',
  '',
  '{',
  '  "name": "Ada"',
  '}',
  '',
  '?? status == 201',
  "?? js response.parsedBody['a b']  ==  \"x y\"",
  '',
  '### After the body, no blank line',
  'POST http://x.test/d',
  '',
  'name=Ada',
  '?? body $.id exists',
  '',
  '### Blank line, no body',
  'DELETE http://x.test/e',
  '',
  '?? status == 204',
  '',
  '### Not httpYac lines',
  'POST http://x.test/f',
  '',
  '??no-space stays in the body',
  'a ?? b',
  '',
].join('\n');

test('httpYac ?? lines are parsed as asserts in every position, never as body, headers or URL', () => {
  const r = parseHttpFile(yacFile).requests;
  assert.equal(r.length, 6);
  assert.deepEqual([r[0].url, r[0].headers, r[0].body, r[0].asserts], ['http://x.test/a?page=2', [], undefined, ['?? status == 200']]);
  assert.deepEqual([r[1].headers, r[1].body, r[1].asserts], [
    [{ name: 'Accept', value: 'application/json' }],
    undefined,
    ['time < 500', '?? header content-type includes json', "?? js response.headers['x-a'] == \"b:c\""],
  ]);
  assert.deepEqual([r[2].body, r[2].asserts], ['{\n  "name": "Ada"\n}', ['?? status == 201', "?? js response.parsedBody['a b']  ==  \"x y\""]]);
  assert.deepEqual([r[3].body, r[3].asserts], ['name=Ada', ['?? body $.id exists']]);
  assert.deepEqual([r[4].body, r[4].asserts], [undefined, ['?? status == 204']]);
  assert.deepEqual([r[5].body, r[5].asserts], ['??no-space stays in the body\na ?? b', undefined]);
});

test('httpYac ?? lines round-trip: serialize keeps them verbatim, replaceRequest keeps other blocks byte-for-byte', () => {
  const f = parseHttpFile(yacFile);
  const strip = (r: object) => {
    const { startLine, endLine, requestLine, ...rest } = r as Record<string, unknown>;
    return rest;
  };
  // parse → serialize → parse gives the same requests.
  assert.deepEqual(parseHttpFile(serializeHttpFile(f.variables, f.requests)).requests.map(strip), f.requests.map(strip));
  // The usual httpYac layouts serialize back to exactly what was written.
  const block = (i: number) => yacFile.split('\n').slice(f.requests[i].startLine, f.requests[i].endLine).join('\n').replace(/\n+$/, '');
  for (const i of [1, 2]) assert.equal(serializeRequest(f.requests[i]), block(i), `request ${i}`);
  // Canonical form of the other layouts (only applies to a block that is edited; the ?? lines
  // themselves are unchanged): `?page=2` joined into the URL, a blank line after a body and none
  // after headers.
  assert.equal(serializeRequest(f.requests[0]), '### Directly after the request line\nGET http://x.test/a?page=2\n?? status == 200');
  assert.equal(serializeRequest(f.requests[3]), '### After the body, no blank line\nPOST http://x.test/d\n\nname=Ada\n\n?? body $.id exists');
  assert.equal(serializeRequest(f.requests[4]), '### Blank line, no body\nDELETE http://x.test/e\n?? status == 204');
  // Editing one request (as the GUI does) leaves every other byte alone...
  const out = replaceRequest(yacFile, 3, { ...f.requests[3], url: 'http://x.test/d2' });
  const before = yacFile.split('\n');
  const after = out.split('\n');
  assert.deepEqual(after.slice(0, f.requests[3].startLine), before.slice(0, f.requests[3].startLine));
  assert.deepEqual(after.slice(f.requests[3].endLine + 1), before.slice(f.requests[3].endLine));
  // ...and the edited block keeps its ?? line as an assert, outside the body.
  const g = parseHttpFile(out).requests[3];
  assert.deepEqual([g.url, g.body, g.asserts], ['http://x.test/d2', 'name=Ada', ['?? body $.id exists']]);
  // Editing the body of a request with ?? lines after it: the lines stay after the new body.
  const out2 = replaceRequest(yacFile, 2, { ...f.requests[2], body: '{"name":"Bob"}' });
  assert.match(out2, /\n\{"name":"Bob"\}\n\n\?\? status == 201\n\?\? js response\.parsedBody\['a b'\]  ==  "x y"\n\n### After the body, no blank line/);
  assert.equal(parseHttpFile(out2).requests[2].body, '{"name":"Bob"}');
});

// Anonymised from public httpYac files (GitHub code search) and checked against httpYac 6.16's own
// parser: same requests, methods and URLs. One deliberate difference: httpYac would start a request
// at the `POST /...` text inside the multipart field; Plainwire keeps a multipart body whole.
const realYac = readFileSync(new URL('./fixtures/httpyac-real.http', import.meta.url), 'utf8');

test('real httpYac layouts: requests without ###, scripts, handlers, block comments, URL continuation', () => {
  const f = parseHttpFile(realYac);
  assert.deepEqual(
    f.requests.map((r) => `${r.method} ${r.url}`),
    [
      'GET {{baseUrl}}/health',
      'POST {{baseUrl}}/api/keys',
      'GET {{baseUrl}}/random',
      'GET {{baseUrl}}/api/data/v9.2/reports(42)?$top=5',
      'POST {{baseUrl}}/upload',
      'POST {{baseUrl}}/session',
      'MOVE {{baseUrl}}{{$xpath:trash //d:response[2]/d:href}}',
    ],
  );
  assert.deepEqual(f.variables, [
    { name: 'baseUrl', value: '{{BASE_URL}}' },
    { name: 'xpath_ns', value: 'd = DAV:' },
    { name: 'lazyToken', value: '{{login.token}}' },
    { name: 'session', value: '{{createSession.id}}' },
  ]);
  const [health, keys, random, report, upload, session, move] = f.requests;
  // The block comment (with a ### inside) and the global script are kept, never sent or split on.
  assert.equal(health.rawBefore?.[0], '/*');
  assert.ok(health.rawBefore?.includes('}}'));
  assert.equal(health.name, 'health');
  assert.equal(health.asserts?.length, 4);
  assert.equal(health.body, undefined);
  // A request line after a body starts the next request; its comment and @name lines go with it.
  assert.equal(keys.body, '{\n  "key": "key-1"\n}');
  assert.equal(keys.asserts?.length, 4);
  assert.equal(random.name, 'random');
  assert.deepEqual(random.comments, ['/ No delay']);
  assert.equal(random.body, undefined);
  // `{{@response ... }}` after the request is a script, not a body; `??` inside it is JavaScript.
  assert.equal(report.body, undefined);
  assert.deepEqual(report.asserts, ['?? js response.parsedBody["@odata.count"] == 5', '?? body value[0].name == First report']);
  assert.equal(report.rawAfter?.[0], '{{@response');
  // `< {% %}` before and `> {% %}` / `>>` after: kept verbatim; the multipart body stays whole.
  assert.equal(upload.rawBefore?.[0], '< {%');
  assert.equal(upload.body, '--WebKitFormBoundary\nContent-Disposition: form-data; name="note"\n\nPOST /this-is-text-in-a-form-field\n--WebKitFormBoundary--');
  assert.equal(upload.asserts, undefined);
  assert.deepEqual(upload.rawAfter?.slice(-2), ['%}', '>> ./out/upload.json']);
  // Notes and variables after a blank line are not sent as body.
  assert.equal(session.body, 'USERNAME={{user}}&PASSWORD={{pass}}');
  assert.deepEqual(session.rawAfter, ['# keep the session id for the next requests', '@session = {{createSession.id}}']);
  assert.equal(move.body, undefined);
  assert.deepEqual(move.headers, [{ name: 'Destination', value: '{{baseUrl}}/files/a.txt' }]);
  assert.deepEqual(move.rawAfter?.slice().sort(), ['# Then the status should be 201', '<> ./previous/restore.json']);
});

test('real httpYac layouts survive a GUI edit of any request', () => {
  const f = parseHttpFile(realYac);
  const strip = (r: object) => {
    const { startLine, endLine, requestLine, rawAfter, ...rest } = r as Record<string, unknown>;
    return { ...rest, rawAfter: (rawAfter as string[] | undefined)?.slice().sort() };
  };
  for (let i = 0; i < f.requests.length; i++) {
    const out = replaceRequest(realYac, i, f.requests[i]);
    const g = parseHttpFile(out);
    assert.deepEqual(g.requests.map(strip), f.requests.map(strip), `edit of request ${i}`);
    assert.deepEqual(g.variables, f.variables, `edit of request ${i}`);
  }
});

test('a request line only splits when it looks like one; comments directly after body text stay body', () => {
  const text = 'POST http://x.test/notes\nContent-Type: text/plain\n\nDELETE everything\nGET is a verb\n# not a comment here\n';
  const [r, ...more] = parseHttpFile(text).requests;
  assert.equal(more.length, 0);
  assert.equal(r.body, 'DELETE everything\nGET is a verb\n# not a comment here');
  const two = parseHttpFile('GET http://x.test/a\n\nGET example.com/b\n\nDELETE localhost:8080/c HTTP/1.1\n').requests;
  assert.deepEqual(two.map((x) => `${x.method} ${x.url}`), ['GET http://x.test/a', 'GET example.com/b', 'DELETE localhost:8080/c']);
  // An unterminated script or block comment is not one.
  assert.equal(parseHttpFile('POST http://x.test/a\n\n{{\n"a": 1\n').requests[0].body, '{{\n"a": 1');
});
