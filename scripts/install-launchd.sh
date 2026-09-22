#!/usr/bin/env bash
# Installs the Aquarius local service as a launchd agent (macOS).
#
# launchd's only job here is process supervision: start at login, restart on
# crash. The daily 03:00 Asia/Shanghai ingestion window and the missed-window
# catch-up are enforced by the application itself.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AQUARIUS_HOME="${AQUARIUS_HOME:-$HOME/.aquarius}"
NODE_BIN="$(command -v node || true)"
ENTRY="$APP_ROOT/packages/server/src/main.ts"
TEMPLATE="$APP_ROOT/deploy/launchd/com.aquarius.server.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.aquarius.server.plist"
LABEL="com.aquarius.server"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node is not on PATH" >&2
  exit 1
fi

if [[ ! -f "$ENTRY" ]]; then
  echo "error: cannot find the service entry point at $ENTRY" >&2
  exit 1
fi

mkdir -p "$AQUARIUS_HOME/logs" "$(dirname "$TARGET")"
sed -e "s|@AQUARIUS_NODE@|$NODE_BIN|g" \
    -e "s|@AQUARIUS_ENTRY@|$ENTRY|g" \
    -e "s|@AQUARIUS_APP_ROOT@|$APP_ROOT|g" \
    -e "s|@AQUARIUS_HOME@|$AQUARIUS_HOME|g" \
    "$TEMPLATE" > "$TARGET"

chmod 600 "$TARGET"

# Reload cleanly if the agent is already installed.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl enable "gui/$(id -u)/$LABEL"

echo "installed $LABEL"
echo "  plist:   $TARGET"
echo "  home:    $AQUARIUS_HOME"
echo "  logs:    $AQUARIUS_HOME/logs/aquarius.err.log"
echo
echo "The service generates its local API token in $AQUARIUS_HOME/config.json on first start."
echo "Check it with: $APP_ROOT/packages/cli/src/main.ts doctor"
