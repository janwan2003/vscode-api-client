import type { ImportedCollection } from '../model.ts';
import { serializeHttpFile } from '../httpFile.ts';
import { parseCurl } from '../curl.ts';
import { importPostman, importPostmanEnvironment, isObj, isPostmanCollection, isPostmanEnvironment, str } from './postman.ts';
import { importOpenApi, isOpenApi } from './openapi.ts';
import { importThunder, importThunderEnvironments, importThunderWorkspace, isThunderCollection, isThunderEnvironment } from './thunder.ts';

export { importPostman, importPostmanEnvironment } from './postman.ts';
export { importOpenApi } from './openapi.ts';
export { importThunder, importThunderWorkspace, importThunderEnvironments } from './thunder.ts';

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
export function detectAndImport(text: string, fileName?: string): ImportedCollection[] {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (/^(\$\s+)?(\S*[\\/])?curl(\.exe)?\s/i.test(trimmed)) {
    const req = parseCurl(trimmed);
    req.title ??= `${req.method} ${req.url}`;
    const c = emptyCollection(baseName(fileName) || 'curl');
    c.folders.push({ name: '', requests: [req] });
    return [c];
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${fileName ?? 'Input'} is not valid JSON (${(e as Error).message}), nor a curl command.`);
  }

  if (isPostmanCollection(json)) return [importPostman(json)];
  if (isOpenApi(json)) return [importOpenApi(json)];
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
      'OpenAPI 3.x / Swagger 2.0, Thunder Client collection export, thunder-tests/*.json, or a curl command.',
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
 * Lay out an imported collection as files: one `.http` file per folder under
 * `<collection>/`, root requests in `requests.http`, and `http-client.env.json` for environments.
 * Paths use '/' and are relative to the import target directory.
 */
export function collectionToFiles(c: ImportedCollection, usedDirs: Set<string> = new Set()): { path: string; content: string }[] {
  const dir = unique(safeName(c.name, 'collection'), usedDirs);
  const used = new Set<string>();
  const files: { path: string; content: string }[] = [];
  for (const f of c.folders) {
    if (!f.requests.length) continue;
    const base = unique(f.name === '' ? 'requests' : safeName(f.name, 'folder'), used);
    files.push({ path: `${dir}/${base}.http`, content: serializeHttpFile(c.variables, f.requests) });
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
