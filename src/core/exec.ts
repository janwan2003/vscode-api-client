import { runAssertions, type AssertionResult } from './assert.ts';
import { parseHttpFile } from './httpFile.ts';
import type { HttpFile, HttpRequest, HttpResponse } from './model.ts';
import { sendRequest, type SendOptions } from './send.ts';
import { referencedRequestNames, resolveRequest, resolveText, type NamedExchange, type VariableContext } from './variables.ts';

/**
 * Everything the executor needs from its surroundings. The VS Code extension implements it with
 * workspace APIs; the CLI with node:fs. `file` is an opaque key (a URI string or a path).
 */
export interface ExecHost {
  /** Text of the .http file a request came from. */
  readHttpFile(file: string): Promise<string>;
  /** Bytes of a `< ./path` body file, relative to the .http file. */
  readBodyFile(path: string, file: string | undefined): Promise<Uint8Array>;
  /** Variables from the nearest `.env` file, for `{{$dotenv NAME}}`. */
  dotenv(file: string | undefined): Promise<Record<string, string>>;
  /** The active environment, already merged with `$shared`. */
  environment(): Record<string, string>;
  /** Timeout, TLS, proxy and redirect settings for this request (`req.meta` holds its `# @flags`). */
  sendOptions(req: HttpRequest): SendOptions;
  /** Called after every exchange, including chained dependencies (history, logging). */
  onExchange?(e: { request: HttpRequest; file?: string; response?: HttpResponse; error?: string }): void | Promise<void>;
}

export interface ExecResult {
  resolved: HttpRequest;
  response: HttpResponse;
  /** Results of the request's `# @assert` lines (empty when it has none). */
  assertions: AssertionResult[];
}

/**
 * Sends requests: resolves variables, sends chained (`{{login.response...}}`) requests first,
 * reads body files and evaluates `# @assert` lines. Remembers named responses per file.
 */
export class Executor {
  private readonly named = new Map<string, Map<string, NamedExchange>>();

  constructor(private readonly host: ExecHost) {}

  /** Forget named responses for a file, so the next run sends chained requests again. */
  resetSession(file: string): void {
    this.named.delete(file);
  }

  async run(req: HttpRequest, file: string | undefined, signal?: AbortSignal, depth = 0): Promise<ExecResult> {
    if (depth > 5) throw new Error('Chained requests are nested too deeply (or reference each other in a loop)');
    const parsed: HttpFile = file !== undefined ? parseHttpFile(await this.host.readHttpFile(file)) : { variables: [], requests: [] };
    const key = file ?? '';
    const named = this.named.get(key) ?? new Map<string, NamedExchange>();
    this.named.set(key, named);

    // Send named requests this one depends on, if they have not been sent yet.
    const text = [req.url, ...req.headers.map((h) => h.value), req.body ?? '', ...(req.asserts ?? [])].join('\n');
    for (const name of referencedRequestNames(text)) {
      if (named.has(name) || name === req.name) continue;
      const dep = parsed.requests.find((r) => r.name === name);
      if (!dep) continue;
      await this.run(dep, file, signal, depth + 1);
    }

    const ctx: VariableContext = {
      fileVariables: parsed.variables,
      environment: this.host.environment(),
      named,
      processEnv: process.env,
      dotenv: await this.host.dotenv(file),
    };
    const resolved = resolveRequest(req, ctx);
    normalizeBasicAuth(resolved);

    let bodyOverride: Uint8Array | undefined;
    const ref = bodyFileRef(resolved.body);
    if (ref) {
      const bytes = await this.host.readBodyFile(ref.path, file);
      if (ref.resolveVariables) resolved.body = resolveText(new TextDecoder().decode(bytes), ctx);
      else bodyOverride = bytes;
    }

    try {
      const response = await sendRequest(resolved, { ...this.host.sendOptions(req), signal, bodyOverride });
      if (req.name) {
        named.set(req.name, {
          request: { url: resolved.url, headers: resolved.headers.map((h) => [h.name, h.value]), body: resolved.body },
          response,
        });
      }
      await this.host.onExchange?.({ request: req, file, response });
      const assertions = req.asserts?.length ? runAssertions(req.asserts, response, (t) => resolveText(t, ctx)) : [];
      return { resolved, response, assertions };
    } catch (e) {
      await this.host.onExchange?.({ request: req, file, error: (e as Error).message });
      throw e;
    }
  }
}

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
    if (v.includes(':')) h.value = `Basic ${Buffer.from(v).toString('base64')}`;
    else if (/\s/.test(v)) {
      const [u, ...p] = v.split(/\s+/);
      h.value = `Basic ${Buffer.from(`${u}:${p.join(' ')}`).toString('base64')}`;
    }
  }
}

/** One request in a run report (the Run all tab and the CLI share it). */
export interface RunRow {
  file: string;
  index: number;
  method: string;
  label: string;
  state: 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'skipped';
  status?: number;
  timeMs?: number;
  error?: string;
  assertions: AssertionResult[];
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  timeMs: number;
}

/**
 * A request passes when it got a response and all its `# @assert` checks pass. A request with no
 * checks passes on any status below 400 (add `# @assert status == 404` to expect an error status).
 */
export function rowState(status: number, assertions: AssertionResult[]): 'pass' | 'fail' {
  if (assertions.length) return assertions.every((a) => a.passed) ? 'pass' : 'fail';
  return status < 400 ? 'pass' : 'fail';
}

export function summarize(rows: Pick<RunRow, 'state'>[], timeMs: number): RunSummary {
  const n = (s: RunRow['state']) => rows.filter((r) => r.state === s).length;
  return { total: rows.length, passed: n('pass'), failed: n('fail'), errors: n('error'), skipped: n('skipped'), timeMs };
}

/** Title shown for a request: `### title`, else `@name`, else the URL path without host. */
export function requestLabel(r: HttpRequest): string {
  return r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || r.url;
}

/** Markdown report for a PR, an issue or a GitHub job summary. */
export function markdownReport(title: string, rows: RunRow[], s: RunSummary): string {
  const icon = { pass: '✅', fail: '❌', error: '⚠️', skipped: '⏭️', pending: '…', running: '…' } as const;
  const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `**Plainwire run: ${title}**: ${s.passed} passed, ${s.failed} failed, ${s.errors} errors, ${s.skipped} skipped (${s.timeMs} ms)`,
    '',
    '| | Request | Status | Time | Checks |',
    '|---|---|---|---|---|',
    ...rows.map((r) => {
      const checks = r.assertions.length ? `${r.assertions.filter((a) => a.passed).length}/${r.assertions.length}` : '';
      const fails = r.assertions.filter((a) => !a.passed).map((a) => `<br>✗ \`${cell(a.source)}\`: ${cell(a.message)}`).join('');
      return `| ${icon[r.state]} | ${r.method} ${cell(r.label)} (${r.file})${r.error ? `<br>${cell(r.error)}` : ''}${fails} | ${r.status ?? ''} | ${r.timeMs ?? ''} | ${checks} |`;
    }),
  ].join('\n');
}
