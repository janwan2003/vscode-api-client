// WebSocket requests: script parsing, framing, and full conversations with a local RFC 6455 server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { acceptKey, encodeFrame, FrameReader, isWebSocketRequest, OP, parseWsScript, sendWebSocket } from '../src/core/websocket.ts';
import { Executor } from '../src/core/exec.ts';
import { parseHttpFile, serializeHttpFile } from '../src/core/httpFile.ts';
import { runAssertions } from '../src/core/assert.ts';
import { CookieJar } from '../src/core/cookies.ts';

test('parseWsScript: messages, separators with comments, waits before and after', () => {
  const s = parseWsScript(['', '{"a":1}', '=== // separator', '{"b":2}', '', '=== wait-for-server', 'three', 'lines', '===   wait-for-server', '=== wait-for-server', 'four', '=== wait-for-server', ''].join('\n'));
  assert.deepEqual(s.steps, [
    { wait: 0, message: '{"a":1}' },
    { wait: 0, message: '{"b":2}' },
    { wait: 1, message: 'three\nlines' },
    { wait: 2, message: 'four' },
  ]);
  assert.equal(s.trailingWaits, 1);
  assert.deepEqual(parseWsScript(undefined), { steps: [], trailingWaits: 0 });
  // `====` or `=== something` is message text, not a separator.
  assert.deepEqual(parseWsScript('====\n=== later').steps, [{ wait: 0, message: '====\n=== later' }]);
});

test('isWebSocketRequest: WEBSOCKET keyword or ws(s):// with GET', () => {
  assert.equal(isWebSocketRequest({ method: 'WEBSOCKET', url: 'http://x/ws' }), true);
  assert.equal(isWebSocketRequest({ method: 'GET', url: 'wss://x/ws' }), true);
  assert.equal(isWebSocketRequest({ method: 'WS', url: 'wss://x/ws' }), true);
  assert.equal(isWebSocketRequest({ method: 'GET', url: 'https://x/ws' }), false);
  assert.equal(isWebSocketRequest({ method: 'POST', url: 'ws://x/ws' }), false);
});

test('parseHttpFile keeps a WEBSOCKET request and its === lines, and writes it back unchanged', () => {
  const text = ['### Chat', 'WEBSOCKET ws://localhost:8080/chat', 'Content-Type: application/json', '', '{"hi":1}', '=== wait-for-server', '{"bye":1}', ''].join('\n');
  const f = parseHttpFile(text);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'WEBSOCKET');
  assert.equal(f.requests[0].url, 'ws://localhost:8080/chat');
  assert.equal(f.requests[0].body, '{"hi":1}\n=== wait-for-server\n{"bye":1}');
  assert.equal(serializeHttpFile(f.variables, f.requests), text);
});

test('frames: lengths 0, 125, 126, 65535, 65536 round-trip, masked and unmasked, split anywhere', () => {
  for (const len of [0, 125, 126, 65535, 65536]) {
    for (const mask of [true, false]) {
      const payload = Buffer.alloc(len, 7);
      const bytes = encodeFrame(OP.binary, payload, mask);
      const r = new FrameReader();
      const out = [...r.push(bytes.subarray(0, 1)), ...r.push(bytes.subarray(1, 3)), ...r.push(bytes.subarray(3))];
      assert.equal(out.length, 1);
      assert.equal(out[0].opcode, OP.binary);
      assert.equal(out[0].payload.length, len);
      assert.ok(out[0].payload.equals(payload));
    }
  }
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // RFC 6455 section 1.3
});

