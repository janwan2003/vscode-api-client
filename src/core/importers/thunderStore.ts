import type { ImportedCollection } from '../model.ts';
import { arr, isObj, str } from './postman.ts';
import { importThunder, importThunderWorkspace } from './thunder.ts';

/**
 * Read Thunder Client's own data files, wherever they are: the extension's storage folder
 * (`<editor>/User/globalStorage/rangav.vscode-thunder-client/`, which Thunder's docs describe as
 * holding `collections/` and `environments/` folders), a workspace `thunder-tests/` folder, or a
 * "custom location". Users do not need Thunder Client (or its login) to export anything.
 *
 * Every layout seen in the wild is accepted, and records are classified by their shape rather than
 * by file name, so layouts we have not seen (Thunder's "Database Format v4", one file per request)
 * still import as long as the records keep their fields:
 *  - per-collection JSON files `collections/tc_col_*.json` ({ _id, colName, folders, requests, settings });
 *  - per-environment JSON files `environments/tc_env_*.json` ({ name, data: [{ name, value }] });
 *  - the legacy single files `thunderCollection.json`, `thunderclient.json`, `thunderEnvironment.json`,
 *    `thunderActivity.json` (JSON arrays);
 *  - the older NeDB databases `thunderclient.db`, `thunderCollection.db`, `thunderEnvironment.db`,
 *    `thunderActivity.db`: one JSON record per line, where a later line with the same `_id` replaces
 *    the earlier one and `{"$$deleted": true}` removes it;
 *  - a collection export ({ clientName: "Thunder Client", collectionName, requests }).
 * Request history (`colId: "history"`, the "Activity" tab) is imported only when asked, as one
 * `Thunder Client history` collection, newest first, duplicates (same method, URL and body) dropped.
 * Pure: no file system access, so the website converter can use it too.
 */

export interface ThunderFile {
  /** Path relative to the folder being imported, `/`-separated (used for skipping backups and grouping). */
  path: string;
  text: string;
}

export interface ThunderStoreSummary {
  collections: number;
  requests: number;
  environments: number;
  /** History entries after removing duplicates (counted even when history is not imported). */
  history: number;
}

export interface ThunderStore {
  collections: ImportedCollection[];
  summary: ThunderStoreSummary;
  /** Files that were not Thunder data or not readable, with the reason. */
  skipped: string[];
}

type Obj = Record<string, unknown>;

/** Backup copies that Thunder Client and users leave next to the live data (`backup/`, `_db-backup/`). */
export function isThunderBackupPath(path: string): boolean {
  return path.split('/').some((seg, i, all) => i < all.length - 1 && /backup/i.test(seg)) || /\.(tmp|bak)$/i.test(path);
}

/** Parse NeDB text: one JSON document per line; the last line for an `_id` wins, `$$deleted` removes. */
export function parseNedb(text: string): Obj[] {
  const byId = new Map<string, Obj>();
  const noId: Obj[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const doc = JSON.parse(t) as unknown;
    if (!isObj(doc)) throw new Error('a line is not a JSON object');
    if ('$$indexCreated' in doc || '$$indexRemoved' in doc) continue;
    const id = str(doc._id);
    if (!id) {
      noId.push(doc);
      continue;
    }
    byId.delete(id); // keep the order of the latest write
    if (doc.$$deleted !== true) byId.set(id, doc);
  }
  return [...noId, ...byId.values()];
}

/** True when `text` looks like a NeDB file: several lines, each a JSON object. */
export function looksLikeNedb(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('{')) return false;
  try {
    return lines.every((l) => isObj(JSON.parse(l)));
  } catch {
    return false;
  }
}

function parseFile(f: ThunderFile): Obj[] {
  const text = f.text.replace(/^﻿/, '');
  if (!text.trim()) return [];
  if (/\.db$/i.test(f.path)) return parseNedb(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    if (looksLikeNedb(text)) return parseNedb(text);
    throw new Error(`not valid JSON (${(e as Error).message})`);
  }
  if (Array.isArray(json)) return json.filter(isObj);
  if (isObj(json)) return [json];
  return [];
}

const isRequest = (o: Obj): boolean => typeof o.url === 'string' && typeof o.method === 'string';
const isCollection = (o: Obj): boolean => typeof o.colName === 'string' && !isRequest(o);
const isEnvironment = (o: Obj): boolean => typeof o.name === 'string' && Array.isArray(o.data) && !isRequest(o) && !('values' in o);
const isExport = (o: Obj): boolean =>
  (str(o.clientName).toLowerCase().includes('thunder') || str(o.client).toLowerCase().includes('thunder')) && typeof o.collectionName === 'string';
const isHistoryFile = (path: string): boolean => /(^|\/)thunderActivity\.(json|db)$/i.test(path);

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');

function modified(o: Obj): number {
  const t = Date.parse(str(o.modified) || str(o.created));
  return Number.isNaN(t) ? 0 : t;
}

