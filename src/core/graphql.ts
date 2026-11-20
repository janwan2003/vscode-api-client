import type { HttpRequest } from './model.ts';

/**
 * GraphQL requests in REST Client's format:
 *
 *   POST https://api.example.com/graphql
 *   X-REQUEST-TYPE: GraphQL
 *
 *   query Pet($id: ID!) {
 *     pet(id: $id) { id name }
 *   }
 *
 *   { "id": "{{petId}}" }
 *
 * The body is the query, then a blank line, then an optional JSON object of variables. It is sent
 * as `{"query": ..., "variables": {...}, "operationName": ...}` with `Content-Type: application/json`
 * (added when the request has none); the `X-REQUEST-TYPE` header itself is not sent.
 * `operationName` is included only when the document has exactly one operation and it is named.
 * The `.http` text is never rewritten: the conversion happens just before sending (and in Copy as cURL).
 */

/** Header that marks a GraphQL request (REST Client convention). Matched case-insensitively. */
export const GRAPHQL_HEADER = 'X-REQUEST-TYPE';

/** True when the request has an enabled `X-REQUEST-TYPE: GraphQL` header (any case). */
export function isGraphqlRequest(req: Pick<HttpRequest, 'headers'>): boolean {
  return req.headers.some((h) => !h.disabled && h.name.trim().toLowerCase() === 'x-request-type' && h.value.trim().toLowerCase() === 'graphql');
}

/**
 * A JSON object (`{"` or `{}`), or a `{{variable}}` that will hold one. A GraphQL document never
 * has a top-level `{` followed by `"`, `}` or `{`, so this cannot swallow part of a query.
 */
const VARIABLES_START = /^\{(\s*["}]|\{)/;

/** Split a GraphQL body into the query and the variables text (after the first blank line that is followed by a JSON object). */
export function splitGraphqlBody(body: string): { query: string; variables?: string } {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') continue;
    const rest = lines.slice(i + 1).join('\n').trim();
    if (VARIABLES_START.test(rest)) return { query: lines.slice(0, i).join('\n').trim(), variables: rest };
  }
  return { query: body.trim() };
}

/** Inverse of `splitGraphqlBody`: query, blank line, variables (omitted when empty). */
export function joinGraphqlBody(query: string, variables?: string): string {
  const q = query.replace(/\s+$/, '');
  const v = variables?.trim();
  return v ? `${q}\n\n${v}` : q;
}

/** Names of the operations in a GraphQL document, plus how many anonymous ones it has. */
export function graphqlOperations(query: string): { named: string[]; anonymous: number } {
  const tokens = tokenize(query);
  const named: string[] = [];
  let anonymous = 0;
  let depth = 0;
  let expectDefinition = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{' || t === '(' || t === '[') {
      if (depth === 0 && expectDefinition && t === '{') {
        anonymous++; // `{ field }` shorthand query
        expectDefinition = false;
      }
      depth++;
    } else if (t === '}' || t === ')' || t === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && t === '}') expectDefinition = true;
    } else if (depth === 0 && expectDefinition) {
      expectDefinition = false;
      if (t === 'query' || t === 'mutation' || t === 'subscription') {
        const next = tokens[i + 1];
        if (next && /^[_A-Za-z]/.test(next)) named.push(next);
        else anonymous++;
      }
    }
  }
  return { named, anonymous };
}

/** Names and punctuation that matter for finding operations; strings and `#` comments are skipped. */
function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src.startsWith('"""', i)) {
      i += 3;
      while (i < src.length && !src.startsWith('"""', i)) i += src.startsWith('\\"""', i) ? 4 : 1;
      i += 3;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
    } else if ('{}()[]'.includes(c)) {
      out.push(c);
      i++;
    } else if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z0-9]+/.exec(src.slice(i))![0];
      out.push(m);
      i += m.length;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * The JSON text sent for a GraphQL body. With `lenient`, variables that are not valid JSON (for
 * example with unresolved `{{placeholders}}`, as in Copy as cURL) are inserted as written instead of
 * throwing.
 */
export function graphqlPayload(body: string, lenient = false): string {
  const { query, variables } = splitGraphqlBody(body);
  if (!query && !lenient) throw new Error('GraphQL request has no query: write the query in the body (X-REQUEST-TYPE: GraphQL).');
  let varsJson = '{}';
  if (variables !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(variables);
    } catch (e) {
      if (!lenient) {
        throw new Error(
          `GraphQL variables are not valid JSON: ${(e as Error).message}. ` +
            'Variables are the JSON object after the first blank line in the body; put {{variables}} that hold text inside quotes.',
        );
      }
    }
    if (parsed === undefined) varsJson = variables;
    else if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (!lenient) throw new Error('GraphQL variables must be a JSON object, e.g. {"id": 1}.');
      varsJson = variables;
    } else varsJson = JSON.stringify(parsed);
  }
  const ops = graphqlOperations(query);
  const op = ops.named.length === 1 && ops.anonymous === 0 ? `,"operationName":${JSON.stringify(ops.named[0])}` : '';
  return `{"query":${JSON.stringify(query)},"variables":${varsJson}${op}}`;
}

/**
 * The request as sent: a GraphQL request (see `isGraphqlRequest`) gets the JSON body and
 * `Content-Type: application/json`, and loses its `X-REQUEST-TYPE` header. Other requests are
 * returned unchanged. Never modifies `req`. Throws on GET/HEAD and on invalid variables unless `lenient`.
 */
export function toGraphqlHttp(req: HttpRequest, lenient = false): HttpRequest {
  if (!isGraphqlRequest(req)) return req;
  const method = req.method.toUpperCase();
  if (!lenient && (method === 'GET' || method === 'HEAD')) {
    throw new Error(`GraphQL over ${method} is not supported: use POST for X-REQUEST-TYPE: GraphQL requests.`);
  }
  const headers = req.headers.filter((h) => h.name.trim().toLowerCase() !== 'x-request-type').map((h) => ({ ...h }));
  if (!headers.some((h) => !h.disabled && h.name.trim().toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
  return { ...req, headers, body: graphqlPayload(req.body ?? '', lenient) };
}
