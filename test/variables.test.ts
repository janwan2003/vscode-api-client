import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonPath, mergeEnvironment, parseDotenv, referencedRequestNames, resolveRequest, resolveText, UnresolvedVariableError, type VariableContext } from '../src/core/variables.ts';

function ctx(over: Partial<VariableContext> = {}): VariableContext {
  return {
    fileVariables: [],
    environment: {},
    named: new Map(),
    processEnv: {},
    dotenv: {},
    now: () => new Date('2026-01-02T03:04:05.678Z'),
    ...over,
  };
}

test('file variables override environment and nest', () => {
  const c = ctx({ fileVariables: [{ name: 'host', value: '{{scheme}}://api' }], environment: { host: 'nope', scheme: 'https' } });
  assert.equal(resolveText('{{host}}/x', c), 'https://api/x');
});

test('unknown variables throw', () => {
  assert.throws(() => resolveText('{{missing}}', ctx()), UnresolvedVariableError);
});

test('loops are detected', () => {
  const c = ctx({ fileVariables: [{ name: 'a', value: '{{b}}' }, { name: 'b', value: '{{a}}' }] });
  assert.throws(() => resolveText('{{a}}', c), /loop/);
});

test('system variables', () => {
  const c = ctx({ processEnv: { HOME: '/h' }, dotenv: { KEY: 'k' }, environment: { which: 'HOME' } });
  assert.match(resolveText('{{$guid}}', c), /^[0-9a-f-]{36}$/);
  assert.equal(resolveText('{{$timestamp}}', c), String(Math.floor(Date.parse('2026-01-02T03:04:05.678Z') / 1000)));
  assert.equal(resolveText('{{$timestamp -1 d}}', c), String(Math.floor(Date.parse('2026-01-01T03:04:05.678Z') / 1000)));
  assert.equal(resolveText('{{$datetime iso8601}}', c), '2026-01-02T03:04:05.678Z');
  assert.equal(resolveText('{{$datetime rfc1123}}', c), 'Fri, 02 Jan 2026 03:04:05 GMT');
  assert.equal(resolveText('{{$datetime "YYYY-MM-DD HH:mm"}}', c), '2026-01-02 03:04');
  const n = Number(resolveText('{{$randomInt 5 7}}', c));
  assert.ok(n >= 5 && n < 7);
  assert.equal(resolveText('{{$processEnv HOME}}', c), '/h');
  assert.equal(resolveText('{{$processEnv %which}}', c), '/h');
  assert.equal(resolveText('{{$dotenv KEY}}', c), 'k');
});

test('request chaining reads JSON body paths and headers', () => {
  const named = new Map([
    [
      'login',
      {
        request: { url: 'https://x', headers: [] as [string, string][], body: '{"user":"a"}' },
        response: { status: 200, statusText: 'OK', headers: [['x-request-id', 'r1']] as [string, string][], body: '{"token":"t0k","items":[{"id":7}]}', bodyEncoding: 'utf8' as const, size: 1, timeMs: 1, url: 'https://x' },
      },
    ],
  ]);
  const c = ctx({ named });
  assert.equal(resolveText('Bearer {{login.response.body.$.token}}', c), 'Bearer t0k');
  assert.equal(resolveText('{{login.response.body.$.items[0].id}}', c), '7');
  assert.equal(resolveText('{{login.response.body.$.items[-1]}}', c), '{"id":7}');
  assert.equal(resolveText('{{login.response.headers.X-Request-Id}}', c), 'r1');
  assert.equal(resolveText('{{login.request.body.$.user}}', c), 'a');
  assert.deepEqual(referencedRequestNames('{{login.response.body.$.token}} {{host}} {{other.request.headers.a}}'), ['login', 'other']);
});

test('jsonPath bracket keys and misses', () => {
  assert.equal(jsonPath({ 'a b': { c: 1 } }, "$['a b'].c"), 1);
  assert.equal(jsonPath({ a: 1 }, '$.b.c'), undefined);
  assert.equal(jsonPath({ a: 1 }, '$..a'), undefined);
});

test('resolveRequest drops disabled headers', () => {
  const r = resolveRequest({ method: 'GET', url: '{{u}}', headers: [{ name: 'A', value: '{{u}}' }, { name: 'B', value: '{{nope}}', disabled: true }] }, ctx({ environment: { u: 'x' } }));
  assert.deepEqual(r.headers, [{ name: 'A', value: 'x' }]);
  assert.equal(r.url, 'x');
});

test('mergeEnvironment applies $shared', () => {
  const env = mergeEnvironment({ $shared: { v: '1', host: 'h' }, dev: { host: 'd', ref: '{{$shared v}}' } }, 'dev');
  assert.deepEqual(env, { v: '1', host: 'd', ref: '1' });
});

test('parseDotenv', () => {
  assert.deepEqual(parseDotenv('# c\nA=1\nexport B="x y"\nC=\'z\' \nD=v # comment\n'), { A: '1', B: 'x y', C: 'z', D: 'v' });
});

test('jsonPath .length on strings and arrays', () => {
  assert.equal(jsonPath({ id: 'abcde', items: [1, 2] }, '$.id.length'), 5);
  assert.equal(jsonPath({ id: 'abcde', items: [1, 2] }, '$.items.length'), 2);
  assert.equal(jsonPath({ id: 'abcde' }, '$.id.foo'), undefined);
});
