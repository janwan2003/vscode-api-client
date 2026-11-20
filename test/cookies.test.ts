import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CookieJar, defaultPath, domainMatch, mergeCookieHeader, parseCookieDate, parseSetCookie, pathMatch } from '../src/core/cookies.ts';
import { parseAssertion, runAssertions } from '../src/core/assert.ts';
import { Executor } from '../src/core/exec.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';
import { sendRequest } from '../src/core/send.ts';

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

test('parseSetCookie: attributes, Max-Age wins over Expires, deletion, invalid lines', () => {
  const c = parseSetCookie('sid=a b=c; Path=/app; Domain=.Example.com; Secure; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2037 07:28:00 GMT', T0)!;
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'a b=c');
  assert.equal(c.domain, 'example.com');
  assert.equal(c.path, '/app');
  assert.equal(c.expires, Date.UTC(2037, 9, 21, 7, 28, 0));
  assert.ok(c.secure && c.httpOnly);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(parseSetCookie('a=1; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT', T0)!.expires, T0 + 60000);
  assert.equal(parseSetCookie('a=; Max-Age=0', T0)!.expired, true);
  assert.equal(parseSetCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', T0)!.expired, true);
  assert.equal(parseSetCookie('novalue', T0), undefined);
  assert.equal(parseSetCookie('=x', T0), undefined);
  assert.equal(parseSetCookie('a=1; Path=relative', T0)!.path, undefined);
});

test('parseCookieDate: RFC 1123, RFC 850, asctime, 2-digit years, garbage', () => {
  assert.equal(parseCookieDate('Sun, 06 Nov 1994 08:49:37 GMT'), Date.UTC(1994, 10, 6, 8, 49, 37));
  assert.equal(parseCookieDate('Sunday, 06-Nov-94 08:49:37 GMT'), Date.UTC(1994, 10, 6, 8, 49, 37));
  assert.equal(parseCookieDate('Sun Nov  6 08:49:37 1994'), Date.UTC(1994, 10, 6, 8, 49, 37));
  assert.equal(parseCookieDate('Fri, 01-Jan-30 00:00:00 GMT'), Date.UTC(2030, 0, 1));
  assert.equal(parseCookieDate('tomorrow'), undefined);
  assert.equal(parseCookieDate('Sun, 32 Nov 1994 08:49:37 GMT'), undefined);
});

test('domainMatch, defaultPath, pathMatch (RFC 6265 5.1.3 / 5.1.4)', () => {
  assert.ok(domainMatch('api.example.com', 'example.com'));
  assert.ok(!domainMatch('badexample.com', 'example.com'));
  assert.ok(!domainMatch('1.2.3.4', '2.3.4'));
  assert.equal(defaultPath('/a/b/c'), '/a/b');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath(''), '/');
  assert.ok(pathMatch('/app/x', '/app'));
  assert.ok(pathMatch('/app/x', '/app/'));
  assert.ok(pathMatch('/app', '/app'));
  assert.ok(!pathMatch('/application', '/app'));
});

