import { importPath, parseHttpFile, splitLines } from './httpFile.ts';

/**
 * Organising requests inside and across `.http` files: delete, duplicate, rename, and move
 * (reorder within a file or move to another file). Everything works on the text: the moved
 * block is copied verbatim (comments, `# @name`, scripts, `??` checks and all), and every
 * line outside the edited blocks stays byte-for-byte as it was, line endings included.
 *
 * File variables (`@host = …`) and imports (`# @import ./x.http`) that sit inside a request's
 * block belong to the whole file in REST Client and httpYac, so they always stay in their file.
 */

const SEPARATOR = /^###(.*)$/;
/** Same shapes the parser accepts as file variables / imports (see httpFile.ts). */
const FILE_VAR = /^\s*@([\w.-]+)(?:\s*:?=\s*|\s+(?=\S))(.*?)\s*$/;
const NAME_META = /^(\s*(?:#|\/\/)\s*@name\s+)(\S+)(.*)$/;

function eolOf(text: string): string {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function isFileLevel(line: string): boolean {
  return FILE_VAR.test(line) || importPath(line) !== undefined;
}

/** The lines of request `index`, as a block that starts with a `###` line; file-level lines left out. */
export function requestBlock(text: string, index: number): string[] {
  return cut(text, index).block;
}

function cut(text: string, index: number): { lines: string[]; block: string[]; start: number; end: number; kept: string[] } {
  const lines = splitLines(text);
  const r = parseHttpFile(text).requests[index];
  if (!r) throw new Error(`No request #${index} in this file`);
  const kept: string[] = [];
  const block: string[] = [];
  for (let i = r.startLine; i < r.endLine; i++) {
    if (i < r.requestLine && isFileLevel(lines[i])) kept.push(lines[i]);
    else block.push(lines[i]);
  }
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  // The first request of a file may have no `###` line; a moved or copied block always gets one.
  if (!SEPARATOR.test(block[0] ?? '')) {
    while (block.length && block[0].trim() === '') block.shift();
    block.unshift('###');
  }
  return { lines, block, start: r.startLine, end: r.endLine, kept };
}

/** Remove request `index`; the file's variables and imports in its block stay. */
export function deleteRequest(text: string, index: number): string {
  const eol = eolOf(text);
  const { lines, start, end, kept } = cut(text, index);
  const after = lines.slice(end);
  return joinAround(lines.slice(0, start), kept.length ? [...kept, ''] : [], after, text).join(eol);
}

/**
 * Insert a block (from `requestBlock`) before request `before`, or at the end of the file when
 * `before` is undefined or past the last request.
 */
export function insertBlock(text: string, block: string[], before?: number): string {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const reqs = parseHttpFile(text).requests;
  const target = before === undefined ? undefined : reqs[before];
  if (!target) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const out = lines.length ? [...lines, '', ...block, ''] : [...block, ''];
    return out.join(eol);
  }
  if (SEPARATOR.test(lines[target.startLine])) {
    lines.splice(target.startLine, 0, ...block, '');
    return lines.join(eol);
  }
  // The target is the first request and has no `###`: insert after the file's leading variables,
  // imports and blank lines, and give the target its own `###` line.
  let at = target.startLine;
  while (at < target.requestLine && (isFileLevel(lines[at]) || lines[at].trim() === '')) at++;
  lines.splice(at, 0, ...(at > 0 && lines[at - 1].trim() !== '' ? [''] : []), ...block, '', '###');
  return lines.join(eol);
}

/** Move request `from` so that it ends up before request `before` (an index in the original text), or last. */
export function moveRequest(text: string, from: number, before?: number): string {
  if (before === from || before === from + 1) return text;
  const block = requestBlock(text, from);
  const rest = deleteRequest(text, from);
  const target = before === undefined ? undefined : before > from ? before - 1 : before;
  return insertBlock(rest, block, target);
}

/** Move request `from` out of `fromText` into `toText` (before request `before`, or last). */
export function moveRequestToFile(fromText: string, from: number, toText: string, before?: number): { from: string; to: string } {
  const block = requestBlock(fromText, from);
  return { from: deleteRequest(fromText, from), to: insertBlock(toText, block, before) };
}

/**
 * Copy of request `index` right after it. Its `###` title gets " (copy)" and its `# @name`
 * a free numbered name, so request chaining (`{{name.response…}}`) keeps pointing at the original.
 */
export function duplicateRequest(text: string, index: number, otherNames: Iterable<string> = []): string {
  const parsed = parseHttpFile(text);
  const taken = new Set([...parsed.requests.map((r) => r.name).filter((n): n is string => !!n), ...otherNames]);
  const block = requestBlock(text, index);
  const req = parsed.requests[index];
  const title = (req.title ?? '').trim();
  block[0] = `### ${title ? `${title} (copy)` : `${req.method} ${req.url} (copy)`}`;
  for (let i = 1; i < block.length; i++) {
    const m = NAME_META.exec(block[i]);
    if (m) {
      block[i] = m[1] + freeName(m[2], taken) + m[3];
      break;
    }
  }
  return insertBlock(text, block, index + 1 < parsed.requests.length ? index + 1 : undefined);
}

function freeName(name: string, taken: Set<string>): string {
  const base = name.replace(/_?\d+$/, '') || name;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Set the title on request `index`'s `###` line (an empty title leaves a bare `###`). */
export function renameRequest(text: string, index: number, title: string): string {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const reqs = parseHttpFile(text).requests;
  const r = reqs[index];
  if (!r) throw new Error(`No request #${index} in this file`);
  const clean = title.replace(/[\r\n]+/g, ' ').trim();
  const line = clean ? `### ${clean}` : '###';
  if (SEPARATOR.test(lines[r.startLine])) {
    lines[r.startLine] = line;
    return lines.join(eol);
  }
  if (!clean) return text;
  let at = r.startLine;
  while (at < r.requestLine && (isFileLevel(lines[at]) || lines[at].trim() === '')) at++;
  lines.splice(at, 0, line);
  return lines.join(eol);
}

/** Request names (`# @name`) that another file's text refers to with `{{name.response…}}` / `{{name.request…}}`. */
export function chainedNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\w-]+)\.(?:response|request)\b/g)) out.add(m[1]);
  return out;
}

