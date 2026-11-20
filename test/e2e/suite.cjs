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
      if (req.url === '/session-login') {
        res.writeHead(302, { location: '/session', 'set-cookie': 'sid=e2e-sid; Path=/; HttpOnly' });
        return res.end('{}');
      }
      if (req.url === '/session') {
        const ok = /(?:^|; )sid=e2e-sid(?:;|$)/.test(req.headers.cookie || '');
        res.statusCode = ok ? 200 : 401;
        return res.end(JSON.stringify({ ok, cookie: req.headers.cookie || null }));
      }
      if (req.url === '/oauth/token') {
        const p = new URLSearchParams(body);
        const basic = 'Basic ' + Buffer.from('e2e-client:e2e-secret').toString('base64');
        if (p.get('grant_type') !== 'client_credentials' || req.headers.authorization !== basic) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: 'invalid_client' }));
        }
        oauthIssued++;
        return res.end(JSON.stringify({ access_token: `e2e-at-${oauthIssued}`, token_type: 'Bearer', expires_in: 600 }));
      }
      if (req.url === '/oauth/me') {
        const ok = /^Bearer e2e-at-\d+$/.test(req.headers.authorization || '');
        res.statusCode = ok ? 200 : 401;
        return res.end(JSON.stringify({ ok, auth: req.headers.authorization || null }));
      }
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization || null }));
    });
  });
  // Minimal RFC 6455 echo for the WebSocket check: replies "echo:<text>" to each (masked) client text frame.
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = require('crypto').createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (op, payload) => Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]);
    let buf = Buffer.alloc(0);
    socket.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 6) {
        const len = buf[1] & 0x7f; // short test messages only
        if (buf.length < 6 + len) break;
        const mask = buf.subarray(2, 6);
        const data = Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ mask[i & 3]);
        const op = buf[0] & 0x0f;
        buf = buf.subarray(6 + len);
        if (op === 8) { socket.end(frame(8, data.subarray(0, 2))); return; }
        if (op === 1 && socket.writable) socket.write(frame(1, Buffer.from('echo:' + Buffer.from(data).toString())));
      }
    });
    socket.on('error', () => {});
  });
  let oauthIssued = 0;
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

  await check('WebSocket: WEBSOCKET request with === and wait-for-server, live messages, done, checks on messages', async () => {
    const f = vscode.Uri.joinPath(ws, 'socket.http');
    fs.writeFileSync(f.fsPath, '### Echo\n# @assert status == 101\n# @assert messages.length == 2\n# @assert messages[-1].data == echo:two {{envName}}\nWEBSOCKET {{host}}/ws\n\none\n===\ntwo {{envName}}\n=== wait-for-server\n=== wait-for-server\n');
    const reqs = api.parseHttpFileForTest(fs.readFileSync(f.fsPath, 'utf8')).requests;
    const live = [];
    const { response, assertions } = await api.deps.runner.run(reqs[0], { uri: f }, undefined, (e) => live.push(e.event + ' ' + e.data));
    assert.equal(response.status, 101);
    assert.equal(response.streamEnd, 'done');
    assert.deepEqual(live, ['sent one', 'sent two local', 'message echo:one', 'message echo:two local']);
    assert.deepEqual(assertions.map((a) => a.passed), [true, true, true]);
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

  await check('cookies: a login\'s session cookie (set on a redirect) is sent by later requests, kept per workspace, off by setting; Clear Cookies', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['plainwire.manageCookies', 'plainwire.clearCookies']) assert.ok(all.includes(c), c);
    const f = vscode.Uri.joinPath(ws, 'session.http');
    fs.writeFileSync(f.fsPath, '### Log in\n# @assert status == 200\nPOST {{host}}/session-login\n\n### Session\n# @assert $.ok == true\nGET {{host}}/session\n\n### No jar\n# @no-cookie-jar\n# @assert status == 401\nGET {{host}}/session\n');
    const summary = await vscode.commands.executeCommand('plainwire.runFile', f);
    const { timeMs, ...rest } = summary;
    assert.deepEqual(rest, { total: 3, passed: 3, failed: 0, errors: 0, skipped: 0 });
    const jar = api.cookiesForTest.jar;
    assert.equal(jar.cookieHeader(`http://127.0.0.1:${port}/x`), 'sid=e2e-sid');
    // Saved in workspace state, so it survives a window reload.
    const saved = api.cookiesForTest.state.get('plainwire.cookies');
    assert.deepEqual(saved.map((c) => `${c.name}=${c.value} ${c.domain}${c.path}`), ['sid=e2e-sid 127.0.0.1/']);
    // plainwire.rememberCookies = false: nothing sent.
    const cfg = vscode.workspace.getConfiguration('plainwire');
    await cfg.update('rememberCookies', false, vscode.ConfigurationTarget.Workspace);
    const reqs = api.parseHttpFileForTest(fs.readFileSync(f.fsPath, 'utf8')).requests;
    const off = await api.deps.runner.run(reqs[1], { uri: f });
    assert.equal(off.response.status, 401);
    await cfg.update('rememberCookies', undefined, vscode.ConfigurationTarget.Workspace);
    const on = await api.deps.runner.run(reqs[1], { uri: f });
    assert.equal(on.response.status, 200);
    assert.equal(on.response.sentCookie, 'sid=e2e-sid');
    await vscode.commands.executeCommand('plainwire.clearCookies');
    assert.equal(jar.size, 0);
    assert.equal((await api.deps.runner.run(reqs[1], { uri: f })).response.status, 401);
  });

  await check('scripts: > {% %} handler sets client.global for the next request, < {% %} sets request variables; saved per workspace; plainwire.runScripts off', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('plainwire.clearScriptVariables'));
    const f = vscode.Uri.joinPath(ws, 'scripts.http');
    fs.writeFileSync(f.fsPath, [
      '### Login', 'POST {{host}}/login', '', '> {%',
      '  client.test("has token", () => client.assert(response.body.token === "tok-123", "token " + response.body.token));',
      '  client.global.set("tok", response.body.token);', '%}', '',
      '### Me', '< {% request.variables.set("who", "e2e-" + request.method) %}', 'GET {{host}}/me-script', 'Authorization: Bearer {{tok}}', 'X-Who: {{who}}', '',
      '> {% client.test("auth echoed", () => client.assert(response.body.auth === "Bearer tok-123", response.body.auth)); client.log("auth=" + response.body.auth) %}', '',
    ].join('\n'));
    const summary = await vscode.commands.executeCommand('plainwire.runFile', f);
    const { timeMs, ...rest } = summary;
    assert.deepEqual(rest, { total: 2, passed: 2, failed: 0, errors: 0, skipped: 0 });
    const me = seen.filter((x) => x.url === '/me-script').at(-1);
    assert.equal(me.headers['x-who'], 'e2e-GET');
    assert.equal(me.headers.authorization, 'Bearer tok-123');
    assert.deepEqual(api.cookiesForTest.state.get('plainwire.scriptGlobals'), [['tok', 'tok-123']]);
    const reqs = api.parseHttpFileForTest(fs.readFileSync(f.fsPath, 'utf8')).requests;
    const r = await api.deps.runner.run(reqs[1], { uri: f });
    assert.deepEqual(r.assertions.map((a) => [a.source, a.passed]), [['auth echoed', true]]);
    assert.deepEqual(r.logs, ['auth=Bearer tok-123']);
    const cfg = vscode.workspace.getConfiguration('plainwire');
    await cfg.update('runScripts', false, vscode.ConfigurationTarget.Workspace);
    api.deps.runner.globals.clear();
    const off = await api.deps.runner.run(reqs[0], { uri: f });
    assert.deepEqual(off.assertions, []);
    assert.equal(api.deps.runner.globals.size, 0);
    await cfg.update('runScripts', undefined, vscode.ConfigurationTarget.Workspace);
  });

  await check('OAuth 2: {{$auth.token("id")}} from Security.Auth (secret in the private env file), token reused; Acquire / Clear commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['plainwire.acquireOAuthToken', 'plainwire.clearOAuthTokens']) assert.ok(all.includes(c), c);
    const priv = path.join(ws.fsPath, 'http-client.private.env.json');
    fs.writeFileSync(priv, JSON.stringify({ local: { Security: { Auth: { e2e: { 'Client Secret': 'e2e-secret' } } } } }));
    const pub = path.join(ws.fsPath, 'http-client.env.json');
    const envJson = JSON.parse(fs.readFileSync(pub, 'utf8'));
    envJson.local.Security = { Auth: { e2e: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': '{{host}}/oauth/token', 'Client ID': 'e2e-client' } } };
    fs.writeFileSync(pub, JSON.stringify(envJson));
    await api.deps.envs.reload();
    await api.deps.envs.select('local');
    const f = vscode.Uri.joinPath(ws, 'oauth.http');
    fs.writeFileSync(f.fsPath, '### Me\n# @assert status == 200\nGET {{host}}/oauth/me\nAuthorization: Bearer {{$auth.token("e2e")}}\n\n### Again\n# @assert $.ok == true\nGET {{host}}/oauth/me?again=1\nAuthorization: Bearer {{$auth.token("e2e")}}\n');
    const summary = await vscode.commands.executeCommand('plainwire.runFile', f);
    const { timeMs, ...rest } = summary;
    assert.deepEqual(rest, { total: 2, passed: 2, failed: 0, errors: 0, skipped: 0 });
    assert.equal(oauthIssued, 1, 'one token for both requests');
    const t = await vscode.commands.executeCommand('plainwire.acquireOAuthToken', 'e2e');
    assert.ok(t && t.expiresAt > Date.now(), JSON.stringify(t));
    assert.equal(oauthIssued, 2, 'Acquire forces a new token');
    assert.equal(api.oauth2ForTest.size, 1);
    await vscode.commands.executeCommand('plainwire.clearOAuthTokens');
    assert.equal(api.oauth2ForTest.size, 0);
    const reqs = api.parseHttpFileForTest(fs.readFileSync(f.fsPath, 'utf8')).requests;
    const r = await api.deps.runner.run(reqs[0], { uri: f });
    assert.equal(r.response.status, 200);
    assert.equal(oauthIssued, 3, 'signs in again after Clear');
    // The env-file schema is contributed for both env files.
    const jv = ext.packageJSON.contributes.jsonValidation;
    assert.ok(jv.some((j) => j.fileMatch.includes('http-client.private.env.json')), JSON.stringify(jv));
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

  await check('Edit Environments: opens the editor, saves secrets to the private file, keeps Security objects, environments reload', async () => {
    const until = async (what, fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (!(await fn())) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('plainwire.editEnvironments'));
    const pubPath = path.join(ws.fsPath, 'http-client.env.json');
    const privPath = path.join(ws.fsPath, 'http-client.private.env.json');
    const security = { Auth: { 'my-oauth': { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': `http://127.0.0.1:${port}/token`, Scope: ['read', 'write'], PKCE: true } } };
    const original = { $schema: 'https://example.com/env.schema.json', local: { host: `http://127.0.0.1:${port}`, envName: 'local', Security: security, retries: 3 } };
    fs.writeFileSync(pubPath, JSON.stringify(original));
    // Start without a private file (the OAuth check above leaves one with a Security block).
    fs.rmSync(privPath, { force: true });
    fs.writeFileSync(path.join(ws.fsPath, '.gitignore'), 'node_modules/');
    await vscode.commands.executeCommand('plainwire.editEnvironments');
    const panel = api.envEditorForTest();
    assert.ok(panel, 'no editor panel');
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.includes('Environments'), JSON.stringify(tabs));
    // The webview script ran (CSP + nonce + media paths are right) and asked for its data.
    await until('webview ready', () => panel.readyCount > 0);
    // Several folders have an http-client.env.json (root + the OpenAPI import); edit the root pair.
    await panel.handle({ type: 'folder', value: ws.toString() });
    const local = panel.model.envs.find((e) => e.name === 'local');
    assert.deepEqual(local.vars.map((v) => `${v.name}:${v.readonly || 'string'}`), ['host:string', 'envName:string', 'Security:object', 'retries:number']);
    // Saving without edits writes nothing.
    assert.deepEqual(await panel.handle({ type: 'save', model: panel.model }), { wrote: [] });
    assert.equal(fs.readFileSync(pubPath, 'utf8'), JSON.stringify(original));
    // Edit like the form does: a secret in "local", a new environment, a shared variable.
    const model = JSON.parse(JSON.stringify(panel.model));
    model.envs.find((e) => e.name === 'local').vars.push({ name: 'apiKey', value: 'k-123', secret: true });
    model.envs.push({ name: 'qa', vars: [{ name: 'host', value: 'https://qa.example.com', secret: false }] });
    model.envs.unshift({ name: '$shared', vars: [{ name: 'tenant', value: 'acme', secret: false }] });
    const changedBefore = new Promise((r) => { const d = api.deps.envs.onDidChange(() => { d.dispose(); r(); }); });
    const r = await panel.handle({ type: 'save', model });
    assert.deepEqual(r.wrote.sort(), ['http-client.env.json', 'http-client.private.env.json']);
    const pubText = fs.readFileSync(pubPath, 'utf8');
    assert.ok(pubText.endsWith('}\n') && pubText.includes('\n  "local": {\n    "host"'), pubText);
    const pub = JSON.parse(pubText);
    assert.deepEqual(Object.keys(pub), ['$schema', 'local', '$shared', 'qa']);
    assert.deepEqual(pub.local, original.local);
    assert.deepEqual(Object.keys(pub.local), ['host', 'envName', 'Security', 'retries']);
    assert.deepEqual(JSON.parse(fs.readFileSync(privPath, 'utf8')), { local: { apiKey: 'k-123' } });
    // The EnvironmentManager picks the change up through its file watcher (no explicit reload here).
    await Promise.race([changedBefore, new Promise((_, j) => setTimeout(() => j(new Error('EnvironmentManager did not reload')), 8000))]);
    await until('environments reloaded', () => api.deps.envs.names().includes('qa') && api.deps.envs.variables().apiKey === 'k-123');
    assert.equal(api.deps.envs.selected, 'local');
    assert.equal(api.deps.envs.variables().tenant, 'acme');
    // The private file is not git-ignored yet: one click adds it.
    await panel.handle({ type: 'addGitignore' });
    assert.equal(fs.readFileSync(path.join(ws.fsPath, '.gitignore'), 'utf8').split('\n').filter((l) => l === 'http-client.private.env.json').length, 1);
    // Changed on disk while there are unsaved edits: Save refuses (the webview shows Reload / Overwrite) until forced.
    await panel.handle({ type: 'dirty', dirty: true });
    const external = { ...pub, qa: { host: 'https://edited-elsewhere' } };
    fs.writeFileSync(pubPath, JSON.stringify(external, null, 2) + '\n');
    const blocked = await panel.handle({ type: 'save', model: panel.model });
    assert.equal(blocked, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(pubPath, 'utf8')), external);
    // Not dirty: an external change reloads the editor.
    await panel.handle({ type: 'dirty', dirty: false });
    await panel.handle({ type: 'reload' });
    assert.equal(panel.model.envs.find((e) => e.name === 'qa').vars[0].value, 'https://edited-elsewhere');
    fs.writeFileSync(pubPath, JSON.stringify({ ...external, qa: { host: 'https://third' } }, null, 2) + '\n');
    await until('editor reloaded from disk', () => panel.model.envs.find((e) => e.name === 'qa').vars[0].value === 'https://third');
    // The status-bar environment picker's last item opens the editor.
    panel.dispose();
    assert.equal(api.envEditorForTest(), undefined);
    const envTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === 'Environments').length;
    await until('editor tab closed', () => envTabs() === 0);
    const picking = vscode.commands.executeCommand('plainwire.selectEnvironment');
    await new Promise((r) => setTimeout(r, 1000));
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectPrevious'); // wraps to the last item
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await picking;
    await until('editor opened from the picker', () => api.envEditorForTest());
    assert.equal(api.deps.envs.selected, 'local');
  });

  await check('Collections: folders in the tree, drag requests between files and within one, duplicate, Move Up, move a file into a folder', async () => {
    const api = vscode.extensions.getExtension('plainbyte.plainwire').exports;
    const ws = vscode.workspace.workspaceFolders[0].uri;
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ws.fsPath, rel)), { recursive: true }); fs.writeFileSync(path.join(ws.fsPath, rel), text); };
    const read = (rel) => fs.readFileSync(path.join(ws.fsPath, rel), 'utf8');
    write('shop/orders.http', '@h = http://x\n\n### List orders\nGET {{h}}/orders\n\n### Create order\n# @name create\nPOST {{h}}/orders\nContent-Type: application/json\n\n{"a": 1}\n\n### Order by id\nGET {{h}}/orders/{{create.response.body.$.id}}\n');
    write('shop/admin/users.http', '### Users\nGET http://x/users\n');
    write('loose.http', '### Loose\nGET http://x/loose\n');
    const tree = api.collectionsForTest;
    tree.refresh();
    await new Promise((r) => setTimeout(r, 500));
    const label = (n) => tree.getTreeItem(n).label;
    const top = await tree.getChildren();
    const shop = top.find((n) => label(n) === 'shop');
    assert.ok(shop, 'shop folder at the top: ' + top.map(label).join(', '));
    assert.equal(tree.getTreeItem(shop).contextValue, 'plainwire.folder');
    assert.ok(top.some((n) => label(n) === 'loose.http' && tree.getTreeItem(n).contextValue === 'plainwire.file'));
    const inShop = await tree.getChildren(shop);
    assert.deepEqual(inShop.map(label), ['admin', 'orders.http']);
    const orders = inShop[1];
    const reqs = await tree.getChildren(orders);
    assert.deepEqual(reqs.map(label), ['List orders', 'Create order', 'Order by id']);
    // Drag "Create order" onto users.http (append there).
    const users = (await tree.getChildren(inShop[0]))[0];
    const dt = new vscode.DataTransfer();
    api.organizerForTest.handleDrag([reqs[1]], dt);
    await api.organizerForTest.handleDrop(users, dt);
    assert.equal(read('shop/admin/users.http'), '### Users\nGET http://x/users\n\n### Create order\n# @name create\nPOST {{h}}/orders\nContent-Type: application/json\n\n{"a": 1}\n');
    assert.equal(read('shop/orders.http'), '@h = http://x\n\n### List orders\nGET {{h}}/orders\n\n### Order by id\nGET {{h}}/orders/{{create.response.body.$.id}}\n');
    // Drag "List orders" down onto "Order by id": it lands after it.
    const reqs2 = await tree.getChildren(orders);
    const dt2 = new vscode.DataTransfer();
    api.organizerForTest.handleDrag([reqs2[0]], dt2);
    await api.organizerForTest.handleDrop(reqs2[1], dt2);
    assert.deepEqual((await tree.getChildren(orders)).map(label), ['Order by id', 'List orders']);
    assert.ok(read('shop/orders.http').startsWith('@h = http://x\n\n### Order by id\n'));
    // Duplicate and Move Up through the commands, as the context menu runs them.
    await vscode.commands.executeCommand('plainwire.duplicateRequest', (await tree.getChildren(orders))[1]);
    assert.deepEqual((await tree.getChildren(orders)).map(label), ['Order by id', 'List orders', 'List orders (copy)']);
    await vscode.commands.executeCommand('plainwire.moveUp', (await tree.getChildren(orders))[2]);
    assert.deepEqual((await tree.getChildren(orders)).map(label), ['Order by id', 'List orders (copy)', 'List orders']);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Drag loose.http onto the admin folder: the file moves.
    const loose = (await tree.getChildren()).find((n) => label(n) === 'loose.http');
    const dt3 = new vscode.DataTransfer();
    api.organizerForTest.handleDrag([loose], dt3);
    assert.ok(dt3.get('text/uri-list'), 'files can also be dropped into editors');
    await api.organizerForTest.handleDrop(inShop[0], dt3);
    assert.ok(fs.existsSync(path.join(ws.fsPath, 'shop/admin/loose.http')));
    assert.ok(!fs.existsSync(path.join(ws.fsPath, 'loose.http')));
    tree.refresh();
    await new Promise((r) => setTimeout(r, 500));
    const admin = (await tree.getChildren((await tree.getChildren()).find((n) => label(n) === 'shop')))[0];
    assert.deepEqual((await tree.getChildren(admin)).map(label), ['loose.http', 'users.http']);
  });

  if (tlsServer) tlsServer.close();
  server.close();
  const report = results.join('\n');
  fs.writeFileSync(process.env.PLAINWIRE_E2E_REPORT, report + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(report);
};
