# SCCE — Self-Contained Cognitive Engine

**A local-first reasoning engine that answers from evidence, not from vibes.**

Most AI systems generate the most statistically plausible next words. SCCE is built around a different idea: ingest real source material, track exactly where every fact came from, reason over that material as a graph, and only answer what the evidence actually supports — with an inspectable trail behind every response.

It runs on your own machine against your own PostgreSQL database. Nothing about what it knows lives in a black box.

## Why SCCE

- **Every answer is traceable.** SCCE doesn't just produce a response — it produces a trace of the evidence, the reasoning steps, and the confidence behind it. You can inspect exactly why it said what it said.
- **It says "I don't know" instead of making things up.** When the evidence doesn't support a confident answer, SCCE says so, offers a qualified answer, or goes and looks for more support — it doesn't fabricate facts to sound helpful.
- **It learns your language, not just your facts.** SCCE builds its own language model from what it reads, rather than leaning on a fixed pretrained voice — so its writing style is grounded in what it's actually been shown.
- **It reasons over a real knowledge graph.** Ingested material becomes structured, queryable graph state — not just embeddings in a vector store.
- **It's yours.** Local runtime, your database, your data. No API keys sent to a third party, no telemetry by default.

## What it does

- Ingest documents, code, and spreadsheets (including `.xlsx` / `.xlsm` / `.xls`) with full source identity, byte-level provenance, and timestamps.
- Build and reason over a directed knowledge graph, with learned activation instead of keyword search.
- Construct answers through a pipeline that tracks proof and contradiction at every step, and never lets an answer outrun its evidence.
- Recognize when it's under-supported and recover: look for more evidence, or clearly label a lower-confidence attempt as such — never silently overreach.
- Apply reviewed code patches through a loopback-only VS Code integration, with exact-byte workspace snapshots so nothing is touched without an explicit, auditable diff.

## Under the hood, briefly

```text
source material
  -> tracked evidence (who said it, when, exactly which bytes)
  -> knowledge graph (entities, relations, structure)
  -> reasoning over that graph
  -> a proposed answer, checked against the evidence that supports it
  -> natural-language realization, grounded in learned language patterns
  -> an answer, plus the full trace behind it
```

The reasoning layer decides *what* can be said; a separate realization layer decides *how* to phrase it — it never gets to invent facts of its own. If you want the deep technical version of this pipeline, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project layout

```text
packages/kernel         core reasoning runtime: graph, evidence, planning, language
packages/adapters-node  PostgreSQL, file, document, and spreadsheet ingestion
packages/server         HTTP API and workbench server
packages/cli            command-line interface
packages/ui             workbench-facing UI models and surfaces
packages/vscode         loopback-only VS Code integration
tools/scce-dev-mcp      repository and trace inspection tooling
docs                    architecture, guides, and status records
```

## Getting started

Requirements: Node.js 20+, pnpm 10, and a PostgreSQL database.

```powershell
pnpm install
pnpm validate
```

Point SCCE at your database and set it up:

```powershell
$env:SCCE_DATABASE_URL="postgresql://<user>:<password>@<host>:<port>/<database>"
pnpm scce db migrate
pnpm scce db verify
```

Then run it:

```powershell
pnpm server   # HTTP API + workbench
pnpm scce     # command-line interface
```

Full setup detail (rehearsal commands, configuration options, VS Code packaging, startup behavior) lives in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) and [`docs/README.md`](docs/README.md).

## Learn more

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the reasoning pipeline actually works
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — setup, configuration, and day-to-day usage
- [`docs/API_SURFACE.md`](docs/API_SURFACE.md) — the HTTP API
- [`docs/README.md`](docs/README.md) — full documentation index
- [`SECURITY.md`](SECURITY.md) — security posture and reporting

Contributing an AI coding agent to this repo? Read [`AGENTS.md`](AGENTS.md) first.

## License

The source is available here for inspection under a proprietary license — that means you can read it, but this is **not** an open-source project, and no license to use, copy, or redistribute it is granted. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for the exact terms.
