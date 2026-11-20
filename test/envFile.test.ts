import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitignoreCovers, modelFromFiles, validate, writeFiles, type EnvModel } from '../src/core/envFile.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Deep-equal including key order. */
const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a, null, 1), JSON.stringify(b, null, 1));

const security = {
  Auth: {
    'my-oauth': {
      Type: 'OAuth2',
      'Grant Type': 'Authorization Code',
      'Client ID': 'abc',
      'Token URL': 'https://auth.example.com/token',
      Scope: ['openid', 'profile'],
      PKCE: true,
      'Expires In': 3600,
    },
  },
};
const PUB = {
  $schema: 'https://example.com/http-client.env.schema.json',
  dev: { baseUrl: 'http://localhost:3000', token: '', Security: security, retries: 3, verbose: true, nothing: null, tags: ['a', 'b'] },
  $shared: { userAgent: 'plainwire', version: 'v1' },
  prod: { baseUrl: 'https://api.example.com' },
  notAnEnv: 'kept as is',
  alsoNot: [1, 2],
};
const PRIV = {
  dev: { token: 'dev-secret', password: 'hunter2' },
  prod: { token: 'prod-secret', Security: { Auth: { 'my-oauth': { 'Client Secret': 's3cr3t' } } } },
  staging: { token: 'only-private' },
};

const envOf = (m: EnvModel, name: string) => m.envs.find((e) => e.name === name)!;

test('model: envs in file order, private-only envs after, rows per file, non-strings read-only', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  assert.deepEqual(m.envs.map((e) => e.name), ['dev', '$shared', 'prod', 'staging']);
  const dev = envOf(m, 'dev');
  assert.deepEqual(dev.vars.map((v) => `${v.name}:${v.secret ? 'S' : 'P'}:${v.readonly ?? 'string'}`), [
    'baseUrl:P:string', 'token:P:string', 'Security:P:object', 'retries:P:number', 'verbose:P:boolean', 'nothing:P:null', 'tags:P:array',
    'token:S:string', 'password:S:string',
  ]);
  const sec = dev.vars.find((v) => v.name === 'Security')!;
  assert.equal(sec.value, undefined);
  assert.ok(sec.preview!.startsWith('{"Auth":{"my-oauth":'));
  assert.ok(sec.preview!.length <= 80);
  assert.deepEqual(validate(m), []);
});

test('round trip with no edits is identical and nothing needs writing', () => {
  const pub = clone(PUB);
  const priv = clone(PRIV);
  const r = writeFiles(modelFromFiles(pub, priv), pub, priv);
  same(r.public, PUB);
  same(r.private, PRIV);
  assert.equal(r.publicChanged, false);
  assert.equal(r.privateChanged, false);
  assert.equal(r.publicText, JSON.stringify(PUB, null, 2) + '\n');
  // The model survives a trip through the webview (JSON) unchanged too.
  const again = writeFiles(clone(modelFromFiles(pub, priv)), pub, priv);
  same(again.public, PUB);
  same(again.private, PRIV);
});

test('editing one value keeps $schema, Security objects, unknown keys and key order', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  envOf(m, 'dev').vars[0].value = 'http://localhost:4000';
  const r = writeFiles(m, PUB, PRIV);
  assert.equal(r.publicChanged, true);
  assert.equal(r.privateChanged, false);
  same(r.public, { ...PUB, dev: { ...PUB.dev, baseUrl: 'http://localhost:4000' } });
  assert.deepEqual(Object.keys(r.public), ['$schema', 'dev', '$shared', 'prod', 'notAnEnv', 'alsoNot']);
  assert.deepEqual((r.public.dev as Record<string, unknown>).Security, security);
  assert.deepEqual((r.private.prod as Record<string, unknown>).Security, PRIV.prod.Security);
  assert.ok(r.publicText.endsWith('}\n') && r.publicText.includes('\n  "dev": {\n    "baseUrl"'));
});

test('read-only values are written from the original file, not from the edited model', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  const sec = envOf(m, 'dev').vars.find((v) => v.name === 'Security')!;
  sec.value = 'tampered';
  sec.preview = 'x';
  const r = writeFiles(m, PUB, PRIV);
  assert.deepEqual((r.public.dev as Record<string, unknown>).Security, security);
  assert.equal(r.publicChanged, false);
});

