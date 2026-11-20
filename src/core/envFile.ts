/**
 * The environment editor's model of an `http-client.env.json` + `http-client.private.env.json` pair
 * (JetBrains / httpYac / REST Client format: `{ "$shared": {...}, "dev": { "baseUrl": "..." } }`).
 *
 *   files → modelFromFiles() → (edits in the UI) → writeFiles() → the two output objects / texts
 *
 * Pure: no I/O. Everything the editor does not edit is written back unchanged: `$schema` and other top-level keys
 * that are not environments, non-string variable values (objects such as `"Security": { "Auth": {...} }`, arrays,
 * numbers, booleans, null), and the order of existing keys. A file whose content would not change is not rewritten.
 */

export type Which = 'public' | 'private';

/** One variable as it appears in one file. The same name may exist in both files (the private value wins). */
export interface EnvVarRow {
  name: string;
  /** The value, for string values. Unset for read-only rows. */
  value?: string;
  /** Stored in `http-client.private.env.json`. */
  secret: boolean;
  /**
   * Set for non-string values: what kind of JSON value it is. Such rows are shown read-only and written back
   * exactly as they were read (taken from the original file, not from the edited model).
   */
  readonly?: 'object' | 'array' | 'number' | 'boolean' | 'null';
  /** Short JSON preview of a read-only value. */
  preview?: string;
  /** Where this row came from (unset for rows added in the editor). Used to keep key order and read-only values. */
  orig?: { name: string; secret: boolean };
}

export interface EnvEntry {
  name: string;
  /** Name in the files when loaded (unset for environments added in the editor). */
  orig?: string;
  vars: EnvVarRow[];
}

export interface EnvModel {
  envs: EnvEntry[];
}

export const SHARED = '$shared';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Top-level keys that are environments (same rule as the EnvironmentManager: objects, except `$schema`). */
const isEnvKey = (k: string, v: unknown): v is Obj => k !== '$schema' && isObj(v);

function kindOf(v: unknown): EnvVarRow['readonly'] {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

function preview(v: unknown, max = 80): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Build the editor model from the two parsed files (either may be undefined: the file does not exist). */
export function modelFromFiles(pub: unknown, priv: unknown): EnvModel {
  const envs: EnvEntry[] = [];
  const byName = new Map<string, EnvEntry>();
  const read = (file: unknown, secret: boolean) => {
    if (!isObj(file)) return;
    for (const [env, vars] of Object.entries(file)) {
      if (!isEnvKey(env, vars)) continue;
      let e = byName.get(env);
      if (!e) {
        e = { name: env, orig: env, vars: [] };
        byName.set(env, e);
        envs.push(e);
      }
      for (const [name, v] of Object.entries(vars)) {
        const row: EnvVarRow = { name, secret, orig: { name, secret } };
        if (typeof v === 'string') row.value = v;
        else {
          row.readonly = kindOf(v);
          row.preview = preview(v);
        }
        e.vars.push(row);
      }
    }
  };
  read(pub, false);
  read(priv, true);
  return { envs };
}

/** Problems that block saving, as messages for the user. Empty when the model can be written. */
export function validate(model: EnvModel): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of model.envs) {
    const name = e.name.trim();
    if (!name) errors.push('An environment has no name.');
    else if (name === '$schema') errors.push('"$schema" cannot be used as an environment name.');
    else if (seen.has(name)) errors.push(`There are two environments named "${name}".`);
    seen.add(name);
    const label = e.name === SHARED ? 'Shared' : `"${e.name}"`;
    const names = { public: new Set<string>(), private: new Set<string>() };
    for (const v of e.vars) {
      const n = v.name.trim();
      const set = v.secret ? names.private : names.public;
      if (!n) errors.push(`A variable in ${label} has no name.`);
      else if (set.has(n)) errors.push(`${label} has two ${v.secret ? 'secret' : 'non-secret'} variables named "${n}".`);
      set.add(n);
      if (v.readonly && !v.orig) errors.push(`Variable "${n}" in ${label} has no value.`);
    }
  }
  return errors;
}

export interface WriteResult {
  public: Obj;
  private: Obj;
  /** Texts to write (2-space indent, trailing newline). */
  publicText: string;
  privateText: string;
  /** Whether the file's content changes (or the file has to be created). Unchanged files should not be written. */
  publicChanged: boolean;
  privateChanged: boolean;
}

export const toText = (o: unknown): string => JSON.stringify(o, null, 2) + '\n';

/**
 * Apply the edited model to the original files. `origPub` / `origPriv` are the parsed files the model was built from
 * (undefined when the file did not exist). Throws if the model does not validate.
 */
