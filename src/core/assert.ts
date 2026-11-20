import { createHash } from 'node:crypto';
import type { HttpResponse } from './model.ts';
import { jsonPath } from './variables.ts';

/**
 * Response assertions, written in `.http` files as metadata comments:
 *
 *   # @assert status == 200
 *   # @assert time < 500
 *   # @assert header content-type contains json
 *   # @assert $.items.length > 0
 *   # @assert $.user.email matches /@example\.com$/
 *   # @assert $.id exists
 *   # @assert body contains "ok"
 *
 * Grammar: `<subject> <operator> [expected]`. Subjects: status, time (ms), size (bytes), body,
 * header <name>, and a JSONPath into the JSON body (`$.a.b[0]`, also written `body.$.a`).
 * The expected value is read as JSON when it parses (numbers, true/false/null, "quoted strings",
 * arrays/objects), otherwise as a plain string. Comparisons are loose: `"200" == 200` passes.
 *
 * httpYac test lines (`?? status == 200`, written after the request) are accepted too; see
 * parseHttpYacAssertion for the forms that are translated and the ones reported as unsupported.
 */

export const OPERATORS = [
  '==', '!=', '<', '<=', '>', '>=',
  'contains', '!contains', 'startsWith', 'endsWith', 'matches', '!matches',
  'exists', '!exists', 'isEmpty', '!isEmpty',
  'isNumber', 'isString', 'isBoolean', 'isArray', 'isObject', 'isNull', 'isJson', 'isTrue', 'isFalse',
  'md5', 'sha256', 'sha512',
] as const;
export type Operator = (typeof OPERATORS)[number];

const UNARY = new Set<Operator>(['exists', '!exists', 'isEmpty', '!isEmpty', 'isNumber', 'isString', 'isBoolean', 'isArray', 'isObject', 'isNull', 'isJson', 'isTrue', 'isFalse']);
const OP_LOOKUP = new Map<string, Operator>(OPERATORS.map((o) => [o.toLowerCase(), o]));
// Friendly aliases (and the spellings other tools use).
for (const [alias, op] of [
  ['=', '=='], ['===', '=='], ['eq', '=='], ['equals', '=='], ['!==', '!='], ['ne', '!='], ['<>', '!='],
  ['lt', '<'], ['lte', '<='], ['gt', '>'], ['gte', '>='],
  ['notcontains', '!contains'], ['includes', 'contains'], ['startswith', 'startsWith'], ['endswith', 'endsWith'],
  ['notmatches', '!matches'], ['notexists', '!exists'], ['notempty', '!isEmpty'], ['empty', 'isEmpty'],
] as const) OP_LOOKUP.set(alias, op);

export type Subject =
  | { kind: 'status' | 'time' | 'size' | 'body' }
  | { kind: 'header'; name: string }
  | { kind: 'json'; path: string };

export interface Assertion {
  source: string;
  subject: Subject;
  op: Operator;
  /** Raw expected text (undefined for unary operators). */
  expected?: string;
}

export interface AssertionResult {
  source: string;
  passed: boolean;
  /** What the subject evaluated to, shortened for display. */
  actual?: string;
  /** Why it failed (or a short confirmation when it passed). */
  message: string;
}

/** An httpYac test line (`?? status == 200`). Kept verbatim, `??` included, in `HttpRequest.asserts`. */
export function isHttpYacAssert(line: string): boolean {
  return /^\s*\?\?(?=\s|$)/.test(line);
}

/** Parse one assertion. Throws with a readable message on syntax errors. */
export function parseAssertion(source: string): Assertion {
  if (isHttpYacAssert(source)) return parseHttpYacAssertion(source);
  return parseCore(source.trim(), source);
}

/**
 * httpYac `?? <subject> <predicate> [expected]` lines, translated to the subjects above:
 *
 *   ?? status == 200                       ?? duration < 500             (duration = time)
 *   ?? header content-type includes json   ?? body includes "ok"         ?? body $.id exists
 *   ?? js response.parsedBody.items.length > 0      ?? js response.statusCode == 200
 *   ?? js response.body.user.name == "Ada"          ?? js response.headers['x-id'] exists
 *
 * `?? js` is never evaluated: only a plain property path on `response.parsedBody` / `response.body`
 * (→ JSONPath; `response.body` alone → the body text), `response.statusCode` and
 * `response.headers.name` / `['name']` are translated. Anything else (other JavaScript, `xpath`,
 * unknown subjects or predicates) throws "unsupported httpYac assertion", which runAssertions
 * reports as a failed check: a check that cannot run must never pass silently.
 */
