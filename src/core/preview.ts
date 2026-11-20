// Pure parts of "resolve a request without sending it", shared by exec.ts (extension + CLI) and the
// browser converter on the website. No Node APIs here.
import { base64Utf8 } from './curl.ts';
import { isGraphqlRequest, toGraphqlHttp } from './graphql.ts';
import type { HttpRequest } from './model.ts';
import { prepareBody } from './wire.ts';

/** A body that is exactly one `< ./file` (raw bytes) or `<@ ./file` (text with variables) line. */
export function bodyFileRef(body: string | undefined): { path: string; resolveVariables: boolean } | undefined {
  if (body === undefined) return undefined;
  const lines = body.split(/\r?\n/);
  const m = /^<(@?)\s+(.+?)\s*$/.exec(lines[0]);
  if (!m || lines.filter((l) => l.trim()).length !== 1) return undefined;
  return { path: m[2], resolveVariables: m[1] === '@' };
}

/** `Authorization: Basic user:pass` or `Basic user pass` → base64, as REST Client does. */
export function normalizeBasicAuth(req: HttpRequest): void {
  for (const h of req.headers) {
    if (h.name.toLowerCase() !== 'authorization') continue;
    const m = /^Basic\s+(.+)$/i.exec(h.value.trim());
    if (!m) continue;
    const v = m[1];
    if (v.includes(':')) h.value = `Basic ${base64Utf8(v)}`;
    else if (/\s/.test(v)) {
      const [u, ...p] = v.split(/\s+/);
      h.value = `Basic ${base64Utf8(`${u}:${p.join(' ')}`)}`;
    }
  }
}

/**
 * The last steps of a preview, after variables are resolved: the same GraphQL → JSON conversion as
 * sending, no body on GET/HEAD, and form/multipart bodies normalised as the sender does.
 */
export function toWireForm(resolved: HttpRequest): HttpRequest {
  if (isGraphqlRequest(resolved) && !bodyFileRef(resolved.body)) resolved = toGraphqlHttp(resolved, true);
  const method = resolved.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') resolved.body = undefined;
  else if (resolved.body !== undefined && !bodyFileRef(resolved.body)) resolved.body = prepareBody(resolved);
  return resolved;
}
