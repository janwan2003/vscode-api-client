import * as vscode from 'vscode';
import type { HttpRequest } from '../core/model.ts';
import type { SseEvent } from '../core/sse.ts';
import { Executor, type ExecResult, type PreviewResult } from '../core/exec.ts';
import type { SendOptions } from '../core/send.ts';
import { authConfigs, OAuth2Manager, readAuthConfig } from '../core/oauth2.ts';
import { sendRequest } from '../core/send.ts';
import { parseDotenv, resolveText } from '../core/variables.ts';
import type { CookieStore } from './cookies.ts';
import type { EnvironmentManager } from './environments.ts';
import type { History } from './history.ts';

export interface RunSource {
  /** The .http file the request belongs to (for file variables, chaining, relative body files). */
  uri?: vscode.Uri;
}

export type RunResult = ExecResult;

const GLOBALS_KEY = 'plainwire.scriptGlobals';

/** Sends requests with the shared core Executor, reading files through the VS Code workspace and recording history. */
export class Runner {
  private readonly exec: Executor;
  /** OAuth 2 tokens for `{{$auth.token("id")}}`, kept in memory for this window. */
  readonly oauth2: OAuth2Manager;

  constructor(private readonly envs: EnvironmentManager, history: History, cookies?: CookieStore, log?: (m: string) => void, state?: vscode.Memento) {
    const saved = state?.get<[string, string][]>(GLOBALS_KEY);
    this.oauth2 = new OAuth2Manager({
      send: (req, signal) => sendRequest(req, { ...vscodeSendOptions(req), signal }),
      openBrowser: async (url) => {
        const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
        if (!ok) throw new Error('The browser could not be opened for the OAuth 2 sign-in');
        vscode.window.setStatusBarMessage('$(sync~spin) Plainwire: waiting for the OAuth 2 sign-in in your browser…', 15000);
      },
      showDeviceCode: ({ id, userCode, verificationUri }) => {
        void vscode.env.clipboard.writeText(userCode);
        void vscode.window.showInformationMessage(`Plainwire: to sign in to "${id}", enter the code ${userCode} at ${verificationUri} (copied to the clipboard).`);
      },
      log,
    });
    this.exec = new Executor({
      oauth2: this.oauth2,
      readHttpFile: (file) => readText(vscode.Uri.parse(file)),
      resolveImport: (p, file) => resolveBodyPath(p, vscode.Uri.parse(file)).toString(),
      readBodyFile: async (p, file) => vscode.workspace.fs.readFile(resolveBodyPath(p, file ? vscode.Uri.parse(file) : undefined)),
      dotenv: (file) => loadDotenv(file ? vscode.Uri.parse(file) : undefined),
      environment: () => envs.variables(),
      sendOptions: (req) => vscodeSendOptions(req),
      get cookieJar() {
        return cookies?.enabled ? cookies.jar : undefined;
      },
      runScripts: () => vscode.workspace.isTrusted && vscode.workspace.getConfiguration('plainwire').get<boolean>('runScripts', true),
      globals: new Map(Array.isArray(saved) ? saved : []),
      onGlobalsChanged: async (g) => void (await state?.update(GLOBALS_KEY, [...g])),
      onExchange: async ({ request, file, response, error }) => {
        if (cookies?.enabled) await cookies.save();
        await history.add({ request: stripPosition(request), response, error, file });
      },
    });
  }

  /** `client.global` values set by response handlers, kept per workspace. */
  get globals(): Map<string, string> {
    return this.exec.globals;
  }

  /** Forget named responses for a file, so the next run sends chained requests again. */
  resetSession(uri: vscode.Uri): void {
    this.exec.resetSession(uri.toString());
  }

  /** The request as it would be sent (variables resolved), without sending it or its chained requests. */
  preview(req: HttpRequest, source: RunSource): Promise<PreviewResult> {
    return this.exec.preview(req, source.uri?.toString());
  }

  /** Auth configuration ids of the active environment ("Security" → "Auth"). */
  authIds(): string[] {
    return Object.keys(authConfigs(this.envs.variables()));
  }

  /** Acquire a token for an auth id now, skipping the cache (Acquire OAuth 2 Token). */
  async acquireToken(id: string, token?: vscode.CancellationToken): Promise<{ expiresAt?: number; hasRefresh: boolean; hasIdToken: boolean }> {
    const env = this.envs.variables();
    const ctx = { fileVariables: [], environment: env, named: new Map(), processEnv: process.env, dotenv: {} };
    const cfg = readAuthConfig(env, id, (s) => resolveText(s, ctx));
    const abort = new AbortController();
    const sub = token?.onCancellationRequested(() => abort.abort(new Error('Cancelled')));
    try {
      const t = await this.oauth2.token(cfg, { force: true, signal: abort.signal });
      return { expiresAt: t.expiresAt, hasRefresh: !!t.refreshToken, hasIdToken: !!t.idToken };
    } finally {
      sub?.dispose();
    }
  }

  async run(req: HttpRequest, source: RunSource, token?: vscode.CancellationToken, onEvent?: (e: SseEvent) => void): Promise<RunResult> {
    const abort = new AbortController();
    const sub = token?.onCancellationRequested(() => abort.abort(new Error('Cancelled')));
    try {
      return await this.exec.run(req, source.uri?.toString(), abort.signal, { onEvent });
    } finally {
      sub?.dispose();
    }
  }
}


/** Timeout, redirects, TLS, proxy and User-Agent from Plainwire's settings (and the request's `# @flags`). */
export function vscodeSendOptions(req?: HttpRequest): SendOptions {
  const cfg = vscode.workspace.getConfiguration('plainwire');
  return {
    timeoutMs: cfg.get<number>('timeoutMs', 60000),
    followRedirects: req?.meta?.['no-redirect'] === undefined && cfg.get<boolean>('followRedirects', true),
    rejectUnauthorized: req?.meta?.['insecure'] === undefined && cfg.get<boolean>('rejectUnauthorized', true),
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
    userAgent: `plainwire/${vscode.extensions.getExtension('plainbyte.plainwire')?.packageJSON?.version ?? ''}`.replace(/\/$/, ''),
  };
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
