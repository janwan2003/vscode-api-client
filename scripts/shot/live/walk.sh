#!/bin/bash
# Keep a real headless VS Code with Plainwire open for hand-walking the GUI (same setup as hero.sh, but it stays up).
# Drive it with: curl --data-binary '<js>' 127.0.0.1:9444/eval  (extension host)  and  node scripts/shot/live/cdp.mjs ...
# Usage: scripts/shot/live/walk.sh WORKSPACE_DIR [code binary]   (Ctrl-C / kill to stop)
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); H=$ROOT/scripts/shot/live; WS=$1; CODE=${2:-/snap/code/current/usr/share/code/code}
T=$(mktemp -d); mkdir -p $T/user/User
echo '{"workbench.startupEditor":"none","workbench.colorTheme":"Default Dark Modern","workbench.secondarySideBar.defaultVisibility":"hidden","chat.commandCenter.enabled":false,"chat.disableAIFeatures":true,"workbench.tips.enabled":false,"extensions.ignoreRecommendations":true}' > $T/user/User/settings.json
node $H/server.mjs & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf $T' EXIT
SHOT_READY=$T/ready DONT_PROMPT_WSL_INSTALL=1 "$CODE" "$WS" --extensionDevelopmentPath=$ROOT --extensionTestsPath=$H/driver.cjs --user-data-dir=$T/user --extensions-dir=$T/ext --disable-extensions --disable-gpu --no-sandbox --disable-workspace-trust --skip-welcome --skip-release-notes --ozone-platform=headless --window-size=1280,800 --remote-debugging-port=9333
