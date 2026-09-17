#!/bin/sh
# What a brain actually contains, and whether it is serveable. Safe to run during a build.
#   scripts/brain-progress.sh [config]
set -e
cd "$(dirname "$0")/.."
CONFIG="${1:-scce.config.new.json}"
node --max-old-space-size=2048 packages/cli/dist/index.js --config "$CONFIG" db indexes status
node scripts/brain-progress.mjs "$CONFIG"
