import * as vscode from 'vscode';
import { importPath, splitLines } from '../core/httpFile.ts';

/** Makes the path on `# @import ./shared.http` and `import ./shared.http` lines a Ctrl+click link to that file. */
export class ImportLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    splitLines(doc.getText()).forEach((line, i) => {
      const path = importPath(line);
      if (path === undefined) return;
      const col = line.lastIndexOf(path);
      if (col < 0) return;
      const target = /^([a-zA-Z]:[\\/]|\/)/.test(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(doc.uri, '..', path);
      const link = new vscode.DocumentLink(new vscode.Range(i, col, i, col + path.length), target);
      link.tooltip = 'Open the imported file';
      links.push(link);
    });
    return links;
  }
}
