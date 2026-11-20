import * as vscode from 'vscode';
import { parseHttpFile } from '../core/httpFile.ts';
import type { HttpRequest } from '../core/model.ts';
import type { History, HistoryEntry } from './history.ts';
import { readText } from './runner.ts';

export function requestLabel(r: HttpRequest): string {
  return r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || r.url;
}

export class FileNode {
  constructor(readonly uri: vscode.Uri) {}
}
export class RequestNode {
  constructor(
    readonly uri: vscode.Uri,
    readonly index: number,
    readonly request: HttpRequest & { requestLine: number },
  ) {}
}

/** All .http / .rest files in the workspace, with their requests as children. */
export class CollectionsProvider implements vscode.TreeDataProvider<FileNode | RequestNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.{http,rest}');
  private readonly subs: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    const refresh = () => this.refresh();
    this.subs.push(
      this.watcher,
      this.watcher.onDidCreate(refresh),
      this.watcher.onDidDelete(refresh),
      this.watcher.onDidChange(refresh),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (/\.(http|rest)$/i.test(e.document.uri.path)) refresh();
      }),
    );
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 300);
  }

  async getChildren(node?: FileNode | RequestNode): Promise<(FileNode | RequestNode)[]> {
    if (!node) {
      const files = await vscode.workspace.findFiles('**/*.{http,rest}', '{**/node_modules/**,**/.git/**}', 1000);
      files.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
      return files.map((f) => new FileNode(f));
    }
    if (node instanceof FileNode) {
      try {
        return parseHttpFile(await readText(node.uri)).requests.map((r, i) => new RequestNode(node.uri, i, r));
      } catch {
        return [];
      }
    }
    return [];
  }

  getTreeItem(node: FileNode | RequestNode): vscode.TreeItem {
    if (node instanceof FileNode) {
      const item = new vscode.TreeItem(vscode.workspace.asRelativePath(node.uri), vscode.TreeItemCollapsibleState.Collapsed);
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'plainwire.file';
      item.command = undefined;
      return item;
    }
    const r = node.request;
    const item = new vscode.TreeItem(requestLabel(r), vscode.TreeItemCollapsibleState.None);
    item.description = r.method;
    item.tooltip = `${r.method} ${r.url}${r.name ? `\n@name ${r.name}` : ''}`;
    item.iconPath = new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor(methodColor(r.method)));
    item.contextValue = 'plainwire.request';
    item.command = { command: 'plainwire.openRequest', title: 'Open', arguments: [node] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}

function methodColor(m: string): string {
  switch (m) {
    case 'GET':
      return 'charts.green';
    case 'POST':
      return 'charts.yellow';
    case 'PUT':
    case 'PATCH':
      return 'charts.blue';
    case 'DELETE':
      return 'charts.red';
    default:
      return 'foreground';
  }
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryEntry> {
  readonly onDidChangeTreeData: vscode.Event<void>;
  constructor(private readonly history: History) {
    this.onDidChangeTreeData = history.onDidChange;
  }
  getChildren(e?: HistoryEntry): HistoryEntry[] {
    return e ? [] : this.history.entries();
  }
  getTreeItem(e: HistoryEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(`${e.request.method} ${e.request.url}`, vscode.TreeItemCollapsibleState.None);
    const when = new Date(e.at);
    item.description = e.response ? `${e.response.status} · ${e.response.timeMs} ms · ${when.toLocaleTimeString()}` : `failed · ${when.toLocaleTimeString()}`;
    item.tooltip = `${when.toLocaleString()}\n${e.error ?? `${e.response?.status} ${e.response?.statusText}`}`;
    item.iconPath = new vscode.ThemeIcon(e.error ? 'error' : 'history', e.error || (e.response && e.response.status >= 400) ? new vscode.ThemeColor('errorForeground') : undefined);
    item.command = { command: 'plainwire.openHistory', title: 'Open', arguments: [e] };
    item.contextValue = 'plainwire.history';
    return item;
  }
}
