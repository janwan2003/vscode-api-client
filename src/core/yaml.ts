/**
 * A small YAML reader, sized for OpenAPI / Swagger documents (no runtime dependencies).
 *
 * Supported: block mappings and sequences (including `- key: v` compact mappings and sequences
 * at the same indentation as their parent key), plain / single- / double-quoted scalars with
 * multi-line folding, block scalars (`|`, `>`, chomping `-`/`+`, indentation indicators), flow
 * collections, comments, `---` / `...` (only the first document is read), anchors, aliases,
 * the `<<` merge key, and the `!!str` tag (other tags are ignored). Plain scalars resolve with
 * the YAML 1.2 core schema (so `yes`/`no`/`on`/`off` and dates stay strings); mapping keys
 * are always strings, exactly as written (`200:` gives the key "200").
 *
 * Explicit `? key` entries work for scalar keys. Not supported: collections as mapping keys,
 * later documents (only the first is read), `%TAG` shorthands, tags other than `!!str`, and
 * many of the strict errors a conformance suite would demand (the reader is lenient).
 */

const FLOW_INDICATORS = ',[]{}';

/** Parse the first YAML document in `text` into plain JS values. Throws `Error` with a line number. */
export function parseYaml(text: string): unknown {
  return new Parser(text).document();
}

interface Props {
  anchor?: string;
  tag?: string;
}

class Parser {
  private readonly s: string;
  private pos = 0;
  /** Offsets where each line starts, for column and line-number lookups. */
  private readonly lineStarts: number[] = [0];
  private readonly anchors = new Map<string, unknown>();

  constructor(text: string) {
    this.s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    for (let i = this.s.indexOf('\n'); i >= 0; i = this.s.indexOf('\n', i + 1)) this.lineStarts.push(i + 1);
  }

  // ---- positions and errors ----------------------------------------------------------------

