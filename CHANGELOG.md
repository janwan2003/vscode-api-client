# Changelog

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