test('CookieJar: host-only vs Domain cookies, paths, Secure, ordering, replace and delete', () => {
  const jar = new CookieJar();
  const at = (u: string, h: string, now = T0) => jar.set(new URL(u), h, now);
  assert.ok(at('https://api.example.com/v1/login', 'sid=1; Path=/'));
  assert.ok(at('https://api.example.com/v1/login', 'shared=s; Domain=example.com; Path=/'));
  assert.ok(at('https://api.example.com/v1/login', 'deep=d; Path=/v1'));
  assert.ok(at('https://api.example.com/v1/login', 'dir=x')); // default path /v1
  assert.ok(!at('https://api.example.com/', 'evil=1; Domain=other.com'));
  assert.ok(!at('https://api.example.com/', 'tld=1; Domain=com'));
  assert.ok(!at('http://api.example.com/', 'sec=1; Secure'), 'Secure needs a secure origin');
  assert.ok(at('http://localhost:3000/', 'sec=1; Secure'), 'localhost counts as secure');
  assert.ok(!at('https://api.example.com/', '__Host-x=1; Secure; Path=/; Domain=example.com'));
  assert.ok(at('https://api.example.com/', '__Host-x=1; Secure; Path=/'));

  assert.equal(jar.cookieHeader('https://api.example.com/v1/users', T0), 'deep=d; dir=x; sid=1; shared=s; __Host-x=1');
  assert.equal(jar.cookieHeader('https://www.example.com/', T0), 'shared=s', 'host-only cookies stay on their host');
  assert.equal(jar.cookieHeader('https://api.example.com/v2', T0), 'sid=1; shared=s; __Host-x=1');
  assert.equal(jar.cookieHeader('http://api.example.com/v2', T0), 'sid=1; shared=s', 'no Secure cookies over http');
  assert.equal(jar.cookieHeader('http://localhost:3000/', T0), 'sec=1');
  assert.equal(jar.cookieHeader('https://nothere.org/', T0), undefined);

  // Replacing keeps the position (creation time); Max-Age=0 deletes.
  at('https://api.example.com/', 'sid=2; Path=/', T0 + 1000);
  assert.equal(jar.cookieHeader('https://api.example.com/', T0 + 1000), 'sid=2; shared=s; __Host-x=1');
  at('https://api.example.com/', 'sid=; Path=/; Max-Age=0', T0 + 2000);
  assert.equal(jar.cookieHeader('https://api.example.com/', T0 + 2000), 'shared=s; __Host-x=1');

  // Expiry.
  at('https://api.example.com/', 'short=1; Path=/; Max-Age=10', T0);
  assert.match(jar.cookieHeader('https://api.example.com/', T0 + 5000)!, /short=1/);
  assert.doesNotMatch(jar.cookieHeader('https://api.example.com/', T0 + 11000) ?? '', /short=1/);

  // Persistence round trip and delete.
  const copy = new CookieJar(JSON.parse(JSON.stringify(jar.toJSON())));
  assert.equal(copy.cookieHeader('https://api.example.com/v1/x', T0), jar.cookieHeader('https://api.example.com/v1/x', T0));
  copy.delete({ name: 'shared', domain: 'example.com', path: '/' });
  assert.doesNotMatch(copy.cookieHeader('https://api.example.com/', T0) ?? '', /shared/);
  copy.delete();
  assert.equal(copy.size, 0);
});

test('CookieJar: per-domain limit evicts the oldest', () => {
  const jar = new CookieJar();
  for (let i = 0; i < 200; i++) jar.set(new URL('https://a.test/'), `c${i}=1`, T0 + i);
  assert.equal(jar.size, 180);
  assert.doesNotMatch(jar.cookieHeader('https://a.test/', T0 + 300)!, /\bc0=/);
  assert.match(jar.cookieHeader('https://a.test/', T0 + 300)!, /\bc199=/);
});

test('mergeCookieHeader: the request\'s own cookies win by name', () => {
  assert.equal(mergeCookieHeader(undefined, 'a=1'), 'a=1');
  assert.equal(mergeCookieHeader('a=mine', undefined), 'a=mine');
  assert.equal(mergeCookieHeader('a=mine', 'a=1; b=2'), 'a=mine; b=2');
  assert.equal(mergeCookieHeader('a=mine;', 'a=1'), 'a=mine;');
});

test('assert: cookie <name> reads this response\'s Set-Cookie', () => {
  const res = { status: 200, statusText: 'OK', headers: [['Set-Cookie', 'sid=abc; Path=/; HttpOnly'], ['set-cookie', 'old=; Max-Age=0']] as [string, string][], body: '', bodyEncoding: 'utf8' as const, size: 0, timeMs: 1, url: 'http://x/' };
  const r = runAssertions(['cookie sid == abc', 'cookie sid exists', 'res.cookies.sid startsWith a', 'cookie old !exists', 'cookie nope exists'], res);
  assert.deepEqual(parseAssertion('cookie sid == abc').subject, { kind: 'cookie', name: 'sid' });
  assert.deepEqual(r.map((x) => x.passed), [true, true, true, true, false], JSON.stringify(r));
});

// ---- Live: a login that answers 302 + Set-Cookie, then pages that need the session.

