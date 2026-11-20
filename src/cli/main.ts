import { CookieJar } from '../core/cookies.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Executor, requestLabel, rowState, summarize, markdownReport } from '../core/exec.ts';
import { fetchText } from '../core/fetchText.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import { attachEnvironments, collectionsToFiles, detectAndImport } from '../core/importers/index.ts';
import { importThunderWorkspace } from '../core/importers/thunder.ts';
import type { ImportedCollection, ParsedRequest } from '../core/model.ts';
import { OAuth2Manager } from '../core/oauth2.ts';
import { describeNetworkError, sendRequest, type SendOptions } from '../core/send.ts';
import type { HttpRequest } from '../core/model.ts';
import { spawn } from 'node:child_process';
import { mergeEnvironment, parseDotenv } from '../core/variables.ts';
import { loadEnvironments } from './env.ts';
import { findHttpFiles, walk } from './files.ts';
import { failureText, githubAnnotations, jsonReport, junitReport, type CliRow } from './report.ts';

declare const PLAINWIRE_VERSION: string;
const VERSION = typeof PLAINWIRE_VERSION === 'string' ? PLAINWIRE_VERSION : 'dev';

const HELP = `plainwire ${VERSION}: run and test .http files from the command line (REST Client / JetBrains format)

Usage:
  plainwire run [files, folders or "globs"...] [options]   Send every request in order and check its # @assert lines
  plainwire import <export.json | openapi.yaml | https://… | thunder-tests/>... [--out dir]
                                                          Convert Thunder Client / Postman exports, OpenAPI / Swagger
                                                          definitions (a file or a URL) or a curl command file to
                                                          .http files

Run options:
  -e, --env <name>          Environment from http-client.env.json / http-client.private.env.json / .vscode/settings.json
      --env-file <file>     Extra environment file (http-client.env.json format); repeatable
      --var <name=value>    Set a variable (wins over the environment); repeatable
  -g, --grep <regex>        Only run requests whose title, @name or URL matches
      --bail                Stop after the first failed request
      --timeout <ms>        Per-request timeout (default 60000)
  -k, --insecure            Accept self-signed / invalid TLS certificates
      --proxy <url>         HTTP proxy (default: HTTPS_PROXY / HTTP_PROXY; NO_PROXY is honoured)
      --no-redirect         Do not follow redirects
      --no-cookie-jar       Do not remember cookies between requests (default: cookies set by a
                            response are sent with later requests of the run, like a browser)
      --junit <file>        Write a JUnit XML report
      --json <file>         Write a JSON report
      --markdown <file>     Write a Markdown report
  -v, --verbose             Print the response body of failed requests
  -q, --quiet               Only print failures and the summary
      --no-color            No colours (also NO_COLOR=1)

In GitHub Actions the run also writes a job summary and marks failed requests in the PR diff.
A request passes when all its # @assert lines pass; without asserts, when its status is below 400.
# @skip skips a request. Exit code: 0 all passed, 1 something failed, 2 usage error.

Examples:
  plainwire run api/ --env staging --junit results.xml
  plainwire run "tests/**/*.http" --var token=$API_TOKEN --bail
  plainwire import postman_collection.json --out http/
  plainwire import https://petstore3.swagger.io/api/v3/openapi.json --out petstore/
`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
      process.stdout.write(HELP);
      return cmd ? 0 : 2;
    }
    if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (cmd === 'run') return await run(rest);
    if (cmd === 'import') return await importCmd(rest);
    // `plainwire api.http` is a shortcut for `plainwire run api.http`.
    if (/\.(http|rest)$/i.test(cmd) || existsSync(cmd)) return await run(argv);
    throw new UsageError(`Unknown command "${cmd}". Try: plainwire run [files...] or plainwire --help`);
  } catch (e) {
    // Usage errors, unknown options (ERR_PARSE_ARGS_*), unreadable env or .http files.
    process.stderr.write(`plainwire: ${(e as Error).message}\n`);
    return 2;
  }
}

function colors(enabled: boolean) {
  const c = (code: number) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: c(32), red: c(31), yellow: c(33), dim: c(2), bold: c(1), cyan: c(36) };
}