/** The history in Thunder's Activity tab: newest first, one entry per distinct method + URL + body. */
function dedupeHistory(list: Obj[]): Obj[] {
  const seen = new Set<string>();
  const out: Obj[] = [];
  for (const r of [...list].sort((a, b) => modified(b) - modified(a))) {
    const key = `${str(r.method).toUpperCase()} ${str(r.url)} ${JSON.stringify(r.body ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function readThunderStore(files: ThunderFile[], opts: { history?: boolean; maxHistory?: number } = {}): ThunderStore {
  const skipped: string[] = [];
  const collections = new Map<string, Obj & { _file: string }>();
  const requests = new Map<string, Obj & { _file: string }>();
  const environments = new Map<string, Obj>();
  const exports: Obj[] = [];
  let history: Obj[] = [];
  let anonymous = 0;

  const addRequest = (r: Obj, file: string, colId?: string) => {
    const rec = { ...r, _file: file } as Obj & { _file: string };
    if (colId && !str(rec.colId)) rec.colId = colId;
    if (str(rec.colId) === 'history' || isHistoryFile(file)) {
      history.push(rec);
      return;
    }
    const id = str(rec._id) || `#${anonymous++}`;
    const prev = requests.get(id);
    if (!prev || modified(rec) >= modified(prev)) requests.set(id, rec);
  };

  for (const f of files) {
    const path = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isThunderBackupPath(path)) continue;
    let records: Obj[];
    try {
      records = parseFile({ path, text: f.text });
    } catch (e) {
      skipped.push(`${path}: ${(e as Error).message}`);
      continue;
    }
    let used = false;
    for (const o of records) {
      if (isExport(o)) {
        exports.push(o);
        used = true;
      } else if (isCollection(o)) {
        const id = str(o._id) || `col:${str(o.colName)}`;
        const prev = collections.get(id);
        // tc_col_*.json carries its requests; the legacy thunderCollection.* only folders.
        const merged = { ...(prev ?? {}), ...o, _id: id, _file: path } as Obj & { _file: string };
        if (prev && !Array.isArray(o.folders)) merged.folders = prev.folders;
        delete merged.requests;
        collections.set(id, merged);
        for (const r of arr(o.requests)) if (isObj(r) && isRequest(r)) addRequest(r, path, id);
        used = true;
      } else if (isEnvironment(o)) {
        environments.set(str(o._id) || str(o.name), o);
        used = true;
      } else if (isRequest(o)) {
        addRequest(o, path);
        used = true;
      }
    }
    if (!used && records.length) skipped.push(`${path}: no Thunder Client collections, requests or environments in it`);
  }

  // Requests stored without a collection id (one file per request) belong to the collection whose
  // file sits in the same folder or above; otherwise to a collection named after their folder.
  const cols = [...collections.values()];
  for (const r of requests.values()) {
    if (str(r.colId)) continue;
    const dir = dirOf(r._file);
    const owner = cols
      .filter((c) => dir === dirOf(c._file) || dir.startsWith(`${dirOf(c._file)}/`))
      .sort((a, b) => dirOf(b._file).length - dirOf(a._file).length)[0];
    if (owner) r.colId = str(owner._id);
    else if (/(^|\/)collections\//.test(r._file) && dir.split('/').pop()) {
      const name = dir.split('/').pop() as string;
      const id = `dir:${dir}`;
      if (!collections.has(id)) collections.set(id, { _id: id, colName: name, folders: [], _file: `${dir}/` });
      r.colId = id;
    }
  }

  const strip = (o: Obj) => {
    const { _file, ...rest } = o;
    void _file;
    return rest;
  };
  const out: ImportedCollection[] = [];
  const reqList = [...requests.values()].map(strip);
  const colList = [...collections.values()].map(strip);
  const envList = [...environments.values()];
  if (colList.length || reqList.length) out.push(...importThunderWorkspace({ collections: colList, requests: reqList, environments: envList }));
  for (const e of exports) out.push(importThunder(e));

  history = dedupeHistory(history);
  const historyCount = history.length;
  if (opts.history && historyCount) {
    const max = opts.maxHistory ?? 500;
    const kept = history.slice(0, max).map((r, i) => ({ ...strip(r), colId: '', containerId: '', sortNum: i }));
    const [h] = importThunderWorkspace({ requests: kept });
    h.name = 'Thunder Client history';
    if (historyCount > max) h.warnings.push(`Only the newest ${max} of ${historyCount} history entries were imported.`);
    out.push(h);
  }
  if (!out.length && envList.length) {
    out.push({ name: 'Thunder Client', folders: [], variables: [], environments: {}, warnings: [] });
  }
  // Environments belong to the whole store: give every output folder the full set.
  if (envList.length) {
    const [any] = importThunderWorkspace({ environments: envList });
    for (const c of out) c.environments = { ...any.environments, ...c.environments };
  }

  const requestCount = out.filter((c) => c.name !== 'Thunder Client history').reduce((n, c) => n + c.folders.reduce((m, f) => m + f.requests.length, 0), 0);
  return {
    collections: out,
    summary: { collections: colList.length + exports.length, requests: requestCount, environments: envList.length, history: historyCount },
    skipped,
  };
}

/** "3 collections, 41 requests, 2 environments, 120 history entries" (zero parts left out). */
export function describeThunderStore(s: ThunderStoreSummary): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return (
    [
      part(s.collections, 'collection', 'collections'),
      part(s.requests, 'request', 'requests'),
      part(s.environments, 'environment', 'environments'),
      part(s.history, 'history entry', 'history entries'),
    ]
      .filter(Boolean)
      .join(', ') || 'no requests'
  );
}
