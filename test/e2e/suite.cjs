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
      if (req.url === '/login') return res.end(JSON.stringify({ token: 'tok-123' }));
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization || null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = vscode.workspace.workspaceFolders[0].uri;
  fs.writeFileSync(path.join(ws.fsPath, 'http-client.env.json'), JSON.stringify({ local: { host: `http://127.0.0.1:${port}`, envName: 'local' } }));

  const ext = vscode.extensions.getExtension('plainwire.plainwire');
  await check('extension activates', async () => {
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.ok(ext.isActive);
  });
  const api = ext.exports;
  const file = vscode.Uri.joinPath(ws, 'api.http');

  await check('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['plainwire.newRequest', 'plainwire.importThunder', 'plainwire.importPostman', 'plainwire.importCurl', 'plainwire.sendAt', 'plainwire.selectEnvironment']) assert.ok(all.includes(c), c);
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

  server.close();
  const report = results.join('\n');
  fs.writeFileSync(process.env.PLAINWIRE_E2E_REPORT, report + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(report);
};
