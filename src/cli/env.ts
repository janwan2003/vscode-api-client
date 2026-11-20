import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { readJsonFile, walk } from './files.ts';

export type Envs = Record<string, Record<string, string>>;

/** Merge `{ envName: { var: value } }` into `envs` (later wins per variable), as the extension does. */
export function addEnvironments(envs: Envs, src: unknown): void {
  if (!src || typeof src !== 'object') return;
  for (const [env, vars] of Object.entries(src as Record<string, unknown>)) {
    if (env === '$schema' || !vars || typeof vars !== 'object') continue;
    envs[env] ??= {};
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      envs[env][k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
}

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
