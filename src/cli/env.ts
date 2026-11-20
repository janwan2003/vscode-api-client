import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { addEnvironments } from '../core/variables.ts';
import { readJsonFile, walk } from './files.ts';

export { addEnvironments };

export type Envs = Record<string, Record<string, string>>;

/**
 * Environments, in the extension's order (later wins per variable):
 *   1. `rest-client.environmentVariables` and `plainwire.environmentVariables` in `.vscode/settings.json`,
 *   2. every `http-client.env.json` under `root`,
 *   3. every `http-client.private.env.json` under `root`,
 *   4. `--env-file` files, in the order given.
 * Returns the environments and the files they came from (relative to root) for the log line.
 */
export function loadEnvironments(root: string, extraFiles: string[]): { envs: Envs; sources: string[] } {
  const envs: Envs = {};
  const sources: string[] = [];
  const settings = join(root, '.vscode', 'settings.json');
  if (existsSync(settings)) {
    try {
      const s = readJsonFile(settings, true) as Record<string, unknown>;
      for (const key of ['rest-client.environmentVariables', 'plainwire.environmentVariables']) {
        if (s && typeof s === 'object' && s[key]) {
          addEnvironments(envs, s[key]);
          sources.push(`.vscode/settings.json (${key})`);
        }
      }
    } catch (e) {
      throw new Error(`Could not read .vscode/settings.json: ${(e as Error).message}`);
    }
  }
  const found = walk(root, (p) => /^http-client(\.private)?\.env\.json$/.test(basename(p)), 200);
  found.sort((a, b) => Number(a.includes('.private.')) - Number(b.includes('.private.')) || a.localeCompare(b));
  for (const f of [...found, ...extraFiles]) {
    try {
      addEnvironments(envs, readJsonFile(f));
    } catch (e) {
      throw new Error(`Could not read ${relative(root, f) || f}: ${(e as Error).message}`);
    }
    sources.push(relative(root, f) || f);
  }
  return { envs, sources };
}