async function run(args: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      env: { type: 'string', short: 'e' },
      'env-file': { type: 'string', multiple: true },
      var: { type: 'string', multiple: true },
      grep: { type: 'string', short: 'g' },
      bail: { type: 'boolean' },
      timeout: { type: 'string' },
      insecure: { type: 'boolean', short: 'k' },
      proxy: { type: 'string' },
      'no-redirect': { type: 'boolean' },
      'no-cookie-jar': { type: 'boolean' },
      junit: { type: 'string' },
      json: { type: 'string' },
      markdown: { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      quiet: { type: 'boolean', short: 'q' },
      'no-color': { type: 'boolean' },
      color: { type: 'boolean' },
    },
  });
  const cwd = process.cwd();
  const col = colors(!o['no-color'] && !process.env.NO_COLOR && (Boolean(o.color) || Boolean(process.stdout.isTTY) || process.env.GITHUB_ACTIONS === 'true'));
  const out = (s: string) => process.stdout.write(s + '\n');
  const timeoutMs = o.timeout !== undefined ? Number(o.timeout) : 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds, got "${o.timeout}"`);
  let grep: RegExp | undefined;
  if (o.grep !== undefined) {
    try {
      grep = new RegExp(o.grep, 'i');
    } catch (e) {
      throw new UsageError(`--grep is not a valid regular expression: ${(e as Error).message}`);
    }
  }

  // Environment.
  const envFiles = (o['env-file'] ?? []).map((f) => resolve(cwd, f));
  for (const f of envFiles) if (!existsSync(f)) throw new UsageError(`--env-file ${relative(cwd, f)} does not exist`);
  const { envs, sources } = loadEnvironments(cwd, envFiles);
  const names = Object.keys(envs).filter((n) => n !== '$shared');
  if (o.env && !envs[o.env]) {
    throw new UsageError(`Environment "${o.env}" not found. ${names.length ? `Available: ${names.join(', ')}` : 'No http-client.env.json, http-client.private.env.json or .vscode/settings.json environments found'} (searched under ${cwd}).`);
  }
  const environment = mergeEnvironment(envs, o.env);
  for (const kv of o.var ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new UsageError(`--var expects name=value, got "${kv}"`);
    environment[kv.slice(0, i).trim()] = kv.slice(i + 1);
  }

  // Files and plan.
  const { files, missing } = findHttpFiles(positionals, cwd);
  if (missing.length) throw new UsageError(`Not found: ${missing.join(', ')}`);
  const plan: { file: string; req: ParsedRequest; index: number }[] = [];
  for (const file of files) {
    const parsed = parseHttpFile(readFileSync(file, 'utf8'));
    parsed.requests.forEach((req, index) => {
      if (grep && !grep.test([req.title ?? '', req.name ?? '', req.url].join('\n'))) return;
      plan.push({ file, req, index });
    });
  }
  if (!plan.length) {
    throw new UsageError(
      files.length ? `No requests${grep ? ` matching --grep ${o.grep}` : ''} in ${files.length} file${files.length === 1 ? '' : 's'}.` : `No .http or .rest files found${positionals.length ? ` in ${positionals.join(' ')}` : ` under ${cwd}`}.`,
    );
  }

  const proxy = o.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sendOptions = (req: HttpRequest): SendOptions => ({
    timeoutMs,
    followRedirects: !o['no-redirect'] && req.meta?.['no-redirect'] === undefined,
    rejectUnauthorized: !o.insecure && req.meta?.['insecure'] === undefined,
    proxy,
    noProxy,
    userAgent: `plainwire/${VERSION}`,
  });
  // OAuth 2 ({{$auth.token("id")}}): tokens live for this run. Browser sign-ins print the URL (and open
  // a browser when run in a terminal); in CI use Client Credentials or Password.
  const oauth2 = new OAuth2Manager({
    send: (req, signal) => sendRequest(req, { ...sendOptions(req), signal }),
    openBrowser: (url) => {
      process.stderr.write(`Open this URL to sign in:\n  ${url}\n`);
      if (process.stderr.isTTY && !process.env.CI) openInBrowser(url);
    },
    showDeviceCode: ({ id, userCode, verificationUri }) => process.stderr.write(`Auth "${id}": enter the code ${userCode} at ${verificationUri}\n`),
    log: (m) => {
      if (o.verbose) process.stderr.write(col.dim(m) + '\n');
    },
  });
  const exec = new Executor({
    readHttpFile: async (file) => readFileSync(file, 'utf8'),
    resolveImport: (p, file) => (isAbsolute(p) ? p : resolve(dirname(file), p)),
    readBodyFile: async (p, file) => readFileSync(isAbsolute(p) ? p : resolve(file ? dirname(file) : cwd, p)),
    dotenv: async (file) => {
      for (const d of [file ? dirname(file) : undefined, cwd]) {
        if (d && existsSync(join(d, '.env'))) return parseDotenv(readFileSync(join(d, '.env'), 'utf8'));
      }
      return {};
    },
    environment: () => environment,
    cookieJar: o['no-cookie-jar'] ? undefined : new CookieJar(),
    sendOptions,
    oauth2,
  });

  if (!o.quiet) {
    const envLine = o.env ? `environment ${col.bold(o.env)}` : names.length ? `no environment (available: ${names.join(', ')})` : 'no environment';
    out(col.dim(`plainwire ${VERSION} · ${plan.length} request${plan.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} · ${envLine}${sources.length && o.env ? ` from ${sources.join(', ')}` : ''}`));
  }

  const rel = (f: string, from = cwd) => {
    const r = relative(from, f);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : f;
  };
  const rows: CliRow[] = plan.map(({ file, req, index }) => ({
    file: rel(file),
    line: req.requestLine + 1,
    index,
    method: req.method,
    label: requestLabel(req),
    state: req.meta && 'skip' in req.meta ? 'skipped' : 'pending',
    assertions: [],
  }));
  const started = Date.now();
  let lastFile = '';
  let bailed = false;
  for (let i = 0; i < plan.length; i++) {
    const row = rows[i];
    if (!o.quiet && row.file !== lastFile) {
      out(`\n${col.bold(row.file)}`);
      lastFile = row.file;
    }
    if (row.state === 'skipped' || bailed) {
      row.state = 'skipped';
      if (bailed) row.error = 'Not run (--bail)';
      if (!o.quiet) out(`  ${col.yellow('-')} ${row.method} ${row.label} ${col.dim(bailed ? '(not run, --bail)' : '(skipped)')}`);
      continue;
    }
    try {
      const { response, assertions } = await exec.run(plan[i].req, plan[i].file);
      row.status = response.status;
      row.timeMs = response.timeMs;
      row.assertions = assertions;
      if (response.events) row.stream = { events: response.events.length, end: response.streamEnd ?? 'closed', ...(response.status === 101 ? { sent: response.events.filter((e) => e.event === 'sent').length } : {}) };
      row.state = rowState(response.status, assertions);
      if (row.state === 'fail') row.responseBody = response.bodyEncoding === 'utf8' ? response.body.slice(0, 4000) : `(${response.size} bytes of binary data)`;
    } catch (e) {
      row.state = 'error';
      row.error = describeNetworkError(e).replace(/Set "plainwire\.rejectUnauthorized": false to accept it \(or add # @insecure above the request\)\./, 'Run with --insecure to accept it (or add # @insecure above the request).');
    }
    const ok = row.state === 'pass';
    if (!o.quiet || !ok) {
      if (o.quiet && row.file !== lastFile) {
        out(`\n${col.bold(row.file)}`);
        lastFile = row.file;
      }
      const meta = [row.status !== undefined ? String(row.status) : '', row.timeMs !== undefined ? `${row.timeMs} ms` : '', row.stream ? streamMeta(row.stream) : '', row.assertions.length ? `${row.assertions.filter((a) => a.passed).length}/${row.assertions.length} checks` : '']
        .filter(Boolean)
        .join(' · ');
      out(`  ${ok ? col.green('✓') : col.red('✗')} ${row.method} ${row.label} ${col.dim(meta)}`);
      if (!ok) {
        for (const l of failureText(row).split('\n')) out(`      ${col.red(l)}`);
        out(`      ${col.dim(`at ${row.file}:${row.line}`)}`);
        if (o.verbose && row.responseBody) out(row.responseBody.split('\n').map((l) => `      ${col.dim('│')} ${l}`).join('\n'));
      }
    }
    if (!ok && o.bail) bailed = true;
  }
  const s = summarize(rows, Date.now() - started);
  const parts = [col.green(`${s.passed} passed`), s.failed ? col.red(`${s.failed} failed`) : `${s.failed} failed`];
  if (s.errors) parts.push(col.red(`${s.errors} errors`));
  if (s.skipped) parts.push(col.yellow(`${s.skipped} skipped`));
  out(`\n${parts.join(', ')} ${col.dim(`(${s.total} requests, ${s.timeMs} ms)`)}`);

  const write = (path: string, content: string) => {
    const p = resolve(cwd, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    if (!o.quiet) out(col.dim(`Wrote ${rel(p)}`));
  };
  const title = positionals.length ? positionals.join(' ') : 'all .http files';
  if (o.junit) write(o.junit, junitReport(rows, s));
  if (o.json) write(o.json, jsonReport(rows, s));
  if (o.markdown) write(o.markdown, markdownReport(title, rows, s) + '\n');
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Annotations need paths relative to the repository root, not to --working-directory.
    const ws = process.env.GITHUB_WORKSPACE || cwd;
    for (const a of githubAnnotations(rows.map((r, i) => ({ ...r, file: rel(plan[i].file, ws) })))) out(a);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownReport(title, rows, s) + '\n\n');
      } catch {
        /* the summary is a nice-to-have */
      }
    }
  }
  return s.failed + s.errors ? 1 : 0;
}

async function importCmd(args: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string', short: 'o' }, force: { type: 'boolean' }, insecure: { type: 'boolean', short: 'k' }, proxy: { type: 'string' } } });
  if (!positionals.length) throw new UsageError('import needs at least one file: a Postman or Thunder Client export (.json), an OpenAPI / Swagger definition (.json, .yaml, or its https:// URL), a thunder-tests/ folder, or a file with a curl command');
  const cwd = process.cwd();
  const outDir = resolve(cwd, o.out ?? 'http');
  let collections: ImportedCollection[] = [];
  for (const p of positionals) {
    if (/^https?:\/\//i.test(p)) {
      const proxy = o.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;
      const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const { text, fileName, url } = await fetchText(p, { rejectUnauthorized: !o.insecure, proxy, noProxy, userAgent: `plainwire/${VERSION}` });
      collections.push(...detectAndImport(text, fileName, url));
      continue;
    }
    const abs = resolve(cwd, p);
    if (!existsSync(abs)) throw new UsageError(`Not found: ${p}`);
    if (statSync(abs).isDirectory()) collections.push(...importThunderDir(abs));
    else collections.push(...detectAndImport(readFileSync(abs, 'utf8'), abs.split(/[\\/]/).pop()));
  }
  collections = attachEnvironments(collections);
  let requests = 0;
  const warnings: string[] = [];
  for (const c of collections) {
    requests += c.folders.reduce((n, f) => n + f.requests.length, 0);
    warnings.push(...c.warnings.map((w) => `${c.name}: ${w}`));
  }
  const written: string[] = [];
  for (const f of collectionsToFiles(collections)) {
    let target = join(outDir, f.path);
    if (!o.force) for (let n = 2; existsSync(target); n++) target = join(outDir, f.path.replace(/(\.[^./]+)$/, `-${n}$1`));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    written.push(relative(cwd, target).split(sep).join('/'));
  }
  process.stdout.write(`Imported ${requests} request${requests === 1 ? '' : 's'} into ${written.length} file${written.length === 1 ? '' : 's'}:\n${written.map((w) => `  ${w}\n`).join('')}`);
  if (warnings.length) process.stdout.write(`Not converted (${warnings.length}):\n${warnings.map((w) => `  - ${w}\n`).join('')}`);
  return 0;
}

/** A Thunder Client `thunder-tests/` folder (legacy single files and the newer per-collection layout). */
function importThunderDir(dir: string): ImportedCollection[] {
  const read = (name: string) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined);
  const collections: ImportedCollection[] = [];
  const legacy = { collections: read('thunderCollection.json'), requests: read('thunderclient.json'), environments: read('thunderEnvironment.json') };
  if (legacy.collections || legacy.requests) collections.push(...importThunderWorkspace(legacy));
  for (const sub of ['collections', 'environments']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of walk(d, (p) => p.endsWith('.json'))) {
      try {
        collections.push(...detectAndImport(readFileSync(f, 'utf8'), f.split(/[\\/]/).pop()));
      } catch (e) {
        process.stderr.write(`Skipped ${relative(dir, f)}: ${(e as Error).message}\n`);
      }
    }
  }
  if (!collections.length) throw new UsageError(`No Thunder Client collections found in ${relative(process.cwd(), dir) || dir}.`);
  return collections;
}

/** Best effort: open a URL in the default browser (the URL is printed too). */
function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // printed above
  }
}

/** `3 events (closed)` for server-sent events; `1 sent, 2 received (done)` for a WebSocket. */
function streamMeta(st: NonNullable<CliRow['stream']>): string {
  if (st.sent !== undefined) return `${st.sent} sent, ${st.events - st.sent} received (${st.end})`;
  return `${st.events} event${st.events === 1 ? '' : 's'} (${st.end})`;
}
