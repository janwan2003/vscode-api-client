import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Executor, rowState } from '../src/core/exec.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
import { inlineScript, runScript, scriptSources, type ScriptContext } from '../src/core/scripts.ts';
import type { HttpResponse } from '../src/core/model.ts';

const ctx = (over: Partial<ScriptContext> = {}): ScriptContext => ({
  globals: new Map(),
  requestVariables: new Map(),
  environment: { host: 'example.com' },
  resolve: (t) => t.replace('{{host}}', 'example.com'),
  ...over,
});
const res = (body: string, headers: [string, string][] = [['Content-Type', 'application/json; charset=utf-8']], status = 200): HttpResponse => ({
  status, statusText: 'OK', headers, body, bodyEncoding: 'utf8', size: body.length, timeMs: 1, url: 'http://x',
});
const req = { method: 'POST', url: 'https://{{host}}/login', headers: [{ name: 'X-Id', value: '{{host}}' }], body: '{"a":1}' };

test('scriptSources: inline, multi-line and file scripts per side; httpYac blocks and comments skipped', () => {
  const after = ['> {%', '  client.global.set("a", 1);', '%}', '> {% client.log("one line") %}', '> ./handler.js', '>> out.json', '{{', '> {% not this %}', '}}', '/*', '> {% nor this %}', '*/'];
  assert.deepEqual(scriptSources(after, 'response'), [{ code: '  client.global.set("a", 1);' }, { code: ' client.log("one line") ' }, { path: './handler.js' }]);
  assert.deepEqual(scriptSources(after, 'pre'), []);
  assert.deepEqual(scriptSources(['< {%', 'request.variables.set("x", "1")', '%}', '< sign.js'], 'pre'), [{ code: 'request.variables.set("x", "1")' }, { path: 'sign.js' }]);
  assert.equal(inlineScript(after, 'response'), '  client.global.set("a", 1);');
  assert.equal(inlineScript(undefined, 'pre'), '');
});

test('runScript: response handler reads JSON body, headers, status, content type; sets globals; tests pass and fail', () => {
  const c = ctx();
  const r = runScript(`
    client.test("status is 200", () => client.assert(response.status === 200, "got " + response.status));
    client.test("has token", () => { client.assert(typeof response.body.token === "string"); });
    client.test("fails", () => { client.assert(response.body.items.length === 3, "expected 3 items, got " + response.body.items.length); });
    client.test("arrays are real arrays", () => client.assert(Array.isArray(response.body.items) && response.body.items instanceof Array));
    client.global.set("token", response.body.token);
    client.global.set("user", response.body.user);
    client.global.set("count", response.body.items.length);
    client.log("mime", response.contentType.mimeType, response.contentType.charset, response.headers.valueOf("content-type"));
    console.log(jsonPath(response.body, "$.user.id"));
  `, 'response', req, c, res('{"token":"t-1","user":{"id":7},"items":[1,2]}'));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tests.map((t) => [t.source, t.passed]), [['status is 200', true], ['has token', true], ['fails', false], ['arrays are real arrays', true]]);
  assert.equal(r.tests[2].message, 'expected 3 items, got 2');
  assert.deepEqual([...c.globals], [['token', 't-1'], ['user', '{"id":7}'], ['count', '2']]);
  assert.deepEqual(r.logs, ['mime application/json utf-8 application/json; charset=utf-8', '7']);
});

test('runScript: non-JSON body is a string; a JSON body without a JSON content type is still parsed', () => {
  const c = ctx();
  runScript('client.global.set("t", typeof response.body); client.global.set("l", response.body.length)', 'response', req, c, res('hello', [['content-type', 'text/plain']]));
  runScript('client.global.set("j", response.body.ok)', 'response', req, c, res('{"ok":true}', [['content-type', 'text/plain']]));
  assert.deepEqual([...c.globals], [['t', 'string'], ['l', '5'], ['j', 'true']]);
});

