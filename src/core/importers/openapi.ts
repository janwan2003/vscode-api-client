import type { Header, HttpRequest, ImportedCollection } from '../model.ts';
import { buildMultipartBody, formEncode, multipartContentType } from '../curl.ts';
import type { MultipartPart } from '../curl.ts';
import { arr, cleanImportedRequest, hasHeader, isObj, str } from './postman.ts';

/**
 * OpenAPI 3.0 / 3.1 and Swagger 2.0 → requests.
 *
 * - One request per path + method, grouped into one file per first tag.
 * - URLs are `{{baseUrl}}/path/{{param}}`. `baseUrl`, path parameters and credentials go to the
 *   `$shared` environment (so they resolve without choosing an environment); with several servers,
 *   each server also gets a named environment that overrides `baseUrl`.
 * - Required query/header parameters are written with their example (or default, or a value made
 *   from the schema); optional query parameters are listed in a comment above the request.
 * - Bodies come from the media type's example, else are generated from the schema (local `$ref`s,
 *   `allOf` merged, first of `oneOf`/`anyOf`).
 * - Security: HTTP bearer/basic, API keys (header, query, cookie); OAuth 2 / OpenID Connect become a
 *   Bearer `{{accessToken}}` header. External `$ref`s are not followed (warning).
 * - Each request with exactly one documented 2xx status gets `# @assert status == <code>`.
 */

type Obj = Record<string, unknown>;

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function isOpenApi(x: unknown): x is Obj {
  return isObj(x) && (typeof x.openapi === 'string' || str(x.swagger).startsWith('2')) && isObj(x.paths);
}

interface Ctx {
  root: Obj;
  v2: boolean;
  warnings: string[];
  shared: Record<string, string>;
  /** Warnings that should appear once per import, not once per request. */
  once: Set<string>;
}

function warnOnce(ctx: Ctx, msg: string): void {
  if (ctx.once.has(msg)) return;
  ctx.once.add(msg);
  ctx.warnings.push(msg);
}

/** Follow a local `$ref` chain (`#/components/schemas/Pet`); external refs resolve to undefined. */
function deref(ctx: Ctx, x: unknown, seen: Set<string> = new Set()): Obj | undefined {
  let cur = x;
  for (let hops = 0; isObj(cur) && typeof cur.$ref === 'string'; hops++) {
    const ref = cur.$ref;
    if (hops > 20 || seen.has(ref)) return undefined;
    if (!ref.startsWith('#')) {
      warnOnce(ctx, `External $ref ${ref.split('#')[0]} is not followed; parts that use it are left empty.`);
      return undefined;
    }
    let node: unknown = ctx.root;
    for (const seg of ref.slice(1).split('/').filter(Boolean)) {
      const key = decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~');
      node = isObj(node) ? node[key] : Array.isArray(node) ? node[Number(key)] : undefined;
    }
    if (node === undefined) {
      warnOnce(ctx, `$ref ${ref} does not exist in the document.`);
      return undefined;
    }
    cur = node;
  }
  return isObj(cur) ? cur : undefined;
}

// --- Example values from schemas ---------------------------------------------------------------

function firstType(t: unknown): string {
  if (Array.isArray(t)) return str(t.find((x) => x !== 'null'));
  return str(t);
}

function stringSample(schema: Obj): string {
  switch (str(schema.format)) {
    case 'date-time':
      return '2025-01-01T00:00:00Z';
    case 'date':
      return '2025-01-01';
    case 'time':
      return '12:00:00';
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'hostname':
      return 'example.com';
    case 'ipv4':
      return '192.0.2.1';
    case 'ipv6':
      return '2001:db8::1';
    case 'byte':
      return 'c3RyaW5n';
    case 'password':
      return 'password';
    case 'binary':
      return '';
    default:
      return 'string';
  }
}

const MAX_DEPTH = 8;

