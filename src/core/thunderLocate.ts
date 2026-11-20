import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { readThunderStore, type ThunderFile, type ThunderStoreSummary } from './importers/thunderStore.ts';

/**
 * Find Thunder Client's data on this computer. Thunder's docs (docs.thunderclient.com, "Storage
 * Location") name `<editor user dir>/User/globalStorage/rangav.vscode-thunder-client` per OS; the
 * same folder name exists for every VS Code-based editor, under its own product folder, and under
 * the `*-server/data` folder of a remote (SSH/WSL) host. Kept out of `importers/` so the website
 * bundle stays free of `node:fs`.
 */

export const THUNDER_EXTENSION_ID = 'rangav.vscode-thunder-client';

/** Product folders of VS Code and the forks that use the same layout, with a display name. */
const EDITORS: [folder: string, label: string][] = [
  ['Code', 'VS Code'],
  ['Code - Insiders', 'VS Code Insiders'],
  ['Cursor', 'Cursor'],
  ['Windsurf', 'Windsurf'],
  ['VSCodium', 'VSCodium'],
  ['Code - OSS', 'Code - OSS'],
  ['Trae', 'Trae'],
  ['Kiro', 'Kiro'],
  ['Positron', 'Positron'],
];

/** Remote server data folders (`~/.vscode-server/data`), for Thunder data on an SSH/WSL host. */
const SERVERS: [folder: string, label: string][] = [
  ['.vscode-server', 'VS Code Server'],
  ['.vscode-server-insiders', 'VS Code Insiders Server'],
  ['.cursor-server', 'Cursor Server'],
  ['.windsurf-server', 'Windsurf Server'],
  ['.vscodium-server', 'VSCodium Server'],
];

export interface ThunderCandidate {
  dir: string;
  label: string;
}

export interface LocateEnv {
  home?: string;
  platform?: NodeJS.Platform;
  appData?: string;
  xdgConfig?: string;
}

/** Every folder where Thunder Client may keep its data, existing or not. */
export function thunderCandidateDirs(env: LocateEnv = {}): ThunderCandidate[] {
  const home = env.home ?? homedir();
  const platform = env.platform ?? process.platform;
  const base =
    platform === 'win32'
      ? env.appData || process.env.APPDATA || join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : env.xdgConfig || process.env.XDG_CONFIG_HOME || join(home, '.config');
  const out: ThunderCandidate[] = [];
  for (const [folder, label] of EDITORS) {
    const user = join(base, folder, 'User');
    out.push({ dir: join(user, 'globalStorage', THUNDER_EXTENSION_ID), label });
    // Profiles other than Default may keep their own extension storage.
    const profiles = join(user, 'profiles');
    if (existsSync(profiles)) {
      for (const p of safeList(profiles)) out.push({ dir: join(profiles, p, 'globalStorage', THUNDER_EXTENSION_ID), label: `${label} (profile ${p})` });
    }
  }
  for (const [folder, label] of SERVERS) out.push({ dir: join(home, folder, 'data', 'User', 'globalStorage', THUNDER_EXTENSION_ID), label });
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

/** The `.json` and `.db` files under `dir` (depth ≤ 6, backups skipped later by the reader). */
export function readThunderDir(dir: string): ThunderFile[] {
  const files: ThunderFile[] = [];
  let bytes = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 6 || files.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        walk(p, depth + 1);
      } else if (e.isFile() && /\.(json|db)$/i.test(e.name)) {
        let size = 0;
        try {
          size = statSync(p).size;
        } catch {
          continue;
        }
        if (bytes + size > MAX_BYTES) continue;
        bytes += size;
        try {
          files.push({ path: relative(dir, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
        } catch {
          // unreadable: skip
        }
      }
    }
  };
  walk(dir, 0);
  return files;
}

/** Newest modification time (ms) among the files, for sorting locations. */
function newest(dir: string, files: ThunderFile[]): number {
  let t = 0;
  for (const f of files) {
    try {
      t = Math.max(t, statSync(join(dir, ...f.path.split('/'))).mtimeMs);
    } catch {
      // ignore
    }
  }
  return t;
}

export interface ThunderLocation extends ThunderCandidate {
  files: ThunderFile[];
  summary: ThunderStoreSummary;
  /** Newest file's modification time in ms (0 when unknown). */
  modified: number;
}

/** Inspect one folder; undefined when it holds no Thunder requests, collections, environments or history. */
export function inspectThunderDir(c: ThunderCandidate): ThunderLocation | undefined {
  if (!existsSync(c.dir)) return undefined;
  const files = readThunderDir(c.dir);
  if (!files.length) return undefined;
  const { summary } = readThunderStore(files);
  if (!summary.requests && !summary.environments && !summary.history && !summary.collections) return undefined;
  return { ...c, files, summary, modified: newest(c.dir, files) };
}

/** Thunder data found in the given (or default) folders, most recently changed first; duplicates by path dropped. */
export function findThunderData(extra: ThunderCandidate[] = [], env: LocateEnv = {}): ThunderLocation[] {
  const seen = new Set<string>();
  const out: ThunderLocation[] = [];
  for (const c of [...extra, ...thunderCandidateDirs(env)]) {
    const key = process.platform === 'win32' || process.platform === 'darwin' ? c.dir.toLowerCase() : c.dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const loc = inspectThunderDir(c);
    if (loc) out.push(loc);
  }
  return out.sort((a, b) => b.modified - a.modified);
}
