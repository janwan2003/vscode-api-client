# Changelog

## 0.2.0 (2026-11-20)

- **Tests**: `# @assert <subject> <operator> [value]` lines (status, time, size, body, header, JSONPath; `==` `!=` `<` `>` `contains` `matches` `exists` `isNumber` …), evaluated after every send. Tests tab in the request editor; pass/fail in the response view.
- **Run all**: run every request in a file, folder or the workspace in order (CodeLens, editor title, Explorer and sidebar menus), with a pass/fail report, *Re-run failed* and *Copy report (Markdown)*. `# @skip` skips a request.
- **Import**: Thunder Client tests and common Postman test snippets become `# @assert` lines.
- **Networking**: requests now go through Node's http/https instead of fetch: any port (fetch refused e.g. 6000 and 10080), self-signed certificates (`# @insecure` or `plainwire.rejectUnauthorized`), HTTP proxies (`plainwire.proxy` / `http.proxy` / `HTTPS_PROXY`, CONNECT tunnelling, `NO_PROXY`), exact header casing, gzip/deflate/brotli, safer redirects (Authorization dropped across hosts). Response size is now bytes on the wire.

## 0.1.0 (2026-11-20)

First release: request editor, response viewer, .http files with CodeLens, environments, system variables, request chaining, history, Thunder Client / Postman / cURL import, copy as cURL.
