// Local test API on :8787 for scripts/shot/live (screenshots and hand checks).
import http from 'node:http';
import crypto from 'node:crypto';
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/users/1') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin', 'dev'], address: { city: 'London', zip: 'N1' } })); }
    if (u.pathname === '/users' && req.method === 'POST') { res.statusCode = 201; res.statusMessage = 'Created'; res.setHeader('content-type', 'application/json'); let b = {}; try { b = JSON.parse(body); } catch {} return res.end(JSON.stringify({ id: 42, ...b, createdAt: '2026-11-20T12:00:00Z', settings: { theme: 'dark', notifications: { email: true, push: false } } })); }
    if (u.pathname === '/login' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'sid=abc123; Path=/; HttpOnly'); return res.end(JSON.stringify({ token: 'tok-' + Date.now() })); }
    if (u.pathname === '/html') { res.setHeader('content-type', 'text/html'); return res.end('<html><body><h1>Hello</h1></body></html>'); }
    if (u.pathname === '/big') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, name: 'item ' + i })))); }
    if (u.pathname === '/token' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZGEiLCJzY29wZSI6InJlYWQifQ.', token_type: 'Bearer', expires_in: 3600, scope: 'read' })); }
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`event: price\nid: ${n}\ndata: ${JSON.stringify({ symbol: 'ACME', price: 100 + n * 1.25, n })}\n\n`);
        if (n >= 5) { clearInterval(t); res.end(); }
      }, 400);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (u.pathname === '/err') { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end('{"error":"boom"}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body }));
  });
});
// Minimal WebSocket echo on /ws (text frames only): replies {"echo": <msg>, "n": k}.
srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (op, buf) => { const len = buf.length; const h = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]); return Buffer.concat([h, buf]); };
  sock.write(frame(1, Buffer.from(JSON.stringify({ hello: 'connected' }))));
  let acc = Buffer.alloc(0), k = 0;
  sock.on('data', (d) => {
    acc = Buffer.concat([acc, d]);
    while (acc.length >= 2) {
      const op = acc[0] & 15; let len = acc[1] & 127, off = 2;
      if (len === 126) { len = acc.readUInt16BE(2); off = 4; }
      if (acc.length < off + 4 + len) return;
      const mask = acc.subarray(off, off + 4); const p = Buffer.from(acc.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      acc = acc.subarray(off + 4 + len);
      if (op === 8) { sock.end(frame(8, Buffer.from([3, 232]))); return; }
      if (op === 9) { sock.write(frame(10, p)); continue; }
      if (op === 1) { let m = p.toString(); try { m = JSON.parse(m); } catch {} sock.write(frame(1, Buffer.from(JSON.stringify({ echo: m, n: ++k })))); }
    }
  });
  sock.on('error', () => {});
});
srv.listen(8787, '127.0.0.1');
