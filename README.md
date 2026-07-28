# SCCE

**GO WEIGHTLESS.**

Sovereign intelligence on ordinary hardware.

SCCE is a self-contained cognitive engine that ingests evidence, builds durable knowledge, reasons, plans, acts, and learns — without a foundation-model runtime.

No LLM inference. No vector-database RAG loop. No GPU cluster. No cloud dependency.

SCCE compiles evidence, language, reasoning, and learned skills into sparse, inspectable cognitive structures. At runtime, it activates only the structures relevant to the task.

**CPU-native · Local · Persistent · Evidence-bound**

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

## One engine, multiple surfaces

SCCE is exposed through:

- a local HTTP API and a chat-first workbench in the browser;
- a chat sidebar in VS Code, with reviewed code-change requests reachable from the same conversation;
- a command-line interface;
- repository and trace inspection through `scce-dev-mcp`;
- PostgreSQL-backed persistent cognitive state.

The interfaces do not contain separate intelligence. They operate against the same local cognitive engine.

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
docs                    architecture, guides, and implementation records
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — cognitive architecture and runtime pipeline
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — installation and operation
- [`docs/API_SURFACE.md`](docs/API_SURFACE.md) — HTTP API
- [`docs/README.md`](docs/README.md) — complete documentation index
- [`SECURITY.md`](SECURITY.md) — security posture and vulnerability reporting
- [`AGENTS.md`](AGENTS.md) — instructions for coding agents working in this repository

## License

SCCE is source-available for inspection under a proprietary license. It is not open source, and no license to use, copy, or redistribute the software is granted except as stated in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

**Own the runtime. Keep the learning.**

SCCE — the weightless cognitive engine.
