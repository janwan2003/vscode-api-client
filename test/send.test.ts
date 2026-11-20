import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { bypassProxy, sendRequest } from '../src/core/send.ts';
import { toGraphqlHttp } from '../src/core/graphql.ts';

let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/echo' });
        return res.end();
      }
      if (req.url === '/see-other') {
        res.writeHead(303, { location: '/echo' });
        return res.end();
      }
      if (req.url === '/temporary') {
        res.writeHead(307, { location: '/echo' });
        return res.end();
      }
      if (req.url?.startsWith('/elsewhere/')) {
        res.writeHead(302, { location: `http://127.0.0.1:${req.url.slice('/elsewhere/'.length)}/echo` });
        return res.end();
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        return res.end();
      }
      if (req.url === '/gzip' || req.url === '/br') {
        const json = JSON.stringify({ hello: 'world'.repeat(50), acceptEncoding: req.headers['accept-encoding'] });
        const gz = req.url === '/gzip';
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': gz ? 'gzip' : 'br' });
        return res.end(gz ? gzipSync(json) : brotliCompressSync(json));
      }
      if (req.url === '/cookies') {
        res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
        res.setHeader('X-Mixed-Case', 'v');
        return res.end('ok');
      }
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500);
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-test': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString() }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('sends method, headers and body; returns status, headers, timing', async () => {
  const res = await sendRequest({ method: 'POST', url: `${base}/echo?a=1`, headers: [{ name: 'X-One', value: '1' }, { name: 'X-Off', value: '0', disabled: true }, { name: 'Content-Type', value: 'application/json' }], body: '{"a":1}' });
  assert.equal(res.status, 201);
  assert.equal(res.bodyEncoding, 'utf8');
  const echo = JSON.parse(res.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.url, '/echo?a=1');
  assert.equal(echo.headers['x-one'], '1');
  assert.equal(echo.headers['x-off'], undefined);
  assert.equal(echo.body, '{"a":1}');
  assert.ok(res.headers.some(([k, v]) => k === 'x-test' && v === 'yes'));
  assert.ok(res.size > 0 && res.timeMs >= 0);
});

test('form bodies split over & lines are joined', async () => {
  const res = await sendRequest({ method: 'POST', url: `${base}/echo`, headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'a=1\n&b=2' });
  assert.equal(JSON.parse(res.body).body, 'a=1&b=2');
});

test('a GraphQL request (X-REQUEST-TYPE: GraphQL) reaches the server as a JSON {query, variables} body', async () => {
  const req = toGraphqlHttp({
    method: 'POST',
    url: `${base}/graphql`,
    headers: [{ name: 'Authorization', value: 'Bearer t' }, { name: 'X-REQUEST-TYPE', value: 'GraphQL' }],
    body: 'query Pet($id: ID!) {\n  pet(id: $id) { id }\n}\n\n{"id": "42"}',
  });
  const echo = JSON.parse((await sendRequest(req)).body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.headers['content-type'], 'application/json');
  assert.equal(echo.headers['x-request-type'], undefined);
  assert.equal(echo.headers.authorization, 'Bearer t');
  assert.equal(echo.headers['content-length'], String(Buffer.byteLength(echo.body)));
  assert.deepEqual(JSON.parse(echo.body), { query: 'query Pet($id: ID!) {\n  pet(id: $id) { id }\n}', variables: { id: '42' }, operationName: 'Pet' });
});

test('redirects follow by default and can be disabled', async () => {
  const followed = await sendRequest({ method: 'GET', url: `${base}/redirect`, headers: [] });
  assert.equal(followed.status, 201);
  assert.ok(followed.url.endsWith('/echo'));
  const manual = await sendRequest({ method: 'GET', url: `${base}/redirect`, headers: [] }, { followRedirects: false });
  assert.equal(manual.status, 302);
});

