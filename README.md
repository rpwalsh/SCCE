# SCCE — Self-Contained Cognitive Engine

**GO WEIGHTLESS.**

Sovereign intelligence on ordinary hardware.

SCCE is a self-contained cognitive engine that ingests evidence, builds durable knowledge, reasons, plans, acts, and learns — without a foundation-model runtime.

No language model anywhere -- evidence, proof, planning and wording are graph-native and corpus-learned (the only declared model is an optional CLIP visual embedder, off by default; see `models.declared.json`). No vector-database RAG loop. No GPU cluster. No cloud dependency at inference.

![SCCE knowledge graph explorer showing ingested evidence and reasoning traces](docs/screenshots/dashboard.jpg)

SCCE compiles evidence, language, reasoning, and learned skills into sparse, inspectable cognitive structures. At runtime, it activates only the structures relevant to the task.

**CPU-native · Local · Persistent**

**Implemented · Benchmarked · Operational**

**Evaluate it**: [QUICKSTART.md](QUICKSTART.md) — build, train a small corpus, and talk to it locally in ~10 minutes.
**License it**: [COMMERCIAL.md](COMMERCIAL.md) — source is inspection-only; commercial and evaluation licenses available.

SCCE is an implemented cognitive runtime, not a proposal, model wrapper, or retrieval layer. This repository contains its evidence-preserving ingestion, persistent cognitive graph, reasoning, planning, learned language, durable memory, application surfaces, and sealed evaluation harness.

## Current verified status

Measured against this repository's own gates, on a live PostgreSQL-backed
runtime with a real ingested Wikipedia corpus (2026-09-05):

- **No model anywhere.** There is no language model in the runtime: no
  local model server, no remote API, no constrained decoder. Wording comes
  from learned constructions and language memory over the admitted corpus.
  `tools/no-hidden-model-check.mjs` fails the build on any model endpoint
  or generation call. Only a declared CLIP visual embedder remains, off by
  default.
- **Sealed 168-question head-to-head**: SCCE 168/168 exact answers versus
  158/168 for the independent BM25 reference on identical evidence
  (three consecutive sealed runs on 2026-09-04, `out-full-39` to
  `out-full-41`; each answer an exact substring of a `sha256`-verified
  source document, recorded with document id and character offsets).
  The question set is generated mechanically from the sealed corpus (160
  cloze + 8 abstention probes) so the generator encodes no question
  grammar.
- **Sealed-evaluation network defect — disclosed and fixed.** Every
  system manifest declares `"networkPolicy": "disabled"`, but until
  2026-08-18 the harness never enforced it; two abstention probes were
  answered with live web results. Enforcement now lives in the
  evaluation adapter, which disables every connector before constructing
  the runtime. Every number above was produced under the fix.
- **Test suite**: unit tests run per package (`pnpm test:unit`), including
  live-database tests against a real PostgreSQL instance when
  `SCCE_TEST_DATABASE_URL` is set; the counts printed by that run are the
  authoritative ones.
- **Real-use trial**: a private repository (50 files) ingested cold
  answered questions from its own documents with evidence-bound citations
  ("What license does X use?" -> the license file).
- **Learning with consent**: when a question has no evidence the turn asks
  before searching; fetched material is quarantined with a preview and
  becomes evidence only after confirmation.
- **Ingest throughput** (2026-09-05): a shard flush that used to stall for
  hours (a quadratic medoid search in role induction, and graph-surface
  alignment over every lattice unit against every shard target) now
  completes in minutes; page ingest compute halved. The construction gate
  (independent held-out promotion) runs live and reports per hypothesis
  why it does or does not promote.
- **What is not yet claimed**: learned reversible constructions have not
  been promoted from the Wikipedia corpus, because the declared relation
  channels available today (article links and section headings) yield
  page-specific hyperedges that no independent source can corroborate;
  a prose relation channel is the next item. Single-operator rehearsal
  scope throughout; the independent public-review protocol in
  [`docs/PUBLIC_REVIEW_CONTRACT.md`](docs/PUBLIC_REVIEW_CONTRACT.md) has
  not been executed.

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
  pnpm scce learn pending | confirm <id> | reject <id> | curriculum | pursue <planId>
  pnpm scce code --path=<workspace-file> [--attempts=3] <request>
  pnpm scce settings show | get <key> | set <key> <value> | edit
  pnpm scce model list | download <org/name> | remove <org/name>
  pnpm scce inspect last
  pnpm scce inspect brain
```

### Learning with consent

SCCE never searches the web on its own. When a question has no evidence,
the turn asks first: the workbench and VS Code chat show an offer to
search and learn, `scce turn` asks at the prompt, and a pending
`network.search` approval appears in the session. Material fetched after
consent is not knowledge yet: it is held in quarantine with a preview,
and only becomes evidence when you confirm it is true (Learning panel,
chat buttons, or `scce learn confirm <id>`). The learning loop's own
proposals ("wants to learn: …") take the same path through
`scce learn curriculum` and `scce learn pursue`.

### No model lane

SCCE contains no language model: no local model server, no remote API,
no constrained decoder. Wording comes from the mouth's learned
constructions and language memory over the admitted corpus, and
`scce code` applies only code actions the TypeScript compiler itself
owns, rolled back unless they typecheck. `tools/no-hidden-model-check.mjs`
fails the build on any model endpoint or generation call.

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

Configure the database. Credentials belong in `scce.config.local.json`, an
untracked overlay merged over `scce.config.json`, so nothing machine-specific
reaches the repository:

```json
{ "database": { "url": "postgresql://<user>:<password>@<host>:<port>/<database>" } }
```

```powershell
pnpm scce db migrate
pnpm scce db verify
```

`SCCE_DATABASE_URL` still overrides the file when one is set.

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
- [`docs/README.md`](docs/README.md) — complete documentation index
- [`SECURITY.md`](SECURITY.md) — security posture and vulnerability reporting

## License

SCCE is source-available for inspection under a proprietary license. It is not open source, and no license to use, copy, or redistribute the software is granted except as stated in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

**Own the runtime. Keep the learning.**

SCCE — the weightless cognitive engine.