/** A JSON value matching `schema`, preferring the schema's own example/default/enum. */
function sampleFromSchema(ctx: Ctx, schemaIn: unknown, depth = 0, refs: Set<string> = new Set()): unknown {
  if (!isObj(schemaIn)) return undefined;
  const ref = typeof schemaIn.$ref === 'string' ? schemaIn.$ref : undefined;
  if (ref && refs.has(ref)) return undefined; // recursive schema: stop here
  const schema = deref(ctx, schemaIn);
  if (!schema || depth > MAX_DEPTH) return undefined;
  const nextRefs = ref ? new Set([...refs, ref]) : refs;

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((e) => e !== null) ?? schema.enum[0];

  if (Array.isArray(schema.allOf)) {
    let merged: unknown;
    for (const part of schema.allOf) {
      const v = sampleFromSchema(ctx, part, depth + 1, nextRefs);
      if (isObj(v) && (merged === undefined || isObj(merged))) merged = { ...(merged as Obj | undefined), ...v };
      else if (v !== undefined && merged === undefined) merged = v;
    }
    const own = isObj(schema.properties) ? sampleObject(ctx, schema, depth, nextRefs) : undefined;
    if (isObj(own)) merged = { ...(isObj(merged) ? merged : {}), ...own };
    return merged;
  }
  for (const k of ['oneOf', 'anyOf']) {
    const opts = arr(schema[k]);
    if (opts.length) {
      const pick = opts.find((o) => firstType(deref(ctx, o)?.type) !== 'null') ?? opts[0];
      return sampleFromSchema(ctx, pick, depth + 1, nextRefs);
    }
  }

  let type = firstType(schema.type);
  if (!type) type = isObj(schema.properties) || isObj(schema.additionalProperties) ? 'object' : schema.items ? 'array' : '';
  switch (type) {
    case 'object':
      return sampleObject(ctx, schema, depth, nextRefs);
    case 'array': {
      const item = sampleFromSchema(ctx, schema.items, depth + 1, nextRefs);
      return item === undefined ? [] : [item];
    }
    case 'string':
      return stringSample(schema);
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return undefined;
  }
}

