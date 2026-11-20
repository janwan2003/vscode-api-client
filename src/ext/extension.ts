import * as vscode from 'vscode';
import type { CodeTarget } from '../core/codegen.ts';
import { parseCurl } from '../core/curl.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import type { HttpRequest } from '../core/model.ts';
import { RequestCodeLens } from './codelens.ts';
import { ImportLinkProvider } from './links.ts';
import { CodeCopier } from './copyCode.ts';
import { CookieStore } from './cookies.ts';
import { EnvEditorPanel } from './envEditor.ts';
import { EnvironmentManager } from './environments.ts';
import { History, type HistoryEntry } from './history.ts';
import { importFromFiles, importFromUrl, importOpenApi, writeCollections } from './importer.ts';
import { detectAndImport } from '../core/importers/index.ts';
import { RequestPanel, type PanelDeps } from './panel.ts';
import { readText, Runner } from './runner.ts';
import { filesFor, RunAllPanel } from './runAll.ts';
import { CollectionsProvider, HistoryProvider, type RequestNode } from './tree.ts';
import { Organizer } from './organize.ts';

interface At {
  uri: vscode.Uri;
  index: number;
}

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const envs = new EnvironmentManager(context.workspaceState);
  const history = new History(context.workspaceState);
  const cookies = new CookieStore(context.workspaceState);
  const output = vscode.window.createOutputChannel('Plainwire');
  const runner = new Runner(envs, history, cookies, (m) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`), context.workspaceState);
  const copier = new CodeCopier(runner, context.globalState);
  const deps: PanelDeps = { extensionUri: context.extensionUri, runner, envs, copier, ui: context.globalState };
  const collections = new CollectionsProvider();
  const organizer = new Organizer(deps, collections);
  void envs.reload();

  const requestAt = async (at: At): Promise<HttpRequest> => {
    const r = parseHttpFile(await readText(at.uri)).requests[at.index];
    if (!r) throw new Error('That request no longer exists in the file.');
    return r;
  };
  const guard =
    <A extends unknown[]>(fn: (...a: A) => unknown) =>
    async (...a: A) => {
      try {
        return await fn(...a);
      } catch (e) {
        void vscode.window.showErrorMessage(`Plainwire: ${(e as Error).message}`);
      }
    };

  /** Request under the cursor in the active .http editor. */
  const atCursor = (): At | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return undefined;
    const line = ed.selection.active.line;
    const reqs = parseHttpFile(ed.document.getText()).requests;
    const index = reqs.findIndex((r) => line >= r.startLine && line < r.endLine);
    return index >= 0 ? { uri: ed.document.uri, index } : undefined;
  };

  context.subscriptions.push(
    envs,
    history,
    output,
    collections,
    (organizer.view = vscode.window.createTreeView('plainwire.collections', { treeDataProvider: collections, dragAndDropController: organizer, canSelectMany: true, showCollapseAll: true })),
    ...organizer.commands(),
    vscode.window.registerTreeDataProvider('plainwire.history', new HistoryProvider(history)),
    vscode.languages.registerCodeLensProvider([{ language: 'http' }, { pattern: '**/*.{http,rest}' }], new RequestCodeLens()),
    vscode.languages.registerDocumentLinkProvider([{ language: 'http' }, { pattern: '**/*.{http,rest}' }], new ImportLinkProvider()),

    vscode.commands.registerCommand('plainwire.newRequest', () => RequestPanel.show(deps, { method: 'GET', url: '', headers: [] }, { kind: 'scratch' })),
    vscode.commands.registerCommand('plainwire.openRequest', (n: RequestNode) => RequestPanel.show(deps, n.request, { kind: 'file', uri: n.uri, index: n.index })),
    vscode.commands.registerCommand('plainwire.sendRequest', guard(async (n: RequestNode) => RequestPanel.show(deps, await requestAt(n), { kind: 'file', uri: n.uri, index: n.index }, undefined, true))),
    vscode.commands.registerCommand('plainwire.openAt', guard(async (at: At) => RequestPanel.show(deps, await requestAt(at), { kind: 'file', ...at }))),
    vscode.commands.registerCommand('plainwire.sendAt', guard(async (at: At) => RequestPanel.show(deps, await requestAt(at), { kind: 'file', ...at }, undefined, true))),
    vscode.commands.registerCommand('plainwire.sendAtCursor', guard(async () => {
      const at = atCursor();
      if (!at) throw new Error('Put the cursor inside a request in a .http file.');
      RequestPanel.show(deps, await requestAt(at), { kind: 'file', ...at }, undefined, true);
    })),
    vscode.commands.registerCommand('plainwire.copyCurlAt', guard(async (at?: At | RequestNode) => {
      const target = at ?? atCursor();
      if (!target) throw new Error('Put the cursor inside a request in a .http file.');
      return copier.copy(await requestAt(target), target.uri, 'curl');
    })),
    // Optional second argument: a language id from CODE_TARGETS in core/codegen.ts (skips the picker).
    vscode.commands.registerCommand('plainwire.copyAsCode', guard(async (at?: At | RequestNode, language?: CodeTarget) => {
      const target = at ?? atCursor();
      if (!target) throw new Error('Put the cursor inside a request in a .http file.');
      return copier.copy(await requestAt(target), target.uri, language);
    })),
    vscode.commands.registerCommand('plainwire.revealRequest', guard(async (n: RequestNode) => {
      const doc = await vscode.workspace.openTextDocument(n.uri);
      const pos = new vscode.Position(n.request.requestLine, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    })),
    vscode.commands.registerCommand('plainwire.openHistory', (e: HistoryEntry) => {
      const uri = e.file ? vscode.Uri.parse(e.file) : undefined;
      RequestPanel.show(deps, e.request, { kind: 'scratch' }, e.response);
      void uri;
    }),
    vscode.commands.registerCommand('plainwire.manageCookies', guard(() => cookies.manage())),
    vscode.commands.registerCommand('plainwire.clearCookies', guard(async () => {
      const n = cookies.jar.size;
      await cookies.clear();
      void vscode.window.showInformationMessage(`Plainwire: ${n} cookie${n === 1 ? '' : 's'} cleared.`);
    })),
    // Optional argument: the auth id (skips the picker).
    vscode.commands.registerCommand('plainwire.acquireOAuthToken', guard(async (id?: string) => {
      if (typeof id !== 'string') {
        const ids = runner.authIds();
        if (!ids.length) throw new Error(`No OAuth 2 configuration in ${envs.selected ? `environment "${envs.selected}"` : 'the shared environment (select an environment first)'}. Add "Security": { "Auth": { "my-api": { "Type": "OAuth2", ... } } } to http-client.env.json.`);
        id = ids.length === 1 ? ids[0] : await vscode.window.showQuickPick(ids, { placeHolder: 'Acquire a new OAuth 2 token for' });
        if (!id) return;
      }
      const authId = id;
      const t = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Plainwire: signing in to "${authId}"…`, cancellable: true }, (_p, token) => runner.acquireToken(authId, token));
      const mins = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 60000)) : undefined;
      void vscode.window.showInformationMessage(`Plainwire: token for "${authId}" acquired${mins !== undefined ? `, expires in ${mins} min` : ''}${t.hasRefresh ? ' (will refresh automatically)' : ''}. Use it as {{$auth.token("${authId}")}}.`);
      return t;
    })),
    vscode.commands.registerCommand('plainwire.clearOAuthTokens', () => {
      const n = runner.oauth2.size;
      runner.oauth2.clear();
      void vscode.window.showInformationMessage(`Plainwire: ${n} OAuth 2 token${n === 1 ? '' : 's'} cleared; the next request signs in again.`);
    }),
    vscode.commands.registerCommand('plainwire.clearScriptVariables', guard(async () => {
      const g = runner.globals;
      if (!g.size) {
        void vscode.window.showInformationMessage('Plainwire: no script variables are set (scripts set them with client.global.set).');
        return;
      }
      const names = [...g.keys()];
      const pick = await vscode.window.showQuickPick([{ label: '$(clear-all) Clear all', all: true }, ...names.map((n) => ({ label: n, description: preview(g.get(n) ?? ''), all: false }))], {
        title: `Script variables (client.global): ${names.length}`,
        placeHolder: 'Pick one to clear it, or clear all',
      });
      if (!pick) return;
      if (pick.all) g.clear();
      else g.delete(pick.label);
      await context.workspaceState.update('plainwire.scriptGlobals', [...g]);
      void vscode.window.showInformationMessage(pick.all ? `Plainwire: ${names.length} script variable${names.length === 1 ? '' : 's'} cleared.` : `Plainwire: script variable "${pick.label}" cleared.`);
    })),
    vscode.commands.registerCommand('plainwire.clearHistory', guard(async () => {
      const ok = await vscode.window.showWarningMessage('Clear Plainwire request history for this workspace?', { modal: true }, 'Clear');
      if (ok) await history.clear();
    })),
    vscode.commands.registerCommand('plainwire.refresh', () => {
      collections.refresh();
      void envs.reload();
    }),
    vscode.commands.registerCommand('plainwire.runFile', guard(async (target?: unknown) => {
      const files = await filesFor(target);
      if (!files.length) throw new Error('No .http or .rest files to run.');
      const title = files.length === 1 ? vscode.workspace.asRelativePath(files[0]) : target ? `${vscode.workspace.asRelativePath(target instanceof vscode.Uri ? target : (target as { uri: vscode.Uri }).uri)} (${files.length} files)` : `workspace (${files.length} files)`;
      return RunAllPanel.run(runner, files, title, (uri, index) => void vscode.commands.executeCommand('plainwire.openAt', { uri, index }));
    })),
    vscode.commands.registerCommand('plainwire.runFolder', (target?: unknown) => vscode.commands.executeCommand('plainwire.runFile', target)),
    vscode.commands.registerCommand('plainwire.runAll', guard(async () => {
      const files = await filesFor(null);
      if (!files.length) throw new Error('No .http or .rest files in this workspace.');
      return RunAllPanel.run(runner, files, `workspace (${files.length} files)`, (uri, index) => void vscode.commands.executeCommand('plainwire.openAt', { uri, index }));
    })),
    vscode.commands.registerCommand('plainwire.selectEnvironment', guard(() => envs.pick())),
    vscode.commands.registerCommand('plainwire.editEnvironments', guard(() => EnvEditorPanel.show(context.extensionUri, envs))),
    vscode.commands.registerCommand('plainwire.createEnvFile', guard(async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) throw new Error('Open a folder first.');
      const uri = vscode.Uri.joinPath(root, 'http-client.env.json');
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        const sample = { $shared: { userAgent: 'plainwire' }, dev: { host: 'http://localhost:3000' }, prod: { host: 'https://api.example.com' } };
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(sample, null, 2) + '\n'));
      }
      await vscode.window.showTextDocument(uri);
      void vscode.window.showInformationMessage('Use variables as {{host}}. Put secrets in http-client.private.env.json and add it to .gitignore.');
      await envs.reload();
    })),
    vscode.commands.registerCommand('plainwire.importThunder', guard(() => importFromFiles('thunder', output))),
    vscode.commands.registerCommand('plainwire.importPostman', guard(() => importFromFiles('postman', output))),
    vscode.commands.registerCommand('plainwire.importOpenApi', guard(() => importOpenApi(output))),
    vscode.commands.registerCommand('plainwire.importCurl', guard(async () => {
      const clip = (await vscode.env.clipboard.readText()).trim();
      const value = /^curl\s/i.test(clip) ? clip : '';
      const text = await vscode.window.showInputBox({ prompt: 'Paste a cURL command', value, placeHolder: "curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{\"a\":1}'", ignoreFocusOut: true });
      if (!text) return;
      RequestPanel.show(deps, parseCurl(text), { kind: 'scratch' });
    })),
  );

  // Exposed for the integration tests in test/e2e.
  return {
    deps,
    importUrlForTest: (url: string) => importFromUrl(url, output),
    historyForTest: history,
    cookiesForTest: cookies,
    oauth2ForTest: runner.oauth2,
    envEditorForTest: () => EnvEditorPanel.current,
    envsForTest: envs,
    collectionsForTest: collections,
    organizerForTest: organizer,
    parseHttpFileForTest: parseHttpFile,
    importTextForTest: (text: string, name: string, out: vscode.OutputChannel) => writeCollections(detectAndImport(text, name), out),
  };
}

export function deactivate(): void {}

/** A variable value for a quick pick: one line, at most 60 characters. */
function preview(v: string): string {
  const one = v.replace(/\s+/g, ' ');
  return one.length > 60 ? one.slice(0, 57) + '…' : one;
}
