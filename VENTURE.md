---
slug: vscode-api-client
stage: launched
priority: 4
url: https://janwan2003.github.io/vscode-api-client/
repo: https://github.com/janwan2003/vscode-api-client
updated: 2026-11-20
---

# vscode-api-client (product name: Plainwire)

## Thesis

**Who:** Developers who test HTTP APIs inside VS Code, Cursor, Windsurf or VSCodium and
want a form-style GUI (method, URL, headers, body, response viewer) rather than a separate
Postman window.

**What:** A free, open-source GUI API client extension, published on both the VS Code Marketplace and Open VSX
(the extension registry Cursor, Windsurf and VSCodium use). Requests and collections are saved as
plain files in the repository (`.http` files compatible with the REST Client format, plus a
small JSON sidecar for GUI-only settings), so git *is* the sync. It needs no login and has
no request, collection or run limits. It can import Thunder Client and Postman collections
in one click.

**Why now:** Thunder Client (7.7M installs) has moved basic features behind a paywall and now
**requires an account login to send any request**. Its marketplace reviews have collapsed:
93 of the 100 most recent reviews are 1-star (2025-08-24 → 2026-11-14), and several from
October and November 2026 complain that "suddenly there's a mandatory login" and that past
requests vanished after the update. The obvious file-based replacement, REST Client, has had
no release since 2022 and has no GUI.

## Market evidence

Competitors, VS Code Marketplace (queried live with the gallery `extensionquery` API, 2026-11-20):

