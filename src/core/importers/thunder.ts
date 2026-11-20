import type { HttpRequest, ImportedCollection } from '../model.ts';
import { basicAuthValue, buildMultipartBody, filePath, formEncode, multipartContentType } from '../curl.ts';
import type { MultipartPart } from '../curl.ts';
import { convertThunderTests } from './tests.ts';
import { arr, cleanImportedRequest, graphqlBody, hasHeader, isObj, str } from './postman.ts';

/**
 * Thunder Client importer. Two layouts are supported:
 *  - a collection export: { clientName, collectionName, folders, requests, settings }
 *  - the legacy workspace files in `thunder-tests/`: thunderCollection.json (array of
 *    { _id, colName, folders, settings }), thunderclient.json (array of requests with colId) and
 *    thunderEnvironment.json (array of { name, data: [{ name, value }] }).
 * Unknown fields are ignored and missing ones defaulted; only input that is clearly not Thunder
 * Client data throws.
 */

type Obj = Record<string, unknown>;

interface Folder {
  id: string;
  name: string;
  parent: string;
  auth?: Obj;
}

const BODY_TYPES: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
};

function hasContent(x: unknown): boolean {
  if (Array.isArray(x)) return x.length > 0;
  if (isObj(x)) return Object.values(x).some(hasContent);
  if (typeof x === 'string') return x.trim() !== '';
  return false;
}

function folderMap(list: unknown): Map<string, Folder> {
  const m = new Map<string, Folder>();
  for (const f of arr(list)) {
    if (!isObj(f)) continue;
    const id = str(f._id);
    if (!id) continue;
    const settings = isObj(f.settings) ? f.settings : undefined;
    m.set(id, {
      id,
      name: str(f.name) || 'Untitled folder',
      parent: str(f.containerId),
      auth: settings && isObj(settings.auth) ? settings.auth : undefined,
    });
  }
  return m;
}

/** Folder chain from the outermost folder to `id` (cycle-safe). */
function chain(folders: Map<string, Folder>, id: string): Folder[] {
  const out: Folder[] = [];
  const seen = new Set<string>();
  let cur = folders.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent ? folders.get(cur.parent) : undefined;
  }
  return out;
}

function isAuthSet(a: Obj | undefined): a is Obj {
  if (!a) return false;
  const t = str(a.type);
  return t !== '' && t !== 'inherit';
}

function applyAuth(auth: Obj | undefined, req: HttpRequest, label: string, warnings: string[]): void {
  if (!auth) return;
  const type = str(auth.type);
  const set = (value: string) => {
    if (!hasHeader(req.headers, 'Authorization')) req.headers.push({ name: 'Authorization', value });
  };
  switch (type) {
    case '':
    case 'none':
    case 'inherit':
      return;
    case 'bearer': {
      const prefix = str(auth.bearerPrefix).trim() || 'Bearer';
      set(`${prefix} ${str(auth.bearer)}`);
      return;
    }
    case 'basic': {
      const b = isObj(auth.basic) ? auth.basic : {};
      set(basicAuthValue(str(b.username), str(b.password)));
      return;
    }
    case 'oauth2': {
      const o = isObj(auth.oauth2) ? auth.oauth2 : {};
      const token = str(o.accessToken) || str(o.token);
      if (token) {
        set(`${str(o.tokenPrefix).trim() || 'Bearer'} ${token}`);
        warnings.push(`${label}: OAuth 2.0 was converted to a fixed Bearer token; token refresh is not imported.`);
      } else warnings.push(`${label}: OAuth 2.0 auth has no stored access token; not imported.`);
      return;
    }
    default:
      warnings.push(`${label}: ${type} auth is not supported; not imported.`);
  }
}

