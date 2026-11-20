// "Copy as Code" generators. Where the interpreter/tool is installed, every snippet is RUN against a
// local echo server and the server checks method, path, headers and body bytes. Missing tools are
// skipped (not failed). String-literal rules are also checked against small decoders written from
// each language's spec, so languages without an interpreter here still get their escaping tested.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_TARGETS, csString, encodeUrl, generateCode, goString, javaString, jsString, phpString, psString, pyString, type CodeTarget } from '../src/core/codegen.ts';
import { previewRequest } from '../src/core/exec.ts';
import type { HttpRequest } from '../src/core/model.ts';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let server: Server;
let base = '';
const seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const pythonRequests = has('python3') && spawnSync('python3', ['-c', 'import requests'], { stdio: 'ignore' }).status === 0;
const dotnetFileApps = has('dotnet') && Number((spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).stdout || '0').split('.')[0]) >= 10;

/** How to run a snippet: file name and command. `undefined` = tool not installed here. */
const runners: Record<CodeTarget, { file: string; cmd: string[] } | undefined> = {
  curl: has('curl') ? { file: 'run.sh', cmd: ['sh', 'run.sh'] } : undefined,
  // The browser snippet is plain ES module code; Node 18+ runs it unchanged (top-level await, fetch).
  'javascript-fetch': { file: 'run.mjs', cmd: [process.execPath, 'run.mjs'] },
  'node-fetch': { file: 'run.mjs', cmd: [process.execPath, 'run.mjs'] },
  'python-requests': pythonRequests ? { file: 'run.py', cmd: ['python3', 'run.py'] } : undefined,
  go: has('go') ? { file: 'main.go', cmd: ['go', 'run', 'main.go'] } : undefined,
  httpie: has('http') ? { file: 'run.sh', cmd: ['sh', 'run.sh'] } : undefined,
  powershell: has('pwsh') ? { file: 'run.ps1', cmd: ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'run.ps1'] } : undefined,
  wget: has('wget') ? { file: 'run.sh', cmd: ['sh', 'run.sh'] } : undefined,
  csharp: dotnetFileApps ? { file: 'run.cs', cmd: ['dotnet', 'run', 'run.cs'] } : undefined,
  'php-curl': has('php') ? { file: 'run.php', cmd: ['php', 'run.php'] } : undefined,
  java: has('java') ? { file: 'Main.java', cmd: ['java', 'Main.java'] } : undefined,
};

const TRICKY_BODY = [
  '{',
  `  "quotes": "it's \\"quoted\\" and ''' and \\"\\"\\"",`,
  '  "backslash": "C:\\\\path\\\\n \\\\u000a",',
  '  "shell": "$HOME ${x} `id` $(id) %s {{x}} !!",',
  '  "unicode": "café 日本 😀 ’‘",',
  '\t"crlf": "a"\r',
  `}'`,
].join('\n');
const DATA_FILE = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x0d, 0x27, 0x22, 0x60, 0x24]);

interface Case {
  name: string;
  req: (base: string) => HttpRequest;
  /** Expected on the server. Header names lower-case; Node joins repeats with ", " (Cookie: "; "). */
  expect: { method: string; url: string; headers: Record<string, string>; body: Buffer };
  /** Targets that cannot run this case (and why). */
  skip?: Partial<Record<CodeTarget, string>>;
}

