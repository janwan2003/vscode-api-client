// Runs inside VS Code (extension host). Started by scripts/e2e.mjs.
const vscode = require('vscode');
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

exports.run = async function run() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push('ok   ' + name);
    } catch (e) {
      results.push('FAIL ' + name + ': ' + (e && e.stack || e));
    }
  };
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => res.write(`event: tick\ndata: {"i": ${++i}}\n\n`), 15);
        return res.on('close', () => clearInterval(t));
      }
      if (req.url === '/spec.json') return res.end(JSON.stringify({ openapi: '3.0.3', info: { title: 'Url API', version: '1' }, servers: [{ url: 'http://127.0.0.1:1' }], paths: { '/things': { get: { tags: ['things'], operationId: 'listThings', summary: 'List things', responses: { 200: { description: 'ok' } } } } } }));
      if (req.url === '/login') return res.end(JSON.stringify({ token: 'tok-123' }));
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization || null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = vscode.workspace.workspaceFolders[0].uri;
  fs.writeFileSync(path.join(ws.fsPath, 'http-client.env.json'), JSON.stringify({ local: { host: `http://127.0.0.1:${port}`, envName: 'local' } }));

  const ext = vscode.extensions.getExtension('plainbyte.plainwire');
  await check('extension activates', async () => {
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.ok(ext.isActive);
  });
  const api = ext.exports;
  const file = vscode.Uri.joinPath(ws, 'api.http');

  await check('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['plainwire.newRequest', 'plainwire.importThunder', 'plainwire.importPostman', 'plainwire.importOpenApi', 'plainwire.importCurl', 'plainwire.sendAt', 'plainwire.selectEnvironment']) assert.ok(all.includes(c), c);
  });

  await check('.http files get the http language and CodeLenses', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.equal(doc.languageId, 'http');
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file);
    const titles = lenses.map((l) => l.command && l.command.title);
    assert.equal(titles.filter((t) => t === '$(play) Send').length, 2, JSON.stringify(titles));
  });

  await check('environment from http-client.env.json + chained request sends login first', async () => {
    await api.deps.envs.reload();
    assert.deepEqual(api.deps.envs.names(), ['local']);
    await api.deps.envs.select('local');
    const { parseHttpFileForTest } = api;
    const text = fs.readFileSync(file.fsPath, 'utf8');
    const reqs = parseHttpFileForTest(text).requests;
    const { response, resolved } = await api.deps.runner.run(reqs[1], { uri: file });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.map((s) => s.url), ['/login', '/me']);
    assert.equal(seen[0].body, '{"user": "ada"}');
    assert.equal(seen[1].headers.authorization, 'Bearer tok-123');
    assert.equal(seen[1].headers['x-env'], 'local');
    assert.equal(JSON.parse(response.body).auth, 'Bearer tok-123');
    assert.equal(resolved.url, `http://127.0.0.1:${port}/me`);
  });

  await check('Send CodeLens command opens a request panel', async () => {
    await vscode.commands.executeCommand('plainwire.sendAt', { uri: file, index: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.some((t) => t.startsWith('POST Login')), JSON.stringify(tabs));
    assert.ok(seen.length >= 3, 'request was not sent from the panel: ' + seen.length);
  });

  await check('history recorded the sends', async () => {
    const h = api.historyForTest.entries();
    assert.ok(h.length >= 3, String(h.length));
    assert.equal(h[0].response.status, 200);
  });

  await check('Thunder Client import writes .http files', async () => {
    const coll = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'thunder-collection.json'), 'utf8');
    const out = vscode.window.createOutputChannel('t');
    await api.importTextForTest(coll, 'thunder-collection.json', out);
    const files = await vscode.workspace.findFiles('http/**/*.http');
    assert.ok(files.length >= 1, 'no files written');
    const content = fs.readFileSync(files[0].fsPath, 'utf8');
    assert.match(content, /^(GET|POST|PUT|PATCH|DELETE) /m);
  });

  await check('OpenAPI YAML import writes .http + env files and the request sends with $shared baseUrl', async () => {
    const spec = [
      'openapi: 3.0.3',
      'info: { title: E2E Shop, version: "1" }',
      'servers:',
      `  - url: http://127.0.0.1:${port}/v1`,
      'paths:',
      '  /orders:',
      '    get:',
      '      tags: [orders]',
      '      summary: List orders',
      '      operationId: listOrders',
      '      parameters:',
      '        - { name: status, in: query, required: true, schema: { type: string, enum: [open] } }',
      '        - { name: X-Tenant, in: header, required: true, example: acme }',
      "      responses: { '200': { description: ok } }",
      '',
    ].join('\n');
    const out = vscode.window.createOutputChannel('t2');
    await api.importTextForTest(spec, 'shop.yaml', out);
    const files = await vscode.workspace.findFiles('http/E2E Shop/*');
    assert.deepEqual(files.map((f) => path.basename(f.fsPath)).sort(), ['http-client.env.json', 'orders.http']);
    const httpFile = files.find((f) => f.fsPath.endsWith('orders.http'));
    await api.deps.envs.reload();
    const reqs = api.parseHttpFileForTest(fs.readFileSync(httpFile.fsPath, 'utf8')).requests;
    seen.length = 0;
    const { response, assertions } = await api.deps.runner.run(reqs[0], { uri: httpFile });
    assert.equal(response.status, 200);
    assert.equal(seen[0].url, '/v1/orders?status=open');
    assert.equal(seen[0].headers['x-tenant'], 'acme');
    assert.deepEqual(assertions.map((a) => [a.source, a.passed]), [['status == 200', true]]);
  });

  await check('assertions from the .http file are evaluated on send', async () => {
    const reqs = api.parseHttpFileForTest(fs.readFileSync(file.fsPath, 'utf8')).requests;
    const { assertions } = await api.deps.runner.run(reqs[0], { uri: file });
    assert.deepEqual(assertions.map((a) => [a.source, a.passed]), [['status == 200', true], ['$.token exists', true]]);
  });

  await check('GraphQL (X-REQUEST-TYPE: GraphQL) is sent as JSON and copied as cURL with the JSON body', async () => {
    const gql = vscode.Uri.joinPath(ws, 'graphql.http');
    const text = '### Pet\nPOST {{host}}/graphql\nX-REQUEST-TYPE: GraphQL\n\nquery Pet($id: ID!) {\n  pet(id: $id) { id }\n}\n\n{"id": "{{envName}}"}\n';
    fs.writeFileSync(gql.fsPath, text);
    const before = seen.length;
    await api.deps.runner.run(api.parseHttpFileForTest(text).requests[0], { uri: gql });
    const got = seen[before];
    assert.equal(got.url, '/graphql');
    assert.equal(got.headers['content-type'], 'application/json');
    assert.equal(got.headers['x-request-type'], undefined);
    assert.deepEqual(JSON.parse(got.body), { query: 'query Pet($id: ID!) {\n  pet(id: $id) { id }\n}', variables: { id: 'local' }, operationName: 'Pet' });
    await vscode.commands.executeCommand('plainwire.copyCurlAt', { uri: gql, index: 0 });
    const curl = await vscode.env.clipboard.readText();
    assert.ok(curl.includes(`--data-raw '{"query":"query Pet($id: ID!) {\\n  pet(id: $id) { id }\\n}","variables":{"id":"local"},"operationName":"Pet"}'`), curl); // Copy as cURL resolves variables since 0.4.0
    assert.ok(!/X-REQUEST-TYPE/i.test(curl), curl);
    assert.equal(fs.readFileSync(gql.fsPath, 'utf8'), text);
  });

  // HTTPS with a self-signed certificate (needs openssl) on a port Node's fetch refuses (10080).
  let tlsServer;
  let tlsPort = 0;
  try {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pw-tls-'));
    require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    tlsServer = require('https').createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"secure":true}');
    });
    await new Promise((r, j) => { tlsServer.once('error', j); tlsServer.listen(10080, '127.0.0.1', r); });
    tlsPort = 10080;
  } catch (e) {
    results.push('skip self-signed/bad-port checks: ' + (e && e.message));
  }

  await check('Run all: report with pass, fail, skip, self-signed TLS via # @insecure', async () => {
    const checks = vscode.Uri.joinPath(ws, 'checks.http');
    const tls = tlsPort ? `\n### Self-signed on port 10080\n# @insecure\n# @assert $.secure == true\nGET https://127.0.0.1:${tlsPort}/\n\n### Self-signed rejected by default\n# @assert status == 200\nGET https://127.0.0.1:${tlsPort}/\n` : '';
    fs.writeFileSync(checks.fsPath, `### Passing\n# @assert status == 200\n# @assert $.ok == true\nGET {{host}}/a\n\n### Failing\n# @assert $.ok == false\nGET {{host}}/b\n\n### Skipped\n# @skip\nGET {{host}}/c\n${tls}`);
    const summary = await vscode.commands.executeCommand('plainwire.runFile', checks);
    assert.ok(summary, 'runFile returned no summary');
    const expected = tlsPort ? { total: 5, passed: 2, failed: 1, errors: 1, skipped: 1 } : { total: 3, passed: 1, failed: 1, errors: 0, skipped: 1 };
    const { timeMs, ...rest } = summary;
    assert.deepEqual(rest, expected);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.some((t) => t.startsWith('Run: checks.http')), JSON.stringify(tabs));
  });

  await check('# @import: Run all uses a login and variables from another folder; the import path is a link', async () => {
    fs.mkdirSync(path.join(ws.fsPath, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(ws.fsPath, 'imp'), { recursive: true });
    fs.writeFileSync(path.join(ws.fsPath, 'shared', 'auth.http'), '@who = grace\n\n### Log in\n# @name login\nPOST {{host}}/login\nContent-Type: application/json\n\n{"user": "{{who}}"}\n');
    const me = vscode.Uri.joinPath(ws, 'imp', 'me.http');
    fs.writeFileSync(me.fsPath, '# @import ../shared/auth.http\n\n### Me\n# @assert $.auth == Bearer tok-123\nGET {{host}}/me\nAuthorization: Bearer {{login.response.body.$.token}}\n');
    const from = seen.length;
    const summary = await vscode.commands.executeCommand('plainwire.runFile', me);
    const { timeMs, ...rest } = summary;
    assert.deepEqual(rest, { total: 1, passed: 1, failed: 0, errors: 0, skipped: 0 });
    const sent = seen.slice(from);
    assert.deepEqual(sent.map((x) => x.url), ['/login', '/me']);
    assert.equal(sent[0].body, '{"user": "grace"}');
    assert.equal(sent[0].headers['user-agent'], 'plainwire/' + ext.packageJSON.version);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(me));
    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', me);
    assert.ok(links.some((l) => l.target && l.target.fsPath === path.join(ws.fsPath, 'shared', 'auth.http')), JSON.stringify(links.map((l) => l.target && l.target.toString())));
  });

  await check('server-sent events: live events, # @max-events, events checks', async () => {
    const f = vscode.Uri.joinPath(ws, 'sse.http');
    fs.writeFileSync(f.fsPath, '### Ticks\n# @max-events 3\n# @assert events.length == 3\n# @assert events[-1].data.i == 3\nGET {{host}}/sse\n');
    const reqs = api.parseHttpFileForTest(fs.readFileSync(f.fsPath, 'utf8')).requests;
    const live = [];
    const { response, assertions } = await api.deps.runner.run(reqs[0], { uri: f }, undefined, (e) => live.push(e.data));
    assert.equal(response.streamEnd, 'max-events');
    assert.deepEqual(live, ['{"i": 1}', '{"i": 2}', '{"i": 3}']);
    assert.deepEqual(assertions.map((a) => a.passed), [true, true]);
  });

  await check('OpenAPI import from a URL writes .http files', async () => {
    const out = vscode.window.createOutputChannel('u');
    await api.importUrlForTest(`http://127.0.0.1:${port}/spec.json`);
    const files = await vscode.workspace.findFiles('http/**/things*.http');
    assert.ok(files.length >= 1, 'no things.http written');
    assert.match(fs.readFileSync(files[0].fsPath, 'utf8'), /# @name listThings\n(?:#.*\n)*GET \{\{baseUrl\}\}\/things/);
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('plainwire.importOpenApi'));
  });

  await check('CodeLens offers "Run all" on files with several requests', async () => {
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file);
    assert.ok(lenses.some((l) => l.command && /Run all 2 requests \(2 checks\)/.test(l.command.title)), JSON.stringify(lenses.map((l) => l.command && l.command.title)));
  });

  await check('Copy as Code: picker, resolved snippet on the clipboard, last-picked language first', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('plainwire.copyAsCode'));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file);
    assert.equal(lenses.filter((l) => l.command && l.command.command === 'plainwire.copyAsCode').length, 2);
    const pickWith = async (keys) => {
      const p = vscode.commands.executeCommand('plainwire.copyAsCode', { uri: file, index: 1 });
      await new Promise((r) => setTimeout(r, 1000));
      for (const k of keys) await vscode.commands.executeCommand(k);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return p;
    };
    // First item on a fresh profile is cURL. The chained token comes from the login sent earlier.
    const curl = await pickWith([]);
    assert.equal(await vscode.env.clipboard.readText(), curl);
    assert.ok(curl.startsWith(`curl http://127.0.0.1:${port}/me`), curl);
    assert.ok(curl.includes("-H 'Authorization: Bearer tok-123'") && curl.includes("-H 'X-Env: local'"), curl);
    // Pick the second language (JavaScript); next time it is listed first.
    const js = await pickWith(['workbench.action.quickOpenSelectNext']);
    assert.ok(js.includes(`await fetch("http://127.0.0.1:${port}/me"`), js);
    const again = await pickWith([]);
    assert.equal(again, js);
    // Direct call with a language id.
    const py = await vscode.commands.executeCommand('plainwire.copyAsCode', { uri: file, index: 0 }, 'python-requests');
    assert.ok(py.includes(`url = "http://127.0.0.1:${port}/login"`) && py.includes('requests.post(url'), py);
  });

  if (tlsServer) tlsServer.close();
  server.close();
  const report = results.join('\n');
  fs.writeFileSync(process.env.PLAINWIRE_E2E_REPORT, report + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(report);
};