/** Join the text around a removed block; only the cut boundary is touched. */
function joinAround(before: string[], middle: string[], after: string[], original: string): string[] {
  if (after.length && !(after.length === 1 && after[0] === '')) return [...before, ...middle, ...after];
  // The removed block was the last one: end the file right after the remaining content.
  const out = [...before, ...middle];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (out.length && /\n$/.test(original)) out.push('');
  return out;
}

export interface RequestRef {
  /** Any key for the file (a URI string in the extension). */
  file: string;
  index: number;
}

/**
 * Move several requests (from one or more files) so they land, in file order, before request
 * `target.before` of `target.file` (an index in the current text), or at its end. Returns the new
 * text of every file that changed; an empty map when the drop is onto one of the moved requests.
 */
export function moveRequests(texts: Map<string, string>, refs: RequestRef[], target: { file: string; before?: number }): Map<string, string> {
  const uniq = [...new Map(refs.map((r) => [`${r.file}\u0000${r.index}`, r])).values()];
  if (target.before !== undefined && uniq.some((r) => r.file === target.file && r.index === target.before)) return new Map();
  const files = [...new Set(uniq.map((r) => r.file))];
  const order = (a: RequestRef, b: RequestRef) => files.indexOf(a.file) - files.indexOf(b.file) || a.index - b.index;
  uniq.sort(order);
  const get = (f: string) => {
    const t = texts.get(f);
    if (t === undefined) throw new Error(`Unknown file ${f}`);
    return t;
  };
  const blocks = uniq.map((r) => requestBlock(get(r.file), r.index));
  const out = new Map<string, string>();
  let before = target.before;
  for (const f of files) {
    let t = get(f);
    const idx = uniq.filter((r) => r.file === f).map((r) => r.index).sort((a, b) => b - a);
    for (const i of idx) {
      t = deleteRequest(t, i);
      if (f === target.file && before !== undefined && i < before) before--;
    }
    out.set(f, t);
  }
  let t = out.get(target.file) ?? get(target.file);
  for (const b of blocks) {
    t = insertBlock(t, b, before);
    if (before !== undefined) before++;
  }
  out.set(target.file, t);
  for (const [f, v] of [...out]) if (v === texts.get(f)) out.delete(f);
  return out;
}
