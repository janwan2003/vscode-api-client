// Server-sent events: parser (HTML standard rules) and streaming responses from a local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { SseParser, eventsView } from '../src/core/sse.ts';
import { sendRequest } from '../src/core/send.ts';
import { Executor, requestSendOptions } from '../src/core/exec.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';

test('SseParser: fields, multi-line data, comments, default type, id persistence, retry', () => {
  const p = new SseParser();
  const ev = p.feed(': hello\n\ndata: a\ndata:b\n\nevent: tick\nid: 7\nretry: 1500\ndata: {"n":1}\n\ndata\n\nevent: x\n\ndata: after\n\nid: \ndata: no id\n\n');
  assert.deepEqual(ev.map(({ timeMs, ...e }) => e), [
    { event: 'message', data: 'a\nb' },
    { event: 'tick', data: '{"n":1}', id: '7', retry: 1500 },
    { event: 'message', data: '', id: '7' },
    // `event: x` with no data is not dispatched, and its type does not leak into the next event.
    { event: 'message', data: 'after', id: '7' },
    { event: 'message', data: 'no id' },
  ]);
});

test('SseParser: CRLF split across chunks, lone CR, BOM, unfinished event dropped', () => {
  const p = new SseParser();
  const out = [...p.feed('﻿data: one\r'), ...p.feed('\n\r\n'), ...p.feed('data: two\r\rdata: thr'), ...p.feed('ee\n')];
  assert.deepEqual(out.map((e) => e.data), ['one', 'two']);
  // "three" never got its blank line: not an event.
  assert.equal(p.feed('').length, 0);
  // A CRLF split right after CR does not produce an extra blank line.
  const q = new SseParser();
  assert.deepEqual([...q.feed('data: a\r'), ...q.feed('\ndata: b\r\n\r\n')].map((e) => e.data), ['a\nb']);
});

test('eventsView parses JSON data, leaves text alone', () => {
  const v = eventsView([{ event: 'message', data: '{"a":1}', timeMs: 1 }, { event: 'message', data: '[DONE]', timeMs: 2 }, { event: 'message', data: '42', timeMs: 3 }]);
  assert.deepEqual(v.map((e) => e.data), [{ a: 1 }, '[DONE]', 42]);
});

let server: Server;
let base = '';
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const enc = u.searchParams.has('gzip') ? 'gzip' : (u.searchParams.get('enc') ?? '');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...(enc ? { 'content-encoding': enc } : {}) });
    const z = enc === 'gzip' ? zlib.createGzip() : enc === 'br' ? zlib.createBrotliCompress() : enc === 'deflate' ? zlib.createDeflate() : undefined;
    if (z) z.pipe(res);
    const write = (t: string) => (z ? (z.write(t), (z as zlib.Gzip).flush()) : res.write(t));
    const count = Number(u.searchParams.get('n') ?? 3);
    const forever = u.pathname === '/forever';
    let i = 0;
    const tick = () => {
      i++;
      write(`event: tick\nid: ${i}\ndata: {"n": ${i}, "text": "é${i}"}\n\n`);
      if (!forever && i >= count) {
        write('data: [DONE]\n\n');
        return z ? z.end() : res.end();
      }
      timer = setTimeout(tick, 20);
    };
    let timer = setTimeout(tick, 10);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('send: a stream that the server closes; events arrive live, body keeps the raw text', async () => {
  const live: number[] = [];
  const started = Date.now();
  const r = await sendRequest({ method: 'GET', url: `${base}/three`, headers: [] }, { timeoutMs: 5000, onEvent: () => live.push(Date.now() - started) });
  assert.equal(r.status, 200);
  assert.equal(r.streamEnd, 'closed');
  assert.deepEqual(r.events!.map((e) => e.data), ['{"n": 1, "text": "é1"}', '{"n": 2, "text": "é2"}', '{"n": 3, "text": "é3"}', '[DONE]']);
  assert.deepEqual(r.events!.map((e) => e.id), ['1', '2', '3', '3']);
  assert.equal(live.length, 4);
  assert.ok(live[0] < live[3], 'events were delivered as they arrived, not all at the end');
  assert.match(r.body, /^event: tick\nid: 1\ndata: \{"n": 1, "text": "é1"\}\n\n/);
  assert.equal(r.size, Buffer.byteLength(r.body));
});

