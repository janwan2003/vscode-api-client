/**
 * A cookie jar for an API client, after RFC 6265 (section 5): `Set-Cookie` from every response
 * (redirect hops included) is stored, and matching cookies are sent as a `Cookie` header on later
 * requests, so a login that sets a session cookie works for the requests after it.
 *
 * Not a browser: SameSite is ignored (every request is "same-site"), and there is no public-suffix
 * list, so a `Domain` attribute is accepted when the request host domain-matches it and it contains
 * a dot (or equals the host). `Secure` cookies are sent over https, and also to localhost and
 * 127.0.0.1 over http, as browsers do. Pure: no Node APIs, so the web bundle can use it too.
 */

export interface Cookie {
  name: string;
  value: string;
  /** Lower-case domain without a leading dot. */
  domain: string;
  /** True when the response set no `Domain` attribute: sent to this exact host only. */
  hostOnly: boolean;
  path: string;
  /** Expiry in ms since the epoch; undefined for a session cookie. */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  /** Creation time (ms), kept when a cookie is replaced; orders the `Cookie` header. */
  created: number;
}

/** One `Set-Cookie` header, parsed but not yet tied to a request URL. */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** From `Max-Age` if present (it wins), else `Expires`. NaN-free; undefined = session cookie. */
  expires?: number;
  /** `Max-Age` <= 0 or an `Expires` in the past: the cookie is deleted. */
  expired?: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

const MAX_COOKIES = 3000;
const MAX_PER_DOMAIN = 180;

/** Parse one `Set-Cookie` header value. Returns undefined for a line a browser would ignore. */
export function parseSetCookie(header: string, now = Date.now()): ParsedSetCookie | undefined {
  const parts = header.split(';');
  const first = parts.shift()!;
  const eq = first.indexOf('=');
  if (eq < 0) return undefined; // RFC 6265 5.2: no '=' in the name-value pair → ignore
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || name.length + value.length > 4096 || /[\x00-\x1f\x7f]/.test(name + value)) return undefined;
  const out: ParsedSetCookie = { name, value, secure: false, httpOnly: false };
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const part of parts) {
    const i = part.indexOf('=');
    const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : part.slice(i + 1).trim();
    if (key === 'domain') {
      const d = val.replace(/^\./, '').toLowerCase();
      if (d) out.domain = d;
    } else if (key === 'path') {
      out.path = val.startsWith('/') ? val : undefined;
    } else if (key === 'max-age') {
      if (/^-?\d+$/.test(val)) maxAge = Number(val);
    } else if (key === 'expires') {
      const t = parseCookieDate(val);
      if (t !== undefined) expires = t;
    } else if (key === 'secure') out.secure = true;
    else if (key === 'httponly') out.httpOnly = true;
    else if (key === 'samesite' && val) out.sameSite = val;
  }
  if (maxAge !== undefined) {
    if (maxAge <= 0) out.expired = true;
    else out.expires = now + maxAge * 1000;
  } else if (expires !== undefined) {
    if (expires <= now) out.expired = true;
    else out.expires = expires;
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The cookie date algorithm of RFC 6265 5.1.1 (lenient: any order, 2-digit years). */
export function parseCookieDate(s: string): number | undefined {
  let time: number[] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const tok of s.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/).filter(Boolean)) {
    const t = /^(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(tok);
    if (!time && t) {
      time = [Number(t[1]), Number(t[2]), Number(t[3])];
      continue;
    }
    if (day === undefined && /^\d{1,2}(\D|$)/.test(tok)) {
      day = parseInt(tok, 10);
      continue;
    }
    const m = MONTHS.indexOf(tok.slice(0, 3).toLowerCase());
    if (month === undefined && m >= 0) {
      month = m;
      continue;
    }
    if (year === undefined && /^\d{2,4}(\D|$)/.test(tok)) {
      year = parseInt(tok, 10);
      if (year >= 70 && year <= 99) year += 1900;
      else if (year >= 0 && year <= 69) year += 2000;
    }
  }
  if (!time || day === undefined || month === undefined || year === undefined) return undefined;
  if (day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59) return undefined;
  return Date.UTC(year, month, day, time[0], time[1], time[2]);
}

function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isIpAddress(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

/** RFC 6265 5.1.3. */
export function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith('.' + domain) && !isIpAddress(host));
}

/** RFC 6265 5.1.4: the directory of the request path. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

/** RFC 6265 5.1.4. */
export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

