import type { Header, HttpRequest } from './model.ts';
import { toGraphqlHttp } from './graphql.ts';

/**
 * cURL <-> HttpRequest conversion.
 *
 * `parseCurl` accepts what browsers' "Copy as cURL" (bash and cmd flavours), API docs and
 * shell history produce. Options that only change how curl itself behaves (-s, -L, -k, ...)
 * are ignored; options that take a value but do not affect the request are skipped together
 * with their value so the value is not mistaken for the URL.
 */

/** Fixed boundary so generated multipart bodies are stable (and diffable in git). */
export const MULTIPART_BOUNDARY = '----PlainwireFormBoundary7MA4YWxkTrZu0gW';

export interface MultipartPart {
  name: string;
  /** Text value, used when `file` is not set. */
  value?: string;
  /** Path of a file to upload; written as a `< path` line (REST Client syntax). */
  file?: string;
  filename?: string;
  contentType?: string;
}

/** Build a multipart/form-data body using `\n` line ends and the fixed boundary. */
export function buildMultipartBody(parts: MultipartPart[], boundary = MULTIPART_BOUNDARY): string {
  const out: string[] = [];
  for (const p of parts) {
    out.push(`--${boundary}`);
    let disp = `Content-Disposition: form-data; name="${p.name.replace(/"/g, '%22')}"`;
    if (p.file !== undefined) {
      const fname = p.filename ?? baseName(p.file);
      disp += `; filename="${fname.replace(/"/g, '%22')}"`;
    }
    out.push(disp);
    if (p.contentType) out.push(`Content-Type: ${p.contentType}`);
    out.push('');
    out.push(p.file !== undefined ? `< ${filePath(p.file)}` : (p.value ?? ''));
  }
  out.push(`--${boundary}--`);
  return out.join('\n');
}

export function multipartContentType(boundary = MULTIPART_BOUNDARY): string {
  return `multipart/form-data; boundary=${boundary}`;
}

/** REST Client resolves `< path` relative to the .http file; make bare relative paths explicit. */
export function filePath(p: string): string {
  const t = p.trim();
  if (/^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/]|\{\{)/.test(t)) return t;
  return `./${t}`;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Base64 of the UTF-8 bytes of `s` (works in Node and browsers). */
export function base64Utf8(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** `Authorization` value for HTTP basic auth. Credentials containing `{{vars}}` cannot be pre-encoded,
 *  so they are written in REST Client's plain `Basic user:password` form instead. */
export function basicAuthValue(user: string, password: string): string {
  const pair = `${user}:${password}`;
  return pair.includes('{{') ? `Basic ${pair}` : `Basic ${base64Utf8(pair)}`;
}

/** Percent-encode for application/x-www-form-urlencoded, leaving `{{var}}` placeholders intact. */
export function formEncode(s: string): string {
  return s
    .split(/(\{\{[^{}]*\}\})/)
    .map((seg, i) => (i % 2 === 1 ? seg : encodeURIComponent(seg)))
    .join('');
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

/** Split a shell command line into arguments. Stops at an unquoted `|`, `;`, `&&`, `>` word. */
export function tokenizeShell(input: string): string[] {
  const cmd = /\^\r?\n/.test(input) || /\^"/.test(input);
  return cmd ? tokenizeCmd(input) : tokenizePosix(input);
}

function tokenizePosix(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  const n = input.length;
  const push = () => {
    if (inWord) tokens.push(cur);
    cur = '';
    inWord = false;
  };
  while (i < n) {
    const c = input[i];
    if (c === '\\') {
      // Line continuation (also tolerate trailing spaces after the backslash).
      const m = /^\\[ \t]*\r?\n/.exec(input.slice(i, i + 64));
      if (m) {
        i += m[0].length;
        continue;
      }
      if (i + 1 < n) {
        cur += input[i + 1];
        inWord = true;
        i += 2;
      } else i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (!inWord && c === '#') {
      // Comment until end of line.
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (!inWord && (c === '|' || c === ';' || c === '>' || (c === '&' && input[i + 1] === '&'))) break;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote in curl command');
      cur += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && input[i + 1] === "'") {
      const r = readAnsiC(input, i + 2);
      cur += r.value;
      inWord = true;
      i = r.end;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      let closed = false;
      while (i < n) {
        const d = input[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n) {
          const e = input[i + 1];
          if (e === '\n') {
            i += 2;
            continue;
          }
          if (e === '\r' && input[i + 2] === '\n') {
            i += 3;
            continue;
          }
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            cur += e;
            i += 2;
            continue;
          }
        }
        cur += d;
        i++;
      }
      if (!closed) throw new Error('Unterminated double quote in curl command');
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  push();
  return tokens;
}

function readAnsiC(s: string, start: number): { value: string; end: number } {
  let out = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") return { value: out, end: i + 1 };
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    i += 2;
    const simple: Record<string, string> = {
      n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b',
      '\\': '\\', "'": "'", '"': '"', '?': '?',
    };
    if (e in simple) {
      out += simple[e];
    } else if (e === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i));
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 16));
        i += m[0].length;
      } else out += '\\x';
    } else if (e === 'u' || e === 'U') {
      const m = (e === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i));
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
      } else out += '\\' + e;
    } else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{0,2}/.exec(s.slice(i))!;
      out += String.fromCharCode(parseInt(e + m[0], 8));
      i += m[0].length;
    } else {
      out += '\\' + e;
    }
  }
  throw new Error("Unterminated $'...' string in curl command");
}

