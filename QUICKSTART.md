# SCCE Quickstart — evaluate it on your own machine

Everything below runs locally. No cloud services, no model downloads, no GPU.

## Prerequisites

- Node.js 24.x (`>=24.18.0 <25`) and pnpm
- PostgreSQL 14+ running locally
- ~10 minutes for a small training corpus

## 1. Build

```sh
pnpm install
pnpm build
```

## 2. Point SCCE at your database

Create an empty database, then set its URL in `scce.config.json`:

```json
"database": { "url": "postgresql://localhost:5432/scce", "schema": "scce3_runtime" }
```

The runtime creates and migrates its own schema on first start.

## 3. Teach it something

SCCE answers only from evidence it has ingested — a fresh brain knows
nothing and says so. Train it on a small corpus (see
[docs/CORPUS_TRAINING.md](docs/CORPUS_TRAINING.md) for the full guide):

```sh
pnpm scce --config scce.corpus-dev.config.json corpus train gutenberg corpus/gutenberg --max-files=16
```

Wikipedia ingestion from a standard multistream dump is also supported:

```sh
pnpm scce --config scce.corpus-dev.config.json ingest wiki <pages-articles-multistream.xml.bz2> --index=<index.txt.bz2>
```

## 4. Start the server

```sh
pnpm server
```

The runtime listens on `http://127.0.0.1:3873` (configurable in `scce.config.json`).

## 5. Talk to it

**VS Code extension** (chat, bounded coding requests, voice mode):

```sh
npx @vscode/vsce package --no-dependencies
```

from `packages/vscode`, then install the generated `.vsix` via VS Code's
"Install from VSIX". The SCCE chat view connects to the local server.

**CLI**: `pnpm scce` exposes the same runtime from the terminal.

## What to look for

- Every answer is evidence-bound: sources are listed with the answer, and
  the audit detail shows the proof route that produced it.
- Ask about something it was never taught — it asks whether it may search
  and learn instead of inventing an answer, and what it fetches waits for
  your confirmation before it counts as knowledge.
- Turn latency on ordinary hardware: ~2.5s median on the sealed benchmark
  corpus.

## 6. Let it learn, with your consent

Enable a web connector in `scce.config.json`, then ask about something
outside what you taught it. The answer carries an offer to search; approve
it (chat button, workbench Approvals panel, or the prompt in `pnpm scce turn`).
The fetched pages land in the Learning panel with a preview. Mark each one
true or not true; only confirmed material is promoted to evidence, and the
question is answered again from it. `pnpm scce learn curriculum` lists what
SCCE itself wants to learn next; `pnpm scce learn pursue <planId>` consents.

## 7. Coding

`pnpm scce code --path=src/file.ts "<request>"` applies a code action the
TypeScript compiler owns for that file (name the diagnostic or fix) and keeps
it only if the project still typechecks. There is no model anywhere in SCCE.

## Verification

The claims in the README are backed by this repository's own gates:
`pnpm test` runs the full suite; the sealed evaluation harness and its
protocol live in [tools/sealed-eval](tools/sealed-eval) and
[docs/EVALUATION_PROTOCOL.md](docs/EVALUATION_PROTOCOL.md).
