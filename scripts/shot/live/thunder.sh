#!/bin/bash
# Real-window walk of "import Thunder Client's own data": seeds a Thunder Client storage folder (current layout:
# collections/tc_col_*.json, environments/tc_env_*.json, plus an old NeDB thunderActivity.db history) into a fresh
# VS Code profile, opens an empty workspace, and screenshots the one-time offer, the picker and the imported result.
# Usage: scripts/shot/live/thunder.sh [code binary]   Output: $OUT_DIR (default /tmp/pw-thunder-shots), docs/thunder-import.png
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); H=$ROOT/scripts/shot/live; CODE=${1:-/snap/code/current/usr/share/code/code}
OUT=${OUT_DIR:-/tmp/pw-thunder-shots}; mkdir -p $OUT
T=$(mktemp -d); WS=$T/shop-api; mkdir -p $WS/src $T/user/User
TC=$T/user/User/globalStorage/rangav.vscode-thunder-client; mkdir -p $TC/collections $TC/environments
echo '# shop-api' > $WS/README.md; echo 'export {};' > $WS/src/index.ts
cat > $TC/collections/tc_col_shop.json <<'J'
{"_id":"c-shop","colName":"Shop API","created":"2026-09-01T09:00:00.000Z","sortNum":10000,
 "folders":[{"_id":"f-orders","name":"Orders","containerId":"","created":"2026-09-01T09:00:00.000Z","sortNum":20000}],
 "settings":{"headers":[{"name":"Accept","value":"application/json"}]},
 "requests":[
  {"_id":"r1","colId":"c-shop","containerId":"","name":"List users","url":"{{host}}/users","method":"GET","sortNum":10000,"created":"2026-09-01T09:00:00.000Z","modified":"2026-11-10T09:00:00.000Z","headers":[],"params":[],"tests":[{"type":"res-code","custom":"","action":"equal","value":"200"}]},
  {"_id":"r2","colId":"c-shop","containerId":"","name":"Create user","url":"{{host}}/users","method":"POST","sortNum":20000,"created":"2026-09-01T09:00:00.000Z","modified":"2026-11-10T09:00:00.000Z","headers":[],"params":[],"body":{"type":"json","raw":["{","  \"name\": \"Ada Lovelace\",","  \"email\": \"ada@example.com\"","}"],"form":[]},"auth":{"type":"bearer","bearer":"{{token}}"},"tests":[{"type":"res-code","custom":"","action":"equal","value":"201"},{"type":"json-query","custom":"json.id","action":"istype","value":"number"}]},
  {"_id":"r3","colId":"c-shop","containerId":"f-orders","name":"Open orders","url":"{{host}}/orders?status=open","method":"GET","sortNum":10000,"created":"2026-09-01T09:00:00.000Z","modified":"2026-11-10T09:00:00.000Z","headers":[],"params":[{"name":"status","value":"open","isPath":false}],"tests":[]}
 ]}
J
cat > $TC/collections/tc_col_auth.json <<'J'
{"_id":"c-auth","colName":"Auth","created":"2026-09-02T09:00:00.000Z","sortNum":20000,"folders":[],
 "requests":[{"_id":"a1","colId":"c-auth","containerId":"","name":"Login","url":"{{host}}/login","method":"POST","sortNum":10000,"created":"2026-09-02T09:00:00.000Z","modified":"2026-11-12T09:00:00.000Z","headers":[],"params":[],"body":{"type":"formencoded","raw":"","form":[{"name":"user","value":"ada"},{"name":"password","value":"{{password}}"}]},"tests":[]}]}
