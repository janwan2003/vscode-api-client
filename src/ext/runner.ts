import * as vscode from 'vscode';
import { parseHttpFile } from '../core/httpFile.ts';
import type { HttpRequest, HttpResponse } from '../core/model.ts';
import { sendRequest } from '../core/send.ts';
import { parseDotenv, referencedRequestNames, resolveRequest, resolveText, type NamedExchange, type VariableContext } from '../core/variables.ts';
import type { EnvironmentManager } from './environments.ts';
import type { History } from './history.ts';

export interface RunSource {
  /** The .http file the request belongs to (for file variables, chaining, relative body files). */
  uri?: vscode.Uri;
}

export interface RunResult {
  resolved: HttpRequest;
  response: HttpResponse;
}

/** Sends requests: resolves variables, runs chained requests first, records history. */
export class Runner {
  /** Responses of named requests sent in this session, per file. */
  private readonly named = new Map<string, Map<string, NamedExchange>>();

  constructor(
    private readonly envs: EnvironmentManager,
    private readonly history: History,
  ) {}

  async run(req: HttpRequest, source: RunSource, token?: vscode.CancellationToken, depth = 0): Promise<RunResult> {
    if (depth > 5) throw new Error('Chained requests are nested too deeply (or reference each other in a loop)');
    const fileText = source.uri ? await readText(source.uri) : undefined;
    const file = fileText !== undefined ? parseHttpFile(fileText) : { variables: [], requests: [] };
    const key = source.uri?.toString() ?? '';
    const named = this.named.get(key) ?? new Map<string, NamedExchange>();
    this.named.set(key, named);

    // Send named requests this one depends on, if they have not been sent yet.
    const text = [req.url, ...req.headers.map((h) => h.value), req.body ?? ''].join('\n');
    for (const name of referencedRequestNames(text)) {
      if (named.has(name) || name === req.name) continue;
      const dep = file.requests.find((r) => r.name === name);
      if (!dep) continue;
      await this.run(dep, source, token, depth + 1);
    }

    const ctx: VariableContext = {
      fileVariables: file.variables,
      environment: this.envs.variables(),
      named,
      processEnv: process.env,
      dotenv: await loadDotenv(source.uri),
    };
    const resolved = resolveRequest(req, ctx);
    normalizeBasicAuth(resolved);

    let bodyOverride: Uint8Array | undefined;
    const fileBody = resolved.body !== undefined ? /^<(@?)\s+(.+?)\s*$/.exec(resolved.body.split(/\r?\n/)[0]) : null;
    if (fileBody && resolved.body!.split(/\r?\n/).filter((l) => l.trim()).length === 1) {
      const target = resolveBodyPath(fileBody[2], source.uri);
      const bytes = await vscode.workspace.fs.readFile(target);
      if (fileBody[1] === '@') resolved.body = resolveText(new TextDecoder().decode(bytes), ctx);
      else bodyOverride = bytes;
    }

    const cfg = vscode.workspace.getConfiguration('plainwire');
    const abort = new AbortController();
    const sub = token?.onCancellationRequested(() => abort.abort(new Error('Cancelled')));
    try {
      const response = await sendRequest(resolved, {
        timeoutMs: cfg.get<number>('timeoutMs', 60000),
        followRedirects: req.meta?.['no-redirect'] === undefined && cfg.get<boolean>('followRedirects', true),
        signal: abort.signal,
        bodyOverride,
      });
      if (req.name) {
        named.set(req.name, {
          request: { url: resolved.url, headers: resolved.headers.map((h) => [h.name, h.value]), body: resolved.body },
          response,
        });
      }
      await this.history.add({ request: stripPosition(req), response, file: source.uri?.toString() });
      return { resolved, response };
    } catch (e) {
      await this.history.add({ request: stripPosition(req), error: (e as Error).message, file: source.uri?.toString() });
      throw e;
    } finally {
      sub?.dispose();
    }
  }
}

function stripPosition(req: HttpRequest): HttpRequest {
  const { startLine, endLine, requestLine, ...rest } = req as HttpRequest & { startLine?: number; endLine?: number; requestLine?: number };
  return rest;
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

export async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function resolveBodyPath(p: string, fileUri: vscode.Uri | undefined): vscode.Uri {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return vscode.Uri.file(p);
  const base = fileUri ? vscode.Uri.joinPath(fileUri, '..') : vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!base) throw new Error(`Cannot resolve body file ${p} without a workspace`);
  return vscode.Uri.joinPath(base, p);
}

async function loadDotenv(fileUri: vscode.Uri | undefined): Promise<Record<string, string>> {
  const candidates: vscode.Uri[] = [];
  if (fileUri) candidates.push(vscode.Uri.joinPath(fileUri, '..', '.env'));
  const folder = fileUri ? vscode.workspace.getWorkspaceFolder(fileUri) : vscode.workspace.workspaceFolders?.[0];
  if (folder) candidates.push(vscode.Uri.joinPath(folder.uri, '.env'));
  for (const c of candidates) {
    try {
      return parseDotenv(new TextDecoder().decode(await vscode.workspace.fs.readFile(c)));
    } catch {
      /* try next */
    }
  }
  return {};
}
