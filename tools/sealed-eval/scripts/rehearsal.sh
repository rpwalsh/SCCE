#!/usr/bin/env bash
set -euo pipefail
echo "This rehearsal uses synthetic fixtures only and is local verification, not an independent result."
node harness/cli.mjs verify-kit
node --test harness/tests/*.test.mjs
