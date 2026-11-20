import type { ImportedCollection } from '../model.ts';
import { serializeHttpFile } from '../httpFile.ts';
import { parseCurl } from '../curl.ts';
import { importPostman, importPostmanEnvironment, isObj, isPostmanCollection, isPostmanEnvironment, str } from './postman.ts';
import { importOpenApi, isOpenApi } from './openapi.ts';
import { parseYaml } from '../yaml.ts';
import { importThunder, importThunderEnvironments, importThunderWorkspace, isThunderCollection, isThunderEnvironment } from './thunder.ts';
import { looksLikeNedb, readThunderStore } from './thunderStore.ts';

export { importPostman, importPostmanEnvironment } from './postman.ts';
export { importOpenApi } from './openapi.ts';
export { importThunder, importThunderWorkspace, importThunderEnvironments } from './thunder.ts';
export { readThunderStore, describeThunderStore } from './thunderStore.ts';

/** Thunder Client's own data files: NeDB `.db` databases and the Activity (history) file. */
function importThunderDataFile(text: string, fileName: string | undefined): ImportedCollection[] {
  const store = readThunderStore([{ path: fileName ?? 'thunder.db', text }], { history: true });
  if (!store.collections.length) throw new Error(`${fileName ?? 'This file'} has no Thunder Client requests, collections or environments${store.skipped.length ? ` (${store.skipped[0]})` : ''}.`);
  return store.collections;
}

/**
 * YAML aliases share objects, so a small file can expand to an enormous tree ("billion laughs").
 * Walk it with a node budget before importing; real specs (GitHub's 11 MB one) are far below it.
 */
function assertReasonableSize(doc: unknown, budget = 5_000_000): void {
  const stack: unknown[] = [doc];
  let n = 0;
  while (stack.length) {
    const x = stack.pop();
    if (++n > budget) throw new Error('The YAML expands to too much data (more than 5 million values once aliases are expanded); not imported.');
    if (Array.isArray(x)) stack.push(...x);
    else if (x !== null && typeof x === 'object') stack.push(...Object.values(x));
  }
}

function baseName(fileName: string | undefined): string {
  if (!fileName) return '';
  const b = fileName.split(/[\\/]/).pop() ?? '';
  return b.replace(/\.[^.]*$/, '');
}

function emptyCollection(name: string): ImportedCollection {
  return { name, folders: [], variables: [], environments: {}, warnings: [] };
}

/**
 * Detect the format of an exported file and import it. Supports Postman collections and
 * environments, Thunder Client collection exports, the legacy `thunder-tests/*.json` files, and
 * a pasted curl command. Throws a readable Error for anything else.
 */