let server: Server;
let base = '';
let dir = '';
const seen: { url: string; cookie?: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url ?? '', cookie: req.headers.cookie });
      const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (req.url === '/login') return json(302, {}, { location: '/dashboard', 'set-cookie': ['sid=s3cr3t; Path=/; HttpOnly', 'flash=welcome; Path=/dashboard'] });
      if (req.url === '/dashboard') return sid ? json(200, { user: 'ada', cookie: req.headers.cookie }) : json(401, { error: 'no session' });
      if (req.url === '/me') return sid ? json(200, { user: 'ada', cookie: req.headers.cookie }) : json(401, { error: 'no session' });
      if (req.url === '/logout') return json(200, {}, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      json(200, { cookie: req.headers.cookie ?? null });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'pw-cookies-'));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sendRequest: cookies set on a redirect hop are sent on the next hop and stored', async () => {
  seen.length = 0;
  const jar = new CookieJar();
  const r = await sendRequest({ method: 'POST', url: `${base}/login`, headers: [], body: 'u=ada' }, { cookieJar: jar, timeoutMs: 5000 });
  assert.equal(r.status, 200);
  assert.equal(seen[1].url, '/dashboard');
  assert.equal(seen[1].cookie, 'flash=welcome; sid=s3cr3t');
  assert.equal(r.sentCookie, 'flash=welcome; sid=s3cr3t');
  // The request's own Cookie header is kept and wins by name.
  const r2 = await sendRequest({ method: 'GET', url: `${base}/echo`, headers: [{ name: 'Cookie', value: 'sid=override; extra=1' }] }, { cookieJar: jar, timeoutMs: 5000 });
  assert.equal(JSON.parse(r2.body).cookie, 'sid=override; extra=1');
  // Without a jar nothing is added.
  const r3 = await sendRequest({ method: 'GET', url: `${base}/echo`, headers: [] }, { timeoutMs: 5000 });
  assert.equal(JSON.parse(r3.body).cookie, null);
  assert.equal(r3.sentCookie, undefined);
});

test('Executor: session cookie from a chained login; # @no-cookie-jar; logout deletes it', async () => {
  const file = [
    '### Me',
    '# @assert status == 200',
    `GET ${base}/me`,
    'X-Login: {{login.response.body.$.user}}',
    '',
    '### Login',
    '# @name login',
    '# @assert cookie sid !exists',
    `POST ${base}/login`,
    '',
    '### Without the jar',
    '# @no-cookie-jar',
    `GET ${base}/me`,
    '',
    '### Logout',
    '# @assert cookie sid !exists',
    `GET ${base}/logout`,
    '',
    '### Me again',
    `GET ${base}/me`,
    '',
  ].join('\n');
  const jar = new CookieJar();
  const exec = new Executor({
    readHttpFile: async () => file,
    readBodyFile: async () => new Uint8Array(),
    dotenv: async () => ({}),
    environment: () => ({}),
    sendOptions: () => ({ timeoutMs: 5000 }),
    cookieJar: jar,
  });
  const reqs = parseHttpFile(file).requests;
  const me = await exec.run(reqs[0], 'f.http');
  assert.equal(me.response.status, 200, me.response.body);
  assert.ok(me.assertions.every((a) => a.passed));
  assert.equal((await exec.run(reqs[2], 'f.http')).response.status, 401);
  assert.equal(jar.size, 2);
  const out = await exec.run(reqs[3], 'f.http');
  assert.ok(out.assertions.every((a) => a.passed), JSON.stringify(out.assertions));
  assert.equal(jar.list().some((c) => c.name === 'sid'), false);
  assert.equal((await exec.run(reqs[4], 'f.http')).response.status, 401);
});

test('CLI: cookies carry across a run; --no-cookie-jar turns them off', async () => {
  const cli = join(dir, 'plainwire.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))], outfile: cli, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', define: { PLAINWIRE_VERSION: '"9.9.9"' } });
  writeFileSync(join(dir, 'session.http'), ['### Log in', `POST ${base}/login`, '', '### Dashboard', '# @assert status == 200', '# @assert $.user == ada', `GET ${base}/me`, ''].join('\n'));
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) =>
      execFile(process.execPath, [cli, 'run', 'session.http', ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '' } }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout + stderr })),
    );
  const on = await run([]);
  assert.equal(on.code, 0, on.stdout);
  assert.match(on.stdout, /2 passed, 0 failed/);
  const off = await run(['--no-cookie-jar']);
  assert.equal(off.code, 1, off.stdout);
  // Without a jar even the login's own redirect to /dashboard is unauthenticated (0.8.0 behaviour).
  assert.match(off.stdout, /0 passed, 2 failed/);
});
