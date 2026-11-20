import type { HttpRequest, HttpResponse } from './model.ts';

export interface SendOptions {
  timeoutMs?: number;
  followRedirects?: boolean;
  signal?: AbortSignal;
  /** Body bytes to send instead of `req.body` (used for `< ./file` bodies). */
  bodyOverride?: Uint8Array;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|problem\+xml|soap\+xml|xhtml\+xml|yaml|x-yaml|x-ndjson|.*\+json|.*\+xml))/i;

/** Normalise a body before sending: form bodies may be split over lines starting with `&`. */
export function prepareBody(req: HttpRequest): string | undefined {
  if (req.body === undefined) return undefined;
  const ct = req.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  if (/application\/x-www-form-urlencoded/i.test(ct)) {
    return req.body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('');
  }
  // multipart bodies need CRLF line endings
  if (/multipart\//i.test(ct)) return req.body.replace(/\r?\n/g, '\r\n') + '\r\n';
  return req.body;
}

function ensureScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

/** Send a fully-resolved request with Node's fetch (no CORS in the extension host). */
export async function sendRequest(req: HttpRequest, opts: SendOptions = {}): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs) : undefined;
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason ?? new Error('Cancelled')), { once: true });

  const headers = new Headers();
  for (const h of req.headers) {
    if (h.disabled || !h.name) continue;
    // fetch computes these itself
    if (/^(content-length|host|connection)$/i.test(h.name)) continue;
    headers.append(h.name, h.value);
  }
  const method = req.method.toUpperCase();
  const body = opts.bodyOverride ?? (method === 'GET' || method === 'HEAD' ? undefined : prepareBody(req));

  const started = performance.now();
  try {
    const res = await fetch(ensureScheme(req.url), {
      method,
      headers,
      body: body as BodyInit | undefined,
      redirect: opts.followRedirects === false ? 'manual' : 'follow',
      signal: controller.signal,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const timeMs = Math.round(performance.now() - started);
    const ct = res.headers.get('content-type') ?? '';
    let text: string | undefined;
    if (TEXT_TYPES.test(ct) || ct === '') {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        text = undefined;
      }
    }
    const hdrs: [string, string][] = [];
    res.headers.forEach((v, k) => hdrs.push([k, v]));
    return {
      status: res.status,
      statusText: res.statusText,
      headers: hdrs,
      body: text ?? Buffer.from(buf).toString('base64'),
      bodyEncoding: text === undefined ? 'base64' : 'utf8',
      size: buf.byteLength,
      timeMs,
      url: res.url || req.url,
    };
  } catch (err) {
    const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message : undefined;
    const detail = reason ?? describeNetworkError(err);
    throw new Error(`Request failed: ${detail}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Turn undici's "fetch failed" into the underlying cause, e.g. "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1". */
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
