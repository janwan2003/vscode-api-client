# Changelog

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