const cases: Case[] = [
  {
    name: 'JSON POST with quotes, backslashes, $, backticks, CRLF, non-ASCII, repeated headers',
    req: (b) => ({
      method: 'POST',
      url: `${b}/echo/café?q=1&x=日`,
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Dup', value: '1' },
        { name: 'X-Dup', value: '2' },
        { name: 'X-Tricky', value: `it's "q" $HOME \`id\` \${x} \\ end` },
        { name: 'X-Off', value: 'no', disabled: true },
        { name: 'Cookie', value: 'a=1' },
        { name: 'Cookie', value: 'b=2' },
      ],
      body: TRICKY_BODY,
    }),
    expect: {
      method: 'POST',
      url: '/echo/caf%C3%A9?q=1&x=%E6%97%A5',
      headers: { 'content-type': 'application/json', 'x-dup': '1, 2', 'x-tricky': `it's "q" $HOME \`id\` \${x} \\ end`, cookie: 'a=1; b=2' },
      body: Buffer.from(TRICKY_BODY, 'utf8'),
    },
  },
  {
    name: 'single-line text body with both quote kinds',
    req: (b) => ({ method: 'PATCH', url: `${b}/one`, headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: `it's "both" \\ $x \`y\` ’` }),
    expect: { method: 'PATCH', url: '/one', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`it's "both" \\ $x \`y\` ’`) },
  },
  {
    name: 'form-urlencoded POST',
    req: (b) => ({ method: 'POST', url: `${b}/form`, headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'a=1&b=hello%20world&c=%24x' }),
    expect: { method: 'POST', url: '/form', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('a=1&b=hello%20world&c=%24x') },
  },
  {
    name: 'GET without body',
    req: (b) => ({ method: 'GET', url: `${b}/get?x=1&y=a%2Fb`, headers: [{ name: 'Accept', value: 'application/json' }, { name: 'Authorization', value: 'Bearer abc.def' }] }),
    expect: { method: 'GET', url: '/get?x=1&y=a%2Fb', headers: { accept: 'application/json', authorization: 'Bearer abc.def' }, body: Buffer.alloc(0) },
  },
  {
    name: 'PUT with a binary file body (< ./data.bin)',
    req: (b) => ({ method: 'PUT', url: `${b}/upload`, headers: [{ name: 'Content-Type', value: 'application/octet-stream' }], body: '< ./data.bin' }),
    expect: { method: 'PUT', url: '/upload', headers: { 'content-type': 'application/octet-stream' }, body: DATA_FILE },
    skip: { 'javascript-fetch': 'browser snippet does not read files (comment says so)' },
  },
  {
    name: 'custom method without body',
    req: (b) => ({ method: 'PURGE', url: `${b}/cache/item`, headers: [{ name: 'X-Reason', value: 'stale' }] }),
    expect: { method: 'PURGE', url: '/cache/item', headers: { 'x-reason': 'stale' }, body: Buffer.alloc(0) },
  },
];

/** Async on purpose: spawnSync would block the event loop and the echo server in this process with it. */
function run(cmd: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, env, timeout: 60000 });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => resolve({ status: -1, stdout, stderr: stderr + e.message }));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const env = { ...process.env, NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };

for (const t of CODE_TARGETS) {
  const runner = runners[t.id];
  for (const c of cases) {
    const why = !runner ? `${t.label}: interpreter not installed` : c.skip?.[t.id];
    test(`run ${t.id}: ${c.name}`, { skip: why || false }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pw-codegen-'));
      try {
        writeFileSync(join(dir, 'data.bin'), DATA_FILE);
        const code = generateCode(t.id, c.req(base));
        writeFileSync(join(dir, runner!.file), code);
        seen.length = 0;
        const r = await run(runner!.cmd, dir);
        assert.equal(r.status, 0, `exit ${r.status}\n--- snippet ---\n${code}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`);
        assert.equal(seen.length, 1, `server saw ${seen.length} requests\n${code}`);
        const s = seen[0];
        assert.equal(s.method, c.expect.method);
        assert.equal(s.url, c.expect.url);
        for (const [k, v] of Object.entries(c.expect.headers)) assert.equal(s.headers[k], v, `header ${k}\n${code}`);
        assert.equal(s.headers['x-off'], undefined);
        assert.equal(s.body.toString('hex'), c.expect.body.toString('hex'), `body\n${code}`);
        assert.match(r.stdout, /200|"ok":true|\bok\b[\s\S]*\bTrue\b/); // status (most snippets), the body (curl, wget) or the parsed object (PowerShell)
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// String-literal round trips. Decoders implement each language's literal rules from its spec.

const SAMPLES = [
  '',
  'plain',
  `it's "both"`,
  "only 'single'",
  'only "double"',
  'back\\slash \\n \\u000a \\x41 \\\\',
  '$HOME ${x} $(id) `tick` {$x} #{x} %s',
  "'''\"\"\" ending quote'",
  'ending double"',
  'line1\nline2\n',
  '\nstarts with newline',
  'crlf\r\nline',
  'tab\there',
  'nul\u0000bell\u0007esc\u001bdel\u007f',
  'café 日本 😀 ’‘‚‛ “”',
  "multi\nline with 'single' and \"double\" and ''' and \"\"\"",
  'multi\nline with `backtick`',
];

function decodeGo(lit: string): string {
  if (lit.startsWith('`')) {
    assert.ok(lit.endsWith('`') && !lit.slice(1, -1).includes('`'));
    return lit.slice(1, -1).replace(/\r/g, '');
  }
  assert.ok(lit.startsWith('"') && lit.endsWith('"'));
  const body = lit.slice(1, -1);
  assert.ok(!/[\n\r]/.test(body), 'interpreted Go string spans lines');
  return decodeCStyle(body, { x: 'byte' });
}

/** Backslash escapes shared by Go, C#, Java, PHP double quotes, Python: \\ \" \' \n \r \t \0 \xNN \uXXXX. */
function decodeCStyle(body: string, o: { x?: 'byte'; quote?: string } = {}): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (o.quote && c === o.quote) assert.fail(`unescaped ${o.quote} in ${body}`);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === '0') out += '\0';
    else if (n === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === '\\' || n === '"' || n === "'" || n === '$') out += n;
    else assert.fail(`unknown escape \\${n}`);
  }
  return out;
}

function decodePs(lit: string): string {
  const parts = lit.startsWith('(') ? lit.slice(1, -1).split(/ \+ (?=['"])/) : [lit];
  return parts
    .map((p) => {
      if (p.startsWith('"')) {
        const m = /^"`(r|0|u\{([0-9a-f]+)\})"$/.exec(p);
        assert.ok(m, p);
        return m[1] === 'r' ? '\r' : m[1] === '0' ? '\0' : String.fromCharCode(parseInt(m[2], 16));
      }
      assert.ok(p.startsWith("'") && p.endsWith("'"), p);
      const body = p.slice(1, -1);
      // Any of ' ‘ ’ ‚ ‛ ends a single-quoted string unless doubled.
      let out = '';
      for (let i = 0; i < body.length; i++) {
        if (/['\u2018-\u201b]/.test(body[i])) {
          assert.equal(body[i + 1], body[i], `undoubled quote in ${p}`);
          i++;
        }
        out += body[i];
      }
      return out;
    })
    .join('');
}

function decodePhp(lit: string): string {
  if (lit.startsWith("'")) {
    const body = lit.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "'") assert.fail('unescaped quote');
      if (body[i] === '\\' && (body[i + 1] === '\\' || body[i + 1] === "'")) i++;
      out += body[i];
    }
    return out;
  }
  const body = lit.slice(1, -1);
  assert.ok(!/(^|[^\\])(\\\\)*\$/.test(body), 'unescaped $ in PHP double quotes');
  return decodeCStyle(body, { quote: '"' });
}

function decodeCs(lit: string): string {
  if (lit.startsWith('@"')) {
    const body = lit.slice(2, -1);
    assert.ok(!/(^|[^"])"("")*($|[^"])/.test(body.replace(/""/g, '')), 'lone quote in verbatim string');
    return body.replace(/""/g, '"');
  }
  return decodeCStyle(lit.slice(1, -1), { quote: '"' });
}

test('Go literals round-trip and raw strings never contain a backtick or CR', () => {
  for (const s of SAMPLES) assert.equal(decodeGo(goString(s)), s, s);
  assert.equal(goString('a\nb'), '`a\nb`');
  assert.equal(goString('a\n`b`'), '"a\\n`b`"');
  assert.equal(goString('a\r\nb'), '"a\\r\\nb"');
});

test('PowerShell literals: single quotes, typographic quotes doubled, $ and backtick inert, CR concatenated', () => {
  for (const s of SAMPLES) assert.equal(decodePs(psString(s)), s, s);
  assert.equal(psString(`it's ’$x \`n`), `'it''s ’’$x \`n'`);
  assert.equal(psString('a\r\nb'), `('a' + "\`r" + '\nb')`);
});

test('PHP literals round-trip; single quotes unless control characters', () => {
  for (const s of SAMPLES) assert.equal(decodePhp(phpString(s)), s, s);
  assert.equal(phpString(`a'b\\c $x`), `'a\\'b\\\\c $x'`);
  assert.equal(phpString('a\rb $x'), '"a\\rb \\$x"');
});

test('C# literals round-trip; verbatim strings for multi-line text', () => {
  for (const s of SAMPLES) assert.equal(decodeCs(csString(s)), s, s);
  assert.equal(csString('a\n"b"'), '@"a\n""b"""');
});

test('Java, JavaScript and Python literals evaluate to the original string (in the real interpreters)', { skip: !has('java') || !has('python3') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-lit-'));
  try {
    const expected = JSON.stringify(SAMPLES);
    // Python: print each literal's value as JSON.
    writeFileSync(join(dir, 'lit.py'), `import json\nprint(json.dumps([${SAMPLES.map(pyString).join(',\n')}]))\n`);
    const py = spawnSync('python3', ['lit.py'], { cwd: dir, encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.deepEqual(JSON.parse(py.stdout), SAMPLES);
    // JavaScript
    writeFileSync(join(dir, 'lit.mjs'), `console.log(JSON.stringify([${SAMPLES.map(jsString).join(',\n')}]))\n`);
    const js = spawnSync(process.execPath, ['lit.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(js.status, 0, js.stderr);
    assert.equal(js.stdout.trim(), expected);
    // Java: print code units as hex so the console encoding does not matter.
    const javaSrc = `public class Lit { public static void main(String[] a) { String[] s = {\n${SAMPLES.map((x) => javaString(x, '  ')).join(',\n')}\n}; for (String x : s) { StringBuilder b = new StringBuilder(); for (char c : x.toCharArray()) b.append(String.format("%04x", (int) c)); System.out.println(b); } } }\n`;
    writeFileSync(join(dir, 'Lit.java'), javaSrc);
    const jv = spawnSync('java', ['Lit.java'], { cwd: dir, encoding: 'utf8' });
    assert.equal(jv.status, 0, jv.stderr);
    const hex = (x: string) => [...Array(x.length).keys()].map((i) => x.charCodeAt(i).toString(16).padStart(4, '0')).join('');
    assert.deepEqual(jv.stdout.split('\n').slice(0, SAMPLES.length), SAMPLES.map(hex));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Python triple-quoted strings escape a delimiter quote only before another quote or the end', () => {
  assert.equal(pyString(`a\n'''b'`), `"""a\n'''b'"""`);
  assert.equal(pyString(`a\n"x" 'y'`), `'''a\n"x" 'y\\''''`);
  assert.equal(pyString(`a\n'''b"`), `'''a\n\\'\\''b"'''`);
});

// ---------------------------------------------------------------------------------------------
// Shape of individual snippets (incl. languages without an interpreter here)

const req = (r: Partial<HttpRequest>): HttpRequest => ({ method: 'POST', url: 'https://api.example.com/items', headers: [], ...r });

test('URLs: non-ASCII and spaces after the host are percent-encoded, {{unresolved}} and %XX left alone', () => {
  assert.equal(encodeUrl('https://h.test/café/a b?q=日&r=%2F'), 'https://h.test/caf%C3%A9/a%20b?q=%E6%97%A5&r=%2F');
  assert.equal(encodeUrl('{{host}}/x?y={{id}}'), '{{host}}/x?y={{id}}');
});

test('every target produces a snippet; cURL reuses toCurl', () => {
  const r = req({ headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"a":1}' });
  for (const t of CODE_TARGETS) assert.ok(generateCode(t.id, r).includes('api.example.com/items'), t.id);
  assert.equal(generateCode('curl', r), "curl https://api.example.com/items \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"a\":1}'");
});

test('Go: Host header goes to req.Host, method constants, file body via os.ReadFile', () => {
  const code = generateCode('go', req({ method: 'PUT', headers: [{ name: 'Host', value: 'example.org' }, { name: 'X-A', value: '1' }, { name: 'X-A', value: '2' }], body: '< ./data.bin' }));
  assert.match(code, /req\.Host = "example\.org"/);
  assert.match(code, /http\.NewRequest\(http\.MethodPut, "https:\/\/api\.example\.com\/items", bytes\.NewReader\(data\)\)/);
  assert.match(code, /data, err := os\.ReadFile\("\.\/data\.bin"\)/);
  assert.equal(code.match(/req\.Header\.Add\("X-A"/g)?.length, 2);
  assert.match(code, /import \(\n\t"bytes"\n\t"fmt"\n\t"io"\n\t"net\/http"\n\t"os"\n\)/);
  const custom = generateCode('go', req({ method: 'PURGE', body: 'x\ny' }));
  assert.match(custom, /http\.NewRequest\("PURGE", .*, body\)/);
  assert.match(custom, /strings\.NewReader\(`x\ny`\)/);
});

test('PowerShell: Content-Type and User-Agent as parameters, custom methods, UTF-8 bytes for non-ASCII, -InFile', () => {
  const code = generateCode('powershell', req({ headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'User-Agent', value: 'me' }, { name: 'X-Price', value: "$5 it's" }], body: '{"name":"café"}' }));
  assert.match(code, /\$headers = @\{\n {4}'X-Price' = '\$5 it''s'\n\}/);
  assert.match(code, /-Method Post/);
  assert.match(code, /-ContentType 'application\/json'/);
  assert.match(code, /-UserAgent 'me'/);
  assert.match(code, /-Body \(\[System\.Text\.Encoding\]::UTF8\.GetBytes\(\$body\)\)/);
  assert.match(generateCode('powershell', req({ method: 'PURGE' })), /-CustomMethod 'PURGE'/);
  assert.match(generateCode('powershell', req({ method: 'PUT', body: '< ./a b.bin' })), /-InFile '\.\/a b\.bin'/);
  assert.match(generateCode('powershell', req({ body: 'ascii' })), /-Body \$body$/m);
});

test('HTTPie: method, header items, --raw body, empty header, leading = escaped, file via stdin', () => {
  const code = generateCode('httpie', req({ headers: [{ name: 'X-A', value: "it's" }, { name: 'X-Empty', value: '' }, { name: 'X-Eq', value: '=1' }], body: '{"a":1}' }));
  assert.equal(code, `http \\\n  --raw '{"a":1}' \\\n  POST https://api.example.com/items \\\n  'X-A:it'\\''s' \\\n  'X-Empty;' \\\n  'X-Eq:\\=1'\n`);
  assert.equal(generateCode('httpie', req({ method: 'PUT', body: '< ./data.bin' })), `http \\\n  PUT https://api.example.com/items \\\n  < ./data.bin\n`);
});

test('PHP: CURLOPT_* array, NOBODY for HEAD, file_get_contents for files, empty header as Name;', () => {
  const code = generateCode('php-curl', req({ headers: [{ name: 'X-A', value: "it's $x" }, { name: 'X-Empty', value: '' }], body: 'a\\b' }));
  assert.match(code, /^<\?php\n/);
  assert.match(code, /CURLOPT_CUSTOMREQUEST => 'POST'/);
  assert.match(code, /'X-A: it\\'s \$x',/);
  assert.match(code, /'X-Empty;',/);
  assert.match(code, /CURLOPT_POSTFIELDS => 'a\\\\b',/);
  assert.match(generateCode('php-curl', req({ method: 'HEAD' })), /CURLOPT_NOBODY => true/);
  assert.doesNotMatch(generateCode('php-curl', req({ method: 'GET' })), /CUSTOMREQUEST/);
  assert.match(generateCode('php-curl', req({ body: '< ./x.bin' })), /CURLOPT_POSTFIELDS => file_get_contents\('\.\/x\.bin'\)/);
});

test('C#: content headers on request.Content, default text/plain removed, others TryAddWithoutValidation', () => {
  const code = generateCode('csharp', req({ headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Authorization', value: 'Bearer x' }, { name: 'X-A', value: '1' }, { name: 'X-A', value: '2' }], body: '{\n  "a": "\\"q\\""\n}' }));
  assert.match(code, /new HttpRequestMessage\(HttpMethod\.Post, "https:\/\/api\.example\.com\/items"\)/);
  assert.match(code, /request\.Headers\.TryAddWithoutValidation\("Authorization", "Bearer x"\);/);
  assert.equal(code.match(/TryAddWithoutValidation\("X-A"/g)?.length, 2);
  assert.match(code, /new StringContent\(@"\{\n {2}""a"": ""\\""q\\""""\n\}", Encoding\.UTF8\);/);
  assert.match(code, /request\.Content\.Headers\.ContentType = null;\nrequest\.Content\.Headers\.TryAddWithoutValidation\("Content-Type", "application\/json; charset=utf-8"\);/);
  assert.doesNotMatch(code, /request\.Headers\.TryAddWithoutValidation\("Content-Type"/);
  const file = generateCode('csharp', req({ method: 'PURGE', body: '< ./x.bin' }));
  assert.match(file, /new HttpMethod\("PURGE"\)/);
  assert.match(file, /new ByteArrayContent\(File\.ReadAllBytes\("\.\/x\.bin"\)\)/);
  assert.match(file, /^using System\.IO;$/m);
  assert.match(generateCode('csharp', req({ method: 'GET', headers: [{ name: 'Content-Type', value: 'a/b' }] })), /\/\/ Not sent: Content-Type/);
});

test('Java: restricted headers are left out with a comment', () => {
  const code = generateCode('java', req({ method: 'GET', headers: [{ name: 'Host', value: 'x' }, { name: 'Connection', value: 'close' }, { name: 'X-A', value: '1' }] }));
  assert.match(code, /\/\/ Not sent: Host, Connection/);
  assert.match(code, /\.GET\(\)/);
  assert.match(code, /\.header\("X-A", "1"\)/);
});

test('browser fetch says the file body is not inlined; Node reads it', () => {
  const r = req({ method: 'PUT', body: '< ./data.bin' });
  assert.match(generateCode('javascript-fetch', r), /The body is the file \.\/data\.bin; it is not inlined/);
  assert.match(generateCode('node-fetch', r), /import \{ readFile \} from 'node:fs\/promises';[\s\S]*body: await readFile\("\.\/data\.bin"\)/);
});

test('repeated headers are combined (", ", Cookie "; ") only for map-based clients', () => {
  const r = req({ method: 'GET', headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }, { name: 'Cookie', value: 'a=1' }, { name: 'Cookie', value: 'b=2' }] });
  assert.match(generateCode('python-requests', r), /"X-A": "1, 2",\n {4}"Cookie": "a=1; b=2",/);
  assert.match(generateCode('python-requests', r), /# Repeated headers are combined/);
  assert.equal(generateCode('curl', r).match(/-H 'X-A: 1'|-H 'x-a: 2'/g)?.length, 2);
  assert.equal(generateCode('java', r).match(/\.header\("[Xx]-[Aa]"/g)?.length, 2);
});

// ---------------------------------------------------------------------------------------------
// Resolution without sending (input to Copy as cURL / Copy as Code)

test('previewRequest resolves variables, keeps unknown and unsent chained ones, sends nothing', async () => {
  const file = '@host = https://api.example.com\n@token = {{login.response.body.$.token}}\n\n### Login\n# @name login\nPOST {{host}}/login\n\n###\nGET {{host}}/me?id={{$randomInt 5 6}}\n';
  const host = {
    readHttpFile: async () => file,
    readBodyFile: async (p: string) => new TextEncoder().encode(p === './tpl.json' ? '{"user":"{{user}}","missing":"{{nope}}"}' : ''),
    dotenv: async () => ({}),
    environment: () => ({ user: 'ada' }),
  };
  const r1 = await previewRequest({ method: 'GET', url: '{{host}}/me?id={{$randomInt 5 6}}', headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }, { name: 'X-Who', value: '{{user}}' }, { name: 'X-Off', value: '{{zzz}}', disabled: true }] }, host, 'f.http');
  assert.equal(r1.request.url, 'https://api.example.com/me?id=5');
  assert.deepEqual(r1.request.headers, [{ name: 'Authorization', value: 'Bearer {{login.response.body.$.token}}' }, { name: 'X-Who', value: 'ada' }]);
  assert.deepEqual(r1.unresolved, ['login.response.body.$.token']);

  const r2 = await previewRequest({ method: 'POST', url: 'localhost:3000/x', headers: [{ name: 'Authorization', value: 'Basic u:p' }], body: '<@ ./tpl.json' }, host, 'f.http');
  assert.equal(r2.request.url, 'http://localhost:3000/x');
  assert.equal(r2.request.headers[0].value, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(r2.request.body, '{"user":"ada","missing":"{{nope}}"}');
  assert.deepEqual(r2.unresolved, ['nope']);

  // `< file` stays a reference; GET bodies are dropped (the sender drops them); form lines are joined.
  assert.equal((await previewRequest({ method: 'PUT', url: 'http://x/', headers: [], body: '< ./data.bin' }, host, undefined)).request.body, '< ./data.bin');
  assert.equal((await previewRequest({ method: 'GET', url: 'http://x/', headers: [], body: 'ignored' }, host, undefined)).request.body, undefined);
  const form = await previewRequest({ method: 'POST', url: 'http://x/', headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'a=1\n&b=2' }, host, undefined);
  assert.equal(form.request.body, 'a=1&b=2');
});

test('previewRequest converts GraphQL requests, so every snippet sends the JSON Plainwire sends', async () => {
  const host = { readHttpFile: async () => '', readBodyFile: async () => new Uint8Array(), dotenv: async () => ({}), environment: () => ({ code: 'PL' }) };
  const req: HttpRequest = { method: 'POST', url: 'https://countries.example/graphql', headers: [{ name: 'X-REQUEST-TYPE', value: 'GraphQL' }], body: 'query Country($code: ID!) {\n  country(code: $code) { name }\n}\n\n{ "code": "{{code}}" }' };
  const r = await previewRequest(req, host, undefined);
  assert.ok(!r.request.headers.some((h) => h.name.toLowerCase() === 'x-request-type'));
  assert.ok(r.request.headers.some((h) => h.name.toLowerCase() === 'content-type' && /json/.test(h.value)));
  const body = JSON.parse(r.request.body ?? '');
  assert.deepEqual(body.variables, { code: 'PL' });
  assert.equal(body.operationName, 'Country');
  for (const t of CODE_TARGETS) assert.match(generateCode(t.id as CodeTarget, r.request), /query/, t.id);
});
