import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { authReferences, OAuth2Manager, readAuthConfig, type OAuth2Host } from '../src/core/oauth2.ts';
import { Executor } from '../src/core/exec.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';
import { sendRequest } from '../src/core/send.ts';
import { addEnvironments, mergeEnvironment } from '../src/core/variables.ts';

// A small OAuth 2 server: token endpoint (all grants), authorize endpoint, device endpoint, protected API.
let server: Server;
let base = '';
const log: string[] = [];
let issued = 0;
const codes = new Map<string, { challenge?: string; method?: string; redirect: string }>();
let devicePolls = 0;
let refreshFails = false;

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const json = (status: number, obj: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const token = (extra: Record<string, unknown> = {}) => json(200, { access_token: `at-${++issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${issued}`, ...extra });
      if (u.pathname === '/token') {
        const grant = body.get('grant_type');
        log.push(`token ${grant} auth=${req.headers.authorization ?? ''} body=${[...body.keys()].sort().join(',')} aud=${body.get('audience') ?? ''} x=${req.headers['x-tenant'] ?? ''}`);
        if (grant === 'client_credentials') {
          const want = `Basic ${Buffer.from('my+client:s%3Acr%2Bt').toString('base64')}`;
          if (req.headers.authorization !== want && body.get('client_secret') !== 's:cr+t') return json(401, { error: 'invalid_client', error_description: 'bad client' });
          return token({ scope: body.get('scope') });
        }
        if (grant === 'password') return body.get('password') === 'pw' ? token() : json(400, { error: 'invalid_grant', error_description: 'wrong password' });
        if (grant === 'refresh_token') return refreshFails ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: `at-${++issued}-refreshed`, expires_in: 3600 });
        if (grant === 'authorization_code') {
          const c = codes.get(body.get('code') ?? '');
          if (!c) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
          if (c.redirect !== body.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
          if (c.challenge) {
            const v = body.get('code_verifier') ?? '';
            const ok = c.method === 'plain' ? v === c.challenge : b64url(createHash('sha256').update(v).digest()) === c.challenge;
            if (!ok) return json(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
          }
          return token({ id_token: 'idt-1' });
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          devicePolls++;
          if (devicePolls === 1) return json(400, { error: 'authorization_pending' });
          if (devicePolls === 2) return json(400, { error: 'slow_down' });
          return token();
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/authorize') {
        const redirect = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        log.push(`authorize ${u.searchParams.get('response_type')} scope=${u.searchParams.get('scope')} aud=${u.searchParams.get('audience') ?? ''} pkce=${u.searchParams.get('code_challenge_method') ?? ''}`);
        if (u.searchParams.get('client_id') === 'deny') {
          res.writeHead(302, { location: `${redirect}?error=access_denied&error_description=User+said+no&state=${state}` }).end();
          return;
        }
        if (u.searchParams.get('response_type') === 'token') {
          res.writeHead(302, { location: `${redirect}#access_token=implicit-1&token_type=Bearer&expires_in=60&state=${state}` }).end();
          return;
        }
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? undefined, method: u.searchParams.get('code_challenge_method') ?? undefined, redirect });
        res.writeHead(302, { location: `${redirect}?code=${code}&state=${state}` }).end();
        return;
      }
      if (u.pathname === '/device') {
        log.push(`device client=${body.get('client_id')} scope=${body.get('scope')}`);
        return json(200, { device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: `${base}/activate`, verification_uri_complete: `${base}/activate?code=ABCD-1234`, interval: 1, expires_in: 600 });
      }
      if (u.pathname === '/api') {
        log.push(`api ${req.headers.authorization ?? ''}`);
        return req.headers.authorization?.startsWith('Bearer at-') || u.searchParams.get('t')?.startsWith('at-') || req.headers.authorization === 'Bearer mock-tok' ? json(200, { ok: true }) : json(401, { error: 'unauthorized' });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

/** A "browser": follows the authorize redirect into the loopback server (a fragment is posted back as the page's script would). */
async function browser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location')!;
  const hash = loc.indexOf('#');
  if (hash >= 0) {
    const page = await fetch(loc.slice(0, hash));
    assert.match(await page.text(), /__plainwire_fragment/);
    await fetch(new URL(`/__plainwire_fragment?${loc.slice(hash + 1)}`, loc));
    return;
  }
  const back = await fetch(loc);
  await back.text();
}

