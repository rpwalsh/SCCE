#!/bin/sh
# Build a brain from nothing, or resume one: create the schema, migrate it, defer the read indexes, ingest the
# configured corpora, restore the indexes, verify, then learn the language identities and report what landed.
#
#   scripts/new-brain.sh [config] [max-pages]     # default scce.config.new.json, 20000
#
# Every corpus path and the schema come from the config; credentials come from the config overlay or
# SCCE_DATABASE_URL and are never echoed.
#
# Three properties this script exists to guarantee, each of which was violated by a real build:
#   RESUMABLE  -- resume is the ingestor's own, not a byte offset pasted into this script. A script that picks
#                 the furthest recorded checkpoint skips every block between a gap and that maximum, which is
#                 how a corpus loses pages without anyone seeing it.
#   LOUD       -- any step failing stops the build. A wiki run that reads blocks and stores no page now exits
#                 non-zero instead of printing a summary full of zeros and returning success.
#   SERVEABLE  -- read indexes are dropped only between the deferral and the restore, and `db verify` refuses
#                 the schema for as long as they are missing, so a half-indexed brain cannot be served.
set -e
cd "$(dirname "$0")/.."
CONFIG="${1:-scce.config.new.json}"
MAX_PAGES="${2:-20000}"
CLI="node --max-old-space-size=7168 packages/cli/dist/index.js --config $CONFIG"
[ -f "$CONFIG" ] || { echo "no such config: $CONFIG"; exit 1; }

SCHEMA=$(node -e "console.log(require('./$CONFIG').database.schema)")
echo "=== brain build in schema $SCHEMA from $CONFIG (max-pages=$MAX_PAGES)"

step() { echo; echo "--- $1"; shift; "$@"; }

step "db migrate" $CLI db migrate
step "db verify" $CLI db verify

# Index maintenance on ngram_observations is 63% of the insert cost during a corpus build (measured on 248,778
# rows: 20,512ms with the production indexes, 7,503ms with none), while rebuilding them afterwards from sorted
# data costs seconds. db migrate below is what puts them back, and db verify fails until it has.
step "db indexes defer" $CLI db indexes defer --confirm-not-serving

WIKI=$(node -e "const w=(require('./$CONFIG').runtime.corpora||{}).wikipedia||{};console.log(w.enabled&&w.dumpPath?w.dumpPath:'')")
if [ -n "$WIKI" ] && [ -f "$WIKI" ]; then
  step "ingest wikipedia (resuming from the ingestor's own checkpoint)" $CLI ingest wiki --max-pages="$MAX_PAGES"
else
  echo; echo "--- skip wikipedia (not enabled, or dump not at the configured path)"
fi

for dir in data/gutenberg data/books; do
  [ -d "$dir" ] && step "corpus train gutenberg $dir" $CLI corpus train gutenberg "$dir"
done

# Code corpus: every checkout under data/oss becomes a versioned software artifact, not a pile of text.
if [ -d data/oss ]; then
  for repo in data/oss/*; do
    [ -d "$repo" ] && step "corpus train oss $repo" $CLI corpus train oss "$repo"
  done
fi

step "db migrate (restores the deferred indexes)" $CLI db migrate
step "db verify (fails while any index is still deferred)" $CLI db verify

# Must be last: identity discovery is one-shot over whatever is already ingested, and anything ingested after
# it carries no language identity, which makes it unreachable at answer time.
step "language identities --rebuild" $CLI language identities --rebuild

step "progress" sh scripts/brain-progress.sh "$CONFIG"
echo
echo "=== brain ready in $SCHEMA. Serve it with: scripts/restart-server.sh $CONFIG"
