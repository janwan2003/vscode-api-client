import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpRequest, HttpResponse } from './model.ts';

/**
 * OAuth 2.0 in the JetBrains HTTP Client format. An environment in `http-client.env.json` holds
 *
 *   "Security": { "Auth": { "my-api": { "Type": "OAuth2", "Grant Type": "Client Credentials",
 *                                      "Token URL": "...", "Client ID": "...", "Client Secret": "{{secret}}" } } }
 *
 * and a request uses `Authorization: Bearer {{$auth.token("my-api")}}` (or `$auth.idToken`). The token is
 * fetched before the request, cached, refreshed with its refresh token when it expires, and fetched again
 * when it cannot be refreshed. Grant types: Authorization Code (with PKCE), Client Credentials, Password,
 * Device Authorization and Implicit; `"Type": "Mock"` returns a fixed `"Token"`.
 */

export type GrantType = 'Authorization Code' | 'Client Credentials' | 'Device Authorization' | 'Implicit' | 'Password';
export const GRANT_TYPES: GrantType[] = ['Authorization Code', 'Client Credentials', 'Device Authorization', 'Implicit', 'Password'];
type Use = 'Everywhere' | 'In Auth Request' | 'In Token Request';

export interface OAuth2Config {
  id: string;
  type: 'OAuth2' | 'Mock';
  grantType?: GrantType;
  authUrl?: string;
  tokenUrl?: string;
  redirectUrl?: string;
  deviceAuthUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** How the client authenticates at the token endpoint (JetBrains default: basic). */
  clientCredentials: 'basic' | 'in body' | 'none';
  scope?: string;
  username?: string;
  password?: string;
  /** PKCE for the Authorization Code grant. */
  pkce?: { method: 'S256' | 'plain'; verifier?: string };
  params: { name: string; value: string; use: Use }[];
  headers: { name: string; value: string; use: Use }[];
  /** `false`: never start a sign-in for a request; only a token acquired before (or refreshed) is used. */
  acquireAutomatically: boolean;
  /** `$auth.token` returns the ID token instead of the access token. */
  useIdToken: boolean;
  /** Device Authorization: open `verification_uri_complete` (the code is in the URL). */
  openCompleteUri: boolean;
  /** Mock: the fixed tokens. */
  mockToken?: string;
  mockIdToken?: string;
}

export interface OAuth2Token {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Epoch ms; undefined = the server did not say (valid until cleared). */
  expiresAt?: number;
  obtainedAt: number;
}

/** What the token manager needs from its surroundings. */
export interface OAuth2Host {
  /** Send a token/device request (with the host's TLS, proxy and timeout settings). */
  send(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
  /** Open the sign-in page in a browser (Authorization Code, Implicit, Device Authorization). */
  openBrowser?(url: string): Promise<void> | void;
  /** Show the device code to the user while polling (Device Authorization). */
  showDeviceCode?(info: { id: string; userCode: string; verificationUri: string; verificationUriComplete?: string }): void;
  /** Progress messages ("Signing in to my-api…"). */
  log?(message: string): void;
  now?(): number;
  /** Override for tests: how long to wait between device polls. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Tokens expiring within this window are refreshed before use. */
const EXPIRY_SKEW_MS = 30_000;
/** Longest wait for the browser to come back to the redirect URL, or for a device to be approved. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** `$auth.token("id")` / `$auth.idToken("id")` references in text, deduplicated. */
export function authReferences(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*\$auth\.(?:token|idToken)\(\s*["']([^"']+)["']\s*\)\s*\}\}/g)) ids.add(m[1]);
  return [...ids];
}

/** Parse `$auth.token("id")` / `$auth.idToken("id")`; undefined for anything else. */
export function parseAuthVariable(expr: string): { kind: 'token' | 'idToken'; id: string } | undefined {
  const m = /^\$auth\.(token|idToken)\(\s*["']([^"']+)["']\s*\)$/.exec(expr.trim());
  return m ? { kind: m[1] as 'token' | 'idToken', id: m[2] } : undefined;
}

