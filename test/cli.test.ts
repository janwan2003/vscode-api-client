// Builds the real CLI bundle and runs it as a subprocess against a local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { globToRegExp, parseJsonc, findHttpFiles } from '../src/cli/files.ts';
import { githubAnnotations, junitReport } from '../src/cli/report.ts';
import { summarize } from '../src/core/exec.ts';

let server: Server;
let base = '';
let dir = '';
let cli = '';
const seen: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/login') return json(200, { token: `tok-${JSON.parse(Buffer.concat(chunks).toString()).user}` });
      if (req.url === '/me') return req.headers.authorization === 'Bearer tok-alice' ? json(200, { name: 'Alice', roles: ['admin'] }) : json(401, { error: 'no' });
      if (req.url === '/missing') return json(404, { error: 'not found' });
      if (req.url === '/upload') return json(200, { got: Buffer.concat(chunks).toString() });
      if (req.url === '/graphql') return json(200, { contentType: req.headers['content-type'], requestType: req.headers['x-request-type'] ?? null, received: JSON.parse(Buffer.concat(chunks).toString()) });
      json(200, { path: req.url });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'pw-cli-'));
  cli = join(dir, 'plainwire.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))], outfile: cli, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', define: { PLAINWIRE_VERSION: '"9.9.9"' } });

  mkdirSync(join(dir, 'api', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ $shared: { user: 'alice' }, local: { base }, other: { base: 'http://127.0.0.1:1' } }));
  writeFileSync(join(dir, 'api', 'body.json'), '{"file": "{{user}}"}');
  writeFileSync(
    join(dir, 'api', 'auth.http'),
    [
      '### Who am I',
      '# @assert status == 200',
      '# @assert $.name == Alice',
      'GET {{base}}/me',
      'Authorization: Bearer {{login.response.body.$.token}}',
      '',
      '### Log in',
      '# @name login',
      'POST {{base}}/login',
      'Content-Type: application/json',
      '',
      '{"user": "{{user}}"}',
      '',
      '### Upload a file with variables',
      'POST {{base}}/upload',
      'Content-Type: application/json',
      '',
      '<@ ./body.json',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'api', 'nested', 'checks.rest'),
    ['### Expect 404', '# @assert status == 404', 'GET {{base}}/missing', '', '### Wrong expectation', '# @assert $.path == /nope', 'GET {{base}}/thing', '', '### Skipped', '# @skip', 'GET {{base}}/skipped', '', '### Plain 404', 'GET {{base}}/missing', ''].join('\n'),
  );
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('run: environment, chaining across order, <@ body file, asserts; exit 0 when all pass', async () => {
  seen.length = 0;
  const r = await runCli(['run', 'api/auth.http', '--env', 'local']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 passed, 0 failed/);
  assert.match(r.stdout, /environment local/);
  // /me comes first in the file but needs login's token: login is sent first as a dependency
  // (and again later as its own row, like every request in the file).
  assert.ok(seen[0].startsWith('POST /login'), seen.join('\n'));
  assert.equal(seen[1], 'GET /me Bearer tok-alice');
  assert.ok(seen.some((s) => s.startsWith('POST /upload')));
});

