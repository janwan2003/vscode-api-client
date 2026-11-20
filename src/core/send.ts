import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type Socket } from 'node:net';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import type { HttpRequest, HttpResponse } from './model.ts';
import { ensureScheme, prepareBody } from './wire.ts';

export { ensureScheme, prepareBody } from './wire.ts';

export interface SendOptions {
  /** Overall deadline for the whole exchange, redirects and body included. */
  timeoutMs?: number;
  followRedirects?: boolean;
  /** Maximum number of redirects to follow (default 10). */
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Body bytes to send instead of `req.body` (used for `< ./file` bodies). */
  bodyOverride?: Uint8Array;
  /** Verify TLS certificates (default true). `false` accepts self-signed, expired or mismatched certificates. */
  rejectUnauthorized?: boolean;
  /**
   * HTTP proxy, `http://[user:pass@]host:port` (an `https://` proxy URL is also accepted).
   * http targets are sent to it as absolute-URI requests; https targets are tunnelled with CONNECT.
   */
  proxy?: string;
  /** Hosts that bypass the proxy: exact hosts, domain suffixes (`example.com`, `.example.com`, `*.example.com`) or `*`. localhost is always bypassed. */
  noProxy?: string[];
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|problem\+xml|soap\+xml|xhtml\+xml|yaml|x-yaml|x-ndjson|.*\+json|.*\+xml))/i;

const TLS_ERRORS = /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_UNTRUSTED|CERT_REVOKED|CERT_SIGNATURE_FAILURE|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH|INVALID_CA)\b/;
const TLS_HINT = 'Set "plainwire.rejectUnauthorized": false to accept it (or add # @insecure above the request).';

interface Hdr {
  name: string;
  value: string;
}

/**
 * Send a fully-resolved request with node:http / node:https (no CORS, any port, per-request TLS
 * settings, proxies, header casing preserved).
 */
export async function sendRequest(req: HttpRequest, opts: SendOptions = {}): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs) : undefined;
  const onAbort = () => controller.abort(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error('Cancelled'));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = controller.signal;

  const started = performance.now();
  try {
    let url = new URL(ensureScheme(req.url));
    let method = req.method.toUpperCase();
    let headers: Hdr[] = [];
    for (const h of req.headers) {
      if (h.disabled || !h.name) continue;
      // Computed per hop (Content-Length) or managed by node (Connection).
      if (/^(content-length|connection)$/i.test(h.name)) continue;
      headers.push({ name: h.name, value: h.value });
    }
    // http://user:pass@host → Basic auth, unless the request already has an Authorization header.
    if (url.username || url.password) {
      if (!hasHeader(headers, 'authorization')) {
        const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(cred).toString('base64')}` });
      }
      url.username = '';
      url.password = '';
    }
    if (!hasHeader(headers, 'accept-encoding')) headers.push({ name: 'Accept-Encoding', value: 'gzip, deflate, br' });

    const text = opts.bodyOverride ?? (method === 'GET' || method === 'HEAD' ? undefined : prepareBody(req));
    let body: Uint8Array | undefined = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;

    const maxRedirects = opts.maxRedirects ?? 10;
    for (let hop = 0; ; hop++) {
      const res = await exchange(url, method, headers, body, opts, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (opts.followRedirects !== false && [301, 302, 303, 307, 308].includes(status) && location) {
        res.destroy();
        if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects})`);
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`Redirect to unsupported URL ${next.href}`);
        if (status !== 307 && status !== 308) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          headers = headers.filter((h) => !/^(content-type|content-encoding|transfer-encoding)$/i.test(h.name));
        }
        if (next.host !== url.host) headers = headers.filter((h) => !/^(authorization|host)$/i.test(h.name));
        url = next;
        continue;
      }

      const raw = await readBody(res);
      const buf = decompress(raw, res.headers['content-encoding']);
      const timeMs = Math.round(performance.now() - started);
      const ct = res.headers['content-type'] ?? '';
      let decoded: string | undefined;
      if (TEXT_TYPES.test(ct) || ct === '') {
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch {
          decoded = undefined;
        }
      }
      const hdrs: [string, string][] = [];
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) hdrs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
      return {
        status,
        statusText: res.statusMessage ?? '',
        headers: hdrs,
        body: decoded ?? Buffer.from(buf).toString('base64'),
        bodyEncoding: decoded === undefined ? 'base64' : 'utf8',
        // Body bytes as received on the wire, i.e. before gzip/deflate/br decompression (headers not counted).
        size: raw.byteLength,
        timeMs,
        url: url.href,
      };
    }
  } catch (err) {
    const reason = signal.aborted && signal.reason instanceof Error ? signal.reason.message : undefined;
    let detail = reason ?? describeNetworkError(err);
    if (!reason && TLS_ERRORS.test(detail)) detail = `${detail.replace(/\.$/, '')}. ${TLS_HINT}`;
    throw new Error(`Request failed: ${detail}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function hasHeader(headers: Hdr[], lower: string): boolean {
  return headers.some((h) => h.name.toLowerCase() === lower);
}

/** One request/response round trip (no redirect handling); resolves once the response head arrives. */
async function exchange(url: URL, method: string, headers: Hdr[], body: Uint8Array | undefined, opts: SendOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:';
  if (!secure && url.protocol !== 'http:') throw new Error(`Unsupported protocol ${url.protocol}`);
  const host = stripBrackets(url.hostname);
  const port = Number(url.port) || (secure ? 443 : 80);
  const rejectUnauthorized = opts.rejectUnauthorized !== false;
  const proxy = opts.proxy && !bypassProxy(host, port, opts.noProxy) ? parseProxy(opts.proxy) : undefined;

  // Header order and casing as the user wrote them; Host first unless the user placed (and set) it.
  const out = new Map<string, { name: string; values: string[] }>();
  if (!hasHeader(headers, 'host')) out.set('host', { name: 'Host', values: [url.host] });
  for (const h of headers) {
    const k = h.name.toLowerCase();
    const e = out.get(k);
    if (e) e.values.push(h.value);
    else out.set(k, { name: h.name, values: [h.value] });
  }
  if (body !== undefined && !out.has('transfer-encoding')) out.set('content-length', { name: 'Content-Length', values: [String(body.byteLength)] });
  if (proxy?.auth && !secure) out.set('proxy-authorization', { name: 'Proxy-Authorization', values: [proxy.auth] });

  const path = `${url.pathname}${url.search}`;
  let options: http.RequestOptions & tls.ConnectionOptions;
  let mod: typeof http | typeof https = secure ? https : http;
  if (!proxy) {
    options = { host, port, path, rejectUnauthorized };
  } else if (!secure) {
    // Absolute-URI request to the proxy.
    mod = proxy.url.protocol === 'https:' ? https : http;
    options = { host: proxy.host, port: proxy.port, path: `${url.protocol}//${url.host}${path}`, rejectUnauthorized };
  } else {
    const socket = await tunnel(proxy, host, port, rejectUnauthorized, signal);
    const tlsSocket = await startTls(socket, host, rejectUnauthorized, signal);
    mod = http;
    options = { host, port, path, createConnection: () => tlsSocket };
  }

  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const r = mod.request({ ...options, method, setHost: false, agent: options.createConnection ? undefined : false, signal });
    r.on('error', reject);
    r.on('response', resolve);
    try {
      for (const { name, values } of out.values()) r.setHeader(name, values.length === 1 ? values[0] : values);
    } catch (e) {
      r.destroy();
      return reject(e);
    }
    if (body !== undefined) r.end(body);
    else r.end();
  });
}