/** The `Security.Auth` object of a merged environment (stored as a JSON string by the env loaders). */
export function authConfigs(environment: Record<string, string>): Record<string, Record<string, unknown>> {
  const raw = environment['Security'];
  if (!raw) return {};
  let sec: unknown;
  try {
    sec = JSON.parse(raw);
  } catch {
    return {};
  }
  const auth = sec && typeof sec === 'object' ? (sec as Record<string, unknown>)['Auth'] : undefined;
  if (!auth || typeof auth !== 'object') return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(auth as Record<string, unknown>)) if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as Record<string, unknown>;
  return out;
}

/**
 * Read one auth configuration from the environment. String values may use `{{variables}}`; `resolve`
 * substitutes them. Throws a readable error for a missing id, unknown type or grant, or missing URLs.
 */
export function readAuthConfig(environment: Record<string, string>, id: string, resolve: (s: string) => string = (s) => s): OAuth2Config {
  const all = authConfigs(environment);
  const raw = all[id];
  if (!raw) {
    const names = Object.keys(all);
    throw new Error(`No auth configuration "${id}" in the environment's "Security": { "Auth": { ... } }${names.length ? ` (found: ${names.join(', ')})` : '. Select an environment that defines it in http-client.env.json'}`);
  }
  // Keys are matched case-insensitively and ignoring spaces ("Token URL" = "tokenUrl").
  const get = (key: string): unknown => {
    const want = key.replace(/\s+/g, '').toLowerCase();
    const k = Object.keys(raw).find((x) => x.replace(/\s+/g, '').toLowerCase() === want);
    return k === undefined ? undefined : raw[k];
  };
  const str = (key: string): string | undefined => {
    const v = get(key);
    if (v === undefined || v === null || v === '') return undefined;
    return resolve(typeof v === 'string' ? v : String(v));
  };
  const bool = (key: string, dflt: boolean): boolean => {
    const v = get(key);
    if (v === undefined || v === null || v === '') return dflt;
    return v === true || String(v).toLowerCase() === 'true';
  };
  const typeRaw = String(get('Type') ?? 'OAuth2');
  const type = /^mock$/i.test(typeRaw) ? 'Mock' : /^oauth\s*2(\.0)?$/i.test(typeRaw) ? 'OAuth2' : undefined;
  if (!type) throw new Error(`Auth "${id}": "Type": "${typeRaw}" is not supported (use "OAuth2" or "Mock")`);
  if (type === 'Mock') {
    return { id, type, clientCredentials: 'basic', params: [], headers: [], acquireAutomatically: true, useIdToken: bool('Use ID Token', false), openCompleteUri: false, mockToken: str('Token') ?? '', mockIdToken: str('ID Token') };
  }
  const grantRaw = str('Grant Type');
  const grantType = GRANT_TYPES.find((g) => g.replace(/\s+/g, '').toLowerCase() === (grantRaw ?? '').replace(/[\s_-]+/g, '').toLowerCase()) ??
    ({ authorizationcode: 'Authorization Code', clientcredentials: 'Client Credentials', devicecode: 'Device Authorization', password: 'Password', implicit: 'Implicit' } as Record<string, GrantType>)[(grantRaw ?? '').replace(/[\s_-]+/g, '').toLowerCase()];
  if (!grantType) throw new Error(`Auth "${id}": "Grant Type" ${grantRaw ? `"${grantRaw}" is not supported` : 'is missing'} (use ${GRANT_TYPES.map((g) => `"${g}"`).join(', ')})`);
  const credRaw = (str('Client Credentials') ?? 'basic').toLowerCase().replace(/\s+/g, ' ');
  const clientCredentials = credRaw === 'in body' || credRaw === 'body' ? 'in body' : credRaw === 'none' ? 'none' : 'basic';
  let pkce: OAuth2Config['pkce'];
  const p = get('PKCE');
  if (p === true || p === 'true') pkce = { method: 'S256' };
  else if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    const m = String(o['Code Challenge Method'] ?? 'S256');
    pkce = { method: /plain/i.test(m) ? 'plain' : 'S256', verifier: o['Code Verifier'] ? resolve(String(o['Code Verifier'])) : undefined };
  }
  const custom = (key: string) => {
    const out: { name: string; value: string; use: Use }[] = [];
    const v = get(key);
    if (!v || typeof v !== 'object') return out;
    for (const [name, val] of Object.entries(v as Record<string, unknown>)) {
      const push = (x: unknown, use: Use) => out.push({ name, value: resolve(String(x)), use });
      if (Array.isArray(val)) val.forEach((x) => push(x, 'Everywhere'));
      else if (val && typeof val === 'object') {
        const o = val as Record<string, unknown>;
        const u = String(o['Use'] ?? 'Everywhere');
        const use: Use = /auth/i.test(u) ? 'In Auth Request' : /token/i.test(u) ? 'In Token Request' : 'Everywhere';
        const values = Array.isArray(o['Value']) ? (o['Value'] as unknown[]) : [o['Value']];
        values.filter((x) => x !== undefined && x !== null).forEach((x) => push(x, use));
      } else if (val !== undefined && val !== null) push(val, 'Everywhere');
    }
    return out;
  };
  const cfg: OAuth2Config = {
    id,
    type,
    grantType,
    authUrl: str('Auth URL'),
    tokenUrl: str('Token URL'),
    redirectUrl: str('Redirect URL'),
    deviceAuthUrl: str('Device Auth URL'),
    clientId: str('Client ID'),
    clientSecret: str('Client Secret'),
    clientCredentials,
    scope: str('Scope'),
    username: str('Username'),
    password: str('Password'),
    pkce,
    params: custom('Custom Request Parameters'),
    headers: custom('Custom Request Headers'),
    acquireAutomatically: bool('Acquire Automatically', true),
    useIdToken: bool('Use ID Token', false),
    openCompleteUri: bool('Open Complete URI', false),
  };
  const need = (cond: unknown, what: string) => {
    if (!cond) throw new Error(`Auth "${id}" (${grantType}): "${what}" is missing`);
  };
  need(cfg.clientId, 'Client ID');
  if (grantType === 'Authorization Code' || grantType === 'Implicit') need(cfg.authUrl, 'Auth URL');
  if (grantType !== 'Implicit') need(cfg.tokenUrl, 'Token URL');
  if (grantType === 'Device Authorization') need(cfg.deviceAuthUrl, 'Device Auth URL');
  if (grantType === 'Password') need(cfg.username, 'Username');
  return cfg;
}

