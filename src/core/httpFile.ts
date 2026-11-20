import { isHttpYacAssert } from './assert.ts';
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
 *
 *   ?? status == 200                       httpYac test line (anywhere in the block; never body)
 *
 * `??` lines are kept verbatim in `asserts` (see core/assert.ts) and written back after the
 * headers / body. REST Client has no such syntax; httpYac recognises them by the `??` prefix alone.
 *
 * httpYac / JetBrains extras, checked against httpYac 6.16's own parser on 83 real files: a request
 * line (upper-case method + URL) after a request starts the next request even without `###`;
 * `/path` lines continue the URL; `@name := value` and `@name value` are variables; `{{ }}` scripts,
 * `< {% %}` / `> {% %}` handlers, `>> file` redirects and `/* *\/` comments are kept verbatim in
 * `rawBefore` / `rawAfter` and never run (nor sent as body).
 */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
/** Methods that start a new request even without a `###` line (httpYac's HTTP method list; upper case only). */
const SPLIT_METHODS = [
  ...METHODS, 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'CHECKOUT', 'CHECKIN', 'REPORT', 'MERGE',
  'MKACTIVITY', 'MKWORKSPACE', 'VERSION-CONTROL', 'BASELINE-CONTROL', 'MKCALENDAR', 'ACL', 'SEARCH',
];

