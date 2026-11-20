import * as vscode from 'vscode';
import { parseHttpFile } from '../core/httpFile.ts';

/** "Send" / "Open in Plainwire" / "Copy as cURL" above every request in .http files. */
export class RequestCodeLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('plainwire').get<boolean>('codeLens', true)) return [];
    const lenses: vscode.CodeLens[] = [];
    parseHttpFile(doc.getText()).requests.forEach((r, i) => {
      const range = new vscode.Range(r.requestLine, 0, r.requestLine, 0);
      const args = [{ uri: doc.uri, index: i }];
      lenses.push(
        new vscode.CodeLens(range, { title: '$(play) Send', command: 'plainwire.sendAt', arguments: args, tooltip: 'Send this request and show the response in Plainwire' }),
        new vscode.CodeLens(range, { title: 'Open in Plainwire', command: 'plainwire.openAt', arguments: args }),
        new vscode.CodeLens(range, { title: 'Copy as cURL', command: 'plainwire.copyCurlAt', arguments: args }),
      );
    });
    return lenses;
  }
}