function applyBody(body: unknown, req: HttpRequest, label: string, warnings: string[]): void {
  if (!isObj(body)) return;
  const type = str(body.type);
  const setType = (t: string) => {
    if (!hasHeader(req.headers, 'Content-Type')) req.headers.push({ name: 'Content-Type', value: t });
  };
  switch (type) {
    case 'json':
    case 'text':
    case 'xml': {
      const raw = str(body.raw);
      if (!raw.trim()) return;
      req.body = raw;
      setType(BODY_TYPES[type]);
      return;
    }
    case 'formencoded': {
      const parts: string[] = [];
      for (const f of arr(body.form)) {
        if (!isObj(f) || f.isDisabled === true) continue;
        parts.push(`${formEncode(str(f.name))}=${formEncode(str(f.value))}`);
      }
      setType('application/x-www-form-urlencoded');
      if (parts.length) req.body = parts.join('&');
      return;
    }
    case 'formdata': {
      const parts: MultipartPart[] = [];
      for (const f of arr(body.form)) {
        if (!isObj(f) || f.isDisabled === true) continue;
        parts.push({ name: str(f.name), value: str(f.value) });
      }
      for (const f of arr(body.files)) {
        if (!isObj(f) || f.isDisabled === true) continue;
        const path = str(f.value);
        if (!path) continue;
        parts.push({ name: str(f.name), file: path });
        warnings.push(`${label}: form field "${str(f.name)}" uploads file "${path}"; check that the path exists relative to the .http file.`);
      }
      if (!parts.length) return;
      req.headers = req.headers.filter((h) => h.name.toLowerCase() !== 'content-type');
      req.headers.push({ name: 'Content-Type', value: multipartContentType() });
      req.body = buildMultipartBody(parts);
      return;
    }
    case 'graphql': {
      const g = isObj(body.graphql) ? body.graphql : {};
      const vars = typeof g.variables === 'string' ? g.variables : g.variables ? JSON.stringify(g.variables) : '';
      req.body = graphqlBody(str(g.query), vars);
      setType('application/json');
      return;
    }
    case 'binary': {
      const path = str(body.binary) || (isObj(arr(body.files)[0]) ? str((arr(body.files)[0] as Obj).value) : '');
      if (path) {
        req.body = `< ${filePath(path)}`;
        warnings.push(`${label}: body is the file "${path}"; check that the path exists relative to the .http file.`);
      } else warnings.push(`${label}: binary body has no file path; skipped.`);
      return;
    }
    default:
      // 'none', missing, or unknown: no body. Keep raw text for unknown types if present.
      if (type && type !== 'none' && str(body.raw).trim()) req.body = str(body.raw);
  }
}

function convertRequest(
  r: Obj,
  folders: Map<string, Folder>,
  collectionAuth: Obj | undefined,
  warnings: string[],
): { folder: string; req: HttpRequest } | undefined {
  const name = str(r.name) || 'Untitled';
  const parents = chain(folders, str(r.containerId));
  const folder = parents.map((f) => f.name).join(' / ');
  const label = `"${folder ? folder + ' / ' : ''}${name}"`;

  const req: HttpRequest = { method: str(r.method) || 'GET', url: str(r.url), headers: [], title: name };
  for (const h of arr(r.headers)) {
    if (!isObj(h)) continue;
    const hn = str(h.name);
    if (!hn) continue;
    req.headers.push(h.isDisabled === true ? { name: hn, value: str(h.value), disabled: true } : { name: hn, value: str(h.value) });
  }
  applyBody(r.body, req, label, warnings);

  // Auth: an explicit type wins; missing or 'inherit' walks up folders to the collection.
  let auth = isObj(r.auth) ? r.auth : undefined;
  if (!isAuthSet(auth)) {
    auth = undefined;
    for (let i = parents.length - 1; i >= 0 && !auth; i--) if (isAuthSet(parents[i].auth)) auth = parents[i].auth;
    if (!auth && isAuthSet(collectionAuth)) auth = collectionAuth;
  }
  applyAuth(auth, req, label, warnings);

  const pathParams = arr(r.params)
    .filter((p): p is Obj => isObj(p) && p.isPath === true)
    .map((p) => str(p.name))
    .filter(Boolean);
  if (pathParams.length) {
    warnings.push(`${label}: path parameters (${pathParams.join(', ')}) are left in the URL as written; replace them or define {{variables}}.`);
  }

  const skipped: string[] = [];
  if (hasContent(r.tests)) {
    const t = convertThunderTests(r.tests);
    if (t.asserts.length) req.asserts = t.asserts;
    if (t.skipped.length) warnings.push(`${label}: ${t.skipped.length} test(s) not converted to # @assert: ${t.skipped.join('; ')}.`);
  }
  if (hasContent(r.preReq)) skipped.push('pre-request actions');
  if (hasContent(r.postReq)) skipped.push('post-request actions');
  if (hasContent(r.scripts) || hasContent(r.script)) skipped.push('scripts');
  if (skipped.length) warnings.push(`${label}: ${skipped.join(', ')} skipped.`);

  const clean = cleanImportedRequest(req, label, warnings);
  return clean ? { folder, req: clean } : undefined;
}