function host(extra: Partial<OAuth2Host> = {}): OAuth2Host {
  return { send: (req, signal) => sendRequest(req, { timeoutMs: 5000, signal }), openBrowser: browser, sleep: async () => {}, ...extra };
}

const env = (auth: Record<string, unknown>, vars: Record<string, string> = {}) => ({ ...vars, Security: JSON.stringify({ Auth: auth }) });

test('readAuthConfig: JetBrains keys, defaults, variables, PKCE forms, custom parameters, errors', () => {
  const e = env({
    a: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': '{{base}}/token', 'Client ID': 'id', 'Client Secret': '{{secret}}', Scope: 'read write', 'Custom Request Parameters': { audience: { Value: 'aud', Use: 'In Token Request' }, resource: ['r1', 'r2'], plain: 'p' }, 'Custom Request Headers': { 'X-Tenant': { Value: 't', Use: 'Everywhere' } } },
    b: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': 'https://a/auth', 'Token URL': 'https://a/token', 'Client ID': 'id', PKCE: true, 'Acquire Automatically': false, 'Use ID Token': true },
    c: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': 'https://a/auth', 'Token URL': 'https://a/token', 'Client ID': 'id', PKCE: { 'Code Challenge Method': 'Plain', 'Code Verifier': 'v' }, 'Client Credentials': 'in body' },
    m: { Type: 'Mock', Token: 'mock-tok', 'ID Token': 'mock-id' },
    bad: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Client ID': 'id' },
    nogrant: { Type: 'OAuth2', 'Client ID': 'id' },
  });
  const vars: Record<string, string> = { base: 'http://h', secret: 's3' };
  const a = readAuthConfig(e, 'a', (s) => s.replace(/\{\{(\w+)\}\}/g, (_x, k: string) => vars[k]));
  assert.equal(a.grantType, 'Client Credentials');
  assert.equal(a.tokenUrl, 'http://h/token');
  assert.equal(a.clientSecret, 's3');
  assert.equal(a.clientCredentials, 'basic');
  assert.equal(a.acquireAutomatically, true);
  assert.deepEqual(a.params, [
    { name: 'audience', value: 'aud', use: 'In Token Request' },
    { name: 'resource', value: 'r1', use: 'Everywhere' },
    { name: 'resource', value: 'r2', use: 'Everywhere' },
    { name: 'plain', value: 'p', use: 'Everywhere' },
  ]);
  assert.deepEqual(a.headers, [{ name: 'X-Tenant', value: 't', use: 'Everywhere' }]);
  const b = readAuthConfig(e, 'b');
  assert.deepEqual(b.pkce, { method: 'S256' });
  assert.equal(b.acquireAutomatically, false);
  assert.equal(b.useIdToken, true);
  const c = readAuthConfig(e, 'c');
  assert.deepEqual(c.pkce, { method: 'plain', verifier: 'v' });
  assert.equal(c.clientCredentials, 'in body');
  assert.equal(readAuthConfig(e, 'm').mockToken, 'mock-tok');
  assert.throws(() => readAuthConfig(e, 'bad'), /Auth "bad" \(Client Credentials\): "Token URL" is missing/);
  assert.throws(() => readAuthConfig(e, 'nogrant'), /"Grant Type" is missing/);
  assert.throws(() => readAuthConfig(e, 'zzz'), /No auth configuration "zzz".*found: a, b, c, m, bad, nogrant/);
  assert.throws(() => readAuthConfig({}, 'zzz'), /Select an environment/);
  assert.deepEqual(authReferences('Bearer {{$auth.token("a")}} {{ $auth.idToken(\'b\') }} {{$auth.token("a")}}'), ['a', 'b']);
});

