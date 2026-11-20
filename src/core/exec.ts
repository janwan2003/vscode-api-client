import { runAssertions, type AssertionResult } from './assert.ts';
import { isGraphqlRequest, toGraphqlHttp } from './graphql.ts';
import { parseHttpFile } from './httpFile.ts';
import type { FileVariable, HttpFile, HttpRequest, HttpResponse, ParsedRequest } from './model.ts';
import { bodyFileRef, normalizeBasicAuth, toWireForm } from './preview.ts';
import { ensureScheme, sendRequest, type SendOptions } from './send.ts';

export { bodyFileRef, normalizeBasicAuth } from './preview.ts';
import { referencedRequestNames, resolveRequest, resolveText, type NamedExchange, type VariableContext } from './variables.ts';

/**
 * Everything the executor needs from its surroundings. The VS Code extension implements it with
 * workspace APIs; the CLI with node:fs. `file` is an opaque key (a URI string or a path).
 */
export interface ExecHost {
  /** Text of the .http file a request came from. */
  readHttpFile(file: string): Promise<string>;
  /**
   * The key (same kind as `file`) of a `# @import ./path` written in `file`, relative to that file.
   * Without it, imports are an error.
   */
  resolveImport?(path: string, file: string): string;
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

  /** Resolve without sending; see `previewRequest`. Uses responses already received for `file`. */
  preview(req: HttpRequest, file: string | undefined): Promise<PreviewResult> {
    return previewRequest(req, this.host, file, this.named.get(file ?? ''));
  }

  async run(req: HttpRequest, file: string | undefined, signal?: AbortSignal, depth = 0): Promise<ExecResult> {
    const key = file ?? '';
    const named = this.named.get(key) ?? new Map<string, NamedExchange>();
    this.named.set(key, named);
    return this.runIn(req, file, named, signal, depth);
  }

