# SCCE — Self-Contained Cognitive Engine

**GO WEIGHTLESS.**

Sovereign intelligence on ordinary hardware.

SCCE is a self-contained cognitive engine that ingests evidence, builds durable knowledge, reasons, plans, acts, and learns — without a foundation-model runtime.

No LLM inference. No vector-database RAG loop. No GPU cluster. No cloud dependency.

![SCCE knowledge graph explorer showing ingested evidence and reasoning traces](docs/screenshots/dashboard.jpg)

SCCE compiles evidence, language, reasoning, and learned skills into sparse, inspectable cognitive structures. At runtime, it activates only the structures relevant to the task.

**CPU-native · Local · Persistent**

**Implemented · Benchmarked · Operational**

SCCE is an implemented cognitive runtime, not a proposal, model wrapper, or retrieval layer. This repository contains its evidence-preserving ingestion, persistent cognitive graph, reasoning, planning, learned language, durable memory, application surfaces, and sealed evaluation harness.

## Current verified status

Measured against this repository's own gates, on a live PostgreSQL-backed
runtime with a real ingested Wikipedia corpus (2026-08-18):

- **Test suite**: 1,640 kernel tests (237 files) and 80 server tests (18
  files) passing, including live-database tests run against a real
  PostgreSQL instance. 315 test files across all packages.
- **Sealed-evaluation network defect — disclosed, fixed, and it
  invalidates earlier sealed claims.** Every system manifest declares
  `"networkPolicy": "disabled"`, but that field appeared only in schemas
  and templates: the harness never enforced it, and the evaluation
  adapter passed the ambient config — whose web connector is enabled —
  straight through. A run on 2026-08-18 answered two abstention probes
  ("What is the boiling point of tungsten?", "Who won the 1998 FIFA
  World Cup?"), both absent from the sealed corpus by construction, with
  live DuckDuckGo results. Enforcement now lives in the adapter, which
  disables every configured connector before constructing the runtime.
  **Sealed results published before this fix, including the previously
  claimed 6/6 rehearsal, should be treated as provisional until re-run
  under the fix.**
- **Benchmark scale**: the harness's hand-written question set (6
  questions) was too small to support a comparative claim or to fit the
  surface-energy coefficients. It is now generated mechanically from the
  sealed corpus — 168 questions (160 cloze + 8 abstention probes), each
  answer an exact substring of a `sha256`-verified source document,
  recorded with document id and character offsets. Cloze elision is used
  rather than question templates so the generator encodes no English
  question grammar and produces a benchmark in whatever language the
  corpus is in.
- **Sealed head-to-head (6-question diagnostic, post-fix)**: SCCE 4/6
  versus 3/6 for the independent BM25 reference — winning direct QA 2/2
  and abstention 2/2, losing cloze 0/2. N=6 is far below what this
  repository's own cluster-bootstrap gate will certify, so this is a
  diagnostic signal, not a result. A full 168-question run is the
  measurement that counts.
- **Known open defect**: SCCE returns empty on cloze-shaped prompts whose
  answers are verbatim in its own sealed corpus, where BM25 scores 94%.
  Retrieval and direct QA are unaffected and correct; this is a
  task-shape gap in realization, and it is unfixed.
- Single-operator rehearsal scope throughout. The independent
  public-review protocol in
  [`docs/PUBLIC_REVIEW_CONTRACT.md`](docs/PUBLIC_REVIEW_CONTRACT.md) has
  not been executed.
- **Live rehearsals**: the PostgreSQL schema/activation rehearsal and the
  end-to-end adapter rehearsal (ingest → promote → live turn → exact
  byte-verified citation) both pass against a real database.
- **Enumeration-shaped questions**: "list the main characters of X"-style
  requests return a contiguous, byte-verifiable multi-sentence excerpt
  (learned response-form budget; no keyword lists), verified live against
  the hydrated Wikipedia brain — the answer window is constructed in the
  same normalization space the source-excerpt verifier compares in, so
  verification holds by construction.
- **Post-training query latency**: whole-novel corpus training exposed a
  planner pathology (correlated `EXISTS` over a multi-GB observations
  table seq-scanned once per candidate profile); replaced with a
  recursive index skip scan — measured live at 53ms versus 3.5 minutes
  for the same result, turn-path profile query from stuck (25+ minutes)
  to ~1s cold.

