import * as vscode from 'vscode';
import { attachEnvironments, collectionsToFiles, detectAndImport } from '../core/importers/index.ts';
import { describeThunderStore, readThunderStore } from '../core/importers/thunderStore.ts';
import { findThunderData, inspectThunderDir, readThunderDir, THUNDER_EXTENSION_ID, type ThunderCandidate, type ThunderLocation } from '../core/thunderLocate.ts';
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
let revealImported: ((first: vscode.Uri) => Promise<void>) | undefined;
/** Set by activate(): after an import, show the new files in Plainwire's Requests view (switchers expect their collection there). */
export function onImported(fn: (first: vscode.Uri) => Promise<void>): void {
  revealImported = fn;
}

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
  if (firstHttp) {
    await vscode.window.showTextDocument(firstHttp, { preview: false });
    await revealImported?.(firstHttp).catch((e) => output.appendLine(`Could not show the import in the Requests view: ${(e as Error).message}`));
  }
  const msg = `Plainwire: imported ${requests} request${requests === 1 ? '' : 's'} into ${written.length} file${written.length === 1 ? '' : 's'} under ${folder}/.`;
  // Not awaited: the notification resolves only when the user dismisses it.
  void vscode.window
    .showInformationMessage(warnings.length ? `${msg} ${warnings.length} item(s) could not be converted.` : msg, ...(warnings.length ? ['Show details'] : []))
    .then((choice) => choice && output.show());
}

const DIALOG = {
  thunder: { filters: { 'Thunder Client data': ['json', 'db'] }, title: 'Thunder Client export (.json) or data file (thunderclient.db, tc_col_*.json, thunderActivity.json)' },
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
  if (kind === 'thunder') return importThunderLocal(output);
  return importChosenFiles(kind, output);
}

async function importChosenFiles(kind: 'thunder' | 'postman' | 'openapi', output: vscode.OutputChannel): Promise<void> {
  const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Import', ...DIALOG[kind] });
  if (!uris?.length) return;
  const collections: ImportedCollection[] = [];
  for (const u of uris) {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
    collections.push(...detectAndImport(text, u.path.split('/').pop()));
  }
  await writeCollections(collections, output);
}

/** Where this editor keeps extension data: Thunder Client's folder is a sibling of ours. Set by activate(). */
let ownStorage: vscode.Uri | undefined;
export function setOwnStorage(uri: vscode.Uri): void {
  ownStorage = uri;
}

/**
 * Folders that may hold Thunder Client data, most specific first: the workspace's thunder-tests
 * (Save to Workspace), any folder named in Thunder Client's own settings (Custom Location /
 * Workspace Relative Path), this editor's Thunder storage folder, then every editor's (thunderLocate.ts).
 */
function extraThunderDirs(): ThunderCandidate[] {
  const out: ThunderCandidate[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root?.scheme === 'file') out.push({ dir: vscode.Uri.joinPath(root, 'thunder-tests').fsPath, label: 'this workspace (thunder-tests)' });
  const cfg = vscode.workspace.getConfiguration('thunder-client') as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!/location|path|folder|dir/i.test(key)) continue;
    let dir = value.trim().replace(/^\$HOME(?=[\\/]|$)|^~(?=[\\/]|$)/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
    if (!/^([a-z]:)?[\\/]/i.test(dir) && root?.scheme === 'file') dir = vscode.Uri.joinPath(root, dir).fsPath;
    out.push({ dir, label: `Thunder Client setting "${key}"` });
    out.push({ dir: dir.replace(/[\\/]+$/, '') + '/thunder-tests', label: `Thunder Client setting "${key}"` });
  }
  // Desktop VS Code gives globalStorageUri the `vscode-userdata:` scheme (1.147), not `file:`; both are local paths.
  if (ownStorage && (ownStorage.scheme === 'file' || ownStorage.scheme === 'vscode-userdata')) out.push({ dir: vscode.Uri.joinPath(ownStorage, '..', THUNDER_EXTENSION_ID).fsPath, label: `${vscode.env.appName}` });
  return out;
}

/** Thunder Client data on this computer, most recently changed first. */
export function findLocalThunderData(): ThunderLocation[] {
  return findThunderData(extraThunderDirs());
}