/** Identifies a token: the same id in two environments with different servers or clients gets two tokens. */
function cacheKey(c: OAuth2Config): string {
  return JSON.stringify([c.id, c.type, c.grantType, c.tokenUrl, c.authUrl, c.clientId, c.scope, c.username, c.mockToken]);
}

export class OAuth2Error extends Error {}

/**
 * Fetches, caches and refreshes tokens. One instance per extension window / CLI run.
 */
export class OAuth2Manager {
  private readonly tokens = new Map<string, OAuth2Token>();
  private readonly pending = new Map<string, Promise<OAuth2Token>>();

  constructor(private readonly host: OAuth2Host) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** A cached token that has not expired, without sending anything (for Copy as cURL). */
  cached(cfg: OAuth2Config): OAuth2Token | undefined {
    if (cfg.type === 'Mock') return mockToken(cfg, this.now());
    const t = this.tokens.get(cacheKey(cfg));
    return t && !this.expired(t) ? t : undefined;
  }

  /** Every cached token with its auth id (for the "clear tokens" command). */
  get size(): number {
    return this.tokens.size;
  }

  clear(): void {
    this.tokens.clear();
  }

  private expired(t: OAuth2Token): boolean {
    return t.expiresAt !== undefined && t.expiresAt - EXPIRY_SKEW_MS <= this.now();
  }