  /**
   * Run `req` from `file`, remembering named responses in `named`. A chained request found in an
   * imported file runs with that file's own variables, but its response is remembered in `named`
   * (the session of the file the run started from), so `resetSession` forgets it too.
   */
  private async runIn(req: HttpRequest, file: string | undefined, named: Map<string, NamedExchange>, signal: AbortSignal | undefined, depth: number): Promise<ExecResult> {
    if (depth > 5) throw new Error('Chained requests are nested too deeply (or reference each other in a loop)');
    const loaded = await loadHttpFile(this.host, file);

    // Send named requests this one depends on, if they have not been sent yet.
    const text = [req.url, ...req.headers.map((h) => h.value), req.body ?? '', ...(req.asserts ?? [])].join('\n');
    for (const name of referencedRequestNames(text)) {
      if (named.has(name) || name === req.name) continue;
      const dep = loaded.findRequest(name);
      if (!dep) continue;
      await this.runIn(dep.request, dep.file, named, signal, depth + 1);
    }

    const ctx: VariableContext = {
      fileVariables: loaded.variables,
      environment: this.host.environment(),
      named,
      processEnv: process.env,
      dotenv: await this.host.dotenv(file),
    };
    let resolved = resolveRequest(req, ctx);
    normalizeBasicAuth(resolved);

    let bodyOverride: Uint8Array | undefined;
    const ref = bodyFileRef(resolved.body);
    if (ref) {
      const bytes = await this.host.readBodyFile(ref.path, file);
      if (ref.resolveVariables) resolved.body = resolveText(new TextDecoder().decode(bytes), ctx);
      else bodyOverride = bytes;
    }
    // X-REQUEST-TYPE: GraphQL → JSON {query, variables}; after {{var}} substitution, so both can use variables.
    if (isGraphqlRequest(resolved)) {
      if (bodyOverride) {
        resolved.body = new TextDecoder().decode(bodyOverride);
        bodyOverride = undefined;
      }
      resolved = toGraphqlHttp(resolved);
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

export interface PreviewResult {
  /** The request as it would go on the wire: variables resolved, Basic auth encoded, body normalised. */
  request: HttpRequest;
  /** Variables left as `{{name}}` because they are unknown, or chained to a request not sent yet. */
  unresolved: string[];
}

/**
 * Resolve a request the way `run` would, without sending anything (for "Copy as cURL / Code").
 * Chained values come only from responses already received in this session; nothing else is sent.
 * A `< ./file` body stays a file reference; a `<@ ./file` body is read and resolved.
 */
export async function previewRequest(req: HttpRequest, host: Pick<ExecHost, 'readHttpFile' | 'resolveImport' | 'readBodyFile' | 'dotenv' | 'environment'>, file: string | undefined, named: Map<string, NamedExchange> = new Map()): Promise<PreviewResult> {
  const loaded = await loadHttpFile(host, file);
  const unresolved = new Set<string>();
  const ctx: VariableContext = {
    fileVariables: loaded.variables,
    environment: host.environment(),
    named,
    processEnv: process.env,
    dotenv: await host.dotenv(file),
    unresolved,
  };
  let resolved = resolveRequest(req, ctx);
  normalizeBasicAuth(resolved);
  resolved.url = ensureScheme(resolved.url.trim());
  const ref = bodyFileRef(resolved.body);
  if (ref?.resolveVariables) {
    try {
      resolved.body = resolveText(new TextDecoder().decode(await host.readBodyFile(ref.path, file)), ctx);
    } catch {
      resolved.body = `< ${ref.path}`; // unreadable here: let the snippet read the file itself
    }
  }
  return { request: toWireForm(resolved), unresolved: [...unresolved] };
}

/** A parsed `.http` file together with everything it imports. */
export interface LoadedHttpFile {
  parsed: HttpFile;
  /** Variables of the imported files first (nested imports before the file importing them), then the file's own: the last definition wins. */
  variables: FileVariable[];
  /** Imported files in the order their variables apply (the file itself excluded). */
  imported: { file: string; parsed: HttpFile }[];
  /** A `# @name` request: the file's own first, then the imported files, latest import first. */
  findRequest(name: string): { request: ParsedRequest; file: string | undefined } | undefined;
}

/** Most files one request may pull in through nested imports. */
const MAX_IMPORTED_FILES = 50;

/**
 * Parse `file` and, recursively, the files it imports with `# @import ./other.http` (httpYac) or
 * `import ./other.http` (JetBrains). A file imported twice, or an import cycle, is read once.
 * A missing or unreadable import throws an error naming the line's path and the importing file.
 */
export async function loadHttpFile(host: Pick<ExecHost, 'readHttpFile' | 'resolveImport'>, file: string | undefined): Promise<LoadedHttpFile> {
  const parsed: HttpFile = file !== undefined ? parseHttpFile(await host.readHttpFile(file)) : { variables: [], requests: [] };
  const imported: { file: string; parsed: HttpFile }[] = [];
  const seen = new Set<string>(file !== undefined ? [file] : []);
  const visit = async (from: string, p: HttpFile): Promise<void> => {
    for (const path of p.imports ?? []) {
      if (!host.resolveImport) throw new Error(`Cannot import ${path}: imports are not supported here`);
      const key = host.resolveImport(path, from);
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > MAX_IMPORTED_FILES) throw new Error(`Cannot import ${path}: more than ${MAX_IMPORTED_FILES} imported files`);
      let text: string;
      try {
        text = await host.readHttpFile(key);
      } catch (e) {
        throw new Error(`Cannot import ${path} from ${baseName(from)}: ${key} could not be read (${(e as Error).message})`);
      }
      const child = parseHttpFile(text);
      await visit(key, child); // nested imports first: the importing file's own values override them
      imported.push({ file: key, parsed: child });
    }
  };
  if (file !== undefined) await visit(file, parsed);
  return {
    parsed,
    imported,
    variables: [...imported.flatMap((f) => f.parsed.variables), ...parsed.variables],
    findRequest(name) {
      const own = parsed.requests.find((r) => r.name === name);
      if (own) return { request: own, file };
      for (let i = imported.length - 1; i >= 0; i--) {
        const r = imported[i].parsed.requests.find((x) => x.name === name);
        if (r) return { request: r, file: imported[i].file };
      }
      return undefined;
    },
  };
}

function baseName(file: string): string {
  return decodeURIComponent(file.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? file);
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