test('moving a variable between public and private', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  // baseUrl of prod becomes secret; password of dev becomes public.
  envOf(m, 'prod').vars.find((v) => v.name === 'baseUrl')!.secret = true;
  envOf(m, 'dev').vars.find((v) => v.name === 'password')!.secret = false;
  const r = writeFiles(m, PUB, PRIV);
  same(r.public.prod, {});
  same(r.private.prod, { token: 'prod-secret', Security: PRIV.prod.Security, baseUrl: 'https://api.example.com' });
  same(r.private.dev, { token: 'dev-secret' });
  same(r.public.dev, { ...PUB.dev, password: 'hunter2' });
  assert.ok(r.publicChanged && r.privateChanged);
  // Moving it back restores the original files exactly.
  const m2 = modelFromFiles(r.public, r.private);
  envOf(m2, 'prod').vars.find((v) => v.name === 'baseUrl')!.secret = false;
  envOf(m2, 'dev').vars.find((v) => v.name === 'password')!.secret = true;
  const back = writeFiles(m2, r.public, r.private);
  assert.deepEqual(back.public, PUB);
  assert.deepEqual(back.private, PRIV);
});

test('a read-only Security object can move to the private file intact', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  envOf(m, 'dev').vars.find((v) => v.name === 'Security')!.secret = true;
  const r = writeFiles(m, PUB, PRIV);
  assert.equal((r.public.dev as Record<string, unknown>).Security, undefined);
  assert.deepEqual((r.private.dev as Record<string, unknown>).Security, security);
});

test('rename and delete variables: renamed keep their place', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  const dev = envOf(m, 'dev');
  dev.vars.find((v) => v.name === 'baseUrl')!.name = 'host';
  dev.vars = dev.vars.filter((v) => !(v.name === 'token' && !v.secret) && v.name !== 'retries');
  dev.vars.push({ name: 'apiKey', value: 'k', secret: true }, { name: 'region', value: 'eu', secret: false });
  const r = writeFiles(m, PUB, PRIV);
  assert.deepEqual(Object.keys(r.public.dev as object), ['host', 'Security', 'verbose', 'nothing', 'tags', 'region']);
  same(r.private.dev, { token: 'dev-secret', password: 'hunter2', apiKey: 'k' });
});

test('rename and delete environments in both files; add environments', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  envOf(m, 'dev').name = 'local';
  m.envs = m.envs.filter((e) => e.name !== 'staging');
  m.envs.push({ name: 'qa', vars: [{ name: 'baseUrl', value: 'https://qa', secret: false }, { name: 'token', value: 'qa-secret', secret: true }] });
  m.envs.push({ name: 'empty', vars: [] });
  const r = writeFiles(m, PUB, PRIV);
  assert.deepEqual(Object.keys(r.public), ['$schema', 'local', '$shared', 'prod', 'notAnEnv', 'alsoNot', 'qa', 'empty']);
  assert.deepEqual(Object.keys(r.private), ['local', 'prod', 'qa']);
  same(r.public.local, PUB.dev);
  same(r.private.local, PRIV.dev);
  same(r.private.qa, { token: 'qa-secret' });
  same(r.public.empty, {});
});

test('swapping two environment names', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  envOf(m, 'dev').name = 'tmp';
  envOf(m, 'prod').name = 'dev';
  envOf(m, 'tmp').name = 'prod';
  const r = writeFiles(m, PUB, PRIV);
  assert.deepEqual(Object.keys(r.public), ['$schema', 'prod', '$shared', 'dev', 'notAnEnv', 'alsoNot']);
  same(r.public.prod, PUB.dev);
  same(r.private.dev, PRIV.prod);
});

test('private-only environment gets a public entry only when it has public variables', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  const r1 = writeFiles(m, PUB, PRIV);
  assert.equal(r1.public.staging, undefined);
  envOf(m, 'staging').vars.push({ name: 'baseUrl', value: 'https://staging', secret: false });
  const r2 = writeFiles(m, PUB, PRIV);
  same(r2.public.staging, { baseUrl: 'https://staging' });
});

test('$shared: added when it gets variables, never written empty, cannot be duplicated', () => {
  const pub = { dev: { a: '1' } };
  const m = modelFromFiles(pub, undefined);
  m.envs.unshift({ name: '$shared', vars: [] });
  const r1 = writeFiles(m, pub, undefined);
  assert.equal(r1.publicChanged, false);
  assert.equal(r1.privateChanged, false);
  assert.ok(!('$shared' in r1.public));
  m.envs[0].vars.push({ name: 'ua', value: 'x', secret: false }, { name: 'key', value: 'k', secret: true });
  const r2 = writeFiles(m, pub, undefined);
  assert.deepEqual(Object.keys(r2.public), ['dev', '$shared']);
  same(r2.private, { $shared: { key: 'k' } });
  assert.equal(r2.privateChanged, true);
  m.envs.push({ name: '$shared', vars: [] });
  assert.match(validate(m).join('\n'), /two environments named "\$shared"/);
});

