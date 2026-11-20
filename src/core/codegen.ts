// "Copy as Code": render a resolved request as a runnable snippet in another language or tool.
// Pure functions, no dependencies. Input is the request as it goes on the wire (variables already
// resolved, see exec.ts `previewRequest`); a body that is exactly `< ./path` is a file reference.
import { shellQuote, toCurl } from './curl.ts';
import type { HttpRequest } from './model.ts';

export type CodeTarget =
  | 'curl'
  | 'javascript-fetch'
  | 'node-fetch'
  | 'python-requests'
  | 'go'
  | 'httpie'
  | 'powershell'
  | 'wget'
  | 'csharp'
  | 'php-curl'
  | 'java';

export interface CodeTargetInfo {
  id: CodeTarget;
  label: string;
  /** Library / runtime, shown next to the label in the picker. */
  detail: string;
  /** Editor language id for opening the snippet. */
  language: string;
}

export const CODE_TARGETS: readonly CodeTargetInfo[] = [
  { id: 'curl', label: 'cURL', detail: 'shell', language: 'shellscript' },
  { id: 'javascript-fetch', label: 'JavaScript', detail: 'fetch (browser)', language: 'javascript' },
  { id: 'node-fetch', label: 'Node.js', detail: 'fetch, Node 18+', language: 'javascript' },
  { id: 'python-requests', label: 'Python', detail: 'requests', language: 'python' },
  { id: 'go', label: 'Go', detail: 'net/http', language: 'go' },
  { id: 'httpie', label: 'HTTPie', detail: 'shell, HTTPie 3.2+', language: 'shellscript' },
  { id: 'powershell', label: 'PowerShell', detail: 'Invoke-RestMethod', language: 'powershell' },
  { id: 'wget', label: 'wget', detail: 'shell, GNU Wget 1.15+', language: 'shellscript' },
  { id: 'csharp', label: 'C#', detail: 'HttpClient, .NET 6+', language: 'csharp' },
  { id: 'php-curl', label: 'PHP', detail: 'ext-curl', language: 'php' },
  { id: 'java', label: 'Java', detail: 'java.net.http.HttpClient, Java 11+', language: 'java' },
];

interface Hdr {
  name: string;
  value: string;
}

type Body = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'file'; path: string };

/** Normalised view of the request shared by all generators. */
interface Req {
  method: string;
  url: string;
  /** Enabled headers in order, duplicates kept. */
  headers: Hdr[];
  body: Body;
}

export function generateCode(target: CodeTarget, request: HttpRequest): string {
  const req = normalize(request);
  switch (target) {
    case 'curl':
      return toCurl({ method: req.method, url: req.url, headers: req.headers, body: req.body.kind === 'none' ? undefined : req.body.kind === 'file' ? `< ${req.body.path}` : req.body.text });
    case 'javascript-fetch':
      return jsFetch(req, false);
    case 'node-fetch':
      return jsFetch(req, true);
    case 'python-requests':
      return python(req);
    case 'go':
      return go(req);
    case 'httpie':
      return httpie(req);
    case 'powershell':
      return powershell(req);
    case 'wget':
      return wget(req);
    case 'csharp':
      return csharp(req);
    case 'php-curl':
      return php(req);
    case 'java':
      return java(req);
  }
}

function normalize(r: HttpRequest): Req {
  const headers = r.headers.filter((h) => !h.disabled && h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value }));
  let body: Body = { kind: 'none' };
  if (r.body !== undefined && r.body !== '') {
    const file = /^<@?\s+(\S.*?)\s*$/.exec(r.body.trim());
    body = file && !r.body.trim().includes('\n') ? { kind: 'file', path: file[1] } : { kind: 'text', text: r.body };
  }
  return { method: r.method.trim().toUpperCase() || 'GET', url: encodeUrl(r.url.trim()), headers, body };
}

/**
 * Percent-encode non-ASCII characters and spaces after the host, as Plainwire's sender does
 * (it goes through `new URL`). Leaves everything else, including `{{unresolved}}`, untouched.
 */
export function encodeUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([\s\S]*)$/i.exec(url)!;
  const rest = m[2].replace(/[^\x21-\x7e]+/g, (run) => {
    try {
      return encodeURI(run);
    } catch {
      return run; // lone surrogate: leave as is
    }
  });
  return (m[1] ?? '') + rest;
}

/** One value per name (case-insensitive), for clients whose headers are a map. Like HTTP itself: `, ` (Cookie: `; `). */
function mergeHeaders(headers: Hdr[]): Hdr[] {
  const out: Hdr[] = [];
  for (const h of headers) {
    const prev = out.find((o) => o.name.toLowerCase() === h.name.toLowerCase());
    if (prev) prev.value += (h.name.toLowerCase() === 'cookie' ? '; ' : ', ') + h.value;
    else out.push({ ...h });
  }
  return out;
}

