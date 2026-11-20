export const captured = (globalThis.__pwCaptured ??= {});
export class Uri { static parse(s) { return s; } }
export const ViewColumn = { Active: -1 };
export const FileType = { Directory: 2 };
export class CancellationTokenSource { constructor() { this.token = { isCancellationRequested: false }; } cancel() {} }
export const window = { createWebviewPanel() { const webview = { set html(h) { captured.html = h; }, onDidReceiveMessage() {}, postMessage() {} }; return { webview, reveal() {}, onDidDispose() {}, title: '' }; } };
export const workspace = { asRelativePath: (u) => String(u) };
export const env = {};
