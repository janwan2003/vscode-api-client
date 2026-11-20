# plainwire CLI

Run and test `.http` / `.rest` files (the REST Client and JetBrains HTTP format) from the command line and in CI.
It's the command-line half of the [Plainwire](https://janwan2003.github.io/vscode-api-client/) VS Code extension:
no account, no login, no telemetry, no limits. It is a single file and needs nothing but Node.js 18 or newer.

```sh
# one file, no install
curl -fsSLO https://github.com/janwan2003/vscode-api-client/releases/latest/download/plainwire.mjs
node plainwire.mjs run api/ --env staging

# or install the command globally
npm install -g https://github.com/janwan2003/vscode-api-client/releases/download/v0.3.0/plainwire-cli-0.3.0.tgz
plainwire run "tests/**/*.http" --junit results.xml
```

## What it runs

Every request in the given files, in order. A request **passes** when all its `# @assert` lines pass. A request
without any `# @assert` line passes when its status is below 400. `# @skip` skips a request.

```http
### Log in
# @name login
POST {{base}}/login
Content-Type: application/json

{"user": "{{user}}", "password": "{{$dotenv API_PASSWORD}}"}

### Current user
# @assert status == 200
# @assert $.roles contains "admin"
# @assert header content-type contains json
# @assert time < 500
GET {{base}}/me
Authorization: Bearer {{login.response.body.$.token}}
```

The CLI understands the same syntax as the extension: file variables, `{{$guid}}` / `{{$timestamp}}` / `{{$dotenv X}}` /
`{{$processEnv X}}`, request chaining, `< ./file` bodies, `# @no-redirect` and `# @insecure`.
Environments come from `http-client.env.json`, `http-client.private.env.json` and `rest-client.environmentVariables`
in `.vscode/settings.json`.

## Options

```
plainwire run [files, folders or "globs"...]
  -e, --env <name>        environment
      --env-file <file>   extra environment file (repeatable)
      --var name=value    set a variable (repeatable)
  -g, --grep <regex>      only requests whose title, @name or URL matches
      --bail              stop after the first failure
      --timeout <ms>      per-request timeout (default 60000)
  -k, --insecure          accept self-signed certificates
      --proxy <url>       HTTP proxy (default HTTPS_PROXY / HTTP_PROXY, NO_PROXY honoured)
      --no-redirect       do not follow redirects
      --junit <file>      JUnit XML report
      --json <file>       JSON report
      --markdown <file>   Markdown report
  -v, --verbose           print the response body of failed requests
  -q, --quiet             only failures and the summary

plainwire import <postman.json | thunder-export.json | thunder-tests/ | curl.txt>... [--out http/]
```

Exit code: `0` all passed, `1` a request failed or errored, `2` usage error.
In GitHub Actions it also writes a job summary and marks failed requests on the PR diff.

## GitHub Actions

```yaml
- uses: actions/checkout@v4
- uses: janwan2003/vscode-api-client@v0.3.0
  with:
    files: api/
    env: ci
    junit: plainwire-results.xml
    args: --var token=${{ secrets.API_TOKEN }}
```

MIT licensed. Source: https://github.com/janwan2003/vscode-api-client
