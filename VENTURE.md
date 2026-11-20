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

REST Client's most-reacted open issues (GitHub search API, `repo:Huachao/vscode-restclient is:issue is:open sort:reactions`,
2026-11-20; 528 open issues, last release 0.25.1 on 2022-08-19 per the gallery API): #182 import another .http file (84), #724
sequential execution (62), #267 tests (59), #229 rest-client.env.json (53), #493 SSE (49), #432 CLI runner (44), #627 IntelliJ
compatibility (41), #444 send all in a file (36), #302 OAuth login (33), #521 JS evaluation (29). Plainwire already does
#724/#267/#432/#444 and partly #229/#627 → `docs/rest-client-alternative.html`. Also open: #173 WebSocket client (28 reactions,
GitHub search API 2026-11-20), done in 0.12.0. Since session 8 also #182 (`# @import`, 0.6.0)
and #493 (SSE, 0.7.0), so 6 of the top 10 are done. Since session 13 (0.13.0) also #521 (JavaScript evaluation, via JetBrains
`< {% %}` / `> {% %}` handlers) and most of #627 (IntelliJ compatibility: handlers now run), so 7 of the top 10, 8 counting #627.

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
- **OpenAPI / Swagger → ready-to-run `.http` files** (session 7): every operation with example body, auth and a status check, so
  an API's definition becomes a smoke-test suite for Run all and the CLI.
