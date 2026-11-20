import * as vscode from 'vscode';
import { markdownReport, rowState, summarize, type RunRow as CoreRunRow, type RunSummary } from '../core/exec.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import type { ParsedRequest } from '../core/model.ts';
import { readText, type Runner } from './runner.ts';
import { requestLabel } from './tree.ts';

/** One row in the run report; `uri` lets the report open the request. */
export interface RunRow extends CoreRunRow {
  uri: string;
}

export { rowState, summarize, type RunSummary } from '../core/exec.ts';

/** Collect the .http/.rest files to run from whatever the command was invoked on. */
export async function filesFor(target: unknown): Promise<vscode.Uri[]> {
  const asUri = (x: unknown): vscode.Uri | undefined => (x instanceof vscode.Uri ? x : x && typeof x === 'object' && 'uri' in x && (x as { uri: unknown }).uri instanceof vscode.Uri ? (x as { uri: vscode.Uri }).uri : undefined);
  let uri = asUri(target);
  if (!uri && target === undefined) {
    const ed = vscode.window.activeTextEditor;
    if (ed && /\.(http|rest)$/i.test(ed.document.uri.path)) uri = ed.document.uri;
  }
  if (uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.{http,rest}'), '**/node_modules/**', 1000);
      return found.sort((a, b) => a.path.localeCompare(b.path));
    }
    return [uri];
  }
  const all = await vscode.workspace.findFiles('**/*.{http,rest}', '**/node_modules/**', 1000);
  return all.sort((a, b) => a.path.localeCompare(b.path));
}

/** The "Run all" report tab: runs every request in the given files in order and shows pass/fail. */
export class RunAllPanel {
  private static current?: RunAllPanel;
  private readonly panel: vscode.WebviewPanel;
  private rows: RunRow[] = [];
  private files: vscode.Uri[] = [];
  private title = '';
  private running = false;
  private cts?: vscode.CancellationTokenSource;
  private started = 0;
  private elapsed = 0;

  static async run(runner: Runner, files: vscode.Uri[], title: string, open: (uri: vscode.Uri, index: number) => void): Promise<RunSummary> {
    const p = RunAllPanel.current ?? new RunAllPanel(runner, open);
    RunAllPanel.current = p;
    p.panel.reveal(undefined, false);
    p.files = files;
    p.title = title;
    return p.start();
  }

  private constructor(
    private readonly runner: Runner,
    private readonly open: (uri: vscode.Uri, index: number) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel('plainwire.runAll', 'Plainwire: Run', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      this.cts?.cancel();
      if (RunAllPanel.current === this) RunAllPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((m: { type: string; uri?: string; index?: number }) => {
      if (m.type === 'stop') this.cts?.cancel();
      else if (m.type === 'rerun' && !this.running) void this.start();
      else if (m.type === 'rerunFailed' && !this.running) void this.start(true);
      else if (m.type === 'open' && m.uri !== undefined && m.index !== undefined) this.open(vscode.Uri.parse(m.uri), m.index);
      else if (m.type === 'copy') void vscode.env.clipboard.writeText(this.markdown()).then(() => vscode.window.setStatusBarMessage('$(check) Copied run report', 2500));
      else if (m.type === 'ready') this.post();
    });
  }

  private async start(onlyFailed = false): Promise<RunSummary> {
    const failedKeys = new Set(this.rows.filter((r) => r.state === 'fail' || r.state === 'error').map((r) => `${r.uri}#${r.index}`));
    const plan: { uri: vscode.Uri; req: ParsedRequest; index: number }[] = [];
    for (const uri of this.files) {
      let reqs: ParsedRequest[] = [];
      try {
        reqs = parseHttpFile(await readText(uri)).requests;
      } catch {
        continue;
      }
      reqs.forEach((req, index) => {
        if (!onlyFailed || failedKeys.has(`${uri.toString()}#${index}`)) plan.push({ uri, req, index });
      });
    }
    this.rows = plan.map(({ uri, req, index }) => ({
      file: vscode.workspace.asRelativePath(uri),
      uri: uri.toString(),
      index,
      method: req.method,
      label: requestLabel(req),
      state: req.meta && 'skip' in req.meta ? 'skipped' : 'pending',
      assertions: [],
    }));
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.running = true;
    this.started = Date.now();
    this.panel.title = `Run: ${this.title}`;
    for (const f of this.files) this.runner.resetSession(f);
    this.post();
    for (let i = 0; i < plan.length; i++) {
      const row = this.rows[i];
      if (row.state === 'skipped') continue;
      if (cts.token.isCancellationRequested) {
        row.state = 'skipped';
        row.error = 'Stopped';
        continue;
      }
      row.state = 'running';
      this.post();
      try {
        const { response, assertions } = await this.runner.run(plan[i].req, { uri: plan[i].uri }, cts.token);
        row.status = response.status;
        row.timeMs = response.timeMs;
        row.assertions = assertions;
        row.state = rowState(response.status, assertions);
      } catch (e) {
        row.state = 'error';
        row.error = (e as Error).message;
      }
      this.elapsed = Date.now() - this.started;
      this.post();
    }
    this.running = false;
    this.elapsed = Date.now() - this.started;
    this.post();
    return summarize(this.rows, this.elapsed);
  }

  private post(): void {
    void this.panel.webview.postMessage({
      type: 'state',
      title: this.title,
      running: this.running,
      rows: this.rows,
      summary: summarize(this.rows, this.running ? Date.now() - this.started : this.elapsed),
    });
  }

  /** Markdown report for pasting into a PR or issue. */
  markdown(): string {
    return markdownReport(this.title, this.rows, summarize(this.rows, this.elapsed));
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Plainwire run</title>
<style nonce="${nonce}">
body { margin: 0; padding: 12px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); background: var(--vscode-editor-background); }
button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; border-radius: 3px; padding: 4px 10px; cursor: pointer; }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.head h1 { font-size: 1.15em; margin: 0; flex: 1; }
.sum span { margin-right: 12px; }
.pass { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.fail, .error { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
.skipped, .pending, .muted { color: var(--vscode-descriptionForeground); }
.bar { height: 4px; background: var(--vscode-panel-border); margin: 6px 0 12px; display: flex; }
.bar div { height: 4px; }
.bar .p { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); } .bar .f { background: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
table { border-collapse: collapse; width: 100%; }
td { padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
tr.row:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
.m { font-family: var(--vscode-editor-font-family, monospace); font-weight: 700; width: 64px; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.file { color: var(--vscode-descriptionForeground); font-size: .9em; }
.detail { font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; margin-top: 3px; white-space: pre-wrap; }
</style></head><body><div id="app"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const ICON = { pass: '✓', fail: '✗', error: '⚠', skipped: '⏭', pending: '•', running: '…' };
function el(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else if (k === 'width') e.style.width = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false) e.append(c); return e; }
function render(s) {
  const app = document.getElementById('app');
  const sum = s.summary;
  const done = sum.passed + sum.failed + sum.errors;
  const head = el('div', { class: 'head' },
    el('h1', {}, (s.running ? 'Running ' : 'Ran ') + s.title),
    s.running ? el('button', { onclick: () => vscode.postMessage({ type: 'stop' }) }, 'Stop')
      : el('button', { class: 'primary', onclick: () => vscode.postMessage({ type: 'rerun' }) }, 'Run again'),
    !s.running && sum.failed + sum.errors ? el('button', { onclick: () => vscode.postMessage({ type: 'rerunFailed' }) }, 'Re-run failed') : null,
    !s.running ? el('button', { onclick: () => vscode.postMessage({ type: 'copy' }) }, 'Copy report (Markdown)') : null);
  const line = el('div', { class: 'sum' },
    el('span', { class: 'pass' }, sum.passed + ' passed'), el('span', { class: 'fail' }, sum.failed + ' failed'),
    sum.errors ? el('span', { class: 'error' }, sum.errors + ' errors') : null, sum.skipped ? el('span', { class: 'skipped' }, sum.skipped + ' skipped') : null,
    el('span', { class: 'muted' }, done + '/' + (sum.total - sum.skipped) + ' requests · ' + sum.timeMs + ' ms'));
  const bar = el('div', { class: 'bar' }, el('div', { class: 'p', width: (sum.total ? 100 * sum.passed / sum.total : 0) + '%' }), el('div', { class: 'f', width: (sum.total ? 100 * (sum.failed + sum.errors) / sum.total : 0) + '%' }));
  const oneFile = s.rows.every((r) => r.file === (s.rows[0] && s.rows[0].file));
  const rows = s.rows.map((r) => {
    const failed = r.assertions.filter((a) => !a.passed);
    const checks = r.assertions.length ? (r.assertions.length - failed.length) + '/' + r.assertions.length + ' checks' : (r.status !== undefined ? 'no checks' : '');
    return el('tr', { class: 'row', title: 'Open this request', onclick: () => vscode.postMessage({ type: 'open', uri: r.uri, index: r.index }) },
      el('td', { class: r.state }, ICON[r.state]),
      el('td', { class: 'm' }, r.method),
      el('td', {}, r.label, oneFile ? null : ' ', oneFile ? null : el('span', { class: 'file' }, r.file),
        r.error ? el('div', { class: 'detail error' }, r.error) : null,
        ...failed.map((a) => el('div', { class: 'detail fail' }, '✗ ' + a.source + ': ' + a.message))),
      el('td', { class: 'num ' + (r.status >= 400 ? 'fail' : '') }, r.status ?? ''),
      el('td', { class: 'num muted' }, r.timeMs !== undefined ? r.timeMs + ' ms' : ''),
      el('td', { class: 'num ' + (failed.length ? 'fail' : 'muted') }, checks));
  });
  app.replaceChildren(head, line, bar, s.rows.length ? el('table', {}, ...rows) : el('p', { class: 'muted' }, 'No requests found.'));
}
window.addEventListener('message', (e) => { if (e.data.type === 'state') render(e.data); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
