import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendRequest } from '../src/core/send.ts';

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
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500);
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-test': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
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
