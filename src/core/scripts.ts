import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import type { AssertionResult } from './assert.ts';
import type { HttpRequest, HttpResponse } from './model.ts';
import { jsonPath } from './variables.ts';
import { PM_PRELUDE, usesPostmanApi } from './pmShim.ts';

/**
 * JavaScript in `.http` files, in the JetBrains HTTP Client format:
 *
 *   < {%
 *     request.variables.set('ts', Date.now().toString());
 *   %}
 *   POST https://api.example.com/login
 *
 *   > {%
 *     client.test('logged in', () => client.assert(response.status === 200, 'status ' + response.status));
 *     client.global.set('token', response.body.token);
 *   %}
 *
 * `< {% %}` (above the request line) runs before the request is resolved; `> {% %}` (after the body)
 * runs on the response. `< ./script.js` / `> ./handler.js` load the code from a file next to the
 * `.http` file. `client.global` values are used as `{{name}}` in later requests.
 *
 * Scripts run synchronously in a separate `node:vm` context with a time limit. That context is a
 * convenience, not a security boundary: scripts come from the user's own files, and the extension
 * runs only in trusted workspaces (VS Code Restricted Mode disables it).
 */

export type ScriptSide = 'pre' | 'response';

/** One script found in a request's raw lines: inline code, or a path to a `.js` file. */
export interface ScriptSource {
  code?: string;
  path?: string;
}

/** Inline handler on one line: `> {% client.global.set('a', 1) %}`. */
const INLINE = /^\s*([<>])\s+\{%(.*)%\}\s*$/;
const START = /^\s*([<>])\s+\{%\s*(.*)$/;
const END = /^(.*?)%\}\s*$/;
/** A script file: `> ./handler.js`, `< scripts/sign.js` (one token, no braces). */
const FILE = /^\s*([<>])\s+([^\s{}%]+)\s*$/;

/**
 * The scripts of one side in `rawBefore` (side 'pre', `<` lines) or `rawAfter` (side 'response',
 * `>` lines), in file order. httpYac `{{ }}` blocks and `/* *\/` comments are skipped.
 */
export function scriptSources(lines: string[] | undefined, side: ScriptSide): ScriptSource[] {
  const want = side === 'pre' ? '<' : '>';
  const out: ScriptSource[] = [];
  if (!lines) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\{\{/.test(line)) {
      while (i < lines.length && !/^\s*\}\}\s*$/.test(lines[i])) i++;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      while (i < lines.length && !/\*\/\s*$/.test(lines[i])) i++;
      continue;
    }
    const inline = INLINE.exec(line);
    if (inline) {
      if (inline[1] === want) out.push({ code: inline[2] });
      continue;
    }
    const start = START.exec(line);
    if (start) {
      const body: string[] = start[2].trim() ? [start[2]] : [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const e = END.exec(lines[j]);
        if (e) {
          if (e[1].trim()) body.push(e[1]);
          break;
        }
        body.push(lines[j]);
      }
      if (start[1] === want) out.push({ code: body.join('\n') });
      i = j;
      continue;
    }
    const file = FILE.exec(line);
    if (file && file[1] === want) out.push({ path: file[2] });
  }
  return out;
}

/** Inline code of the first `{% %}` block of a side ('' when none), for the request editor. */
export function inlineScript(lines: string[] | undefined, side: ScriptSide): string {
  return scriptSources(lines, side).find((s) => s.code !== undefined)?.code ?? '';
}

/** Everything a script may read and change outside itself. */
export interface ScriptContext {
  /** `client.global`: survives between requests (and runs, if the host keeps it). Values are strings. */
  globals: Map<string, string>;
  /** `request.variables`: this request only; used for its `{{name}}` before anything else. */
  requestVariables: Map<string, string>;
  /** The active environment, for `request.environment.get(name)`. */
  environment: Record<string, string>;
  /** Resolve `{{variables}}` in text, for `tryGetSubstituted()`. Throws on unknown variables. */
  resolve: (text: string) => string;
  /** Milliseconds a script may run (default 5000). */
  timeoutMs?: number;
}

export interface ScriptOutcome {
  /** `client.test(...)` results, and a failed result for an uncaught error or a failed top-level `client.assert`. */
  tests: AssertionResult[];
  /** `client.log(...)` / `console.log(...)` lines. */
  logs: string[];
  /** The script threw (or timed out); for a pre-request script this stops the request. */
  error?: string;
}

class ExitSignal {}
class ScriptAssertionError extends Error {}