const hasDuplicates = (headers: Hdr[]) => new Set(headers.map((h) => h.name.toLowerCase())).size !== headers.length;
const isNonAscii = (s: string) => /[^\x00-\x7f]/.test(s);
const hex2 = (c: string) => c.charCodeAt(0).toString(16).padStart(2, '0');
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const STANDARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// ---------------------------------------------------------------------------------------------
// String literals, one function per language

/** JavaScript: JSON string for one line, a template literal for multi-line text. */
export function jsString(s: string): string {
  if (!s.includes('\n')) return JSON.stringify(s);
  return (
    '`' +
    s.replace(/[\\`]|\$\{|[\x00-\x08\x0b-\x1f\x7f]/g, (c) => {
      if (c === '\\' || c === '`') return '\\' + c;
      if (c === '${') return '\\${';
      if (c === '\r') return '\\r';
      return '\\x' + hex2(c);
    }) +
    '`'
  );
}

/** Python 3: double-quoted (or single when that avoids escapes); triple-quoted for multi-line text. */
export function pyString(s: string): string {
  const esc = (q: string) => (c: string) => {
    if (c === '\\') return '\\\\';
    if (c === q) return '\\' + q;
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return '\\x' + hex2(c);
  };
  if (s.includes('\n')) {
    // A delimiter quote is escaped when another quote or the end follows it, so no unescaped
    // run of three (and no trailing quote) can end the literal early.
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    const body = s.replace(new RegExp(`[\\\\\\r\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]|${q}(?=${q}|$)`, 'g'), esc(q));
    return q.repeat(3) + body + q.repeat(3);
  }
  const q = s.includes('"') && !s.includes("'") ? "'" : '"';
  return q + s.replace(new RegExp(`[\\\\${q}\\x00-\\x1f\\x7f]`, 'g'), esc(q)) + q;
}