test('environments: http-client.private.env.json adds a Client Secret to the public Security config; $shared merges too', () => {
  const envs: Record<string, Record<string, string>> = {};
  addEnvironments(envs, { $shared: { Security: { Auth: { api: { 'Client ID': 'shared-id', Scope: 's' } } } }, dev: { Security: { Auth: { api: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': 'https://t' } } }, host: 'h' } });
  addEnvironments(envs, { dev: { Security: { Auth: { api: { 'Client Secret': 'private!' } } } } });
  const merged = mergeEnvironment(envs, 'dev');
  const cfg = readAuthConfig(merged, 'api');
  assert.equal(cfg.clientId, 'shared-id');
  assert.equal(cfg.clientSecret, 'private!');
  assert.equal(cfg.tokenUrl, 'https://t');
  assert.equal(cfg.scope, 's');
  assert.equal(merged.host, 'h');
  // A string variable still simply wins.
  addEnvironments(envs, { dev: { host: 'h2' } });
  assert.equal(mergeEnvironment(envs, 'dev').host, 'h2');
});

test('Client Credentials: Basic client auth (form-encoded id/secret), token request params, cache, refresh, re-acquire', async () => {
  let now = 1_000_000;
  const m = new OAuth2Manager(host({ now: () => now }));
  const cfg = readAuthConfig(env({ api: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': `${base}/token`, 'Client ID': 'my client', 'Client Secret': 's:cr+t', Scope: 'read', 'Custom Request Parameters': { audience: { Value: 'aud1', Use: 'In Token Request' }, prompt: { Value: 'x', Use: 'In Auth Request' } }, 'Custom Request Headers': { 'X-Tenant': 'acme' } } }), 'api');
  log.length = 0;
  const t1 = await m.token(cfg);
  assert.match(t1.accessToken, /^at-\d+$/);
  assert.equal(t1.scope, 'read');
  assert.equal(t1.expiresAt, now + 3600_000);
  assert.match(log[0], /^token client_credentials auth=Basic \S+ body=audience,grant_type,scope aud=aud1 x=acme$/);
  assert.equal((await m.token(cfg)).accessToken, t1.accessToken, 'cached');
  assert.equal(log.length, 1);
  assert.equal(m.cached(cfg)?.accessToken, t1.accessToken);
  // Expired (inside the 30 s skew) → refresh token used.
  now += 3600_000 - 10_000;
  assert.equal(m.cached(cfg), undefined);
  const t2 = await m.token(cfg);
  assert.match(t2.accessToken, /-refreshed$/);
  assert.equal(t2.refreshToken, t1.refreshToken, 'old refresh token kept when the server sends none');
  assert.match(log[1], /^token refresh_token /);
  // Refresh rejected → a new client_credentials token.
  now += 3600_000;
  refreshFails = true;
  try {
    const t3 = await m.token(cfg);
    assert.match(t3.accessToken, /^at-\d+$/);
    assert.deepEqual(log.slice(2).map((l) => l.split(' ')[1]), ['refresh_token', 'client_credentials']);
  } finally {
    refreshFails = false;
  }
  // Concurrent calls share one request.
  const fresh = new OAuth2Manager(host());
  log.length = 0;
  const [x, y] = await Promise.all([fresh.token(cfg), fresh.token(cfg)]);
  assert.equal(x.accessToken, y.accessToken);
  assert.equal(log.length, 1);
});

test('Client Credentials "in body", Password grant, readable errors', async () => {
  const m = new OAuth2Manager(host());
  const e = env({
    body: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': `${base}/token`, 'Client ID': 'my client', 'Client Secret': 's:cr+t', 'Client Credentials': 'in body' },
    wrong: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': `${base}/token`, 'Client ID': 'x', 'Client Secret': 'nope' },
    pw: { Type: 'OAuth2', 'Grant Type': 'Password', 'Token URL': `${base}/token`, 'Client ID': 'cli', Username: 'ada', Password: 'pw', 'Client Credentials': 'none' },
    pwbad: { Type: 'OAuth2', 'Grant Type': 'Password', 'Token URL': `${base}/token`, 'Client ID': 'cli', Username: 'ada', Password: 'bad' },
    down: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': 'http://127.0.0.1:1/token', 'Client ID': 'x', 'Client Secret': 'y' },
  });
  log.length = 0;
  assert.match((await m.token(readAuthConfig(e, 'body'))).accessToken, /^at-/);
  assert.match(log[0], /auth= body=client_id,client_secret,grant_type/);
  await assert.rejects(m.token(readAuthConfig(e, 'wrong')), /Auth "wrong": token request failed: invalid_client: bad client \(HTTP 401\)/);
  log.length = 0;
  assert.match((await m.token(readAuthConfig(e, 'pw'))).accessToken, /^at-/);
  assert.match(log[0], /^token password auth= body=client_id,grant_type,password,username/);
  await assert.rejects(m.token(readAuthConfig(e, 'pwbad')), /invalid_grant: wrong password/);
  await assert.rejects(m.token(readAuthConfig(e, 'down')), /Auth "down": http:\/\/127\.0\.0\.1:1\/token could not be reached/);
});

test('Authorization Code: loopback redirect on a free port, PKCE S256 and plain, state, provider errors', async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const freePort = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const opened: string[] = [];
  const m = new OAuth2Manager(host({ openBrowser: async (u) => { opened.push(u); return browser(u); } }));
  const e = env({
    code: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': `${base}/authorize`, 'Token URL': `${base}/token`, 'Client ID': 'web', Scope: 'openid profile', PKCE: true, 'Custom Request Parameters': { audience: { Value: 'aud2', Use: 'In Auth Request' } } },
    plain: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': `${base}/authorize`, 'Token URL': `${base}/token`, 'Client ID': 'web', PKCE: { 'Code Challenge Method': 'Plain' }, 'Redirect URL': `http://localhost:${freePort}/cb/here` },
    deny: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': `${base}/authorize`, 'Token URL': `${base}/token`, 'Client ID': 'deny' },
    remote: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Auth URL': `${base}/authorize`, 'Token URL': `${base}/token`, 'Client ID': 'web', 'Redirect URL': 'https://app.example.com/callback' },
  });
  log.length = 0;
  const t = await m.token(readAuthConfig(e, 'code'));
  assert.match(t.accessToken, /^at-/);
  assert.equal(t.idToken, 'idt-1');
  const auth = new URL(opened[0]);
  assert.match(auth.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(log.slice(0, 2).map((l) => l.split(' ').slice(0, 2).join(' ')), ['authorize code', 'token authorization_code']);
  assert.match(log[0], /scope=openid profile aud=aud2 pkce=S256/);
  assert.match(log[1], /body=client_id,code,code_verifier,grant_type,redirect_uri aud= /, 'auth-only parameter not sent to the token endpoint');
  const p = await m.token(readAuthConfig(e, 'plain'));
  assert.match(p.accessToken, /^at-/);
  assert.equal(new URL(opened[1]).searchParams.get('code_challenge_method'), 'plain');
  assert.equal(new URL(opened[1]).searchParams.get('redirect_uri'), `http://localhost:${freePort}/cb/here`);
  await assert.rejects(m.token(readAuthConfig(e, 'deny')), /sign-in failed: access_denied: User said no/);
  await assert.rejects(m.token(readAuthConfig(e, 'remote')), /"Redirect URL" must be an http:\/\/localhost/);
  // No browser available (e.g. a host without one) → clear error.
  await assert.rejects(new OAuth2Manager({ send: host().send }).token(readAuthConfig(e, 'code')), /needs a browser/);
  // Cancelled while waiting for the browser.
  const ac = new AbortController();
  const waiting = new OAuth2Manager(host({ openBrowser: () => void setTimeout(() => ac.abort(), 20) })).token(readAuthConfig(e, 'code'), { signal: ac.signal });
  await assert.rejects(waiting, /Cancelled/);
});

test('Implicit grant: token from the redirect fragment', async () => {
  const m = new OAuth2Manager(host());
  const t = await m.token(readAuthConfig(env({ imp: { Type: 'OAuth2', 'Grant Type': 'Implicit', 'Auth URL': `${base}/authorize`, 'Client ID': 'spa' } }), 'imp'));
  assert.equal(t.accessToken, 'implicit-1');
  assert.ok(t.expiresAt);
});

test('Device Authorization: shows the code, polls through authorization_pending and slow_down', async () => {
  const shown: string[] = [];
  const opened: string[] = [];
  const sleeps: number[] = [];
  devicePolls = 0;
  const m = new OAuth2Manager(host({ openBrowser: (u) => void opened.push(u), showDeviceCode: (i) => void shown.push(`${i.id} ${i.userCode} ${i.verificationUri}`), sleep: async (ms) => void sleeps.push(ms) }));
  const cfg = readAuthConfig(env({ dev: { Type: 'OAuth2', 'Grant Type': 'Device Authorization', 'Device Auth URL': `${base}/device`, 'Token URL': `${base}/token`, 'Client ID': 'tv', Scope: 'read', 'Client Credentials': 'none', 'Open Complete URI': true } }), 'dev');
  const t = await m.token(cfg);
  assert.match(t.accessToken, /^at-/);
  assert.deepEqual(shown, [`dev ABCD-1234 ${base}/activate`]);
  assert.deepEqual(opened, [`${base}/activate?code=ABCD-1234`]);
  assert.deepEqual(sleeps, [1000, 1000, 6000], 'interval 1 s, +5 s after slow_down');
  assert.equal(devicePolls, 3);
});

test('Executor: {{$auth.token("id")}} fetches once, is reused, previews from cache only; Mock; missing config', async () => {
  const environment = {
    ...env({
      api: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': '{{base}}/token', 'Client ID': 'my client', 'Client Secret': '{{secret}}' },
      mock: { Type: 'Mock', Token: 'mock-tok' },
    }),
    base,
    secret: 's:cr+t',
  };
  const file = `# @name one\n# @assert status == 200\nGET {{base}}/api\nAuthorization: Bearer {{$auth.token("api")}}\n\n###\nGET {{base}}/api?t={{$auth.token("api")}}\n\n###\nGET {{base}}/api\nAuthorization: Bearer {{$auth.token("mock")}}\n\n###\nGET {{base}}/api\nAuthorization: Bearer {{$auth.token("nope")}}\n\n###\nGET {{base}}/api\nAuthorization: Bearer {{$auth.idToken("api")}}\n`;
  const oauth2 = new OAuth2Manager(host());
  const exec = new Executor({ readHttpFile: async () => file, readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => environment, sendOptions: () => ({ timeoutMs: 5000 }), oauth2 });
  const reqs = parseHttpFile(file).requests;
  const before = await exec.preview(reqs[0], 'f.http');
  assert.deepEqual(before.unresolved, ['$auth.token("api")'], 'nothing is sent for a preview');
  log.length = 0;
  const r1 = await exec.run(reqs[0], 'f.http');
  assert.equal(r1.response.status, 200);
  assert.equal(r1.assertions[0].passed, true);
  const r2 = await exec.run(reqs[1], 'f.http');
  assert.equal(r2.response.status, 200);
  assert.deepEqual(log.map((l) => l.split(' ').slice(0, 2).join(' ')), ['token client_credentials', 'api Bearer', 'api ']);
  const after = await exec.preview(reqs[0], 'f.http');
  assert.deepEqual(after.unresolved, []);
  assert.match(after.request.headers.find((h) => h.name === 'Authorization')!.value, /^Bearer at-\d+$/);
  assert.equal((await exec.run(reqs[2], 'f.http')).response.status, 200);
  await assert.rejects(exec.run(reqs[3], 'f.http'), /No auth configuration "nope".*found: api, mock/);
  await assert.rejects(exec.run(reqs[4], 'f.http'), /no id_token/);
  // Without a manager (e.g. a host that does not support it): a clear error.
  const plain = new Executor({ readHttpFile: async () => file, readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => environment, sendOptions: () => ({ timeoutMs: 5000 }) });
  await assert.rejects(plain.run(reqs[0], 'f.http'), /OAuth 2 is not available here/);
});

test('CLI: client credentials from http-client.env.json + secret from the private file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-oauth-'));
  try {
    const cli = join(dir, 'plainwire.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))], outfile: cli, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', define: { PLAINWIRE_VERSION: '"9.9.9"' } });
    writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { base, Security: { Auth: { api: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': '{{base}}/token', 'Client ID': 'my client' } } } } }));
    writeFileSync(join(dir, 'http-client.private.env.json'), JSON.stringify({ local: { Security: { Auth: { api: { 'Client Secret': 's:cr+t' } } } } }));
    writeFileSync(join(dir, 'api.http'), `# @assert status == 200\nGET {{base}}/api\nAuthorization: Bearer {{$auth.token("api")}}\n\n###\n# @assert status == 200\nGET {{base}}/api\nAuthorization: Bearer {{$auth.token("api")}}\n`);
    log.length = 0;
    const r = await new Promise<{ code: number; out: string }>((res) => execFile(process.execPath, [cli, 'run', '--env', 'local', '--no-color'], { cwd: dir }, (e, out, err) => res({ code: (e as { code?: number } | null)?.code ?? 0, out: out + err })));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 passed/);
    assert.equal(log.filter((l) => l.startsWith('token ')).length, 1, 'one token for the whole run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