  /**
   * A valid token: the cached one, else refreshed with the refresh token, else a new sign-in
   * (`force` skips the cache and the refresh). Concurrent calls for the same token share one sign-in.
   */
  async token(cfg: OAuth2Config, opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<OAuth2Token> {
    if (cfg.type === 'Mock') return mockToken(cfg, this.now());
    const key = cacheKey(cfg);
    const cur = this.tokens.get(key);
    if (cur && !opts.force && !this.expired(cur)) return cur;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      if (cur?.refreshToken && !opts.force) {
        try {
          return await this.refresh(cfg, cur, opts.signal);
        } catch (e) {
          this.host.log?.(`Auth "${cfg.id}": refresh failed (${(e as Error).message}); signing in again`);
        }
      }
      if (!cfg.acquireAutomatically && !opts.force) {
        throw new OAuth2Error(`Auth "${cfg.id}" has "Acquire Automatically": false and no valid token. Acquire one first (Plainwire: Acquire OAuth 2 Token).`);
      }
      return this.acquire(cfg, opts.signal);
    })();
    this.pending.set(key, p);
    try {
      const t = await p;
      this.tokens.set(key, t);
      return t;
    } finally {
      this.pending.delete(key);
    }
  }

  private async refresh(cfg: OAuth2Config, cur: OAuth2Token, signal?: AbortSignal): Promise<OAuth2Token> {
    this.host.log?.(`Auth "${cfg.id}": refreshing the token`);
    const t = await this.tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: cur.refreshToken! }, signal);
    // A server may omit the refresh token on refresh: keep the old one.
    return { ...t, refreshToken: t.refreshToken ?? cur.refreshToken, idToken: t.idToken ?? cur.idToken };
  }

  private async acquire(cfg: OAuth2Config, signal?: AbortSignal): Promise<OAuth2Token> {
    this.host.log?.(`Auth "${cfg.id}": ${cfg.grantType} sign-in`);
    switch (cfg.grantType) {
      case 'Client Credentials':
        return this.tokenRequest(cfg, { grant_type: 'client_credentials', ...(cfg.scope ? { scope: cfg.scope } : {}) }, signal);
      case 'Password':
        return this.tokenRequest(cfg, { grant_type: 'password', username: cfg.username ?? '', password: cfg.password ?? '', ...(cfg.scope ? { scope: cfg.scope } : {}) }, signal);
      case 'Authorization Code':
        return this.authorizationCode(cfg, signal);
      case 'Implicit':
        return this.implicit(cfg, signal);
      case 'Device Authorization':
        return this.device(cfg, signal);
      default:
        throw new OAuth2Error(`Auth "${cfg.id}": unsupported grant type`);
    }
  }

  /** POST to the token endpoint with client authentication and custom parameters/headers. */
  private async tokenRequest(cfg: OAuth2Config, params: Record<string, string>, signal?: AbortSignal, url = cfg.tokenUrl!): Promise<OAuth2Token> {
    const res = await this.post(cfg, url, params, signal, true);
    return parseTokenResponse(cfg, res, this.now());
  }

  private async post(cfg: OAuth2Config, url: string, params: Record<string, string>, signal: AbortSignal | undefined, clientAuth: boolean): Promise<HttpResponse> {
    const body = new URLSearchParams(params);
    const headers: { name: string; value: string }[] = [
      { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
      { name: 'Accept', value: 'application/json' },
    ];
    if (clientAuth && cfg.clientCredentials === 'basic' && cfg.clientSecret !== undefined) {
      // RFC 6749 2.3.1: form-urlencode id and secret before Base64.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(`${enc(cfg.clientId ?? '')}:${enc(cfg.clientSecret)}`).toString('base64')}` });
    } else if (clientAuth && cfg.clientCredentials === 'in body' && cfg.clientSecret !== undefined) {
      body.set('client_id', cfg.clientId ?? '');
      body.set('client_secret', cfg.clientSecret);
    } else {
      body.set('client_id', cfg.clientId ?? ''); // public client ("none", or no secret)
    }
    for (const p of cfg.params) if (p.use !== 'In Auth Request') body.append(p.name, p.value);
    for (const h of cfg.headers) {
      if (h.use === 'In Auth Request') continue;
      const i = headers.findIndex((x) => x.name.toLowerCase() === h.name.toLowerCase());
      if (i >= 0) headers.splice(i, 1);
      headers.push({ name: h.name, value: h.value });
    }
    let res: HttpResponse;
    try {
      res = await this.host.send({ method: 'POST', url, headers, body: body.toString() }, signal);
    } catch (e) {
      throw new OAuth2Error(`Auth "${cfg.id}": ${url} could not be reached: ${(e as Error).message}`);
    }
    return res;
  }

  private authParams(cfg: OAuth2Config, responseType: 'code' | 'token', redirectUri: string, state: string): URLSearchParams {
    const q = new URLSearchParams({ response_type: responseType, client_id: cfg.clientId ?? '', redirect_uri: redirectUri, state });
    if (cfg.scope) q.set('scope', cfg.scope);
    for (const p of cfg.params) if (p.use !== 'In Token Request') q.append(p.name, p.value);
    return q;
  }

  private async authorizationCode(cfg: OAuth2Config, signal?: AbortSignal): Promise<OAuth2Token> {
    const state = b64url(randomBytes(16));
    let verifier: string | undefined;
    const loop = await startLoopback(cfg, signal);
    try {
      const q = this.authParams(cfg, 'code', loop.redirectUri, state);
      if (cfg.pkce) {
        verifier = cfg.pkce.verifier ?? b64url(randomBytes(32));
        q.set('code_challenge', cfg.pkce.method === 'plain' ? verifier : b64url(createHash('sha256').update(verifier).digest()));
        q.set('code_challenge_method', cfg.pkce.method);
      }
      const url = withQuery(cfg.authUrl!, q);
      this.host.log?.(`Auth "${cfg.id}": waiting for the browser to return to ${loop.redirectUri}`);
      await this.openBrowser(cfg, url);
      const back = await loop.result;
      if (back.get('state') !== state) throw new OAuth2Error(`Auth "${cfg.id}": the redirect's state does not match (possible CSRF); try again`);
      oauthError(cfg, back);
      const code = back.get('code');
      if (!code) throw new OAuth2Error(`Auth "${cfg.id}": the redirect to ${loop.redirectUri} had no "code"`);
      return await this.tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: loop.redirectUri, ...(verifier ? { code_verifier: verifier } : {}) }, signal);
    } finally {
      loop.close();
    }
  }

  private async implicit(cfg: OAuth2Config, signal?: AbortSignal): Promise<OAuth2Token> {
    const state = b64url(randomBytes(16));
    const loop = await startLoopback(cfg, signal);
    try {
      const url = withQuery(cfg.authUrl!, this.authParams(cfg, 'token', loop.redirectUri, state));
      await this.openBrowser(cfg, url);
      const back = await loop.result;
      if (back.get('state') !== state) throw new OAuth2Error(`Auth "${cfg.id}": the redirect's state does not match; try again`);
      oauthError(cfg, back);
      const accessToken = back.get('access_token');
      if (!accessToken) throw new OAuth2Error(`Auth "${cfg.id}": the redirect had no access_token`);
      const exp = Number(back.get('expires_in'));
      const now = this.now();
      return { accessToken, idToken: back.get('id_token') ?? undefined, tokenType: back.get('token_type') ?? undefined, scope: back.get('scope') ?? undefined, expiresAt: exp > 0 ? now + exp * 1000 : undefined, obtainedAt: now };
    } finally {
      loop.close();
    }
  }

  private async device(cfg: OAuth2Config, signal?: AbortSignal): Promise<OAuth2Token> {
    const res = await this.post(cfg, cfg.deviceAuthUrl!, cfg.scope ? { scope: cfg.scope } : {}, signal, true);
    const d = parseBody(res);
    if (res.status >= 400 || d['error']) throw new OAuth2Error(`Auth "${cfg.id}": device authorization failed: ${describeError(d, res)}`);
    const deviceCode = String(d['device_code'] ?? '');
    const userCode = String(d['user_code'] ?? '');
    const verificationUri = String(d['verification_uri'] ?? d['verification_url'] ?? '');
    const complete = d['verification_uri_complete'] ? String(d['verification_uri_complete']) : undefined;
    if (!deviceCode || !verificationUri) throw new OAuth2Error(`Auth "${cfg.id}": the device authorization response has no device_code or verification_uri`);
    let interval = Math.max(1, Number(d['interval']) || 5) * 1000;
    const expiresIn = Number(d['expires_in']) > 0 ? Number(d['expires_in']) * 1000 : SIGN_IN_TIMEOUT_MS;
    this.host.showDeviceCode?.({ id: cfg.id, userCode, verificationUri, verificationUriComplete: complete });
    await this.openBrowser(cfg, cfg.openCompleteUri && complete ? complete : verificationUri);
    const deadline = this.now() + expiresIn;
    const sleep = this.host.sleep ?? defaultSleep;
    for (;;) {
      await sleep(interval, signal);
      if (signal?.aborted) throw new OAuth2Error('Cancelled');
      const r = await this.post(cfg, cfg.tokenUrl!, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, signal, true);
      const b = parseBody(r);
      const err = typeof b['error'] === 'string' ? b['error'] : undefined;
      if (err === 'authorization_pending') {
        if (this.now() > deadline) throw new OAuth2Error(`Auth "${cfg.id}": the device code expired before it was approved`);
        continue;
      }
      if (err === 'slow_down') {
        interval += 5000;
        continue;
      }
      return parseTokenResponse(cfg, r, this.now());
    }
  }

  private async openBrowser(cfg: OAuth2Config, url: string): Promise<void> {
    if (!this.host.openBrowser) throw new OAuth2Error(`Auth "${cfg.id}": ${cfg.grantType} needs a browser, which is not available here`);
    await this.host.openBrowser(url);
  }
}

