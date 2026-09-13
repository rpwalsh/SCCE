#!/bin/sh
# The authoritative measurement. Everything a lane measured was measured against its own build; this is the one
# run that decides, built from committed main only, with one corpus state for all 311 rows.
set -e
cd "$(dirname "$0")/.."

STAMP=$(date -u +%Y%m%dT%H%M)
OUT="artifacts/head-to-head/results-final-${STAMP}.json"

echo "== 1. committed state only =="
git status --porcelain -- packages/ | grep . && { echo "REFUSING: uncommitted changes under packages/"; exit 1; } || true
git log --oneline -1

echo "== 2. build =="
powershell -NoProfile -Command "Set-Location '$(pwd -W 2>/dev/null || pwd)'; pnpm -r build" 2>&1 | tail -3

echo "== 3. restart under the lock =="
LANE=final node tools/with-server-lock.mjs sh scripts/restart-server.sh

echo "== 4. full suite, both systems =="
LANE=final node tools/with-server-lock.mjs node tools/head-to-head/run.mjs --out "$OUT"

echo "== 5. page =="
node tools/results-page/build.mjs --in "$OUT" --out artifacts/results-page/index.html
echo "$OUT"
