#!/bin/bash
# Real VS Code screenshots for the README / store listing: docs/environments.png (environment editor) and
# docs/run-all.png (Run all report). Same setup as hero.sh: headless VS Code + driver.cjs (:9444) + cdp.mjs.
# Usage: scripts/shot/live/shots.sh [/snap/code/current/usr/share/code/code]
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); H=$ROOT/scripts/shot/live; CODE=${1:-/snap/code/current/usr/share/code/code}
T=$(mktemp -d); WS=$T/ws; mkdir -p $WS/api $T/user/User
cat > $WS/api/users.http <<'H'
### Create user
# @name createUser
# @assert status == 201
# @assert $.id isNumber
POST {{host}}/users
Content-Type: application/json
Authorization: Bearer {{token}}

{"name": "Ada Lovelace", "email": "ada@example.com"}

### Get user
# @assert status == 200
# @assert $.email == "ada@example.com"
GET {{host}}/users/1

### List orders
# @assert status == 200
GET {{host}}/orders?status=open

### Delete user (not allowed yet)
# @assert status == 204
DELETE {{host}}/err
H
echo '{"$shared": {"apiVersion": "v2"}, "dev": {"host": "http://127.0.0.1:8787", "user": "ada"}, "staging": {"host": "https://staging.example.com", "user": "qa-bot"}, "production": {"host": "https://api.example.com"}}' > $WS/api/http-client.env.json
echo '{"dev": {"token": "dev-token-1234", "password": "correct-horse"}}' > $WS/api/http-client.private.env.json
printf 'node_modules/\nhttp-client.private.env.json\n' > $WS/.gitignore
echo '{"workbench.startupEditor":"none","workbench.colorTheme":"Default Dark Modern","workbench.secondarySideBar.defaultVisibility":"hidden","chat.commandCenter.enabled":false,"chat.disableAIFeatures":true,"workbench.tips.enabled":false,"extensions.ignoreRecommendations":true}' > $T/user/User/settings.json
node $H/server.mjs & SRV=$!
SHOT_READY=$T/ready DONT_PROMPT_WSL_INSTALL=1 "$CODE" "$WS" --extensionDevelopmentPath=$ROOT --extensionTestsPath=$H/driver.cjs --user-data-dir=$T/user --extensions-dir=$T/ext --disable-extensions --disable-gpu --no-sandbox --disable-workspace-trust --skip-welcome --skip-release-notes --ozone-platform=headless --window-size=1280,800 --remote-debugging-port=9333 >/dev/null 2>&1 & VS=$!
for i in $(seq 90); do [ -f $T/ready ] && break; sleep 1; done; sleep 3
ev() { curl -s --data-binary "$1" http://127.0.0.1:9444/eval >/dev/null; }
wv() { curl -s http://127.0.0.1:9333/json/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).filter(x=>x.type==="iframe"&&x.url.includes("extensionId=plainbyte.plainwire"));process.stdout.write(t.length?new URL(t[t.length-1].url).host:"")})'; }
ev "const api = await vscode.extensions.getExtension('plainbyte.plainwire').activate(); await api.envsForTest.select('dev'); await vscode.commands.executeCommand('workbench.view.extension.plainwire'); await vscode.commands.executeCommand('plainwire.editEnvironments'); await vscode.commands.executeCommand('notifications.clearAll');"
sleep 2
node $H/cdp.mjs shot /dev/null >/dev/null
node $H/cdp.mjs sash 300
# Show the secret column state: dev has two secrets (masked).
node $H/cdp.mjs shot "${OUT_ENV:-$ROOT/docs/environments.png}"
ev "await vscode.commands.executeCommand('workbench.action.closeAllEditors'); const t = vscode.extensions.getExtension('plainbyte.plainwire').exports.collectionsForTest; await vscode.commands.executeCommand('plainwire.runFile', vscode.Uri.file('$WS/api/users.http')); await vscode.commands.executeCommand('notifications.clearAll');"
sleep 3
node $H/cdp.mjs shot "${OUT_RUN:-$ROOT/docs/run-all.png}"
kill $VS $SRV 2>/dev/null; sleep 1; rm -rf $T