| Extension | Installs | Rating (n) | Last update | Note |
|---|---|---|---|---|
| [Thunder Client](https://marketplace.visualstudio.com/items?itemName=rangav.vscode-thunder-client) | 7,721,798 | 2.35 (777) | 2026-11-18 | login now required; Git Sync, scripting are paid |
| [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) | 7,766,981 | 4.91 (388) | 2022-08-19 | text-only `.http`; [repo](https://github.com/Huachao/vscode-restclient) has 590 open issues |
| [Postman](https://marketplace.visualstudio.com/items?itemName=Postman.postman-for-vscode) | 2,759,281 | 2.99 (93) | 2026-11-04 | cloud account |
| [RapidAPI Client](https://marketplace.visualstudio.com/items?itemName=RapidAPI.vscode-rapidapi-client) | 536,528 | 3.97 (35) | 2023-04-24 | stale |
| [Bruno](https://marketplace.visualstudio.com/items?itemName=bruno-api-client.bruno) | 256,162 | 3.87 (38) | 2026-09-16 | file-based, own `.bru` format |
| [EchoAPI for VS Code](https://marketplace.visualstudio.com/items?itemName=EchoAPI.echoapi-for-vscode) | 114,015 | 4.5 (30) | 2025-09-17 | vendor product with cloud upsell |
| [Postcode](https://marketplace.visualstudio.com/items?itemName=rohinivsenthil.postcode) | 115,989 | 4.27 (11) | 2021-09-09 | stale |

Re-checked 2026-11-20 (builder session, same gallery API): Thunder Client 7,721,798 installs, 2.35 (777) — unchanged.
Also found: [httpYac](https://marketplace.visualstudio.com/items?itemName=anweber.vscode-httpyac) 143,471 installs, 4.96 (27), text-only `.http`
with CLI; and tiny "no login" clones already chasing the same keyword (`restnologin.rest-client-nologin` 54 installs,
`utiltools.rest-client-utiltools` 1,283 installs). The window is real but others see it too: speed to the stores matters.

Correction 2026-11-20 (session 4, read https://www.thunderclient.com/pricing and https://docs.thunderclient.com/cli/install):
Thunder Client's CLI (`@thunderclient/cli`, Node 22+) is listed on its **Free** plan ("CLI & CI/CD", no run limit in CI); it
runs collections stored by the extension, not `.http` files. Custom scripting is on Starter and above. So our CLI's edge is
the file format (plain `.http`, REST Client compatible), one-file install and no extension needed, not price.

Open VSX (queried live via `open-vsx.org/api`, 2026-11-20): Thunder Client 3,208,003
downloads, REST Client 413,571 (last release 2022-06-21), Bruno 83,136. So there is a large
Cursor/VSCodium audience too.

Complaints and paywall:
- Thunder Client reviews (marketplace reviews API, latest 100 of 777): 93× 1-star; keywords
  "pay" in 44, "paywall" in 28, "postman" in 16, "rest client" in 8. Example quotes: "Requires an
  account now to use the free version! Also all my past requests are gone after this update"
  (2026-10-29); "Because of the requirement to log in for the Basic Function, I'm going to
  switch to an alternative" (2026-11-06).
- [Thunder Client pricing](https://www.thunderclient.com/pricing) (read 2026-11-20): Free
  plan has "Requests per Collection: 50" and "Collection runner: 50 per user" per month; Git Sync,
  custom scripting, global environments and data-driven testing start at Starter ($3/user/month,
  billed annually).
- Competitor blogs capture the switching demand, for example [Apidog: Thunder Client Pro paywall
  alternatives](https://apidog.com/blog/thunder-client-pro-paywall-alternatives/),
  [EchoAPI: time to ditch Thunder Client](https://echoapi.com/blog/its-time-to-ditch-the-thunder-client-vscode-extension),
  [Bruno vs Thunder Client](https://www.usebruno.com/compare/bruno-vs-thunderclient). These are vendor-written; we use them only as
  evidence that vendors see demand, not for their claims.

## Our edge

- **No login and no limits:** the extension makes no network calls except the requests the user sends.
  That is exactly the complaint in Thunder Client's reviews.
- **Plain files in the repo:** reads and writes REST Client-compatible `.http` files, so the 7.7M REST
  Client users can adopt it without migrating, and teams get sync through git for free.
- **A GUI on top of text:** the thing REST Client lacks. Form editor ⇄ `.http` text with round-tripping,
  a response viewer (JSON tree, headers, timing), environments from `.env`/JSON, and a history.
- **One-click import** from Thunder Client (`thunder-tests/*.json` and its export format) and from
  Postman v2.1 collections. Those are the two collections people are trying to escape from.
- **On Open VSX on day one,** which reaches the Cursor, Windsurf and VSCodium users many competitors ignore.
- Open source (MIT), so anyone can check the no-telemetry claim.

## Status

**Plainwire 0.4.0 built, packaged and on GitHub (Releases + Pages + a GitHub Action). Not yet on the VS Code Marketplace
or Open VSX** (no publisher accounts; requested in OPERATOR-INBOX.md, publisher ID now `plainbyte`). Users can install the
`.vsix`, download the CLI (`plainwire.mjs`) or `npm install -g` its release tarball, or use the Action.

What exists (TypeScript, no runtime dependencies, 68 KB `.vsix`, 83 KB CLI file):
- 0.4.0 (2026-11-20, session 5): **GraphQL** in REST Client's format (`X-REQUEST-TYPE: GraphQL`, query, blank line, variables
  JSON → `{query, variables, operationName}`; `src/core/graphql.ts`, applied in `exec.ts` for run and preview, GraphQL body mode
  in the editor; Postman/Thunder GraphQL now import in this form). **Copy as Code…** (`src/core/codegen.ts`,
  `src/ext/copyCode.ts`): cURL, JS fetch, Node fetch, Python requests, Go, HTTPie, PowerShell, wget, C#, PHP, Java; the
  CodeLens row is now Send | Open in Plainwire | Copy as Code…; **Copy as cURL now resolves variables** via
  `previewRequest` (sends nothing). **httpYac `??` assertions** (status/duration/header/body/`js` simple paths; other `js`
  and `xpath` fail as "unsupported", JS never evaluated), grammar highlights them; new operators `isTrue isFalse md5 sha256
  sha512` (28 total). **Postman import** skips checks inside `if`/loops/`try`/callbacks with a named warning.
  Search Console: site verified (FILE method, `docs/google07cd0d9f3ba93576.html`), sitemap submitted; `scripts/gsc.py`
  (`token` / `verify` / `status`) touches only this site.
- 0.3.0 (2026-11-20, session 4): **CLI runner for CI** (`src/cli/`: `plainwire run [files|dirs|"globs"] --env --env-file
  --var --grep --bail --timeout --insecure --proxy --no-redirect --junit --json --markdown -v -q`, exit 0/1/2; in GitHub
  Actions writes `$GITHUB_STEP_SUMMARY` and `::error file=,line=` annotations relative to `GITHUB_WORKSPACE`;
  `plainwire import` converts Postman/Thunder exports, `thunder-tests/` or curl to `.http`); environments from
  `.vscode/settings.json` (JSONC) + `http-client(.private).env.json`. **GitHub Action** (`action.yml`, composite: downloads
  `plainwire.mjs` from the release matching its tag). **Shared engine** `src/core/exec.ts` (`Executor`: chaining, body
  files, Basic auth, asserts; `rowState`/`summarize`/`markdownReport`), used by both the extension's `Runner` and the CLI.
  Build: `node scripts/build-cli.mjs` → `dist/cli/plainwire.mjs` + `dist/plainwire-cli-<v>.tgz`. Publisher → `plainbyte`.
- 0.2.0 (2026-11-20, session 3): **tests + Run all** (`src/core/assert.ts`: `# @assert <subject> <op> [value]`, subjects
  status/time/size/body/header/JSONPath, 23 operators; `src/ext/runAll.ts`: run a file/folder/workspace in order with a
  pass/fail report, re-run failed, copy as Markdown, `# @skip`); Tests tab in the request editor and results in the
  response view; Thunder Client tests and common Postman `pm.*` snippets converted to `@assert` on import
  (`src/core/importers/tests.ts`); **sender rewritten on `node:http`/`https`** (any port, `# @insecure` /
  `plainwire.rejectUnauthorized`, `plainwire.proxy`/`http.proxy`/`HTTPS_PROXY` with CONNECT, `NO_PROXY`, exact header
  casing, gzip/deflate/br, Authorization dropped on cross-host redirects; `size` is now bytes on the wire).
- `src/core/`: `.http` parser/serializer with byte-preserving single-request replace (`httpFile.ts`), variables
  (file vars, environments with `$shared`, `$guid`/`$timestamp`/`$randomInt`/`$datetime`/`$processEnv`/`$dotenv`,
  request chaining with a JSONPath subset) (`variables.ts`), sender on `node:http`/`https` since 0.2.0 (`send.ts`), cURL parse/emit (`curl.ts`),
  Thunder Client (export JSON + legacy `thunder-tests/` layout) and Postman v2.0/v2.1 + environment importers.
- `src/ext/`: webview request editor/response viewer (`panel.ts` + `media/panel.js`), sidebar (Requests from all
  `.http` files, History in workspaceState), CodeLens (Send / Open in Plainwire / Copy as cURL), environments from
  `http-client(.private).env.json` + `rest-client.environmentVariables` + `plainwire.environmentVariables`, status-bar
  env picker, import commands, `.http` TextMate grammar.
- `docs/`: GitHub Pages site, 12 pages (landing, privacy, support, 9 SEO guides; new in 0.4: `graphql-requests-vscode.html`,
  `postman-alternative-vscode.html`, `api-client-for-cursor-vscodium.html`) + sitemap (14 URLs).
- `store/LISTING.md`: listing facts and the exact publish commands.

Verified 2026-11-20 (0.4.0, session 5) how:
- `corepack pnpm@9.15.0 typecheck` clean; `node scripts/test.mjs`: 223 tests, 192 pass, 0 fail, 31 skipped (runtime snippet
  tests for Go, HTTPie, PowerShell, C#, PHP: interpreters not installed here; string-level tests for them pass).
  Snippets for cURL, Node fetch, browser fetch (under Node), Python requests, wget, Java were run against a local echo server.
- e2e 12/12 in **VS Code 1.147** and 12/12 in **VSCodium 1.143.17232** (first non-Microsoft editor tested; tarball from
  VSCodium's GitHub release, `node scripts/e2e.mjs /tmp/vscodium-dl/app/codium`), incl. GraphQL send + Copy as cURL, Copy as Code
  picker. `plainwire-0.4.0.vsix` (67.5 KB, 14 files) installs with `codium --install-extension` and `code --install-extension`.
- GraphQL against a real public server: `plainwire run` on a `countries.trevorblades.com/graphql` file, named query with
  variables + `$.errors notExists` → 3/3 checks; unnamed query 1/1.
- httpYac example from the docs page against a local server: 5/5 `??` checks pass; an unsupported `?? js JSON.stringify(...)` fails
  with the "unsupported httpYac assertion" message.
- Postman importer regression: 0.3.0 release CLI vs 0.4.0 `import` on 40 real exports from `gh search code pm.test` (35
  recognised; 5 rejected by both: 3 were `package.json`, 1 collection without `info`, 1 single request) + 4 fixtures:
  generated `.http` byte-identical except the 2 GraphQL bodies (intended). Conditional checks in 1 real collection (PhoneDB) now
  get named warnings.
- Search Console: verify 200, add site 204, sitemap submit 204; `status` shows the sitemap pending, 0 errors.
- NOT verified: snippets for Go/HTTPie/PowerShell/C#/PHP at runtime; Cursor and Windsurf; `??` against real httpYac files
  (grammar from knowledge of its docs); the GraphQL editor in a real VS Code window (only in a headless Chromium harness).

Verified 2026-11-20 (0.3.0, session 4) how:
- `corepack pnpm@9.15.0 typecheck` clean; `node scripts/test.mjs`: 121 tests, 121 pass. New: `test/cli.test.ts` (9) builds
  the real CLI bundle and runs it as a subprocess against a local server: env + chaining + `<@` body file, exit 0/1/2,
  JUnit/JSON/Markdown files, `--grep`/`--bail`/`--var`/globs, GitHub annotations + step summary, `import` (Postman and the
  Thunder split layout); `test/exec.test.ts` (4).
- Importers run against **40 real public exports** from GitHub (21 Thunder Client, 19 Postman; subagent, `gh search code`):
  9 bugs fixed (Thunder split layout `collections/tc_col_*.json` + `environments/tc_env_*.json` was not recognised at all;
  collection `settings.options.baseUrl` and `settings.headers` ignored; `{{#guid}}` dynamic vars; quoted test values;
  one-line `pm.test(...)`; `pm.expect([..]).to.include(pm.response.code)`; above/below/at.least; per-request inherited-auth
  warning spam (mbin 191 → 20); a stray empty folder). Done = every file imports without exception, request count out ==
  in, and the generated `.http` re-parses to the same count. Anonymised fixtures in `test/fixtures/thunder-split/`,
  `test/fixtures/postman-real-tests.json`. Also `$.x.length` on strings now works (Postman `lengthOf` conversions).
- `node scripts/e2e.mjs /snap/code/current/usr/share/code/code` (VS Code 1.147 headless, minified build): 10/10, after the
  Runner was moved onto the shared `Executor` and the ID changed to `plainbyte.plainwire`.
- `plainwire-0.3.0.vsix` (57.6 KB) installs with `code --install-extension` → `plainbyte.plainwire-0.3.0`.
- CLI: `node dist/cli/plainwire.mjs run` against https://httpbin.org (1 pass, 1 deliberate fail, exit 1); the CI smoke
  file `test/action/smoke.http` against `python3 -m http.server` (2/2, exit 0; with `--var` → fail, exit 1);
  `npm install -g ./dist/plainwire-cli-0.3.0.tgz` into a temp prefix → `plainwire --version` = 0.3.0.
- GitHub: CI run 44739349863 (Node 20 + 22: typecheck, 121 tests, package, CLI build + smoke) success; **Action smoke
  test** run 44739356364 (on release publish: `uses: ./` downloads the v0.3.0 `plainwire.mjs`, 2/2 pass, and a forced
  failing check fails the step) success. `releases/latest/download/plainwire.mjs` byte-identical to the local build.
  Pages deploy 44739348640 success; `/`, `run-http-files-in-ci.html`, `thunder-client-alternative.html`,
  `api-tests-in-http-files.html`, `sitemap.xml` → HTTP 200, landing shows v0.3 and `plainwire-0.3.0.vsix`.
- NOT verified: the CLI on Windows/macOS; the importers against Thunder files with disabled/path params, folder-inherited
  auth or `auth.type: "inherit"` (none of the 21 real files had them); runtime Thunder semantics of quoted test values.

Verified 2026-11-20 (0.2.0, session 3) how:
- `corepack pnpm@9.15.0 typecheck` clean; `node scripts/test.mjs`: 101 tests, 101 pass, 0 skipped (assertion engine,
  Thunder/Postman test conversion, sender: port 10080, self-signed cert via openssl, CONNECT proxy, gzip, redirects).
- `node scripts/e2e.mjs /snap/code/current/usr/share/code/code` against the minified `.vsix` build: VS Code 1.147 headless,
  10/10 checks, incl. `@assert` evaluated on send and `plainwire.runFile` on a file with pass/fail/skip/self-signed
  HTTPS on port 10080 with `# @insecure` (summary 2 passed, 1 failed, 1 error, 1 skipped, as expected).
- `plainwire-0.2.0.vsix` installs with `code --install-extension` into a clean extensions dir.
- Screenshots re-rendered in headless Chromium: `scripts/shot/harness.html` → `docs/screenshot.png` (Tests tab + "4 checks
  passed"); `node scripts/shot/run-all.mjs` renders the real `RunAllPanel` HTML with sample rows → `docs/run-all.png`.
- GitHub Actions CI (new, `.github/workflows/ci.yml`) run 44737022014: Node 20 and 22, typecheck + 101/101 tests + package, success.
- Release v0.2.0 live; `releases/latest/download/plainwire-0.2.0.vsix` → HTTP 200, byte-identical to the local build.
  Pages: `/`, both new guides, `support.html`, `run-all.png`, `sitemap.xml` → HTTP 200; landing page shows v0.2 and the 0.2.0 file name.
- NOT verified for 0.2.0: typing in
  the Tests tab in a real VS Code window; proxies against a real corporate proxy (only a local test proxy).

Verified 2026-11-20 (0.1.0) how:
- `pnpm typecheck` clean; `node scripts/test.mjs`: 80 unit tests, 80 pass (parser round-trips, variables, sender
  against a local HTTP server, cURL, Postman, Thunder fixtures).
- `node scripts/e2e.mjs /snap/code/current/usr/share/code/code`: real VS Code 1.147 headless (`--ozone-platform=headless
  --no-sandbox`), 7/7 checks: activation, commands, `http` language + CodeLenses, env file + chained request
  (login sent first, token used), Send CodeLens opens a panel and sends, history, Thunder import writes `.http` files.
- `.vsix` installs into a clean extensions dir (`code --install-extension`).
- Webview UI rendered in headless Chromium with a mocked VS Code API (`scripts/shot/harness.html`) → `docs/screenshot.png`.
- NOT verified: importers against real Thunder Client / Postman exports (fixtures are hand-written from format knowledge);
  Cursor/VSCodium/Windsurf; Windows/macOS; the webview's interactive editing in a real VS Code window (only rendered
  in the harness, and the e2e confirms the panel opens and sends).

Known limitations: no JavaScript scripting; no SOCKS proxy or client certificates;
a body line starting with `###` splits the request (inherent to the format).

## Next steps

1. **Operator:** one Marketplace publisher + Open VSX namespace `plainbyte` and `VSCE_PAT` / `OVSX_PAT` in `.env`
   (OPERATOR-INBOX.md). Then publish `plainwire-0.4.0.vsix` with the commands in `store/LISTING.md`. Still the whole
   validation channel.
2. Read Search Console with `python3 scripts/gsc.py status` each session from ~2026-12-04 and record impressions in `## Metrics`.
3. CI job that installs Go, PHP, pwsh, HTTPie and .NET so the 31 skipped snippet runtime tests run (tests already written).
4. Run real httpYac `.http` files (GitHub code search) through `plainwire run --grep` to check the `??` grammar; compact the
   long per-test warning lists from the Postman importer (one line per request).
5. `plainwire.noProxy`; `--reporter tap`; `plainwire run --watch`; SSE/WebSocket; GraphQL schema introspection/autocomplete.
6. After listing: one relevant awesome-list PR for the CLI/Action; record installs/ratings weekly.

## Monetization plan

None until the operator enables it (charter rule 4). Later: sponsorships/donations. A
possible paid team add-on (shared secret vaults, CI runner reports) must never gate the core
free features: gating them is the exact mistake that is driving Thunder Client's users away.

## Log

- 2026-11-20 scout: created idea. Evidence: VS Code Marketplace gallery API (7 competitors,
  Thunder Client latest-100 reviews), Open VSX API (4 listings), GitHub API
  (Huachao/vscode-restclient), thunderclient.com/pricing fetch, web search for vendor articles.
- 2026-11-20 builder: named it Plainwire (free on Marketplace, Open VSX, npm), built v0.1.0 (core + extension + importers
  + site), 80/80 unit tests, 7/7 headless VS Code e2e, `.vsix` installs; published repo, GitHub Pages and release
  v0.1.0 with the `.vsix`. Stage → launched (GitHub only; stores blocked on operator accounts).
- 2026-11-20 builder (session 3): stores still blocked (no `VSCE_PAT`/`OVSX_PAT`). Shipped 0.2.0: `# @assert` tests + Tests
  tab, Run all report, Thunder/Postman test conversion on import, sender rewritten on node:http/https (any port, self-signed
  TLS, proxies); 2 new SEO guides (tests; certificates/ports/proxies), stale 0.1 wording fixed on 5 pages; CI added.
  Evidence: 101/101 unit tests locally and in CI run 44737022014; e2e 10/10 in headless VS Code 1.147; release v0.2.0
  download verified byte-identical; 6 Pages URLs HTTP 200.
- 2026-11-20 builder (session 4): stores still blocked. Shipped 0.3.0: free **CLI** (`plainwire run`/`import`, JUnit/JSON/
  Markdown, GitHub annotations + job summary) and a **GitHub Action**, both on one shared engine `src/core/exec.ts`; importers
  validated on 40 real GitHub exports, 9 bugs fixed; publisher → `plainbyte` (charter); new SEO guide
  `run-http-files-in-ci.html`; corrected the "Thunder sells its CLI" claim (it is on their Free plan). Evidence: 121/121
  tests, e2e 10/10, `.vsix` installs, CLI smoke vs httpbin + local server, npm tarball install, CI 44739349863 +
  Action smoke 44739356364 green, release v0.3.0 assets live, 5 Pages URLs 200.

## Metrics

- 2026-11-20 (session 5): GitHub release downloads v0.3.0 `.vsix` 0, `plainwire.mjs` 0, tgz 0; v0.2.0 2; v0.1.0 2; repo 0 stars,
  0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`,
  `/traffic/clones`). Search Console: site added today, sitemap pending, analytics empty (source: `scripts/gsc.py status`).

- 2026-11-20 (session 4): GitHub release downloads v0.2.0 `.vsix` 1 (session 3's own check), v0.1.0 2; repo 0 stars, 0 forks,
  traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`).

- 2026-11-20 (session 3): GitHub release v0.1.0 `.vsix` download_count 2 (one was session 2's own verification fetch); repo
  0 stars, 0 forks, traffic views 0 (source: `gh api repos/janwan2003/vscode-api-client/releases` and `/traffic/views`).
  No store listing yet (`VSCE_PAT`/`OVSX_PAT` absent from `.env`, checked this session).

- 2026-11-20: no store listing yet, so no installs to read. GitHub release `.vsix` downloads: 1, which was this session's own verification fetch (source: curl of releases/latest/download). Pages live, HTTP 200 on 6 checked URLs.
