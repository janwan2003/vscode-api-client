// Local test API on :8787 for scripts/shot/live (screenshots and hand checks).
import http from 'node:http';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/users/1') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin', 'dev'], address: { city: 'London', zip: 'N1' } })); }
    if (u.pathname === '/users' && req.method === 'POST') { res.statusCode = 201; res.statusMessage = 'Created'; res.setHeader('content-type', 'application/json'); let b = {}; try { b = JSON.parse(body); } catch {} return res.end(JSON.stringify({ id: 42, ...b, createdAt: '2026-11-20T12:00:00Z', settings: { theme: 'dark', notifications: { email: true, push: false } } })); }
    if (u.pathname === '/login' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'sid=abc123; Path=/; HttpOnly'); return res.end(JSON.stringify({ token: 'tok-' + Date.now() })); }
    if (u.pathname === '/html') { res.setHeader('content-type', 'text/html'); return res.end('<html><body><h1>Hello</h1></body></html>'); }
    if (u.pathname === '/big') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, name: 'item ' + i })))); }
    if (u.pathname === '/err') { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end('{"error":"boom"}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body }));
  });
}).listen(8787, '127.0.0.1');
