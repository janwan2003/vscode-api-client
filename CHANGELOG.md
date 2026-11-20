# Changelog

## 0.10.0 (2026-11-20)

- **OAuth 2.0 tokens**: `{{$auth.token("id")}}` and `{{$auth.idToken("id")}}` in any URL, header or body. The configuration lives in the environment, in the JetBrains HTTP Client format: `"Security": { "Auth": { "id": { "Type": "OAuth2", "Grant Type": …, "Token URL": …, "Client ID": … } } }`. A token is fetched before the first request that needs it, reused while it is valid, refreshed with its refresh token 30 s before it expires, and fetched again when the refresh fails. REST Client had no OAuth support ([#302](https://github.com/Huachao/vscode-restclient/issues/302)).
- Grant types: **Client Credentials**, **Password**, **Authorization Code** with optional **PKCE** (SHA-256 or plain; the sign-in opens in your browser and Plainwire receives the redirect on `http://127.0.0.1`/`localhost`, a free port by default), **Device Authorization** (the code is shown and copied, polling honours `slow_down`), **Implicit**, and `"Type": "Mock"` for a fixed token. Keys: `Client Credentials` (`basic` default, `in body`, `none`), `Scope`, `Redirect URL`, `Custom Request Parameters` / `Custom Request Headers` with `Use` (`Everywhere`, `In Auth Request`, `In Token Request`), `Acquire Automatically`, `Use ID Token`, `Open Complete URI`; any value can use `{{variables}}`. Checked live against Duende's public IdentityServer demo: Client Credentials, and Authorization Code + PKCE through a real browser login, including a refresh after the token expired.
- Object values in env files now **merge key by key** across `http-client.env.json` → `http-client.private.env.json` and `$shared` → the selected environment, so the private file can hold just the `Client Secret`. (Before, a later object replaced the whole value.)
- Request editor: the **Auth** tab has an **OAuth 2** option (pick a configuration of the current environment, send the ID token instead, *Acquire token now*).
- Commands **Plainwire: Acquire OAuth 2 Token…** (fresh token now) and **Plainwire: Clear OAuth 2 Tokens**. Tokens stay in memory for the window; they are not written to disk or history. Copy as cURL / Code uses a cached token and never starts a sign-in.
- A **JSON schema** for `http-client.env.json` / `http-client.private.env.json`: completions and hover text for every auth key and value.
- CLI: one token per `plainwire run`; browser grants print the sign-in URL (and open a browser in a terminal); `-v` logs token activity.
- Site: the "Cookies and session logins" guide's main content was rendered inside the page header (missing tags); fixed.
- **Environment editor**: *Plainwire: Edit Environments…* (also *Edit environments…* in the status-bar environment picker and in the Requests view's `…` menu) opens a form over `http-client.env.json`: environments as tabs with *Shared (all environments)* first, and per variable a name, a value and a **Secret** box. Add, rename and delete variables and environments; *Save* or `Ctrl/Cmd+S`, with an unsaved-changes marker.
- Secret values go to `http-client.private.env.json` in the same folder (created on first save) and are masked until you click *Show*. If the workspace's `.gitignore` does not cover that file, the editor says so and adds it in one click.
- Nothing you do not edit is lost: values that are not strings (objects such as an OAuth `Security` block, arrays, numbers, booleans) are shown read-only with *Open JSON* and written back as they were, `$schema` and other keys are kept, existing keys keep their order, and a file whose content does not change is not rewritten. Files are written with 2-space indent and a trailing newline.
- Several `http-client.env.json` files in the workspace: pick which folder's pair to edit. With none, the files are created in the first workspace folder. If the files change on disk while the editor is open, it reloads (no unsaved edits) or offers *Reload* / *Overwrite*. The active environment is still chosen in the status bar, and it picks up saved changes straight away.

## 0.9.0 (2026-11-20)

- **Cookie jar**: cookies a response sets (`Set-Cookie`) are kept and sent with later requests to the same site, like a browser, so a login that sets a session cookie works for the requests after it. Cookies set on a redirect hop are stored before the redirect is followed (login → 302 → dashboard works). Domain, path, `Secure` (also allowed for localhost over http), `Max-Age`/`Expires` and deletion follow RFC 6265; `__Secure-`/`__Host-` prefixes are enforced. A `Cookie:` header you write yourself is sent as written and wins over a jar cookie of the same name. In 0.8.0 no cookie was ever carried from one request to the next.
- One jar per workspace, saved in workspace storage (survives a reload). **Plainwire: Manage Cookies…** lists them (pick one to delete, or clear all); **Plainwire: Clear Cookies**. Setting `plainwire.rememberCookies` (default on).
- `# @no-cookie-jar` above a request (same spelling as REST Client and the JetBrains HTTP Client; also a checkbox on the Info tab): the request neither sends nor stores jar cookies.
- Response view: a **Cookies** tab with the cookies the response set (domain, path, expiry, flags; deletions struck through) and the `Cookie` header that was sent.
- Checks: `# @assert cookie <name> …` on a cookie this response sets, e.g. `cookie sessionid exists`.
- CLI: one jar per `plainwire run`; `--no-cookie-jar` turns it off. Checked against httpbin.org's cookie endpoints: 5/5 with the jar, 3 passed / 2 failed without.

## 0.8.0 (2026-11-20)

- **Import OpenAPI / Swagger from a URL**: the *Import OpenAPI / Swagger…* command now asks *From a file…* or *From a URL…*, and `plainwire import` accepts `https://…` URLs (redirects followed, proxy and `--insecure` honoured). A relative server URL such as `/api/v3` now resolves against the definition's URL, as the OpenAPI specification says (Swagger 2.0: a missing `host` is the host serving the definition), instead of falling back to `http://localhost`. Checked with the public Petstore 3 definition: imported from its URL, two requests then passed against the live server without setting `baseUrl`.

## 0.7.0 (2026-11-20)

- **Server-sent events**: a response with `Content-Type: text/event-stream` is shown event by event while it arrives (time, event type, id, data), with **Stop** in place of Cancel. The stream ends when the server closes it, when you stop it, at the timeout, or after `# @max-events N` events; all four keep what arrived and count as a response. gzip/deflate/br streams are decompressed as they arrive. Parsing follows the HTML standard (multi-line `data`, comments, `id`, `retry`, CRLF split across packets). Checked against Wikimedia's public recent-changes stream.
- **Checks on events**: `# @assert events.length == 3`, `events[0].event == tick`, `events[-1].data == "[DONE]"`, and paths into JSON data such as `events[0].data.delta`.
- **`# @timeout 5s`** (or `5000`, `2m`) sets the time limit for one request.
- **A default `User-Agent: plainwire/<version>`** is sent when the request sets none, like REST Client and curl do. Some servers refuse requests without one (Wikimedia's event stream answered 403).
- CLI: rows of streaming requests show the event count and how the stream ended, e.g. `5 events (max-events)`.

## 0.6.0 (2026-11-20)

- **Import another `.http` file**: `# @import ./shared.http` (also `// @import`, and JetBrains' `import ./shared.http`) makes that file's variables and `# @name` requests available. Chain to an imported login with `{{login.response.body.$.token}}`: it is sent first, with its own file's variables, once per session. The importing file's variables win over imported ones, a later import over an earlier one; nested imports work and a file is read once even in an import cycle. A missing file is a request error naming the import line. Works for Send, Run all, Copy as Code and the `plainwire` CLI. This was REST Client's most-reacted open request ([#182](https://github.com/Huachao/vscode-restclient/issues/182)).
- Import paths are Ctrl+click links to the file; `import` and `run` lines are highlighted.
- JetBrains `run #name` / `run ./file.http` lines are kept in the file and not executed. 0.5.0 read both `run …` and `import …` lines as GET requests.
- Editing the first request in the form editor keeps an `# @import` line above it.

## 0.5.0 (2026-11-20)

- **Import OpenAPI / Swagger** (new command *Plainwire: Import OpenAPI / Swagger…*, `plainwire import openapi.yaml`, and the [online converter](https://janwan2003.github.io/vscode-api-client/openapi-to-http-file.html)): OpenAPI 3.0/3.1 and Swagger 2.0, YAML or JSON. One `.http` file per tag (untagged operations grouped by path), one request per operation titled with its summary and named after its `operationId`; `{{baseUrl}}` and path parameters in the URL with their values in `http-client.env.json` (`$shared`, plus one environment per server); required query/header/cookie parameters filled from examples, defaults or the schema, optional query parameters listed in a comment; bodies from examples or generated from the schema (`$ref`, `allOf`, `oneOf`/`anyOf`, `readOnly` skipped; JSON, form with `a[b]=` nesting, multipart); Bearer/Basic/API key/OAuth 2 auth; a `# @assert status == …` check when the operation documents exactly one 2xx status. Checked on the GitHub (1,281 operations, 0.13 s), Stripe (612), Twilio (197) and both Petstore definitions: every operation becomes a request and every file reads back the same requests.
- **YAML** support in the importer (new dependency-free parser, `src/core/yaml.ts`).
- **httpYac `??` lines**: `exists` and `isTrue` are now truthy checks and `isFalse` a falsy check, exactly as in httpYac 6.16 (`?? body $.count isTrue` passes for 3). `# @assert` lines keep their stricter meaning (`exists` = defined, `isTrue` = `true`).
- Website: fixed a garbled row in the converter's mapping table.
- **Copy as Code → HTTPie** snippets now pass `--ignore-stdin` (except for `< file` bodies). Without it HTTPie read stdin whenever it was not a terminal (scripts, CI, editor tasks): `--raw` bodies failed with "cannot be mixed" and requests without a body waited 10 s. Found by running the snippets against a real HTTPie 3.2.4; CI now installs HTTPie so these runtime tests run.
- **httpYac compatibility, checked on 83 real public `.http` files** (305 found with GitHub code search; compared against httpYac 6.16.7's own parser, nothing sent): 77/83 files now parse into the same requests (was 56), 699/699 requests found (was 662). `?? body <path>` (e.g. `?? body data.id == 5`) now works; lines with several operators split at the last one, as httpYac does; `notequals`/`not equals`, `==200`. A new method line starts a new request even without `###`. `{{ }}` scripts, `< {% %}`/`> {% %}` handlers, `>>` redirects and `/* */` comments are kept in the file but never sent. Multi-line URLs are joined; `@a=b`, `@a b`, `@a := b` variables are read. JavaScript and xpath assertions still fail as unsupported (never evaluated).
- **Postman import**: at most one warning line per request, with checks skipped inside if/loop/callback/try summarised as a count.
- **Website**: free in-browser converters, [Postman / Thunder Client / cURL → .http](https://janwan2003.github.io/vscode-api-client/convert-to-http-file.html) and [.http → cURL and 10 other languages](https://janwan2003.github.io/vscode-api-client/http-file-to-curl.html), built from the same code as the extension.

## 0.4.0 (2026-11-20)

- **GraphQL**: requests in REST Client's format (`X-REQUEST-TYPE: GraphQL`, the query, a blank line, a JSON variables object) are sent as `{"query", "variables", "operationName"}` JSON, from the extension and the CLI, with `{{variables}}` in both parts. New GraphQL body mode in the request editor (Query + Variables). Postman and Thunder Client GraphQL requests now import in this format instead of a JSON body.
- **Copy as Code…**: any request as cURL, JavaScript fetch, Node.js fetch, Python requests, Go, HTTPie, PowerShell, wget, C# HttpClient, PHP cURL or Java HttpClient (CodeLens, command palette, sidebar, request editor). Remembers the last language.
- **Copy as cURL now resolves variables** (environment, file variables, `.env`, responses already received). Unknown or not-yet-sent chained variables stay as `{{name}}` with a warning; nothing is sent. The CodeLens row now shows *Copy as Code…* in place of *Copy as cURL* (cURL is the first choice).
- **httpYac `??` assertions** run unchanged: `?? status == 200`, `?? header content-type includes json`, `?? body $.id exists`, `?? duration < 500`, `?? js response.parsedBody.name == "Ada"`. JavaScript is never evaluated: other `?? js` expressions and `?? xpath` fail with "unsupported httpYac assertion". `??` lines are highlighted and are never sent as part of the body.
- New operators for `# @assert` and `??`: `isTrue`, `isFalse`, `md5`, `sha256`, `sha512`.
- **Postman import**: checks inside `if`/`else`, loops, `try` or callbacks are no longer converted into unconditional checks; each is listed as a warning.

## 0.3.0 (2026-11-20)

- **Command-line runner for CI** (free, single file, Node 18+): `plainwire run [files|folders|"globs"] --env <name>` sends every request in order and checks its `# @assert` lines; exit code 1 on failure. JUnit XML, JSON and Markdown reports; `--grep`, `--bail`, `--var name=value`, `--env-file`, `--insecure`, `--proxy`, `--timeout`. In GitHub Actions it writes a job summary and marks failed requests on the PR diff. Download `plainwire.mjs` from the release, or `npm install -g` the release tarball.
- **GitHub Action**: `uses: janwan2003/vscode-api-client@v0.3.0` with `files`, `env`, `junit`, `args`.
- **`plainwire import`**: convert Postman / Thunder Client exports, a `thunder-tests/` folder or a curl command to `.http` files from the terminal.
- The extension and the CLI share one request engine (`src/core/exec.ts`), so a file that passes in VS Code passes in CI. Chained requests referenced only from `# @assert` lines are now sent first too.
- Publisher ID is now `plainbyte` (extension ID `plainbyte.plainwire`).

## 0.2.0 (2026-11-20)

- **Tests**: `# @assert <subject> <operator> [value]` lines (status, time, size, body, header, JSONPath; `==` `!=` `<` `>` `contains` `matches` `exists` `isNumber` …), evaluated after every send. Tests tab in the request editor; pass/fail in the response view.
- **Run all**: run every request in a file, folder or the workspace in order (CodeLens, editor title, Explorer and sidebar menus), with a pass/fail report, *Re-run failed* and *Copy report (Markdown)*. `# @skip` skips a request.
- **Import**: Thunder Client tests and common Postman test snippets become `# @assert` lines.
- **Networking**: requests now go through Node's http/https instead of fetch: any port (fetch refused e.g. 6000 and 10080), self-signed certificates (`# @insecure` or `plainwire.rejectUnauthorized`), HTTP proxies (`plainwire.proxy` / `http.proxy` / `HTTPS_PROXY`, CONNECT tunnelling, `NO_PROXY`), exact header casing, gzip/deflate/brotli, safer redirects (Authorization dropped across hosts). Response size is now bytes on the wire.

## 0.1.0 (2026-11-20)

First release: request editor, response viewer, .http files with CodeLens, environments, system variables, request chaining, history, Thunder Client / Postman / cURL import, copy as cURL.
