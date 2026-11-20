import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { graphqlOperations, graphqlPayload, isGraphqlRequest, joinGraphqlBody, splitGraphqlBody, toGraphqlHttp } from '../src/core/graphql.ts';
import { parseHttpFile, replaceRequest } from '../src/core/httpFile.ts';
import { toCurl } from '../src/core/curl.ts';
import { Executor } from '../src/core/exec.ts';
import type { HttpRequest } from '../src/core/model.ts';

const gql = (body: string | undefined, extra: HttpRequest['headers'] = []): HttpRequest => ({
  method: 'POST',
  url: 'https://api.test/graphql',
  headers: [{ name: 'X-REQUEST-TYPE', value: 'GraphQL' }, ...extra],
  body,
});

test('query only: JSON body, Content-Type added, X-REQUEST-TYPE not sent', () => {
  const r = toGraphqlHttp(gql('{ products { id } }'));
  assert.deepEqual(JSON.parse(r.body!), { query: '{ products { id } }', variables: {} });
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: 'application/json' }]);
});

test('query + variables after a blank line; operationName for a single named operation', () => {
  const body = 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}\n\n{\n  "id": "42"\n}';
  const r = toGraphqlHttp(gql(body, [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]));
  assert.deepEqual(JSON.parse(r.body!), { query: 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}', variables: { id: '42' }, operationName: 'Pet' });
  // An existing Content-Type is kept as written.
  assert.deepEqual(r.headers, [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]);
});

test('header name and value are case-insensitive; a disabled header or other value is not GraphQL', () => {
  const lower = { method: 'POST', url: 'u', headers: [{ name: 'x-request-type', value: ' graphql ' }], body: 'query { a }' };
  assert.equal(isGraphqlRequest(lower), true);
  assert.deepEqual(JSON.parse(toGraphqlHttp(lower).body!), { query: 'query { a }', variables: {} });
  assert.equal(isGraphqlRequest({ headers: [{ name: 'X-Request-Type', value: 'GraphQL', disabled: true }] }), false);
  assert.equal(isGraphqlRequest({ headers: [{ name: 'X-Request-Type', value: 'REST' }] }), false);
  const plain: HttpRequest = { method: 'POST', url: 'u', headers: [], body: 'x' };
  assert.equal(toGraphqlHttp(plain), plain);
});

test('invalid variables JSON, non-object variables, no query, GET: clear errors', () => {
  assert.throws(() => toGraphqlHttp(gql('query { a }\n\n{"id": }')), /GraphQL variables are not valid JSON: .*after the first blank line/);
  assert.throws(() => toGraphqlHttp(gql('query { a }\n\n{"id": abc}')), /not valid JSON.*inside quotes/);
  assert.throws(() => graphqlPayload('query { a }\n\n{{vars}}'), /not valid JSON/);
  assert.throws(() => toGraphqlHttp(gql(undefined)), /no query/);
  assert.throws(() => toGraphqlHttp({ ...gql('{ a }'), method: 'GET' }), /GraphQL over GET is not supported: use POST/);
});

test('split: blank lines inside the query stay in the query; variables may contain blank lines', () => {
  const body = 'fragment F on Pet { id }\n\nquery Q {\n\n  pets { ...F }\n}\n\n{\n  "a": 1,\n\n  "b": 2\n}\n';
  const s = splitGraphqlBody(body);
  assert.equal(s.query, 'fragment F on Pet { id }\n\nquery Q {\n\n  pets { ...F }\n}');
  assert.deepEqual(JSON.parse(s.variables!), { a: 1, b: 2 });
  // A shorthand query after a fragment is a query, not variables.
  assert.deepEqual(splitGraphqlBody('fragment F on Pet { id }\n\n{ pets { ...F } }'), { query: 'fragment F on Pet { id }\n\n{ pets { ...F } }' });
  assert.deepEqual(splitGraphqlBody('query { a }\r\n\r\n{}'), { query: 'query { a }', variables: '{}' });
  assert.deepEqual(splitGraphqlBody('query { a }\n\n{{allVars}}'), { query: 'query { a }', variables: '{{allVars}}' });
  assert.equal(joinGraphqlBody('query { a }\n', '  {"x": 1}\n'), 'query { a }\n\n{"x": 1}');
  assert.equal(joinGraphqlBody('query { a }', ''), 'query { a }');
});

