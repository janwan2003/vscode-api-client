// End-to-end test in a real VS Code without a display (Electron headless Ozone backend).
// Usage: node scripts/e2e.mjs [path-to-code-binary]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Pass the Electron binary itself (e.g. /snap/code/current/usr/share/code/code), not the snap wrapper.
const code = process.argv[2] || process.env.VSCODE_BIN || 'code';
const root = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'plainwire-e2e-'));
const ws = join(tmp, 'ws');
cpSync('test/e2e/workspace', ws, { recursive: true });
const report = join(tmp, 'report.txt');
const r = spawnSync(code, [
  ws,
  '--extensionDevelopmentPath=' + root,
  '--extensionTestsPath=' + join(root, 'test/e2e/suite.cjs'),
  '--user-data-dir=' + join(tmp, 'user'),
  '--extensions-dir=' + join(tmp, 'ext'),
  '--disable-extensions',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--ozone-platform=headless',
], { env: { ...process.env, PLAINWIRE_E2E_REPORT: report, DONT_PROMPT_WSL_INSTALL: '1' }, encoding: 'utf8', timeout: 180000 });
let out = '';
try { out = readFileSync(report, 'utf8'); } catch { out = '(no report)\n' + (r.stdout || '') + (r.stderr || '').split('\n').slice(-30).join('\n'); }
console.log(out);
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status === 0 && !out.includes('FAIL') && out.includes('ok') ? 0 : 1);