test('send: gzip-compressed stream is decompressed as it arrives', async () => {
  const r = await sendRequest({ method: 'GET', url: `${base}/three?gzip&n=2`, headers: [] }, { timeoutMs: 5000 });
  assert.equal(r.streamEnd, 'closed');
  assert.deepEqual(r.events!.map((e) => e.data), ['{"n": 1, "text": "é1"}', '{"n": 2, "text": "é2"}', '[DONE]']);
  assert.ok(r.size < Buffer.byteLength(r.body) + 100);
});

test('send: br and deflate streams too', async () => {
  for (const enc of ['br', 'deflate']) {
    const r = await sendRequest({ method: 'GET', url: `${base}/three?enc=${enc}&n=2`, headers: [] }, { timeoutMs: 5000 });
    assert.equal(r.streamEnd, 'closed', enc);
    assert.deepEqual(r.events!.map((e) => e.data), ['{"n": 1, "text": "é1"}', '{"n": 2, "text": "é2"}', '[DONE]'], enc);
  }
});

test('send: endless stream ends at maxEvents, at the timeout, or when stopped, keeping what arrived', async () => {
  const a = await sendRequest({ method: 'GET', url: `${base}/forever`, headers: [] }, { timeoutMs: 5000, maxEvents: 2 });
  assert.equal(a.streamEnd, 'max-events');
  assert.equal(a.events!.length, 2);
  const b = await sendRequest({ method: 'GET', url: `${base}/forever`, headers: [] }, { timeoutMs: 150 });
  assert.equal(b.streamEnd, 'timeout');
  assert.ok(b.events!.length >= 2, String(b.events!.length));
  const stop = new AbortController();
  const p = sendRequest({ method: 'GET', url: `${base}/forever`, headers: [] }, { timeoutMs: 5000, signal: stop.signal, onEvent: (e) => e.id === '3' && stop.abort() });
  const c = await p;
  assert.equal(c.streamEnd, 'stopped');
  assert.equal(c.events!.length, 3);
});

test('Executor: # @max-events, # @timeout and events assertions', async () => {
  const file = [
    '### Ticks',
    '# @max-events 2',
    '# @assert events.length == 2',
    '# @assert events[0].event == tick',
    '# @assert events[0].data.n == 1',
    '# @assert events[-1].data.text == é2',
    '# @assert events[1].id == "2"',
    '# @assert $.n exists',
    `GET ${base}/forever`,
    '',
    '### Timeout',
    '# @timeout 0.2s',
    '# @assert events.length > 1',
    `GET ${base}/forever`,
    '',
  ].join('\n');
  const exec = new Executor({ readHttpFile: async () => file, readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => ({}), sendOptions: () => ({ timeoutMs: 5000 }) });
  const reqs = parseHttpFile(file).requests;
  const seen: string[] = [];
  const r = await exec.run(reqs[0], 'f.http', undefined, { onEvent: (e) => seen.push(e.id!) });
  assert.deepEqual(seen, ['1', '2']);
  assert.deepEqual(r.assertions.map((x) => [x.source, x.passed, x.message]), [
    ['events.length == 2', true, 'passed'],
    ['events[0].event == tick', true, 'passed'],
    ['events[0].data.n == 1', true, 'passed'],
    ['events[-1].data.text == é2', true, 'passed'],
    ['events[1].id == "2"', true, 'passed'],
    ['$.n exists', false, 'response body is not JSON'],
  ]);
  const t0 = Date.now();
  const t = await exec.run(reqs[1], 'f.http');
  assert.equal(t.response.streamEnd, 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(t.assertions[0].passed, t.assertions[0].message);
});

test('requestSendOptions: units and bad values', () => {
  const r = (meta: Record<string, string>) => requestSendOptions({ method: 'GET', url: 'x', headers: [], meta });
  assert.deepEqual(r({ timeout: '2500' }), { timeoutMs: 2500 });
  assert.deepEqual(r({ timeout: '5s', 'max-events': '3' }), { timeoutMs: 5000, maxEvents: 3 });
  assert.deepEqual(r({ timeout: '2m' }), { timeoutMs: 120000 });
  assert.throws(() => r({ timeout: 'soon' }), /# @timeout soon: expected milliseconds/);
  assert.throws(() => r({ 'max-events': '0' }), /# @max-events 0/);
});

test('events assertions on a non-stream response fail with a clear message', async () => {
  const { runAssertions } = await import('../src/core/assert.ts');
  const res = { status: 200, statusText: 'OK', headers: [], body: '{}', bodyEncoding: 'utf8' as const, size: 2, timeMs: 1, url: 'x' };
  assert.match(runAssertions(['events.length == 1'], res)[0].message, /not a server-sent events/);
});
