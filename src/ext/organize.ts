import * as vscode from 'vscode';
import { invalidName } from '../core/folders.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import { chainedNames, deleteRequest, duplicateRequest, insertBlock, moveRequests, renameRequest, type RequestRef } from '../core/organize.ts';
import { requestLabel } from '../core/exec.ts';
import { RequestPanel, type PanelDeps } from './panel.ts';
import { readText } from './runner.ts';
import { type CollectionNode, FileNode, FolderNodeItem, RequestNode, type CollectionsProvider } from './tree.ts';

const MIME = 'application/vnd.code.tree.plainwire.collections';
const STARTER = '### New request\nGET https://example.com\n';

/**
 * Organising the Collections view: new file / folder / request, rename, duplicate, delete, move
 * up / down / to another file, and drag and drop. Request edits go through `core/organize.ts`, so
 * only the edited blocks change; file and folder edits go through a WorkspaceEdit, so open
 * editors follow renames and Undo works.
 */
export class Organizer implements vscode.TreeDragAndDropController<CollectionNode> {
  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME, 'text/uri-list'];
  /** The Collections tree view, for commands run from a keybinding (they get no node argument). */
  view?: vscode.TreeView<CollectionNode>;

  constructor(
    private readonly deps: PanelDeps,
    private readonly tree: CollectionsProvider,
  ) {}

  commands(): vscode.Disposable[] {
    const guard =
      <A extends unknown[]>(fn: (...a: A) => unknown) =>
      async (...a: A) => {
        try {
          return await fn(...a);
        } catch (e) {
          void vscode.window.showErrorMessage(`Plainwire: ${(e as Error).message}`);
        }
      };
    const reg = (id: string, fn: (n?: CollectionNode, all?: CollectionNode[]) => unknown) =>
      vscode.commands.registerCommand(
        id,
        guard((n?: CollectionNode, all?: CollectionNode[]) => {
          // From a keybinding or the palette: the tree's selection (VS Code passes no node).
          if (!n && this.view?.selection.length) return fn(this.view.selection[0], [...this.view.selection]);
          return fn(n, all);
        }),
      );
    return [
      reg('plainwire.newRequestIn', (n) => this.newRequest(n)),
      reg('plainwire.newFile', (n) => this.newFile(n)),
      reg('plainwire.newFolder', (n) => this.newFolder(n)),
      reg('plainwire.rename', (n) => this.rename(n)),
      reg('plainwire.duplicateRequest', (n) => n instanceof RequestNode && this.duplicate(n)),
      reg('plainwire.delete', (n, all) => this.delete(selection(n, all))),
      reg('plainwire.moveUp', (n) => n instanceof RequestNode && this.step(n, -1)),
      reg('plainwire.moveDown', (n) => n instanceof RequestNode && this.step(n, 1)),
      reg('plainwire.moveToFile', (n, all) => this.moveToFile(selection(n, all).filter((x): x is RequestNode => x instanceof RequestNode))),
    ];
  }

  // ---- drag and drop ----

  handleDrag(source: readonly CollectionNode[], data: vscode.DataTransfer): void {
    data.set(MIME, new vscode.DataTransferItem(source));
    const files = source.filter((s): s is FileNode => s instanceof FileNode);
    if (files.length) data.set('text/uri-list', new vscode.DataTransferItem(files.map((f) => f.uri.toString()).join('\r\n')));
  }

  async handleDrop(target: CollectionNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const nodes = data.get(MIME)?.value as CollectionNode[] | undefined;
    if (!nodes?.length) return;
    try {
      const requests = nodes.filter((n): n is RequestNode => n instanceof RequestNode);
      if (requests.length) {
        if (requests.length !== nodes.length) throw new Error('Drag requests, or files and folders, but not both at once.');
        if (target instanceof RequestNode) return await this.moveTo(requests, target.uri, target.index, true);
        if (target instanceof FileNode) return await this.moveTo(requests, target.uri, undefined);
        throw new Error('Drop requests on a .http file, or on a request to place them there.');
      }
      const dir = target instanceof FolderNodeItem ? target.uri : target ? vscode.Uri.joinPath(target.uri, '..') : vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri : undefined;
      if (!dir) throw new Error('Drop files on a folder.');
      await this.moveEntries(nodes.filter((n): n is FileNode | FolderNodeItem => n instanceof FileNode || (n instanceof FolderNodeItem && !n.isRoot)).map((n) => n.uri), dir);
    } catch (e) {
      void vscode.window.showErrorMessage(`Plainwire: ${(e as Error).message}`);
    }
  }

  // ---- requests ----

  /**
   * Move requests to `uri`, before request `index` (or to the end). With `onto`, a drop onto a
   * later request in the same file places them after it, which is what dragging downwards means.
   */
  async moveTo(requests: RequestNode[], uri: vscode.Uri, index: number | undefined, onto = false): Promise<void> {
    const key = uri.toString();
    const texts = new Map<string, string>();
    for (const u of [uri, ...requests.map((r) => r.uri)]) if (!texts.has(u.toString())) texts.set(u.toString(), await readText(u));
    let before = index;
    if (onto && index !== undefined && requests.every((r) => r.uri.toString() === key && r.index < index)) {
      before = index + 1 < parseHttpFile(texts.get(key)!).requests.length ? index + 1 : undefined;
    }
    const refs: RequestRef[] = requests.map((r) => ({ file: r.uri.toString(), index: r.index }));
    const changed = moveRequests(texts, refs, { file: key, before });
    if (!changed.size) return;
    this.warnBrokenChains(requests, texts, uri);
    await this.write(changed);
  }

  /** A moved `# @name` request that other requests in its old file chain to (`{{name.response…}}`). */
  private warnBrokenChains(requests: RequestNode[], texts: Map<string, string>, to: vscode.Uri): void {
    for (const r of requests) {
      if (!r.request.name || r.uri.toString() === to.toString()) continue;
      const rest = texts.get(r.uri.toString()) ?? '';
      if (!chainedNames(rest).has(r.request.name)) continue;
      const rel = relativePath(r.uri, to);
      if ((parseHttpFile(rest).imports ?? []).some((p) => p.replace(/^\.\//, '') === rel.replace(/^\.\//, ''))) continue;
      const from = vscode.workspace.asRelativePath(r.uri);
      void vscode.window.showWarningMessage(
        `Plainwire: requests in ${from} use {{${r.request.name}.response…}}. Add "# @import ${rel.startsWith('.') ? rel : './' + rel}" to ${from} so they still find it.`,
      );
    }
  }

  private async step(n: RequestNode, delta: -1 | 1): Promise<void> {
    const text = await readText(n.uri);
    const count = parseHttpFile(text).requests.length;
    const target = n.index + delta;
    if (target < 0 || target >= count) return;
    // Up: before the previous request. Down: before the one after next (or last).
    const before = delta < 0 ? target : target + 1 < count ? target + 1 : undefined;
    const changed = moveRequests(new Map([[n.uri.toString(), text]]), [{ file: n.uri.toString(), index: n.index }], { file: n.uri.toString(), before });
    await this.write(changed);
  }

  private async moveToFile(requests: RequestNode[]): Promise<void> {
    if (!requests.length) return;
    const files = await vscode.workspace.findFiles('**/*.{http,rest}', '{**/node_modules/**,**/.git/**}', 2000);
    const from = new Set(requests.map((r) => r.uri.toString()));
    const items = files
      .filter((u) => !(from.size === 1 && from.has(u.toString())))
      .map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const pick = await vscode.window.showQuickPick([{ label: '$(new-file) New .http file…', uri: undefined as vscode.Uri | undefined }, ...items], {
      placeHolder: requests.length === 1 ? `Move "${requestLabel(requests[0].request)}" to…` : `Move ${requests.length} requests to…`,
    });
    if (!pick) return;
    let uri = pick.uri;
    if (!uri) {
      uri = await this.askNewFile(vscode.Uri.joinPath(requests[0].uri, '..'), '');
      if (!uri) return;
    }
    await this.moveTo(requests, uri, undefined);
  }

  private async duplicate(n: RequestNode): Promise<void> {
    const text = await readText(n.uri);
    const out = duplicateRequest(text, n.index);
    await this.write(new Map([[n.uri.toString(), out]]));
    const copy = parseHttpFile(out).requests[n.index + 1];
    if (copy) RequestPanel.show(this.deps, copy, { kind: 'file', uri: n.uri, index: n.index + 1 });
  }

  private async newRequest(n?: CollectionNode): Promise<void> {
    if (n instanceof FolderNodeItem || !n) return this.newFile(n);
    const uri = n.uri;
    const text = await readText(uri);
    const at = n instanceof RequestNode ? n.index + 1 : undefined;
    const block = STARTER.trimEnd().split('\n');
    const out = insertBlock(text, block, at !== undefined && at < parseHttpFile(text).requests.length ? at : undefined);
    await this.write(new Map([[uri.toString(), out]]));
    const reqs = parseHttpFile(out).requests;
    const index = at !== undefined && at < reqs.length - 1 ? at : reqs.length - 1;
    RequestPanel.show(this.deps, reqs[index], { kind: 'file', uri, index });
  }

  // ---- files and folders ----

  private dirOf(n?: CollectionNode): vscode.Uri | undefined {
    if (n instanceof FolderNodeItem) return n.uri;
    if (n) return vscode.Uri.joinPath(n.uri, '..');
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /** Ask for a file name in `dir` (".http" added when missing); undefined when cancelled or taken. */
  private async askNewFile(dir: vscode.Uri, content: string = STARTER): Promise<vscode.Uri | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: `New .http file in ${vscode.workspace.asRelativePath(dir) || 'the workspace root'}`,
      placeHolder: 'users  (or orders/list: subfolders are created)',
      validateInput: (v) => v.split('/').map((p) => invalidName(p)).find(Boolean),
    });
    if (!name) return undefined;
    const file = /\.(http|rest)$/i.test(name.trim()) ? name.trim() : `${name.trim()}.http`;
    const uri = vscode.Uri.joinPath(dir, ...file.split('/'));
    if (await exists(uri)) throw new Error(`${vscode.workspace.asRelativePath(uri)} already exists.`);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    this.tree.refresh();
    return uri;
  }

  private async newFile(n?: CollectionNode): Promise<void> {
    const dir = this.dirOf(n);
    if (!dir) throw new Error('Open a folder first.');
    const uri = await this.askNewFile(dir);
    if (!uri) return;
    const r = parseHttpFile(STARTER).requests[0];
    RequestPanel.show(this.deps, r, { kind: 'file', uri, index: 0 });
  }

  private async newFolder(n?: CollectionNode): Promise<void> {
    const dir = this.dirOf(n);
    if (!dir) throw new Error('Open a folder first.');
    const name = await vscode.window.showInputBox({
      prompt: `New folder in ${vscode.workspace.asRelativePath(dir) || 'the workspace root'} (it starts with requests.http)`,
      validateInput: (v) => v.split('/').map((p) => invalidName(p)).find(Boolean),
    });
    if (!name) return;
    const folder = vscode.Uri.joinPath(dir, ...name.trim().split('/'));
    if (await exists(folder)) throw new Error(`${vscode.workspace.asRelativePath(folder)} already exists.`);
    const uri = vscode.Uri.joinPath(folder, 'requests.http');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(STARTER));
    this.tree.refresh();
    RequestPanel.show(this.deps, parseHttpFile(STARTER).requests[0], { kind: 'file', uri, index: 0 });
  }

  private async rename(n?: CollectionNode): Promise<void> {
    if (!n) return;
    if (n instanceof RequestNode) {
      const text = await readText(n.uri);
      const r = parseHttpFile(text).requests[n.index];
      if (!r) throw new Error('That request no longer exists in the file.');
      const title = await vscode.window.showInputBox({ prompt: 'Request title (the text after ###)', value: r.title?.trim() ?? requestLabel(r) });
      if (title === undefined) return;
      await this.write(new Map([[n.uri.toString(), renameRequest(text, n.index, title)]]));
      return;
    }
    if (n instanceof FolderNodeItem && n.isRoot) return;
    const old = n.uri.path.slice(n.uri.path.lastIndexOf('/') + 1);
    const isFile = n instanceof FileNode;
    const dot = isFile ? old.lastIndexOf('.') : -1;
    const name = await vscode.window.showInputBox({
      prompt: isFile ? 'New file name' : 'New folder name',
      value: old,
      valueSelection: dot > 0 ? [0, dot] : undefined,
      validateInput: (v) => invalidName(v),
    });
    if (!name || name === old) return;
    let next = name.trim();
    if (isFile && !/\.(http|rest)$/i.test(next)) next += old.slice(dot);
    const target = vscode.Uri.joinPath(n.uri, '..', next);
    await this.renameEntries([[n.uri, target]]);
  }

  async moveEntries(uris: vscode.Uri[], dir: vscode.Uri): Promise<void> {
    const pairs: [vscode.Uri, vscode.Uri][] = [];
    for (const u of uris) {
      const name = u.path.slice(u.path.lastIndexOf('/') + 1);
      const to = vscode.Uri.joinPath(dir, name);
      if (to.toString() === u.toString()) continue;
      if (dir.path === u.path || dir.path.startsWith(u.path + '/')) throw new Error(`Cannot move ${name} into itself.`);
      pairs.push([u, to]);
    }
    await this.renameEntries(pairs);
  }

  private async renameEntries(pairs: [vscode.Uri, vscode.Uri][]): Promise<void> {
    if (!pairs.length) return;
    for (const [, to] of pairs) if (await exists(to)) throw new Error(`${vscode.workspace.asRelativePath(to)} already exists.`);
    const edit = new vscode.WorkspaceEdit();
    for (const [from, to] of pairs) edit.renameFile(from, to, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The move was not applied.');
    RequestPanel.renamed(pairs);
    this.tree.refresh();
  }

  private async delete(nodes: CollectionNode[]): Promise<void> {
    nodes = nodes.filter((n) => !(n instanceof FolderNodeItem && n.isRoot));
    if (!nodes.length) return;
    const requests = nodes.filter((n): n is RequestNode => n instanceof RequestNode);
    const entries = nodes.filter((n): n is FileNode | FolderNodeItem => !(n instanceof RequestNode));
    const what =
      nodes.length === 1
        ? requests.length
          ? `the request "${requestLabel(requests[0].request)}"`
          : `${entries[0] instanceof FolderNodeItem ? 'the folder' : ''} "${vscode.workspace.asRelativePath(entries[0].uri)}"${entries[0] instanceof FolderNodeItem ? ' and everything in it' : ''}`.trim()
        : `${nodes.length} items`;
    const ok = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail: entries.length ? 'Files and folders go to the trash.' : 'Undo with Ctrl+Z in the file.' }, 'Delete');
    if (ok !== 'Delete') return;
    // Requests: per file, highest index first so the others keep their positions.
    const byFile = new Map<string, number[]>();
    for (const r of requests) {
      if (entries.some((e) => r.uri.path === e.uri.path || r.uri.path.startsWith(e.uri.path + '/'))) continue;
      byFile.set(r.uri.toString(), [...(byFile.get(r.uri.toString()) ?? []), r.index]);
    }
    const changed = new Map<string, string>();
    for (const [file, idx] of byFile) {
      let t = await readText(vscode.Uri.parse(file));
      for (const i of [...new Set(idx)].sort((a, b) => b - a)) t = deleteRequest(t, i);
      changed.set(file, t);
    }
    await this.write(changed);
    for (const e of entries) await vscode.workspace.fs.delete(e.uri, { recursive: true, useTrash: true });
    if (entries.length) this.tree.refresh();
  }

  /** Write new texts through a WorkspaceEdit (keeps Undo and unsaved-editor state), save, and re-point open request tabs. */
  private async write(changed: Map<string, string>): Promise<void> {
    if (!changed.size) return;
    const edit = new vscode.WorkspaceEdit();
    const docs: vscode.TextDocument[] = [];
    for (const [key, text] of changed) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(key));
      docs.push(doc);
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The edit was not applied.');
    for (const d of docs) await d.save();
    RequestPanel.relocate(changed);
    this.tree.refresh();
  }
}

/** The clicked node plus the rest of the selection, the way VS Code passes them to context-menu commands. */
function selection(n: CollectionNode | undefined, all: CollectionNode[] | undefined): CollectionNode[] {
  if (all?.length) return all;
  return n ? [n] : [];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Path of `file` relative to the folder of `from`, '/'-separated. */
function relativePath(from: vscode.Uri, file: vscode.Uri): string {
  const a = from.path.split('/').slice(0, -1);
  const b = file.path.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || b[b.length - 1];
}