test('run: failures set exit 1, report file:line, JUnit + JSON + Markdown files written', async () => {
  const r = await runCli(['run', 'api', '-e', 'local', '--junit', 'out/junit.xml', '--json', 'out/r.json', '--markdown', 'out/r.md']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /4 passed, 2 failed, 1 skipped/);
  assert.match(r.stdout, /\$\.path == \/nope/);
  assert.match(r.stdout, /at api\/nested\/checks\.rest:7/);
  assert.match(r.stdout, /HTTP 404 \(a request without # @assert lines/);
  const xml = readFileSync(join(dir, 'out', 'junit.xml'), 'utf8');
  assert.match(xml, /<testsuites name="plainwire" tests="7" failures="2" errors="0" skipped="1"/);
  assert.match(xml, /<testsuite name="api\/nested\/checks.rest" tests="4" failures="2"/);
  assert.match(xml, /<failure message="\$\.path == \/nope/);
  const json = JSON.parse(readFileSync(join(dir, 'out', 'r.json'), 'utf8'));
  assert.equal(json.summary.failed, 2);
  assert.match(readFileSync(join(dir, 'out', 'r.md'), 'utf8'), /\*\*Plainwire run: api\*\*: 4 passed, 2 failed/);
});

test('run: --grep, --bail, --var, quoted globs', async () => {
  const g = await runCli(['run', '-e', 'local', '--grep', 'expect 404']);
  assert.equal(g.code, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /1 passed, 0 failed \(1 requests/);

  const b = await runCli(['run', 'api/nested', '-e', 'local', '--bail']);
  assert.equal(b.code, 1);
  assert.match(b.stdout, /1 passed, 1 failed, 2 skipped/);
  assert.match(b.stdout, /not run, --bail/);

  // --var overrides the environment: base points at a closed port → connection error.
  const v = await runCli(['run', 'api/nested/checks.rest', '-e', 'local', '--var', 'base=http://127.0.0.1:1', '-q']);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /ECONNREFUSED/);
  assert.match(v.stdout, /3 errors/);

  const glob = await runCli(['run', '**/*.rest', '-e', 'local', '-g', '^Expect']);
  assert.equal(glob.code, 0, glob.stdout + glob.stderr);
});

test('run: GitHub Actions annotations and job summary', async () => {
  const summary = join(dir, 'summary.md');
  const r = await runCli(['run', 'api/nested', '-e', 'local'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: join(dir, '..') });
  assert.equal(r.code, 1);
  // Relative to the repository root (GITHUB_WORKSPACE), not the working directory.
  const prefix = `${dir.split(/[\\/]/).pop()}/`;
  assert.ok(r.stdout.includes(`::error file=${prefix}api/nested/checks.rest,line=7,title=GET Wrong expectation::$.path == /nope`), r.stdout);
  assert.match(readFileSync(summary, 'utf8'), /\| ❌ \| GET Wrong expectation/);
});

test('usage errors exit 2 with a readable message', async () => {
  const unknownEnv = await runCli(['run', '-e', 'prod']);
  assert.equal(unknownEnv.code, 2);
  assert.match(unknownEnv.stderr, /Environment "prod" not found\. Available: local, other/);
  const missing = await runCli(['run', 'nope.http']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Not found: nope\.http/);
  const badOpt = await runCli(['run', '--frobnicate']);
  assert.equal(badOpt.code, 2);
  assert.match((await runCli(['--version'])).stdout, /^9\.9\.9/);
  // An unresolved variable is a request error, not a crash.
  const noEnv = await runCli(['run', 'api/nested/checks.rest', '-q']);
  assert.equal(noEnv.code, 1);
  assert.match(noEnv.stdout, /Variable \{\{base\}\} is not defined\. It is defined in environment "local" and "other", but no environment is selected\. Run with --env local\./);
});

test('import: Postman collection → .http files + env file', async () => {
  writeFileSync(
    join(dir, 'pm.json'),
    JSON.stringify({
      info: { name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Orders', item: [{ name: 'List orders', request: { method: 'GET', url: '{{host}}/orders' }, event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {', '  pm.response.to.have.status(200);', '});'] } }] }] }],
    }),
  );
  const r = await runCli(['import', 'pm.json', '--out', 'imported']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Imported 1 request into 1 file/);
  const text = readFileSync(join(dir, 'imported', 'Shop API', 'Orders.http'), 'utf8');
  assert.match(text, /GET \{\{host\}\}\/orders/);
  assert.match(text, /# @assert status == 200/);
  // Running it again does not overwrite.
  await runCli(['import', 'pm.json', '--out', 'imported']);
  assert.ok(existsSync(join(dir, 'imported', 'Shop API', 'Orders-2.http')));
});

test('globToRegExp, parseJsonc, findHttpFiles', () => {
  assert.ok(globToRegExp('**/*.http').test('a/b/c.http'));
  assert.ok(globToRegExp('**/*.http').test('c.http'));
  assert.ok(!globToRegExp('*.http').test('a/c.http'));
  assert.ok(globToRegExp('api/*.{http,rest}').test('api/x.rest'));
  assert.deepEqual(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,],\n}'), { a: 'http://x', b: [1] });
  const { files } = findHttpFiles(['api'], dir);
  assert.deepEqual(files.map((f) => f.slice(dir.length + 1)), ['api/auth.http', 'api/nested/checks.rest']);
});

test('junitReport escapes XML; annotations escape newlines', () => {
  const rows = [{ file: 'a<b>.http', line: 3, index: 0, method: 'GET', label: 'x & "y"', state: 'fail' as const, status: 500, assertions: [{ source: 'status == 200', passed: false, message: 'got 500\nline2' }] }];
  const xml = junitReport(rows, summarize(rows, 5));
  assert.match(xml, /name="a&lt;b&gt;\.http"/);
  assert.match(xml, /name="GET x &amp; &quot;y&quot;"/);
  assert.deepEqual(githubAnnotations(rows), ['::error file=a<b>.http,line=3,title=GET x & "y"::status == 200: got 500%0Aline2']);
});

