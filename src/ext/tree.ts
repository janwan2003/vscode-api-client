import * as vscode from 'vscode';
import { parseHttpFile, shortLabel } from '../core/httpFile.ts';
import type { HttpRequest } from '../core/model.ts';
import type { History, HistoryEntry } from './history.ts';
import { readText } from './runner.ts';
import { buildFolderTree, parentFolder, type FolderNode } from '../core/folders.ts';

export { requestLabel } from '../core/exec.ts';
import { requestLabel } from '../core/exec.ts';

export class FolderNodeItem {
  constructor(
    readonly uri: vscode.Uri,
    readonly folder: FolderNode,
    readonly ws: vscode.WorkspaceFolder,
    /** A workspace folder shown as a top-level node in a multi-root workspace. */
    readonly isRoot = false,
  ) {}
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
export type CollectionNode = FolderNodeItem | FileNode | RequestNode;

/** Every .http / .rest file in the workspace, in its folders, with its requests as children. */
export class CollectionsProvider implements vscode.TreeDataProvider<CollectionNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.{http,rest}');
  private readonly subs: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private roots?: Promise<FolderNodeItem[]>;

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
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
      vscode.workspace.onDidRenameFiles(refresh),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('plainwire.collections')) refresh();
      }),
    );
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.roots = undefined;
      this.emitter.fire();
    }, 300);
  }

  /** Rebuild now (not debounced), e.g. before revealing files that were just written. */
  refreshNow(): void {
    clearTimeout(this.timer);
    this.roots = undefined;
    this.emitter.fire();
  }

  /** Folder trees per workspace folder, built once per refresh. */
  private async folderRoots(): Promise<FolderNodeItem[]> {
    this.roots ??= (async () => {
      const files = await vscode.workspace.findFiles('**/*.{http,rest}', '{**/node_modules/**,**/.git/**}', 2000);
      const compact = vscode.workspace.getConfiguration('plainwire.collections').get<boolean>('compactFolders', true);
      const out: FolderNodeItem[] = [];
      for (const ws of vscode.workspace.workspaceFolders ?? []) {
        const base = ws.uri.path.replace(/\/$/, '') + '/';
        const rel = files.filter((f) => f.scheme === ws.uri.scheme && f.authority === ws.uri.authority && f.path.startsWith(base)).map((f) => f.path.slice(base.length));
        out.push(new FolderNodeItem(ws.uri, buildFolderTree(rel, compact), ws, true));
      }
      return out;
    })();
    return this.roots;
  }

  async getChildren(node?: CollectionNode): Promise<CollectionNode[]> {
    if (!node) {
      const roots = await this.folderRoots();
      if (roots.length === 1) return this.folderChildren(roots[0]);
      return roots.filter((r) => r.folder.files.length || r.folder.folders.length);
    }
    if (node instanceof FolderNodeItem) return this.folderChildren(node);
    if (node instanceof FileNode) {
      try {
        return parseHttpFile(await readText(node.uri)).requests.map((r, i) => new RequestNode(node.uri, i, r));
      } catch {
        return [];
      }
    }
    return [];
  }

  private folderChildren(n: FolderNodeItem): CollectionNode[] {
    return [
      ...n.folder.folders.map((f) => new FolderNodeItem(vscode.Uri.joinPath(n.ws.uri, f.path), f, n.ws)),
      ...n.folder.files.map((f) => new FileNode(vscode.Uri.joinPath(n.ws.uri, f))),
    ];
  }

  /** For TreeView.reveal: request → file → folders → (multi-root) workspace folder. */
  async getParent(node: CollectionNode): Promise<CollectionNode | undefined> {
    if (node instanceof RequestNode) return new FileNode(node.uri);
    const roots = await this.folderRoots();
    const root = roots.find((r) => node.uri.path.startsWith(r.ws.uri.path.replace(/\/$/, '') + '/'));
    if (!root || (node instanceof FolderNodeItem && node.isRoot)) return undefined;
    const rel = node.uri.path.slice(root.ws.uri.path.replace(/\/$/, '').length + 1);
    const parent = parentFolder(root.folder, rel);
    if (parent) return new FolderNodeItem(vscode.Uri.joinPath(root.ws.uri, parent.path), parent, root.ws);
    return roots.length > 1 ? root : undefined;
  }

  getTreeItem(node: CollectionNode): vscode.TreeItem {
    if (node instanceof FolderNodeItem) {
      const item = new vscode.TreeItem(node.isRoot ? node.ws.name : node.folder.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `dir:${node.uri.toString()}`;
      item.resourceUri = node.uri;
      item.iconPath = node.isRoot ? new vscode.ThemeIcon('root-folder') : vscode.ThemeIcon.Folder;
      item.contextValue = node.isRoot ? 'plainwire.root' : 'plainwire.folder';
      item.tooltip = vscode.workspace.asRelativePath(node.uri);
      return item;
    }
    if (node instanceof FileNode) {
      const name = node.uri.path.slice(node.uri.path.lastIndexOf('/') + 1);
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `file:${node.uri.toString()}`;
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'plainwire.file';
      item.tooltip = vscode.workspace.asRelativePath(node.uri);
      return item;
    }
    const r = node.request;
    const item = new vscode.TreeItem(requestLabel(r), vscode.TreeItemCollapsibleState.None);
    item.id = `req:${node.uri.toString()}#${node.index}:${r.method} ${r.url}`;
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
    const item = new vscode.TreeItem(`${e.request.method} ${shortLabel(e.request)}`, vscode.TreeItemCollapsibleState.None);
    const when = new Date(e.at);
    item.description = e.response ? `${e.response.status} · ${e.response.timeMs} ms · ${when.toLocaleTimeString()}` : `failed · ${when.toLocaleTimeString()}`;
    item.tooltip = `${e.request.method} ${e.request.url}\n${when.toLocaleString()}\n${e.error ?? `${e.response?.status} ${e.response?.statusText}`}`;
    item.iconPath = new vscode.ThemeIcon(e.error ? 'error' : 'history', e.error || (e.response && e.response.status >= 400) ? new vscode.ThemeColor('errorForeground') : undefined);
    item.command = { command: 'plainwire.openHistory', title: 'Open', arguments: [e] };
    item.contextValue = 'plainwire.history';
    return item;
  }
}

