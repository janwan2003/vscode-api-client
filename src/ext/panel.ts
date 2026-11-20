import type { SseEvent } from '../core/sse.ts';
import * as vscode from 'vscode';
import { parseCurl } from '../core/curl.ts';
import { appendRequest, parseHttpFile, replaceRequest } from '../core/httpFile.ts';
import type { HttpRequest, HttpResponse } from '../core/model.ts';
import type { CodeCopier } from './copyCode.ts';
import type { EnvironmentManager } from './environments.ts';
import { readText, type Runner } from './runner.ts';

export type PanelSource = { kind: 'file'; uri: vscode.Uri; index: number } | { kind: 'scratch' };

export interface PanelDeps {
  extensionUri: vscode.Uri;
  runner: Runner;
  envs: EnvironmentManager;
  copier: CodeCopier;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; request: HttpRequest }
  | { type: 'cancel' }
  | { type: 'save'; request: HttpRequest }
  | { type: 'saveAs'; request: HttpRequest }
  | { type: 'copyCurl'; request: HttpRequest }
  | { type: 'copyCode'; request: HttpRequest }
  | { type: 'openText' }
  | { type: 'selectEnv' }
  | { type: 'acquireToken'; id: string }
  | { type: 'changed'; request: HttpRequest }
  | { type: 'openBody'; body: string; contentType: string }
  | { type: 'importCurl'; text: string };

/** A request editor tab. One per saved request; scratch requests get their own tabs. */
export class RequestPanel {
  private static readonly open = new Map<string, RequestPanel>();
  private static scratchCount = 0;

  private source: PanelSource;
  private request: HttpRequest;
  /** Method+URL+name at load time, used to find the request again if the file changed. */
  private snapshot: { method: string; url: string; name?: string };
  private cts?: vscode.CancellationTokenSource;
  private readonly disposables: vscode.Disposable[] = [];

  static show(deps: PanelDeps, request: HttpRequest, source: PanelSource, response?: HttpResponse, autoSend = false): RequestPanel {
    const key = RequestPanel.key(source);
    let p = RequestPanel.open.get(key);
    if (p) {
      p.panel.reveal(undefined, false);
      p.request = request;
      p.snapshot = { method: request.method, url: request.url, name: request.name };
      p.post({ type: 'load', request, response, ...p.meta() });
    } else {
      p = new RequestPanel(deps, request, source, key, response);
      RequestPanel.open.set(key, p);
    }
    if (autoSend) void p.send(request);
    return p;
  }

  /**
   * After requests were reordered, moved between files or deleted from the sidebar: point each
   * open request tab at its request's new place (looked up the way Save does, by `@name` or
   * method + URL; first in its own file, then in the other changed files).
   */
  static relocate(changed: Map<string, string>): void {
    for (const p of [...RequestPanel.open.values()]) {
      if (p.source.kind !== 'file') continue;
      const own = p.source.uri.toString();
      if (!changed.has(own)) continue;
      const same = (r: HttpRequest) => (p.snapshot.name ? r.name === p.snapshot.name : r.method === p.snapshot.method && r.url === p.snapshot.url);
      for (const file of [own, ...[...changed.keys()].filter((k) => k !== own)]) {
        const reqs = parseHttpFile(changed.get(file)!).requests;
        // In its own file, prefer the old position when it still matches (two requests may share a URL).
        const index = file === own && reqs[p.source.index] && same(reqs[p.source.index]) ? p.source.index : reqs.findIndex(same);
        if (index < 0) continue;
        const next: PanelSource = { kind: 'file', uri: vscode.Uri.parse(file), index };
        const other = RequestPanel.open.get(RequestPanel.key(next));
        if (other && other !== p) break;
        p.rekey(next);
        p.post({ type: 'env', ...p.meta() });
        break;
      }
    }
  }

  /** After files or folders were renamed or moved: keep open request tabs pointing at their file. */
  static renamed(pairs: [vscode.Uri, vscode.Uri][]): void {
    for (const p of [...RequestPanel.open.values()]) {
      if (p.source.kind !== 'file') continue;
      const path = p.source.uri.path;
      for (const [from, to] of pairs) {
        if (path !== from.path && !path.startsWith(from.path + '/')) continue;
        const uri = to.with({ path: to.path + path.slice(from.path.length) });
        p.rekey({ kind: 'file', uri, index: p.source.index });
        p.post({ type: 'env', ...p.meta() });
        break;
      }
    }
  }

  private static key(source: PanelSource): string {
    return source.kind === 'file' ? `${source.uri.toString()}#${source.index}` : `scratch:${++RequestPanel.scratchCount}`;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly deps: PanelDeps,
    request: HttpRequest,
    source: PanelSource,
    private key: string,
    private pendingResponse?: HttpResponse,
  ) {
    this.source = source;
    this.request = request;
    this.snapshot = { method: request.method, url: request.url, name: request.name };
    this.panel = vscode.window.createWebviewPanel('plainwire.request', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'tab-icon.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
      deps.envs.onDidChange(() => this.post({ type: 'env', ...this.meta() })),
    );
  }

  private title(): string {
    const r = this.request;
    const label = r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || r.url || 'New request';
    return `${r.method} ${label}`.slice(0, 60);
  }

