// Render the Run-all report webview with sample data: node scripts/shot/run-all.mjs, then screenshot /tmp/pw-shot/run.html.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
const out = await build({ entryPoints: ['src/ext/runAll.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error', alias: { vscode: './scripts/shot/vscode-stub.mjs' } });
writeFileSync('/tmp/pw-shot/runAll.mjs', out.outputFiles[0].text);
const stub = await import('./vscode-stub.mjs');
const mod = await import('/tmp/pw-shot/runAll.mjs');
// Construct the panel (private ctor) via run() with no files; html is captured by the stub.
const runner = { resetSession() {}, run() {} };
await mod.RunAllPanel.run(runner, [], 'http/shop.http', () => {});
let html = stub.captured.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const rows = [
  ['POST', 'Log in', 'pass', 200, 64, [['status == 200', true], ['$.token exists', true]]],
  ['POST', 'Create product', 'pass', 201, 112, [['status == 201', true], ['$.id isNumber', true], ['$.price == 19.99', true]]],
  ['GET', 'Get product', 'pass', 200, 38, [['$.name == "Desk lamp"', true]]],
  ['GET', 'Search products', 'fail', 200, 241, [['$.items.length > 0', false, 'expected > 0, got 0'], ['time < 200', false, 'expected < 200, got 241']]],
  ['DELETE', 'Delete product', 'pass', 204, 41, []],
  ['GET', 'Legacy export', 'skipped', undefined, undefined, []],
].map(([method, label, state, status, timeMs, a], index) => ({ file: 'http/shop.http', uri: 'f', index, method, label, state, status, timeMs, assertions: a.map(([source, passed, message]) => ({ source, passed, message: message || 'passed' })) }));
const state = { type: 'state', title: 'http/shop.http', running: false, rows, summary: { total: 6, passed: 4, failed: 1, errors: 0, skipped: 1, timeMs: 512 } };
const vars = `:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:"DejaVu Sans Mono",monospace;--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-panel-border:#2b2b2b;--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f14c4c;--vscode-list-hoverBackground:#2a2d2e}`;
html = html.replace('<head>', `<head><style>${vars}</style><script>window.acquireVsCodeApi=()=>({postMessage(m){ if(m.type==='ready') setTimeout(()=>window.postMessage(${JSON.stringify(state)},'*'),10); }});</script>`);
writeFileSync('/tmp/pw-shot/run.html', html);