/** Windows cmd flavour (Chrome "Copy as cURL (cmd)"): `^` escapes the next character, `^` + newline
 *  continues the line, and the resulting argv is split with MSVCRT rules (`"` groups, `\"` is a quote). */
function tokenizeCmd(input: string): string[] {
  let s = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '^') {
      if (input[i + 1] === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (input[i + 1] === '\n') {
        i++;
        continue;
      }
      if (i + 1 < input.length) s += input[++i];
      continue;
    }
    s += c;
  }
  const tokens: string[] = [];
  let cur = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let j = i;
      while (s[j] === '\\') j++;
      const count = j - i;
      if (s[j] === '"') {
        cur += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) {
          cur += '"';
          i = j;
        } else i = j - 1;
      } else {
        cur += '\\'.repeat(count);
        i = j - 1;
      }
      inWord = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      inWord = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (inWord) tokens.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quoted) throw new Error('Unterminated double quote in curl command');
  if (inWord) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser

type Kind =
  | 'request' | 'header' | 'data' | 'data-raw' | 'data-binary' | 'data-urlencode' | 'json'
  | 'user' | 'user-agent' | 'cookie' | 'referer' | 'url' | 'form' | 'form-string'
  | 'get' | 'head' | 'oauth2-bearer' | 'upload-file' | 'skip-value' | 'flag';

const LONG: Record<string, Kind> = {
  request: 'request', header: 'header', data: 'data', 'data-ascii': 'data', 'data-raw': 'data-raw',
  'data-binary': 'data-binary', 'data-urlencode': 'data-urlencode', json: 'json', user: 'user',
  'user-agent': 'user-agent', cookie: 'cookie', referer: 'referer', url: 'url', form: 'form',
  'form-string': 'form-string', get: 'get', head: 'head', 'oauth2-bearer': 'oauth2-bearer',
  'upload-file': 'upload-file',
};

