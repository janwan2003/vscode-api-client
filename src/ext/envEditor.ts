import * as vscode from 'vscode';
import { gitignoreCovers, modelFromFiles, writeFiles, type EnvModel, type Which } from '../core/envFile.ts';
import type { EnvironmentManager } from './environments.ts';

const PUBLIC = 'http-client.env.json';
const PRIVATE = 'http-client.private.env.json';

type FromWebview =
  | { type: 'ready' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'save'; model: EnvModel; force?: boolean }
  | { type: 'reload' }
  | { type: 'folder'; value: string }
  | { type: 'openJson'; which: Which; env?: string; name?: string }
  | { type: 'addGitignore' }
  | { type: 'activate'; name: string };

interface FileState {
  uri: vscode.Uri;
  /** Text on disk when loaded (undefined: the file does not exist). */
  text?: string;
  /** Parsed JSON (undefined: the file does not exist). */
  json?: unknown;
}

interface GitignoreState {
  state: 'none' | 'covered' | 'missing';
  /** The .gitignore that "Add to .gitignore" appends to. */
  uri?: vscode.Uri;
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return undefined;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    throw e;
  }
}

/** Folders that contain an `http-client.env.json` and/or `http-client.private.env.json`, workspace roots first. */
async function envFolders(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles('**/http-client{.env,.private.env}.json', '**/node_modules/**', 200);
  const dirs = new Map<string, vscode.Uri>();
  for (const f of files) {
    const d = vscode.Uri.joinPath(f, '..');
    dirs.set(d.toString(), d);
  }
  const list = [...dirs.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!list.length && root) list.push(root);
  return list;
}

function folderLabel(u: vscode.Uri): string {
  const ws = vscode.workspace.getWorkspaceFolder(u);
  if (!ws) return u.fsPath;
  const rel = u.path.slice(ws.uri.path.replace(/\/$/, '').length + 1);
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return (multi ? ws.name + '/' : '') + (rel || (multi ? '' : '(workspace root)'));
}

/** The "Edit Environments" tab: a form over the http-client.env.json / http-client.private.env.json pair of one folder. */
export class EnvEditorPanel {
  static current?: EnvEditorPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: vscode.Disposable;
  private folders: vscode.Uri[] = [];
  private folder?: vscode.Uri;
  private pub?: FileState;
  private priv?: FileState;
  private error?: string;
  private dirty = false;
  /** Number of times the webview script started (and said "ready"). */
  readyCount = 0;
  model: EnvModel = { envs: [] };

