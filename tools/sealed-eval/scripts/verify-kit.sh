#!/usr/bin/env bash
set -euo pipefail
node harness/cli.mjs verify-kit
node --test harness/tests/*.test.mjs
