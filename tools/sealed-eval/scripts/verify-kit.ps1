$ErrorActionPreference = "Stop"
node harness/cli.mjs verify-kit
node --test harness/tests/*.test.mjs