/** Value stored by `client.global.set` / `request.variables.set`: strings as they are, everything else as JSON. */
function asVariable(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function message(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function header(headers: [string, string][], name: string): string[] {
  return headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

/** JetBrains' `crypto` helper: `crypto.sha256().updateWithText(s).digest().toHex()`, `crypto.hmac.sha256().withTextSecret(k)…`. */
function cryptoApi() {
  const digestOf = (bytes: Buffer) => ({
    toHex: () => bytes.toString('hex'),
    toBase64: (urlSafe?: boolean) => (urlSafe ? bytes.toString('base64url') : bytes.toString('base64')),
    toUrlSafeBase64: () => bytes.toString('base64url'),
  });
  const hasher = (update: (b: Buffer) => void, digest: () => Buffer) => {
    const self = {
      updateWithText: (s: string, encoding?: string) => (update(Buffer.from(String(s), (encoding as BufferEncoding) ?? 'utf8')), self),
      updateWithHex: (s: string) => (update(Buffer.from(String(s), 'hex')), self),
      updateWithBase64: (s: string, urlSafe?: boolean) => (update(Buffer.from(String(s), urlSafe ? 'base64url' : 'base64')), self),
      digest: () => digestOf(digest()),
    };
    return self;
  };
  const algos = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' } as const;
  const api: Record<string, unknown> = {};
  const hmac: Record<string, unknown> = {};
  for (const [name, algo] of Object.entries(algos)) {
    api[name] = () => {
      const h = createHash(algo);
      return hasher((b) => h.update(b), () => h.digest());
    };
    hmac[name] = () => {
      const withSecret = (key: Buffer) => {
        const h = createHmac(algo, key);
        return hasher((b) => h.update(b), () => h.digest());
      };
      return {
        withTextSecret: (s: string) => withSecret(Buffer.from(String(s), 'utf8')),
        withHexSecret: (s: string) => withSecret(Buffer.from(String(s), 'hex')),
        withBase64Secret: (s: string, urlSafe?: boolean) => withSecret(Buffer.from(String(s), urlSafe ? 'base64url' : 'base64')),
      };
    };
  }
  api.hmac = hmac;
  return api;
}

/** JetBrains' `$random` helper (the script-side twin of `{{$random.*}}`). */
function randomApi() {
  const pick = (chars: string, n: number) => Array.from({ length: Math.max(0, Number(n) || 0) }, () => chars[randomInt(chars.length)]).join('');
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return {
    get uuid() {
      return randomUUID();
    },
    integer: (from = 0, to = 1000) => randomInt(Math.ceil(from), Math.floor(to)),
    float: (from = 0, to = 1000) => from + Math.random() * (to - from),
    alphabetic: (n = 10) => pick(letters, n),
    alphanumeric: (n = 10) => pick(letters + '0123456789_', n),
    hexadecimal: (n = 10) => pick('0123456789abcdef', n),
    get email() {
      return `${pick(letters.slice(0, 26), 8)}@example.com`;
    },
  };
}

function requestApi(req: HttpRequest, ctx: ScriptContext) {
  const subst = (text: string) => {
    try {
      return ctx.resolve(text);
    } catch {
      return text;
    }
  };
  const headerApi = (h: { name: string; value: string }) => ({
    name: h.name,
    getRawValue: () => h.value,
    tryGetSubstitutedValue: () => subst(h.value),
  });
  const enabled = req.headers.filter((h) => !h.disabled);
  return {
    method: req.method,
    url: { getRaw: () => req.url, tryGetSubstituted: () => subst(req.url) },
    headers: {
      all: () => enabled.map(headerApi),
      findByName: (name: string) => {
        const h = enabled.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
        return h ? headerApi(h) : null;
      },
    },
    body: { getRaw: () => req.body ?? '', tryGetSubstituted: () => subst(req.body ?? '') },
    environment: { get: (name: string) => ctx.environment[name] ?? null },
    variables: {
      set: (name: string, value: unknown) => void ctx.requestVariables.set(String(name), asVariable(value)),
      get: (name: string) => ctx.requestVariables.get(String(name)) ?? null,
    },
    iteration: () => 0,
  };
}

/**
 * Run one script. Never throws: errors come back in `error` and as a failed test (a response
 * handler) so that "Run all" and the CLI report them like failed checks.
 */
export function runScript(code: string, side: ScriptSide, req: HttpRequest, ctx: ScriptContext, res?: HttpResponse, label = side === 'pre' ? 'pre-request script' : 'response handler'): ScriptOutcome {
  const tests: AssertionResult[] = [];
  const logs: string[] = [];
  const log = (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '));
  const sandbox: Record<string, unknown> = {
    client: {
      global: {
        set: (name: string, value: unknown) => void ctx.globals.set(String(name), asVariable(value)),
        get: (name: string) => ctx.globals.get(String(name)) ?? null,
        isEmpty: () => ctx.globals.size === 0,
        clear: (name: string) => void ctx.globals.delete(String(name)),
        clearAll: () => ctx.globals.clear(),
      },
      test: (name: string, fn: () => void) => {
        try {
          fn();
          tests.push({ source: String(name), passed: true, message: 'passed' });
        } catch (e) {
          if (e instanceof ExitSignal) throw e;
          tests.push({ source: String(name), passed: false, message: message(e) });
        }
      },
      assert: (condition: unknown, msg?: string) => {
        if (!condition) throw new ScriptAssertionError(msg ? String(msg) : 'Assertion failed');
      },
      log,
      exit: () => {
        throw new ExitSignal();
      },
    },
    request: requestApi(req, ctx),
    console: { log, info: log, warn: log, error: log, debug: log },
    jsonPath: (data: unknown, path: string) => jsonPath(typeof data === 'string' ? safeParse(data) : data, String(path)) ?? null,
    crypto: cryptoApi(),
    $random: randomApi(),
    btoa: (s: string) => Buffer.from(String(s), 'latin1').toString('base64'),
    atob: (s: string) => Buffer.from(String(s), 'base64').toString('latin1'),
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });
  if (res) {
    sandbox.__res = { text: res.bodyEncoding === 'utf8' ? res.body : '', json: isJson(res) };
    // Parse inside the context so that arrays and objects are the script's own (instanceof Array works).
    vm.runInContext('globalThis.__body = __res.json ? JSON.parse(__res.text) : __res.text; delete globalThis.__res;', context);
    const contentType = header(res.headers, 'content-type')[0] ?? '';
    const stream = res.events ? streamBody(res) : undefined;
    sandbox.response = {
      status: res.status,
      body: stream ?? sandbox.__body,
      headers: {
        valueOf: (name: string) => header(res.headers, String(name))[0] ?? null,
        valuesOf: (name: string) => header(res.headers, String(name)),
      },
      contentType: {
        mimeType: contentType.split(';')[0].trim(),
        charset: /charset=([^;\s]+)/i.exec(contentType)?.[1] ?? 'utf-8',
      },
    };
    delete sandbox.__body;
  }
  let error: string | undefined;
  const pm = usesPostmanApi(code);
  try {
    if (pm) {
      const headers: Record<string, string> = {};
      for (const [k, v] of res?.headers ?? []) headers[k] = v;
      sandbox.__pm = res ? { status: res.status, statusText: res.statusText, timeMs: res.timeMs, text: res.bodyEncoding === 'utf8' ? res.body : '', headers, name: req.title ?? req.name } : { name: req.title ?? req.name };
      vm.runInContext(PM_PRELUDE, context, { filename: 'postman-api', timeout: ctx.timeoutMs ?? 5000 });
    }
    vm.runInContext(code, context, { filename: label, timeout: ctx.timeoutMs ?? 5000 });
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      const timedOut = /Script execution timed out/.test(message(e));
      error = timedOut ? `timed out after ${ctx.timeoutMs ?? 5000} ms` : message(e);
      const top = e instanceof ScriptAssertionError ? 'client.assert' : label;
      tests.push({ source: top, passed: false, message: error });
    }
  }
  // Legacy Postman tests: `tests["name"] = condition`.
  if (pm && sandbox.tests && typeof sandbox.tests === 'object') {
    for (const [name, ok] of Object.entries(sandbox.tests as Record<string, unknown>)) {
      tests.push({ source: name, passed: !!ok, message: ok ? 'passed' : 'tests["' + name + '"] is false' });
    }
  }
  return { tests, logs, error };
}

/**
 * `response.body` of a stream (server-sent events or WebSocket), JetBrains-style: the messages are
 * replayed after the fact through `onEachMessage((msg, unsubscribe) => …)` / `onEachLine`.
 */
function streamBody(res: HttpResponse) {
  const ws = res.status === 101;
  const messages = (res.events ?? []).filter((e) => !ws || e.event !== 'sent');
  const replay = (items: unknown[], cb: (item: unknown, unsubscribe: () => void, output: () => void) => void) => {
    let stop = false;
    for (const item of items) {
      cb(item, () => (stop = true), () => undefined);
      if (stop) break;
    }
  };
  return {
    onEachMessage: (cb: (m: unknown, u: () => void, o: () => void) => void) => replay(messages.map((e) => safeParse(e.data) ?? e.data), cb),
    onEachLine: (cb: (l: unknown, u: () => void, o: () => void) => void) => replay((res.body || '').split(/\r?\n/), cb),
    toString: () => res.body,
  };
}

function isJson(res: HttpResponse): boolean {
  if (res.bodyEncoding !== 'utf8' || res.events) return false;
  const ct = header(res.headers, 'content-type')[0] ?? '';
  const t = res.body.trimStart();
  if (!/json/i.test(ct) && !(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(res.body);
    return true;
  } catch {
    return false;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