## A third architecture for AI

Closed-weight AI rents intelligence from somebody else's data center.

Open-weight AI lets you host the weights yourself — but still requires billions of parameters, accelerator infrastructure, and repeated dense inference.

SCCE removes foundation-model weights from the runtime architecture entirely.

| Dense AI | SCCE |
|---|---|
| Intelligence encoded in opaque model weights | Intelligence compiled into inspectable graph structures |
| Dense model evaluated repeatedly | Bounded, task-local activation |
| Knowledge blended into parameters | Evidence retains identity, time, and provenance |
| Context disappears between sessions | Knowledge, skills, and outcomes persist |
| Accelerator-centered inference | CPU-native execution |
| Provider or model controls the intelligence | The operator owns the runtime and its memory |

## What SCCE does

**INGEST → STRUCTURE → ACTIVATE → REASON → PLAN → ACT → LEARN**

- Ingests documents, source code, and spreadsheets while preserving exact source identity, coordinates, and timestamps.
- Compiles observations into a directed cognitive graph instead of embedding text into a retrieval index.
- Activates a bounded, task-relevant graph field instead of evaluating a dense model for every generated token.
- Constructs answers with explicit evidence, contradiction, and confidence traces.
- Separates what may be claimed from how it is expressed.
- Applies reviewed code patches through a loopback-only VS Code integration backed by exact-byte workspace snapshots.
- Preserves learned knowledge and outcomes in operator-controlled storage.

## Evidence is part of the answer

SCCE does not treat provenance as a citation added after generation.

Every admitted observation retains:

- where it came from;
- when it was observed;
- the exact source span that supports it;
- how it entered the graph;
- which reasoning path activated it;
- what contradictions or uncertainty remain.

When the available evidence cannot support an answer, SCCE can qualify the result, request more information, or decline to invent one.

## The cognitive pipeline

```text
Source material
      |
Evidence-preserving ingestion
      |
Entities, relations, events, and constructions
      |
Persistent cognitive graph
      |
Task-conditioned local activation
      |
Reasoning, planning, and capability selection
      |
Evidence-bound answer or proposed action
      |
Outcome recording and continued learning
```

The reasoning layer determines what the evidence licenses SCCE to say or do. A separate realization layer determines how to express it. Surface fluency cannot authorize unsupported facts.

For the complete technical design, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Three interfaces, one engine

SCCE has three user-facing surfaces — a browser workbench over the local
HTTP API, a VS Code extension, and a CLI — plus `scce-dev-mcp` for
repository and trace inspection by development tooling.

None of them contain separate intelligence. Each is a client of the same
local cognitive engine and the same PostgreSQL-backed state, so an answer
obtained in one surface is reproducible in the others.

Everything shown below is real: existing screenshots, a recorded video,
and command output pasted verbatim. Where a capture does not exist, that
is stated rather than illustrated.

### 1. Browser workbench (HTTP API)

The server exposes 62 routes and serves a chat-first workbench. Captures
are of the real runtime answering against its live PostgreSQL brain.

- [30-second demo video](docs/media/scce-demo-30s.mp4) — source-cited
  answers with the live evidence trace expanded (recorded in real time,
  played back at 6.4×).
- ![Workbench chat with source-cited answers](docs/screenshots/workbench-chat.png)
- ![Evidence trace details expanded on an answer](docs/screenshots/workbench-evidence-details.png)

A real turn against the live brain, captured 2026-08-18 — request, and
the answer verbatim including its citation:

```console
$ curl -s -X POST http://127.0.0.1:3873/api/turn \
    -H 'content-type: application/json' \
    -d '{"text":"who is ada lovelace?"}'
```

