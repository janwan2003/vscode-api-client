// Pure request normalisation shared by the sender, previews and the browser converter (no Node APIs).
import type { HttpRequest } from './model.ts';

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

export function ensureScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}
