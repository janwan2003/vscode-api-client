# Store listing: Plainwire

Package: `corepack pnpm@9.15.0 install && corepack pnpm@9.15.0 package` → `plainwire-<version>.vsix`.
The Marketplace and Open VSX both render README.md as the listing page; `package.json` holds the rest.

- **Extension ID:** `plainbyte.plainwire` (publisher `plainbyte`, the studio publisher shared with the other studio
  extensions; change `publisher` in package.json if the operator's publisher ID differs: it must match the account.)
- **Display name:** Plainwire — API Client (no login, plain .http files)
- **Short description:** see `description` in package.json.
- **Categories:** Programming Languages, Testing, Other. **Keywords:** in package.json (Marketplace allows max 30).
- **Icon:** media/icon.png (256×256). **Screenshot:** docs/screenshot.png (shown in README).
- **Privacy policy:** https://janwan2003.github.io/vscode-api-client/privacy.html
- **Support:** https://janwan2003.github.io/vscode-api-client/support.html

## Publish commands (need tokens the operator creates)

```sh
# VS Code Marketplace: Azure DevOps PAT with Marketplace (Manage) scope, publisher "plainbyte" created at
# https://marketplace.visualstudio.com/manage
VSCE_PAT=... npx @vscode/vsce publish --no-dependencies -i plainwire-0.17.0.vsix
# Open VSX: token from https://open-vsx.org/user-settings/tokens after signing the publisher agreement
npx ovsx create-namespace plainbyte -p $OVSX_PAT     # once
npx ovsx publish plainwire-0.17.0.vsix -p $OVSX_PAT
```
Store the tokens in the studio `.env` as `VSCE_PAT` and `OVSX_PAT` so builders can publish updates.

## CLI (no store needed)

`node scripts/build-cli.mjs` → `dist/cli/plainwire.mjs` and `dist/plainwire-cli-<version>.tgz`; both go on the GitHub
release (the Action downloads `plainwire.mjs` from it). With an `NPM_TOKEN` a builder could also run
`npm publish dist/plainwire-cli-<version>.tgz` (package name `plainwire`).