const SEPARATOR = /^###(.*)$/;
const COMMENT = /^\s*(#|\/\/)(.*)$/;
const META = /^\s*(?:#|\/\/)\s*@([\w-]+)\s*(.*?)\s*$/;
/** `@name = value`; httpYac also accepts `@name := value` (lazy) and `@name value`. */
const FILE_VAR = /^\s*@([\w.-]+)(?:\s*:?=\s*|\s+(?=\S))(.*?)\s*$/;
/** A variable line after a body: only the `=` / `:=` forms (a body line like `@team hello` stays body). */
const TRAILING_VAR = /^\s*@([\w.-]+)\s*:?=\s*(.*?)\s*$/;
const REQUEST_LINE = new RegExp(`^\\s*(?:(${METHODS.join('|')})\\s+)?(\\S.*?)(?:\\s+(HTTP\\/[\\d.]+))?\\s*$`, 'i');
/** Non-standard methods (PURGE, PROPFIND, LINK...) must be upper case and followed by a URL-like target. */
// A URL is one word, except that `{{ ... }}` may contain spaces (`{{$xpath:x //a/b}}`, `{{ id }}`).
const URL_TAIL = String.raw`(?:\{\{.*?\}\}|\S)*?`;
const CUSTOM_METHOD_LINE = new RegExp(String.raw`^\s*([A-Z][A-Z-]*)\s+((?:[a-z][a-z0-9+.-]*:\/\/|\{\{|\/)${URL_TAIL})(?:\s+(HTTP\/[\d.]+))?\s*$`);
/**
 * A request line after another request in the same block (no `###` between them). httpYac starts a
 * new request there; the target must look like a URL so that body text ("DELETE everything") never does.
 */
const NEXT_REQUEST_LINE = new RegExp(
  String.raw`^\s*(?:${SPLIT_METHODS.join('|')})\s+(?:[a-z][a-z0-9+.-]*:\/\/|\{\{|\/|[\w-]+(?:\.[\w-]+)+(?::\d+)?(?=[/?#\s]|$)|[\w-]+:\d+(?=[/?#\s]|$))` +
    String.raw`${URL_TAIL}(?:\s+HTTP\/[\d.]+)?\s*$`,
);
const HEADER = /^\s*([^\s:][^:]*?)\s*:\s?(.*)$/;
const DISABLED_HEADER = /^\s*(?:#|\/\/)\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+):\s?(.*)$/;
/** URL continuation lines after the request line: `?a=1`, `&b=2` (not `??` tests) and httpYac's `/more/path`. */
const URL_CONTINUATION = /^\s*(?:[?&](?!\?)|\/(?![/*]))\S*\s*$/;

// Blocks that Plainwire keeps verbatim but never runs (see HttpRequest.rawBefore / rawAfter).
/** httpYac script: `{{` (optionally `{{@response`, `{{+after`, `{{@js request`...) up to a `}}` line. */
const SCRIPT_START = /^\s*\{\{(?:@js\s+)?(?:\+|@)?(?:request|streaming|response|after|responseLogging)?\s*$/i;
const SCRIPT_END = /^\s*\}\}\s*$/;
/** JetBrains / httpYac handler scripts: `> {% ... %}` (response), `< {% ... %}` (pre-request), or a script file. */
const HANDLER_START = /^\s*([<>])\s+\{%\s*$/;
const HANDLER_END = /^\s*%\}\s*$/;
const HANDLER_LINE = /^\s*([<>])\s+(?:\{%.*%\}|[^\s{%}]+)\s*$/;
/** httpYac output redirection: `>> file` / `>>! file` (write the response body to a file). */
const OUTPUT_REDIRECT = /^\s*>>!?\s+\S/;
/** JetBrains / httpYac response reference: `<> previous-response.json`. */
const RESPONSE_REF = /^\s*<>\s+\S/;
const BLOCK_COMMENT_START = /^\s*\/\*/;
/**
 * Import of another file: httpYac `# @import ./shared.http` (also `// @import`) and JetBrains
 * `import ./shared.http`. The JetBrains form needs a `.http`/`.rest` path so that it can never be
 * mistaken for a request line to a host called "import".
 */
const IMPORT_META = /^\s*(?:#|\/\/)\s*@import\s+(\S(?:.*\S)?)\s*$/;
const IMPORT_JETBRAINS = /^\s*import\s+(\S+\.(?:http|rest))\s*$/i;
/** JetBrains `run #name` / `run #(name)` / `run ./file.http`: kept verbatim, not executed. */
const RUN_LINE = /^\s*run\s+(?:#\(?[^\s)]+\)?|\S+\.(?:http|rest))(?:\s+\(.*\))?\s*$/i;

/** The imported path on an import line, or undefined. */
export function importPath(line: string): string | undefined {
  const m = IMPORT_META.exec(line) ?? IMPORT_JETBRAINS.exec(line);
  return m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : undefined;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * If a kept-verbatim block starts at line `i`, the index just after it; otherwise `i`.
 * `before` = above the request line (`<` handlers allowed); otherwise after it (where `< file` is
 * the body and `>>` redirects the output). Unterminated blocks are not blocks.
 */
function rawBlockEnd(lines: string[], i: number, end: number, before: boolean): number {
  const line = lines[i];
  const until = (re: RegExp): number => {
    for (let j = i + 1; j < end; j++) if (re.test(lines[j])) return j + 1;
    return i;
  };
  if (SCRIPT_START.test(line)) return until(SCRIPT_END);
  if (before && RUN_LINE.test(line)) return i + 1;
  const h = HANDLER_START.exec(line);
  if (h && (before || h[1] === '>')) return until(HANDLER_END);
  const hl = HANDLER_LINE.exec(line);
  if (hl && (before || hl[1] === '>')) return i + 1;
  if (!before && (OUTPUT_REDIRECT.test(line) || RESPONSE_REF.test(line))) return i + 1;
  // Block comments: any `/*` above the request line; after it only a line that is exactly `/*`
  // (httpYac's own rule), so that a CSS or JavaScript body is never cut.
  if (before ? BLOCK_COMMENT_START.test(line) : /^\s*\/\*\s*$/.test(line)) {
    if (/\*\/\s*$/.test(line.replace(/^\s*\/\*/, ''))) return i + 1;
    return until(/\*\/\s*$/);
  }
  return i;
}

export function parseHttpFile(text: string): HttpFile {
  const lines = splitLines(text);
  const variables: FileVariable[] = [];
  const requests: ParsedRequest[] = [];
  const imports: string[] = [];

  // Split into blocks at ### lines (a ### inside a multi-line script or comment block does not count).
  const blocks: { start: number; end: number; title?: string }[] = [];
  let start = 0;
  let title: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const skip = Math.max(rawBlockEnd(lines, i, lines.length, true), rawBlockEnd(lines, i, lines.length, false));
    if (skip > i + 1) {
      i = skip - 1;
      continue;
    }
    const m = SEPARATOR.exec(lines[i]);
    if (m) {
      blocks.push({ start, end: i, title });
      start = i;
      title = m[1].trim() || undefined;
    }
  }
  blocks.push({ start, end: lines.length, title });

  for (const block of blocks) {
    // A block can hold several requests when they are not separated by ### (httpYac allows that).
    let from = block.start;
    let blockTitle = block.title;
    while (from < block.end) {
      const { req, next } = parseBlock(lines, from, block.end, blockTitle, variables, imports);
      if (req) requests.push(req);
      from = next;
      blockTitle = undefined;
    }
  }
  return imports.length ? { variables, requests, imports } : { variables, requests };
}

function parseBlock(
  lines: string[],
  start: number,
  end: number,
  title: string | undefined,
  variables: FileVariable[],
  imports: string[],
): { req?: ParsedRequest; next: number } {
  let i = start;
  if (i < end && SEPARATOR.test(lines[i])) i++;

  const meta: Record<string, string> = {};
  const comments: string[] = [];
  const asserts: string[] = [];
  const rawBefore: string[] = [];
  const rawAfter: string[] = [];
  let name: string | undefined;

  // Preamble: blank lines, comments, metadata, file variables, scripts.
  for (; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const raw = rawBlockEnd(lines, i, end, true);
    if (raw > i) {
      rawBefore.push(...lines.slice(i, raw));
      i = raw - 1;
      continue;
    }
    if (isHttpYacAssert(line)) {
      asserts.push(line);
      continue;
    }
    const imp = importPath(line);
    if (imp !== undefined) {
      imports.push(imp);
      continue;
    }
    const fv = FILE_VAR.exec(line);
    if (fv) {
      variables.push({ name: fv[1], value: fv[2] });
      continue;
    }
    const mm = META.exec(line);
    if (mm) {
      if (mm[1] === 'name') name = mm[2] || undefined;
      else if (mm[1] === 'assert') {
        if (mm[2]) asserts.push(mm[2]);
      } else meta[mm[1]] = mm[2];
      continue;
    }
    const cm = COMMENT.exec(line);
    if (cm) {
      comments.push(cm[2].replace(/^ /, ''));
      continue;
    }
    break;
  }
  if (i >= end) return { next: end };

  const rl = CUSTOM_METHOD_LINE.exec(lines[i]) ?? REQUEST_LINE.exec(lines[i]);
  if (!rl) return { next: end };
  const requestLine = i;
  let url = rl[2];
  const method = (rl[1] ?? 'GET').toUpperCase();
  const httpVersion = rl[3];
  i++;

  // Query continuation lines (`?a=1`, `&b=2`) and httpYac path continuations (`/more`) directly after the request line.
  for (; i < end && URL_CONTINUATION.test(lines[i]); i++) url += lines[i].trim();

  // Where the next request starts when it follows without ###: its request line, moved up over the
  // comment and metadata lines written directly above it (they belong to it, not to this request).
  const nextRequestAt = (at: number, taken: string[]): number => {
    let k = at;
    while (k > requestLine + 1 && COMMENT.test(lines[k - 1]) && !SEPARATOR.test(lines[k - 1])) k--;
    taken.splice(taken.length - (at - k), at - k);
    return k;
  };
  const finish = (endLine: number, headers: Header[], bodyLines: string[]): { req: ParsedRequest; next: number } => {
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    // Comment and `@name = value` lines at the end, after a blank line (or with no body text before
    // them), are notes and variables, not body: httpYac reads them so, and sending them is never meant.
    const notes: string[] = [];
    for (;;) {
      let k = bodyLines.length;
      while (k > 0 && (COMMENT.test(bodyLines[k - 1]) || TRAILING_VAR.test(bodyLines[k - 1]))) k--;
      let p = k;
      while (p > 0 && bodyLines[p - 1].trim() === '') p--;
      if (k === bodyLines.length || (p === k && p > 0)) break;
      notes.unshift(...bodyLines.splice(p).slice(k - p));
    }
    for (const line of notes) {
      const v = TRAILING_VAR.exec(line);
      if (v) variables.push({ name: v[1], value: v[2] });
    }
    rawAfter.push(...notes);
    while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    const body = bodyLines.length ? bodyLines.join('\n') : undefined;
    const req: ParsedRequest = { method, url, headers, startLine: start, endLine, requestLine };
    if (name) req.name = name;
    if (title) req.title = title;
    if (httpVersion) req.httpVersion = httpVersion;
    if (body !== undefined) req.body = body;
    if (Object.keys(meta).length) req.meta = meta;
    if (asserts.length) req.asserts = asserts;
    if (comments.length) req.comments = comments;
    if (rawBefore.length) req.rawBefore = rawBefore;
    if (rawAfter.length) req.rawAfter = rawAfter;
    return { req, next: endLine };
  };

  // Headers until a blank line.
  const headers: Header[] = [];
  const headerComments: string[] = [];
  for (; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      break;
    }
    if (isHttpYacAssert(line)) {
      asserts.push(line);
      continue;
    }
    if (NEXT_REQUEST_LINE.test(line)) return finish(nextRequestAt(i, headerComments), headers, []);
    const dh = DISABLED_HEADER.exec(line);
    if (dh) {
      headers.push({ name: dh[1], value: dh[2], disabled: true });
      continue;
    }
    if (COMMENT.test(line)) {
      headerComments.push(line);
      continue;
    }
    const h = HEADER.exec(line);
    if (h) headers.push({ name: h[1], value: h[2] });
    else {
      // Not a header: treat the rest as body (REST Client is lenient here).
      break;
    }
  }

  // A multipart body runs to its closing boundary before a request line can start a new request.
  const ct = headers.find((h) => !h.disabled && h.name.toLowerCase() === 'content-type')?.value ?? '';
  const boundary = /^\s*multipart\//i.test(ct) ? /boundary="?([^";\s]+)"?/i.exec(ct)?.[1] : undefined;
  let inMultipart = boundary !== undefined;

  // Body: everything until the end of the block, minus `??` test lines, scripts and output
  // redirects, up to a request line that starts the next request.
  const bodyLines: string[] = [];
  for (; i < end; i++) {
    const line = lines[i];
    if (isHttpYacAssert(line)) {
      asserts.push(line);
      continue;
    }
    const raw = rawBlockEnd(lines, i, end, false);
    if (raw > i) {
      rawAfter.push(...lines.slice(i, raw));
      i = raw - 1;
      continue;
    }
    if (inMultipart && line.includes(`--${boundary}--`)) inMultipart = false;
    if (!inMultipart && NEXT_REQUEST_LINE.test(line)) return finish(nextRequestAt(i, bodyLines), headers, bodyLines);
    bodyLines.push(line);
  }
  return finish(end, headers, bodyLines);
}

/** Serialize one request as a block, starting with its `###` separator line. */
export function serializeRequest(req: HttpRequest): string {
  const out: string[] = [];
  out.push(req.title ? `### ${req.title}` : '###');
  for (const c of req.comments ?? []) out.push(`# ${c}`.trimEnd());
  if (req.name) out.push(`# @name ${req.name}`);
  for (const [k, v] of Object.entries(req.meta ?? {})) out.push(`# @${k}${v ? ' ' + v : ''}`);
  const yac = (req.asserts ?? []).filter(isHttpYacAssert);
  for (const a of req.asserts ?? []) if (a.trim() && !isHttpYacAssert(a)) out.push(`# @assert ${a.trim()}`);
  out.push(...(req.rawBefore ?? []));
  out.push(`${req.method.toUpperCase()} ${req.url}${req.httpVersion ? ' ' + req.httpVersion : ''}`);
  for (const h of req.headers) {
    if (!h.name.trim()) continue;
    out.push(`${h.disabled ? '# ' : ''}${h.name}: ${h.value}`);
  }
  const hasBody = req.body !== undefined && req.body !== '';
  if (hasBody) {
    out.push('');
    out.push(req.body!.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  }
  // httpYac `??` lines go after the request, verbatim: right after the headers, or after a blank
  // line following the body (so they can never be read back as part of it).
  if (yac.length) {
    if (hasBody) out.push('');
    out.push(...yac);
  }
  // Scripts and output redirects after the request, after a blank line (never read back as headers).
  if (req.rawAfter?.length) {
    out.push('');
    out.push(...req.rawAfter);
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
  // Keep file variables and imports that live inside the block's preamble.
  const kept: string[] = [];
  for (let i = parsed.startLine; i < parsed.requestLine; i++) {
    if (FILE_VAR.test(lines[i]) || importPath(lines[i]) !== undefined) kept.push(lines[i]);
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

/**
 * A short human label for a request: its `###` title, else its `@name`, else the URL without the leading `{{host}}`
 * variable or scheme://host ("/users/1"). Used for history rows and request tab titles.
 */
export function shortLabel(r: { url: string; title?: string; name?: string }): string {
  if (r.title?.trim()) return r.title.trim();
  if (r.name?.trim()) return r.name.trim();
  const path = r.url.replace(/^\{\{[^{}]+\}\}(?=[/?#])/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(?=[/?#])/i, '');
  return path || r.url || 'New request';
}