test('operations: names, anonymous, strings, comments and default values do not confuse it', () => {
  assert.deepEqual(graphqlOperations('query A { a } mutation B($x: In = {k: "}"}) { b }'), { named: ['A', 'B'], anonymous: 0 });
  assert.deepEqual(graphqlOperations('# query Fake { x }\n"""desc { """\nquery { a(s: "query X {") }'), { named: [], anonymous: 1 });
  assert.deepEqual(graphqlOperations('fragment F on T { a }\n{ ...F }'), { named: [], anonymous: 1 });
  assert.deepEqual(graphqlOperations('subscription OnPet { pet { id } }'), { named: ['OnPet'], anonymous: 0 });
  // Two named operations: the server needs operationName, which we cannot guess, so none is sent.
  assert.equal(JSON.parse(graphqlPayload('query A { a }\nquery B { b }')).operationName, undefined);
});

test('{{variables}} inside the query and the variables JSON are substituted before encoding (Executor)', async () => {
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":{"pet":{"id":"7"}}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = [
    `@base = ${base}`,
    '@field = name',
    '',
    '### Pet',
    '# @assert $.data.pet.id == 7',
    'POST {{base}}/graphql',
    'X-Request-Type: GraphQL',
    '',
    'query Pet($id: ID!) {',
    '  pet(id: $id) { id {{field}} note(text: "say \\"hi\\"") }',
    '}',
    '',
    '{',
    '  "id": {{petId}},',
    '  "who": "{{$processEnv PW_GQL_TEST_WHO}}"',
    '}',
    '',
  ].join('\n');
  process.env.PW_GQL_TEST_WHO = 'ada lovelace';
  const exec = new Executor({
    readHttpFile: async () => file,
    readBodyFile: async () => new Uint8Array(),
    dotenv: async () => ({}),
    environment: () => ({ petId: '7' }),
    sendOptions: () => ({ timeoutMs: 5000 }),
  });
  try {
    const req = parseHttpFile(file).requests[0];
    const r = await exec.run(req, 'f.http');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.equal(seen[0].headers['x-request-type'], undefined);
    assert.deepEqual(JSON.parse(seen[0].body), {
      query: 'query Pet($id: ID!) {\n  pet(id: $id) { id name note(text: "say \\"hi\\"") }\n}',
      variables: { id: 7, who: 'ada lovelace' },
      operationName: 'Pet',
    });
    // The "Sent request" view and chaining see what was sent.
    assert.equal(r.resolved.body, seen[0].body);
    assert.equal(r.assertions[0].passed, true, r.assertions[0].message);
    // {{field}} = name, unquoted → invalid JSON after substitution: a readable error, nothing sent.
    const bad = { ...req, body: 'query { a }\n\n{"id": {{field}}}' };
    await assert.rejects(exec.run(bad, 'f.http'), /GraphQL variables are not valid JSON/);
    assert.equal(seen.length, 1);
  } finally {
    server.close();
    delete process.env.PW_GQL_TEST_WHO;
  }
});

test('the .http text is untouched: parse + replace of an unchanged GraphQL request is byte-identical', () => {
  const text = '### Pet\nPOST https://api.test/graphql\nX-REQUEST-TYPE: GraphQL\n\nquery Pet($id: ID!) {\n  # a comment\n  pet(id: $id) { id }\n}\n\n{\n  "id": "{{id}}"\n}\n\n### Next\nGET https://api.test/\n';
  const parsed = parseHttpFile(text);
  assert.equal(parsed.requests.length, 2);
  assert.equal(replaceRequest(text, 0, parsed.requests[0]), text);
  assert.equal(splitGraphqlBody(parsed.requests[0].body!).variables, '{\n  "id": "{{id}}"\n}');
});

test('Copy as cURL emits the JSON body, keeping unresolved {{placeholders}}', () => {
  const c = toCurl(gql('query Pet { pet(id: "{{id}}") { id } }\n\n{"n": {{n}}}'));
  assert.equal(
    c,
    [
      "curl https://api.test/graphql",
      '-X POST',
      "-H 'Content-Type: application/json'",
      `--data-raw '{"query":"query Pet { pet(id: \\"{{id}}\\") { id } }","variables":{"n": {{n}}},"operationName":"Pet"}'`,
    ].join(' \\\n  '),
  );
  assert.ok(!/X-REQUEST-TYPE/i.test(c));
});