/** One-time offer at startup when Thunder Client data exists on this computer (setting plainwire.offerThunderImport). */
export async function offerThunderImport(state: vscode.Memento, output: vscode.OutputChannel): Promise<void> {
  const KEY = 'plainwire.thunderImportOffered';
  if (state.get<boolean>(KEY) || !vscode.workspace.getConfiguration('plainwire').get<boolean>('offerThunderImport', true)) return;
  if (!vscode.workspace.workspaceFolders?.length) return; // imports are written into a workspace folder
  const found = findLocalThunderData().filter((l) => l.summary.requests > 0);
  if (!found.length) return;
  await state.update(KEY, true);
  const [first] = found;
  const where = found.length > 1 ? `${found.length} places (newest: ${first.label})` : first.label;
  const pick = await vscode.window.showInformationMessage(
    `Plainwire found Thunder Client data from ${where}: ${describeThunderStore(first.summary)}. Import it as .http files in this workspace? No export or login needed; nothing leaves your computer.`,
    'Import',
    "Don't ask again",
  );
  if (pick === 'Import') await importThunderLocal(output, found);
}

/** Pick a Thunder Client data folder found on this computer (or a file / folder) and import it. */
export async function importThunderLocal(output: vscode.OutputChannel, found?: ThunderLocation[]): Promise<void> {
  const locations = found ?? findLocalThunderData();
  type Item = vscode.QuickPickItem & { loc?: ThunderLocation; id?: 'files' | 'folder' };
  const items: Item[] = locations.map((loc) => ({
    label: `$(database) ${loc.label}`,
    description: loc.modified ? `changed ${new Date(loc.modified).toLocaleDateString()}` : undefined,
    detail: `${describeThunderStore(loc.summary)} · ${loc.dir}`,
    loc,
  }));
  if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push(
    { label: '$(file) Choose exported or data file(s)…', detail: 'A collection or environment export (.json), thunderclient.db, tc_col_*.json, thunderActivity.json', id: 'files' },
    { label: '$(folder) Choose a folder…', detail: "A thunder-tests folder, Thunder Client's Custom Location, or a copy of its storage folder", id: 'folder' },
  );
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: locations.length ? 'Thunder Client data found on this computer. Choose what to import (nothing is sent anywhere)' : 'No Thunder Client data found in the usual places. Choose a file or folder',
    matchOnDetail: true,
  });
  if (!pick) return;
  if (pick.id === 'files') return importChosenFiles('thunder', output);
  let loc = pick.loc;
  if (pick.id === 'folder') {
    const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Import', title: 'Folder with Thunder Client data' });
    if (!dirs?.length) return;
    loc = inspectThunderDir({ dir: dirs[0].fsPath, label: dirs[0].fsPath });
    if (!loc) throw new Error(`No Thunder Client collections, requests or environments found in ${dirs[0].fsPath}.`);
  }
  if (!loc) return;
  let history = false;
  if (loc.summary.history) {
    const h = await vscode.window.showQuickPick(
      [
        { label: 'Collections and environments', detail: describeThunderStore({ ...loc.summary, history: 0 }), history: false },
        { label: 'Also the history', detail: `Adds the ${loc.summary.history} distinct requests from Thunder's Activity tab as one "Thunder Client history" file`, history: true },
      ],
      { placeHolder: 'Import the history too?' },
    );
    if (!h) return;
    history = h.history;
  }
  await importThunderLocation(loc, history, output);
}

/** Convert one Thunder Client data folder and write it into the workspace (no UI before the write). */
export async function importThunderLocation(loc: ThunderLocation, history: boolean, output: vscode.OutputChannel): Promise<void> {
  const store = readThunderStore(loc.files.length ? loc.files : readThunderDir(loc.dir), { history });
  for (const s of store.skipped) output.appendLine(`Skipped ${s}`);
  if (!store.collections.length) throw new Error(`No Thunder Client collections found in ${loc.dir}.`);
  output.appendLine(`Thunder Client data from ${loc.label}: ${loc.dir}`);
  await writeCollections(store.collections, output);
}
