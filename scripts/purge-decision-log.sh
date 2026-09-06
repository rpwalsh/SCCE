#!/usr/bin/env bash
# Purges DECISIONS.md from every commit on every branch, then force-pushes. Run from the repo root in Git Bash:
#   bash scripts/purge-decision-log.sh
# The working copy of DECISIONS.md is left untouched (it is untracked and ignored).
set -euo pipefail
cp DECISIONS.md /tmp/DECISIONS.md.bak 2>/dev/null || true
git filter-branch -f --index-filter 'git rm --cached --ignore-unmatch DECISIONS.md' -- --all
rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now --quiet
echo "commits still touching DECISIONS.md: $(git log --all --oneline -- DECISIONS.md | wc -l)"
git push --force --all
[ -f DECISIONS.md ] || cp /tmp/DECISIONS.md.bak DECISIONS.md 2>/dev/null || true
echo "done"
