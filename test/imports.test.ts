// `# @import ./other.http` (httpYac) and `import ./other.http` (JetBrains): parser, executor, preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseHttpFile, replaceRequest } from '../src/core/httpFile.ts';
import { Executor, loadHttpFile, previewRequest, type ExecHost } from '../src/core/exec.ts';

test('parser: # @import, // @import and JetBrains import lines are file-level imports, not request metadata', () => {
  const f = parseHttpFile(['# @import ./shared.http', '// @import "../common/auth.http"', 'import ./jb.rest', '', '### One', 'GET https://a.test/x', ''].join('\n'));
  assert.deepEqual(f.imports, ['./shared.http', '../common/auth.http', './jb.rest']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].meta, undefined);
  assert.equal(f.requests[0].url, 'https://a.test/x');
  // A file with only imports and variables has no requests but keeps both.
  const lib = parseHttpFile('# @import ./a.http\n@host = h\n');
  assert.deepEqual(lib.imports, ['./a.http']);
  assert.deepEqual(lib.variables, [{ name: 'host', value: 'h' }]);
  assert.equal(parseHttpFile('GET https://a.test\n').imports, undefined);
});

test('parser: "import" without a .http path is still a request line; JetBrains run lines are kept, not sent', () => {
  // A host called "import" (unlikely, but valid) is not swallowed.
  assert.equal(parseHttpFile('import.example.com/x\n').requests[0].url, 'import.example.com/x');
  const f = parseHttpFile(['### Uses login', 'run #login', 'run #(other)', 'run ./setup.http', 'GET https://a.test/me', ''].join('\n'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://a.test/me');
  assert.deepEqual(f.requests[0].rawBefore, ['run #login', 'run #(other)', 'run ./setup.http']);
});

test('replaceRequest keeps an import line that sits in the edited request\'s preamble', () => {
  const text = ['# @import ./shared.http', '@x = 1', 'GET {{host}}/a', ''].join('\n');
  const out = replaceRequest(text, 0, { method: 'POST', url: '{{host}}/b', headers: [] });
  assert.equal(out, ['# @import ./shared.http', '@x = 1', 'POST {{host}}/b', ''].join('\n'));
  assert.deepEqual(parseHttpFile(out).imports, ['./shared.http']);
});

function memoryHost(files: Record<string, string>, env: Record<string, string> = {}): ExecHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readHttpFile: async (f) => {
      reads.push(f);
      if (!(f in files)) throw new Error('ENOENT');
      return files[f];
    },
    resolveImport: (p, from) => {
      // POSIX-style join for the test: /dir/a.http + ../b/c.http
      const parts = from.split('/').slice(0, -1);
      for (const seg of p.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      return parts.join('/');
    },
    readBodyFile: async () => new Uint8Array(),
    dotenv: async () => ({}),
    environment: () => env,
    sendOptions: () => ({ timeoutMs: 5000 }),
  };
}

test('loadHttpFile: nested imports, precedence (own > later import > earlier import > nested), cycles read once', async () => {
  const host = memoryHost({
    '/p/api/users.http': '# @import ../shared/base.http\n# @import ./local.http\n@own = users\nGET {{host}}/users\n',
    '/p/shared/base.http': '# @import ./root.http\n@host = https://base.test\n@who = base\n@level = base\n',
    '/p/shared/root.http': '# @import ../api/users.http\n@host = https://root.test\n@level = root\n@rootOnly = r\n',
    '/p/api/local.http': '@who = local\n',
  });
  const loaded = await loadHttpFile(host, '/p/api/users.http');
  assert.deepEqual(loaded.imported.map((f) => f.file), ['/p/shared/root.http', '/p/shared/base.http', '/p/api/local.http']);
  const value = (n: string) => [...loaded.variables].reverse().find((v) => v.name === n)?.value;
  assert.equal(value('host'), 'https://base.test'); // base overrides the root it imports
  assert.equal(value('who'), 'local'); // the later import wins
  assert.equal(value('rootOnly'), 'r');
  assert.equal(value('own'), 'users');
  // users.http → base → root → users.http (cycle): users.http is read once.
  assert.equal(host.reads.filter((r) => r === '/p/api/users.http').length, 1);
});

test('loadHttpFile: a missing import names the line and the importing file; no resolveImport → clear error', async () => {
  const host = memoryHost({ '/p/a.http': '# @import ./nope.http\nGET https://x.test\n' });
  await assert.rejects(loadHttpFile(host, '/p/a.http'), /Cannot import \.\/nope\.http from a\.http: \/p\/nope\.http could not be read/);
  const { resolveImport: _ignored, ...noImports } = host;
  await assert.rejects(loadHttpFile(noImports, '/p/a.http'), /imports are not supported here/);
});

test('Executor: variables and a named login from an imported file; the login runs with its own file\'s variables, once', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, data].filter(Boolean).join(' '));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/login' ? JSON.stringify({ token: `t-${JSON.parse(data).user}` }) : JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const host = memoryHost({
      '/p/shared/auth.http': [`@host = ${base}`, '@user = shared-user', '', '### Log in', '# @name login', 'POST {{host}}/login', 'Content-Type: application/json', '', '{"user": "{{user}}"}', ''].join('\n'),
      '/p/api/users.http': ['# @import ../shared/auth.http', '@user = local-user', '', '### Me', '# @assert status == 200', 'GET {{host}}/me', 'Authorization: Bearer {{login.response.body.$.token}}', '', '### Again', 'GET {{host}}/again', 'Authorization: Bearer {{login.response.body.$.token}}', ''].join('\n'),
    });
    const exec = new Executor(host);
    const reqs = parseHttpFile(await host.readHttpFile('/p/api/users.http')).requests;
    const r1 = await exec.run(reqs[0], '/p/api/users.http');
    assert.equal(r1.response.status, 200);
    assert.deepEqual(r1.assertions.map((a) => a.passed), [true]);
    // The imported login used auth.http's own @user, not the importing file's.
    assert.deepEqual(seen, ['POST /login {"user": "shared-user"}', 'GET /me Bearer t-shared-user']);
    await exec.run(reqs[1], '/p/api/users.http');
    assert.equal(seen.length, 3, 'login is remembered for the session, not sent again');
    assert.equal(seen[2], 'GET /again Bearer t-shared-user');
    // resetSession on the importing file forgets the imported login too.
    exec.resetSession('/p/api/users.http');
    await exec.run(reqs[1], '/p/api/users.http');
    assert.deepEqual(seen.slice(3), ['POST /login {"user": "shared-user"}', 'GET /again Bearer t-shared-user']);
    // Copy as code: imported variables resolve without sending anything.
    const before = seen.length;
    const p = await previewRequest(reqs[0], host, '/p/api/users.http');
    assert.equal(p.request.url, `${base}/me`);
    assert.deepEqual(p.unresolved, ['login.response.body.$.token']);
    assert.equal(seen.length, before);
  } finally {
    server.close();
  }
});