> 'Augusta Ada King, Countess of Lovelace' (; 10 December 1815 –
> 27 November 1852), also known as 'Ada Lovelace', was an English
> mathematician and writer chiefly known for work on Charles Babbage's
> proposed mechanical general-purpose computer, the analytical engine.
> She was the first to recognise the machine had applications beyond
> pure calculation.
>
> Source: Ada Lovelace (https://en.wikipedia.org/wiki/Ada_Lovelace)

Returned in 11.0s with one evidence span attached. The same turn also
returns the full proof object — obligations, evidence bindings,
contradiction and uncertainty mass — which is what the evidence panel in
the screenshots above is rendering.

### 2. VS Code extension

A chat sidebar and an activity timeline, talking to the same local
engine over loopback only.

![VS Code extension: SCCE chat sidebar beside workspace code](docs/screenshots/vscode.png)

Commands it actually contributes (`packages/vscode/package.json`):

```text
scce.checkReadiness            SCCE: Check Readiness
scce.setServerToken            SCCE: Set Local Server Token
scce.workspace.initialize      SCCE: Initialize Workspace
scce.workspace.ingest          SCCE: Ingest Workspace
scce.project.summary           SCCE: Show Project Summary
scce.workspace.ask             SCCE: Ask About Workspace
scce.workspace.status          SCCE: Show Read-Only Workspace Status
scce.workspace.codingRequest   SCCE: Plan and Apply Coding Request
scce.workspace.applyPatchPlan  SCCE: Apply Reviewed Patch Transaction
scce.tasks.clear               SCCE: Clear Task Timeline
```

Views: `scce.chat` (webview) and `scce.taskTimeline`. Coding requests
return an unauthorized, unexecuted plan; nothing is written to the
workspace until a reviewed patch transaction is explicitly applied.

### 3. Command line

Real output of `pnpm scce` with no arguments, captured 2026-08-18
(abridged — the full listing continues past `inspect brain`):

```console
$ pnpm scce
SCCE v3 CLI

Commands:
  pnpm scce db status
  pnpm scce db migrate
  pnpm scce db verify
  pnpm scce ingest <path-or-uri>
  pnpm scce workspace init <path>
  pnpm scce workspace ask <question>
  pnpm scce workspace plan-code --path=<workspace-file> [options] <request>
    Alias: workspace code. Returns an unauthorized, unexecuted plan; it
    does not edit files or run checks.
  pnpm scce project summary [path]
  pnpm scce ingest wiki <dump-path> --index=<index-path>
  pnpm scce corpus train gutenberg <path>
  pnpm scce turn <prompt> [--detail=brief|normal|detailed|stepwise]
  pnpm scce inspect last
  pnpm scce inspect brain
```

There is no CLI screenshot. A previous one was removed on 2026-08-17
because the image was an HTML re-rendering styled to look like a
terminal — the text was genuine command output, but presenting it as a
screenshot failed this section's own bar. The block above is the command
output itself rather than a picture of it.

## Run SCCE

Requirements: Node.js 24.18+ (24.x), pnpm 10, and PostgreSQL.

Install and validate:

```powershell
pnpm install
pnpm validate
```

Configure the database:

```powershell
$env:SCCE_DATABASE_URL="postgresql://<user>:<password>@<host>:<port>/<database>"
pnpm scce db migrate
pnpm scce db verify
```

Start the server or CLI:

```powershell
pnpm server
pnpm scce
```

Full setup, configuration, rehearsal commands, and VS Code packaging are documented in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Repository map

```text
packages/kernel         cognition, graph, evidence, planning, and language
packages/adapters-node  PostgreSQL, files, documents, and spreadsheet ingestion
packages/server         HTTP API and workbench server
packages/cli            command-line interface
packages/ui             workbench-facing models and surfaces
packages/vscode         loopback-only VS Code integration
tools/scce-dev-mcp      repository and trace inspection
tools/sealed-eval       sealed evaluation harness, question generator, gates
docs                    architecture, guides, and normative contracts
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — cognitive architecture and runtime pipeline
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — installation and operation
- [`docs/API_SURFACE.md`](docs/API_SURFACE.md) — HTTP API
- [`docs/EVALUATION_PROTOCOL.md`](docs/EVALUATION_PROTOCOL.md) — evaluation results, defect disclosures, and their scope limits
- [`docs/README.md`](docs/README.md) — complete documentation index
- [`SECURITY.md`](SECURITY.md) — security posture and vulnerability reporting

## License

SCCE is source-available for inspection under a proprietary license. It is not open source, and no license to use, copy, or redistribute the software is granted except as stated in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

**Own the runtime. Keep the learning.**

SCCE — the weightless cognitive engine.
