import { randomUUID } from 'node:crypto';
import type { FileVariable, HttpRequest, HttpResponse } from './model.ts';

/** A response remembered for `{{name.response.body.$.path}}` chaining. */
export interface NamedExchange {
  request: { url: string; headers: [string, string][]; body?: string };
  response: HttpResponse;
}

export interface VariableContext {
  fileVariables: FileVariable[];
  /** Active environment, already merged with shared values. */
  environment: Record<string, string>;
  named: Map<string, NamedExchange>;
  processEnv: Record<string, string | undefined>;
  dotenv: Record<string, string>;
  /** Clock override for tests. */
  now?: () => Date;
}

export class UnresolvedVariableError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Variable {{${variable}}} is not defined`);
    this.variable = variable;
  }
}

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Resolve every `{{...}}` in `text`. Unknown variables throw UnresolvedVariableError. */
export function resolveText(text: string, ctx: VariableContext, depth = 0): string {
  if (depth > 10) throw new Error('Variables reference each other in a loop');
  return text.replace(VAR, (_all, expr: string) => resolveOne(expr, ctx, depth));
}

function resolveOne(expr: string, ctx: VariableContext, depth: number): string {
  if (expr.startsWith('$')) return systemVariable(expr, ctx);
  // File variables win over environment (REST Client order: request > file > environment).
  const fv = [...ctx.fileVariables].reverse().find((v) => v.name === expr);
  if (fv) return resolveText(fv.value, ctx, depth + 1);
  if (Object.prototype.hasOwnProperty.call(ctx.environment, expr)) {
    return resolveText(ctx.environment[expr], ctx, depth + 1);
  }
  const chained = chainedVariable(expr, ctx);
  if (chained !== undefined) return chained;
  throw new UnresolvedVariableError(expr);
}

/** Names of requests referenced through `{{name.response...}}` / `{{name.request...}}`. */
export function referencedRequestNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(VAR)) {
    const cm = /^([\w-]+)\.(response|request)\./.exec(m[1].trim());
    if (cm) names.add(cm[1]);
  }
  return [...names];
}

function chainedVariable(expr: string, ctx: VariableContext): string | undefined {
  const m = /^([\w-]+)\.(response|request)\.(body|headers)\.(.+)$/.exec(expr);
  if (!m) return undefined;
  const ex = ctx.named.get(m[1]);
  if (!ex) return undefined;
  const [, , side, part, path] = m;
  if (part === 'headers') {
    const headers = side === 'response' ? ex.response.headers : ex.request.headers;
    const h = headers.find(([k]) => k.toLowerCase() === path.toLowerCase());
    return h ? h[1] : '';
  }
  const body = side === 'response' ? (ex.response.bodyEncoding === 'utf8' ? ex.response.body : '') : (ex.request.body ?? '');
  if (path === '*') return body;
  if (path.startsWith('$')) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return '';
    }
    const v = jsonPath(data, path);
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  return '';
}

/** Minimal JSONPath: `$`, `.key`, `['key']`, `[0]`, `[-1]`. */
export function jsonPath(data: unknown, path: string): unknown {
  const tokens: (string | number)[] = [];
  const re = /\.([^.[\]]+)|\[\s*(-?\d+)\s*\]|\[\s*['"]([^'"]*)['"]\s*\]/g;
  let m: RegExpExecArray | null;
  const rest = path.replace(/^\$/, '');
  let consumed = 0;
  while ((m = re.exec(rest))) {
    if (m.index !== consumed) return undefined;
    consumed = re.lastIndex;
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else tokens.push(m[3]);
  }
  if (consumed !== rest.length) return undefined;
  let cur: unknown = data;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof t === 'number' && Array.isArray(cur)) cur = cur[t < 0 ? cur.length + t : t];
    else cur = (cur as Record<string, unknown>)[String(t)];
  }
  return cur;
}

const UNITS: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, M: 2592e6, y: 31536e6 };

function applyOffset(date: Date, args: string[]): Date {
  if (args.length >= 2 && /^-?\d+$/.test(args[0]) && UNITS[args[1]]) {
    return new Date(date.getTime() + Number(args[0]) * UNITS[args[1]]);
  }
  return date;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function formatDate(d: Date, fmt: string, local: boolean): string {
  if (fmt === 'rfc1123') return d.toUTCString();
  if (fmt === 'iso8601') return local ? localIso(d) : d.toISOString();
  // Custom format with YYYY MM DD HH mm ss SSS tokens, quoted.
  const g = local
    ? { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), H: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), S: d.getMilliseconds() }
    : { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), H: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), S: d.getUTCMilliseconds() };
  return fmt
    .replace(/^["']|["']$/g, '')
    .replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (t) =>
      t === 'YYYY' ? String(g.Y) : t === 'MM' ? pad(g.M) : t === 'DD' ? pad(g.D) : t === 'HH' ? pad(g.H) : t === 'mm' ? pad(g.m) : t === 'ss' ? pad(g.s) : pad(g.S, 3),
    );
}

function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function systemVariable(expr: string, ctx: VariableContext): string {
  const parts = expr.match(/"[^"]*"|'[^']*'|\S+/g) ?? [expr];
  const name = parts[0];
  const args = parts.slice(1);
  const now = ctx.now ? ctx.now() : new Date();
  switch (name) {
    case '$guid':
    case '$uuid':
    case '$random.uuid':
      return randomUUID();
    case '$timestamp':
      return String(Math.floor(applyOffset(now, args).getTime() / 1000));
    case '$isoTimestamp':
      return now.toISOString();
    case '$randomInt':
    case '$random.integer': {
      const min = Number(args[0] ?? 0);
      const max = Number(args[1] ?? 1000);
      return String(Math.floor(min + Math.random() * (max - min)));
    }
    case '$datetime':
    case '$localDatetime': {
      const fmt = args[0] ?? 'iso8601';
      return formatDate(applyOffset(now, args.slice(1)), fmt, name === '$localDatetime');
    }
    case '$processEnv': {
      const key = resolveIndirect(args[0], ctx);
      const v = ctx.processEnv[key];
      if (v === undefined) throw new UnresolvedVariableError(expr);
      return v;
    }
    case '$dotenv': {
      const key = resolveIndirect(args[0], ctx);
      const v = ctx.dotenv[key];
      if (v === undefined) throw new UnresolvedVariableError(expr);
      return v;
    }
    default:
      throw new UnresolvedVariableError(expr);
  }
}

/** `{{$processEnv %envVarName}}` looks the key up in the current environment first. */
function resolveIndirect(arg: string | undefined, ctx: VariableContext): string {
  if (!arg) return '';
  if (arg.startsWith('%')) {
    const k = arg.slice(1);
    return ctx.environment[k] ?? k;
  }
  return arg;
}

/** Resolve URL, header values and body of a request. */
export function resolveRequest(req: HttpRequest, ctx: VariableContext): HttpRequest {
  return {
    ...req,
    url: resolveText(req.url, ctx),
    headers: req.headers.filter((h) => !h.disabled).map((h) => ({ name: resolveText(h.name, ctx), value: resolveText(h.value, ctx) })),
    body: req.body === undefined ? undefined : resolveText(req.body, ctx),
  };
}

/** Parse a `.env` file (KEY=value, quotes, # comments, `export ` prefix). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/**
 * Merge environments the way REST Client does: `$shared` first, then the selected one.
 * Values may reference `{{$shared varName}}`.
 */
export function mergeEnvironment(all: Record<string, Record<string, string>>, selected: string | undefined): Record<string, string> {
  const shared = all['$shared'] ?? {};
  const env = selected ? all[selected] ?? {} : {};
  const merged: Record<string, string> = { ...shared, ...env };
  for (const [k, v] of Object.entries(merged)) {
    merged[k] = String(v).replace(/\{\{\s*\$shared\s+([\w.-]+)\s*\}\}/g, (_a, n: string) => shared[n] ?? '');
  }
  return merged;
}
