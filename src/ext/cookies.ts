import * as vscode from 'vscode';
import { CookieJar, type Cookie } from '../core/cookies.ts';

const KEY = 'plainwire.cookies';

/**
 * The extension's cookie jar: one per workspace, kept in workspace state so a login survives a
 * window reload. Off when `plainwire.rememberCookies` is false.
 */
export class CookieStore {
  readonly jar: CookieJar;

  constructor(private readonly state: vscode.Memento) {
    this.jar = new CookieJar(state.get<Cookie[]>(KEY, []));
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('plainwire').get<boolean>('rememberCookies', true);
  }

  save(): Thenable<void> {
    return this.state.update(KEY, this.jar.toJSON());
  }

  /** Command: list stored cookies; pick one to delete it, or clear them all. */
  async manage(): Promise<void> {
    const cookies = this.jar.list();
    if (!cookies.length) {
      void vscode.window.showInformationMessage(
        this.enabled ? 'Plainwire: no cookies stored. Cookies that responses set are kept here and sent with later requests.' : 'Plainwire: no cookies stored ("plainwire.rememberCookies" is off).',
      );
      return;
    }
    type Item = vscode.QuickPickItem & { cookie?: Cookie; all?: boolean };
    const items: Item[] = [
      { label: '$(trash) Clear all cookies', description: `${cookies.length} stored`, all: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...cookies
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
        .map((c) => ({
          label: `${c.name}=${c.value.length > 60 ? c.value.slice(0, 57) + '…' : c.value}`,
          description: `${c.hostOnly ? '' : '.'}${c.domain}${c.path}`,
          detail: [c.expires ? `expires ${new Date(c.expires).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'session', c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '', c.sameSite ? `SameSite=${c.sameSite}` : ''].filter(Boolean).join(' · '),
          cookie: c,
        })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a cookie to delete it', matchOnDescription: true });
    if (!pick) return;
    if (pick.all) this.jar.delete();
    else if (pick.cookie) this.jar.delete(pick.cookie);
    await this.save();
    void vscode.window.showInformationMessage(pick.all ? 'Plainwire: all cookies cleared.' : `Plainwire: cookie ${pick.cookie!.name} deleted.`);
  }

  async clear(): Promise<void> {
    this.jar.delete();
    await this.save();
  }
}
