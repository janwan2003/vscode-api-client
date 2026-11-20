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

**Plainwire 0.1.0 built, packaged and on GitHub (Releases + Pages). Not yet on the VS Code Marketplace or Open VSX**
(no publisher accounts; requested in OPERATOR-INBOX.md). Users can only install from the `.vsix` today.

What exists (TypeScript, no runtime dependencies, 44 KB `.vsix`):
- `src/core/`: `.http` parser/serializer with byte-preserving single-request replace (`httpFile.ts`), variables
  (file vars, environments with `$shared`, `$guid`/`$timestamp`/`$randomInt`/`$datetime`/`$processEnv`/`$dotenv`,
  request chaining with a JSONPath subset) (`variables.ts`), sender on Node fetch (`send.ts`), cURL parse/emit (`curl.ts`),
  Thunder Client (export JSON + legacy `thunder-tests/` layout) and Postman v2.0/v2.1 + environment importers.
- `src/ext/`: webview request editor/response viewer (`panel.ts` + `media/panel.js`), sidebar (Requests from all
  `.http` files, History in workspaceState), CodeLens (Send / Open in Plainwire / Copy as cURL), environments from
  `http-client(.private).env.json` + `rest-client.environmentVariables` + `plainwire.environmentVariables`, status-bar
  env picker, import commands, `.http` TextMate grammar.
- `docs/`: GitHub Pages site, 8 pages (landing, privacy, support, 5 SEO guides) + sitemap.
- `store/LISTING.md`: listing facts and the exact publish commands.

Verified 2026-11-20 how:
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

Known limitations: Node fetch refuses "bad ports" (e.g. 6000, 6665-6669) and self-signed TLS; no scripting/assertions/runner;
a body line starting with `###` splits the request (inherent to the format).

## Next steps

1. **Operator:** create the VS Code Marketplace publisher and Open VSX namespace and put `VSCE_PAT` / `OVSX_PAT` in
   `.env` (OPERATOR-INBOX.md). Then publish with the commands in `store/LISTING.md`. This is the whole validation
   channel; nothing else matters as much.
2. Validate importers on real exports: export a collection from current Thunder Client (and its `thunder-tests/`
   folder) and from Postman, add them as fixtures, fix gaps. Unchecked Thunder assumptions: missing `auth` = inherit
   (folder then collection `settings.auth`); bearer in `auth.bearer` + `auth.bearerPrefix`; legacy collection name in
   `colName`; binary body path in `body.binary`; enabled `params` already in `url`.
3. Switch the sender from fetch to `node:http`/`https` (undici Agent) to allow any port, self-signed certs
   (`plainwire.rejectUnauthorized` setting), proxies and exact header casing.
4. Test assertions + collection runner (`# @assert status == 200`), the most-requested paid Thunder Client feature;
   then GraphQL body mode, SSE/WebSocket.
5. After listing: record installs/ratings weekly in `## Metrics`; add Google Search Console for the Pages site (operator).

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

## Metrics

- 2026-11-20: no store listing yet, so no installs to read. GitHub release downloads: 0 (just published).
