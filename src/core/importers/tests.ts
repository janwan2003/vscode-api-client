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
    out.asserts.push(`${subject} ${op} ${op === 'matches' && !/^\/.*\/[a-z]*$/.test(value) ? `/${value}/` : value}`);
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

/**
 * Convert the common Postman test snippets (the ones Postman's own "Snippets" sidebar inserts)
 * into @assert lines. Anything else in the script is counted as skipped.
 */
export function convertPostmanTests(code: string): ConvertedTests {
  const out: ConvertedTests = { asserts: [], skipped: [] };
  const jsonVars = new Set<string>();
  for (const m of code.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*pm\.response\.json\(\)/g)) jsonVars.add(m[1]);
  let unhandled = 0;
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim().replace(/;$/, '');
    if (!line || line.startsWith('//') || /^pm\.test\(.*function\s*\(\)\s*\{$|^pm\.test\(.*=>\s*\{$/.test(line) || /^\}\)?\)?$/.test(line)) continue;
    if (/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*pm\.response\.json\(\)$/.test(line)) continue;
    let m: RegExpExecArray | null;
    const push = (a: string) => out.asserts.push(a);
    if ((m = /^pm\.response\.to\.have\.status\((\d{3})\)$/.exec(line))) push(`status == ${m[1]}`);
    else if ((m = /^pm\.response\.to\.have\.status\((['"])(.*)\1\)$/.exec(line))) {
      out.skipped.push(`status text check "${m[2]}"`);
    } else if ((m = /^pm\.expect\(pm\.response\.code\)\.to\.(?:eql|equal|be\.equal|eq)\((\d{3})\)$/.exec(line))) push(`status == ${m[1]}`);
    else if ((m = /^pm\.expect\(pm\.response\.code\)\.to\.be\.oneOf\(\[([\d,\s]+)\]\)$/.exec(line))) {
      push(`status matches /^(${m[1].split(',').map((x) => x.trim()).join('|')})$/`);
    } else if ((m = /^pm\.expect\(pm\.response\.responseTime\)\.to\.be\.(below|lessThan|above|greaterThan)\((\d+)\)$/.exec(line))) {
      push(`time ${/below|less/i.test(m[1]) ? '<' : '>'} ${m[2]}`);
    } else if ((m = /^pm\.response\.to\.have\.header\((['"])([^'"]+)\1\)$/.exec(line))) push(`header ${m[2]} exists`);
    else if ((m = /^pm\.response\.to\.have\.header\((['"])([^'"]+)\1,\s*(.+)\)$/.exec(line)) && jsLiteral(m[3])) push(`header ${m[2]} == ${jsLiteral(m[3])}`);
    else if ((m = /^pm\.expect\(pm\.response\.headers\.get\((['"])([^'"]+)\1\)\)\.to\.(include|contain|eql|equal)\((.+)\)$/.exec(line)) && jsLiteral(m[4])) {
      push(`header ${m[2]} ${/include|contain/.test(m[3]) ? 'contains' : '=='} ${jsLiteral(m[4])}`);
    } else if ((m = /^pm\.expect\(pm\.response\.text\(\)\)\.to\.(include|contain)\((.+)\)$/.exec(line)) && jsLiteral(m[2])) push(`body contains ${jsLiteral(m[2])}`);
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
    } else unhandled++;
  }
  if (unhandled) out.skipped.push(`${unhandled} script line(s)`);
  return out;
}