test('creating both files from nothing', () => {
  const m = modelFromFiles(undefined, undefined);
  assert.equal(m.envs.length, 0);
  const none = writeFiles(m, undefined, undefined);
  assert.equal(none.publicChanged, false);
  assert.equal(none.privateChanged, false);
  m.envs.push({ name: '$shared', vars: [{ name: 'baseUrl', value: 'http://localhost:3000', secret: false }] });
  m.envs.push({ name: 'dev', vars: [{ name: 'token', value: 'abc', secret: true }] });
  const r = writeFiles(m, undefined, undefined);
  assert.equal(r.publicText, '{\n  "$shared": {\n    "baseUrl": "http://localhost:3000"\n  },\n  "dev": {}\n}\n');
  assert.equal(r.privateText, '{\n  "dev": {\n    "token": "abc"\n  }\n}\n');
  assert.ok(r.publicChanged && r.privateChanged);
  // Only public variables: no private file.
  const pubOnly = writeFiles({ envs: [{ name: 'dev', vars: [{ name: 'a', value: '1', secret: false }] }] }, undefined, undefined);
  assert.equal(pubOnly.privateChanged, false);
});

test('a variable may exist in both files (private wins at runtime); duplicates in one file are rejected', () => {
  const m = modelFromFiles(clone(PUB), clone(PRIV));
  const dev = envOf(m, 'dev');
  assert.equal(dev.vars.filter((v) => v.name === 'token').length, 2);
  assert.deepEqual(validate(m), []);
  dev.vars.find((v) => v.name === 'password')!.name = ' token ';
  assert.match(validate(m).join('\n'), /"dev" has two secret variables named "token"/);
  assert.throws(() => writeFiles(m, PUB, PRIV), /two secret variables/);
});

test('validation: empty names, $schema as env name, read-only row without origin', () => {
  assert.match(validate({ envs: [{ name: ' ', vars: [] }] }).join(), /has no name/);
  assert.match(validate({ envs: [{ name: '$schema', vars: [] }] }).join(), /cannot be used/);
  assert.match(validate({ envs: [{ name: 'dev', vars: [{ name: '', value: 'x', secret: false }] }] }).join(), /variable in "dev" has no name/);
  assert.match(validate({ envs: [{ name: 'dev', vars: [{ name: 'x', secret: false, readonly: 'object' }] }] }).join(), /has no value/);
});

test('names are trimmed on write; values are written as typed', () => {
  const r = writeFiles({ envs: [{ name: ' dev ', vars: [{ name: ' a ', value: ' spaced ', secret: false }] }] }, undefined, undefined);
  same(r.public, { dev: { a: ' spaced ' } });
});

test('a file that is not a JSON object is never overwritten', () => {
  const m = modelFromFiles([1, 2], undefined);
  assert.equal(m.envs.length, 0);
  m.envs.push({ name: 'dev', vars: [{ name: 'a', value: '1', secret: false }] });
  assert.throws(() => writeFiles(m, [1, 2], undefined), /http-client.env.json is not a JSON object/);
  assert.throws(() => writeFiles(m, undefined, 'x'), /http-client.private.env.json is not a JSON object/);
});

test('gitignoreCovers', () => {
  const f = 'http-client.private.env.json';
  assert.equal(gitignoreCovers('', f), false);
  assert.equal(gitignoreCovers('# comment\nnode_modules/\n', f), false);
  assert.equal(gitignoreCovers('http-client.private.env.json\n', f), true);
  assert.equal(gitignoreCovers('http-client.private.env.json\n', 'api/http-client.private.env.json'), true);
  assert.equal(gitignoreCovers('/http-client.private.env.json\n', 'api/http-client.private.env.json'), false);
  assert.equal(gitignoreCovers('*.private.env.json\n', 'a/b/' + f), true);
  assert.equal(gitignoreCovers('**/*.private.env.json', 'a/b/' + f), true);
  assert.equal(gitignoreCovers('*.env.json\n!http-client.private.env.json\n', f), false);
  assert.equal(gitignoreCovers('!http-client.private.env.json\n*.json\n', f), true);
  assert.equal(gitignoreCovers('api/\n', 'api/' + f), true);
  assert.equal(gitignoreCovers('api/\n', 'api'), false);
  assert.equal(gitignoreCovers('/api/*.json\n', 'api/' + f), true);
  assert.equal(gitignoreCovers('/api/*.json\n', 'x/api/' + f), false);
  assert.equal(gitignoreCovers('http-client.private.env.json  \r\n', f), true);
  assert.equal(gitignoreCovers('http-client.[pP]rivate.env.json', f), true);
  assert.equal(gitignoreCovers('http-client.private.env.jso?', f), true);
  assert.equal(gitignoreCovers('http-client.env.json', f), false);
});
