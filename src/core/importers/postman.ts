import type { FileVariable, Header, HttpRequest, ImportedCollection } from '../model.ts';
import { METHODS } from '../httpFile.ts';
import { convertPostmanTests } from './tests.ts';
import { basicAuthValue, buildMultipartBody, filePath, formEncode, multipartContentType } from '../curl.ts';
import type { MultipartPart } from '../curl.ts';
import { isGraphqlRequest, joinGraphqlBody } from '../graphql.ts';

/**
 * Postman Collection v2.0 / v2.1 importer.
 * Folders are flattened to "A / B" names; collection/folder auth is applied to requests that
 * inherit it; scripts are skipped with a warning. Postman's `{{var}}` syntax is kept as is.
 */

type Obj = Record<string, unknown>;

export function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
export function str(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  return '';
}
export function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

const VAR_NAME = /^[\w.-]+$/;

/** `{{$...}}` names Plainwire resolves (see core/variables.ts systemVariable). */
const SYSTEM_VARIABLES = new Set([
  '$guid', '$uuid', '$random.uuid', '$timestamp', '$isoTimestamp', '$randomInt', '$random.integer',
  '$datetime', '$localDatetime', '$processEnv', '$dotenv',
]);

/** Dynamic variables (`{{$randomEmail}}`, Thunder's `{{#email}}`) that will not resolve when sent. */
function unsupportedDynamicVariables(req: HttpRequest): string[] {
  const text = [req.url, ...req.headers.map((h) => h.value), req.body ?? ''].join('\n');
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([$#][^{}\s,]*)[^{}]*\}\}/g)) {
    if (!SYSTEM_VARIABLES.has(m[1])) out.add(`{{${m[1]}}}`);
  }
  return [...out];
}

/** Normalize an imported request so it survives serialization to `.http`; returns undefined
 *  (with a warning) when it cannot be represented at all. */
export function cleanImportedRequest(req: HttpRequest, label: string, warnings: string[]): HttpRequest | undefined {
  const url = req.url.replace(/[\r\n]+/g, '').trim();
  if (!url) {
    warnings.push(`${label}: request has no URL; skipped.`);
    return undefined;
  }
  const method = (req.method || 'GET').trim().toUpperCase() || 'GET';
  if (!METHODS.includes(method)) {
    warnings.push(`${label}: method ${method} is not supported in .http files; it will be read back as part of the URL.`);
  }
  const headers: Header[] = [];
  for (const h of req.headers) {
    const name = h.name.trim();
    if (!name) continue;
    if (/[\s:]/.test(name)) {
      warnings.push(`${label}: header "${name}" has an invalid name; skipped.`);
      continue;
    }
    const hh: Header = { name, value: h.value.replace(/\r?\n/g, ' ') };
    if (h.disabled) hh.disabled = true;
    headers.push(hh);
  }
  const out: HttpRequest = { method, url, headers };
  const title = req.title?.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (title) out.title = title;
  const asserts = req.asserts?.map((a) => a.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
  if (asserts?.length) out.asserts = asserts;
  if (req.rawBefore?.length) out.rawBefore = req.rawBefore;
  if (req.rawAfter?.length) out.rawAfter = req.rawAfter;
  if (req.body !== undefined && req.body.trim() !== '') {
    out.body = req.body.replace(/\r\n/g, '\n');
    if (/^###/m.test(out.body)) {
      warnings.push(`${label}: body contains a line starting with ###, which .http files treat as a request separator.`);
    }
  }
  const dynamic = unsupportedDynamicVariables(out);
  if (dynamic.length) {
    warnings.push(`${label}: dynamic variable(s) ${dynamic.join(', ')} have no Plainwire equivalent; define them as variables or replace them.`);
  }
  return out;
}

/** Convert a variable list, skipping names the `.http` format cannot express. */
export function toFileVariables(list: { name: string; value: string }[], where: string, warnings: string[]): FileVariable[] {
  const out: FileVariable[] = [];
  for (const v of list) {
    if (!v.name) continue;
    if (!VAR_NAME.test(v.name)) {
      warnings.push(`${where}: variable "${v.name}" has characters not allowed in .http variable names; skipped.`);
      continue;
    }
    if (/[\r\n]/.test(v.value)) {
      warnings.push(`${where}: variable "${v.name}" is multi-line; line breaks were replaced with spaces.`);
    }
    out.push({ name: v.name, value: v.value.replace(/\r?\n/g, ' ').trim() });
  }
  return out;
}

export function hasHeader(headers: Header[], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some((h) => !h.disabled && h.name.toLowerCase() === n);
}

export function appendQuery(url: string, pair: string): string {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const frag = hash < 0 ? '' : url.slice(hash);
  return base + (base.includes('?') ? '&' : '?') + pair + frag;
}

/**
 * Write a GraphQL body in REST Client's form (`X-REQUEST-TYPE: GraphQL`, the query, a blank line,
 * the variables JSON), which Plainwire sends as `{"query", "variables"}` JSON (see core/graphql.ts).
 * `variables` is JSON text that may contain `{{vars}}`; it is pretty-printed when it parses, and
 * left out when empty or `{}`.
 */
export function applyGraphqlBody(req: HttpRequest, query: string, variables: string): void {
  let v = variables.trim();
  try {
    const parsed: unknown = JSON.parse(v);
    v = isObj(parsed) && !Object.keys(parsed).length ? '' : JSON.stringify(parsed, null, 2);
  } catch {
    // e.g. contains {{placeholders}}; valid JSON once they are substituted
  }
  req.body = joinGraphqlBody(query, v);
  if (!hasHeader(req.headers, 'Content-Type')) req.headers.push({ name: 'Content-Type', value: 'application/json' });
  if (!isGraphqlRequest(req)) req.headers.push({ name: 'X-REQUEST-TYPE', value: 'GraphQL' });
}

// ---------------------------------------------------------------------------------------------

interface Ctx {
  warnings: string[];
  folders: Map<string, HttpRequest[]>;
  /** Folder chain per folder key, for nested output directories. */
  paths: Map<string, string[]>;
}

/** Postman auth: v2.1 uses arrays of {key, value}; v2.0 uses plain objects. */
function authParam(auth: Obj, type: string, key: string): string {
  const p = auth[type];
  if (Array.isArray(p)) {
    for (const e of p) if (isObj(e) && e.key === key) return str(e.value);
    return '';
  }
  if (isObj(p)) return str(p[key]);
  return '';
}

function applyAuth(auth: Obj | undefined, req: HttpRequest, label: string, warnings: string[]): void {
  if (!auth) return;
  const type = str(auth.type);
  if (type === '' || type === 'noauth' || type === 'inherit') return;
  const setAuth = (value: string) => {
    if (!hasHeader(req.headers, 'Authorization')) req.headers.push({ name: 'Authorization', value });
  };
  switch (type) {
    case 'bearer':
      setAuth(`Bearer ${authParam(auth, 'bearer', 'token')}`);
      return;
    case 'basic':
      setAuth(basicAuthValue(authParam(auth, 'basic', 'username'), authParam(auth, 'basic', 'password')));
      return;
    case 'apikey': {
      const key = authParam(auth, 'apikey', 'key') || 'X-API-Key';
      const value = authParam(auth, 'apikey', 'value');
      if (authParam(auth, 'apikey', 'in') === 'query') req.url = appendQuery(req.url, `${key}=${value}`);
      else if (!hasHeader(req.headers, key)) req.headers.push({ name: key, value });
      return;
    }
    case 'oauth2': {
      const token = authParam(auth, 'oauth2', 'accessToken');
      if (token) {
        setAuth(`Bearer ${token}`);
        warnings.push(`${label}: OAuth 2.0 was converted to a fixed Bearer token; token refresh is not imported.`);
      } else warnings.push(`${label}: OAuth 2.0 auth has no stored access token; not imported.`);
      return;
    }
    default:
      warnings.push(`${label}: ${type} auth is not supported; not imported.`);
  }
}

/**
 * Keep a Postman script as a `< {% %}` / `> {% %}` block (rawBefore / rawAfter). False (and the
 * script stays a "skipped" warning) when a line would end the block early.
 */
function embedScript(req: HttpRequest, mark: '<' | '>', code: string, label: string, w: string[]): boolean {
  const lines = code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  if (lines.some((l) => /%\}\s*$/.test(l))) return false;
  const block = [`${mark} {%`, ...lines, '%}'];
  if (mark === '<') req.rawBefore = [...(req.rawBefore ?? []), ...block];
  else req.rawAfter = [...(req.rawAfter ?? []), ...block];
  const unsupported = [/\bpm\.sendRequest\b/.test(code) ? 'pm.sendRequest' : '', /\brequire\s*\(/.test(code) ? 'require()' : '', /\bpm\.(?:visualizer|cookies|execution|vault)\b/.test(code) ? 'pm.visualizer/cookies/execution/vault' : '']
    .filter(Boolean);
  if (unsupported.length) w.push(`${label}: ${mark === '<' ? 'pre-request' : 'test'} script uses ${unsupported.join(', ')}, which Plainwire's pm API does not support`);
  return true;
}

/** Code of the enabled `test` scripts in a Postman `event` list. */
function testScript(events: unknown): string {
  return eventScript(events, 'test');
}

/** Code of the enabled scripts for one `listen` value (`test`, `prerequest`). */
function eventScript(events: unknown, listen: string): string {
  const parts: string[] = [];
  for (const e of arr(events)) {
    if (!isObj(e) || e.disabled === true || str(e.listen) !== listen) continue;
    const script = isObj(e.script) ? e.script : undefined;
    const exec = script ? script.exec : undefined;
    parts.push(Array.isArray(exec) ? exec.map(str).join('\n') : str(exec));
  }
  return parts.join('\n');
}

function scriptKinds(events: unknown): string[] {
  const kinds: string[] = [];
  for (const e of arr(events)) {
    if (!isObj(e) || e.disabled === true) continue;
    const script = isObj(e.script) ? e.script : undefined;
    const exec = script ? script.exec : undefined;
    const code = Array.isArray(exec) ? exec.map(str).join('\n') : str(exec);
    if (!code.trim()) continue;
    const listen = str(e.listen);
    const kind = listen === 'prerequest' ? 'pre-request script' : listen === 'test' ? 'test script' : `${listen || 'unknown'} script`;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function pathItem(x: unknown): string {
  if (isObj(x)) return str(x.value);
  return str(x);
}

function buildUrl(u: unknown): string {
  if (typeof u === 'string') return u;
  if (!isObj(u)) return '';
  const raw = str(u.raw).trim();
  let base: string;
  let hash = '';
  let rawQuery: string | undefined;
  if (raw) {
    const h = raw.indexOf('#');
    const noHash = h < 0 ? raw : raw.slice(0, h);
    hash = h < 0 ? '' : raw.slice(h);
    const q = noHash.indexOf('?');
    base = q < 0 ? noHash : noHash.slice(0, q);
    rawQuery = q < 0 ? undefined : noHash.slice(q + 1);
  } else {
    const host = Array.isArray(u.host) ? u.host.map(pathItem).join('.') : str(u.host);
    const protocol = str(u.protocol);
    const port = str(u.port);
    const path = Array.isArray(u.path) ? u.path.map(pathItem).join('/') : str(u.path).replace(/^\//, '');
    base = `${protocol ? protocol + '://' : ''}${host}${port ? ':' + port : ''}${path ? '/' + path : ''}`;
    if (str(u.hash)) hash = '#' + str(u.hash);
  }
  // Rebuild the query from the structured list so disabled params are dropped.
  let query: string | undefined;
  if (Array.isArray(u.query)) {
    const parts: string[] = [];
    for (const q of u.query) {
      if (!isObj(q) || q.disabled === true) continue;
      const key = q.key == null ? '' : str(q.key);
      if (q.value == null) parts.push(key);
      else parts.push(`${key}=${str(q.value)}`);
    }
    query = parts.length ? parts.join('&') : undefined;
  } else query = rawQuery;
  let url = base + (query !== undefined && query !== '' ? '?' + query : '') + hash;
  // Path variables (/users/:id): substitute the stored value, or turn them into {{id}}.
  for (const v of arr(u.variable)) {
    if (!isObj(v)) continue;
    const key = str(v.key);
    if (!key) continue;
    const value = str(v.value);
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    url = url.replace(new RegExp(`/:${esc}(?=[/?#]|$)`, 'g'), `/${value !== '' ? value : `{{${key}}}`}`);
  }
  return url;
}

function headersOf(h: unknown): Header[] {
  if (typeof h === 'string') {
    // v2.0 allows a raw header block.
    const out: Header[] = [];
    for (const line of h.split(/\r?\n/)) {
      const c = line.indexOf(':');
      if (c > 0) out.push({ name: line.slice(0, c).trim(), value: line.slice(c + 1).trim() });
    }
    return out;
  }
  const out: Header[] = [];
  for (const e of arr(h)) {
    if (!isObj(e)) continue;
    const name = str(e.key);
    if (!name) continue;
    const hh: Header = { name, value: str(e.value) };
    if (e.disabled === true) hh.disabled = true;
    out.push(hh);
  }
  return out;
}

const RAW_LANG_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

function applyBody(body: unknown, req: HttpRequest, label: string, warnings: string[]): void {
  if (!isObj(body) || body.disabled === true) return;
  const mode = str(body.mode);
  const setType = (t: string) => {
    if (!hasHeader(req.headers, 'Content-Type')) req.headers.push({ name: 'Content-Type', value: t });
  };
  switch (mode) {
    case 'raw': {
      const raw = str(body.raw);
      if (!raw) return;
      req.body = raw;
      const opts = isObj(body.options) && isObj(body.options.raw) ? body.options.raw : undefined;
      const lang = opts ? str(opts.language) : '';
      if (RAW_LANG_TYPES[lang]) setType(RAW_LANG_TYPES[lang]);
      return;
    }
    case 'urlencoded': {
      const parts: string[] = [];
      for (const e of arr(body.urlencoded)) {
        if (!isObj(e) || e.disabled === true) continue;
        parts.push(`${formEncode(str(e.key))}=${formEncode(str(e.value))}`);
      }
      setType('application/x-www-form-urlencoded');
      if (parts.length) req.body = parts.join('&');
      return;
    }
    case 'formdata': {
      const parts: MultipartPart[] = [];
      for (const e of arr(body.formdata)) {
        if (!isObj(e) || e.disabled === true) continue;
        const name = str(e.key);
        const contentType = str(e.contentType) || undefined;
        if (str(e.type) === 'file') {
          const src = Array.isArray(e.src) ? str(e.src[0]) : str(e.src);
          if (src && !src.startsWith('postman-cloud:')) {
            parts.push({ name, file: src, contentType });
            warnings.push(`${label}: form field "${name}" uploads file "${src}"; check that the path exists relative to the .http file.`);
          } else {
            warnings.push(`${label}: form field "${name}" is a file upload with no local path; skipped.`);
          }
          continue;
        }
        parts.push({ name, value: str(e.value), contentType });
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
      applyGraphqlBody(req, str(g.query), vars);
      return;
    }
    case 'file': {
      const f = isObj(body.file) ? str(body.file.src) : '';
      if (f) {
        req.body = `< ${filePath(f)}`;
        warnings.push(`${label}: body is the file "${f}"; check that the path exists relative to the .http file.`);
      } else warnings.push(`${label}: binary file body has no path; skipped.`);
      return;
    }
    default:
      return;
  }
}

/** Auth set on the collection or a folder, with a label naming where it was set. */
interface InheritedAuth {
  auth: Obj;
  where: string;
}

function walk(items: unknown, path: string[], inheritedAuth: InheritedAuth | undefined, ctx: Ctx): void {
  for (const item of arr(items)) {
    if (!isObj(item)) continue;
    const name = str(item.name) || 'Untitled';
    if (Array.isArray(item.item)) {
      // Folder.
      const folderPath = [...path, name];
      const kinds = scriptKinds(item.event);
      if (kinds.length) ctx.warnings.push(`Folder "${folderPath.join(' / ')}": ${kinds.join(' and ')} skipped.`);
      const auth = isObj(item.auth) && str(item.auth.type) !== 'inherit' ? { auth: item.auth, where: `Folder "${folderPath.join(' / ')}" auth` } : inheritedAuth;
      walk(item.item, folderPath, auth, ctx);
      continue;
    }
    if (!('request' in item)) continue;
    const label = `"${[...path, name].join(' / ')}"`;
    // This request's warnings, reported as one line at the end ("label: a; b; c.").
    const w: string[] = [];
    const r = item.request;
    let req: HttpRequest;
    let auth: InheritedAuth | undefined = inheritedAuth;
    if (typeof r === 'string') {
      req = { method: 'GET', url: r, headers: [] };
    } else if (isObj(r)) {
      req = { method: str(r.method) || 'GET', url: buildUrl(r.url), headers: headersOf(r.header) };
      applyBody(r.body, req, label, w);
      if (isObj(r.auth) && str(r.auth.type) !== 'inherit') auth = { auth: r.auth, where: label };
    } else continue;
    req.title = name;
    if (auth?.where === label) applyAuth(auth.auth, req, label, w);
    else if (auth) {
      // Inherited auth that cannot be converted is reported once, where it is set, not per request.
      const inherited: string[] = [];
      applyAuth(auth.auth, req, auth.where, inherited);
      for (const x of inherited) if (!ctx.warnings.includes(x)) ctx.warnings.push(x);
    }
    let kinds = scriptKinds(item.event);
    const code = testScript(item.event);
    // Pre-request scripts run as `< {% %}` with Plainwire's Postman-compatible `pm` API.
    const preCode = eventScript(item.event, 'prerequest');
    if (preCode.trim() && embedScript(req, '<', preCode, label, w)) kinds = kinds.filter((k) => k !== 'pre-request script');
    if (code.trim()) {
      const t = convertPostmanTests(code);
      // Fully convertible scripts become `# @assert` lines; anything else (variables, conditions,
      // loops) is kept whole as a `> {% %}` handler, which runs it with the `pm` API.
      if ((t.skipped.length || t.conditional || !t.asserts.length) && embedScript(req, '>', code, label, w)) {
        kinds = kinds.filter((k) => k !== 'test script');
        t.skipped = [];
        t.conditional = 0;
        t.asserts = [];
      }
      if (t.asserts.length) req.asserts = t.asserts;
      if (t.asserts.length || !t.skipped.length || t.conditional) kinds = kinds.filter((k) => k !== 'test script');
      if (t.asserts.length && t.skipped.length) {
        w.push(`${label}: test script converted to ${t.asserts.length} # @assert check(s); not converted: ${t.skipped.join(', ')}.`);
      } else if (t.conditional) {
        // Nothing converted, but name the tests whose checks were conditional.
        w.push(`${label}: test script not converted: ${t.skipped.join(', ')}.`);
      }
    }
    if (kinds.length) w.push(`${label}: ${kinds.join(' and ')} skipped.`);
    const clean = cleanImportedRequest(req, label, w);
    if (w.length) ctx.warnings.push(`${label}: ${w.map((x) => x.replace(`${label}: `, '').replace(/\.$/, '')).join('; ')}.`);
    if (!clean) continue;
    const folder = path.join(' / ');
    if (!ctx.paths.has(folder)) ctx.paths.set(folder, [...path]);
    const list = ctx.folders.get(folder);
    if (list) list.push(clean);
    else ctx.folders.set(folder, [clean]);
  }
}

export function isPostmanCollection(json: unknown): boolean {
  return isObj(json) && isObj(json.info) && /getpostman/i.test(str(json.info.schema));
}

/** Import a Postman Collection v2.0 / v2.1 export. */
export function importPostman(json: unknown): ImportedCollection {
  if (!isObj(json) || !isObj(json.info) || !Array.isArray(json.item)) {
    if (isObj(json) && Array.isArray(json.requests) && Array.isArray(json.order)) {
      throw new Error('This is a Postman Collection v1 export, which is not supported. Re-export it from Postman as Collection v2.1.');
    }
    throw new Error('Not a Postman collection: expected an object with "info" and "item" (Collection v2.0/v2.1 export).');
  }
  const ctx: Ctx = { warnings: [], folders: new Map(), paths: new Map() };
  const name = str(json.info.name) || 'Postman collection';
  const kinds = scriptKinds(json.event);
  if (kinds.length) ctx.warnings.push(`Collection: ${kinds.join(' and ')} skipped.`);
  const rootAuth = isObj(json.auth) ? { auth: json.auth, where: 'Collection auth' } : undefined;
  walk(json.item, [], rootAuth, ctx);

  const vars: { name: string; value: string }[] = [];
  for (const v of arr(json.variable)) {
    if (!isObj(v) || v.disabled === true) continue;
    const key = str(v.key) || str(v.id);
    vars.push({ name: key, value: typeof v.value === 'object' && v.value !== null ? JSON.stringify(v.value) : str(v.value) });
  }
  const variables = toFileVariables(vars, 'Collection variables', ctx.warnings);

  // Root-level requests first, then folders in order of appearance.
  const folders: ImportedCollection['folders'] = [];
  const root = ctx.folders.get('');
  if (root) folders.push({ name: '', requests: root });
  for (const [fname, requests] of ctx.folders) if (fname !== '') folders.push({ name: fname, path: ctx.paths.get(fname), requests });

  return { name, folders, variables, environments: {}, warnings: ctx.warnings };
}

export function isPostmanEnvironment(json: unknown): boolean {
  return isObj(json) && Array.isArray(json.values) && (typeof json.name === 'string' || '_postman_variable_scope' in json);
}

/** Import a Postman environment (or globals) export: `{ name, values: [{ key, value, enabled }] }`. */
export function importPostmanEnvironment(json: unknown): Record<string, Record<string, string>> {
  if (!isPostmanEnvironment(json)) {
    throw new Error('Not a Postman environment: expected an object with "name" and a "values" array.');
  }
  const env = json as Obj;
  const name = str(env.name) || (env._postman_variable_scope === 'globals' ? 'globals' : 'environment');
  const values: Record<string, string> = {};
  for (const v of arr(env.values)) {
    if (!isObj(v) || v.enabled === false) continue;
    const key = str(v.key);
    if (!key) continue;
    values[key] = str(v.value);
  }
  return { [name]: values };
}