- **REST Client's two most-wanted gaps closed** (session 8): import another `.http` file (#182, 84 reactions) and
  server-sent events with live view, Stop and checks on events (#493, 49 reactions), in the extension and the CLI.
- **Session logins work** (session 9, 0.9.0): a cookie jar like a browser's (RFC 6265, cookies set on redirect hops kept), shown
  in a Cookies tab and checkable with `# @assert cookie <name>`, in the extension and the CLI. Before this, any cookie-based login
  (Django, Rails, Laravel, Express sessions) failed on the second request.
- **OAuth 2.0 without a GUI vendor** (session 10, 0.10.0): `{{$auth.token("id")}}` with the JetBrains HTTP Client's own `Security.Auth`
  config, so files move between IntelliJ and VS Code; all five grants incl. Authorization Code + PKCE via a loopback redirect, cached and
  refreshed, in the extension and the CLI. REST Client has none (#302). Plus a form **environment editor** with secrets kept in the
  git-ignored private file (what Thunder Client switchers expect).
- **Folders and drag and drop over plain files** (session 11, 0.11.0): the sidebar mirrors the workspace's folders → `.http` files →
  requests, with drag to reorder/move, rename, duplicate, move to file, delete. Thunder Client's tree UX, but every edit is a minimal
  text edit that leaves the rest of the file byte for byte (small git diffs), which neither REST Client (no tree) nor Thunder (JSON
  storage) offers.
- **WebSocket in the same files** (session 12, 0.12.0): JetBrains-format `WEBSOCKET` scripts with replies checked in CI. REST Client
  has none (#173, 28 reactions); our sent/received view and `messages[-1].data` checks work in the CLI too.
- **Scripts without a paywall** (session 13, 0.13.0): JetBrains-format `< {% %}` pre-request scripts and `> {% %}` response handlers
  (`client.test`, `client.global.set`, `crypto` HMAC) run in the extension and the CLI, and imported **Postman scripts keep running**
  through a `pm` compatibility layer (`pm.test`, `pm.expect`, `pm.environment.set`, legacy `tests[]`). Thunder Client sells scripting
  (Starter plan); REST Client has none (#521); Postman switchers no longer lose their test scripts on import.
- **A response you can query** (session 14, 0.14.0): side-by-side request/response with a draggable divider, a JSONPath/text filter on
  the response, and *+ Add as test* that turns a filtered value into an `# @assert`. Exploring an API becomes its test suite.
- **On Open VSX on day one,** which reaches the Cursor, Windsurf and VSCodium users many competitors ignore.
- Open source (MIT), so anyone can check the no-telemetry claim.

## Status

**Plainwire 0.14.0 built, packaged and on GitHub (Releases + Pages + a GitHub Action), plus three free in-browser converter
tools on the site. Not yet on the VS Code Marketplace
or Open VSX** (no publisher accounts; requested in OPERATOR-INBOX.md, publisher ID now `plainbyte`). Users can install the
`.vsix`, download the CLI (`plainwire.mjs`) or `npm install -g` its release tarball, or use the Action.

What exists (TypeScript, no runtime dependencies, 133 KB `.vsix`, 171 KB CLI file):
- 0.14.0 (2026-11-20, session 14): **first hand-walk of the request editor in a real VS Code window** (headless VS Code 1.147 +
  DevTools; webview driven through a CDP isolated world because headless windows deliver no keyboard focus into webviews), then fixes
  for what it showed. `media/panel.js`: **layout** auto/cols/rows (`SIDE_BY_SIDE_MIN` 820 px, was a 1100 px CSS media query, so on
  ordinary laptops the response sat under the request and was squeezed by the Scripts tab), *Side by side / Stack* button, draggable
  `.gutter` (ratio 0.15–0.85, double-click resets), stored in `globalState` key `plainwire.panelLayout` via message `layout` and
  broadcast to other open tabs (`src/ext/panel.ts` `PanelLayout`, `PanelDeps.ui`). **Response filter**: `drawBody` + `jsonQuery`
  (JSONPath: `.k`, `['k','j']`, `[n]`, `[-n]`, `[a:b]`, `[*]`, `.*`, `..k`, `..*`, `[?(@.k)]`, `[?(@.k op v)]` with == != < <= > >= =~);
  non-`$` text = grep with `<mark>` and line numbers; **+ Add as test** on a single plain-path value → `# @assert $.p == v`. URL box
  focused on New Request; "1 check passed"; request tabs wrap. `test/panelFilter.test.ts` extracts `jsonQuery` from panel.js.
  `scripts/shot/live/` (driver.cjs control server on :9444, cdp.mjs eval/shot/sash, server.mjs local API on :8787, hero.sh) made the
  **real** `docs/screenshot.png` (sidebar + side-by-side editor + 4 passing checks), replacing the webview-only render from 0.2.0.
- 0.13.0 (2026-11-20, session 13): **JavaScript scripts** in the JetBrains HTTP Client format. `src/core/scripts.ts`: `scriptSources`
  (inline `{% %}`, multi-line, `< file.js` / `> file.js`; httpYac `{{ }}` and `/* */` skipped) and `runScript` (`node:vm` context, 5 s
  timeout, `client.test/assert/log/exit/global.*`, `request.*` incl. `variables.set` and `tryGetSubstituted`, `response.status/body/
  headers.valueOf/contentType`, stream `onEachMessage` replay, `crypto` hash/HMAC, `$random`, `jsonPath`, `btoa/atob`; never throws).
  `variables.ts`: `requestVariables` (first) and `globals` (after env, before chaining). `exec.ts`: pre-request scripts before auth/
  resolve (error → "Not sent: …"), handlers after `# @assert`, `client.test` results appended to `assertions`, `ExecResult.logs`,
  `ExecHost.runScripts/globals/onGlobalsChanged`, unresolved-variable error names the request whose handler sets it, preview runs
  pre-request scripts on copies. `src/core/pmShim.ts`: Postman `pm` API (test/expect chain/response/variables, legacy `tests[]`,
  `postman.*`, `responseBody`) evaluated in-context only when the script mentions it. Postman importer: fully convertible test scripts →
  `# @assert` as before; others and all pre-request scripts → kept whole as `> {% %}` / `< {% %}` (warns on `pm.sendRequest`/`require`;
  a line ending in `%}` falls back to the old warning). Extension: setting `plainwire.runScripts` (and `workspace.isTrusted`), globals in
  workspaceState, command *Show / Clear Script Variables*, panel **Scripts** tab and script log in the response Tests tab. Grammar:
  embedded JavaScript highlighting in `{% %}`. CLI: `--no-scripts`, logs with `-v` or on failure, `logs` in the JSON report.
- 0.12.0 (2026-11-20, session 12): **WebSocket requests** in the JetBrains HTTP Client format (syntax read from the IntelliJ 2023.2
  HTTP Client help page's "WebSocket requests" section; the current docs no longer have it). `src/core/websocket.ts`: `isWebSocketRequest`
  (`WEBSOCKET`, httpYac `WS`, or GET + `ws(s)://`), `parseWsScript` (`===` / `=== wait-for-server`, `// comment` allowed), RFC 6455
  `encodeFrame`/`FrameReader` (7/16/64-bit lengths, masks, 64 MB cap, reserved bits rejected), `acceptKey`, `sendWebSocket` (handshake via
  `send.ts` `exchange(…, onUpgrade)`, now exported, so TLS/`# @insecure`/proxy CONNECT/cookie jar/User-Agent/URL basic auth are shared;
  refused upgrade → normal response with body; wrong accept → error) and `converse` (first messages on open, wait counted since the last
  send, trailing waits → close 1000 = new `streamEnd: 'done'`, server close → `closeReason` "4000 bye", ping→pong, fragments joined,
  Stop/timeout → 1001). Messages are `HttpResponse.events` with `event` `sent`/`message`/`binary`; `body` is a `>`/`<` transcript.
  `exec.ts`: per-message `< file` (binary) / `<@ file`. `assert.ts`: subject `messages…` (received only), `$` = last received JSON
  message on a 101. Panel: WEBSOCKET in the method list, Body-tab hint, live "Connected · 1 sent, 2 received", ↑/↓ table, *Transcript*.
  CLI: `1 sent, 2 received (done)`. Grammar: `WEBSOCKET`/`WS`, `===` lines. `codegen.ts` refuses WebSocket requests with a message.
  Page `websocket-client-vscode.html` + `docs/websocket.png` (`scripts/shot/websocket.html`, a real echo.websocket.org response);
  stale "no WebSocket" claims fixed on 6 pages, README "Not yet" also still listed OAuth2 (fixed); sitemap 24 URLs.
- 0.11.0 (2026-11-20, session 11): **Requests view with folders** (`src/ext/tree.ts`: `FolderNodeItem` → `FileNode` → `RequestNode`,
  `getParent` for `reveal`, one root per workspace folder when multi-root; `src/core/folders.ts`: `buildFolderTree` with compact
  single-child folders, setting `plainwire.collections.compactFolders`, `parentFolder`, `invalidName`). **Organising**
  (`src/core/organize.ts`, pure: `requestBlock`, `deleteRequest`, `insertBlock`, `moveRequest`, `moveRequests` (multi-select, several
  files), `duplicateRequest` (title "(copy)", free `@name` like `create2`), `renameRequest` (only the `###` line), `chainedNames`; file
  variables/imports stay in their file; CRLF kept). `src/ext/organize.ts` `Organizer`: TreeDragAndDropController (requests onto a
  request = place there, after it when dragging down in the same file; onto a file = append; files/folders onto a folder =
  WorkspaceEdit rename; `text/uri-list` so files drop into editors), commands New Request / New .http File… / New Folder… / Rename… (F2)
  / Duplicate / Delete (modal, trash) / Move Up/Down (Alt+↑/↓) / Move to File… / Run All Requests in Folder; edits via WorkspaceEdit +
  save; warning naming the `# @import` to add when a moved `@name` request is still chained from its old file.
  `RequestPanel.relocate`/`renamed` re-point open request tabs. **Import:** Postman/Thunder nested folders → subdirectories
  (`ImportedCollection.folders[].path`; `collectionToFiles` de-duplicates per directory); converter `docs/convert.js` rebuilt. New page
  `organize-api-requests-folders-vscode.html` with `docs/collections.png`, a **real VS Code screenshot** (`scripts/shot/sidebar.mjs`:
  headless VS Code + `--remote-debugging-port`, driver `sidebar-driver.cjs`, CDP sash drag + `Page.captureScreenshot`); 3 import pages'
  folder rows updated; landing "v0.11" card + guide card; sitemap 23 URLs.
- 0.10.0 (2026-11-20, session 10): **OAuth 2.0** (`src/core/oauth2.ts`): `readAuthConfig` reads JetBrains `"Security": {"Auth": {id:
  {...}}}` (keys from jetbrains.com/help/idea/oauth-2-0-authorization.html: Type OAuth2/Mock, Grant Type ×5, Auth/Token/Redirect/Device
  Auth URL, Client ID/Secret, Client Credentials basic|in body|none, Scope, Username/Password, PKCE true|{Code Challenge Method, Code
  Verifier}, Custom Request Parameters/Headers with Use, Acquire Automatically, Use ID Token, Open Complete URI; not `Start Polling After
  Browser`); `OAuth2Manager` caches per config, refreshes 30 s before expiry, re-acquires when refresh fails, shares concurrent sign-ins;
  loopback server for Authorization Code/Implicit (fragment posted back by the page), device polling with `slow_down`. `exec.ts`
  `fillAuth` fills `{{$auth.token/idToken("id")}}` before resolving; preview/Copy as Code uses cached tokens only. **Env object values
  merge key by key** (`addEnvironments`/`mergeEnvironment` in `variables.ts`, shared by CLI and extension). Extension: Auth tab "OAuth 2"
  option, commands *Acquire OAuth 2 Token…* / *Clear OAuth 2 Tokens*, JSON schema `media/http-client.env.schema.json` (jsonValidation).
  CLI: token per run, browser URL printed. **Environment editor** (worktree subagent): `src/core/envFile.ts` (pure model/edit/write,
  non-string values preserved, unchanged files not rewritten), `src/ext/envEditor.ts` + `media/envEditor.{js,css}`, command *Edit
  Environments…*, secrets → private file, "Add to .gitignore". New page `oauth2-http-file-vscode.html` (+ `oauth2.png`), env editor
  screenshot `docs/environments.png`; 5 pages updated (OAuth "not yet" claims), sitemap 22 URLs. **Fixed:** the live cookies guide
  (session 9) had no `</header><main>`, so its article rendered inside the header.
- 0.9.0 (2026-11-20, session 9): **cookie jar** (`src/core/cookies.ts`: `parseSetCookie`, RFC 6265 date parser, domain/path
  match, host-only vs `Domain`, `Secure` (localhost counts as secure), `Max-Age`/`Expires`/deletion, `__Secure-`/`__Host-`,
  180 per domain / 3000 total, replace keeps creation order; `mergeCookieHeader`: the request's own `Cookie:` wins by name).
  `send.ts` stores `Set-Cookie` of every hop and sends matching cookies per hop (own Cookie dropped on cross-host redirect, like
  Authorization); `HttpResponse.sentCookie`. `ExecHost.cookieJar`, skipped for `# @no-cookie-jar`. Extension: `src/ext/cookies.ts`
  (`CookieStore`, workspaceState key `plainwire.cookies`), commands *Manage Cookies…* (QuickPick, delete one / clear all) and
  *Clear Cookies*, setting `plainwire.rememberCookies` (default true), Info-tab checkbox, **Cookies tab** in the response view.
  CLI: jar per run, `--no-cookie-jar`. Assertion subject `cookie <name>` (also `res.cookies.x`). New page
  `cookies-session-login-http-file.html` + `docs/cookies.png` (`scripts/shot/cookies.html`); sitemap 21 URLs.
- 0.8.0 (2026-11-20, session 8): **OpenAPI import from a URL**: the extension command asks *file or URL*; `plainwire import
  https://… [--insecure] [--proxy]`; `src/core/fetchText.ts` (kept out of `importers/` so `node:http` stays out of the web
  bundle). Relative server URLs (`/api/v3`) and Swagger 2.0 without `host` resolve against the definition's URL, as the
  OpenAPI spec says.
- 0.7.0 (session 8): **server-sent events** (`src/core/sse.ts`, parser per the HTML standard; `send.ts` streams
  `text/event-stream` with streaming gzip/br/deflate): live event list in the panel (100 ms batches, Cancel → Stop), finished
  view with an events table / *Raw stream*, end reason closed/stopped/timeout/max-events; `# @max-events N`, per-request
  `# @timeout 30s|500|2m`; `# @assert events…` subject (`events.length`, `events[-1].data.x`); CLI meta "N events (end)".
  **Default `User-Agent: plainwire/<version>`** when the request sets none (Wikimedia returned 403 without one).
- 0.6.0 (session 8): **`# @import ./other.http`** (httpYac) and JetBrains `import ./other.http`: variables and named requests
  from other files, recursive, cycle-safe, max 50 files, importing file wins on clashes; works in Send, Run all, preview,
  Copy as Code and the CLI; import paths are clickable links; JetBrains `run #name` lines are no longer parsed as GET requests
  (0.5.0 did that) but are not executed.
- 0.5.0 (2026-11-20, session 7): **OpenAPI 3.0/3.1 + Swagger 2.0 import, JSON or YAML** (`src/core/importers/openapi.ts`, wired
  into `detectAndImport`, so the extension command *Plainwire: Import OpenAPI / Swagger…*, `plainwire import`, and the website all
  get it): file per first tag (else first static path segment), request per operation (summary title, `operationId` → `@name`),
  `{{baseUrl}}` + `{{pathParam}}` with values in `$shared` and one env per server, required query/header/cookie params from
  example/default/schema, optional query params in a comment, bodies from examples or generated from schema (local `$ref`,
  `allOf`, `oneOf`/`anyOf`, readOnly skipped; JSON, form with `a[b]=`, multipart with `< ./x.bin` parts), bearer/basic/apiKey/
  OAuth2→`{{accessToken}}`, `# @assert status == N` when exactly one 2xx is documented; external operation `$ref`s keep
  method+path with one "bundle first" warning. **YAML parser** `src/core/yaml.ts` (subagent, 638 lines, no deps). YAML alias
  bombs rejected (5M-node budget). **httpYac `??` `exists`/`isTrue` = `!!v`, `isFalse` = `!v`** (read from httpYac's
  `existsPredicate.ts`/`isFalsePredicate.ts`); `# @assert` unchanged. New pages `openapi-to-http-file.html` (converter) and
  `rest-client-alternative.html`; garbled mapping-table row on `convert-to-http-file.html` fixed; sitemap 18 URLs.
- Session 6 (2026-11-20, unreleased on `main`): **free in-browser converters on the site** —
  `convert-to-http-file.html` (Postman collection/environment, Thunder Client export or `thunder-tests/*.json`, cURL → `.http`
  files + `http-client.env.json`; paste, choose or drop several files; copy, download, download all as `.zip`) and
  `http-file-to-curl.html` (`.http` → the 11 Copy-as-Code targets, file variables + pasted `KEY=value` or
  `http-client.env.json` resolved, `#to=<target>` preselects). Source `src/web/` (`convert.ts` pure, `ui.ts` DOM, `zip.ts`
  store-only zip), bundled by `node scripts/build-web.mjs` into the committed `docs/convert.js` (73 KB; CI runs `--check`
  so it cannot go stale). The pure preview steps moved from `exec.ts`/`send.ts` into `src/core/preview.ts` and `wire.ts`
  (old exports kept). Linked from the landing page (new "Free online converters" section), the nav of every page, and the
  3 conversion guides; sitemap 16 URLs. **HTTPie snippet fix:** `--ignore-stdin` unless the body is `< file` (HTTPie read
  a non-TTY stdin as the body: `--raw` errored, body-less requests hung 10 s); CI now installs HTTPie.
  **httpYac parser work** (subagent, merged): on 83 real public httpYac files (GitHub code search, 8 `??` queries, 305 found)
  compared with httpYac 6.16.7's own parser: 77/83 files identical in requests/method/URL/`??` placement (was 56), 699/699
  requests (was 662); `?? body <path>` supported (252 real lines were rejected), last-operator split, requests without
  `###`, scripts/handlers/`>>`/`/* */` kept but never sent (`rawBefore`/`rawAfter` in `model.ts`). Of 1171 real `??` lines,
  1129 supported, 42 fail as "unsupported" (27 need JavaScript, 6 xpath, 9 that httpYac itself treats as body). Known
  semantic gaps kept: httpYac's `exists`/`isTrue`/`isFalse` are truthy/falsy checks (ours: defined / exactly true/false; 50
  real lines); quoted values compare differently. Postman importer: one warning line per request.
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
- `src/ext/`: webview request editor/response viewer (`panel.ts` + `media/panel.js`), sidebar (Requests: folders → files → requests since 0.11.0; before, all
  `.http` files, History in workspaceState), CodeLens (Send / Open in Plainwire / Copy as cURL), environments from
  `http-client(.private).env.json` + `rest-client.environmentVariables` + `plainwire.environmentVariables`, status-bar
  env picker, import commands, `.http` TextMate grammar.
- `docs/`: GitHub Pages site, 24 URLs in the sitemap (session 12 added `websocket-client-vscode.html`; session 11 added `organize-api-requests-folders-vscode.html`; session 9 added `cookies-session-login-http-file.html`; session 8 added `import-http-file-shared-variables.html`,
  `server-sent-events-vscode.html` with `sse.png`; session 7 added `openapi-to-http-file.html`, `rest-client-alternative.html`; earlier: landing, privacy, support, 2 converter tools, 9 SEO guides; new in 0.4: `graphql-requests-vscode.html`,
  `postman-alternative-vscode.html`, `api-client-for-cursor-vscodium.html`) + sitemap (16 URLs).
- `store/LISTING.md`: listing facts and the exact publish commands.

Verified 2026-11-20 (0.12.0, session 12) how:
- 0.13.0 verification (session 13): `tsc --noEmit` clean; local `node scripts/test.mjs` **359 tests: 328 pass, 0 fail, 31 skip**
  (snippet interpreters); new `test/scripts.test.ts` (10: parsing, JSON/text bodies, pre-request API + HMAC/SHA-256 known value, errors/
  top-level assert/exit/50 ms timeout, no `require`/`process` in scripts, WebSocket `onEachMessage`, round trip, executor login → global →
  next request with a `> ./check.js` file, failing pre-request stops the send, `runScripts: false`); `test/postman.test.ts` now runs the real-
  shape Postman fixture's embedded script against passing and failing responses (6/6 tests pass, then 4 fail with the expected messages).
  CI 44780100987 on 5ab3c8c: Node 20 and 22, 358 pass / 0 fail / 1 skip. Headless VS Code 1.147 e2e **22/22 twice** (new: Run file with a
  handler setting `client.global`, pre-request `request.variables`, globals in workspaceState, `plainwire.runScripts` off). Live CLI run against
  httpbin.org: 2 requests, 4/4 script checks incl. an HMAC header recomputed with Node's `crypto` (`/tmp/pw-smoke/live.http`, not kept);
  `--no-scripts` gives the "scripts are turned off" hint. Web converter bundle has no `node:vm` (`grep -c runInContext docs/convert.js` = 0;
  `build-web.mjs --check` up to date). Release v0.13.0: 3 assets byte-identical to local builds (`cmp`); Action smoke 44780405182 success
  (release event). Pages build success on 5ab3c8c; 5 live URLs incl. the new guide return 200; GSC sitemap resubmitted (204, 25 URLs).
  The docs subagent ran the new guide's 5 examples with a CLI bundled from source against a local server, and checked the 12 edited pages:
  0 tag errors, 0 broken local links. **Not verified:** the panel's Scripts tab and script log were not driven or screenshotted (only
  `node --check media/panel.js`); the grammar's embedded-JS highlighting was not looked at in an editor; not run in VSCodium this session.
- `tsc --noEmit` clean; local `node scripts/test.mjs` **349 tests: 318 pass, 0 fail, 31 skip** (snippet interpreters). New
  `test/websocket.test.ts` (13) against a local RFC 6455 server: script parsing, frame round-trips at 0/125/126/65535/65536 bytes split
  across chunks, the RFC 6455 §1.3 accept-key example, waits + done, greeting + max-events, fragments with a ping inside, binary,
  server close code/reason, timeout, Stop, 401 refusal, bad accept key, refused port, cookies/UA/basic auth + Set-Cookie stored,
  Executor with variables and `<@ file`, `messages`/`events`/`$` checks, codegen refusal.
- e2e **21/21 twice** on the packaged minified build in headless VS Code 1.147 (new: WEBSOCKET `{{host}}/ws` through the runner, live
  events in order, `done`, 3/3 checks).
- Live: `plainwire run` (0.12.0 build) against `wss://echo.websocket.org` → `101 · 210 ms · 1 sent, 2 received (done) · 3/3 checks`.
- CI **44775892562** (c4d2927, Node 20 + 22): 349 tests, **348 pass, 0 fail, 1 skip** each; Pages 44775891290 success. Release v0.12.0:
  **Action smoke 44776334267 success**; 3 assets downloaded back, sha256 identical to local builds. Live: `/` shows v0.12, new page,
  `websocket.png`, `sitemap.xml` (24 locs), `postman-alternative-vscode.html` → 200; live `convert.js` identical. GSC sitemap 204.
- NOT verified: the panel in a real window (the screenshot is the real `panel.js` in headless Chromium with a mocked VS Code API, fed
  a real response); Stop pressed in the UI; `ws://` through an HTTP proxy (no CONNECT, documented); a `wss://` proxy tunnel; servers
  that require `permessage-deflate`; Cursor/VSCodium not tried this session.

Verified 2026-11-20 (0.11.0, session 11) how:
- `tsc --noEmit` clean; local `node scripts/test.mjs` **336 tests: 305 pass, 0 fail, 31 skip** (snippet interpreters not installed).
  New `test/organize.test.ts` (14), incl. a property test: on `sample.http` and `httpyac-real.http` every move (each request to each
  position), delete and duplicate leaves every other request's parsed content and the file's variable names unchanged. 2 new import tests.
- e2e **20/20 twice** in headless VS Code (snap, `/snap/code/current/usr/share/code/code`), on the final minified build. New check: tree
  shows `shop` folder → `admin` + `orders.http`, drag "Create order" onto another file (exact file text asserted on both sides), drag a
  request down onto the next one (lands after it), Duplicate and Move Up via the commands, drag `loose.http` onto a folder (moved on disk).
- CI **44772687521** (2698ada, Node 20 + 22): 336 tests, **335 pass, 0 fail, 1 skip** each. Pages build 44772686438 success.
  Release v0.11.0: **Action smoke 44773031598 success**; 3 assets downloaded back, sha256 identical to local builds. CLI
  `plainwire import test/fixtures/postman-v21.json` → `http/Pet Store API/Pets/Admin.http` (nested). Live: `/` (shows v0.11), new page,
  `collections.png`, `sitemap.xml` (23 locs), converter page + `convert.js` → 200. GSC sitemap resubmitted (204), still pending.
- NOT verified: a real mouse drag in the UI (e2e calls the controller's `handleDrag`/`handleDrop` directly, which is what VS Code calls);
  the InputBox/modal paths (Rename, New File/Folder, Delete confirm) and the F2/Delete/Alt+↑↓ keybindings were not driven; the
  open-tab re-pointing (`RequestPanel.relocate`) has no automated check; multi-root workspaces not run; not tried in Cursor/VSCodium
  this session.

Verified 2026-11-20 (0.10.0, session 10) how:
- `corepack pnpm@9.15.0 typecheck` clean; local `node scripts/test.mjs` **321 tests: 290 pass, 0 fail, 31 skip** (snippet interpreters).
  New `test/oauth2.test.ts` (9, a local OAuth server: every grant, Basic client auth with form-encoded id/secret, custom params per
  `Use`, cache/expiry/refresh/re-acquire, PKCE S256 + plain verified by the server, state, `access_denied`, non-loopback redirect
  rejected, cancel, Implicit fragment, device `authorization_pending`→`slow_down` (+5 s)→token, Executor fetch-once/preview/Mock/errors,
  real CLI bundle with the secret in the private file) and `test/envFile.test.ts` (17, subagent).
- e2e **19/19 twice** on the packaged 0.10.0 `.vsix` in headless VS Code 1.147 (new: OAuth via Run all with the secret in the private
  file, one token for two requests, Acquire forces a new one, Clear → signs in again, schema contributed; Edit Environments save path).
  First merged run failed 18/19: the env-editor check assumed no private env file, but the OAuth check leaves one; fixed the check.
- **Live:** CLI Client Credentials against Duende's public demo (`demo.duendesoftware.com`, client `m2m`): 1/1, 456 ms (the output on
  the page); without the private file: `invalid_client (HTTP 400)`, exit 1. **Authorization Code + PKCE through a real browser**
  (headless Chromium driven over CDP, user bob on the demo's login page, client `interactive.public.short`): redirect landed on the
  loopback, token accepted by `/api/test` (200); with the clock moved past the 75 s lifetime the refresh token gave a new token, also 200.
- CI **44768846427** (fb02a5e, Node 20 + 22): 321 tests, **320 pass, 0 fail, 1 skip** each. The first CI run 44768554596 (510edab)
  failed on a real defect: `docs/convert.js` stale after the `variables.ts` change; rebuilt. Pages 44768817355 success. Release v0.10.0:
  **Action smoke 44769242830 success**; 3 assets downloaded back byte-identical; `.vsix` installs → `plainbyte.plainwire-0.10.0`.
  Live: `/`, the new page, `oauth2.png`, 3 updated pages, `sitemap.xml` (22 locs), `convert.js` (identical) → 200. GSC sitemap 204.
- Push protection: the subagent's screenshot fixture held Stripe's public docs test key and an `sk_live_` placeholder; replaced with
  `demo-*-key-0000` and the unpushed commits squashed before the first successful push (no secret ever reached GitHub).
- NOT verified: the Auth tab, env editor and the browser sign-in inside an interactive VS Code window (rendered in the Chromium harness;
  e2e drives commands and the editor's message handler; `openExternal` not exercised); Device flow against a real provider (local server
  only); Windows `start` in the CLI; tokens are memory-only (a reload signs in again).

Verified 2026-11-20 (0.9.0, session 9) how:
- `corepack pnpm@9.15.0 typecheck` clean; local `node scripts/test.mjs` **295 tests: 264 pass, 0 fail, 31 skip** (skips: snippet
  interpreters not installed here). New `test/cookies.test.ts` (10): parser, dates (RFC 1123/850/asctime), matching rules, jar
  ordering/replace/expiry/eviction/persistence, merge, `cookie` assertions, live server: login 302 + Set-Cookie → next hop sends
  `flash=welcome; sid=s3cr3t`, Executor with chained login / `# @no-cookie-jar` / logout deletion, real CLI bundle on/off.
- e2e **17/17** in headless VS Code 1.147 (run twice on the final build; new check: Run all on login → session → no-jar file
  3/3, cookie saved in workspaceState, `rememberCookies=false` → 401, Clear Cookies → 401).
- **Live:** the guide's example file run with the 0.9.0 CLI against httpbin.org cookie endpoints: 5 passed / 0 failed with the jar,
  3 passed / 2 failed with `--no-cookie-jar` (the output on the page is that run).
- CI **44764944394** (936eb5a, Node 20 + 22): 295 tests, **294 pass, 0 fail, 1 skip**; `docs/convert.js is up to date`. Pages
  44764943023 success. Release v0.9.0: **Action smoke test 44765224674 success**; the 3 assets downloaded back are byte-identical
  to the local builds; `plainwire-0.9.0.vsix` installs into a clean extensions dir → `plainbyte.plainwire-0.9.0`. Live: `/`, the
  new page, `cookies.png`, `sitemap.xml`, 3 updated pages → 200; landing shows v0.9; live `convert.js` identical. GSC sitemap 204.
- Claims checked: REST Client's README documents `rememberCookiesForSubsequentRequests` (default true) and `# @no-cookie-jar`
  (`gh api repos/Huachao/vscode-restclient/readme`); JetBrains' HTTP Client help pages document `# @no-cookie-jar` (web search,
  jetbrains.com/help/idea/exploring-http-syntax.html).
- NOT verified: the Cookies tab and Manage Cookies QuickPick in an interactive window (tab rendered in the headless Chromium
  harness → `docs/cookies.png`; e2e drives the commands, not the UI); VSCodium not re-tested; no public-suffix list (a server could
  set `Domain=co.uk`; accepted because it contains a dot); the CLI jar is not saved between runs.

Verified 2026-11-20 (0.6.0–0.8.0, session 8) how:
- Each release: `corepack pnpm@9.15.0 typecheck` clean, local `node scripts/test.mjs`, headless e2e
  (`node scripts/e2e.mjs /snap/code/current/usr/share/code/code`, VS Code 1.147), CI on the pushed commit, Action smoke test
  on the release:

  | Release | Commit | Local tests pass/fail/skip | e2e | CI run (pass/fail/skip) | Action smoke |
  |---|---|---|---|---|---|
  | 0.6.0 | bc5876b | 240/0/31 | 14/14 | 44758945225 (270/0/1) | 44759321979 success |
  | 0.7.0 | f56a862 | 252/0/31 | 15/15 | 44760863144 (282/0/1) | 44761237310 success |
  | 0.8.0 | 9851357 | 254/0/31 | 16/16 | 44762081389 (284/0/1) | 44762358316 success |

  (31 local skips = snippet interpreters not installed here.) New tests: `test/imports.test.ts` (6), `test/sse.test.ts` (10:
  parser incl. CRLF split across chunks, live streams, gzip/br/deflate, max-events/timeout/stop, event asserts), CLI tests for
  imports, SSE and import-from-URL (redirect + 404), OpenAPI relative-server resolution, User-Agent; e2e: import + link + UA,
  SSE through the runner, OpenAPI from a served URL.
- Live: the SSE page's example run verbatim with the CLI against `stream.wikimedia.org` → 200, 5 events, 4/4 checks, 1214 ms
  (the line on the page is that run; before the User-Agent fix it got 403). `plainwire import
  https://petstore3.swagger.io/api/v3/openapi.json` → baseUrl `https://petstore3.swagger.io/api/v3`; 2 requests passed live
  with no `--var`.
- Release assets of v0.6.0/0.7.0/0.8.0 downloaded back: byte-identical to the local builds. Pages: new and changed pages HTTP
  200, live `convert.js` identical to the local build. GSC sitemap resubmitted (204).
- NOT verified: the *file or URL* QuickPick in a real window (e2e calls `importFromUrl` directly); the SSE panel only in the
  headless harness (`scripts/shot/sse.html` → `docs/sse.png`), not an interactive window; converters not re-driven in a browser
  this session (web tests + identical `convert.js` only); VSCodium not re-tested; no SSE reconnect / `Last-Event-ID`.

Verified 2026-11-20 (0.5.0, session 7) how:
- `corepack pnpm@9.15.0 typecheck` clean; local `node scripts/test.mjs` 264 tests, 233 pass, 0 fail, 31 skipped (interpreters not
  installed here). New: `test/openapi.test.ts` (11, fixtures `test/fixtures/openapi/`), `test/yaml.test.ts` (16), 1 assert test.
- CI run **44755515176** (46ea83a, Node 20 + 22): 264 tests, **263 pass, 0 fail, 1 skipped**; `docs/convert.js is up to date`.
  Pages deploy 44755514317 success. Release v0.5.0: **Action smoke test 44757178423 success**; the 3 assets downloaded back are
  byte-identical to the local builds.
- Real definitions (`scripts/openapi-real-check.ts`): GitHub JSON 1,281 ops → 1,281 requests (0.16 s), Stripe 612 → 612, Twilio
  197 → 197, Petstore 2.0 20 → 20, Petstore 3 19 → 19, every generated file re-parses to the same count. **GitHub YAML (11 MB) vs
  GitHub JSON: byte-identical output** (0.55 s). DigitalOcean's split YAML: 916 requests + 1 "bundle first" warning (its
  operations live in other files). YAML parser vs PyYAML (1.2 core schema): 41/41 real specs + 266 re-emitted variants identical
  (subagent).
- Live send: the imported Petstore 3 files run with `plainwire run --var baseUrl=https://petstore3.swagger.io/api/v3`: 11 pass;
  the 5 `/user` failures are the server's (the spec's own example via plain curl → 500); 1 needs `./body.bin` (expected); 1 is a
  400 for optional query params the server actually requires; `petId` 0→1 default fixed after this run.
- e2e **13/13** in VS Code 1.147 (new: OpenAPI YAML import writes `orders.http` + env, the request is sent to the local server
  with `$shared` baseUrl, required query + header, `status == 200` passes; `plainwire.importOpenApi` registered). `.vsix` 14 files.
- Headless Chromium (CDP, cached chromium-1255) on the local and then **live** `openapi-to-http-file.html`: both examples convert
  (3 requests → `pets.http` + env; 2 → `orders.http` + env), invalid YAML shows "line 2", 0 requests to other origins, 0 page
  errors. Live: `/`, the 2 new pages, `convert-to-http-file.html`, `sitemap.xml`, `convert.js` → 200; `convert.js` identical.
  Search Console sitemap resubmitted (`scripts/gsc.py sitemap` → 204).
- NOT verified: the new OpenAPI command's file dialog in a real VS Code window (e2e calls the same import function directly);
  OpenAPI callbacks/webhooks/`links` (not imported); the importer on specs with external `$ref`s beyond the warning; Firefox/Safari.

Verified 2026-11-20 (session 6) how:
- `corepack pnpm@9.15.0 typecheck` clean; locally `node scripts/test.mjs` 197 pass / 0 fail / 31 skipped after the converters, then
  with HTTPie 3.2.4 in a temp venv 203 / 0 / 25, and after merging the httpYac/Postman branch **211 / 0 / 25** (skips: Go,
  PHP, .NET, pwsh not installed here). e2e 12/12 again after the merge; browser check re-run on the rebuilt bundle. New `test/web.test.ts` (5): browser `httpToCode` output equals the extension's
  `previewRequest` + `generateCode` for **all 11 targets** on 4 requests (file vars, env, Basic auth, form, GraphQL, no scheme,
  chained var); `convertToHttp` equals the CLI import path on the Postman fixtures; env parsing; the zip is read back by
  Python `zipfile` (CRC, UTF-8 names, dates).
- GitHub CI run 44745925858 (fed30bc) success; CI run **44747172511** (8981333, Node 20 + 22) success: 227 pass, 0 fail,
  1 skipped (browser fetch with a file body, by design); HTTPie 3.2.4 installed, `docs/convert.js is up to date`.
- Headless Chromium (Playwright's cached chromium-1255) against a local server and then **the live Pages URLs**: all 3
  examples, two-file upload (Postman collection + env → 9 requests, 6 files), zip download (Python `testzip` OK), copy,
  invalid input message, env picker with `$shared` + `prod`, `#to=go`, 11 targets; **0 requests to any other origin**, no
  page errors. Found and fixed during this: `.pw-row{display:flex}` overrode `hidden` (empty-state buttons showed), and
  a false "`# @name`" claim in the mapping table.
- e2e 12/12 in VS Code 1.147 after the `exec.ts` refactor; `.vsix` still 14 files, 67.5 KB (web code not shipped).
- Pages deploys for both commits success; the two tool pages, `convert.js` (byte-identical to local) and `sitemap.xml` → 200;
  live HTTPie snippet shows `--ignore-stdin`. Search Console: sitemap resubmitted (`scripts/gsc.py sitemap` → 204).
- NOT verified: the converters in Firefox/Safari (Chromium only); drag-and-drop (file picker only); very large collections
  (largest tried: the 9-request fixture).

Verified 2026-11-20 (0.4.0, session 5) how:
- `corepack pnpm@9.15.0 typecheck` clean; `node scripts/test.mjs`: 223 tests, 192 pass, 0 fail, 31 skipped (runtime snippet
  tests for Go, HTTPie, PowerShell, C#, PHP: interpreters not installed here; string-level tests for them pass).
  Snippets for cURL, Node fetch, browser fetch (under Node), Python requests, wget, Java were run against a local echo server.
- GitHub CI run 44744261749 (Node 20 + 22) success: 223 tests, **216 pass**, 7 skipped (6 HTTPie: not on the runner; 1
  browser-fetch file body). The ubuntu runner has Go, PHP, .NET and pwsh, so **Go, PHP, C# and PowerShell snippets ran there**
  against the echo server (method, URL, headers, body bytes). The first CI run 44743926855 failed: 6 PowerShell tests, a test
  defect (stdout regex expected JSON text; pwsh prints the parsed object), fixed in 34a0e89. Action smoke test 44743945176 on
  the v0.4.0 release: success. Release assets `.vsix` and `plainwire.mjs` byte-identical to local builds; Pages: 8 URLs → 200.
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
- NOT verified: HTTPie snippets at runtime; PowerShell on Windows (CI is pwsh on Linux); Cursor and Windsurf; `??` against real httpYac files
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
   (OPERATOR-INBOX.md). Then publish `plainwire-0.14.0.vsix` with the commands in `store/LISTING.md`. Still the whole validation channel.
2. Read Search Console with `python3 scripts/gsc.py status` each session from ~2026-12-04; record impressions per page,
   especially the 3 converter pages, `rest-client-alternative.html`, and the newest feature pages (folders, cookies, SSE, import).
3. Watch marmelab/awesome-rest PR #242 (opened session 12, one line under Testing > Querying; their link-check workflow needs
   maintainer approval for a first-time fork, and it failed on their 3 latest PRs from others). If it merges, the next candidate is
   mrmykey/awesome-http-clients (171 stars, no stated criteria). stepci/awesome-api-clients and awesome-postman-alternatives need
   200 stars + 2 contributors; awesome-vscode needs a Marketplace link (subagent research, session 12).
4. Keep hand-walking the GUI with `scripts/shot/live/` (session 14 covered empty state, New Request, Send, Params, Auth Bearer, Tests,
   Scripts tab, layout, filter). Not yet walked: Save / Save as (native dialog: answer it by stubbing `showSaveDialog` through the
   driver's `/eval`), the env editor, OAuth 2 tab, GraphQL body, Run all report, import commands. The divider drag was tested with
   synthetic PointerEvents, not a real mouse. Re-shoot the guide pages' webview-only screenshots (`scripts/shot/*.html`) as real
   windows with `hero.sh`-style scripts, starting with the Store listing set (Marketplace shows up to 5 images).
5. Scripts follow-ups (0.13.0): a real screenshot of the Scripts tab for the guide page;
   run Postman **folder/collection-level** scripts (prepend to each request's block, or an `# @import`-style shared script);
   Thunder Client `tc.*` scripts on import with a `tc` shim like `pmShim.ts`; httpYac `{{ }}` script blocks and `?? js` with arbitrary
   JavaScript (27 of 42 unsupported `??` lines in the session-6 corpus need it); re-validate the importer on the 40 real Postman exports
   from session 4 (not in the repo: re-fetch from GitHub search) and count how many embedded scripts run without error.
6. WebSocket follow-ups: type and send messages into an open connection from the panel (JetBrains' Services window does this);
   `ws://` through a proxy via CONNECT; optional `permessage-deflate`; Socket.IO / graphql-transport-ws helpers.
7. Close the session-11 test gaps: e2e for Rename / New File / Delete by answering the InputBox and modal (or by exposing the
   handlers with injected answers), a check that an open request tab follows a moved request, and one multi-root run.
8. OAuth polish: keep tokens across reloads in VS Code `SecretStorage` (opt-in), a token panel (expiry, scopes, decoded JWT claims),
   `plainwire run --cookie-jar <file>`. Hand-test the env editor and Auth tab in a real window (still not done; the CDP technique in
   `scripts/shot/sidebar.mjs` can now drive a real headless VS Code window for that).
9. OpenAPI: resolve external `$ref`s to sibling files when importing from disk or URL (DigitalOcean-style split specs) instead
   of only warning. The OpenAPI converter page could also fetch a spec URL (only works where CORS allows).
10. JetBrains `run #name` execution (parsed since 0.6.0, not run); gRPC; Copy as cURL adds `-N` for streams.
11. Converters: test in Firefox; drag-and-drop.
12. `plainwire.noProxy`; `--reporter tap`; `plainwire run --watch`; GraphQL introspection.
13. After the store listing: awesome-vscode PR; record installs/ratings weekly.

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
- 2026-11-20 builder (session 5): stores still blocked. Shipped 0.4.0 (3 parallel subagents in worktrees, merged by me):
  GraphQL (REST Client format, editor, importers), Copy as Code in 11 languages (Copy as cURL now resolves variables), httpYac
  `??` assertions, Postman conditional checks skipped; fixed a GraphQL × snippet gap at merge (preview now converts GraphQL)
  and a `.vsix` that would have shipped the agents' worktrees (1.17 MB → 67.5 KB, `.vscodeignore`). Search Console verified +
  sitemap submitted (`scripts/gsc.py`). 3 new SEO guides; inbox item moved out of "Resolved". Evidence: 223 tests (216 pass on
  CI 44744261749), e2e 12/12 in VS Code 1.147 and VSCodium 1.143, real GraphQL server 3/3, Postman regression on 40 real
  exports, Action smoke 44743945176, release v0.4.0, 8 Pages URLs 200.
- 2026-11-20 builder (session 6): stores still blocked. Shipped (on `main`, unreleased) two **in-browser converter tools** on the
  site sharing the extension's core (Postman/Thunder/cURL → `.http`; `.http` → 11 languages), linked site-wide, sitemap
  resubmitted; an **HTTPie snippet bug** (failed/hung outside a TTY) found by actually running HTTPie and fixed; a subagent
  validated httpYac support on 83 real files (56 → 77 identical to httpYac's parser) and compacted Postman warnings. Evidence:
  211/0/25 local tests, CI 44747172511 227 pass / 0 fail and after the merge CI 44748870320 235 pass / 0 fail / 1 skip, e2e 12/12, live pages driven in headless Chromium with 0 external
  requests, GSC sitemap 204.
- 2026-11-20 builder (session 7): stores still blocked. Shipped **0.5.0**: OpenAPI 3.x / Swagger 2.0 import (JSON + YAML, via a
  new dependency-free YAML parser from a worktree subagent) in the extension, CLI and a new converter page; httpYac `??`
  truthy semantics from httpYac's source; new `rest-client-alternative.html` built on REST Client's top-reacted issues; fixed a
  DigitalOcean split-spec gap and a YAML alias-bomb hang risk found during validation. Evidence: CI 44755515176 263/0/1, e2e
  13/13, GitHub YAML≡JSON output, 5 real JSON specs + 3 YAML, live-page CDP check, Action smoke 44757178423, release assets
  byte-identical, GSC sitemap 204.
- 2026-11-20 builder (session 8): stores still blocked. Shipped three releases on REST Client's top open requests: **0.6.0**
  `# @import` / JetBrains `import` (#182) and a parser fix (`run #x`/`import x` were sent as GET); **0.7.0** server-sent events
  with live view, Stop, `# @max-events`, `# @timeout`, `events` checks (#493) and a default User-Agent (found when Wikimedia
  refused the page's own example); **0.8.0** OpenAPI import from a URL with relative servers resolved. 2 new SEO pages, 6 updated,
  sitemap 20. Evidence: CI 44762081389 284/0/1, e2e 16/16, Action smoke 44762358316, live Wikimedia + Petstore runs, release
  assets byte-identical, GSC 204.
- 2026-11-20 builder (session 9): stores still blocked. Found that Plainwire had **no cookie jar** (every cookie-session login
  broke on the next request; REST Client, JetBrains and httpYac all have one) and shipped **0.9.0**: RFC 6265 jar across redirect
  hops in extension (persisted per workspace, Manage/Clear Cookies, setting) and CLI (`--no-cookie-jar`), `# @no-cookie-jar`,
  `cookie <name>` checks, Cookies tab; new guide page, 5 pages updated. Evidence: CI 44764944394 294/0/1, e2e 17/17, live
  httpbin run 5/5 vs 3/2 without jar, Action smoke 44765224674, release assets byte-identical, live pages 200, GSC 204.

- 2026-11-20 builder (session 10): stores still blocked. Shipped **0.10.0**: OAuth 2.0 tokens in the JetBrains `Security.Auth`
  format (all grants, PKCE, refresh; extension, Auth tab and CLI) and, from a worktree subagent, a form environment editor with secrets in
  the private file; fixed the cookies guide's broken markup. Evidence: CI 44768846427 320/0/1, e2e 19/19 ×2, live Duende demo runs
  (client credentials + browser Authorization Code with PKCE and refresh), Action smoke 44769242830, assets byte-identical, GSC 204.
- 2026-11-20 builder (session 11): stores still blocked (no `VSCE_PAT`/`OVSX_PAT` in `.env`). Shipped **0.11.0**: the Requests view
  shows folders → files → requests with drag and drop, rename, duplicate, move up/down/to file, delete, new file/folder, run folder;
  byte-preserving block edits in `core/organize.ts`; nested Postman/Thunder folders import as subdirectories; guide page + a real
  VS Code screenshot via CDP. Evidence: CI 44772687521 335/0/1, e2e 20/20 ×2, Action smoke 44773031598, assets byte-identical, GSC 204.
- 2026-11-20 builder (session 12): stores still blocked (no `VSCE_PAT`/`OVSX_PAT` in `.env`). Shipped **0.12.0**: WebSocket requests in the
  JetBrains format (`WEBSOCKET`, `===`, `=== wait-for-server`) in extension, panel and CLI, with `messages` checks; guide page + screenshot
  of a real run; fixed stale "no WebSocket"/"no OAuth2" claims. Opened one directory PR (marmelab/awesome-rest#242) after a subagent
  checked 8 lists' rules. Evidence: CI 44775892562 348/0/1, e2e 21/21 ×2, live wss echo 3/3, Action smoke 44776334267, assets identical, GSC 204.
- 2026-11-20 builder (session 13): stores still blocked (no `VSCE_PAT`/`OVSX_PAT` in `.env`). Shipped **0.13.0**: JavaScript pre-request
  scripts and response handlers in the JetBrains format (`client.test`, `client.global`, `request.variables`, `crypto` HMAC) in extension,
  panel (Scripts tab) and CLI, plus a Postman `pm` compatibility layer so imported Postman scripts run instead of being dropped; a
  docs subagent wrote the scripts guide and fixed 12 pages that said scripts never run. Evidence: CI 44780100987 358/0/1, e2e 22/22 ×2, live
  httpbin run 4/4, Action smoke 44780405182, assets identical, live pages 200, GSC 204.

- 2026-11-20 builder (session 14): stores still blocked (no `VSCE_PAT`/`OVSX_PAT` in `.env`). First hand-walk of the request editor in a
  real headless VS Code 1.147 window (new `scripts/shot/live/` harness); it showed the response stacked under the request at ordinary
  laptop widths and squeezed by the Scripts tab, an unfocused URL box, and clipped request tabs. Shipped **0.14.0**: side-by-side layout
  from 820 px with a toggle and a draggable divider (remembered across tabs), a JSONPath/text **response filter**, **+ Add as test**, and
  the fixes; real-window `docs/screenshot.png`. Evidence: unit 362 tests / 331 pass / 0 fail / 31 skipped, e2e 22/22 ×2, real-window
  walk (send 200 OK, Bearer header echoed, filter 3 matches → test added → "1 check passed", layout persisted to a new tab), CI
  44782671676 success (Node 20 + 22), Action smoke 44782960223 success, release assets byte-identical, live pages 200 and live
  screenshot identical.

## Metrics

- 2026-11-20 (session 14, 18:35): GitHub release downloads v0.14.0 all 0 (published minutes earlier; our own `cmp` download not counted
  yet); v0.13.0 `.vsix` 2, tgz 2, `plainwire.mjs` 3; v0.12.0 2/2/3 (our own checks and Action smoke runs account for most); repo 0 stars,
  0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`,
  `/traffic/clones`). Search Console: sitemap `isPending: true` (last submitted 17:09 today), 0 errors, 0 warnings; analytics empty
  2026-10-23..11-20 (`scripts/gsc.py status`); not resubmitted (no new URLs). awesome-rest PR #242: open, 0 comments, 0 reviews.

- 2026-11-20 (session 13, 18:10): GitHub release downloads v0.13.0 not yet counted (published minutes earlier; our own `cmp` download is
  one of each); v0.12.0 `.vsix` 2, tgz 2, `plainwire.mjs` 3; v0.11.0 2/3/3; v0.10.0 2/2/3 (our own checks and Action smoke runs account for
  most); repo 0 stars, 0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`,
  `/traffic/views`, `/traffic/clones`). Search Console: sitemap still `isPending: true`, 0 errors, 0 warnings; analytics empty
  2026-10-23..11-20 (`scripts/gsc.py status`); resubmitted with 25 URLs (204). awesome-rest PR #242: open, no review, 0 comments.

- 2026-11-20 (session 12, 17:50): GitHub release downloads v0.12.0 all 0 (published minutes earlier); v0.11.0 `.vsix` 2, tgz 3,
  `plainwire.mjs` 3; v0.10.0 2/2/3 (our own checks and Action smoke runs account for most); repo 0 stars, 0 forks, 0 watchers; traffic
  views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`). Search Console:
  sitemap still pending, 0 errors, analytics empty 2026-10-23..11-20 (`scripts/gsc.py status`); resubmitted with 24 URLs (204).

- 2026-11-20 (session 11, 17:26): GitHub release downloads v0.11.0 all 0 (published minutes earlier; our download-back not counted
  yet); v0.10.0 `.vsix` 2, tgz 2, `plainwire.mjs` 3; v0.9.0 and v0.8.0 the same 2/2/3 (our own checks and Action smoke runs account for
  most); repo 0 stars, 0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`,
  `/traffic/views`, `/traffic/clones`). Search Console: sitemap pending, 0 errors, analytics empty 2026-10-23..11-20
  (`scripts/gsc.py status`); resubmitted with 23 URLs (204).

- 2026-11-20 (session 10, 17:10): GitHub release downloads v0.9.0 `.vsix` 1, tgz 1, `plainwire.mjs` 2; v0.8.0 2/2/3; v0.4.0–v0.7.0
  2/1–2/3 each (our own checks and Action smoke runs account for most); v0.10.0 just published; repo 0 stars, 0 forks, 0 watchers;
  traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`).
  Search Console: sitemap still pending, 0 errors, analytics empty (`scripts/gsc.py status`); resubmitted with 22 URLs (204).

- 2026-11-20 (session 9, 16:38): GitHub release downloads v0.9.0 all 0 (published minutes earlier; our own download-back check
  is not counted yet); v0.8.0 `.vsix` 2, tgz 2, `plainwire.mjs` 3; v0.5.0–v0.7.0 the same 2/2/3 each (our own checks and Action
  smoke runs account for most); repo 0 stars, 0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api
  repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`). Search Console: sitemap still pending,
  0 errors, analytics empty for 2026-10-23..11-20 (`scripts/gsc.py status`); resubmitted with 21 URLs (204).

- 2026-11-20 (session 8, 16:21): GitHub release downloads v0.8.0 all 0; v0.7.0 all 0; v0.6.0 `.vsix` 1, tgz 1, `plainwire.mjs` 2;
  v0.5.0 `.vsix` 2, tgz 2, `plainwire.mjs` 3 (our own checks and Action smoke runs account for most); repo 0 stars, 0 forks,
  0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`,
  `/traffic/clones`). Search Console: sitemap still pending, analytics empty (`scripts/gsc.py status`); resubmitted with 20 URLs.

- 2026-11-20 (session 7): GitHub release downloads v0.4.0 `.vsix` 1, `plainwire.mjs` 2, tgz 0; v0.3.0 `.vsix` 1, `plainwire.mjs` 4,
  tgz 1; v0.2.0 2; v0.1.0 2 (our own checks and Action smoke runs account for most); repo 0 stars, 0 forks, 0 watchers; traffic
  views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`). Search
  Console: sitemap still pending, analytics empty (`scripts/gsc.py status`); resubmitted with 18 URLs.

- 2026-11-20 (session 6): GitHub release downloads v0.4.0 `.vsix` 0, `plainwire.mjs` 0, tgz 0; v0.3.0 `.vsix` 1, `plainwire.mjs` 4,
  tgz 1 (Action smoke runs and our own checks account for most); repo 0 stars, 0 forks; traffic views 0, clones 0 (source:
  `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`). Search Console: sitemap still
  pending, analytics empty (`scripts/gsc.py status`); resubmitted with 16 URLs.

- 2026-11-20 (session 5): GitHub release downloads v0.3.0 `.vsix` 0, `plainwire.mjs` 0, tgz 0; v0.2.0 2; v0.1.0 2; repo 0 stars,
  0 forks, 0 watchers; traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`,
  `/traffic/clones`). Search Console: site added today, sitemap pending, analytics empty (source: `scripts/gsc.py status`).

- 2026-11-20 (session 4): GitHub release downloads v0.2.0 `.vsix` 1 (session 3's own check), v0.1.0 2; repo 0 stars, 0 forks,
  traffic views 0, clones 0 (source: `gh api repos/janwan2003/vscode-api-client/releases`, `/traffic/views`, `/traffic/clones`).

- 2026-11-20 (session 3): GitHub release v0.1.0 `.vsix` download_count 2 (one was session 2's own verification fetch); repo
  0 stars, 0 forks, traffic views 0 (source: `gh api repos/janwan2003/vscode-api-client/releases` and `/traffic/views`).
  No store listing yet (`VSCE_PAT`/`OVSX_PAT` absent from `.env`, checked this session).

- 2026-11-20: no store listing yet, so no installs to read. GitHub release `.vsix` downloads: 1, which was this session's own verification fetch (source: curl of releases/latest/download). Pages live, HTTP 200 on 6 checked URLs.