function sortNum(x: unknown): number {
  if (!isObj(x)) return Number.MAX_SAFE_INTEGER;
  const n = typeof x.sortNum === 'number' ? x.sortNum : Number(x.sortNum);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function buildCollection(
  name: string,
  folderList: unknown,
  requests: unknown[],
  settings: unknown,
): ImportedCollection {
  const warnings: string[] = [];
  const folders = folderMap(folderList);
  const s = isObj(settings) ? settings : {};
  const collectionAuth = isObj(s.auth) ? s.auth : undefined;
  const collSkipped: string[] = [];
  if (hasContent(s.tests)) collSkipped.push('tests');
  if (hasContent(s.preReq)) collSkipped.push('pre-request actions');
  if (hasContent(s.postReq)) collSkipped.push('post-request actions');
  if (collSkipped.length) warnings.push(`Collection "${name}": ${collSkipped.join(', ')} skipped.`);

  const grouped = new Map<string, HttpRequest[]>();
  // Folder order: by the folders' own sortNum, so files appear in the same order as in the tree.
  const folderOrder = [...folders.values()]
    .map((f) => ({ path: chain(folders, f.id).map((c) => c.name).join(' / '), sort: sortNum(arr(folderList).find((x) => isObj(x) && x._id === f.id)) }))
    .sort((a, b) => a.sort - b.sort);
  grouped.set('', []);
  for (const f of folderOrder) if (!grouped.has(f.path)) grouped.set(f.path, []);

  const sorted = requests.filter(isObj).map((r, i) => ({ r, i })).sort((a, b) => sortNum(a.r) - sortNum(b.r) || a.i - b.i);
  for (const { r } of sorted) {
    const c = convertRequest(r, folders, collectionAuth, warnings);
    if (!c) continue;
    const list = grouped.get(c.folder);
    if (list) list.push(c.req);
    else grouped.set(c.folder, [c.req]);
  }
  const outFolders = [...grouped].filter(([, reqs]) => reqs.length).map(([fname, reqs]) => ({ name: fname, requests: reqs }));
  return { name, folders: outFolders, variables: [], environments: {}, warnings };
}

export function isThunderCollection(json: unknown): boolean {
  if (!isObj(json)) return false;
  if (str(json.clientName).toLowerCase().includes('thunder')) return true;
  return typeof json.collectionName === 'string' && (Array.isArray(json.requests) || Array.isArray(json.folders));
}

/** Import a Thunder Client collection export (the JSON written by "Export" on a collection). */
export function importThunder(json: unknown): ImportedCollection {
  if (!isThunderCollection(json)) {
    throw new Error('Not a Thunder Client collection export: expected an object with "collectionName" and "requests".');
  }
  const j = json as Obj;
  const name = str(j.collectionName) || str(j.colName) || 'Thunder Client';
  const c = buildCollection(name, j.folders, arr(j.requests), j.settings);
  // Some exports embed environments; accept them when present.
  const envs = importThunderEnvironments(j.environments);
  c.environments = envs;
  return c;
}

/** Thunder environments: the legacy array of { name, data: [{ name, value }] } or an exported
 *  environment { environmentName, variables: [{ name, value }] }. */
export function importThunderEnvironments(json: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const list = Array.isArray(json) ? json : isObj(json) ? [json] : [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const name = str(e.name) || str(e.environmentName);
    const vars = Array.isArray(e.data) ? e.data : Array.isArray(e.variables) ? e.variables : undefined;
    if (!name || !vars) continue;
    const values: Record<string, string> = {};
    for (const v of vars) {
      if (!isObj(v) || v.isDisabled === true) continue;
      const key = str(v.name) || str(v.key);
      if (key) values[key] = str(v.value);
    }
    out[name] = values;
  }
  return out;
}

/**
 * Import the legacy workspace layout (`thunder-tests/`): one collection per entry of
 * thunderCollection.json, with requests matched by colId. Environments are attached to every
 * collection so each output directory is self-contained.
 */
export function importThunderWorkspace(files: { collections?: unknown; requests?: unknown; environments?: unknown }): ImportedCollection[] {
  const cols = arr(files.collections).filter(isObj);
  const reqs = arr(files.requests).filter(isObj);
  const environments = importThunderEnvironments(files.environments);
  if (!cols.length && !reqs.length && !Object.keys(environments).length) {
    throw new Error('No Thunder Client data found: expected thunderCollection.json, thunderclient.json or thunderEnvironment.json content.');
  }
  const byCol = new Map<string, Obj[]>();
  for (const r of reqs) {
    const id = str(r.colId);
    const list = byCol.get(id);
    if (list) list.push(r);
    else byCol.set(id, [r]);
  }
  const out: ImportedCollection[] = [];
  for (const c of cols) {
    const id = str(c._id);
    const name = str(c.colName) || str(c.collectionName) || str(c.name) || 'Thunder Client';
    out.push(buildCollection(name, c.folders, byCol.get(id) ?? [], c.settings));
    byCol.delete(id);
  }
  const orphans = [...byCol.values()].flat();
  if (orphans.length) {
    const c = buildCollection(cols.length ? 'Thunder Client (no collection)' : 'Thunder Client', [], orphans, undefined);
    if (cols.length) c.warnings.unshift(`${orphans.length} request(s) did not belong to a known collection.`);
    out.push(c);
  }
  if (!out.length) {
    out.push({ name: 'Thunder Client', folders: [], variables: [], environments: {}, warnings: [] });
  }
  for (const c of out) c.environments = { ...environments };
  return out;
}
