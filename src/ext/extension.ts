import * as vscode from 'vscode';
import type { CodeTarget } from '../core/codegen.ts';
import { parseCurl } from '../core/curl.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import type { HttpRequest } from '../core/model.ts';
import { RequestCodeLens } from './codelens.ts';
import { ImportLinkProvider } from './links.ts';
import { CodeCopier } from './copyCode.ts';
import { CookieStore } from './cookies.ts';
import { EnvironmentManager } from './environments.ts';
import { History, type HistoryEntry } from './history.ts';
import { importFromFiles, importFromUrl, importOpenApi, writeCollections } from './importer.ts';
import { detectAndImport } from '../core/importers/index.ts';
import { RequestPanel, type PanelDeps } from './panel.ts';
import { readText, Runner } from './runner.ts';
import { filesFor, RunAllPanel } from './runAll.ts';
import { CollectionsProvider, HistoryProvider, type RequestNode } from './tree.ts';

interface At {
  uri: vscode.Uri;
  index: number;
}

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const envs = new EnvironmentManager(context.workspaceState);
  const history = new History(context.workspaceState);
  const cookies = new CookieStore(context.workspaceState);
  const runner = new Runner(envs, history, cookies);
  const copier = new CodeCopier(runner, context.globalState);
  const deps: PanelDeps = { extensionUri: context.extensionUri, runner, envs, copier };
  const output = vscode.window.createOutputChannel('Plainwire');
  const collections = new CollectionsProvider();
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
    vscode.window.registerTreeDataProvider('plainwire.collections', collections),
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
    vscode.commands.registerCommand('plainwire.runAll', guard(async () => {
      const files = await filesFor(null);
      if (!files.length) throw new Error('No .http or .rest files in this workspace.');
      return RunAllPanel.run(runner, files, `workspace (${files.length} files)`, (uri, index) => void vscode.commands.executeCommand('plainwire.openAt', { uri, index }));
    })),
    vscode.commands.registerCommand('plainwire.selectEnvironment', guard(() => envs.pick())),
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
    parseHttpFileForTest: parseHttpFile,
    importTextForTest: (text: string, name: string, out: vscode.OutputChannel) => writeCollections(detectAndImport(text, name), out),
  };
}

export function deactivate(): void {}
