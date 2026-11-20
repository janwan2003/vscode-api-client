// Screenshot of the real Collections sidebar: VS Code runs headless (Ozone) with a DevTools port,
// sidebar-driver.cjs expands the tree, and Page.captureScreenshot saves docs/collections.png.
// Usage: node scripts/shot/sidebar.mjs /snap/code/current/usr/share/code/code
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const code = process.argv[2] || 'code';
const root = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'plainwire-shot-'));
const ws = join(tmp, 'ws');
const files = {
  'shop-api/auth.http': '@baseUrl = {{host}}/v1\n\n### Log in\n# @name login\nPOST {{baseUrl}}/auth/login\nContent-Type: application/json\n\n{"email": "{{email}}", "password": "{{password}}"}\n\n### Refresh token\nPOST {{baseUrl}}/auth/refresh\n',
  'shop-api/orders/orders.http': '### List orders\nGET {{host}}/v1/orders?status=open\n\n### Create order\nPOST {{host}}/v1/orders\nContent-Type: application/json\n\n{"sku": "A-100", "qty": 2}\n\n### Cancel order\nDELETE {{host}}/v1/orders/42\n',
  'shop-api/orders/refunds.http': '### List refunds\nGET {{host}}/v1/refunds\n\n### Refund an order\n# @name refund\n# @assert status == 201\nPOST {{host}}/v1/orders/42/refund\nAuthorization: Bearer {{login.response.body.$.token}}\nContent-Type: application/json\n\n{"amount": 1999, "reason": "damaged"}\n\n### Refund status\nGET {{host}}/v1/refunds/{{refund.response.body.$.id}}\n',
  'shop-api/users.http': '### Me\nGET {{host}}/v1/me\n\n### Update profile\nPATCH {{host}}/v1/me\n',
  'shop-api/admin/reports.http': '### Daily sales\nGET {{host}}/v1/admin/reports/daily\n',
  'shop-api/http-client.env.json': JSON.stringify({ dev: { host: 'http://localhost:3000' }, staging: { host: 'https://staging.example.com' } }, null, 2),
  'webhooks.http': '### Ping\nPOST {{host}}/hooks/ping\n',
};
for (const [p, c] of Object.entries(files)) {
  mkdirSync(dirname(join(ws, p)), { recursive: true });
  writeFileSync(join(ws, p), c);
}
mkdirSync(join(tmp, 'user/User'), { recursive: true });
writeFileSync(join(tmp, 'user/User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'window.zoomLevel': 0, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.commandCenter.enabled': false, 'workbench.tips.enabled': false, 'workbench.tree.enableStickyScroll': false, 'extensions.ignoreRecommendations': true }));
const ready = join(tmp, 'ready');
const done = join(tmp, 'done');
const port = 9333;
const proc = spawn(code, [ws, '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + join(root, 'scripts/shot/sidebar-driver.cjs'),
  '--user-data-dir=' + join(tmp, 'user'), '--extensions-dir=' + join(tmp, 'ext'), '--disable-extensions', '--disable-gpu', '--no-sandbox',
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--ozone-platform=headless', '--window-size=1280,760', `--remote-debugging-port=${port}`],
  { env: { ...process.env, SHOT_READY: ready, SHOT_DONE: done, DONT_PROMPT_WSL_INSTALL: '1' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 600 && !existsSync(ready); i++) await sleep(100);
await sleep(2500);
if (!existsSync(ready)) { console.error('driver failed:', existsSync(ready + '.log') ? (await import('node:fs')).readFileSync(ready + '.log', 'utf8') : '(no log)'); proc.kill(); process.exit(1); }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url));
const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => sock.addEventListener('open', r));
let id = 0;
const call = (method, params = {}) => new Promise((res) => {
  const my = ++id;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === my) { sock.removeEventListener('message', on); res(m.result); } };
  sock.addEventListener('message', on);
  sock.send(JSON.stringify({ id: my, method, params }));
});
await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
await sleep(800);
// Widen the sidebar by dragging its sash (headless windows ignore the resize commands).
const sashX = (await call('Runtime.evaluate', { expression: "(() => { const s = document.querySelector('.part.sidebar'); const r = s.getBoundingClientRect(); return r.right; })()", returnByValue: true })).result.value;
const mouse = (type, x) => call('Input.dispatchMouseEvent', { type, x, y: 420, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await mouse('mouseMoved', sashX + 1);
await mouse('mousePressed', sashX + 1);
for (let x = sashX + 1; x <= 340; x += 20) await mouse('mouseMoved', x);
await mouse('mouseMoved', 340);
await mouse('mouseReleased', 340);
await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 200, deltaX: 0, deltaY: -600 });
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600, buttons: 0 });
await sleep(1200);
const shot = await call('Page.captureScreenshot', { format: 'png' });
const out = process.argv[3] || join(root, 'docs/collections.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('wrote', out);
writeFileSync(done, 'done');
sock.close();
await sleep(1500);
proc.kill();
rmSync(tmp, { recursive: true, force: true });