function mockToken(cfg: OAuth2Config, now: number): OAuth2Token {
  return { accessToken: cfg.mockToken ?? '', idToken: cfg.mockIdToken, obtainedAt: now };
}

/** The value `{{$auth.token(id)}}` / `{{$auth.idToken(id)}}` stands for. */
export function tokenValue(cfg: OAuth2Config, t: OAuth2Token, kind: 'token' | 'idToken'): string {
  if (kind === 'idToken' || cfg.useIdToken) {
    if (!t.idToken) throw new OAuth2Error(`Auth "${cfg.id}": the token response has no id_token (add "openid" to "Scope"?)`);
    return t.idToken;
  }
  return t.accessToken;
}

function parseBody(res: HttpResponse): Record<string, unknown> {
  const text = res.bodyEncoding === 'utf8' ? res.body : Buffer.from(res.body, 'base64').toString('utf8');
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object') return j as Record<string, unknown>;
  } catch {
    // GitHub answers application/x-www-form-urlencoded unless asked for JSON; accept both.
  }
  return Object.fromEntries(new URLSearchParams(text.trim()));
}

function describeError(d: Record<string, unknown>, res: HttpResponse): string {
  const e = d['error'] ? String(d['error']) : `HTTP ${res.status} ${res.statusText}`.trim();
  const desc = d['error_description'] ? `: ${String(d['error_description'])}` : '';
  const status = d['error'] ? ` (HTTP ${res.status})` : '';
  return `${e}${desc}${status}`;
}

