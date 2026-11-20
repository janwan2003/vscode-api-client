/**
 * Convert other clients' response tests into Plainwire `# @assert` lines (see core/assert.ts).
 * Whatever cannot be expressed is reported back so the importer can warn about it.
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const s = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '');

export interface ConvertedTests {
  asserts: string[];
  /** Human-readable descriptions of tests that were not converted. */
  skipped: string[];
  /** Postman: checks skipped because they only run under a condition, in a loop, callback or try. */
  conditional?: number;
}

/** Thunder Client stores JSON paths as `json.data[0].id`; Plainwire uses `$.data[0].id`. */
function thunderPath(custom: string): string | undefined {
  const c = custom.trim();
  if (!c) return undefined;
  if (c.startsWith('$')) return c;
  const m = /^json(.*)$/i.exec(c);
  if (m) return '$' + m[1];
  return '$.' + c;
}

const THUNDER_OPS: Record<string, string> = {
  equal: '==', equals: '==', '=': '==', '==': '==',
  notequal: '!=', '!=': '!=',
  contains: 'contains', notcontains: '!contains',
  '<': '<', '<=': '<=', '>': '>', '>=': '>=',
  lessthan: '<', greaterthan: '>',
  regex: 'matches', matches: 'matches',
  startswith: 'startsWith', endswith: 'endsWith',
};
const TEXT_OPS = new Set(['contains', '!contains', 'startsWith', 'endsWith']);
const THUNDER_TYPES: Record<string, string> = {
  number: 'isNumber', string: 'isString', boolean: 'isBoolean', array: 'isArray', object: 'isObject', null: 'isNull',
};

/**
 * Thunder Client `tests`: [{ type, custom, action, value }], e.g.
 * { type: 'res-code', action: 'equal', value: '200' } or
 * { type: 'json-query', custom: 'json.id', action: 'equal', value: '1' }.
 * Written from the format as Thunder Client documents it; unknown shapes are reported, not guessed.
 */
export function convertThunderTests(tests: unknown): ConvertedTests {
  const out: ConvertedTests = { asserts: [], skipped: [] };
  if (!Array.isArray(tests)) return out;
  for (const t of tests) {
    if (!isObj(t)) continue;
    const type = s(t.type).toLowerCase();
    const custom = s(t.custom);
    const action = s(t.action).toLowerCase().replace(/[\s_-]/g, '');
    const value = s(t.value).trim();
    const describe = `${s(t.type)}${custom ? ` ${custom}` : ''} ${s(t.action)} ${value}`.trim();
    if (!type) continue;

    let subject: string | undefined;
    if (type === 'res-code' || type === 'status' || type === 'res-status') subject = 'status';
    else if (type === 'res-time' || type === 'time') subject = 'time';
    else if (type === 'res-body' || type === 'body') subject = 'body';
    else if (type === 'json-query' || type === 'json' || type === 'jsonquery') subject = thunderPath(custom);
    else if (type === 'content-type' || type === 'content-length' || type === 'content-encoding') subject = `header ${s(t.type)}`;
    else if ((type === 'header' || type === 'res-header' || type === 'response-header') && custom) subject = `header ${custom.trim()}`;
    else if (type === 'set-env-var' || type === 'setenvvar') {
      out.skipped.push(`"${describe}" sets a variable; name the request (# @name) and use {{name.response.body.$.field}} instead`);
      continue;
    }

    if (!subject || /\s/.test(subject.replace(/^header /, ''))) {
      out.skipped.push(`"${describe}"`);
      continue;
    }
    if (action === 'isjson') {
      out.asserts.push(`${subject === 'body' ? 'body' : subject} isJson`);
      continue;
    }
    if (action === 'count' || action === 'length') {
      if (!subject.startsWith('$') || value === '') {
        out.skipped.push(`"${describe}"`);
        continue;
      }
      out.asserts.push(`${subject}.length == ${value}`);
      continue;
    }
    if (action === 'type' || action === 'istype') {
      const op = THUNDER_TYPES[value.toLowerCase()];
      if (!op) {
        out.skipped.push(`"${describe}"`);
        continue;
      }
      out.asserts.push(`${subject} ${op}`);
      continue;
    }
    if (action === 'exists' || action === 'notexists' || action === 'isempty' || action === 'notempty') {
      const op = { exists: 'exists', notexists: '!exists', isempty: 'isEmpty', notempty: '!isEmpty' }[action];
      out.asserts.push(`${subject} ${op}`);
      continue;
    }
    const op = THUNDER_OPS[action];
    if (!op || value === '') {
      out.skipped.push(`"${describe}"`);
      continue;
    }
    let expected = value;
    if (op === 'matches' && !/^\/.*\/[a-z]*$/.test(value)) expected = `/${value}/`;
    // Thunder compares text literally: `contains "OK"` looks for the quotes too. An @assert value
    // in quotes is read as a JSON string (quotes dropped), so quote it once more to keep them.
    else if (TEXT_OPS.has(op) && /^".*"$/.test(value)) expected = JSON.stringify(value);
    out.asserts.push(`${subject} ${op} ${expected}`);
  }
  return out;
}