/** Go: raw string for multi-line text without backticks or CR (raw strings drop CR), else interpreted. */
export function goString(s: string): string {
  if (s.includes('\n') && !/[`\r\x00-\x08\x0b-\x1f\x7f]/.test(s)) return '`' + s + '`';
  return '"' + s.replace(/[\\"\x00-\x1f\x7f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\x' + hex2(c))) + '"';
}

/**
 * PowerShell: single-quoted, which never interpolates `$` or backtick escapes. `'` and the
 * typographic quotes PowerShell also treats as single quotes (U+2018..U+201B) are doubled.
 * CR and other control characters cannot be typed safely, so they are concatenated as "`r" etc.
 */
export function psString(s: string): string {
  const parts: string[] = [];
  let lit = '';
  const flush = () => {
    if (lit) parts.push(`'${lit}'`);
    lit = '';
  };
  for (const c of s) {
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(c)) {
      flush();
      parts.push(c === '\r' ? '"`r"' : c === '\0' ? '"`0"' : `"\`u{${c.charCodeAt(0).toString(16)}}"`);
    } else lit += /['‘-‛]/.test(c) ? c + c : c;
  }
  flush();
  if (!parts.length) return "''";
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`;
}

/** C#: regular literal with escapes, or a verbatim @"..." (only `"` doubled) for multi-line text. */
export function csString(s: string): string {
  if (s.includes('\n') && !/[\r\x00-\x08\x0b-\x1f\x7f]/.test(s)) return '@"' + s.replace(/"/g, '""') + '"';
  return '"' + s.replace(/[\\"\x00-\x1f\x7f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + hex4(c.charCodeAt(0)))) + '"';
}

/** PHP: single quotes (only `\` and `'` are special); double quotes with escapes when there are control characters. */
export function phpString(s: string): string {
  if (!/[\r\x00-\x08\x0b-\x1f\x7f]/.test(s)) return "'" + s.replace(/[\\']/g, (c) => '\\' + c) + "'";
  return '"' + s.replace(/[\\"$\x00-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : /[\\"$]/.test(c) ? '\\' + c : '\\x' + hex2(c))) + '"';
}

/**
 * Java: double-quoted with escapes; everything outside printable ASCII as \uXXXX so the file
 * compiles whatever the source encoding. Multi-line text is split into one `+` part per line.
 */
export function javaString(s: string, indent = ''): string {
  const one = (t: string) =>
    '"' +
    t.replace(/[^\x20-\x7e]|[\\"]/g, (c) => {
      if (c === '\\' || c === '"') return '\\' + c;
      if (c === '\n') return '\\n';
      if (c === '\r') return '\\r';
      if (c === '\t') return '\\t';
      return '\\u' + hex4(c.charCodeAt(0)); // one UTF-16 unit (no `u` flag), so surrogate pairs become two escapes
    }) +
    '"';
  const lines = s.split(/(?<=\n)/);
  if (lines.length < 2) return one(s);
  return lines.map(one).join(`\n${indent}+ `);
}

// ---------------------------------------------------------------------------------------------
// Generators

function jsFetch(r: Req, node: boolean): string {
  const lines: string[] = [];
  if (node && r.body.kind === 'file') lines.push(`import { readFile } from 'node:fs/promises';`, '');
  if (hasDuplicates(r.headers)) lines.push('// Repeated headers are combined into one, as fetch() does.');
  if (!node && r.body.kind === 'file') lines.push(`// The body is the file ${r.body.path}; it is not inlined. In a browser, pass a File or Blob (e.g. from <input type="file">).`);
  const opts: string[] = [`  method: ${JSON.stringify(r.method)},`];
  const headers = mergeHeaders(r.headers);
  if (headers.length) {
    opts.push('  headers: {');
    for (const h of headers) opts.push(`    ${JSON.stringify(h.name)}: ${JSON.stringify(h.value)},`);
    opts.push('  },');
  }
  if (r.body.kind === 'text') opts.push(`  body: ${jsString(r.body.text)},`);
  else if (r.body.kind === 'file') opts.push(node ? `  body: await readFile(${JSON.stringify(r.body.path)}),` : `  body: file, // contents of ${r.body.path}`);
  if (!node && r.body.kind === 'file') lines.push('const file = /* File or Blob */ null;', '');
  lines.push(`const response = await fetch(${JSON.stringify(r.url)}, {`, ...opts, '});', '', 'console.log(response.status);', 'console.log(await response.text());');
  return lines.join('\n') + '\n';
}

function python(r: Req): string {
  const lines = ['import requests', '', `url = ${pyString(r.url)}`];
  const headers = mergeHeaders(r.headers);
  if (headers.length) {
    if (hasDuplicates(r.headers)) lines.push('# Repeated headers are combined into one (requests takes a dict).');
    lines.push('headers = {', ...headers.map((h) => `    ${pyString(h.name)}: ${pyString(h.value)},`), '}');
  }
  const m = r.method;
  const call = STANDARD_METHODS.includes(m) ? `requests.${m.toLowerCase()}(url` : `requests.request(${pyString(m)}, url`;
  const args = headers.length ? ', headers=headers' : '';
  if (r.body.kind === 'text') {
    // A str body would be encoded as Latin-1 by http.client; send UTF-8 bytes instead.
    lines.push(`data = ${pyString(r.body.text)}${isNonAscii(r.body.text) ? '.encode("utf-8")' : ''}`, '');
    lines.push(`response = ${call}${args}, data=data)`);
  } else if (r.body.kind === 'file') {
    lines.push('', `with open(${pyString(r.body.path)}, "rb") as f:`, `    response = ${call}${args}, data=f)`);
  } else {
    lines.push('', `response = ${call}${args})`);
  }
  lines.push('', 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n') + '\n';
}

function go(r: Req): string {
  const imports = ['fmt', 'io', 'net/http'];
  let bodyExpr = 'nil';
  const pre: string[] = [];
  if (r.body.kind === 'text') {
    imports.push('strings');
    pre.push(`\tbody := strings.NewReader(${goString(r.body.text)})`);
    bodyExpr = 'body';
  } else if (r.body.kind === 'file') {
    imports.push('bytes', 'os');
    pre.push(`\tdata, err := os.ReadFile(${goString(r.body.path)})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
    bodyExpr = 'bytes.NewReader(data)';
  }
  imports.sort();
  const methodConst: Record<string, string> = { GET: 'http.MethodGet', POST: 'http.MethodPost', PUT: 'http.MethodPut', PATCH: 'http.MethodPatch', DELETE: 'http.MethodDelete', HEAD: 'http.MethodHead', OPTIONS: 'http.MethodOptions' };
  const lines = ['package main', '', 'import (', ...imports.map((i) => `\t"${i}"`), ')', '', 'func main() {', ...pre];
  lines.push(`\treq, err := http.NewRequest(${methodConst[r.method] ?? goString(r.method)}, ${goString(r.url)}, ${bodyExpr})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
  for (const h of r.headers) {
    if (h.name.toLowerCase() === 'host') lines.push(`\treq.Host = ${goString(h.value)}`);
    else lines.push(`\treq.Header.Add(${goString(h.name)}, ${goString(h.value)})`);
  }
  lines.push(
    '',
    '\tresp, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '',
    '\tout, err := io.ReadAll(resp.Body)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tfmt.Println(resp.Status)',
    '\tfmt.Println(string(out))',
    '}',
  );
  return lines.join('\n') + '\n';
}

function httpie(r: Req): string {
  // HTTPie reads stdin as the body whenever stdin is not a terminal (scripts, CI, editors' tasks):
  // that clashes with --raw and makes body-less requests wait for input. Only a `< file` body uses stdin.
  const args = r.body.kind === 'file' ? ['http'] : ['http', '--ignore-stdin'];
  if (r.body.kind === 'text') args.push(`--raw ${shellQuote(r.body.text)}`);
  args.push(`${r.method} ${shellQuote(r.url)}`);
  for (const h of r.headers) {
    // `Name:=x` would be a JSON field and `Name:=@x` a JSON file: escape a leading `=`.
    const value = h.value.startsWith('=') ? '\\' + h.value : h.value;
    args.push(shellQuote(h.value === '' ? `${h.name};` : `${h.name}:${value}`));
  }
  let out = args.join(' \\\n  ');
  if (r.body.kind === 'file') out += ` \\\n  < ${shellQuote(r.body.path)}`;
  return out + '\n';
}

function wget(r: Req): string {
  const args = ['wget', '--quiet', '--output-document=-', '--content-on-error', `--method=${r.method}`];
  for (const h of mergeHeaders(r.headers)) args.push(shellQuote(`--header=${h.name}: ${h.value}`));
  if (r.body.kind === 'text') args.push(shellQuote(`--body-data=${r.body.text}`));
  else if (r.body.kind === 'file') args.push(shellQuote(`--body-file=${r.body.path}`));
  args.push(shellQuote(r.url));
  return (hasDuplicates(r.headers) ? '# Repeated headers are combined into one (wget keeps only the last of each name).\n' : '') + args.join(' \\\n  ') + '\n';
}

function powershell(r: Req): string {
  const lines: string[] = [];
  const headers = mergeHeaders(r.headers);
  const ct = headers.find((h) => h.name.toLowerCase() === 'content-type');
  const ua = headers.find((h) => h.name.toLowerCase() === 'user-agent');
  const rest = headers.filter((h) => h !== ct && h !== ua);
  if (hasDuplicates(r.headers)) lines.push('# Repeated headers are combined into one (-Headers takes a hashtable).');
  if (rest.length) lines.push('$headers = @{', ...rest.map((h) => `    ${psString(h.name)} = ${psString(h.value)}`), '}');
  const params = [`-Uri ${psString(r.url)}`];
  const pretty: Record<string, string> = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' };
  params.push(pretty[r.method] ? `-Method ${pretty[r.method]}` : `-CustomMethod ${psString(r.method)}`);
  if (rest.length) params.push('-Headers $headers');
  if (ct) params.push(`-ContentType ${psString(ct.value)}`);
  if (ua) params.push(`-UserAgent ${psString(ua.value)}`);
  if (r.body.kind === 'text') {
    lines.push(`$body = ${psString(r.body.text)}`);
    // Windows PowerShell 5.1 encodes string bodies as ISO-8859-1; bytes are sent as they are.
    params.push(isNonAscii(r.body.text) ? '-Body ([System.Text.Encoding]::UTF8.GetBytes($body))' : '-Body $body');
  } else if (r.body.kind === 'file') params.push(`-InFile ${psString(r.body.path)}`);
  lines.push('', `$response = Invoke-RestMethod ${params.join(' `\n  ')}`, '$response');
  return lines.join('\n').replace(/^\n/, '') + '\n';
}

const CONTENT_HEADERS = ['allow', 'content-disposition', 'content-encoding', 'content-language', 'content-length', 'content-location', 'content-md5', 'content-range', 'content-type', 'expires', 'last-modified'];

function csharp(r: Req): string {
  const lines = ['using System;', ...(r.body.kind === 'file' ? ['using System.IO;'] : []), 'using System.Net.Http;', 'using System.Text;', '', 'using var client = new HttpClient();'];
  const methodProp: Record<string, string> = { GET: 'HttpMethod.Get', POST: 'HttpMethod.Post', PUT: 'HttpMethod.Put', PATCH: 'HttpMethod.Patch', DELETE: 'HttpMethod.Delete', HEAD: 'HttpMethod.Head', OPTIONS: 'HttpMethod.Options' };
  lines.push(`using var request = new HttpRequestMessage(${methodProp[r.method] ?? `new HttpMethod(${csString(r.method)})`}, ${csString(r.url)});`);
  const content = r.headers.filter((h) => CONTENT_HEADERS.includes(h.name.toLowerCase()));
  for (const h of r.headers) {
    if (!content.includes(h)) lines.push(`request.Headers.TryAddWithoutValidation(${csString(h.name)}, ${csString(h.value)});`);
  }
  if (r.body.kind !== 'none') {
    lines.push(r.body.kind === 'text' ? `request.Content = new StringContent(${csString(r.body.text)}, Encoding.UTF8);` : `request.Content = new ByteArrayContent(File.ReadAllBytes(${csString(r.body.path)}));`);
    // StringContent adds "text/plain; charset=utf-8"; send exactly the request's own Content-Type (or none).
    if (r.body.kind === 'text') lines.push('request.Content.Headers.ContentType = null;');
    for (const h of content) {
      if (h.name.toLowerCase() === 'content-length') continue; // computed from the body
      lines.push(`request.Content.Headers.TryAddWithoutValidation(${csString(h.name)}, ${csString(h.value)});`);
    }
  } else if (content.some((h) => h.name.toLowerCase() !== 'content-length')) {
    lines.push(`// Not sent: ${content.map((h) => h.name).join(', ')} (content headers need a body in HttpClient).`);
  }
  lines.push('', 'using var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return lines.join('\n') + '\n';
}

function php(r: Req): string {
  const opts = [`    CURLOPT_URL => ${phpString(r.url)},`];
  if (r.method === 'HEAD') opts.push('    CURLOPT_NOBODY => true,');
  else if (r.method !== 'GET' || r.body.kind !== 'none') opts.push(`    CURLOPT_CUSTOMREQUEST => ${phpString(r.method)},`);
  if (r.headers.length) {
    opts.push('    CURLOPT_HTTPHEADER => [');
    for (const h of r.headers) opts.push(`        ${phpString(h.value === '' ? `${h.name};` : `${h.name}: ${h.value}`)},`);
    opts.push('    ],');
  }
  if (r.body.kind === 'text') opts.push(`    CURLOPT_POSTFIELDS => ${phpString(r.body.text)},`);
  else if (r.body.kind === 'file') opts.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpString(r.body.path)}),`);
  opts.push('    CURLOPT_RETURNTRANSFER => true,');
  return [
    '<?php',
    '',
    '$ch = curl_init();',
    'curl_setopt_array($ch, [',
    ...opts,
    ']);',
    '$response = curl_exec($ch);',
    'if ($response === false) {',
    '    throw new RuntimeException(curl_error($ch));',
    '}',
    'echo curl_getinfo($ch, CURLINFO_RESPONSE_CODE), PHP_EOL;',
    'echo $response, PHP_EOL;',
    'curl_close($ch);',
    '',
  ].join('\n');
}

/** Headers java.net.http refuses unless -Djdk.httpclient.allowRestrictedHeaders is set. */
const JAVA_RESTRICTED = ['connection', 'content-length', 'expect', 'host', 'upgrade'];

function java(r: Req): string {
  const imports = ['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse'];
  if (r.body.kind === 'file') imports.push('java.nio.file.Path');
  const ind = '                ';
  let publisher = 'HttpRequest.BodyPublishers.noBody()';
  if (r.body.kind === 'text') publisher = `HttpRequest.BodyPublishers.ofString(${javaString(r.body.text, ind + '        ')})`;
  else if (r.body.kind === 'file') publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${javaString(r.body.path)}))`;
  const builder = [`${ind}.uri(URI.create(${javaString(r.url)}))`];
  if (r.method === 'GET' && r.body.kind === 'none') builder.push(`${ind}.GET()`);
  else builder.push(`${ind}.method(${javaString(r.method)}, ${publisher})`);
  const skipped: string[] = [];
  for (const h of r.headers) {
    if (JAVA_RESTRICTED.includes(h.name.toLowerCase())) skipped.push(h.name);
    else builder.push(`${ind}.header(${javaString(h.name)}, ${javaString(h.value)})`);
  }
  const lines = [...imports.map((i) => `import ${i};`), '', 'public class Main {', '    public static void main(String[] args) throws Exception {'];
  if (skipped.length) lines.push(`        // Not sent: ${skipped.join(', ')} (restricted in java.net.http; HttpClient sets them itself).`);
  lines.push(
    '        HttpClient client = HttpClient.newHttpClient();',
    '        HttpRequest request = HttpRequest.newBuilder()',
    ...builder,
    `${ind}.build();`,
    '        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
    '        System.out.println(response.statusCode());',
    '        System.out.println(response.body());',
    '    }',
    '}',
  );
  return lines.join('\n') + '\n';
}