function parseTokenResponse(cfg: OAuth2Config, res: HttpResponse, now: number): OAuth2Token {
  const d = parseBody(res);
  if (res.status >= 400 || d['error']) throw new OAuth2Error(`Auth "${cfg.id}": token request failed: ${describeError(d, res)}`);
  const accessToken = d['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) throw new OAuth2Error(`Auth "${cfg.id}": the token response (HTTP ${res.status}) has no access_token`);
  const exp = Number(d['expires_in']);
  return {
    accessToken,
    idToken: typeof d['id_token'] === 'string' ? d['id_token'] : undefined,
    refreshToken: typeof d['refresh_token'] === 'string' ? d['refresh_token'] : undefined,
    tokenType: typeof d['token_type'] === 'string' ? d['token_type'] : undefined,
    scope: typeof d['scope'] === 'string' ? d['scope'] : undefined,
    expiresAt: exp > 0 ? now + exp * 1000 : undefined,
    obtainedAt: now,
  };
}

function oauthError(cfg: OAuth2Config, q: URLSearchParams): void {
  const e = q.get('error');
  if (e) throw new OAuth2Error(`Auth "${cfg.id}": sign-in failed: ${e}${q.get('error_description') ? `: ${q.get('error_description')}` : ''}`);
}

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function withQuery(url: string, q: URLSearchParams): string {
  return url + (url.includes('?') ? '&' : '?') + q.toString();
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const DONE_PAGE = (ok: boolean, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Plainwire</title><body style="font:16px system-ui;margin:3em;color:#222"><h1 style="font-size:1.3em">${ok ? 'Signed in.' : 'Sign-in failed.'}</h1><p>${msg}</p></body>`;

/**
 * Listen on the redirect URL (it must be http on localhost / 127.0.0.1 / [::1]; RFC 8252 loopback
 * redirect). Without a "Redirect URL", a free port on 127.0.0.1 is used: `http://127.0.0.1:<port>/callback`.
 * Resolves with the redirect's query, or, for the Implicit grant, its fragment (posted back by the page).
 */
async function startLoopback(cfg: OAuth2Config, signal?: AbortSignal): Promise<{ redirectUri: string; result: Promise<URLSearchParams>; close(): void }> {
  let target: URL;
  try {
    target = new URL(cfg.redirectUrl ?? 'http://127.0.0.1:0/callback');
  } catch {
    throw new OAuth2Error(`Auth "${cfg.id}": "Redirect URL" ${cfg.redirectUrl} is not a URL`);
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new OAuth2Error(`Auth "${cfg.id}": "Redirect URL" must be an http://localhost:<port>/… or http://127.0.0.1:<port>/… address so Plainwire can receive the sign-in (got ${cfg.redirectUrl}). Register such a URL with the provider, or leave "Redirect URL" out to use a free port on 127.0.0.1.`);
  }
  const path = target.pathname || '/';
  let resolve!: (q: URLSearchParams) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<URLSearchParams>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  result.catch(() => {});
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/__plainwire_fragment') {
      // Implicit grant: the page below posts location.hash here.
      const q = new URLSearchParams(u.search.slice(1));
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      resolve(q);
      return;
    }
    if (u.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (cfg.grantType === 'Implicit' && !u.search) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>Plainwire</title><body style="font:16px system-ui;margin:3em"><p id=m>Finishing sign-in…</p><script>fetch('/__plainwire_fragment?'+location.hash.slice(1)).then(function(){document.getElementById('m').textContent='Signed in. You can close this tab and return to your editor.'})</script></body>`,
      );
      return;
    }
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(!err, err ? `The provider answered: ${escapeHtml(err)}. Return to your editor for details.` : 'You can close this tab and return to your editor.'));
    resolve(u.searchParams);
  });
  await new Promise<void>((res, rej) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      rej(new OAuth2Error(e.code === 'EADDRINUSE' ? `Auth "${cfg.id}": port ${target.port} of the Redirect URL is in use by another program` : `Auth "${cfg.id}": cannot listen on ${target.host}: ${e.message}`)),
    );
    server.listen(Number(target.port || 80), host === 'localhost' ? '127.0.0.1' : host, () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = cfg.redirectUrl ?? `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => reject(new OAuth2Error(`Auth "${cfg.id}": no sign-in came back to ${redirectUri} within 5 minutes`)), SIGN_IN_TIMEOUT_MS);
  const onAbort = () => reject(new OAuth2Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    redirectUri,
    result,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections?.();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
