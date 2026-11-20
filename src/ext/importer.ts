import * as vscode from 'vscode';
import { attachEnvironments, collectionsToFiles, detectAndImport } from '../core/importers/index.ts';
import { importThunderWorkspace } from '../core/importers/thunder.ts';
import { fetchText } from '../core/fetchText.ts';
import type { ImportedCollection } from '../core/model.ts';
import { vscodeSendOptions } from './runner.ts';

async function readJson(uri: vscode.Uri): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Write imported collections as .http files under `<workspace>/<plainwire.importFolder>/`. */
export async function writeCollections(imported: ImportedCollection[], output: vscode.OutputChannel): Promise<void> {
  const collections = attachEnvironments(imported);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('Open a folder first: imported requests are saved as .http files in your workspace.');
  const folder = vscode.workspace.getConfiguration('plainwire').get<string>('importFolder', 'http');
  const written: vscode.Uri[] = [];
  let requests = 0;
  const warnings: string[] = [];
  for (const c of collections) {
    requests += c.folders.reduce((n, f) => n + f.requests.length, 0);
    warnings.push(...c.warnings.map((w) => `${c.name}: ${w}`));
  }
  for (const f of collectionsToFiles(collections)) {
    let target = vscode.Uri.joinPath(root, folder, f.path);
    for (let n = 2; await exists(target); n++) target = vscode.Uri.joinPath(root, folder, f.path.replace(/(\.[^./]+)$/, `-${n}$1`));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(f.content));
    written.push(target);
  }
  output.appendLine(`[${new Date().toLocaleTimeString()}] Imported ${requests} requests into ${written.length} files:`);
  for (const w of written) output.appendLine(`  ${vscode.workspace.asRelativePath(w)}`);
  if (warnings.length) {
    output.appendLine('Not converted:');
    for (const w of warnings) output.appendLine(`  - ${w}`);
  }
  const firstHttp = written.find((w) => w.path.endsWith('.http'));
  if (firstHttp) await vscode.window.showTextDocument(firstHttp, { preview: false });
  const msg = `Plainwire: imported ${requests} request${requests === 1 ? '' : 's'} into ${written.length} file${written.length === 1 ? '' : 's'} under ${folder}/.`;
  // Not awaited: the notification resolves only when the user dismisses it.
  void vscode.window
    .showInformationMessage(warnings.length ? `${msg} ${warnings.length} item(s) could not be converted.` : msg, ...(warnings.length ? ['Show details'] : []))
    .then((choice) => choice && output.show());
}

const DIALOG = {
  thunder: { filters: { 'JSON export': ['json'] }, title: 'Thunder Client collection or environment export (.json)' },
  postman: { filters: { 'JSON export': ['json'] }, title: 'Postman collection v2.0/v2.1 or environment export (.json)' },
  openapi: { filters: { 'OpenAPI / Swagger': ['json', 'yaml', 'yml'] }, title: 'OpenAPI 3.x or Swagger 2.0 definition (.json, .yaml)' },
};

/** Ask where an OpenAPI definition comes from: a file (the usual dialog) or a URL. */
export async function importOpenApi(output: vscode.OutputChannel): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(file) From a file…', id: 'file', detail: 'A .json, .yaml or .yml definition on disk' },
      { label: '$(globe) From a URL…', id: 'url', detail: 'For example https://petstore3.swagger.io/api/v3/openapi.json' },
    ],
    { placeHolder: 'Import an OpenAPI 3.x or Swagger 2.0 definition' },
  );
  if (!pick) return;
  if (pick.id === 'file') return importFromFiles('openapi', output);
  const url = await vscode.window.showInputBox({
    prompt: 'URL of an OpenAPI / Swagger definition (JSON or YAML). Plainwire sends one GET request to it.',
    placeHolder: 'https://api.example.com/openapi.json',
    ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'Enter an http:// or https:// URL'),
  });
  if (!url) return;
  await importFromUrl(url, output);
}

/** Download a definition or collection export and import it (the URL's file name names the collection). */
export async function importFromUrl(url: string, output: vscode.OutputChannel): Promise<void> {
  const got = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Plainwire: downloading ${url}` }, () => fetchText(url, vscodeSendOptions()));
  await writeCollections(detectAndImport(got.text, got.fileName, got.url), output);
}

export async function importFromFiles(kind: 'thunder' | 'postman' | 'openapi', output: vscode.OutputChannel): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (kind === 'thunder' && root) {
    // Thunder Client's "save to workspace" folder.
    const tt = vscode.Uri.joinPath(root, 'thunder-tests');
    if (await exists(tt)) {
      const pick = await vscode.window.showQuickPick(['Import the thunder-tests folder in this workspace', 'Choose exported JSON file(s)…'], { placeHolder: 'Found a thunder-tests folder' });
      if (!pick) return;
      if (pick.startsWith('Import the')) return importThunderFolder(tt, output);
    }
  }
  const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Import', ...DIALOG[kind] });
  if (!uris?.length) return;
  const collections: ImportedCollection[] = [];
  for (const u of uris) {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
    collections.push(...detectAndImport(text, u.path.split('/').pop()));
  }
  await writeCollections(collections, output);
}

async function importThunderFolder(dir: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const read = async (name: string) => ((await exists(vscode.Uri.joinPath(dir, name))) ? readJson(vscode.Uri.joinPath(dir, name)) : undefined);
  const collections: ImportedCollection[] = [];
  const legacy = { collections: await read('thunderCollection.json'), requests: await read('thunderclient.json'), environments: await read('thunderEnvironment.json') };
  if (legacy.collections || legacy.requests) collections.push(...importThunderWorkspace(legacy));
  // Newer layout: one JSON file per collection / environment in sub-folders.
  for (const sub of ['collections', 'environments']) {
    const d = vscode.Uri.joinPath(dir, sub);
    if (!(await exists(d))) continue;
    for (const [name, type] of await vscode.workspace.fs.readDirectory(d)) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(d, name)));
      try {
        collections.push(...detectAndImport(text, name));
      } catch (e) {
        output.appendLine(`Skipped ${sub}/${name}: ${(e as Error).message}`);
      }
    }
  }
  if (!collections.length) throw new Error('No Thunder Client collections found in thunder-tests/.');
  await writeCollections(collections, output);
}