test('binary bodies come back as base64', async () => {
  const res = await sendRequest({ method: 'GET', url: `${base}/binary`, headers: [] });
  assert.equal(res.bodyEncoding, 'base64');
  assert.equal(Buffer.from(res.body, 'base64').length, 6);
});

test('timeouts and connection errors give readable messages', async () => {
  await assert.rejects(sendRequest({ method: 'GET', url: `${base}/slow`, headers: [] }, { timeoutMs: 50 }), /Timed out after 50 ms/);
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  const port = (tmp.address() as AddressInfo).port;
  await new Promise((r) => tmp.close(r));
  await assert.rejects(sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, headers: [] }), /Request failed: ECONNREFUSED/);
});

test('URL without scheme defaults to http', async () => {
  const res = await sendRequest({ method: 'GET', url: base.replace('http://', '') + '/echo', headers: [] });
  assert.equal(res.status, 201);
});

// --- node:http transport -------------------------------------------------------------------

test('ports that fetch refuses (10080, 6666, 6000) work', async (t) => {
  const srv = createServer((_req, res) => res.end('any port'));
  let port: number | undefined;
  for (const p of [10080, 6666, 6000]) {
    const ok = await new Promise<boolean>((r) => {
      srv.once('error', () => r(false));
      srv.listen(p, '127.0.0.1', () => r(true));
    });
    if (ok) {
      port = p;
      break;
    }
  }
  if (port === undefined) return t.skip('ports 10080, 6666 and 6000 are all in use');
  try {
    const res = await sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, headers: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'any port');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('gzip and br responses are decompressed; Accept-Encoding added only when absent', async () => {
  const gz = await sendRequest({ method: 'GET', url: `${base}/gzip`, headers: [] });
  assert.equal(gz.bodyEncoding, 'utf8');
  const body = JSON.parse(gz.body);
  assert.equal(body.hello, 'world'.repeat(50));
  assert.equal(body.acceptEncoding, 'gzip, deflate, br');
  // size is the compressed (wire) body size
  assert.ok(gz.size < gz.body.length, `size ${gz.size} should be the compressed length`);
  const br = await sendRequest({ method: 'GET', url: `${base}/br`, headers: [{ name: 'Accept-Encoding', value: 'br' }] });
  assert.equal(JSON.parse(br.body).acceptEncoding, 'br');
});

test('303 switches to GET without body; 307 keeps method and body', async () => {
  const see = await sendRequest({ method: 'POST', url: `${base}/see-other`, headers: [{ name: 'Content-Type', value: 'text/plain' }], body: 'payload' });
  const a = JSON.parse(see.body);
  assert.equal(a.method, 'GET');
  assert.equal(a.body, '');
  assert.equal(a.headers['content-type'], undefined);
  assert.equal(see.url, `${base}/echo`);
  const tmp = await sendRequest({ method: 'POST', url: `${base}/temporary`, headers: [{ name: 'Content-Type', value: 'text/plain' }], body: 'payload' });
  const b = JSON.parse(tmp.body);
  assert.equal(b.method, 'POST');
  assert.equal(b.body, 'payload');
  assert.equal(b.headers['content-length'], '7');
});

test('Authorization is dropped when a redirect changes host; redirect limit', async () => {
  const other = createServer((req, res) => res.end(JSON.stringify({ headers: req.headers })));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  try {
    const port = (other.address() as AddressInfo).port;
    const res = await sendRequest({ method: 'GET', url: `${base}/elsewhere/${port}`, headers: [{ name: 'Authorization', value: 'Bearer secret' }] });
    assert.equal(JSON.parse(res.body).headers.authorization, undefined);
    const same = await sendRequest({ method: 'GET', url: `${base}/redirect`, headers: [{ name: 'Authorization', value: 'Bearer secret' }] });
    assert.equal(JSON.parse(same.body).headers.authorization, 'Bearer secret');
  } finally {
    other.close();
  }
  await assert.rejects(sendRequest({ method: 'GET', url: `${base}/loop`, headers: [] }, { maxRedirects: 3 }), /Request failed: Too many redirects \(more than 3\)/);
});

test('header name casing and order are preserved on the wire; Content-Length is computed', async () => {
  const res = await sendRequest({
    method: 'POST',
    url: `${base}/echo`,
    headers: [
      { name: 'X-Zeta', value: 'z' },
      { name: 'x-CamelCase-Header', value: 'c' },
      { name: 'X-Alpha', value: 'a' },
      { name: 'Content-Length', value: '999' },
      { name: 'Connection', value: 'upgrade' },
    ],
    body: 'héllo',
  });
  const raw: string[] = JSON.parse(res.body).rawHeaders;
  const names = raw.filter((_, i) => i % 2 === 0);
  assert.ok(names.includes('x-CamelCase-Header'), names.join(','));
  assert.ok(names.indexOf('X-Zeta') < names.indexOf('x-CamelCase-Header') && names.indexOf('x-CamelCase-Header') < names.indexOf('X-Alpha'));
  assert.equal(names[0], 'Host');
  assert.equal(raw[raw.indexOf('Content-Length') + 1], '6');
  assert.ok(!raw.includes('999') && !raw.includes('upgrade'));
});

test('a user-supplied Host header is sent as given', async () => {
  const res = await sendRequest({ method: 'GET', url: `${base}/echo`, headers: [{ name: 'host', value: 'api.example.test' }] });
  const raw: string[] = JSON.parse(res.body).rawHeaders;
  assert.equal(raw[raw.indexOf('host') + 1], 'api.example.test');
});

test('response headers keep original casing and duplicates; statusText from the server', async () => {
  const res = await sendRequest({ method: 'GET', url: `${base}/cookies`, headers: [] });
  assert.deepEqual(res.headers.filter(([k]) => k === 'Set-Cookie').map(([, v]) => v), ['a=1; Path=/', 'b=2; Path=/']);
  assert.ok(res.headers.some(([k]) => k === 'X-Mixed-Case'));
  assert.equal(res.statusText, 'OK');
});

test('userinfo in the URL becomes Basic auth unless Authorization is set', async () => {
  const res = await sendRequest({ method: 'GET', url: base.replace('http://', 'http://us%40er:p%3Ass@') + '/echo', headers: [] });
  assert.equal(JSON.parse(res.body).headers.authorization, `Basic ${Buffer.from('us@er:p:ss').toString('base64')}`);
  assert.ok(!res.url.includes('us%40er'));
  const own = await sendRequest({ method: 'GET', url: base.replace('http://', 'http://u:p@') + '/echo', headers: [{ name: 'Authorization', value: 'Bearer x' }] });
  assert.equal(JSON.parse(own.body).headers.authorization, 'Bearer x');
});

test('cancelling gives a readable message', async () => {
  const ac = new AbortController();
  const p = sendRequest({ method: 'GET', url: `${base}/slow`, headers: [] }, { signal: ac.signal });
  setTimeout(() => ac.abort(new Error('Cancelled')), 20);
  await assert.rejects(p, /^Error: Request failed: Cancelled$/);
});

test('noProxy matching', () => {
  assert.equal(bypassProxy('localhost', 80), true);
  assert.equal(bypassProxy('127.0.0.1', 80), true);
  assert.equal(bypassProxy('api.example.com', 443, ['example.com']), true);
  assert.equal(bypassProxy('api.example.com', 443, ['.example.com']), true);
  assert.equal(bypassProxy('example.com', 443, ['*.example.com']), true);
  assert.equal(bypassProxy('notexample.com', 443, ['example.com']), false);
  assert.equal(bypassProxy('example.com', 443, ['example.com:8080']), false);
  assert.equal(bypassProxy('example.com', 8080, ['example.com:8080']), true);
  assert.equal(bypassProxy('anything.org', 80, ['*']), true);
  assert.equal(bypassProxy('anything.org', 80, []), false);
});

// --- TLS and proxies ---------------------------------------------------------------------

/** A throwaway self-signed certificate, or undefined if openssl is unavailable. */
function selfSigned(): { key: Buffer; cert: Buffer } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'plainwire-cert-'));
  try {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    if (r.error || r.status !== 0) return undefined;
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A recording forward proxy: absolute-URI requests and CONNECT tunnels, all routed to local ports. */
async function startProxy(route: (host: string) => number) {
  const log: { method: string; url: string; auth?: string }[] = [];
  const proxy = createServer((req, res) => {
    log.push({ method: req.method!, url: req.url!, auth: req.headers['proxy-authorization'] });
    const target = new URL(req.url!);
    const up = httpRequest({ host: '127.0.0.1', port: route(target.hostname), method: req.method, path: target.pathname + target.search, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode!, ur.headers);
      ur.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on('connect', (req, client: Socket, head: Buffer) => {
    log.push({ method: 'CONNECT', url: req.url!, auth: req.headers['proxy-authorization'] });
    const up = connect(route(req.url!.split(':')[0]), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  return { log, url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, close: () => proxy.close() };
}

test('http requests go through the proxy as absolute-URI requests; localhost bypasses it', async () => {
  const port = Number(new URL(base).port);
  const proxy = await startProxy(() => port);
  try {
    const res = await sendRequest({ method: 'GET', url: 'http://api.plainwire.test/echo?x=1', headers: [] }, { proxy: proxy.url.replace('http://', 'http://pu:pp@') });
    assert.equal(res.status, 201);
    assert.equal(JSON.parse(res.body).url, '/echo?x=1');
    assert.deepEqual(proxy.log, [{ method: 'GET', url: 'http://api.plainwire.test/echo?x=1', auth: `Basic ${Buffer.from('pu:pp').toString('base64')}` }]);
    await sendRequest({ method: 'GET', url: `${base}/echo`, headers: [] }, { proxy: proxy.url });
    assert.equal(proxy.log.length, 1, '127.0.0.1 must bypass the proxy');
  } finally {
    proxy.close();
  }
});

test('self-signed HTTPS: rejected with a hint by default, accepted with rejectUnauthorized false, tunnelled via CONNECT', async (t) => {
  const pair = selfSigned();
  if (!pair) return t.skip('openssl not available');
  const srv = createHttpsServer(pair, (req, res) => res.end(JSON.stringify({ url: req.url, host: req.headers.host })));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const proxy = await startProxy(() => port);
  try {
    await assert.rejects(
      sendRequest({ method: 'GET', url: `https://127.0.0.1:${port}/`, headers: [] }),
      /Request failed: DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate\. Set "plainwire\.rejectUnauthorized": false to accept it \(or add # @insecure above the request\)\./,
    );
    const ok = await sendRequest({ method: 'GET', url: `https://127.0.0.1:${port}/direct`, headers: [] }, { rejectUnauthorized: false });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).url, '/direct');

    await assert.rejects(sendRequest({ method: 'GET', url: 'https://secure.plainwire.test/', headers: [] }, { proxy: proxy.url }), /self-signed certificate\. Set "plainwire\.rejectUnauthorized"/);
    const tunnelled = await sendRequest({ method: 'GET', url: 'https://secure.plainwire.test/tunnel?q=1', headers: [] }, { proxy: proxy.url, rejectUnauthorized: false });
    assert.equal(tunnelled.status, 200);
    assert.deepEqual(JSON.parse(tunnelled.body), { url: '/tunnel?q=1', host: 'secure.plainwire.test' });
    assert.deepEqual(proxy.log.map((l) => `${l.method} ${l.url}`), ['CONNECT secure.plainwire.test:443', 'CONNECT secure.plainwire.test:443']);
  } finally {
    proxy.close();
    srv.close();
  }
});
