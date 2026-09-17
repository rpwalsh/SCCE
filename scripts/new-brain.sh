#!/bin/sh
# Build a brain from nothing: create the schema, migrate it, ingest the configured corpora, learn the
# language identities, and report what landed. Idempotent -- re-running resumes rather than duplicating.
#
#   scripts/new-brain.sh [config]          # default scce.config.new.json
#
# The schema and every corpus path come from the config; credentials come from the config or
# SCCE_DATABASE_URL and are never echoed. Identity discovery runs LAST on purpose: documents ingested
# after the final rebuild carry no language identity and are unreachable at answer time.
set -e
cd "$(dirname "$0")/.."
CONFIG="${1:-scce.config.new.json}"
CLI="node --max-old-space-size=7168 packages/cli/dist/index.js --config $CONFIG"
[ -f "$CONFIG" ] || { echo "no such config: $CONFIG"; exit 1; }

schema=$(node -e "console.log(require('./$CONFIG').database.schema)")
echo "=== new brain in schema $schema from $CONFIG"

step() { echo; echo "--- $1"; shift; "$@"; }

step "db init" $CLI db init
step "db migrate" $CLI db migrate
step "db verify" $CLI db verify

# Corpora. Each is skipped when the config does not enable it or the path is not on disk, so a machine
# with only a wiki dump still produces a working brain rather than a failed script.
wiki=$(node -e "const c=require('./$CONFIG').runtime.corpora||{};const w=c.wikipedia||{};console.log(w.enabled&&w.dumpPath?w.dumpPath:'')")
if [ -n "$wiki" ] && [ -f "$wiki" ]; then
  step "ingest wikipedia" $CLI ingest wiki
else
  echo; echo "--- skip wikipedia (not enabled, or dump not at the configured path)"
fi

for dir in data/gutenberg data/books; do
  if [ -d "$dir" ]; then step "corpus train gutenberg $dir" $CLI corpus train gutenberg "$dir"; fi
done

# Code corpus: every checkout under data/oss becomes a versioned software artifact, not a pile of text.
if [ -d data/oss ]; then
  for repo in data/oss/*; do
    [ -d "$repo" ] || continue
    step "corpus train oss $repo" $CLI corpus train oss "$repo"
  done
fi

# Must be last: identity discovery is one-shot over whatever is already ingested.
step "language identities --rebuild" $CLI language identities --rebuild

step "db stats" $CLI db stats
echo
echo "=== brain ready in $schema. Start the server on it with: scripts/restart-server.sh $CONFIG"