function isLocal(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

export class CookieJar {
  private cookies: Cookie[] = [];

  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies.filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string');
  }

  /** Store the `Set-Cookie` headers of a response to `url`. Returns how many were stored or deleted. */
  setFromResponse(url: string | URL, setCookies: readonly string[], now = Date.now()): number {
    const u = typeof url === 'string' ? new URL(url) : url;
    let n = 0;
    for (const h of setCookies) if (this.set(u, h, now)) n++;
    return n;
  }

  /** Store one `Set-Cookie` header received from `url`. False when it was rejected. */
  set(url: URL, header: string, now = Date.now()): boolean {
    const p = parseSetCookie(header, now);
    if (!p) return false;
    const host = canonicalHost(url.hostname);
    const secureUrl = url.protocol === 'https:' || isLocal(host);
    let domain = host;
    let hostOnly = true;
    if (p.domain !== undefined && p.domain !== host) {
      // A Domain attribute must cover the host and must not be a bare top-level label ("com").
      if (!domainMatch(host, p.domain) || !p.domain.includes('.')) return false;
      domain = p.domain;
      hostOnly = false;
    }
    if (p.secure && !secureUrl) return false; // RFC 6265bis: only secure origins may set Secure
    if (p.name.startsWith('__Secure-') && !(p.secure && secureUrl)) return false;
    if (p.name.startsWith('__Host-') && !(p.secure && secureUrl && hostOnly && p.path === '/')) return false;
    const path = p.path ?? defaultPath(url.pathname);
    const i = this.cookies.findIndex((c) => c.name === p.name && c.domain === domain && c.path === path);
    if (p.expired) {
      if (i >= 0) this.cookies.splice(i, 1);
      return true;
    }
    // A replaced cookie keeps its creation time and its place (RFC 6265 5.3 step 11.3).
    const cookie: Cookie = { name: p.name, value: p.value, domain, hostOnly, path, expires: p.expires, secure: p.secure, httpOnly: p.httpOnly, sameSite: p.sameSite, created: i >= 0 ? this.cookies[i].created : now };
    if (i >= 0) this.cookies[i] = cookie;
    else this.cookies.push(cookie);
    this.evict(domain, now);
    return true;
  }

  private evict(domain: string, now: number): void {
    this.removeExpired(now);
    const same = this.cookies.filter((c) => c.domain === domain);
    if (same.length > MAX_PER_DOMAIN) this.drop(same.length - MAX_PER_DOMAIN, (c) => c.domain === domain);
    if (this.cookies.length > MAX_COOKIES) this.drop(this.cookies.length - MAX_COOKIES, () => true);
  }

  /** Drop the `n` oldest cookies matching `pred`. */
  private drop(n: number, pred: (c: Cookie) => boolean): void {
    const victims = new Set(this.cookies.filter(pred).sort((a, b) => a.created - b.created).slice(0, n));
    this.cookies = this.cookies.filter((c) => !victims.has(c));
  }

  removeExpired(now = Date.now()): void {
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
  }

  /** Cookies to send to `url`, longest path first, then oldest first (RFC 6265 5.4). */
  matching(url: string | URL, now = Date.now()): Cookie[] {
    const u = typeof url === 'string' ? new URL(url) : url;
    const host = canonicalHost(u.hostname);
    const secureUrl = u.protocol === 'https:' || isLocal(host);
    const path = u.pathname || '/';
    this.removeExpired(now);
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) && pathMatch(path, c.path) && (!c.secure || secureUrl))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  /** The `Cookie` header value for `url`, or undefined when no cookie matches. */
  cookieHeader(url: string | URL, now = Date.now()): string | undefined {
    const m = this.matching(url, now);
    return m.length ? m.map((c) => `${c.name}=${c.value}`).join('; ') : undefined;
  }

  /** All stored cookies (copies), for display and persistence. */
  list(now = Date.now()): Cookie[] {
    this.removeExpired(now);
    return this.cookies.map((c) => ({ ...c }));
  }

  /** Remove one cookie (by name, domain and path), or every cookie when no argument is given. */
  delete(c?: Pick<Cookie, 'name' | 'domain' | 'path'>): void {
    this.cookies = c ? this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)) : [];
  }

  get size(): number {
    return this.cookies.length;
  }

  /** Persisted form: session cookies are kept too (a VS Code session is the "browser session"). */
  toJSON(): Cookie[] {
    return this.list();
  }
}

/**
 * Combine the request's own `Cookie` header with the jar's: the request's cookies are sent as
 * written, and jar cookies are added unless the request already sets a cookie of that name.
 */
export function mergeCookieHeader(explicit: string | undefined, fromJar: string | undefined): string | undefined {
  if (!fromJar) return explicit;
  if (!explicit || !explicit.trim()) return fromJar;
  const names = new Set(explicit.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean));
  const extra = fromJar.split('; ').filter((p) => !names.has(p.split('=')[0]));
  return extra.length ? `${explicit.trim().replace(/;\s*$/, '')}; ${extra.join('; ')}` : explicit;
}