export function writeFiles(model: EnvModel, origPub: unknown, origPriv: unknown): WriteResult {
  const errors = validate(model);
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [label, f] of [['http-client.env.json', origPub], ['http-client.private.env.json', origPriv]] as const) {
    if (f !== undefined && !isObj(f)) throw new Error(`${label} is not a JSON object; fix it in the JSON editor first.`);
  }
  const orig: Record<Which, Obj | undefined> = { public: isObj(origPub) ? origPub : undefined, private: isObj(origPriv) ? origPriv : undefined };
  const envs = model.envs.map((e) => ({ ...e, name: e.name.trim(), vars: e.vars.map((v) => ({ ...v, name: v.name.trim() })) }));

  /** The original value of a read-only row (looked up in the file it came from). */
  const origValue = (e: EnvEntry, v: EnvVarRow): unknown => {
    const src = orig[v.orig!.secret ? 'private' : 'public'];
    const vars = e.orig !== undefined && src ? src[e.orig] : undefined;
    if (!isObj(vars) || !Object.prototype.hasOwnProperty.call(vars, v.orig!.name)) throw new Error(`The original value of "${v.name}" was not found; reload the editor.`);
    return vars[v.orig!.name];
  };
  const valueOf = (e: EnvEntry, v: EnvVarRow): unknown => (v.readonly ? origValue(e, v) : v.value ?? '');

  const buildVars = (e: EnvEntry, which: Which, origVars: Obj | undefined): Obj => {
    const secret = which === 'private';
    const out: Obj = {};
    const placed = new Set<EnvVarRow>();
    // Existing keys first, in their original order (renamed in place; moved or deleted ones drop out).
    for (const k of Object.keys(origVars ?? {})) {
      const row = e.vars.find((v) => v.orig && v.orig.secret === secret && v.orig.name === k && !placed.has(v));
      if (!row || row.secret !== secret) continue;
      out[row.name] = valueOf(e, row);
      placed.add(row);
    }
    // New, renamed-from-elsewhere and moved rows after them, in the editor's order.
    for (const row of e.vars) if (row.secret === secret && !placed.has(row)) out[row.name] = valueOf(e, row);
    return out;
  };

  const buildFile = (which: Which): Obj => {
    const src = orig[which];
    const out: Obj = {};
    const placed = new Set<EnvEntry>();
    for (const [k, v] of Object.entries(src ?? {})) {
      if (!isEnvKey(k, v)) {
        out[k] = v; // $schema and anything else that is not an environment
        continue;
      }
      const e = envs.find((x) => x.orig === k);
      if (!e) continue; // deleted
      out[e.name] = buildVars(e, which, v);
      placed.add(e);
    }
    for (const e of envs) {
      if (placed.has(e)) continue;
      const vars = buildVars(e, which, undefined);
      const hasVars = Object.keys(vars).length > 0;
      // A new environment is listed in the public file even while empty (so it shows up in the picker);
      // an environment that so far only exists in the private file gets a public entry once it has public variables.
      const inOtherFile = e.orig !== undefined;
      if (hasVars || (which === 'public' && !inOtherFile && e.name !== SHARED)) out[e.name] = vars;
    }
    return out;
  };

  const pub = buildFile('public');
  const priv = buildFile('private');
  const changed = (o: Obj, before: Obj | undefined) => (before === undefined ? Object.keys(o).length > 0 : JSON.stringify(o) !== JSON.stringify(before));
  return {
    public: pub,
    private: priv,
    publicText: toText(pub),
    privateText: toText(priv),
    publicChanged: changed(pub, orig.public),
    privateChanged: changed(priv, orig.private),
  };
}

/**
 * Whether a `.gitignore` (its text) ignores `relPath` (a path relative to the .gitignore's folder, `/`-separated).
 * Handles comments, `!` negation, `/` anchoring, trailing `/` (directories), `*`, `?`, `**` and `[...]`; later
 * patterns win. Only this one file is considered (not nested .gitignore files, .git/info/exclude or global excludes).
 */
export function gitignoreCovers(text: string, relPath: string): boolean {
  const parts = relPath.replace(/^\/+/, '').split('/');
  let ignored = false;
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const re = globToRegExp(line);
    // A pattern matches the path itself or any of its parent directories.
    let hit = false;
    for (let i = 1; i <= parts.length && !hit; i++) {
      const isDir = i < parts.length;
      if (dirOnly && !isDir) continue;
      const prefix = parts.slice(0, i).join('/');
      hit = anchored ? re.test(prefix) : re.test(parts[i - 1]);
    }
    if (hit) ignored = !negate;
  }
  return ignored;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) re += '\\' + glob[++i];
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