/** JS literal (number, 'str', "str", `str`, true/false/null) → text usable as an @assert value. */
function jsLiteral(x: string): string | undefined {
  const t = x.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(true|false|null)$/.test(t)) return t;
  const m = /^(['"`])((?:\\.|(?!\1).)*)\1$/.exec(t);
  if (!m || (m[1] === '`' && m[2].includes('${'))) return undefined;
  return JSON.stringify(m[2].replace(/\\(.)/g, '$1'));
}

/** `pm.response.json().data[0].id` / `jsonData.data[0].id` → `$.data[0].id`. */
function jsJsonPath(expr: string, jsonVars: Set<string>): string | undefined {
  const t = expr.trim().replace(/\s+/g, '');
  const m = /^(?:pm\.response\.json\(\)|([A-Za-z_$][\w$]*))((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[(['"])[^'"]*\3\])*)$/.exec(t);
  if (!m) return undefined;
  if (m[1] && !jsonVars.has(m[1])) return undefined;
  return '$' + m[2].replace(/\[(['"])([^'"]*)\1\]/g, "['$2']");
}

/** One statement of a test script, with the `pm.test` it is in and whether it only runs sometimes. */
interface Statement {
  text: string;
  /** Name of the enclosing `pm.test(...)`, if any. */
  test?: string;
  /** Inside an if/else/loop/switch/try/callback block, after a braceless `if (...)`, or in `a && b` / `a ? b : c`. */
  conditional: boolean;
}

interface Frame {
  /** test: a pm.test callback; cond: a block that may run zero or many times; object: any other `{...}`. */
  kind: 'top' | 'test' | 'cond' | 'object';
  test?: string;
  cond: boolean;
  buf: string;
  paren: number;
  /** The previous statement was a braceless `if (...)` / `else` / loop header: the next one is its body. */
  pending: boolean;
}

/** Stands in for a `{...}` block already split into its own statements (test, condition, callback). */
const BLOCK = '\u0001';
/** Stands in for any other `{...}` (object literal); its contents are never converted. */
const OBJECT = '\u0002';

const TEST_OPEN = /^pm\.test\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:(?:async\s+)?function\s*[\w$]*\s*\(\s*\)|(?:async\s+)?\(\s*\)\s*=>)$/;
const TEST_EXPR = /^pm\.test\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*([\s\S]+)\)$/;
const CHECK = /\bpm\.expect\s*\(|\bpm\.response\.to\b|(?:^|[^\w$.])expect\s*\(/;

const unescapeName = (s: string) => s.replace(/\\(.)/g, '$1');

/** Index of the `(` matching the `)` at `close`, or -1. */
function openParen(t: string, close: number): number {
  for (let i = close, d = 0; i >= 0; i--) {
    if (t[i] === ')') d++;
    else if (t[i] === '(' && --d === 0) return i;
  }
  return -1;
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function closeParen(t: string, open: number): number {
  for (let i = open, d = 0; i < t.length; i++) {
    if (t[i] === '(') d++;
    else if (t[i] === ')' && --d === 0) return i;
  }
  return -1;
}

/** What a `{` opens, judged by the statement text before it. */
function classifyBlock(before: string, pending: boolean): { kind: Frame['kind']; test?: string } {
  const t = before.trim();
  const m = TEST_OPEN.exec(t);
  if (m) return { kind: 'test', test: unescapeName(m[2]) };
  if (pending && t === '') return { kind: 'cond' };
  if (/(?:^|[^\w$.])(?:else|try|finally|do)$/.test(t) || t.endsWith('=>')) return { kind: 'cond' };
  if (t.endsWith(')')) {
    const head = t.slice(0, openParen(t, t.length - 1)).trimEnd();
    if (/(?:^|[^\w$.])(?:if|for|while|switch|catch|with|function\s*\*?\s*[\w$]*)$/.test(head) || /(?:^|[^\w$.])function$/.test(head)) return { kind: 'cond' };
  }
  return { kind: 'object' };
}

/** `a && pm.expect(..)`, `a || ..`, `a ? .. : ..` (outside parentheses and strings). */
function shortCircuit(t: string): boolean {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (t.startsWith('&&', i) || t.startsWith('||', i) || (c === '?' && t[i + 1] !== '.'))) return true;
  }
  return false;
}

/**
 * A test script as a list of statements, split on `;` and line ends outside strings, comments and
 * brackets. `pm.test(...)` callbacks are unwrapped (also one-liners such as
 * `pm.test("ok", () => pm.response.to.have.status(200));`); statements inside if/else, loops,
 * switch, try/catch or any other callback (`forEach(x => {...})`) are marked conditional, as are
 * the bodies of braceless `if (x) pm.expect(...)`.
 */
function postmanStatements(code: string): Statement[] {
  const out: Statement[] = [];
  const stack: Frame[] = [{ kind: 'top', cond: false, buf: '', paren: 0, pending: false }];
  let f = stack[0];

  const emit = (fr: Frame, raw: string) => {
    const t = raw.trim();
    if (!t || fr.kind === 'object') return;
    const pending = fr.pending;
    fr.pending = false;
    // Test wrappers and blocks were split up already; what is left of them is not a check.
    if (t.includes(BLOCK)) return;
    const cond = fr.cond || pending;
    let m: RegExpExecArray | null;
    // Braceless control flow: what follows the header (here or on the next line) is conditional.
    if ((m = /^(?:else\s+)?(?:if|for|while)\s*\(/.exec(t))) {
      const rest = t.slice(closeParen(t, m[0].length - 1) + 1).trim();
      if (!rest || closeParen(t, m[0].length - 1) < 0) fr.pending = true;
      else out.push({ text: rest, test: fr.test, conditional: true });
      return;
    }
    if ((m = /^(?:else|do)\b\s*([\s\S]*)$/.exec(t))) {
      if (!m[1]) fr.pending = true;
      else out.push({ text: m[1], test: fr.test, conditional: true });
      return;
    }
    if ((m = TEST_EXPR.exec(t))) {
      const inner = m[3].trim();
      out.push({ text: inner, test: unescapeName(m[2]), conditional: cond || shortCircuit(inner) });
      return;
    }
    out.push({ text: t, test: fr.test, conditional: cond || shortCircuit(t) });
  };

  const lastSignificant = (s: string) => s.trimEnd().slice(-1);
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    // Strings: copied as they are (only template literals may span lines).
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && (c === '`' || code[j] !== '\n')) j += code[j] === '\\' ? 2 : 1;
      f.buf += code.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i + 1 < code.length && code[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 1;
      f.buf += ' ';
      continue;
    }
    // A regex literal (after an operator or opening bracket): copied as is, so `{` in it is not a block.
    if (c === '/' && /^$|[(,=:[!&|?{};]$/.test(lastSignificant(f.buf))) {
      let j = i + 1;
      let cls = false;
      while (j < code.length && code[j] !== '\n' && (cls || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') cls = true;
        else if (code[j] === ']') cls = false;
        j++;
      }
      if (code[j] === '/') {
        f.buf += code.slice(i, j + 1);
        i = j;
        continue;
      }
    }
    if (c === '(' || c === '[') f.paren++;
    else if (c === ')' || c === ']') f.paren--;
    if (c === '{') {
      const { kind, test } = classifyBlock(f.buf, f.pending);
      if (kind !== 'object') f.pending = false;
      f = { kind, test: test ?? f.test, cond: f.cond || kind === 'cond', buf: '', paren: 0, pending: false };
      stack.push(f);
      continue;
    }
    if (c === '}') {
      if (stack.length === 1) continue; // unbalanced: ignore
      emit(f, f.buf);
      const done = stack.pop()!;
      f = stack[stack.length - 1];
      f.buf += done.kind === 'object' ? OBJECT : BLOCK;
      continue;
    }
    if (c === ';' && f.paren <= 0) {
      emit(f, f.buf);
      f.buf = '';
      continue;
    }
    if ((c === '\n' || c === '\r') && f.paren <= 0) {
      // A line starting with `.` continues the previous one (`pm.expect(x)\n  .to.eql(1)`).
      let j = i + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === '.' || /(?:&&|\|\||[,+=?:])$/.test(f.buf.trimEnd())) {
        i = j - 1;
        continue;
      }
      emit(f, f.buf);
      f.buf = '';
      continue;
    }
    f.buf += c === '\n' || c === '\r' ? ' ' : c;
  }
  while (stack.length) {
    const fr = stack.pop()!;
    emit(fr, fr.buf);
  }
  return out;
}

/**
 * Convert the common Postman test snippets (the ones Postman's own "Snippets" sidebar inserts)
 * into @assert lines. Anything else in the script is counted as skipped. A check that only runs
 * under a condition or in a loop (`if (pm.response.code === 200) { pm.expect(...) }`) is never
 * converted, because an @assert always runs; it is reported per test instead.
 */
export function convertPostmanTests(code: string): ConvertedTests {
  const out: ConvertedTests = { asserts: [], skipped: [] };
  const jsonVars = new Set<string>();
  for (const m of code.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*pm\.response\.json\(\)/g)) jsonVars.add(m[1]);
  let unhandled = 0;
  const conditional = new Map<string, number>();
  for (const st of postmanStatements(code)) {
    const line = st.text;
    if (/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*pm\.response\.json\(\)$/.test(line)) continue;
    if (st.conditional) {
      if (CHECK.test(line)) conditional.set(st.test ?? '', (conditional.get(st.test ?? '') ?? 0) + 1);
      else unhandled++;
      continue;
    }
    let m: RegExpExecArray | null;
    const push = (a: string) => out.asserts.push(a);
    if ((m = /^pm\.response\.to\.have\.status\((\d{3})\)$/.exec(line))) push(`status == ${m[1]}`);
    else if ((m = /^pm\.response\.to\.have\.status\((['"])(.*)\1\)$/.exec(line))) {
      out.skipped.push(`status text check "${m[2]}"`);
    } else if ((m = /^pm\.expect\(pm\.response\.code\)\.to\.(?:eql|equal|be\.equal|eq)\((\d{3})\)$/.exec(line))) push(`status == ${m[1]}`);
    else if ((m = /^pm\.expect\(pm\.response\.code\)\.to\.be\.oneOf\(\[([\d,\s]+)\]\)$/.exec(line))) {
      push(`status matches /^(${m[1].split(',').map((x) => x.trim()).join('|')})$/`);
    } else if ((m = /^pm\.expect\(\[([\d,\s]+)\]\)\.to\.(?:include|contain)\(pm\.response\.code\)$/.exec(line))) {
      push(`status matches /^(${m[1].split(',').map((x) => x.trim()).join('|')})$/`);
    } else if ((m = /^pm\.expect\(pm\.response\.responseTime\)\.to\.be\.(below|lessThan|above|greaterThan)\((\d+)\)$/.exec(line))) {
      push(`time ${/below|less/i.test(m[1]) ? '<' : '>'} ${m[2]}`);
    } else if ((m = /^pm\.response\.to\.have\.header\((['"])([^'"]+)\1\)$/.exec(line))) push(`header ${m[2]} exists`);
    else if ((m = /^pm\.response\.to\.have\.header\((['"])([^'"]+)\1,\s*(.+)\)$/.exec(line)) && jsLiteral(m[3])) push(`header ${m[2]} == ${jsLiteral(m[3])}`);
    else if ((m = /^pm\.expect\(pm\.response\.headers\.get\((['"])([^'"]+)\1\)\)\.to\.(include|contain|eql|equal)\((.+)\)$/.exec(line)) && jsLiteral(m[4])) {
      push(`header ${m[2]} ${/include|contain/.test(m[3]) ? 'contains' : '=='} ${jsLiteral(m[4])}`);
    } else if ((m = /^pm\.expect\(pm\.response\.text\(\)\)\.to\.(not\.)?(?:include|contain)\((.+)\)$/.exec(line)) && jsLiteral(m[2])) {
      push(`body ${m[1] ? '!contains' : 'contains'} ${jsLiteral(m[2])}`);
    }
    else if ((m = /^pm\.response\.to\.have\.body\((.+)\)$/.exec(line)) && jsLiteral(m[1])) push(`body == ${jsLiteral(m[1])}`);
    else if (/^pm\.response\.to\.be\.(ok|success)$/.test(line)) push('status < 300');
    else if (/^pm\.response\.to\.be\.json$/.test(line) || /^pm\.response\.to\.have\.jsonBody\(\)$/.test(line)) push('body isJson');
    else if ((m = /^pm\.expect\((.+?)\)\.to\.(?:eql|equal|eq|be\.equal)\((.+)\)$/.exec(line)) && jsJsonPath(m[1], jsonVars) && jsLiteral(m[2])) {
      push(`${jsJsonPath(m[1], jsonVars)} == ${jsLiteral(m[2])}`);
    } else if ((m = /^pm\.expect\((.+?)\)\.to\.(?:include|contain)\((.+)\)$/.exec(line)) && jsJsonPath(m[1], jsonVars) && jsLiteral(m[2])) {
      push(`${jsJsonPath(m[1], jsonVars)} contains ${jsLiteral(m[2])}`);
    } else if ((m = /^pm\.expect\((.+?)\)\.to\.(?:exist|not\.be\.undefined)$/.exec(line)) && jsJsonPath(m[1], jsonVars)) {
      push(`${jsJsonPath(m[1], jsonVars)} exists`);
    } else if ((m = /^pm\.expect\((.+?)\)\.to\.be\.an?\((['"])(number|string|boolean|array|object|null)\2\)$/.exec(line)) && jsJsonPath(m[1], jsonVars)) {
      push(`${jsJsonPath(m[1], jsonVars)} ${THUNDER_TYPES[m[3]]}`);
    } else if ((m = /^pm\.expect\((.+?)\)\.to\.(?:have\.lengthOf|have\.length)\((\d+)\)$/.exec(line)) && jsJsonPath(m[1], jsonVars)) {
      push(`${jsJsonPath(m[1], jsonVars)}.length == ${m[2]}`);
    } else if ((m = /^pm\.expect\((.+?)\)\.to\.be\.(above|greaterThan|below|lessThan|at\.least|at\.most)\((-?\d+(?:\.\d+)?)\)$/.exec(line)) && jsJsonPath(m[1], jsonVars)) {
      const op = { above: '>', greaterThan: '>', below: '<', lessThan: '<', 'at.least': '>=', 'at.most': '<=' }[m[2]];
      push(`${jsJsonPath(m[1], jsonVars)} ${op} ${m[3]}`);
    } else unhandled++;
  }
  // One entry for all conditional checks: the total, then where they are (`3 in 'Body ok'`).
  if (conditional.size) {
    const total = [...conditional.values()].reduce((a, b) => a + b, 0);
    const where = [...conditional].map(([name, n]) => (name ? `${n} in '${name}'` : `${n} outside any pm.test`));
    out.skipped.push(`${total} ${total === 1 ? 'check' : 'checks'} inside if/loop/callback/try (${where.join(', ')})`);
    out.conditional = total;
  }
  if (unhandled) out.skipped.push(`${unhandled} other script statement(s)`);
  return out;
}
