# SCCE — Self-Contained Cognitive Engine

**GO WEIGHTLESS.**

Sovereign intelligence on ordinary hardware.

SCCE ingests evidence, builds durable knowledge, reasons, plans, acts, and learns — without a foundation-model runtime.

No language model anywhere. Evidence, proof, planning and wording are graph-native and corpus-learned. No vector-database RAG loop. No GPU cluster. No cloud dependency at inference. The only declared model is an optional CLIP visual embedder, off by default (`models.declared.json`).

![SCCE knowledge graph explorer showing ingested evidence and reasoning traces](docs/screenshots/dashboard.jpg)

SCCE compiles evidence, language, reasoning, and learned skills into sparse, inspectable cognitive structures. At runtime it activates only the structures relevant to the task.

**CPU-native · Local · Persistent**

**Implemented · Benchmarked · Operational**

**Evaluate it**: [QUICKSTART.md](QUICKSTART.md) — build, train a small corpus, and talk to it locally in ~10 minutes.
**License it**: [COMMERCIAL.md](COMMERCIAL.md) — source is inspection-only; commercial and evaluation licenses available.

This repository contains the running system: evidence-preserving ingestion, a persistent cognitive graph, reasoning, planning, learned language, durable memory, three application surfaces, and a sealed evaluation harness anyone can re-run.

## Why this exists

Closed-weight AI rents intelligence from someone else's data center. Open-weight AI lets you host the weights, but still needs billions of parameters, accelerator infrastructure, and repeated dense inference.

SCCE removes foundation-model weights from the runtime architecture entirely.

| Dense AI | SCCE |
|---|---|
| Intelligence encoded in opaque model weights | Intelligence compiled into inspectable graph structures |
| Dense model evaluated repeatedly | Bounded, task-local activation |
| Knowledge blended into parameters | Evidence retains identity, time, and provenance |
| Context disappears between sessions | Knowledge, skills, and outcomes persist |
| Accelerator-centered inference | CPU-native execution |
| Provider or model controls the intelligence | The operator owns the runtime and its memory |

The commercial consequence: no inference bill that scales with usage, no vendor who can change the model underneath you, no data leaving the operator's machine, and an answer whose support you can point at.

## Verified status

Measured against this repository's own gates, on a live PostgreSQL-backed runtime with a real ingested Wikipedia corpus.

### No model in the runtime

There is no language model: no local model server, no remote API, no constrained decoder. Wording comes from learned constructions and language memory over the admitted corpus. `tools/no-hidden-model-check.mjs` fails the build on any model endpoint or generation call. This is enforced by the build, not asserted by documentation.

### Sealed 168-question head-to-head

SCCE answers **161 of 168** against **158 of 168** for an independent BM25 reference on identical evidence, reproducing exactly across two back-to-back standalone runs (2026-09-06, revision `663afa2`, `out-full-46` and `out-full-47`) and matching the full condition of the same day's ablation sweep.

Every answer is an exact substring of a `sha256`-verified source document, recorded with document id and character offsets. The question set is generated mechanically from the sealed corpus (160 cloze + 8 abstention probes), so the generator encodes no question grammar.

**The entire margin is refusal discipline, and on recall the baseline is ahead.** On the 160 answerable questions BM25 scores 158 and SCCE scores 153. All of SCCE's margin, and more, comes from the eight abstention probes: SCCE declines all eight questions the corpus cannot answer; the BM25 reference answers all eight and is wrong all eight times.

That is the property the system is built for — a system that fabricates when the evidence is absent cannot be used for regulated review, engineering evidence, or contract analysis — and it is measured under seal rather than argued. It is not a recall win, and this document does not present it as one.

**Recall is down five questions from the 2026-09-05 figure** (166/168, cloze tied at 158) and the cause is not yet established. The leading candidate is the graph-projection backfill run on 2026-09-05, which took the live graph from roughly 1.4M to 1.68M nodes and changes the anchor slice every question retrieves through; a code regression in the same window is not excluded. The five questions are identified by id in the run records. The earlier number is not quoted as current.

