import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bodyFileRef, Executor, markdownReport, normalizeBasicAuth, requestLabel, rowState, summarize } from '../src/core/exec.ts';

test('bodyFileRef: only a body that is exactly one < or <@ line', () => {
  assert.deepEqual(bodyFileRef('< ./a.json'), { path: './a.json', resolveVariables: false });
  assert.deepEqual(bodyFileRef('<@ ./a.json\n\n'), { path: './a.json', resolveVariables: true });
  assert.equal(bodyFileRef('< ./a.json\nmore'), undefined);
  assert.equal(bodyFileRef('{"a": 1}'), undefined);
  assert.equal(bodyFileRef(undefined), undefined);
});

test('normalizeBasicAuth: user:pass and "user pass" are encoded, base64 left alone', () => {
  const req = { method: 'GET', url: 'x', headers: [{ name: 'Authorization', value: 'Basic ada:secret' }, { name: 'authorization', value: 'Basic ada secret' }, { name: 'Authorization', value: 'Basic YWRhOnNlY3JldA==' }] };
  normalizeBasicAuth(req);
  assert.deepEqual(req.headers.map((h) => h.value), ['Basic YWRhOnNlY3JldA==', 'Basic YWRhOnNlY3JldA==', 'Basic YWRhOnNlY3JldA==']);
});

test('requestLabel, rowState, summarize, markdownReport escapes pipes', () => {
  assert.equal(requestLabel({ method: 'GET', url: '{{base}}/users?x=1', headers: [] }), '/users?x=1');
  assert.equal(requestLabel({ method: 'GET', url: 'https://a.b/c', headers: [], name: 'n' }), 'n');
  assert.equal(rowState(404, []), 'fail');
  assert.equal(rowState(404, [{ source: 'status == 404', passed: true, message: '' }]), 'pass');
  const rows = [{ file: 'a.http', index: 0, method: 'GET', label: 'a|b', state: 'pass' as const, status: 200, timeMs: 3, assertions: [] }];
  const s = summarize(rows, 3);
  assert.deepEqual(s, { total: 1, passed: 1, failed: 0, errors: 0, skipped: 0, timeMs: 3 });
  assert.match(markdownReport('t', rows, s), /GET a\\\|b \(a\.http\)/);
});

test('Executor: a request named only in an @assert line is sent first', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ n: req.url === '/count' ? 2 : 0, items: [1, 2] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = `# @name count\nGET ${base}/count\n\n###\n# @assert $.items.length == {{count.response.body.$.n}}\nGET ${base}/items\n`;
  const exchanges: string[] = [];
  const exec = new Executor({
    readHttpFile: async () => file,
    readBodyFile: async () => new Uint8Array(),
    dotenv: async () => ({}),
    environment: () => ({}),
    sendOptions: () => ({ timeoutMs: 5000 }),
    onExchange: (e) => void exchanges.push(`${e.request.url} ${e.response?.status}`),
  });
  try {
    const { parseHttpFile } = await import('../src/core/httpFile.ts');
    const r = await exec.run(parseHttpFile(file).requests[1], 'f.http');
    assert.deepEqual(hits, ['/count', '/items']);
    assert.equal(exchanges.length, 2);
    assert.equal(r.assertions[0].passed, true, r.assertions[0].message);
  } finally {
    server.close();
  }
});