  static async show(extensionUri: vscode.Uri, envs: EnvironmentManager): Promise<EnvEditorPanel> {
    if (EnvEditorPanel.current) {
      EnvEditorPanel.current.panel.reveal(undefined, false);
      return EnvEditorPanel.current;
    }
    const p = new EnvEditorPanel(extensionUri, envs);
    EnvEditorPanel.current = p;
    await p.load();
    return p;
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly envs: EnvironmentManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('plainwire.environments', 'Environments', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tab-icon.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m)),
      this.panel.onDidDispose(() => this.dispose()),
      envs.onDidChange(() => this.post({ type: 'active', active: this.envs.selected ?? null })),
    );
  }

  /** Handle a message from the webview. Returns what `save` wrote (used by the e2e test). */
  async handle(m: FromWebview): Promise<{ wrote: string[] } | undefined> {
    try {
      switch (m.type) {
        case 'ready':
          this.readyCount++;
          this.postLoad();
          return;
        case 'dirty':
          this.dirty = m.dirty;
          return;
        case 'save':
          return await this.save(m.model, !!m.force);
        case 'reload':
          await this.load(this.folder);
          return;
        case 'folder':
          await this.load(this.folders.find((f) => f.toString() === m.value));
          return;
        case 'openJson':
          await this.openJson(m.which, m.env, m.name);
          return;
        case 'addGitignore':
          await this.addGitignore();
          return;
        case 'activate':
          // The status bar item and every open request tab follow (EnvironmentManager.onDidChange).
          await this.envs.select(m.name);
          return;
      }
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  /** (Re)read the file pair of `folder` (default: the current one, else the first folder found). */
  private async load(folder?: vscode.Uri, notice?: string): Promise<void> {
    this.folders = await envFolders();
    if (folder && !this.folders.some((f) => f.toString() === folder.toString())) this.folders.push(folder);
    this.folder = folder ?? this.folder ?? this.folders[0];
    this.error = undefined;
    this.dirty = false;
    if (!this.folder) {
      this.error = 'Open a folder first: the environment files are stored in the workspace.';
      this.model = { envs: [] };
      this.postLoad();
      return;
    }
    const pubUri = vscode.Uri.joinPath(this.folder, PUBLIC);
    const privUri = vscode.Uri.joinPath(this.folder, PRIVATE);
    this.pub = { uri: pubUri, text: await readFileText(pubUri) };
    this.priv = { uri: privUri, text: await readFileText(privUri) };
    for (const f of [this.pub, this.priv]) {
      if (f.text === undefined) continue;
      try {
        f.json = JSON.parse(f.text);
      } catch (e) {
        this.error = `${vscode.workspace.asRelativePath(f.uri)} is not valid JSON (${(e as Error).message}). Fix it in the JSON editor, then reload.`;
        continue;
      }
      if (!f.json || typeof f.json !== 'object' || Array.isArray(f.json)) this.error = `${vscode.workspace.asRelativePath(f.uri)} is not a JSON object.`;
    }
    this.model = this.error ? { envs: [] } : modelFromFiles(this.pub.json, this.priv.json);
    this.watch();
    this.postLoad(notice);
  }

  private watch(): void {
    this.watcher?.dispose();
    if (!this.folder) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, 'http-client{.env,.private.env}.json'));
    const on = () => void this.onDiskChange();
    w.onDidChange(on);
    w.onDidCreate(on);
    w.onDidDelete(on);
    this.watcher = w;
  }

  /** The files changed on disk: reload if there are no unsaved edits, otherwise warn. Our own saves are ignored. */
  private async onDiskChange(): Promise<void> {
    if (!this.pub || !this.priv) return;
    const [a, b] = [await readFileText(this.pub.uri), await readFileText(this.priv.uri)];
    if (a === this.pub.text && b === this.priv.text) return;
    if (this.dirty) this.post({ type: 'conflict' });
    else await this.load(this.folder, 'Reloaded: the files changed on disk.');
  }

  private async gitignore(): Promise<GitignoreState> {
    if (!this.priv) return { state: 'none' };
    const ws = vscode.workspace.getWorkspaceFolder(this.priv.uri);
    if (!ws) return { state: 'none' };
    const rootIgnore = vscode.Uri.joinPath(ws.uri, '.gitignore');
    const rel = this.priv.uri.path.slice(ws.uri.path.replace(/\/$/, '').length + 1);
    const dirs = rel.split('/').slice(0, -1);
    // .gitignore files from the workspace folder down to the env folder; a deeper one can also cover the file.
    let covered = false;
    let rootExists = false;
    for (let i = 0; i <= dirs.length; i++) {
      const dir = vscode.Uri.joinPath(ws.uri, ...dirs.slice(0, i));
      const text = await readFileText(vscode.Uri.joinPath(dir, '.gitignore'));
      if (text === undefined) continue;
      if (i === 0) rootExists = true;
      if (gitignoreCovers(text, [...dirs.slice(i), PRIVATE].join('/'))) covered = true;
    }
    if (covered) return { state: 'covered' };
    if (rootExists) return { state: 'missing', uri: rootIgnore };
    // A git repository without a .gitignore yet: `git add .` would commit the secrets, so offer to create one.
    const isRepo = await vscode.workspace.fs.stat(vscode.Uri.joinPath(ws.uri, '.git')).then(() => true, () => false);
    return isRepo ? { state: 'missing', uri: rootIgnore } : { state: 'none' };
  }

  private async addGitignore(): Promise<void> {
    const g = await this.gitignore();
    if (g.state !== 'missing' || !g.uri) return this.postLoad();
    const text = (await readFileText(g.uri)) ?? '';
    const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    await vscode.workspace.fs.writeFile(g.uri, new TextEncoder().encode(`${text}${sep}# Secrets for .http requests (Plainwire / JetBrains HTTP Client / REST Client)\n${PRIVATE}\n`));
    void vscode.window.setStatusBarMessage(`$(check) Added ${PRIVATE} to .gitignore`, 3000);
    this.postLoad();
  }

  private postLoad(notice?: string): void {
    void this.gitignore().then((git) =>
      this.post({
        type: 'load',
        model: this.model,
        error: this.error ?? null,
        notice: notice ?? null,
        folders: this.folders.map((f) => ({ value: f.toString(), label: folderLabel(f) })),
        folder: this.folder?.toString() ?? null,
        files: {
          public: { label: this.pub ? vscode.workspace.asRelativePath(this.pub.uri) : PUBLIC, exists: this.pub?.text !== undefined },
          private: { label: this.priv ? vscode.workspace.asRelativePath(this.priv.uri) : PRIVATE, exists: this.priv?.text !== undefined },
        },
        gitignore: git.state,
        active: this.envs.selected ?? null,
      }),
    );
  }

  private async save(model: EnvModel, force: boolean): Promise<{ wrote: string[] } | undefined> {
    if (!this.pub || !this.priv || this.error) throw new Error(this.error ?? 'Nothing to save.');
    const [a, b] = [await readFileText(this.pub.uri), await readFileText(this.priv.uri)];
    if (!force && (a !== this.pub.text || b !== this.priv.text)) {
      this.post({ type: 'conflict' });
      return;
    }
    const r = writeFiles(model, this.pub.json, this.priv.json);
    const wrote: string[] = [];
    // Remember what we write first, so the watcher sees our own save as "no change".
    if (r.publicChanged) this.pub.text = r.publicText;
    if (r.privateChanged) this.priv.text = r.privateText;
    if (r.privateChanged) {
      await vscode.workspace.fs.writeFile(this.priv.uri, new TextEncoder().encode(r.privateText));
      wrote.push(vscode.workspace.asRelativePath(this.priv.uri));
    }
    if (r.publicChanged) {
      await vscode.workspace.fs.writeFile(this.pub.uri, new TextEncoder().encode(r.publicText));
      wrote.push(vscode.workspace.asRelativePath(this.pub.uri));
    }
    await this.load(this.folder, wrote.length ? `Saved ${wrote.join(' and ')}.` : 'No changes to save.');
    return { wrote };
  }

  private async openJson(which: Which, env?: string, name?: string): Promise<void> {
    const f = which === 'private' ? this.priv : this.pub;
    if (!f) return;
    if ((await readFileText(f.uri)) === undefined) {
      void vscode.window.showInformationMessage(`${vscode.workspace.asRelativePath(f.uri)} does not exist yet; it is created when you save.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(f.uri);
    let offset = 0;
    if (env !== undefined) {
      const text = doc.getText();
      const at = text.indexOf(JSON.stringify(env) + ':');
      const at2 = at >= 0 ? text.indexOf(JSON.stringify(name ?? '') + ':', at) : -1;
      offset = name !== undefined && at2 >= 0 ? at2 : Math.max(at, 0);
    }
    const pos = doc.positionAt(offset);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; img-src ${w.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${media('panel.css')}"><link rel="stylesheet" href="${media('envEditor.css')}"><title>Environments</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${media('envEditor.js')}"></script></body></html>`;
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (EnvEditorPanel.current === this) EnvEditorPanel.current = undefined;
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
