#!/bin/bash
# Real VS Code screenshot of the request editor (docs/screenshot.png): headless VS Code with a DevTools port,
# driver.cjs answers commands on 127.0.0.1:9444, cdp.mjs fills the webview through an isolated world and captures.
# Usage: scripts/shot/live/hero.sh [/snap/code/current/usr/share/code/code]
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); H=$ROOT/scripts/shot/live; CODE=${1:-/snap/code/current/usr/share/code/code}
T=$(mktemp -d); WS=$T/ws; mkdir -p $WS/api $T/user/User
cat > $WS/api/users.http <<'H'
@contentType = application/json

### Create user
# @name createUser
# @assert status == 201
# @assert $.id isNumber
# @assert $.email == "ada@example.com"
# @assert time < 500
POST {{host}}/users?notify=true
Content-Type: {{contentType}}
Authorization: Bearer {{token}}

{"name": "Ada Lovelace", "email": "ada@example.com", "roles": ["admin"]}

### Get user
GET {{host}}/users/1

### List orders
GET {{host}}/orders?status=open
H
echo '{"dev": {"host": "http://127.0.0.1:8787", "token": "dev-token"}, "staging": {"host": "https://staging.example.com"}}' > $WS/api/http-client.env.json
echo '{"workbench.startupEditor":"none","workbench.colorTheme":"Default Dark Modern","workbench.secondarySideBar.defaultVisibility":"hidden","chat.commandCenter.enabled":false,"chat.disableAIFeatures":true,"workbench.tips.enabled":false,"extensions.ignoreRecommendations":true}' > $T/user/User/settings.json
node $H/server.mjs & SRV=$!
SHOT_READY=$T/ready DONT_PROMPT_WSL_INSTALL=1 "$CODE" "$WS" --extensionDevelopmentPath=$ROOT --extensionTestsPath=$H/driver.cjs --user-data-dir=$T/user --extensions-dir=$T/ext --disable-extensions --disable-gpu --no-sandbox --disable-workspace-trust --skip-welcome --skip-release-notes --ozone-platform=headless --window-size=1280,800 --remote-debugging-port=9333 >/dev/null 2>&1 & VS=$!
for i in $(seq 90); do [ -f $T/ready ] && break; sleep 1; done; sleep 3
ev() { curl -s --data-binary "$1" http://127.0.0.1:9444/eval >/dev/null; }
ev "const api = await vscode.extensions.getExtension('plainbyte.plainwire').activate(); await api.envsForTest.select('dev'); await vscode.commands.executeCommand('workbench.view.extension.plainwire'); const t = api.collectionsForTest; let n; let kids = await t.getChildren(undefined); while (kids.length && !kids[0].request) { n = kids[0]; kids = await t.getChildren(n); } const reqs = kids; await api.organizerForTest.view.reveal(reqs[0], { select: true, focus: false }); await vscode.commands.executeCommand('plainwire.sendRequest', reqs[0]); await vscode.commands.executeCommand('notifications.clearAll');"
sleep 2
WV=$(curl -s http://127.0.0.1:9333/json/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).filter(x=>x.type==="iframe"&&x.url.includes("extensionId=plainbyte.plainwire"));process.stdout.write(t.length?new URL(t[0].url).host:"")})')
node $H/cdp.mjs shot /dev/null >/dev/null
node $H/cdp.mjs sash 300
node $H/cdp.mjs eval '(() => { [...document.querySelectorAll("button.tab")].find(b => b.textContent.startsWith("Tests")).click(); return 1; })()' "$WV" >/dev/null
sleep 0.5
node $H/cdp.mjs shot "${OUT:-$ROOT/docs/screenshot.png}"
kill $VS $SRV 2>/dev/null; sleep 1; rm -rf $T