function readBody(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.on('close', () => {
      if (!res.complete) reject(new Error('Connection closed before the response body was complete'));
    });
  });
}

/** Undo Content-Encoding (gzip, deflate, br; possibly stacked). Returns the input unchanged if it cannot. */
function decompress(buf: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || buf.byteLength === 0) return buf;
  const codings = encoding.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'identity');
  let out = buf;
  try {
    for (const c of codings.reverse()) {
      if (c === 'gzip' || c === 'x-gzip') out = zlib.gunzipSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (c === 'br') out = zlib.brotliDecompressSync(out);
      else if (c === 'deflate') {
        try {
          out = zlib.inflateSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
          out = zlib.inflateRawSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        }
      } else return buf;
    }
  } catch {
    return buf;
  }
  return out;
}

interface Proxy {
  url: URL;
  host: string;
  port: number;
  auth?: string;
}

function parseProxy(p: string): Proxy {
  const url = new URL(ensureScheme(p.trim()));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported proxy protocol ${url.protocol} (only http:// and https:// proxies are supported)`);
  const auth = url.username || url.password ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : undefined;
  return { url, host: stripBrackets(url.hostname), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), auth };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Whether `host` should be reached directly rather than through the proxy. */
export function bypassProxy(host: string, port: number, noProxy: string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return true;
  for (const raw of noProxy) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    const pm = /^(.*?):(\d+)$/.exec(e);
    if (pm && !e.includes('::')) {
      if (Number(pm[2]) !== port) continue;
      e = pm[1];
    }
    e = stripBrackets(e).replace(/^\*?\./, '');
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** Open an HTTP CONNECT tunnel through the proxy to host:port. */
function tunnel(proxy: Proxy, host: string, port: number, rejectUnauthorized: boolean, signal: AbortSignal): Promise<Socket> {
  const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const headers: Record<string, string> = { Host: target };
  if (proxy.auth) headers['Proxy-Authorization'] = proxy.auth;
  const mod = proxy.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = mod.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: target, headers, setHost: false, agent: false, rejectUnauthorized, signal });
    r.on('error', reject);
    r.on('connect', (res: http.IncomingMessage, socket: Socket, head: Buffer) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT to ${target} failed: ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    // Non-2xx answers to CONNECT may arrive as an ordinary response.
    r.on('response', (res: http.IncomingMessage) => {
      res.destroy();
      reject(new Error(`Proxy CONNECT to ${target} failed: ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
    });
    r.end();
  });
}

function startTls(socket: Socket, host: string, rejectUnauthorized: boolean, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: isIP(host) ? undefined : host, rejectUnauthorized, ALPNProtocols: ['http/1.1'] });
    const onAbort = () => s.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    s.once('secureConnect', () => {
      signal.removeEventListener('abort', onAbort);
      resolve(s);
    });
    s.once('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(e);
    });
  });
}

/** Turn wrapped network errors into the underlying cause, e.g. "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1". */
export function describeNetworkError(err: unknown): string {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const e = cur as { code?: string; message?: string; cause?: unknown; errors?: unknown[] };
    if (e.code) return `${e.code}: ${e.message ?? ''}`.trim();
    if (Array.isArray(e.errors) && e.errors.length) cur = e.errors[0];
    else if (e.cause) cur = e.cause;
    else return e.message ?? String(cur);
  }
  return (err as Error)?.message ?? String(err);
}
