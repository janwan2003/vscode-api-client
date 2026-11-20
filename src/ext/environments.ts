import * as vscode from 'vscode';
import { addEnvironments, mergeEnvironment } from '../core/variables.ts';

type Envs = Record<string, Record<string, string>>;

const STATE_KEY = 'plainwire.environment';

/**
 * Environments come from, in order (later wins per variable):
 *   1. the `rest-client.environmentVariables` setting (so REST Client users keep theirs),
 *   2. the `plainwire.environmentVariables` setting,
 *   3. `http-client.env.json` files in the workspace (JetBrains / httpYac format),
 *   4. `http-client.private.env.json` files (secrets; keep them out of git).
 */
export class EnvironmentManager implements vscode.Disposable {
  private envs: Envs = {};
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'plainwire.selectEnvironment';
    this.status.tooltip = 'Plainwire: select the environment used for {{variables}}';
    const watcher = vscode.workspace.createFileSystemWatcher('**/http-client*.env.json');
    watcher.onDidChange(() => this.reload());
    watcher.onDidCreate(() => this.reload());
    watcher.onDidDelete(() => this.reload());
    this.disposables.push(
      watcher,
      this.status,
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('rest-client.environmentVariables') || e.affectsConfiguration('plainwire.environmentVariables')) this.reload();
      }),
    );
  }

  async reload(): Promise<void> {
    const envs: Envs = {};
    const add = (src: unknown) => addEnvironments(envs, src);
    add(vscode.workspace.getConfiguration('rest-client').get('environmentVariables'));
    add(vscode.workspace.getConfiguration('plainwire').get('environmentVariables'));
    const files = await vscode.workspace.findFiles('**/http-client{.env,.private.env}.json', '**/node_modules/**', 50);
    files.sort((a, b) => Number(a.path.includes('.private.')) - Number(b.path.includes('.private.')));
    for (const f of files) {
      try {
        add(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(f))));
      } catch (e) {
        void vscode.window.showWarningMessage(`Plainwire: could not read ${vscode.workspace.asRelativePath(f)}: ${(e as Error).message}`);
      }
    }
    this.envs = envs;
    this.updateStatus();
    this.changed.fire();
  }

  names(): string[] {
    return Object.keys(this.envs).filter((n) => n !== '$shared');
  }

  get selected(): string | undefined {
    const s = this.state.get<string>(STATE_KEY);
    return s && this.envs[s] ? s : undefined;
  }

  async select(name: string | undefined): Promise<void> {
    await this.state.update(STATE_KEY, name);
    this.updateStatus();
    this.changed.fire();
  }

  variables(): Record<string, string> {
    return mergeEnvironment(this.envs, this.selected);
  }

  private updateStatus(): void {
    const names = this.names();
    if (!names.length && !this.envs['$shared']) {
      this.status.hide();
      return;
    }
    this.status.text = `$(globe) ${this.selected ?? 'No environment'}`;
    this.status.show();
  }

  async pick(): Promise<void> {
    const names = this.names();
    const items: (vscode.QuickPickItem & { env?: string })[] = [
      { label: 'No environment', description: this.selected ? '' : 'current' },
      ...names.map((n) => ({ label: n, env: n, description: n === this.selected ? 'current' : `${Object.keys(this.envs[n]).length} variables` })),
    ];
    if (!names.length) items.push({ label: '$(add) Create http-client.env.json…', env: '__create__' });
    items.push({ label: '$(edit) Edit environments…', env: '__edit__' });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Environment for {{variables}}' });
    if (!choice) return;
    if (choice.env === '__create__') return void vscode.commands.executeCommand('plainwire.createEnvFile');
    if (choice.env === '__edit__') return void vscode.commands.executeCommand('plainwire.editEnvironments');
    await this.select(choice.env);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
