# Operations

Mechanics that have already cost tokens to rediscover. Read this before running anything.

## CLI
- The config flag is **space-separated**: `--config scce.kowiki.config.json`. The `--config=x` form exists in
  source but not in the built `dist`, and fails with "unknown flag".
- `scce ingest <path>` is the WORKSPACE/code path. It reports 0 files for a folder of prose.
  For text documents use `node --max-old-space-size=7168 tools/train-gutenberg.mjs --root=<dir> --files=<n>`.
- `scce ingest wiki` needs a dump at the config's `corpora.wikipedia.dumpPath`.
- `scce language identities --rebuild` re-derives language identities. Identity discovery is otherwise a one-shot:
  documents ingested after the last rebuild carry NO identity.

## Credentials
Tracked configs carry `postgresql://localhost:5432/scce` with no password, deliberately. The real URL is in the
untracked `scce.config.local.json`. Supply it without printing it:

```sh
export SCCE_DATABASE_URL="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("scce.config.local.json","utf8")).database.url)')"
```

Some auxiliary configs are stale and fail validation with "security.informationAccess is required". Copy the whole
`security` block from `scce.config.json`. Its `localMasterKey` is an empty string; there is no secret in it.

## Builds
`pnpm -r build`, or per package. Adapters and server compile against the kernel's EMITTED types, so build
`@scce/kernel` before typechecking either. A fresh worktree has no `node_modules`; run `pnpm install` there.

## Background work
Use the harness's own background flag. A `nohup ... &` inside a tool call does NOT survive the shell: a 60-item
comparison run died silently after 10 items that way.

## Windows and shell
- Heredocs and `node -e` EAT BACKSLASHES. A regex written that way arrives mangled (`\p{L}` becomes `p{L}`).
  Use the Edit tool, or build the escape with `String.fromCharCode(92)`, then read the line back and verify.
- Files are CRLF. Write patch scripts that detect the EOL rather than assuming `\n`.
- `Math.max(...values)` overflows the stack on a large array. Loop instead.

## Corpus facts
~80,900 spans: 21,676 Wikipedia sources, 1,424 TypeScript files, 15 novels ingested whole. A Gutenberg book's
first spans are ALL front matter, so sample across `char_start` rather than taking the first N.
`source_title` and `source_name` are generated columns; `source_name` is a bag of title plus derived terms, so
match identity against `source_title`.