/** Long options that take a value we do not use. Anything else unknown is treated as a flag. */
const LONG_WITH_VALUE = new Set([
  'output', 'write-out', 'max-time', 'connect-timeout', 'proxy', 'proxy-user', 'cert', 'cert-type',
  'key', 'key-type', 'pass', 'cacert', 'capath', 'crlfile', 'range', 'cookie-jar', 'config',
  'dump-header', 'retry', 'retry-delay', 'retry-max-time', 'limit-rate', 'resolve', 'connect-to',
  'interface', 'max-redirs', 'ciphers', 'dns-servers', 'proxy-header', 'unix-socket',
  'abstract-unix-socket', 'aws-sigv4', 'variable', 'speed-limit', 'speed-time', 'local-port',
  'max-filesize', 'trace', 'trace-ascii', 'stderr', 'output-dir', 'netrc-file', 'preproxy',
  'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'noproxy', 'expect100-timeout', 'happy-eyeballs-timeout-ms',
  'pinnedpubkey', 'tls-max', 'tlsuser', 'tlspassword', 'login-options', 'mail-from', 'mail-rcpt',
  'ftp-port', 'quote', 'telnet-option', 'time-cond', 'proto', 'proto-redir', 'proto-default',
  'header-file', 'keepalive-time', 'sasl-authzid', 'service-name', 'parallel-max', 'rate', 'etag-save',
  'etag-compare', 'json-file', 'hsts', 'alt-svc', 'doh-url', 'delegation', 'krb', 'engine', 'random-file',
]);

const SHORT: Record<string, Kind> = {
  X: 'request', H: 'header', d: 'data', u: 'user', A: 'user-agent', b: 'cookie', e: 'referer',
  F: 'form', G: 'get', I: 'head', T: 'upload-file',
  o: 'skip-value', w: 'skip-value', m: 'skip-value', x: 'skip-value', E: 'skip-value', r: 'skip-value',
  c: 'skip-value', K: 'skip-value', U: 'skip-value', D: 'skip-value', Y: 'skip-value', y: 'skip-value',
  z: 'skip-value', C: 'skip-value', t: 'skip-value', Q: 'skip-value', P: 'skip-value',
};

const NO_VALUE: Kind[] = ['get', 'head', 'flag'];

