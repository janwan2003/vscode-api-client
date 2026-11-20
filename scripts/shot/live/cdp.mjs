// Chrome DevTools helper for scripts/shot/live (VS Code started with --remote-debugging-port=9333).
// usage: node cdp.mjs shot out.png | node cdp.mjs eval 'expr' [webview] | node cdp.mjs targets | node cdp.mjs click x y | node cdp.mjs type 'text' | node cdp.mjs key Enter
const [, , op, a1, a2, a3] = process.argv;
const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
if (op === 'targets') { for (const t of targets) console.log(t.type, t.url.slice(0, 160)); process.exit(0); }
const wantWebview = (op === 'eval' && a2) ? a2 : (op !== 'eval' && process.env.WV) || null;
let t;
if (wantWebview) t = targets.filter((x) => x.type === 'iframe' && x.url.includes('vscode-webview') && x.url.includes(wantWebview)).pop();
else t = targets.find((x) => x.type === 'page' && /workbench/.test(x.url));
if (!t) { console.error('no target'); process.exit(2); }
const sock = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => sock.addEventListener('open', r));
let id = 0;
const call = (method, params = {}) => new Promise((res) => {
  const my = ++id;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === my) { sock.removeEventListener('message', on); res(m.result ?? m); } };
  sock.addEventListener('message', on);
  sock.send(JSON.stringify({ id: my, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (op === 'shot') {
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const s = await call('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(a1, Buffer.from(s.data, 'base64'));
  console.log('wrote', a1);
} else if (op === 'eval') {
  let params = { expression: `(async () => (${a1}))()`, returnByValue: true, awaitPromise: true };
  if (wantWebview) {
    // The webview's content lives in a child frame; evaluate in an isolated world there (shares the DOM, bypasses CSP).
    const tree = (await call('Page.getFrameTree')).frameTree;
    const inner = (tree.childFrames || [])[0]?.frame || tree.frame;
    const ctx = await call('Page.createIsolatedWorld', { frameId: inner.id, worldName: 'drv', grantUniveralAccess: true });
    params.contextId = ctx.executionContextId;
  }
  const r = await call('Runtime.evaluate', params);
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 1).slice(0, 4000));
} else if (op === 'click') {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: +a1, y: +a2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
} else if (op === 'sash') {
  // Widen the side bar by dragging its sash to x = a1 (headless windows ignore the resize commands).
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const x0 = (await call('Runtime.evaluate', { expression: "document.querySelector('.part.sidebar').getBoundingClientRect().right", returnByValue: true })).result.value;
  const m = (type, x) => call('Input.dispatchMouseEvent', { type, x, y: 420, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await m('mouseMoved', x0 + 1); await m('mousePressed', x0 + 1);
  for (let x = x0 + 1; x <= +a1; x += 20) await m('mouseMoved', x);
  await m('mouseMoved', +a1); await m('mouseReleased', +a1);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 700, buttons: 0 });
  await sleep(500);
} else if (op === 'type') {
  await call('Input.insertText', { text: a1 });
} else if (op === 'key') {
  const k = { Enter: [13, '\r'], Escape: [27, ''], Tab: [9, '\t'] }[a1];
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: a1, windowsVirtualKeyCode: k[0], text: k[1], modifiers: +(a2 || 0) });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: a1, windowsVirtualKeyCode: k[0], modifiers: +(a2 || 0) });
}
sock.close();
process.exit(0);