/** `sourceUrl`: where `text` was downloaded from (OpenAPI relative server URLs resolve against it). */
export function detectAndImport(text: string, fileName?: string, sourceUrl?: string): ImportedCollection[] {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (/^(\$\s+)?(\S*[\\/])?curl(\.exe)?\s/i.test(trimmed)) {
    const req = parseCurl(trimmed);
    req.title ??= `${req.method} ${req.url}`;
    const c = emptyCollection(baseName(fileName) || 'curl');
    c.folders.push({ name: '', requests: [req] });
    return [c];
  }
  if (/\.db$/i.test(fileName ?? '') || (!trimmed.startsWith('[') && looksLikeNedb(trimmed) && trimmed.includes('\n'))) {
    return importThunderDataFile(trimmed, fileName);
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    // OpenAPI / Swagger definitions are usually YAML.
    if (/^(openapi|swagger)\s*:/m.test(trimmed) || /\.ya?ml$/i.test(fileName ?? '')) {
      let doc: unknown;
      try {
        doc = parseYaml(trimmed);
        assertReasonableSize(doc);
      } catch (ye) {
        throw new Error(`${fileName ?? 'Input'} is not valid YAML: ${(ye as Error).message}`);
      }
      if (isOpenApi(doc)) return [importOpenApi(doc, { sourceUrl })];
      throw new Error(`${fileName ?? 'This YAML file'} is not an OpenAPI 3.x or Swagger 2.0 definition (no "openapi"/"swagger" version or no "paths").`);
    }
    throw new Error(`${fileName ?? 'Input'} is not valid JSON (${(e as Error).message}), nor a curl command.`);
  }

  if (isPostmanCollection(json)) return [importPostman(json)];
  if (isOpenApi(json)) return [importOpenApi(json, { sourceUrl })];
  if (isPostmanEnvironment(json)) {
    const environments = importPostmanEnvironment(json);
    const c = emptyCollection(baseName(fileName).replace(/\.postman_(environment|globals)$/, '') || Object.keys(environments)[0] || 'environment');
    c.environments = environments;
    return [c];
  }
  if (isThunderCollection(json)) return [importThunder(json)];
  if (isObj(json) && (typeof json.environmentName === 'string' || isThunderEnvironment(json))) {
    const c = emptyCollection(baseName(fileName).replace(/^tc_env_/, '') || str(json.environmentName) || str(json.name) || 'environment');
    c.environments = importThunderEnvironments(json);
    return [c];
  }
  if (Array.isArray(json)) {
    const items = json.filter(isObj);
    if (/(^|[\\/])thunderActivity\.json$/i.test(fileName ?? '') || items.some((x) => x.colId === 'history')) return importThunderDataFile(trimmed, fileName ?? 'thunderActivity.json');
    if (items.some((x) => 'colName' in x || ('folders' in x && '_id' in x && !('url' in x)))) {
      return importThunderWorkspace({ collections: json });
    }
    if (items.some((x) => 'colId' in x || ('url' in x && 'method' in x))) {
      return importThunderWorkspace({ requests: json });
    }
    if (items.some((x) => Array.isArray(x.data) && 'name' in x)) {
      const c = emptyCollection(baseName(fileName) || 'Thunder Client');
      c.environments = importThunderEnvironments(json);
      return [c];
    }
  }
  if (isObj(json) && Array.isArray(json.requests) && Array.isArray(json.order)) {
    return [importPostman(json)]; // throws the "v1 not supported" message
  }
  throw new Error(
    `${fileName ?? 'This file'} is not a recognized export. Supported: Postman Collection v2.0/v2.1, Postman environment, ` +
      'OpenAPI 3.x / Swagger 2.0, Thunder Client collection export, thunder-tests/*.json, Thunder Client .db files, or a curl command.',
  );
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** File-system-safe name: letters, digits, space, - _ . kept; anything else becomes '-'. */
export function safeName(name: string, fallback: string): string {
  let s = name.replace(/[^\p{L}\p{N} \-_.]/gu, '-');
  // No leading/trailing dots or spaces: avoids '..', hidden files and Windows trailing-dot issues.
  s = s.replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s += '-';
  return s;
}

function unique(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name}-${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Lay out an imported collection as files: one `.http` file per folder under `<collection>/`,
 * nested folders as subdirectories (`Orders / Refunds` → `Orders/Refunds.http`), root requests in
 * `requests.http`, and `http-client.env.json` for environments. Paths use '/' and are relative
 * to the import target directory.
 */
export function collectionToFiles(c: ImportedCollection, usedDirs: Set<string> = new Set()): { path: string; content: string }[] {
  const dir = unique(safeName(c.name, 'collection'), usedDirs);
  /** Names taken per directory (case-insensitive), files and subdirectories alike. */
  const used = new Map<string, Set<string>>();
  const usedIn = (d: string) => used.get(d) ?? used.set(d, new Set()).get(d)!;
  /** Each folder chain maps to one directory, so siblings of the same parent share it. */
  const dirs = new Map<string, string>();
  const files: { path: string; content: string }[] = [];
  for (const f of c.folders) {
    if (!f.requests.length) continue;
    const segs = f.path?.length ? f.path : f.name === '' ? [] : [f.name];
    let at = dir;
    for (let i = 0; i < segs.length - 1; i++) {
      const key = segs.slice(0, i + 1).join('\u0000');
      let d = dirs.get(key);
      if (!d) {
        d = `${at}/${unique(safeName(segs[i], 'folder'), usedIn(at + '/'))}`;
        dirs.set(key, d);
      }
      at = d;
    }
    const base = unique(segs.length ? safeName(segs[segs.length - 1], 'folder') : 'requests', usedIn(at));
    files.push({ path: `${at}/${base}.http`, content: serializeHttpFile(c.variables, f.requests) });
  }
  if (Object.keys(c.environments).length) {
    files.push({ path: `${dir}/http-client.env.json`, content: JSON.stringify(c.environments, null, 2) + '\n' });
  }
  return files;
}

/**
 * Environment-only results (e.g. Thunder's `environments/tc_env_*.json` next to `collections/`)
 * are merged into the first collection that has requests, so they land beside its .http files
 * instead of in a folder of their own.
 */
export function attachEnvironments(cs: ImportedCollection[]): ImportedCollection[] {
  const hasRequests = (c: ImportedCollection) => c.folders.some((f) => f.requests.length);
  const target = cs.find(hasRequests);
  if (!target) return cs;
  const out: ImportedCollection[] = [];
  for (const c of cs) {
    if (c !== target && !hasRequests(c) && !c.variables.length) {
      for (const [env, vars] of Object.entries(c.environments)) target.environments[env] = { ...target.environments[env], ...vars };
      target.warnings.push(...c.warnings);
      continue;
    }
    out.push(c);
  }
  return out;
}

/** `collectionToFiles` for several collections, giving each its own (de-duplicated) directory. */
export function collectionsToFiles(cs: ImportedCollection[]): { path: string; content: string }[] {
  const usedDirs = new Set<string>();
  return cs.flatMap((c) => collectionToFiles(c, usedDirs));
}