export function parseHttpYacAssertion(source: string): Assertion {
  const line = source.trim().replace(/^\?\?\s*/, '');
  const unsupported = (why: string): never => {
    throw new Error(`unsupported httpYac assertion "${source.trim()}": ${why}`);
  };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(line);
  if (!m) return unsupported('nothing to check');
  const kind = m[1].toLowerCase();
  let rest = m[2];
  let subject: string;
  if (kind === 'status' || kind === 'duration' || kind === 'body') {
    subject = kind;
    // `?? body $.path ...` → JSONPath into the body.
    const jp = kind === 'body' ? /^(\$(?:\.[^\s.[\]]+|\[\s*(?:-?\d+|'[^']*'|"[^"]*")\s*\])*)(?=\s|$)\s*/.exec(rest) : null;
    if (jp) {
      subject = jp[1];
      rest = rest.slice(jp[0].length);
    }
  } else if (kind === 'header') {
    const h = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?=\s|$)\s*/.exec(rest);
    if (!h) return unsupported('expected a header name after "header"');
    subject = `header ${h[1]}`;
    rest = rest.slice(h[0].length);
  } else if (kind === 'js') {
    const expr = leadingExpression(rest);
    const translated = jsSubject(expr);
    if (!translated) {
      return unsupported(
        `"${expr || '(empty)'}" is not translated (JavaScript is never evaluated); use response.parsedBody.<path>, ` +
          `response.body.<path>, response.statusCode or response.headers['name'], or rewrite it as # @assert`,
      );
    }
    subject = translated;
    rest = rest.slice(expr.length);
  } else if (kind === 'xpath') {
    return unsupported('xpath is not supported; use body contains / matches, or # @assert');
  } else {
    return unsupported(`unknown subject "${m[1]}"; use status, duration, header <name>, body or js <expression>`);
  }
  const text = `${subject} ${rest.trim()}`.trim();
  try {
    return parseCore(text, source);
  } catch (e) {
    return unsupported((e as Error).message.replace(` in "${source}"`, ''));
  }
}

/** The expression after `?? js`: up to the first whitespace outside brackets and quotes. */
function leadingExpression(text: string): string {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (/\s/.test(c) && depth <= 0) return text.slice(0, i);
  }
  return text;
}

/** `response.parsedBody.a[0]['b c']` → `$.a[0]['b c']`; status code and header lookups; else undefined. */
function jsSubject(expr: string): string | undefined {
  if (expr === 'response.statusCode') return 'status';
  let m = /^response\.headers(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([A-Za-z0-9!#$%&*+.^_`|~-]+)\2\s*\])$/.exec(expr);
  if (m) return `header ${m[1] ?? m[3]}`;
  m = /^response\.(parsedBody|body)((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[\s*(['"])[^'"]*\3\s*\])*)$/.exec(expr);
  if (!m) return undefined;
  if (!m[2]) return m[1] === 'parsedBody' ? '$' : 'body';
  return '$' + m[2].replace(/\[\s*(['"])([^'"]*)\1\s*\]/g, "['$2']");
}

function parseCore(text: string, source: string): Assertion {
  let rest = text;
  let subject: Subject;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length).trim();
    return m;
  };
  let m: RegExpExecArray | null;
  if ((m = take(/^(?:res(?:ponse)?\.)?(status|time|duration|size|body)(?=\s|$)/i))) {
    const k = m[1].toLowerCase();
    subject = { kind: k === 'duration' ? 'time' : (k as 'status' | 'time' | 'size' | 'body') };
  } else if ((m = take(/^(?:res(?:ponse)?\.)?headers?(?:\.|\s+)([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?=\s|$)/i))) {
    subject = { kind: 'header', name: m[1] };
  } else if ((m = take(/^(?:(?:res(?:ponse)?\.)?body\.)?(\$(?:\.[^\s.[\]]+|\[\s*(?:-?\d+|'[^']*'|"[^"]*")\s*\])*)(?=\s|$)/))) {
    subject = { kind: 'json', path: m[1] };
  } else {
    throw new Error(`Unknown assertion subject in "${source}". Use status, time, size, body, header <name> or a JSONPath like $.id`);
  }
  const opm = take(/^(!?\s*[A-Za-z][A-Za-z0-9]*|[=!<>]=?=?|<>)(?=\s|$)/);
  if (!opm) throw new Error(`Missing operator in "${source}". Use one of: ${OPERATORS.join(' ')}`);
  let opText = opm[1].replace(/\s+/g, '').toLowerCase();
  if (opText === 'not' || opText === '!') {
    const next = take(/^([A-Za-z]+)(?=\s|$)/);
    opText = '!' + (next?.[1].toLowerCase() ?? '');
  }
  const op = OP_LOOKUP.get(opText) ?? OP_LOOKUP.get(opText.replace(/^!/, 'not'));
  if (!op) throw new Error(`Unknown operator "${opm[1]}" in "${source}". Use one of: ${OPERATORS.join(' ')}`);
  if (UNARY.has(op)) {
    if (rest) throw new Error(`"${op}" takes no value in "${source}"`);
    return { source, subject, op };
  }
  if (!rest) throw new Error(`Missing expected value after "${op}" in "${source}"`);
  return { source, subject, op, expected: rest };
}

function parseExpected(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headerValue(res: HttpResponse, name: string): string | undefined {
  const vals = res.headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
  return vals.length ? vals.join(', ') : undefined;
}

function bodyText(res: HttpResponse): string {
  return res.bodyEncoding === 'base64' ? Buffer.from(res.body, 'base64').toString('latin1') : res.body;
}

function parseJsonBody(res: HttpResponse): { ok: true; value: unknown } | { ok: false } {
  if (res.bodyEncoding !== 'utf8') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(res.body) };
  } catch {
    return { ok: false };
  }
}

function show(v: unknown): string {
  const s = v === undefined ? 'undefined' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

/** Digest of the subject: the body's bytes for `body`, else the text of the value. */
function digest(algo: 'md5' | 'sha256' | 'sha512', a: Assertion, res: HttpResponse, actual: unknown): { base64: string; hex: string } {
  const data = a.subject.kind === 'body' ? Buffer.from(res.body, res.bodyEncoding === 'base64' ? 'base64' : 'utf8') : Buffer.from(asText(actual), 'utf8');
  const h = createHash(algo).update(data).digest();
  return { base64: h.toString('base64'), hex: h.toString('hex') };
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' && typeof b !== 'object') {
    if (typeof a === 'number' || typeof b === 'number') {
      const na = Number(a), nb = Number(b);
      if (String(a).trim() !== '' && String(b).trim() !== '' && !Number.isNaN(na) && na === nb) return true;
    }
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function toRegex(expected: unknown): RegExp {
  const s = String(expected);
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s);
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Evaluate a parsed assertion against a response. */
export function evaluateAssertion(a: Assertion, res: HttpResponse): AssertionResult {
  let actual: unknown;
  let found = true;
  switch (a.subject.kind) {
    case 'status':
      actual = res.status;
      break;
    case 'time':
      actual = res.timeMs;
      break;
    case 'size':
      actual = res.size;
      break;
    case 'body':
      actual = bodyText(res);
      break;
    case 'header':
      actual = headerValue(res, a.subject.name);
      found = actual !== undefined;
      break;
    case 'json': {
      const parsed = parseJsonBody(res);
      if (!parsed.ok) {
        if (a.op === '!exists') return { source: a.source, passed: true, message: 'body is not JSON, so the path does not exist' };
        return { source: a.source, passed: false, message: 'response body is not JSON' };
      }
      actual = jsonPath(parsed.value, a.subject.path);
      found = actual !== undefined;
      break;
    }
  }
  const expected = a.expected === undefined ? undefined : parseExpected(a.expected);
  const fail = (message: string): AssertionResult => ({ source: a.source, passed: false, actual: show(actual), message });
  const pass = (): AssertionResult => ({ source: a.source, passed: true, actual: show(actual), message: 'passed' });
  const check = (ok: boolean, message: string) => (ok ? pass() : fail(message));

  switch (a.op) {
    case 'exists':
      return check(found, 'does not exist');
    case '!exists':
      return check(!found, `exists (${show(actual)})`);
    case 'isEmpty':
      return check(isEmpty(actual), `expected empty, got ${show(actual)}`);
    case '!isEmpty':
      return check(!isEmpty(actual), 'is empty');
    case 'isNumber':
      return check(typeof actual === 'number', `expected a number, got ${show(actual)}`);
    case 'isString':
      return check(typeof actual === 'string', `expected a string, got ${show(actual)}`);
    case 'isBoolean':
      return check(typeof actual === 'boolean', `expected a boolean, got ${show(actual)}`);
    case 'isArray':
      return check(Array.isArray(actual), `expected an array, got ${show(actual)}`);
    case 'isObject':
      return check(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `expected an object, got ${show(actual)}`);
    case 'isNull':
      return check(actual === null, `expected null, got ${show(actual)}`);
    case 'isTrue':
      return check(actual === true || actual === 'true', `expected true, got ${show(actual)}`);
    case 'isFalse':
      return check(actual === false || actual === 'false', `expected false, got ${show(actual)}`);
    case 'isJson': {
      if (typeof actual !== 'string') return check(found, 'does not exist');
      try {
        JSON.parse(actual);
        return pass();
      } catch {
        return fail('is not valid JSON');
      }
    }
  }
  if (!found) return fail('does not exist');
  switch (a.op) {
    case '==':
      return check(looseEqual(actual, expected), `expected ${show(expected)}, got ${show(actual)}`);
    case '!=':
      return check(!looseEqual(actual, expected), `expected anything but ${show(expected)}`);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const x = Number(actual), y = Number(expected);
      if (Number.isNaN(x) || Number.isNaN(y) || actual === null || actual === '') return fail(`cannot compare ${show(actual)} ${a.op} ${show(expected)} as numbers`);
      const ok = a.op === '<' ? x < y : a.op === '<=' ? x <= y : a.op === '>' ? x > y : x >= y;
      return check(ok, `expected ${a.op} ${show(expected)}, got ${show(actual)}`);
    }
    case 'contains':
    case '!contains': {
      const has = Array.isArray(actual) ? actual.some((v) => looseEqual(v, expected)) : asText(actual).includes(String(expected));
      return a.op === 'contains' ? check(has, `does not contain ${show(expected)}`) : check(!has, `contains ${show(expected)}`);
    }
    case 'startsWith':
      return check(asText(actual).startsWith(String(expected)), `does not start with ${show(expected)}`);
    case 'endsWith':
      return check(asText(actual).endsWith(String(expected)), `does not end with ${show(expected)}`);
    case 'matches':
    case '!matches': {
      let re: RegExp;
      try {
        re = toRegex(a.expected);
      } catch (e) {
        return fail(`invalid regular expression: ${(e as Error).message}`);
      }
      const hit = re.test(asText(actual));
      return a.op === 'matches' ? check(hit, `does not match ${re}`) : check(!hit, `matches ${re}`);
    }
    case 'md5':
    case 'sha256':
    case 'sha512': {
      // httpYac writes the expected digest in base64; hex is accepted too.
      const d = digest(a.op, a, res, actual);
      const want = String(a.expected).trim();
      return check(want === d.base64 || want.toLowerCase() === d.hex, `${a.op} is ${d.base64} (hex ${d.hex}), expected ${want}`);
    }
  }
  return fail(`unsupported operator ${a.op}`);
}

/**
 * Evaluate assertion lines against a response. `resolve` expands `{{variables}}` in each line
 * first; a line that fails to parse or resolve becomes a failed result (it never throws).
 */
export function runAssertions(lines: string[], res: HttpResponse, resolve: (s: string) => string = (s) => s): AssertionResult[] {
  return lines.map((line) => {
    try {
      return evaluateAssertion(parseAssertion(resolve(line)), res);
    } catch (e) {
      return { source: line, passed: false, message: (e as Error).message };
    }
  });
}