  private meta() {
    const s = this.source;
    return {
      sourceLabel: s.kind === 'file' ? vscode.workspace.asRelativePath(s.uri) : 'Unsaved request',
      canSave: s.kind === 'file',
      env: this.deps.envs.selected ?? null,
      envNames: this.deps.envs.names(),
      authIds: this.deps.runner.authIds(),
    };
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.post({ type: 'load', request: this.request, response: this.pendingResponse, ...this.meta() });
          this.pendingResponse = undefined;
          break;
        case 'changed':
          this.request = m.request;
          this.panel.title = this.title();
          break;
        case 'send':
          await this.send(m.request);
          break;
        case 'cancel':
          this.cts?.cancel();
          break;
        case 'save':
          await this.save(m.request);
          break;
        case 'saveAs':
          await this.saveAs(m.request);
          break;
        case 'copyCurl':
        case 'copyCode':
          await this.deps.copier.copy(m.request, this.source.kind === 'file' ? this.source.uri : undefined, m.type === 'copyCurl' ? 'curl' : undefined);
          break;
        case 'openText':
          if (this.source.kind === 'file') await this.revealInFile();
          break;
        case 'selectEnv':
          await this.deps.envs.pick();
          break;
        case 'acquireToken':
          await vscode.commands.executeCommand('plainwire.acquireOAuthToken', m.id);
          break;
        case 'openBody': {
          const language = /json/i.test(m.contentType) ? 'json' : /html/i.test(m.contentType) ? 'html' : /xml/i.test(m.contentType) ? 'xml' : 'plaintext';
          const doc = await vscode.workspace.openTextDocument({ content: m.body, language });
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
          break;
        }
        case 'importCurl': {
          const parsed = parseCurl(m.text);
          this.request = { ...parsed, title: this.request.title, name: this.request.name };
          this.post({ type: 'setRequest', request: this.request });
          break;
        }
      }
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  async send(request: HttpRequest): Promise<void> {
    this.request = request;
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.post({ type: 'sending' });
    // Server-sent events reach the webview in batches (at most 10 messages a second), so fast streams stay responsive.
    let batch: SseEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (batch.length && this.cts === cts) this.post({ type: 'events', events: batch });
      batch = [];
    };
    const onEvent = (e: SseEvent) => {
      batch.push(e);
      timer ??= setTimeout(flush, 100);
    };
    try {
      const { resolved, response, assertions, logs } = await this.deps.runner.run(request, { uri: this.source.kind === 'file' ? this.source.uri : undefined }, cts.token, onEvent);
      if (timer) clearTimeout(timer);
      if (this.cts === cts) this.post({ type: 'response', response, resolved, assertions, logs });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (this.cts === cts) this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async findIndex(uri: vscode.Uri, text: string): Promise<number> {
    const reqs = parseHttpFile(text).requests;
    const s = this.source as { index: number };
    const at = reqs[s.index];
    const same = (r: HttpRequest) => (this.snapshot.name ? r.name === this.snapshot.name : r.method === this.snapshot.method && r.url === this.snapshot.url);
    if (at && same(at)) return s.index;
    const found = reqs.findIndex(same);
    if (found >= 0) return found;
    throw new Error(`Could not find this request in ${vscode.workspace.asRelativePath(uri)} any more (was it edited?). Use "Save as…" instead.`);
  }

  private async save(request: HttpRequest): Promise<void> {
    if (this.source.kind !== 'file') return this.saveAs(request);
    const uri = this.source.uri;
    const text = await readText(uri);
    const index = await this.findIndex(uri, text);
    await writeText(uri, replaceRequest(text, index, request));
    this.rekey({ kind: 'file', uri, index });
    this.request = request;
    this.snapshot = { method: request.method, url: request.url, name: request.name };
    this.panel.title = this.title();
    this.post({ type: 'saved', ...this.meta() });
  }

  private async saveAs(request: HttpRequest): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.{http,rest}', '**/node_modules/**', 500);
    const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [
      { label: '$(new-file) New .http file…' },
      ...files.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Add this request to which .http file?' });
    if (!pick) return;
    let uri = pick.uri;
    if (!uri) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      uri = await vscode.window.showSaveDialog({
        defaultUri: root ? vscode.Uri.joinPath(root, 'requests.http') : undefined,
        filters: { 'HTTP requests': ['http', 'rest'] },
      });
      if (!uri) return;
    }
    let text = '';
    try {
      text = await readText(uri);
    } catch {
      /* new file */
    }
    const out = appendRequest(text, request);
    await writeText(uri, out);
    const index = parseHttpFile(out).requests.length - 1;
    this.rekey({ kind: 'file', uri, index });
    this.request = request;
    this.snapshot = { method: request.method, url: request.url, name: request.name };
    this.panel.title = this.title();
    this.post({ type: 'saved', ...this.meta() });
  }

  private rekey(source: PanelSource): void {
    RequestPanel.open.delete(this.key);
    this.source = source;
    this.key = RequestPanel.key(source);
    RequestPanel.open.set(this.key, this);
  }

  private async revealInFile(): Promise<void> {
    if (this.source.kind !== 'file') return;
    const doc = await vscode.workspace.openTextDocument(this.source.uri);
    const index = await this.findIndex(this.source.uri, doc.getText()).catch(() => this.source.kind === 'file' ? this.source.index : 0);
    const r = parseHttpFile(doc.getText()).requests[index];
    const pos = new vscode.Position(r?.requestLine ?? 0, 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'panel.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'panel.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; img-src ${w.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Plainwire</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  dispose(): void {
    this.cts?.cancel();
    RequestPanel.open.delete(this.key);
    for (const d of this.disposables) d.dispose();
  }
}

/** Write through an open editor if there is one (keeps undo), else to disk. */
async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  } else {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  }
}