// A small server: /echo echoes text and binary, greets first if ?greet; /fragmented sends one message
// in 3 fragments with a ping between; /close closes with 4000 after the first message; /deny answers 401;
// /badaccept answers 101 with a wrong key; /cookie echoes the Cookie header and sets one.
let server: Server;
let base = '';
const sockets = new Set<Socket>();
before(async () => {
  server = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('token required');
  });
  server.on('upgrade', (req, socket: Socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const url = new URL(req.url!, 'http://x');
    const key = req.headers['sec-websocket-key'] as string;
    if (url.pathname === '/deny') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 14\r\n\r\ntoken required');
      return;
    }
    const extra = url.pathname === '/cookie' ? 'Set-Cookie: sid=new; Path=/\r\n' : '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}Sec-WebSocket-Accept: ${url.pathname === '/badaccept' ? 'nope' : acceptKey(key)}\r\n\r\n`);
    const send = (op: number, data: Buffer | string, fin = true) => socket.writable && socket.write(encodeFrame(op, typeof data === 'string' ? Buffer.from(data) : data, false, fin));
    if (url.searchParams.has('greet')) send(OP.text, '{"hello":"there"}');
    if (url.pathname === '/cookie') send(OP.text, JSON.stringify({ cookie: req.headers.cookie ?? '', ua: req.headers['user-agent'], auth: req.headers.authorization ?? '' }));
    if (url.pathname === '/fragmented') {
      send(OP.text, 'one ', false);
      send(OP.ping, 'p');
      send(OP.continuation, 'two ', false);
      send(OP.continuation, 'three');
    }
    const reader = new FrameReader();
    const onData = (c: Buffer) => {
      for (const f of reader.push(c)) {
        if (f.opcode === OP.close) {
          send(OP.close, f.payload);
          socket.end();
          return;
        }
        if (f.opcode === OP.pong) send(OP.text, `pong:${f.payload}`);
        if (f.opcode === OP.text || f.opcode === OP.binary) {
          if (url.pathname === '/close') {
            const p = Buffer.alloc(2 + 3);
            p.writeUInt16BE(4000);
            p.write('bye', 2);
            send(OP.close, p);
            socket.end();
            return;
          }
          send(f.opcode, f.opcode === OP.text ? `echo:${f.payload}` : f.payload);
        }
      }
    };
    if (head.length) onData(head);
    socket.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

test('sendWebSocket: script with waits ends "done" after the trailing waits; transcript and events in order', async () => {
  const script = parseWsScript(['{"n":1}', '===', 'second', '=== wait-for-server', '=== wait-for-server', 'third', '=== wait-for-server'].join('\n'));
  const res = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo`, headers: [{ name: 'Content-Type', value: 'application/json' }] }, script, { timeoutMs: 5000 });
  assert.equal(res.status, 101);
  assert.equal(res.streamEnd, 'done');
  assert.deepEqual(res.events!.map((e) => [e.event, e.data]), [
    ['sent', '{"n":1}'],
    ['sent', 'second'],
    ['message', 'echo:{"n":1}'],
    ['message', 'echo:second'],
    ['sent', 'third'],
    ['message', 'echo:third'],
  ]);
  assert.match(res.body, /^> \{"n":1\}\n> second\n< echo:\{"n":1\}/);
  assert.equal(res.url, `${base}/echo`);
});

test('sendWebSocket: greeting counts as a reply; @max-events counts received messages only', async () => {
  const res = await sendWebSocket({ method: 'GET', url: `${base}/echo?greet`, headers: [] }, parseWsScript('a\n===\nb\n===\nc'), { timeoutMs: 5000, maxEvents: 2 });
  assert.equal(res.streamEnd, 'max-events');
  assert.equal(res.events!.filter((e) => e.event !== 'sent').length, 2);
  assert.equal(res.events![0].event, 'sent'); // the first message goes out on open, before any reply
});

test('sendWebSocket: fragmented message with a ping in between; binary from bytes', async () => {
  const frag = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/fragmented`, headers: [] }, { steps: [], trailingWaits: 1 }, { timeoutMs: 5000 });
  assert.deepEqual(frag.events!.map((e) => e.data), ['one two three']);
  const bin = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo`, headers: [] }, { steps: [{ wait: 0, message: new Uint8Array([1, 2, 3]) }], trailingWaits: 1 }, { timeoutMs: 5000 });
  assert.deepEqual(bin.events!.map((e) => [e.event, e.data]), [['sent', 'AQID'], ['binary', 'AQID']]);
  assert.match(bin.body, /> \(3 bytes, binary\)\n< \(3 bytes, binary\)/);
});

test('sendWebSocket: server close code and reason; timeout and stop keep what arrived', async () => {
  const closed = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/close`, headers: [] }, parseWsScript('x'), { timeoutMs: 5000 });
  assert.equal(closed.streamEnd, 'closed');
  assert.equal(closed.closeReason, '4000 bye');
  assert.match(closed.body, /-- closed: 4000 bye$/);

  const t = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo`, headers: [] }, parseWsScript('x'), { timeoutMs: 300 });
  assert.equal(t.streamEnd, 'timeout');
  assert.deepEqual(t.events!.map((e) => e.data), ['x', 'echo:x']);

  const stop = new AbortController();
  const s = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo?greet`, headers: [] }, { steps: [], trailingWaits: 0 }, { timeoutMs: 5000, signal: stop.signal, onEvent: () => stop.abort() });
  assert.equal(s.streamEnd, 'stopped');
  assert.equal(s.events!.length, 1);
});

