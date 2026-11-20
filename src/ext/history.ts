import * as vscode from 'vscode';
import type { HttpRequest, HttpResponse } from '../core/model.ts';

export interface HistoryEntry {
  id: string;
  at: number;
  /** The request as written (unresolved), so it can be reopened and saved. */
  request: HttpRequest;
  response?: HttpResponse;
  error?: string;
  /** File the request came from, if any. */
  file?: string;
}

const KEY = 'plainwire.history';
const MAX_ENTRIES = 100;
const MAX_BODY = 256 * 1024;

/** Sent requests, stored locally in VS Code's workspace storage. Never leaves the machine. */
export class History {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  entries(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(KEY, []);
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries().find((e) => e.id === id);
  }

  async add(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<void> {
    const response = entry.response && entry.response.body.length > MAX_BODY ? { ...entry.response, body: entry.response.body.slice(0, MAX_BODY) } : entry.response;
    const e: HistoryEntry = { ...entry, response, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
    const limit = vscode.workspace.getConfiguration('plainwire').get<number>('historySize', MAX_ENTRIES);
    await this.state.update(KEY, [e, ...this.entries()].slice(0, Math.max(0, limit)));
    this.changed.fire();
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, []);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
