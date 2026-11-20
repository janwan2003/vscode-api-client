// Extension-host driver: exposes a loopback control server so an outside script can run commands.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
exports.run = async function run() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      let out;
      if (u.pathname === '/cmd') {
        const args = u.searchParams.get('args');
        out = await vscode.commands.executeCommand(u.searchParams.get('c'), ...(args ? JSON.parse(args) : []));
      } else if (u.pathname === '/eval') {
        const body = await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
        out = await (new Function('vscode', 'require', `return (async () => { ${body} })()`))(vscode, require);
      }
      res.end(JSON.stringify({ ok: true, out: out === undefined ? null : (() => { try { return JSON.parse(JSON.stringify(out)); } catch { return String(out); } })() }));
    } catch (e) { res.end(JSON.stringify({ ok: false, err: String(e && e.stack || e) })); }
  });
  srv.listen(9444, '127.0.0.1');
  fs.writeFileSync(process.env.SHOT_READY, 'ready');
  await new Promise(() => {});
};
