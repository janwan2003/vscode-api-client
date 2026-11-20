import * as vscode from 'vscode';
import { CODE_TARGETS, generateCode, type CodeTarget } from '../core/codegen.ts';
import type { HttpRequest } from '../core/model.ts';
import type { Runner } from './runner.ts';

const LAST_KEY = 'plainwire.copyAsCode.last';

/**
 * Resolve a request without sending it (environment, file variables, `.env`, responses already
 * received) and copy it as cURL / code. Unresolvable variables stay as `{{name}}` and are reported.
 */
export class CodeCopier {
  constructor(
    private readonly runner: Runner,
    private readonly state: vscode.Memento,
  ) {}

  /** Copy as `target`, or ask which language (last used first). Returns the snippet, or undefined if cancelled. */
  async copy(request: HttpRequest, uri: vscode.Uri | undefined, target?: CodeTarget): Promise<string | undefined> {
    const chosen = target ?? (await this.pick());
    if (!chosen) return undefined;
    const { request: resolved, unresolved } = await this.runner.preview(request, { uri });
    const code = generateCode(chosen, resolved);
    await vscode.env.clipboard.writeText(code);
    if (!target) await this.state.update(LAST_KEY, chosen); // remember picks, not direct calls like Copy as cURL
    const label = CODE_TARGETS.find((t) => t.id === chosen)?.label ?? chosen;
    if (unresolved.length) {
      void vscode.window.showWarningMessage(`Copied as ${label}, but ${unresolved.map((v) => `{{${v}}}`).join(', ')} could not be resolved (unknown, or a chained request not sent yet) and ${unresolved.length === 1 ? 'is' : 'are'} left as written.`);
    } else {
      void vscode.window.setStatusBarMessage(`$(check) Copied as ${label}`, 2500);
    }
    return code;
  }

  /** Languages in the picker, the last one used first. */
  targets(): CodeTarget[] {
    const last = this.state.get<string>(LAST_KEY);
    const ids = CODE_TARGETS.map((t) => t.id);
    return last && ids.includes(last as CodeTarget) ? [last as CodeTarget, ...ids.filter((i) => i !== last)] : ids;
  }

  private async pick(): Promise<CodeTarget | undefined> {
    const last = this.state.get<string>(LAST_KEY);
    const items = this.targets().map((id) => {
      const t = CODE_TARGETS.find((x) => x.id === id)!;
      return { label: t.label, description: t.detail, detail: id === last ? 'last used' : undefined, id };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Copy the request as… (variables are resolved, nothing is sent)', matchOnDescription: true });
    return pick?.id;
  }
}