test('import: Thunder split layout puts environments beside the collection', async () => {
  const src = join(dir, 'thunder-tests');
  mkdirSync(join(src, 'collections'), { recursive: true });
  mkdirSync(join(src, 'environments'), { recursive: true });
  const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/thunder-split/${n}`, import.meta.url)), 'utf8');
  writeFileSync(join(src, 'collections', 'tc_col_shop.json'), fx('tc_col_shop.json'));
  writeFileSync(join(src, 'environments', 'tc_env_dev.json'), fx('tc_env_dev.json'));
  const r = await runCli(['import', 'thunder-tests', '--out', 'split-out']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const envFiles = r.stdout.split('\n').filter((l) => l.includes('http-client.env.json'));
  assert.equal(envFiles.length, 1, r.stdout);
  assert.ok(r.stdout.split('\n').some((l) => l.trim().startsWith(envFiles[0].trim().replace(/http-client\.env\.json$/, '')) && l.endsWith('.http')), r.stdout);
});

test('run: GraphQL requests (X-REQUEST-TYPE: GraphQL) are sent as JSON; bad variables are a request error', async () => {
  mkdirSync(join(dir, 'gql'), { recursive: true });
  writeFileSync(
    join(dir, 'gql', 'pets.http'),
    [
      '### Pet by id',
      '# @assert $.contentType == application/json',
      '# @assert $.requestType isNull',
      '# @assert $.received.operationName == Pet',
      '# @assert $.received.variables.id == 7',
      '# @assert $.received.variables.owner == {{user}}',
      '# @assert $.received.query contains pet(id: $id) { id name }',
      'POST {{base}}/graphql',
      'X-REQUEST-TYPE: GraphQL',
      '',
      'query Pet($id: ID!) {',
      '  pet(id: $id) { id {{field}} }',
      '}',
      '',
      '{"id": {{petId}}, "owner": "{{user}}"}',
      '',
      '### Broken variables',
      'POST {{base}}/graphql',
      'x-request-type: graphql',
      '',
      'query { pets { id } }',
      '',
      '{"id": }',
      '',
    ].join('\n'),
  );
  const r = await runCli(['run', 'gql', '-e', 'local', '--var', 'petId=7', '--var', 'field=name']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /1 passed, 0 failed, 1 errors/);
  assert.match(r.stdout, /GraphQL variables are not valid JSON/);
});

test('run: # @import shares variables and a named login across files; a missing import is a request error', async () => {
  mkdirSync(join(dir, 'imp', 'shared'), { recursive: true });
  mkdirSync(join(dir, 'imp', 'api'), { recursive: true });
  writeFileSync(join(dir, 'imp', 'shared', 'auth.http'), ['@who = alice', '', '### Log in', '# @name login', 'POST {{base}}/login', 'Content-Type: application/json', '', '{"user": "{{who}}"}', ''].join('\n'));
  writeFileSync(
    join(dir, 'imp', 'api', 'me.http'),
    ['# @import ../shared/auth.http', '', '### Me', '# @assert $.name == Alice', 'GET {{base}}/me', 'Authorization: Bearer {{login.response.body.$.token}}', ''].join('\n'),
  );
  writeFileSync(join(dir, 'imp', 'broken.http'), ['import ./gone.http', 'GET {{base}}/x', ''].join('\n'));
  seen.length = 0;
  const ok = await runCli(['run', 'imp/api/me.http', '--env', 'local']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /1 passed, 0 failed/);
  assert.deepEqual(seen, ['POST /login ', 'GET /me Bearer tok-alice']);
  // A shared login marked # @skip is skipped as its own row but still sent when another file chains to it.
  writeFileSync(join(dir, 'imp', 'shared', 'auth.http'), ['@who = alice', '', '### Log in', '# @skip', '# @name login', 'POST {{base}}/login', 'Content-Type: application/json', '', '{"user": "{{who}}"}', ''].join('\n'));
  seen.length = 0;
  const skip = await runCli(['run', 'imp/shared', 'imp/api', '--env', 'local']);
  assert.equal(skip.code, 0, skip.stdout + skip.stderr);
  assert.match(skip.stdout, /1 passed, 0 failed, 1 skipped/);
  assert.deepEqual(seen, ['POST /login ', 'GET /me Bearer tok-alice']);
  const bad = await runCli(['run', 'imp/broken.http', '--env', 'local']);
  assert.equal(bad.code, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /Cannot import \.\/gone\.http from broken\.http: .*gone\.http could not be read/);
});

test('run: a server-sent events request with # @max-events and events checks', async () => {
  const sse = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => res.write(`data: {"i": ${++i}}\n\n`), 10);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => sse.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(join(dir, 'sse.http'), ['### Ticks', '# @max-events 3', '# @assert events.length == 3', '# @assert events[2].data.i == 3', `GET http://127.0.0.1:${(sse.address() as AddressInfo).port}/`, ''].join('\n'));
    const r = await runCli(['run', 'sse.http']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ GET Ticks 200 · \d+ ms · 3 events \(max-events\) · 2\/2 checks/);
  } finally {
    sse.close();
  }
});

test('import: an OpenAPI definition from a URL (redirect followed); a 404 is a clear error', async () => {
  const spec = readFileSync(fileURLToPath(new URL('./fixtures/openapi/shop-3.1.json', import.meta.url)), 'utf8');
  const srv = createServer((req, res) => {
    if (req.url === '/docs/spec') {
      res.writeHead(302, { location: '/v3/shop.json' });
      return res.end();
    }
    if (req.url === '/v3/shop.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(spec);
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await runCli(['import', `${at}/docs/spec`, '--out', 'from-url']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Imported \d+ requests? into \d+ files?/);
    assert.ok(existsSync(join(dir, 'from-url')));
    const bad = await runCli(['import', `${at}/missing.json`]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /GET http:\/\/127\.0\.0\.1:\d+\/missing\.json returned 404/);
  } finally {
    srv.close();
  }
});
