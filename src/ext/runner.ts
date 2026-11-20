import * as vscode from 'vscode';
import type { HttpRequest } from '../core/model.ts';
import { Executor, type ExecResult } from '../core/exec.ts';
import { parseDotenv } from '../core/variables.ts';
import type { EnvironmentManager } from './environments.ts';
import type { History } from './history.ts';

export interface RunSource {
  /** The .http file the request belongs to (for file variables, chaining, relative body files). */
  uri?: vscode.Uri;
}

export type RunResult = ExecResult;

/** Sends requests with the shared core Executor, reading files through the VS Code workspace and recording history. */
export class Runner {
  private readonly exec: Executor;

  constructor(envs: EnvironmentManager, history: History) {
    this.exec = new Executor({
      readHttpFile: (file) => readText(vscode.Uri.parse(file)),
      readBodyFile: async (p, file) => vscode.workspace.fs.readFile(resolveBodyPath(p, file ? vscode.Uri.parse(file) : undefined)),
      dotenv: (file) => loadDotenv(file ? vscode.Uri.parse(file) : undefined),
      environment: () => envs.variables(),
      sendOptions: (req) => {
        const cfg = vscode.workspace.getConfiguration('plainwire');
        return {
          timeoutMs: cfg.get<number>('timeoutMs', 60000),
          followRedirects: req.meta?.['no-redirect'] === undefined && cfg.get<boolean>('followRedirects', true),
          rejectUnauthorized: req.meta?.['insecure'] === undefined && cfg.get<boolean>('rejectUnauthorized', true),
          // plainwire.proxy, else VS Code's http.proxy, else HTTPS_PROXY / HTTP_PROXY (either case).
          proxy:
            cfg.get<string>('proxy') ||
            vscode.workspace.getConfiguration('http').get<string>('proxy') ||
            process.env.HTTPS_PROXY ||
            process.env.https_proxy ||
            process.env.HTTP_PROXY ||
            process.env.http_proxy ||
            undefined,
          noProxy: (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        };
      },
      onExchange: ({ request, file, response, error }) => history.add({ request: stripPosition(request), response, error, file }),
    });
  }

  /** Forget named responses for a file, so the next run sends chained requests again. */
  resetSession(uri: vscode.Uri): void {
    this.exec.resetSession(uri.toString());
  }

  async run(req: HttpRequest, source: RunSource, token?: vscode.CancellationToken): Promise<RunResult> {
    const abort = new AbortController();
    const sub = token?.onCancellationRequested(() => abort.abort(new Error('Cancelled')));
    try {
      return await this.exec.run(req, source.uri?.toString(), abort.signal);
    } finally {
      sub?.dispose();
    }
  }
}

function stripPosition(req: HttpRequest): HttpRequest {
  const { startLine, endLine, requestLine, ...rest } = req as HttpRequest & { startLine?: number; endLine?: number; requestLine?: number };
  return rest;
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
