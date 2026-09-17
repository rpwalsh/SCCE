#!/bin/sh
# Take an ingested brain live: learn the language identities over everything ingested, serve it, ask the gauntlet.
#   scripts/go-live.sh [config]
set -e
cd "$(dirname "$0")/.."
CONFIG="${1:-scce.config.new.json}"
echo "--- language identities --rebuild"
node --max-old-space-size=7168 packages/cli/dist/index.js --config "$CONFIG" language identities --rebuild | grep -vE '^\s*"(pattern|unit)' | head -40
echo "--- restart server on $CONFIG"
sh scripts/restart-server.sh "$CONFIG"
echo "--- gauntlet"
node tools/gauntlet.mjs