/** Parse a curl command line into a request. Throws if the text is not a curl command. */
export function parseCurl(command: string): HttpRequest {
  let text = command.trim().replace(/^\$\s+/, '');
  if (!/^(\S*[\\/])?curl(\.exe)?(\s|\^|$)/i.test(text)) {
    throw new Error(`Not a curl command: expected the text to start with "curl", got "${text.slice(0, 40)}"`);
  }
  const tokens = tokenizeShell(text);
  if (!tokens.length || !/(^|[\\/])curl(\.exe)?$/i.test(tokens[0])) {
    throw new Error('Not a curl command: expected the first word to be "curl"');
  }

  let method: string | undefined;
  let url: string | undefined;
  const headers: Header[] = [];
  const data: { kind: Kind; value: string }[] = [];
  const form: MultipartPart[] = [];
  let useGet = false;
  let head = false;
  let user: string | undefined;
  let uploadFile: string | undefined;
  let endOfOptions = false;

  const apply = (kind: Kind, value: string) => {
    switch (kind) {
      case 'request': method = value.toUpperCase(); break;
      case 'header': addHeader(headers, value); break;
      case 'data': case 'data-raw': case 'data-binary': case 'data-urlencode': case 'json':
        data.push({ kind, value }); break;
      case 'user': user = value; break;
      case 'user-agent': setHeader(headers, 'User-Agent', value); break;
      case 'cookie':
        // Without '=' the value is a cookie file name, which we cannot use.
        if (value.includes('=')) setHeader(headers, 'Cookie', value);
        break;
      case 'referer': setHeader(headers, 'Referer', value.replace(/;auto$/, '')); break;
      case 'url': if (url === undefined) url = value; break;
      case 'form': form.push(parseFormArg(value, false)); break;
      case 'form-string': form.push(parseFormArg(value, true)); break;
      case 'oauth2-bearer': setHeader(headers, 'Authorization', `Bearer ${value}`); break;
      case 'upload-file': uploadFile = value; break;
      case 'get': useGet = true; break;
      case 'head': head = true; break;
      default: break;
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = (): string => {
      if (i + 1 >= tokens.length) throw new Error(`curl option ${tok} expects a value`);
      return tokens[++i];
    };
    if (!endOfOptions && tok === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && tok.startsWith('--') && tok.length > 2) {
      const name = tok.slice(2);
      const kind = LONG[name];
      if (kind) {
        if (NO_VALUE.includes(kind)) apply(kind, '');
        else apply(kind, next());
      } else if (LONG_WITH_VALUE.has(name)) next();
      // else: a flag such as --compressed, --location, --insecure, --http2: ignored.
      continue;
    }
    if (!endOfOptions && tok.startsWith('-') && tok.length > 1) {
      // Short options, possibly combined (-sSL) or with an attached value (-XPOST, -H'A: b').
      for (let j = 1; j < tok.length; j++) {
        const kind = SHORT[tok[j]];
        if (!kind) continue; // -s, -S, -L, -k, -v, -i, ...: ignored
        if (NO_VALUE.includes(kind)) {
          apply(kind, '');
          continue;
        }
        const rest = tok.slice(j + 1);
        apply(kind, rest !== '' ? rest : next());
        break;
      }
      continue;
    }
    if (url === undefined) url = tok;
  }

  if (url === undefined || url === '') throw new Error('curl command has no URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = `http://${url}`;

  // Body.
  let body: string | undefined;
  const isJson = data.some((d) => d.kind === 'json');
  if (data.length) {
    const parts = data.map((d) => dataPart(d.kind, d.value));
    const joined = isJson ? parts.join('') : parts.join('&');
    if (useGet) {
      url += (url.includes('?') ? '&' : '?') + joined;
    } else {
      body = joined;
      if (isJson) {
        if (!hasHeader(headers, 'Content-Type')) headers.push({ name: 'Content-Type', value: 'application/json' });
        if (!hasHeader(headers, 'Accept')) headers.push({ name: 'Accept', value: 'application/json' });
      } else if (!hasHeader(headers, 'Content-Type')) {
        headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
      }
    }
  } else if (form.length) {
    body = buildMultipartBody(form);
    // An explicit multipart Content-Type without our boundary would not match the body.
    removeHeader(headers, 'Content-Type');
    headers.push({ name: 'Content-Type', value: multipartContentType() });
  } else if (uploadFile !== undefined && uploadFile !== '-' && uploadFile !== '.') {
    body = `< ${filePath(uploadFile)}`;
  }

  if (user !== undefined && !hasHeader(headers, 'Authorization')) {
    const c = user.indexOf(':');
    headers.push({
      name: 'Authorization',
      value: c < 0 ? basicAuthValue(user, '') : basicAuthValue(user.slice(0, c), user.slice(c + 1)),
    });
  }

  if (!method) {
    if (head) method = 'HEAD';
    else if (useGet) method = 'GET';
    else if (body !== undefined || data.length) method = 'POST';
    else if (uploadFile !== undefined) method = 'PUT';
    else method = 'GET';
  }

  const req: HttpRequest = { method, url, headers };
  if (body !== undefined) req.body = body;
  return req;
}

function dataPart(kind: Kind, value: string): string {
  if (kind === 'data-raw') return value;
  if (kind === 'data-urlencode') {
    // Forms: "content", "=content", "name=content", "@file", "name@file".
    const eq = value.indexOf('=');
    const at = value.indexOf('@');
    if (eq === 0) return formEncode(value.slice(1));
    if (eq > 0 && (at < 0 || eq < at)) return `${value.slice(0, eq)}=${formEncode(value.slice(eq + 1))}`;
    if (at === 0) return `< ${filePath(value.slice(1))}`;
    if (at > 0) return `${value.slice(0, at)}=< ${filePath(value.slice(at + 1))}`;
    return formEncode(value);
  }
  // -d, --data-binary, --json: a leading @ reads a file.
  if (value.startsWith('@') && value.length > 1) {
    const f = value.slice(1);
    return f === '-' ? '' : `< ${filePath(f)}`;
  }
  return value;
}

function parseFormArg(arg: string, literal: boolean): MultipartPart {
  const eq = arg.indexOf('=');
  const name = eq < 0 ? arg : arg.slice(0, eq);
  let value = eq < 0 ? '' : arg.slice(eq + 1);
  if (literal) return { name, value };
  if (value.startsWith('@') || value.startsWith('<')) {
    const isUpload = value.startsWith('@');
    // name=@path;type=image/png;filename=x.png
    const [path, ...attrs] = value.slice(1).split(';');
    const part: MultipartPart = { name, file: path };
    for (const a of attrs) {
      const ae = a.indexOf('=');
      if (ae < 0) continue;
      const k = a.slice(0, ae).trim().toLowerCase();
      const v = a.slice(ae + 1).trim().replace(/^"(.*)"$/, '$1');
      if (k === 'type') part.contentType = v;
      else if (k === 'filename' && isUpload) part.filename = v;
    }
    if (!isUpload) {
      // `<file`: the file's content is the field value, without a filename. Express that with a
      // file reference but no filename attribute.
      return { name, value: `< ${filePath(path)}`, contentType: part.contentType };
    }
    return part;
  }
  // name=value;type=text/plain
  const semi = value.match(/^(.*?);type=([^;]+)$/);
  if (semi) {
    value = semi[1];
    return { name, value, contentType: semi[2] };
  }
  return { name, value };
}

function addHeader(headers: Header[], raw: string): void {
  if (raw.startsWith('@')) return; // header file
  const c = raw.indexOf(':');
  if (c < 0) {
    // "Name;" sends an empty header.
    if (raw.endsWith(';')) headers.push({ name: raw.slice(0, -1).trim(), value: '' });
    return;
  }
  const name = raw.slice(0, c).trim();
  const value = raw.slice(c + 1).trim();
  if (!name) return;
  if (value === '') {
    // "Name:" removes a header curl would add; nothing to send.
    removeHeader(headers, name);
    return;
  }
  headers.push({ name, value });
}

function hasHeader(headers: Header[], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some((h) => !h.disabled && h.name.toLowerCase() === n);
}

function removeHeader(headers: Header[], name: string): void {
  const n = name.toLowerCase();
  for (let i = headers.length - 1; i >= 0; i--) if (headers[i].name.toLowerCase() === n) headers.splice(i, 1);
}

function setHeader(headers: Header[], name: string, value: string): void {
  removeHeader(headers, name);
  headers.push({ name, value });
}

// ---------------------------------------------------------------------------------------------
// Serializer

/** Quote for POSIX shells: single quotes, with embedded `'` written as `'\''`. */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Render a request as a multi-line curl command (one argument per line). GraphQL requests get their JSON body. */
export function toCurl(request: HttpRequest): string {
  const req = toGraphqlHttp(request, true);
  const lines: string[] = [`curl ${shellQuote(req.url)}`];
  const method = req.method.toUpperCase();
  const hasBody = req.body !== undefined && req.body !== '';
  if (method === 'HEAD' && !hasBody) lines.push('--head');
  // Without -X, curl sends GET (or POST when there is data), so a GET with a body needs it too.
  else if (method !== 'GET' || hasBody) lines.push(`-X ${method}`);
  for (const h of req.headers) {
    if (h.disabled || !h.name.trim()) continue;
    lines.push(`-H ${shellQuote(h.value === '' ? `${h.name};` : `${h.name}: ${h.value}`)}`);
  }
  if (req.body !== undefined && req.body !== '') {
    const fileRef = /^<\s+(\S.*)$/.exec(req.body.trim());
    if (fileRef && !req.body.trim().includes('\n')) lines.push(`--data-binary ${shellQuote('@' + fileRef[1])}`);
    else lines.push(`--data-raw ${shellQuote(req.body)}`);
  }
  return lines.join(' \\\n  ');
}