function sampleObject(ctx: Ctx, schema: Obj, depth: number, refs: Set<string>): Obj {
  const out: Obj = {};
  const props = isObj(schema.properties) ? schema.properties : {};
  for (const [name, p] of Object.entries(props)) {
    const ps = deref(ctx, p);
    if (ps?.readOnly === true) continue;
    const v = sampleFromSchema(ctx, p, depth + 1, refs);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

// --- Parameters --------------------------------------------------------------------------------

interface Param {
  name: string;
  in: string;
  required: boolean;
  schema?: Obj;
  value?: unknown;
  description: string;
}

function paramValue(ctx: Ctx, p: Obj): unknown {
  if (p.example !== undefined) return p.example;
  if (isObj(p.examples)) {
    for (const e of Object.values(p.examples)) {
      const ex = deref(ctx, e);
      if (ex && ex.value !== undefined) return ex.value;
    }
  }
  if (ctx.v2) {
    // Swagger 2 non-body parameters carry their schema inline (type, format, default, enum, items).
    if (p['x-example'] !== undefined) return p['x-example'];
    return sampleFromSchema(ctx, p);
  }
  return sampleFromSchema(ctx, p.schema);
}

function collectParams(ctx: Ctx, lists: unknown[]): { params: Param[]; body?: Obj; formData: Obj[] } {
  const byKey = new Map<string, Obj>();
  for (const list of lists) {
    for (const raw of arr(list)) {
      const p = deref(ctx, raw);
      if (!p || !str(p.name)) continue;
      byKey.set(`${str(p.in)}:${str(p.name)}`, p); // operation-level overrides path-level
    }
  }
  const params: Param[] = [];
  let body: Obj | undefined;
  const formData: Obj[] = [];
  for (const p of byKey.values()) {
    const where = str(p.in);
    if (where === 'body') body = p;
    else if (where === 'formData') formData.push(p);
    else {
      params.push({
        name: str(p.name),
        in: where,
        required: p.required === true || where === 'path',
        schema: ctx.v2 ? p : deref(ctx, p.schema),
        value: paramValue(ctx, p),
        description: str(p.description),
      });
    }
  }
  return { params, body, formData };
}

function scalarText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(scalarText).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A name usable as `{{name}}`: path params may contain characters the variable syntax rejects. */
function varName(name: string): string {
  return name.replace(/[^\w.-]/g, '_') || 'param';
}

// --- Bodies ------------------------------------------------------------------------------------

function mediaExample(ctx: Ctx, media: Obj): { value: unknown; fromExample: boolean } {
  if (media.example !== undefined) return { value: media.example, fromExample: true };
  if (isObj(media.examples)) {
    for (const e of Object.values(media.examples)) {
      const ex = deref(ctx, e);
      if (ex && ex.value !== undefined) return { value: ex.value, fromExample: true };
    }
  }
  return { value: sampleFromSchema(ctx, media.schema), fromExample: false };
}

const isEmpty = (v: unknown) => v === undefined || (isObj(v) && !Object.keys(v).length);

function pickMediaType(types: string[]): string | undefined {
  const order = [
    (t: string) => /^application\/json\b/i.test(t),
    (t: string) => /[/+]json\b/i.test(t),
    (t: string) => /^application\/x-www-form-urlencoded/i.test(t),
    (t: string) => /^multipart\/form-data/i.test(t),
    (t: string) => /^text\//i.test(t),
    (t: string) => /xml/i.test(t),
  ];
  for (const f of order) {
    const t = types.find(f);
    if (t) return t;
  }
  return types[0];
}

/** `a[b]=1&c[0]=x` (deepObject / bracket notation, as Stripe and PHP/Rails servers read it). */
function flattenForm(prefix: string, v: unknown, out: [string, string][]): void {
  if (Array.isArray(v)) v.forEach((x, i) => flattenForm(`${prefix}[${i}]`, x, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) flattenForm(`${prefix}[${k}]`, x, out);
  else out.push([prefix, scalarText(v)]);
}

function formBody(fields: [string, unknown][]): string {
  const flat: [string, string][] = [];
  for (const [k, v] of fields) flattenForm(k, v, flat);
  return flat.map(([k, v]) => `${formEncode(k).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${formEncode(v)}`).join('&');
}

/** Form fields generated from a schema: the required ones, or (if none are required) the scalar ones. */
function formFields(ctx: Ctx, schema: Obj | undefined, value: unknown, fromExample: boolean): [string, unknown][] {
  const entries = Object.entries(isObj(value) ? value : {});
  if (fromExample || !schema) return entries;
  const required = new Set(arr(schema.required).map(str));
  if (required.size) return entries.filter(([k]) => required.has(k));
  return entries.filter(([, v]) => !isObj(v) && !Array.isArray(v));
}

function multipartBody(ctx: Ctx, fields: { name: string; schema: Obj | undefined; value: unknown }[]): string {
  const parts: MultipartPart[] = fields.map((f) => {
    const s = f.schema;
    const isFile = !!s && (str(s.type) === 'file' || str(s.format) === 'binary' || str(s.format) === 'base64' || (str(s.type) === 'array' && str(deref(ctx, s.items)?.format) === 'binary'));
    return isFile ? { name: f.name, file: `./${varName(f.name)}.bin` } : { name: f.name, value: scalarText(f.value) };
  });
  return buildMultipartBody(parts);
}

function setBody(req: HttpRequest, contentType: string, body: string): void {
  if (!hasHeader(req.headers, 'Content-Type')) req.headers.push({ name: 'Content-Type', value: contentType });
  req.body = body;
}

function applyRequestBody(ctx: Ctx, req: HttpRequest, op: Obj, label: string): void {
  const rb = deref(ctx, op.requestBody);
  if (!rb || !isObj(rb.content)) return;
  const type = pickMediaType(Object.keys(rb.content));
  if (!type) return;
  const media = isObj(rb.content[type]) ? (rb.content[type] as Obj) : {};
  const { value, fromExample } = mediaExample(ctx, media);
  // An optional body with nothing in it (e.g. Stripe's GET endpoints declare an empty form body).
  if (rb.required !== true && isEmpty(value) && !/multipart|octet-stream/i.test(type)) return;
  if (/json/i.test(type)) {
    setBody(req, type, value === undefined ? '{}' : JSON.stringify(value, null, 2));
  } else if (/x-www-form-urlencoded/i.test(type)) {
    const body = formBody(formFields(ctx, deref(ctx, media.schema), value, fromExample));
    if (body || rb.required === true) setBody(req, type, body);
  } else if (/multipart\/form-data/i.test(type)) {
    const schema = deref(ctx, media.schema);
    const props = schema && isObj(schema.properties) ? schema.properties : {};
    const values = isObj(value) ? value : {};
    const fields = Object.keys(props).map((name) => ({ name, schema: deref(ctx, props[name]), value: values[name] }));
    setBody(req, multipartContentType(), multipartBody(ctx, fields));
  } else if (/octet-stream|^image\/|^audio\/|^video\/|^application\/pdf/i.test(type)) {
    setBody(req, type, '< ./body.bin');
  } else if (typeof value === 'string') {
    setBody(req, type, value);
  } else {
    if (!hasHeader(req.headers, 'Content-Type')) req.headers.push({ name: 'Content-Type', value: type });
    warnOnce(ctx, `${label}: no example for the ${type} body; the body is left empty.`);
  }
}

function applySwagger2Body(ctx: Ctx, req: HttpRequest, op: Obj, body: Obj | undefined, formData: Obj[]): void {
  const consumes = arr(op.consumes ?? ctx.root.consumes).map(str);
  if (body) {
    const value = sampleFromSchema(ctx, body.schema) ?? (body['x-example'] as unknown);
    const type = pickMediaType(consumes.filter((t) => !/form/i.test(t))) ?? 'application/json';
    if (/json/i.test(type) || value === undefined || typeof value !== 'string') {
      setBody(req, /json/i.test(type) ? type : 'application/json', value === undefined ? '{}' : JSON.stringify(value, null, 2));
    } else setBody(req, type, value);
    return;
  }
  if (!formData.length) return;
  const multipart = formData.some((p) => str(p.type) === 'file') || consumes.some((t) => /multipart/i.test(t)) && !consumes.some((t) => /urlencoded/i.test(t));
  if (multipart) {
    setBody(req, multipartContentType(), multipartBody(ctx, formData.map((p) => ({ name: str(p.name), schema: p, value: paramValue(ctx, p) }))));
  } else {
    const fields = formData.filter((p) => p.required === true || p.default !== undefined).map((p) => [str(p.name), paramValue(ctx, p)] as [string, unknown]);
    setBody(req, 'application/x-www-form-urlencoded', formBody(fields.length ? fields : formData.map((p) => [str(p.name), paramValue(ctx, p)])));
  }
}

// --- Security ----------------------------------------------------------------------------------

function applySecurity(ctx: Ctx, req: HttpRequest, op: Obj): void {
  const requirements = arr(op.security ?? ctx.root.security);
  if (!requirements.length) return;
  // An empty requirement `{}` means "no auth" is accepted.
  const first = requirements.find(isObj);
  if (!first || !Object.keys(first).length) return;
  const schemes = ctx.v2 ? ctx.root.securityDefinitions : isObj(ctx.root.components) ? ctx.root.components.securitySchemes : undefined;
  for (const name of Object.keys(first)) {
    const s = deref(ctx, isObj(schemes) ? schemes[name] : undefined);
    if (!s) {
      warnOnce(ctx, `Security scheme "${name}" is not defined; not applied.`);
      continue;
    }
    const type = str(s.type);
    const scheme = str(s.scheme).toLowerCase();
    if ((type === 'http' && scheme === 'basic') || type === 'basic') {
      ctx.shared.username ??= '';
      ctx.shared.password ??= '';
      if (!hasHeader(req.headers, 'Authorization')) req.headers.push({ name: 'Authorization', value: 'Basic {{username}}:{{password}}' });
    } else if (type === 'http' && scheme === 'bearer') {
      ctx.shared.token ??= '';
      if (!hasHeader(req.headers, 'Authorization')) req.headers.push({ name: 'Authorization', value: 'Bearer {{token}}' });
    } else if (type === 'apiKey') {
      const key = str(s.name) || 'X-API-Key';
      const v = varName(name);
      ctx.shared[v] ??= '';
      if (str(s.in) === 'query') req.url += `${req.url.includes('?') ? '&' : '?'}${formEncode(key)}={{${v}}}`;
      else if (str(s.in) === 'cookie') addCookie(req, `${key}={{${v}}}`);
      else if (!hasHeader(req.headers, key)) req.headers.push({ name: key, value: `{{${v}}}` });
    } else if (type === 'oauth2' || type === 'openIdConnect') {
      ctx.shared.accessToken ??= '';
      if (!hasHeader(req.headers, 'Authorization')) req.headers.push({ name: 'Authorization', value: 'Bearer {{accessToken}}' });
      warnOnce(ctx, `${type === 'oauth2' ? 'OAuth 2.0' : 'OpenID Connect'} ("${name}") is written as "Authorization: Bearer {{accessToken}}"; paste a token into accessToken in http-client.env.json.`);
    } else if (type === 'http') {
      warnOnce(ctx, `HTTP auth scheme "${scheme}" ("${name}") is not supported; not applied.`);
    } else {
      warnOnce(ctx, `Security scheme type "${type}" ("${name}") is not supported; not applied.`);
    }
  }
}

function addCookie(req: HttpRequest, pair: string): void {
  const h = req.headers.find((x) => x.name.toLowerCase() === 'cookie');
  if (h) h.value += `; ${pair}`;
  else req.headers.push({ name: 'Cookie', value: pair });
}

// --- Servers -----------------------------------------------------------------------------------

function serverUrl(server: Obj): string {
  let url = str(server.url);
  const vars = isObj(server.variables) ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (_m, n: string) => {
    const v = vars[n];
    return isObj(v) && v.default !== undefined ? str(v.default) : `{{${varName(n)}}}`;
  });
  return url.replace(/\/+$/, '');
}

function absolute(ctx: Ctx, url: string): string {
  if (/^[a-z][\w+.-]*:\/\//i.test(url) || url.startsWith('{{')) return url;
  warnOnce(ctx, `The server URL "${url || '/'}" is relative; baseUrl was set to http://localhost${url}. Change it in http-client.env.json.`);
  return `http://localhost${url.startsWith('/') || !url ? '' : '/'}${url}`;
}

function servers(ctx: Ctx): { name: string; url: string }[] {
  const root = ctx.root;
  if (ctx.v2) {
    const host = str(root.host);
    const basePath = str(root.basePath).replace(/\/+$/, '');
    const schemes = arr(root.schemes).map(str);
    if (!host) return [{ name: '', url: absolute(ctx, basePath) }];
    const list = schemes.length ? schemes : ['https'];
    return list.map((s) => ({ name: s, url: `${s}://${host}${basePath}` }));
  }
  const list = arr(root.servers).filter(isObj);
  if (!list.length) return [{ name: '', url: absolute(ctx, '') }];
  return list.map((s, i) => ({ name: envName(str(s.description), i), url: absolute(ctx, serverUrl(s)) }));
}

function envName(description: string, i: number): string {
  const n = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return n || `server-${i + 1}`;
}

// --- Main --------------------------------------------------------------------------------------

function cleanComment(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  // A comment starting with @ or ?? would be read back as metadata or an assertion.
  return /^(@|\?\?)/.test(t) ? `- ${t}` : t;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function firstLine(text: string, max = 160): string {
  const plainText = text
    .replace(/<\/?(p|br|div|li|ul|ol|h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(\w+|#\d+);/g, (m, e: string) => (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e] ?? m));
  const line = plainText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const plain = line.replace(/\s+/g, ' ');
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function successAssert(op: Obj): string | undefined {
  const codes = Object.keys(isObj(op.responses) ? op.responses : {}).filter((c) => /^2\d\d$/.test(c));
  return codes.length === 1 ? `status == ${codes[0]}` : undefined;
}

export function importOpenApi(doc: unknown): ImportedCollection {
  if (!isOpenApi(doc)) throw new Error('Not an OpenAPI 3.x or Swagger 2.0 document (no "openapi"/"swagger" version or no "paths").');
  const ctx: Ctx = { root: doc, v2: !doc.openapi, warnings: [], shared: {}, once: new Set() };
  const info = isObj(doc.info) ? doc.info : {};
  const name = str(info.title).trim() || 'OpenAPI';

  const srv = servers(ctx);
  ctx.shared.baseUrl = srv[0].url;
  const environments: Record<string, Record<string, string>> = {};
  if (srv.length > 1) {
    const used = new Set<string>();
    for (const [i, s] of srv.entries()) {
      let n = s.name || `server-${i + 1}`;
      for (let k = 2; used.has(n); k++) n = `${s.name}-${k}`;
      used.add(n);
      environments[n] = { baseUrl: s.url };
    }
  }

  const folders = new Map<string, HttpRequest[]>();
  const usedNames = new Set<string>();
  /** Path variables whose value is a made-up '1', replaced by the first real example seen. */
  const placeholders = new Set<string>();
  let skipped = 0;
  let externalOps = 0;
  for (const [path, rawItem] of Object.entries(doc.paths as Obj)) {
    const item = deref(ctx, rawItem);
    if (!item) continue;
    for (const method of OPERATION_METHODS) {
      const rawOp = item[method];
      if (!isObj(rawOp)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      // Operations kept in other files (`get: { $ref: resources/x.yml }`) cannot be read here: the
      // request keeps its method and path, and one summary warning asks for a bundled definition.
      const external = typeof rawOp.$ref === 'string' && !rawOp.$ref.startsWith('#');
      if (external) externalOps++;
      const op = (external ? {} : deref(ctx, rawOp)) ?? {};
      const { params, body, formData } = collectParams(ctx, [item.parameters, op.parameters]);

      // URL: {{baseUrl}} (or the operation's own server) + path with {{params}}.
      const opServers = arr(op.servers ?? item.servers).filter(isObj);
      const base = opServers.length ? absolute(ctx, serverUrl(opServers[0])) : '{{baseUrl}}';
      const pathParams = new Map(params.filter((p) => p.in === 'path').map((p) => [p.name, p]));
      const urlPath = path.replace(/\{([^}]+)\}/g, (_m, n: string) => {
        const v = varName(n);
        const p = pathParams.get(n);
        const sample = scalarText(p?.value);
        if (ctx.shared[v] === undefined || (placeholders.has(v) && sample)) {
          ctx.shared[v] = sample || '1';
          if (sample) placeholders.delete(v);
          else placeholders.add(v);
        }
        return `{{${v}}}`;
      });
      let url = base + (urlPath.startsWith('/') ? urlPath : `/${urlPath}`);
      const query = params.filter((p) => p.in === 'query');
      const required = query.filter((p) => p.required);
      if (required.length) url += '?' + required.map((p) => `${formEncode(p.name)}=${formEncode(scalarText(p.value))}`).join('&');

      const headers: Header[] = [];
      for (const p of params.filter((x) => x.in === 'header' && x.required)) {
        if (/^(accept|content-type|authorization)$/i.test(p.name)) continue; // set from the spec's media types / security
        headers.push({ name: p.name, value: scalarText(p.value) });
      }
      const req: HttpRequest = { method: method.toUpperCase(), url, headers };
      const cookies = params.filter((x) => x.in === 'cookie' && x.required);
      if (cookies.length) addCookie(req, cookies.map((p) => `${p.name}=${scalarText(p.value)}`).join('; '));

      req.title = firstLine(str(op.summary)) || str(op.operationId) || label;
      const opId = str(op.operationId).replace(/[^\w-]/g, '_');
      if (opId && !usedNames.has(opId)) {
        usedNames.add(opId);
        req.name = opId;
      }
      const comments: string[] = [];
      const desc = firstLine(str(op.description));
      if (desc && desc !== req.title) comments.push(cleanComment(desc));
      if (op.deprecated === true) comments.push('Deprecated.');
      const optional = query.filter((p) => !p.required).map((p) => p.name);
      if (optional.length) comments.push(cleanComment(`Optional query: ${optional.join(', ')}`));
      if (comments.length) req.comments = comments;

      if (ctx.v2) applySwagger2Body(ctx, req, op, body, formData);
      else applyRequestBody(ctx, req, op, label);
      applySecurity(ctx, req, op);
      const a = successAssert(op);
      if (a) req.asserts = [a];

      const clean = cleanImportedRequest(req, label, ctx.warnings);
      if (!clean) {
        skipped++;
        continue;
      }
      if (req.comments) clean.comments = req.comments;
      if (req.name) clean.name = req.name;
      // Untagged operations are grouped by their first path segment (skipping /v1-style versions).
      const tag = str(arr(op.tags)[0]).trim() || path.split('/').find((seg) => seg && !/^[{<:]/.test(seg) && !/^v\d+(\.\d+)*$/i.test(seg)) || '';
      const list = folders.get(tag) ?? [];
      list.push(clean);
      folders.set(tag, list);
    }
  }
  if (externalOps) {
    ctx.warnings.unshift(
      `${externalOps} operation(s) are defined in other files ($ref to another file), so only their method and path were imported. ` +
        'Bundle the definition into one file first (for example "npx @redocly/cli bundle openapi.yaml -o bundled.yaml") and import that.',
    );
  }
  if (skipped) ctx.warnings.push(`${skipped} operation(s) could not be converted.`);
  if (!folders.size) ctx.warnings.push('The document has no operations under "paths".');

  environments.$shared = ctx.shared;
  return {
    name,
    folders: [...folders.entries()].map(([n, requests]) => ({ name: n, requests })),
    variables: [],
    environments: Object.fromEntries([['$shared', ctx.shared], ...Object.entries(environments).filter(([k]) => k !== '$shared')]),
    warnings: ctx.warnings,
  };
}
