import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__']);
const HTTP_FILE = /\.(http|rest)$/i;

/** Every file under `dir` (skipping node_modules, .git and build output), as absolute paths. */
export function walk(dir: string, accept: (path: string) => boolean, limit = 20000): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile() && accept(p)) out.push(p);
    }
  }
  return out.sort();
}

/** `**`, `*`, `?` and `{a,b}` glob → RegExp over '/'-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Resolve CLI arguments to .http/.rest files: files as given, directories searched recursively,
 * quoted glob patterns matched against paths relative to `cwd`. No arguments = everything under `cwd`.
 */
export function findHttpFiles(args: string[], cwd: string): { files: string[]; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  if (!args.length) args = ['.'];
  for (const a of args) {
    if (/[*?{]/.test(a)) {
      const re = globToRegExp(a.replace(/\\/g, '/').replace(/^\.\//, ''));
      const found = walk(cwd, (p) => re.test(relative(cwd, p).split(sep).join('/')));
      if (!found.length) missing.push(a);
      for (const f of found) files.add(f);
      continue;
    }
    const p = resolve(cwd, a);
    if (!existsSync(p)) {
      missing.push(a);
      continue;
    }
    if (statSync(p).isDirectory()) for (const f of walk(p, (x) => HTTP_FILE.test(x))) files.add(f);
    else files.add(p);
  }
  return { files: [...files].sort(), missing };
}

/** Strip // and /* *\/ comments and trailing commas so VS Code's settings.json parses as JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readJsonFile(path: string, jsonc = false): unknown {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return jsonc ? parseJsonc(text) : JSON.parse(text);
}
