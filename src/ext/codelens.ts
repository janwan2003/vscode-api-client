import * as vscode from 'vscode';
import { parseHttpFile } from '../core/httpFile.ts';

/** "Send" / "Open in Plainwire" / "Copy as Code…" (cURL is one of its languages) above every request in .http files. */
export class RequestCodeLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('plainwire').get<boolean>('codeLens', true)) return [];
    const lenses: vscode.CodeLens[] = [];
    const reqs = parseHttpFile(doc.getText()).requests;
    if (reqs.length > 1) {
      const top = new vscode.Range(reqs[0].startLine, 0, reqs[0].startLine, 0);
      const checks = reqs.reduce((n, r) => n + (r.asserts?.length ?? 0), 0);
      lenses.push(new vscode.CodeLens(top, { title: `$(run-all) Run all ${reqs.length} requests${checks ? ` (${checks} checks)` : ''}`, command: 'plainwire.runFile', arguments: [doc.uri], tooltip: 'Send every request in this file in order and show a pass/fail report' }));
    }
    reqs.forEach((r, i) => {
      const range = new vscode.Range(r.requestLine, 0, r.requestLine, 0);
      const args = [{ uri: doc.uri, index: i }];
      lenses.push(
        new vscode.CodeLens(range, { title: '$(play) Send', command: 'plainwire.sendAt', arguments: args, tooltip: 'Send this request and show the response in Plainwire' }),
        new vscode.CodeLens(range, { title: 'Open in Plainwire', command: 'plainwire.openAt', arguments: args }),
        new vscode.CodeLens(range, { title: 'Copy as Code…', command: 'plainwire.copyAsCode', arguments: args, tooltip: 'Copy this request as cURL, fetch, Python, Go, … (variables resolved, nothing sent)' }),
      );
    });
    return lenses;
  }
}