J
echo '{"_id":"e-dev","name":"dev","default":false,"sortNum":10000,"created":"2026-09-01T09:00:00.000Z","modified":"2026-09-01T09:00:00.000Z","data":[{"name":"host","value":"http://127.0.0.1:8787"},{"name":"token","value":"dev-token-1234"},{"name":"password","value":"correct-horse"}]}' > $TC/environments/tc_env_dev.json
printf '%s\n' '{"_id":"h1","colId":"history","containerId":"","name":"http://127.0.0.1:8787/users/1","url":"http://127.0.0.1:8787/users/1","method":"GET","sortNum":0,"created":"2026-11-18T09:00:00.000Z","modified":"2026-11-18T09:00:00.000Z","headers":[],"params":[],"tests":[]}' \
  '{"_id":"h2","colId":"history","containerId":"","name":"http://127.0.0.1:8787/users/1","url":"http://127.0.0.1:8787/users/1","method":"GET","sortNum":0,"created":"2026-11-19T09:00:00.000Z","modified":"2026-11-19T09:00:00.000Z","headers":[],"params":[],"tests":[]}' \
  '{"_id":"h3","colId":"history","containerId":"","name":"http://127.0.0.1:8787/orders","url":"http://127.0.0.1:8787/orders","method":"GET","sortNum":0,"created":"2026-11-17T09:00:00.000Z","modified":"2026-11-17T09:00:00.000Z","headers":[],"params":[],"tests":[]}' > $TC/thunderActivity.db
echo '{"workbench.startupEditor":"none","workbench.colorTheme":"Default Dark Modern","workbench.secondarySideBar.defaultVisibility":"hidden","chat.commandCenter.enabled":false,"chat.disableAIFeatures":true,"workbench.tips.enabled":false,"extensions.ignoreRecommendations":true}' > $T/user/User/settings.json
node $H/server.mjs & SRV=$!
SHOT_READY=$T/ready DONT_PROMPT_WSL_INSTALL=1 "$CODE" "$WS" --extensionDevelopmentPath=$ROOT --extensionTestsPath=$H/driver.cjs --user-data-dir=$T/user --extensions-dir=$T/ext --disable-extensions --disable-gpu --no-sandbox --disable-workspace-trust --skip-welcome --skip-release-notes --ozone-platform=headless --window-size=1280,800 --remote-debugging-port=9333 >/dev/null 2>&1 & VS=$!
trap 'kill $VS $SRV 2>/dev/null; rm -rf $T' EXIT
for i in $(seq 90); do [ -f $T/ready ] && break; sleep 1; done
ev() { curl -s --data-binary "$1" http://127.0.0.1:9444/eval; echo; }
# The extension activates on startup (no .http files here) and offers the import once, ~4 s later.
for i in $(seq 20); do node $H/cdp.mjs eval "document.querySelector('.notification-toast')?.innerText || ''" | grep -q "Thunder Client" && break; sleep 1; done
node $H/cdp.mjs eval "document.querySelector('.notification-toast')?.innerText || '(no toast)'"
node $H/cdp.mjs eval "([...document.querySelectorAll('.notification-toast-container')].filter(t => /temporarily disabled/.test(t.innerText)).forEach(t => t.style.display = 'none'), 'hidden')" >/dev/null
node $H/cdp.mjs shot $OUT/1-offer.png
# Click "Import" on the toast (a real click on the button in the workbench DOM).
node $H/cdp.mjs eval "[...document.querySelectorAll('.notification-toast a.monaco-button, .notification-toast .monaco-button')].find(b => b.innerText.trim() === 'Import')?.click(), 'clicked'"
sleep 2; node $H/cdp.mjs eval "[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.innerText.replace(/\n/g,' | ')).join('\n')"
node $H/cdp.mjs eval "([...document.querySelectorAll('.notification-toast-container')].filter(t => /temporarily disabled/.test(t.innerText)).forEach(t => t.style.display = 'none'), 'hidden')" >/dev/null
node $H/cdp.mjs shot $OUT/2-picker.png
cp $OUT/2-picker.png $ROOT/docs/thunder-import.png
ev "await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); 'accepted location'"
sleep 1; node $H/cdp.mjs eval "[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.innerText.replace(/\n/g,' | ')).join('\n')"
node $H/cdp.mjs shot $OUT/3-history.png
ev "await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext'); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); 'accepted history'"
sleep 3
node $H/cdp.mjs eval "([...document.querySelectorAll('.notification-toast-container')].filter(t => /temporarily disabled/.test(t.innerText)).forEach(t => t.style.display = 'none'), 'hidden')" >/dev/null
node $H/cdp.mjs shot $OUT/4-imported.png
find $WS/http -type f | sed "s|$WS/||" | sort
echo '--- Shop API'; cat "$WS/http/Shop API/requests.http" 2>/dev/null || ls -R $WS/http
echo '--- history'; cat "$WS/http/Thunder Client history/"*.http 2>/dev/null | head -20
