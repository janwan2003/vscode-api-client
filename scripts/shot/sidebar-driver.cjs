// Runs inside VS Code (extension host) for scripts/shot/sidebar.mjs: shows the Plainwire sidebar
// with folders expanded and a request selected, then waits until the screenshot is taken.
const vscode = require('vscode');
const fs = require('fs');
exports.run = async function run() {
  try { await main(); } catch (e) { fs.writeFileSync(process.env.SHOT_READY + '.log', String(e && e.stack || e)); throw e; }
};
async function main() {
  const api = await vscode.extensions.getExtension('plainbyte.plainwire').activate();
  await vscode.commands.executeCommand('workbench.view.extension.plainwire');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
  const tryCmd = (c) => Promise.resolve(vscode.commands.executeCommand(c)).catch((e) => fs.appendFileSync(process.env.SHOT_READY + '.log', `${c}: ${e}\n`));
  await tryCmd('workbench.action.focusSideBar');
  for (let i = 0; i < 20; i++) await tryCmd('workbench.action.increaseViewWidth');
  await new Promise((r) => setTimeout(r, 1500));
  const tree = api.collectionsForTest;
  const view = api.organizerForTest.view;
  const find = async (parent, label) => (await tree.getChildren(parent)).find((n) => tree.getTreeItem(n).label === label);
  const shop = await find(undefined, 'shop-api');
  const orders = await find(shop, 'orders');
  const file = await find(orders, 'refunds.http');
  const reqs = await tree.getChildren(file);
  await view.reveal(reqs[1], { expand: true, select: true, focus: true });
  await vscode.commands.executeCommand('plainwire.openRequest', reqs[1]);
  await new Promise((r) => setTimeout(r, 800));
  await tryCmd('notifications.clearAll');
  fs.writeFileSync(process.env.SHOT_READY, 'ready');
  for (let i = 0; i < 600 && !fs.existsSync(process.env.SHOT_DONE); i++) await new Promise((r) => setTimeout(r, 100));
}