test('runScript: pre-request script sees the request, environment, and sets request variables', () => {
  const c = ctx();
  const r = runScript(`
    request.variables.set("sig", crypto.hmac.sha256().withTextSecret("k").updateWithText(request.body.getRaw()).digest().toHex());
    request.variables.set("url", request.url.tryGetSubstituted());
    request.variables.set("raw", request.url.getRaw());
    request.variables.set("hdr", request.headers.findByName("x-id").tryGetSubstitutedValue());
    request.variables.set("env", request.environment.get("host"));
    request.variables.set("missing", String(request.environment.get("nope")));
    request.variables.set("sha", crypto.sha256().updateWithText("abc").digest().toHex());
    request.variables.set("b64", btoa("ab") + atob("YWI="));
    request.variables.set("uuid", $random.uuid.length);
  `, 'pre', req, c);
  assert.equal(r.error, undefined);
  const v = Object.fromEntries(c.requestVariables);
  assert.match(v.sig, /^[0-9a-f]{64}$/);
  assert.equal(v.sha, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(v.url, 'https://example.com/login');
  assert.equal(v.raw, 'https://{{host}}/login');
  assert.equal(v.hdr, 'example.com');
  assert.equal(v.env, 'example.com');
  assert.equal(v.missing, 'null');
  assert.equal(v.b64, 'YWI=ab');
  assert.equal(v.uuid, '36');
});

test('runScript: errors, top-level client.assert, client.exit and timeouts never throw', () => {
  const thrown = runScript('client.log("before"); undefinedThing.x;', 'response', req, ctx(), res('{}'));
  assert.match(thrown.error!, /undefinedThing is not defined/);
  assert.deepEqual(thrown.tests.map((t) => [t.source, t.passed]), [['response handler', false]]);
  assert.deepEqual(thrown.logs, ['before']);

  const top = runScript('client.assert(false, "nope"); client.log("not reached")', 'response', req, ctx(), res('{}'));
  assert.deepEqual(top.tests, [{ source: 'client.assert', passed: false, message: 'nope' }]);
  assert.deepEqual(top.logs, []);

  const exit = runScript('client.test("a", () => {}); client.exit(); client.test("b", () => {})', 'response', req, ctx(), res('{}'));
  assert.equal(exit.error, undefined);
  assert.deepEqual(exit.tests.map((t) => t.source), ['a']);

  const loop = runScript('while (true) {}', 'pre', req, ctx({ timeoutMs: 50 }));
  assert.equal(loop.error, 'timed out after 50 ms');
});

test('runScript: the script cannot reach Node (no require, process)', () => {
  const r = runScript('client.global.set("r", typeof require); client.global.set("p", typeof process)', 'pre', req, ctx());
  const c = ctx();
  runScript('client.global.set("r", typeof require); client.global.set("p", typeof process)', 'pre', req, c);
  assert.equal(r.error, undefined);
  assert.deepEqual([...c.globals], [['r', 'undefined'], ['p', 'undefined']]);
});

test('runScript: stream responses replay messages through onEachMessage', () => {
  const ws: HttpResponse = { ...res('> hi\n< {"n":1}\n< {"n":2}', []), status: 101, events: [
    { event: 'sent', data: 'hi', timeMs: 1 }, { event: 'message', data: '{"n":1}', timeMs: 2 }, { event: 'message', data: '{"n":2}', timeMs: 3 }] };
  const c = ctx();
  const r = runScript('const ns = []; response.body.onEachMessage((m, unsubscribe) => { ns.push(m.n); if (m.n === 1) unsubscribe(); }); client.global.set("ns", ns.join(","))', 'response', req, c, ws);
  assert.equal(r.error, undefined);
  assert.equal(c.globals.get('ns'), '1');
});

test('handler blocks round-trip through parse and serialize unchanged', () => {
  const text = '< {%\n  request.variables.set("t", Date.now().toString());\n%}\nGET https://example.com/a?t={{t}}\n\n> {%\n  client.global.set("x", response.body.x);\n%}\n';
  const f = parseHttpFile(text);
  assert.deepEqual(f.requests[0].rawBefore, ['< {%', '  request.variables.set("t", Date.now().toString());', '%}']);
  assert.equal(serializeHttpFile(f.variables, f.requests), '###\n' + text);
});

test('Executor: login handler sets a global used by the next request; pre-request variables; tests count as checks', async () => {
  const seen: { url: string; auth?: string; sig?: string }[] = [];
  const server = createServer((rq, rs) => {
    seen.push({ url: rq.url!, auth: rq.headers.authorization, sig: rq.headers['x-sig'] as string | undefined });
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(rq.url === '/login' ? '{"token":"abc"}' : '{"items":[1]}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = [
    `POST ${base}/login`,
    '',
    '> {%',
    '  client.test("token", () => client.assert(response.body.token, "no token"));',
    '  client.global.set("token", response.body.token);',
    '%}',
    '###',
    '< {% request.variables.set("sig", "s-" + request.environment.get("key")) %}',
    '# @assert status == 200',
    `GET ${base}/items`,
    'Authorization: Bearer {{token}}',
    'X-Sig: {{sig}}',
    '',
    '> ./check.js',
    '',
  ].join('\n');
  let saved = 0;
  const exec = new Executor({
    readHttpFile: async () => file,
    readBodyFile: async (p) => new TextEncoder().encode(p === './check.js' ? 'client.test("one item", () => client.assert(response.body.items.length === 2, "items: " + response.body.items.length)); client.log("checked")' : ''),
    dotenv: async () => ({}),
    environment: () => ({ key: 'K' }),
    sendOptions: () => ({ timeoutMs: 5000 }),
    onGlobalsChanged: () => void saved++,
  });
  try {
    const reqs = parseHttpFile(file).requests;
    await assert.rejects(exec.run(reqs[1], 'f.http'), /\{\{token\}\} is not defined.*client\.global\.set.*line 1/s);
    const login = await exec.run(reqs[0], 'f.http');
    assert.deepEqual(login.assertions.map((a) => [a.source, a.passed]), [['token', true]]);
    assert.equal(exec.globals.get('token'), 'abc');
    assert.equal(saved, 1);
    const items = await exec.run(reqs[1], 'f.http');
    assert.deepEqual(seen.at(-1), { url: '/items', auth: 'Bearer abc', sig: 's-K' });
    assert.deepEqual(items.assertions.map((a) => [a.source, a.passed]), [['status == 200', true], ['one item', false]]);
    assert.equal(items.assertions[1].message, 'items: 1');
    assert.deepEqual(items.logs, ['checked']);
    assert.equal(rowState(200, items.assertions), 'fail');
    assert.equal((await exec.preview(reqs[1], 'f.http')).request.headers.find((h) => h.name === 'X-Sig')?.value, 's-K');
  } finally {
    server.close();
  }
});

test('Executor: a failing pre-request script stops the request; runScripts: false skips scripts', async () => {
  let hits = 0;
  const server = createServer((_rq, rs) => {
    hits++;
    rs.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = `< {% client.log("signing"); throw new Error("no key") %}\nGET ${base}/\n\n> {% client.global.set("ran", "yes") %}\n`;
  const host = { readHttpFile: async () => file, readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => ({}), sendOptions: () => ({ timeoutMs: 5000 }) };
  try {
    const r = parseHttpFile(file).requests[0];
    await assert.rejects(new Executor(host).run(r, 'f.http'), /Not sent: the pre-request script: no key\nsigning/);
    assert.equal(hits, 0);
    const off = new Executor({ ...host, runScripts: false });
    const out = await off.run(r, 'f.http');
    assert.equal(hits, 1);
    assert.deepEqual(out.assertions, []);
    assert.equal(off.globals.size, 0);
  } finally {
    server.close();
  }
});