  private lineIndex(p: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private col(p = this.pos): number {
    return p - this.lineStarts[this.lineIndex(p)];
  }

  private fail(message: string, at = this.pos): never {
    throw new Error(`YAML parse error at line ${this.lineIndex(at) + 1}: ${message}`);
  }

  private describe(p = this.pos): string {
    if (p >= this.s.length) return 'end of input';
    const c = this.s[p];
    return c === '\n' ? 'end of line' : JSON.stringify(c);
  }

  // ---- low-level scanning ------------------------------------------------------------------

  private isWs(c: string | undefined): boolean {
    return c === ' ' || c === '\t';
  }

  /** True for whitespace, line break or end of input. */
  private isBreakOrWs(p: number): boolean {
    const c = this.s[p];
    return c === undefined || c === ' ' || c === '\t' || c === '\n';
  }

  private atLineEnd(): boolean {
    return this.pos >= this.s.length || this.s[this.pos] === '\n';
  }

  /** Skip spaces/tabs and a trailing comment on the current line; stop before the line break. */
  private skipInline(): void {
    const s = this.s;
    while (this.isWs(s[this.pos])) this.pos++;
    if (s[this.pos] === '#' && (this.pos === 0 || this.isBreakOrWs(this.pos - 1))) {
      const nl = s.indexOf('\n', this.pos);
      this.pos = nl < 0 ? s.length : nl;
    }
  }

  /** Skip whitespace, line breaks and comments. */
  private skipBlank(): void {
    for (;;) {
      this.skipInline();
      if (this.s[this.pos] !== '\n') return;
      this.pos++;
    }
  }

  private isDocMarker(p: number): boolean {
    const m = this.s.slice(p, p + 3);
    return (m === '---' || m === '...') && this.col(p) === 0 && this.isBreakOrWs(p + 3);
  }

  private isSeqEntry(p = this.pos): boolean {
    return this.s[p] === '-' && this.isBreakOrWs(p + 1);
  }

  /** In block context, indentation must be spaces only. */
  private checkIndent(): void {
    const start = this.lineStarts[this.lineIndex(this.pos)];
    if (this.s.slice(start, this.pos).includes('\t')) this.fail('tabs are not allowed for indentation');
  }

  /** After a block node: only a comment may follow on the same line. */
  private expectLineEnd(): void {
    this.skipInline();
    if (!this.atLineEnd()) this.fail(`unexpected ${this.describe()} after a value`);
  }

  // ---- documents and block structure -------------------------------------------------------

  document(): unknown {
    this.skipBlank();
    while (this.s[this.pos] === '%' && this.col() === 0) {
      const nl = this.s.indexOf('\n', this.pos);
      this.pos = nl < 0 ? this.s.length : nl;
      this.skipBlank();
    }
    let value: unknown = null;
    if (this.isDocMarker(this.pos) && this.s[this.pos] === '-') {
      this.pos += 3;
      this.skipInline();
      value = this.atLineEnd() ? this.nextLinesValue(-1, false) : this.node(-1, 'block');
    } else if (this.pos < this.s.length && !this.isDocMarker(this.pos)) {
      this.checkIndent();
      value = this.node(-1, 'block');
    }
    this.skipBlank();
    if (this.pos < this.s.length && !this.isDocMarker(this.pos)) {
      this.fail(`unexpected ${this.describe()} (bad indentation?)`);
    }
    return value;
  }

  /**
   * The value of a key or `- ` whose own line ended: content on following lines indented more
   * than `parent`, or (for mapping values) a sequence at the parent's indentation; else null.
   */
  private nextLinesValue(parent: number, seqAtParent: boolean): unknown {
    const save = this.pos;
    this.skipBlank();
    if (this.pos < this.s.length && !this.isDocMarker(this.pos)) {
      const c = this.col();
      if (c > parent || (seqAtParent && c === parent && this.isSeqEntry())) {
        this.checkIndent();
        return c > parent ? this.node(parent, 'block') : this.blockSeq(c);
      }
    }
    this.pos = save;
    return null;
  }

  /**
   * A node at the current position. `parent` is the indentation the node's lines must exceed.
   * In 'value' mode (after `key: ` on the same line) block collections cannot start here.
   */
  private node(parent: number, mode: 'block' | 'value'): unknown {
    const column = this.col(); // a mapping's indentation includes properties before its first key
    const props = this.props(false);
    if (props) {
      this.skipInline();
      if (this.atLineEnd()) {
        const value = this.nextLinesValue(parent, mode === 'value');
        return this.finish(value === null && isStrTag(props.tag) ? '' : value, props);
      }
    }
    const s = this.s;
    const c = s[this.pos];
    if (mode === 'block' && this.isSeqEntry()) return this.finish(this.blockSeq(this.col()), props);
    if (mode === 'block' && this.looksLikeKey()) return this.blockMap(column, props);
    if (c === '-' && this.isBreakOrWs(this.pos + 1)) this.fail('a sequence cannot start on the same line as its key');
    if (c === '|' || c === '>') return this.finish(this.blockScalar(parent), props);
    if (c === '[' || c === '{') return this.finish(this.flowCollection(), props);
    if (c === '*') return this.alias(props);
    return this.scalar(parent, false, props);
  }

  /** Register an anchor for a finished node. */
  private finish(value: unknown, props: Props | undefined): unknown {
    if (props?.anchor !== undefined) this.anchors.set(props.anchor, value);
    return value;
  }

  /** `&anchor` and `!tag` properties, in either order. */
  private props(flow: boolean): Props | undefined {
    let props: Props | undefined;
    for (;;) {
      const c = this.s[this.pos];
      if (c !== '&' && c !== '!') return props;
      const start = ++this.pos;
      while (!this.isBreakOrWs(this.pos) && !(flow && FLOW_INDICATORS.includes(this.s[this.pos]))) this.pos++;
      const name = this.s.slice(start, this.pos);
      props ??= {};
      if (c === '&') {
        if (!name) this.fail('anchor name expected after "&"');
        props.anchor = name;
      } else props.tag = name;
      if (flow) this.skipBlank();
      else while (this.isWs(this.s[this.pos])) this.pos++;
    }
  }

  private alias(props: Props | undefined): unknown {
    const start = ++this.pos;
    while (!this.isBreakOrWs(this.pos) && !FLOW_INDICATORS.includes(this.s[this.pos])) this.pos++;
    const name = this.s.slice(start, this.pos);
    if (!this.anchors.has(name)) this.fail(`unknown alias "*${name}"`, start);
    return this.finish(this.anchors.get(name), props);
  }

  /** Does the current line start a block mapping entry (`key:` followed by space or line end)? */
  private looksLikeKey(): boolean {
    const s = this.s;
    let p = this.pos;
    const c = s[p];
    if (c === '?' && this.isBreakOrWs(p + 1)) return true;
    if (c === '"' || c === "'") {
      for (p++; p < s.length && s[p] !== '\n'; p++) {
        if (c === '"' && s[p] === '\\') p++;
        else if (s[p] === c) {
          if (c === "'" && s[p + 1] === "'") p++;
          else break;
        }
      }
      if (s[p] !== c) return false;
      p++;
      while (this.isWs(s[p])) p++;
      return s[p] === ':' && this.isBreakOrWs(p + 1);
    }
    if (c === '[' || c === '{' || c === '|' || c === '>' || c === '#') return false;
    for (; p < s.length && s[p] !== '\n'; p++) {
      if (s[p] === ':' && this.isBreakOrWs(p + 1)) return true;
      if (s[p] === '#' && this.isWs(s[p - 1])) return false;
    }
    return false;
  }

  private blockMap(indent: number, firstProps: Props | undefined): unknown {
    const entries: [string, unknown][] = [];
    const merges: unknown[] = [];
    let keyProps = firstProps;
    for (;;) {
      if (keyProps === undefined) keyProps = this.props(false);
      const keyStart = this.pos;
      const c = this.s[this.pos];
      let key: string;
      let value: unknown;
      let isMerge = false;
      if (c === '?' && this.isBreakOrWs(this.pos + 1)) [key, value] = this.explicitEntry(indent);
      else {
        if (c === '[' || c === '{') this.fail('collections as mapping keys are not supported');
        if (c === '*') key = String(this.alias(undefined));
        else if (c === '"' || c === "'") key = this.quoted();
        else {
          key = this.plainLine(false);
          isMerge = key === '<<';
        }
        while (this.isWs(this.s[this.pos])) this.pos++;
        if (this.s[this.pos] !== ':' || !this.isBreakOrWs(this.pos + 1)) {
          this.fail(`expected ":" after mapping key ${JSON.stringify(key)}, found ${this.describe()}`, keyStart);
        }
        this.pos++;
        this.skipInline();
        value = this.atLineEnd() ? this.nextLinesValue(indent, true) : this.node(indent, 'value');
      }
      this.finish(key, keyProps);
      keyProps = undefined;
      if (isMerge) merges.push(value);
      else entries.push([key, value]);
      this.expectLineEnd();
      const save = this.pos;
      this.skipBlank();
      if (this.pos >= this.s.length || this.isDocMarker(this.pos) || this.col() < indent) {
        this.pos = save;
        break;
      }
      if (this.col() > indent) this.fail('bad indentation of a mapping entry');
      this.checkIndent();
      if (this.isSeqEntry()) {
        this.pos = save;
        break;
      }
    }
    return buildMap(entries, merges, (m) => this.fail(m));
  }

  /**
   * `? key` (emitters write it for keys over 128 characters) and an optional `: value` line at
   * the same indentation. Only scalar keys are supported.
   */
  private explicitEntry(indent: number): [string, unknown] {
    const at = this.pos++;
    this.skipInline();
    const key = this.atLineEnd() ? this.nextLinesValue(indent, false) : this.node(indent, 'block');
    if (key !== null && typeof key === 'object') this.fail('collections as mapping keys are not supported', at);
    this.expectLineEnd();
    const save = this.pos;
    this.skipBlank();
    if (this.col() === indent && this.s[this.pos] === ':' && this.isBreakOrWs(this.pos + 1)) {
      this.pos++;
      this.skipInline();
      return [String(key ?? ''), this.atLineEnd() ? this.nextLinesValue(indent, true) : this.node(indent, 'block')];
    }
    this.pos = save;
    return [String(key ?? ''), null];
  }

  private blockSeq(indent: number): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      this.pos++; // the '-'
      this.skipInline();
      items.push(this.atLineEnd() ? this.nextLinesValue(indent, false) : this.node(indent, 'block'));
      this.expectLineEnd();
      const save = this.pos;
      this.skipBlank();
      const c = this.pos < this.s.length && !this.isDocMarker(this.pos) ? this.col() : -1;
      if (c < indent || (c === indent && !this.isSeqEntry())) {
        this.pos = save;
        return items;
      }
      if (c > indent) this.fail('bad indentation of a sequence entry');
      this.checkIndent();
    }
  }

  // ---- scalars -----------------------------------------------------------------------------

  private scalar(parent: number, flow: boolean, props: Props | undefined): unknown {
    const c = this.s[this.pos];
    let value: unknown;
    if (c === '"' || c === "'") value = this.quoted();
    else {
      const raw = this.plain(parent, flow);
      value = isStrTag(props?.tag) ? raw : resolvePlain(raw);
    }
    return this.finish(value, props);
  }

  /** Scan one line's worth of plain scalar; returns its end (before trailing spaces). */
  private plainEnd(flow: boolean): number {
    const s = this.s;
    let p = this.pos;
    let end = p;
    for (; p < s.length; p++) {
      const c = s[p];
      if (c === '\n') break;
      if (c === ':' && (this.isBreakOrWs(p + 1) || (flow && FLOW_INDICATORS.includes(s[p + 1])))) break;
      if (c === '#' && this.isWs(s[p - 1])) break;
      if (flow && FLOW_INDICATORS.includes(c)) break;
      if (c !== ' ' && c !== '\t') end = p + 1;
    }
    return end;
  }

  /** A single-line plain scalar (used for block mapping keys). */
  private plainLine(flow: boolean): string {
    const start = this.pos;
    const end = this.plainEnd(flow);
    if (end === start) this.fail(`unexpected ${this.describe()}`);
    this.pos = end;
    return this.s.slice(start, end);
  }

  /** A plain scalar, folding continuation lines indented more than `parent`. */
  private plain(parent: number, flow: boolean): string {
    const s = this.s;
    let out = this.plainLine(flow);
    for (;;) {
      let p = this.pos;
      while (this.isWs(s[p])) p++;
      if (s[p] !== '\n') break;
      let breaks = 0;
      while (s[p] === '\n') {
        breaks++;
        p++;
        while (this.isWs(s[p])) p++;
      }
      if (p >= s.length || s[p] === '#' || this.isDocMarker(p) || (!flow && this.col(p) <= parent)) break;
      const save = this.pos;
      this.pos = p;
      const end = this.plainEnd(flow);
      if (end === p) {
        this.pos = save;
        break;
      }
      out += (breaks === 1 ? ' ' : '\n'.repeat(breaks - 1)) + s.slice(p, end);
      this.pos = end;
    }
    return out;
  }

  /** A single- or double-quoted scalar, with escapes and line folding. */
  private quoted(): string {
    const s = this.s;
    const q = s[this.pos];
    const start = this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= s.length) this.fail('unterminated quoted string', start);
      const c = s[this.pos];
      if (c === q) {
        if (q === "'" && s[this.pos + 1] === "'") {
          out += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        return out;
      }
      if (c === ' ' || c === '\t') {
        let p = this.pos;
        while (this.isWs(s[p])) p++;
        if (s[p] !== '\n') out += s.slice(this.pos, p);
        this.pos = p;
      } else if (c === '\n') {
        out += this.foldBreaks(false);
      } else if (c === '\\' && q === '"') {
        out += this.escape();
      } else {
        out += c;
        this.pos++;
      }
    }
  }

  /** At a line break inside a quoted scalar: consume breaks and indentation, return the fold. */
  private foldBreaks(escaped: boolean): string {
    let breaks = 0;
    while (this.s[this.pos] === '\n') {
      breaks++;
      this.pos++;
      while (this.isWs(this.s[this.pos])) this.pos++;
    }
    if (escaped) return '\n'.repeat(breaks - 1);
    return breaks === 1 ? ' ' : '\n'.repeat(breaks - 1);
  }

  private escape(): string {
    const at = this.pos;
    const c = this.s[this.pos + 1];
    this.pos += 2;
    const simple = ESCAPES[c];
    if (simple !== undefined) return simple;
    if (c === '\n') {
      this.pos--;
      return this.foldBreaks(true);
    }
    const len = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0;
    const hex = this.s.slice(this.pos, this.pos + len);
    if (!len || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.fail(`invalid escape "\\${c ?? ''}"`, at);
    this.pos += len;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff) this.fail(`invalid escape "\\${c}${hex}"`, at);
    return String.fromCodePoint(code);
  }

  /** `|` or `>` block scalar; `parent` is the indentation of the owning node. */
  private blockScalar(parent: number): string {
    const s = this.s;
    const folded = s[this.pos++] === '>';
    let chomp = '';
    let explicit = 0;
    for (let i = 0; i < 2; i++) {
      const c = s[this.pos];
      if ((c === '-' || c === '+') && !chomp) chomp = c;
      else if (c >= '1' && c <= '9' && !explicit) explicit = Number(c);
      else break;
      this.pos++;
    }
    if (!this.isBreakOrWs(this.pos)) this.fail(`invalid block scalar header near ${this.describe()}`);
    this.skipInline();
    if (!this.atLineEnd()) this.fail(`unexpected ${this.describe()} after block scalar header`);
    let indent = explicit ? Math.max(parent, 0) + explicit : -1;
    const lines: string[] = [];
    let p = this.pos;
    let lastBreak = false;
    while (p < s.length && p + 1 < s.length) {
      const ls = p + 1;
      let e = s.indexOf('\n', ls);
      if (e < 0) e = s.length;
      let sp = 0;
      while (s[ls + sp] === ' ') sp++;
      if (ls + sp === e) {
        lines.push(indent >= 0 && sp > indent ? s.slice(ls + indent, e) : '');
        p = e;
        continue;
      }
      if (indent < 0) indent = Math.max(sp, parent + 1);
      if (sp < indent || (sp === 0 && this.isDocMarker(ls))) break;
      lines.push(s.slice(ls + indent, e));
      p = e;
      lastBreak = e < s.length;
    }
    this.pos = p;
    let trailing = 0;
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
      trailing++;
    }
    let out = '';
    let empties = 0;
    let prevMore = false;
    let started = false;
    for (const line of lines) {
      if (line === '') {
        empties++;
        continue;
      }
      const more = line[0] === ' ' || line[0] === '\t';
      if (!started) out += '\n'.repeat(empties);
      else if (folded && !more && !prevMore) out += empties ? '\n'.repeat(empties) : ' ';
      else out += '\n'.repeat(empties + 1);
      out += line;
      started = true;
      prevMore = more;
      empties = 0;
    }
    if (chomp === '-') return out;
    if (!started) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const tail = lastBreak || trailing ? '\n' : '';
    return chomp === '+' ? out + tail + '\n'.repeat(trailing) : out + tail;
  }

  // ---- flow collections --------------------------------------------------------------------

  private flowCollection(): unknown {
    const s = this.s;
    const open = s[this.pos];
    const close = open === '[' ? ']' : '}';
    const start = this.pos++;
    const items: unknown[] = [];
    const entries: [string, unknown][] = [];
    const merges: unknown[] = [];
    for (;;) {
      this.skipBlank();
      if (this.pos >= s.length) this.fail(`unterminated flow collection, "${close}" expected`, start);
      if (s[this.pos] === close) break;
      const explicit = s[this.pos] === '?' && this.isBreakOrWs(this.pos + 1);
      if (explicit) {
        this.pos++;
        this.skipBlank();
      }
      const keyStart = this.pos;
      const plainKey = s[this.pos] !== '"' && s[this.pos] !== "'";
      const first = this.flowNode(open === '{');
      this.skipBlank();
      let value: unknown = null;
      const pair = s[this.pos] === ':';
      if (pair) {
        this.pos++;
        this.skipBlank();
        if (s[this.pos] !== ',' && s[this.pos] !== close) value = this.flowNode(false);
        this.skipBlank();
      }
      if (open === '[' && !pair && !explicit) items.push(first);
      else {
        if (first !== null && typeof first === 'object') this.fail('collections as mapping keys are not supported', keyStart);
        const key = first === null ? '' : String(first);
        if (plainKey && key === '<<') merges.push(value);
        else if (open === '{') entries.push([key, value]);
        else items.push(buildMap([[key, value]], [], (m) => this.fail(m)));
      }
      if (s[this.pos] === ',') this.pos++;
      else if (this.pos >= s.length) this.fail(`unterminated flow collection, "${close}" expected`, start);
      else if (s[this.pos] !== close) this.fail(`expected "," or "${close}", found ${this.describe()}`);
    }
    this.pos++;
    return open === '[' ? items : buildMap(entries, merges, (m) => this.fail(m));
  }

  /** A node inside a flow collection; with `asKey`, plain scalars are returned unresolved. */
  private flowNode(asKey: boolean): unknown {
    const props = this.props(true);
    const c = this.s[this.pos];
    if (c === '[' || c === '{') return this.finish(this.flowCollection(), props);
    if (c === '*') return this.alias(props);
    if (c === '"' || c === "'") return this.finish(this.quoted(), props);
    if (c === ',' || c === ']' || c === '}' || c === ':') return this.finish(null, props);
    if (asKey) return this.finish(this.plain(-1, true), props);
    return this.scalar(-1, true, props);
  }
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

/** Build a mapping; `<<` merge sources add keys the mapping does not set itself (first source wins). */
function buildMap(entries: [string, unknown][], merges: unknown[], fail: (m: string) => never): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    // Defining (not assigning) keeps a "__proto__" key an ordinary property.
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  };
  const sources = merges.flatMap((m) => (Array.isArray(m) ? m : [m]));
  for (const src of sources) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) fail('"<<" merge value must be a mapping or a list of mappings');
    for (const [k, v] of Object.entries(src)) if (!Object.prototype.hasOwnProperty.call(out, k)) set(k, v);
  }
  for (const [k, v] of entries) set(k, v);
  return out;
}

/** `!!str` or its verbatim form (tag names are stored without the first "!"). */
function isStrTag(tag: string | undefined): boolean {
  return tag === '!str' || tag === '<tag:yaml.org,2002:str>';
}

/** YAML 1.2 core schema resolution of a plain scalar. */
function resolvePlain(raw: string): unknown {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  if (!'-+.0123456789'.includes(raw[0])) return raw;
  if (/^[-+]?[0-9]+$/.test(raw)) return Number(raw);
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(raw)) return Number(raw);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(raw)) return raw[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(raw)) return NaN;
  return raw;
}