The protocol is in [`tools/sealed-eval/README_FIRST.md`](tools/sealed-eval/README_FIRST.md); the harness, question generator, and gates are in the repository and re-runnable.

### Component ablation

The same set run with one component disabled at a time is reported in [`docs/ABLATION.md`](docs/ABLATION.md), regenerated from the run's own records by `tools/ablation-delta.mjs` — the document's findings are computed from the table, not written by hand.

A cloze set over a fixed corpus is an instrument for retrieval and refusal. It does not exercise contradiction with competing provenance, temporal comparison, multi-hop composition, or learning that changes later answers, and it therefore cannot separate the components that do that work. The twenty behaviours in [`docs/ACCEPTANCE_SUITE.md`](docs/ACCEPTANCE_SUITE.md) are the instrument that can, with current coverage recorded per behaviour.

### Runtime scale

The live brain holds 22,259 sources across 23,512 versions, 64,223 evidence spans of which 56,712 are promoted, 1,679,845 graph nodes and 3,927,131 graph edges — on ordinary developer hardware, served through 80 HTTP routes.

### Implementation completeness

`pnpm reachability` walks the real entry points — server routes and startup, CLI, production turn runtime, kernel, adapters, VS Code, workbench, and the forked worker processes — and writes [`docs/RUNTIME_REACHABILITY.json`](docs/RUNTIME_REACHABILITY.json).

It counts 1,670 exports: 1,178 reached from a real entry point, 461 module-internal helpers, and 31 unreached. Of the unreached, 17 are implemented, tested capabilities not yet called from a runtime path; 13 of those carry a written engineering reason, and **none has no caller anywhere**. The figure is tracked as it falls: 183 at the start of this pass, 67 a day ago, 17 today. The tool matches names as words rather than through the type system, so the unreached figure is a lower bound.

### Live release gate

`pnpm release:gate` runs seven prompts against the running server and checks each answer structurally — evidence
binding, mouth realization, semantic-answer shape, single source version, novel-unit counts, repeated-trigram ratio,
wiki debris, and a hard 10-second turn deadline. Six of the seven pass. The seventh, a false-premise question, answers
from its article's external-links block instead of refuting the premise with a dated counterexample; it is a known
open defect, reproducible with one command.

The turn deadline is enforced at stage boundaries: a stage that overruns its budget yields to a bounded alternative
and the turn completes degraded rather than running past the contract.

### Test and trial evidence

- **Test suite**: 2,228 tests across 352 files pass (`pnpm test:unit`, 11 skipped — live-database tests that require `SCCE_TEST_DATABASE_URL`); 1,704 of them cover the kernel.
- **Real-use trial**: a private repository of 50 files, ingested cold, answered questions from its own documents with evidence-bound citations.
- **Learning with consent**: when a question has no evidence the turn asks before searching; fetched material is quarantined with a preview and becomes evidence only after the owner confirms it.
- **Ingest throughput**: a shard flush completes in minutes. Role induction uses a bounded medoid search; graph-surface alignment is bounded per lattice unit rather than compared against every shard target.

### Scope

Two boundaries are stated rather than implied. Learned reversible constructions have not yet been promoted from the Wikipedia corpus: the relation channels available there (article links and section headings) yield page-specific hyperedges that no independent source corroborates, and a prose relation channel is the next item. The independent public-review protocol in [`docs/PUBLIC_REVIEW_CONTRACT.md`](docs/PUBLIC_REVIEW_CONTRACT.md) is specified and has not yet been executed by a third party.

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

When the available evidence cannot support an answer, SCCE qualifies the result, requests more information, or declines — the behaviour the sealed benchmark measures at 8/8.

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

A browser workbench over the local HTTP API, a VS Code extension, and a CLI — plus `scce-dev-mcp` for repository and trace inspection by development tooling.

None contains separate intelligence. Each is a client of the same local cognitive engine and the same PostgreSQL-backed state, so an answer obtained in one surface is reproducible in the others.

Everything below is captured from the real runtime answering against its live brain.

### 1. Browser workbench (HTTP API)

