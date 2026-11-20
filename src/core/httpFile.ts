import type { FileVariable, Header, HttpFile, HttpRequest, ParsedRequest } from './model.ts';

/**
 * Parser and serializer for the `.http` / `.rest` format used by REST Client,
 * httpYac and JetBrains HTTP Client:
 *
 *   @host = https://api.example.com        file variable
 *   ### Optional title                     request separator
 *   # @name getUser                        request metadata
 *   GET {{host}}/users/1 HTTP/1.1          request line (method optional, defaults to GET)
 *     ?page=2                              query continuation lines
 *     &size=10
 *   Accept: application/json               headers until the first blank line
 *
 *   { "body": true }                       body until the next ###
 */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

const SEPARATOR = /^###(.*)$/;
const COMMENT = /^\s*(#|\/\/)(.*)$/;
const META = /^\s*(?:#|\/\/)\s*@([\w-]+)\s*(.*?)\s*$/;
const FILE_VAR = /^\s*@([\w.-]+)\s*=\s*(.*?)\s*$/;
const REQUEST_LINE = new RegExp(`^\\s*(?:(${METHODS.join('|')})\\s+)?(\\S.*?)(?:\\s+(HTTP\\/[\\d.]+))?\\s*$`, 'i');
/** Non-standard methods (PURGE, PROPFIND, LINK...) must be upper case and followed by a URL-like target. */
const CUSTOM_METHOD_LINE = /^\s*([A-Z][A-Z-]*)\s+((?:[a-z][a-z0-9+.-]*:\/\/|\{\{|\/)\S*?)(?:\s+(HTTP\/[\d.]+))?\s*$/;
const HEADER = /^\s*([^\s:][^:]*?)\s*:\s?(.*)$/;
const DISABLED_HEADER = /^\s*(?:#|\/\/)\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+):\s?(.*)$/;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function parseHttpFile(text: string): HttpFile {
  const lines = splitLines(text);
  const variables: FileVariable[] = [];
  const requests: ParsedRequest[] = [];

  // Split into blocks at ### lines.
  const blocks: { start: number; end: number; title?: string }[] = [];
  let start = 0;
  let title: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = SEPARATOR.exec(lines[i]);
    if (m) {
      blocks.push({ start, end: i, title });
      start = i;
      title = m[1].trim() || undefined;
    }
  }
  blocks.push({ start, end: lines.length, title });

  for (const block of blocks) {
    const req = parseBlock(lines, block.start, block.end, block.title, variables);
    if (req) requests.push(req);
  }
  return { variables, requests };
}

function parseBlock(
  lines: string[],
  start: number,
  end: number,
  title: string | undefined,
  variables: FileVariable[],
): ParsedRequest | undefined {
  let i = start;
  if (i < end && SEPARATOR.test(lines[i])) i++;

  const meta: Record<string, string> = {};
  const comments: string[] = [];
  let name: string | undefined;

  // Preamble: blank lines, comments, metadata, file variables.
  for (; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const fv = FILE_VAR.exec(line);
    if (fv) {
      variables.push({ name: fv[1], value: fv[2] });
      continue;
    }
    const mm = META.exec(line);
    if (mm) {
      if (mm[1] === 'name') name = mm[2] || undefined;
      else meta[mm[1]] = mm[2];
      continue;
    }
    const cm = COMMENT.exec(line);
    if (cm) {
      comments.push(cm[2].replace(/^ /, ''));
      continue;
    }
    break;
  }
  if (i >= end) return undefined;

  const rl = CUSTOM_METHOD_LINE.exec(lines[i]) ?? REQUEST_LINE.exec(lines[i]);
  if (!rl) return undefined;
  const requestLine = i;
  let url = rl[2];
  const method = (rl[1] ?? 'GET').toUpperCase();
  const httpVersion = rl[3];
  i++;

  // Query continuation lines: lines starting with ? or & directly after the request line.
  for (; i < end; i++) {
    const t = lines[i].trim();
    if (t.startsWith('?') || t.startsWith('&')) url += t;
    else break;
  }

  // Headers until a blank line.
  const headers: Header[] = [];
  for (; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      break;
    }
    const dh = DISABLED_HEADER.exec(line);
    if (dh) {
      headers.push({ name: dh[1], value: dh[2], disabled: true });
      continue;
    }
    if (COMMENT.test(line)) continue;
    const h = HEADER.exec(line);
    if (h) headers.push({ name: h[1], value: h[2] });
    else {
      // Not a header: treat the rest as body (REST Client is lenient here).
      break;
    }
  }

  // Body: everything until the end of the block, minus trailing blank lines.
  let bodyEnd = end;
  while (bodyEnd > i && lines[bodyEnd - 1].trim() === '') bodyEnd--;
  const body = bodyEnd > i ? lines.slice(i, bodyEnd).join('\n') : undefined;

  const req: ParsedRequest = { method, url, headers, startLine: start, endLine: end, requestLine };
  if (name) req.name = name;
  if (title) req.title = title;
  if (httpVersion) req.httpVersion = httpVersion;
  if (body !== undefined) req.body = body;
  if (Object.keys(meta).length) req.meta = meta;
  if (comments.length) req.comments = comments;
  return req;
}

/** Serialize one request as a block, starting with its `###` separator line. */
export function serializeRequest(req: HttpRequest): string {
  const out: string[] = [];
  out.push(req.title ? `### ${req.title}` : '###');
  for (const c of req.comments ?? []) out.push(`# ${c}`.trimEnd());
  if (req.name) out.push(`# @name ${req.name}`);
  for (const [k, v] of Object.entries(req.meta ?? {})) out.push(`# @${k}${v ? ' ' + v : ''}`);
  out.push(`${req.method.toUpperCase()} ${req.url}${req.httpVersion ? ' ' + req.httpVersion : ''}`);
  for (const h of req.headers) {
    if (!h.name.trim()) continue;
    out.push(`${h.disabled ? '# ' : ''}${h.name}: ${h.value}`);
  }
  if (req.body !== undefined && req.body !== '') {
    out.push('');
    out.push(req.body.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  }
  return out.join('\n');
}

/** Serialize a whole file: variables first, then each request separated by a blank line. */
export function serializeHttpFile(variables: FileVariable[], requests: HttpRequest[]): string {
  const parts: string[] = [];
  if (variables.length) parts.push(variables.map((v) => `@${v.name} = ${v.value}`).join('\n'));
  for (const r of requests) parts.push(serializeRequest(r));
  return parts.join('\n\n') + '\n';
}

/**
 * Replace one request in the file text, keeping everything else byte-for-byte.
 * `index` is the position in `parseHttpFile(text).requests`. Returns the new text.
 */
export function replaceRequest(text: string, index: number, req: HttpRequest): string {
  const lines = splitLines(text);
  const parsed = parseHttpFile(text).requests[index];
  if (!parsed) throw new Error(`No request #${index} in file`);
  // Keep file variables that live inside the block's preamble.
  const kept: string[] = [];
  for (let i = parsed.startLine; i < parsed.requestLine; i++) {
    if (FILE_VAR.test(lines[i])) kept.push(lines[i]);
  }
  // Keep trailing blank lines of the block so spacing to the next block is unchanged.
  let trailing = 0;
  for (let i = parsed.endLine - 1; i > parsed.requestLine && lines[i].trim() === ''; i--) trailing++;
  let block = serializeRequest(req).split('\n');
  // A block that did not start with ### (first request in a file) keeps that shape.
  if (!SEPARATOR.test(lines[parsed.startLine]) && !req.title) block = block.slice(1);
  const replacement = [...kept, ...block, ...Array(trailing).fill('')];
  lines.splice(parsed.startLine, parsed.endLine - parsed.startLine, ...replacement);
  return lines.join('\n');
}

/** Append a request at the end of the file text. */
export function appendRequest(text: string, req: HttpRequest): string {
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + serializeRequest(req) + '\n';
}

/** Split a URL into base and query parameters (raw, not decoded, so {{vars}} survive). */
export function splitQuery(url: string): { base: string; params: { name: string; value: string }[] } {
  const q = url.indexOf('?');
  if (q < 0) return { base: url, params: [] };
  const hashIdx = url.indexOf('#', q);
  const query = url.slice(q + 1, hashIdx < 0 ? undefined : hashIdx);
  const params = query
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? { name: p, value: '' } : { name: p.slice(0, eq), value: p.slice(eq + 1) };
    });
  return { base: url.slice(0, q), params };
}

export function joinQuery(base: string, params: { name: string; value: string }[]): string {
  const q = params.filter((p) => p.name !== '').map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`));
  return q.length ? `${base}?${q.join('&')}` : base;
}