test('sendWebSocket: refused handshake is a normal response; wrong accept key is an error', async () => {
  const denied = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/deny`, headers: [] }, parseWsScript('x'), { timeoutMs: 5000 });
  assert.equal(denied.status, 401);
  assert.equal(denied.body, 'token required');
  assert.equal(denied.events, undefined);
  await assert.rejects(sendWebSocket({ method: 'WEBSOCKET', url: `${base}/badaccept`, headers: [] }, parseWsScript('x'), { timeoutMs: 5000 }), /WebSocket failed: .*Sec-WebSocket-Accept/);
  await assert.rejects(sendWebSocket({ method: 'WEBSOCKET', url: 'ws://127.0.0.1:1/x', headers: [] }, parseWsScript('x'), { timeoutMs: 5000 }), /WebSocket failed/);
});

test('sendWebSocket: cookies from the jar and the request, user-agent, basic auth from the URL; Set-Cookie stored', async () => {
  const jar = new CookieJar();
  jar.setFromResponse(new URL(base.replace('ws', 'http')), ['jar=1; Path=/']);
  const res = await sendWebSocket({ method: 'WEBSOCKET', url: base.replace('ws://', 'ws://u:p@') + '/cookie', headers: [{ name: 'Cookie', value: 'own=2' }] }, { steps: [], trailingWaits: 1 }, { timeoutMs: 5000, cookieJar: jar, userAgent: 'plainwire/test' });
  const got = JSON.parse(res.events![0].data);
  assert.equal(got.cookie, 'own=2; jar=1');
  assert.equal(got.ua, 'plainwire/test');
  assert.equal(got.auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.match(jar.cookieHeader(new URL(base.replace('ws', 'http') + '/')) ?? '', /sid=new/);
});

test('Executor: variables, < file messages, messages/events/$ checks', async () => {
  const file = [
    '@who = world',
    '### Echo',
    '# @assert status == 101',
    '# @assert messages.length == 2',
    '# @assert messages[0].data == echo:hi world',
    '# @assert events.length == 4',
    '# @assert events[1].event == sent',
    '# @assert $.v == 1',
    `WEBSOCKET ${base}/echo`,
    '',
    'hi {{who}}',
    '===',
    '<@ ./msg.json',
    '=== wait-for-server',
    '=== wait-for-server',
    '',
  ].join('\n');
  const exec = new Executor({
    readHttpFile: async () => file,
    readBodyFile: async (p) => new TextEncoder().encode(p === './msg.json' ? '{"v":{{$randomInt 1 2}}}' : ''),
    dotenv: async () => ({}),
    environment: () => ({}),
    sendOptions: () => ({ timeoutMs: 5000 }),
  });
  const req = parseHttpFile(file).requests[0];
  const seen: string[] = [];
  const r = await exec.run(req, 'f.http', undefined, { onEvent: (e) => seen.push(e.event) });
  assert.deepEqual(seen, ['sent', 'sent', 'message', 'message']);
  assert.equal(r.response.events![2].data, 'echo:hi world');
  // `$` is the last received message, after the "echo:" prefix the server adds → not JSON here.
  assert.deepEqual(r.assertions.map((a) => [a.source, a.passed]).slice(0, 5), [
    ['status == 101', true],
    ['messages.length == 2', true],
    ['messages[0].data == echo:hi world', true],
    ['events.length == 4', true],
    ['events[1].event == sent', true],
  ]);
  assert.equal(r.assertions[5].passed, false);
});

test('runAssertions: $ is the last received JSON message on a WebSocket response', () => {
  const res = { status: 101, statusText: '', headers: [], body: '', bodyEncoding: 'utf8' as const, size: 0, timeMs: 1, url: 'ws://x', events: [{ event: 'message', data: '{"n":1}', timeMs: 1 }, { event: 'sent', data: 'x', timeMs: 2 }, { event: 'message', data: '{"n":2}', timeMs: 3 }] };
  assert.deepEqual(runAssertions(['$.n == 2', 'messages[0].data.n == 1', 'events[1].data == x'], res).map((a) => a.passed), [true, true, true]);
  assert.match(runAssertions(['messages.length == 1'], { ...res, events: undefined })[0].message, /not a WebSocket response/);
});

test('generateCode refuses WebSocket requests with a clear message', async () => {
  const { generateCode } = await import('../src/core/codegen.ts');
  assert.throws(() => generateCode('curl', { method: 'WEBSOCKET', url: 'wss://x/ws', headers: [] }), /WebSocket requests cannot be copied as code/);
  assert.throws(() => generateCode('python-requests', { method: 'GET', url: 'ws://x/ws', headers: [] }), /WebSocket/);
  assert.match(generateCode('curl', { method: 'GET', url: 'https://x/ws', headers: [] }), /^curl/);
});

test('sendWebSocket: onWsOpen sends typed messages into the open connection; refused once closing', async () => {
  const stop = new AbortController();
  let typed: ((t: string) => boolean) | undefined;
  const replies: string[] = [];
  const done = sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo`, headers: [] }, parseWsScript('first'), {
    timeoutMs: 5000,
    signal: stop.signal,
    onWsOpen: (send) => (typed = send),
    onEvent: (e) => {
      if (e.event !== 'message') return;
      replies.push(e.data);
      if (e.data === 'echo:first') assert.equal(typed!('typed {"a":1}'), true);
      if (e.data === 'echo:typed {"a":1}') stop.abort();
    },
  });
  const res = await done;
  assert.equal(res.streamEnd, 'stopped');
  assert.deepEqual(res.events!.map((e) => [e.event, e.data]), [
    ['sent', 'first'],
    ['message', 'echo:first'],
    ['sent', 'typed {"a":1}'],
    ['message', 'echo:typed {"a":1}'],
  ]);
  assert.match(res.body, /> typed \{"a":1\}\n< echo:typed/);
  assert.equal(typed!('too late'), false);
});

test('sendWebSocket: a typed message restarts the timeout (an interactive session stays open while used)', async () => {
  const t0 = Date.now();
  const res = await sendWebSocket({ method: 'WEBSOCKET', url: `${base}/echo`, headers: [] }, { steps: [], trailingWaits: 0 }, {
    timeoutMs: 400,
    onWsOpen: (send) => setTimeout(() => send('still here'), 300),
  });
  assert.equal(res.streamEnd, 'timeout');
  assert.ok(Date.now() - t0 >= 650, `closed after ${Date.now() - t0} ms, before the restarted timeout`);
  assert.deepEqual(res.events!.map((e) => e.data), ['still here', 'echo:still here']);
});