- [30-second demo video](docs/media/scce-demo-30s.mp4) — source-cited answers with the live evidence trace expanded (recorded in real time, played back at 6.4×).
- ![Workbench chat with source-cited answers](docs/screenshots/workbench-chat.png)
- ![Evidence trace details expanded on an answer](docs/screenshots/workbench-evidence-details.png)

A real turn against the live brain — request, and the answer verbatim including its citation:

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

The same turn returns the full proof object — obligations, evidence bindings, contradiction and uncertainty mass — which is what the evidence panel in the screenshots renders.

### 2. VS Code extension

A chat sidebar and an activity timeline, talking to the same local engine over loopback only.

![VS Code extension: SCCE chat sidebar beside workspace code](docs/screenshots/vscode.png)

Contributed commands (`packages/vscode/package.json`):

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

Coding requests return an unauthorized, unexecuted plan; nothing is written to the workspace until a reviewed patch transaction is explicitly applied.

### 3. Command line

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
  pnpm scce eval gate <objective.jsonl>
  pnpm scce hydrate inspect <path>
  pnpm scce inspect last
  pnpm scce inspect brain
```

### Learning with consent

SCCE never searches the web on its own. When a question has no evidence, the turn asks first: the workbench and VS Code chat show an offer to search and learn, `scce turn` asks at the prompt, and a pending `network.search` approval appears in the session.

Material fetched after consent is not knowledge yet: it is held in quarantine with a preview, and becomes evidence only when the owner confirms it (Learning panel, chat buttons, or `scce learn confirm <id>`). The learning loop's own proposals take the same path through `scce learn curriculum` and `scce learn pursue`.

Everything the system records about its owner is inspectable at `GET /api/learning/about-me` and individually withdrawable at `POST /api/learning/forget` — real deletion, not a superseding tombstone.

### No model lane

`scce code` applies only code actions the TypeScript compiler itself owns, rolled back unless they typecheck. Selected actions are re-materialized from exact base bytes and bounded text spans rather than trusting the compiler's output bytes, and the resulting repair lineage is independently verifiable.

## Run SCCE

Requirements: Node.js 24.18+ (24.x), pnpm 10, and PostgreSQL.

```powershell
pnpm install
pnpm validate
```

Credentials belong in `scce.config.local.json`, an untracked overlay merged over `scce.config.json`, so nothing machine-specific reaches the repository:

```json
{ "database": { "url": "postgresql://<user>:<password>@<host>:<port>/<database>" } }
```

```powershell
pnpm scce db migrate
pnpm scce db verify
pnpm server
```

`SCCE_DATABASE_URL` overrides the file when set. Full setup, configuration, rehearsal commands, and VS Code packaging are documented in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

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
- [`docs/ACCEPTANCE_SUITE.md`](docs/ACCEPTANCE_SUITE.md) — twenty behaviours the architecture must demonstrate, with current coverage
- [`docs/ABLATION.md`](docs/ABLATION.md) — what each component is worth, measured by disabling it
- [`docs/PUBLIC_REVIEW_CONTRACT.md`](docs/PUBLIC_REVIEW_CONTRACT.md) — evidence required before a reproducible public-review claim
- [`docs/SBOM.md`](docs/SBOM.md) — third-party components, versions, and licenses (`pnpm sbom`)
- [`docs/README.md`](docs/README.md) — complete documentation index
- [`SECURITY.md`](SECURITY.md) — security posture and vulnerability reporting

Detailed method specifications — alignment, transport, segmentation, induction, and the mathematical appendix — are proprietary and are not published in this repository. They are available to licensees and to evaluators under a signed agreement; see [COMMERCIAL.md](COMMERCIAL.md).

## License

SCCE is source-available for inspection under a proprietary license. It is not open source, and no license to use, copy, or redistribute the software is granted except as stated in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

SCCE's own code being proprietary is not the same as the delivered system containing no open source: it has eight direct third-party runtime dependencies, all under permissive licenses, with one vendored archive recorded by checksum. [`docs/SBOM.md`](docs/SBOM.md) lists every one.

---

**Own the runtime. Keep the learning.**

SCCE — the weightless cognitive engine.
