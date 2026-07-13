# SCCE Agent Guide

This repository is a TypeScript/Node implementation of SCCE: a Self Contained Cognitive Engine with a graph-native kernel, Postgres-backed durable storage, local runtime surfaces, and developer tooling for low-token debugging.

This file is for coding agents. Follow the repository, not prior chat context. When repository code disagrees with this guide, stop and report the conflict instead of guessing.

## First Principles

SCCE is a self-contained graph-native runtime. The hot path is source ingestion, evidence, graph/frontier activation, admissible candidate selection, proof handling, and mouth/surface realization.

Postgres is the canonical durable store. It is not the whole cognition layer and should not be used as a broad text-search substitute for runtime reasoning.

The architecture should stay one-lane and inspectable: one kernel/runtime path, one trainer/import path, one mouth/output path, and one durable store contract.

## Walsh Math: Minimal Engineering Contract

Walsh Math is the routing discipline for SCCE. It is not decorative terminology. It defines how source evidence becomes admissible answer motion through the graph.

The runtime should preserve this path:

```text
source evidence
→ typed observation
→ graph edge / hyperedge
→ α-normalized relation fabric
→ field / frontier activation
→ route scoring
→ admissible proof path
→ slot plan
→ mouth realization
→ traceable answer
```

### 1. Evidence before assertion

A fact-like answer should originate in evidence, not in generated language.

Use this mental model:

```text
evidence span s
→ observation o
→ typed claim c
→ edge/hyperedge h
→ candidate answer a
```

A candidate answer is stronger when it has attached evidence spans, stable source identity, compatible timestamps, and a route through the graph that explains why it was selected.

Do not manufacture proof, source spans, citations, trace events, or certainty after the answer is already chosen.

### 2. Typed observations

Ingestion should transform source material into source-neutral typed observations.

A typed observation should carry at least:

```text
subject / anchor
relation or role
object / value
source id
span or offset
language / locale when known
time / version when known
confidence/support metadata when available
```

Do not encode cognition as English labels. Use language-neutral IDs/primitives and preserve source-derived labels separately.

Bad:

```text
relation = "was born in"
type = "EnglishBiographyFact"
```

Better:

```text
relation_id = rel.birth_place
source_label["en"] = "born in"
source_label["ko"] = ...
evidence_span = ...
```

If the repo uses a different concrete shape, follow the repo and preserve the same principle.

### 3. Graph and hyperedge semantics

A graph edge represents a typed relation between nodes. A hyperedge represents a relation that needs roles, qualifiers, time, provenance, or more than two participants.

Prefer hyperedges when a fact needs structure:

```text
Einstein — birth_place — Ulm
```

may become:

```text
event: birth
roles:
  person: Einstein
  place: Ulm
qualifiers:
  date: 1879-03-14
provenance:
  source/span ids
```

Do not flatten role-bearing evidence into keyword blobs. If flattening is required for storage, the runtime contract still needs the typed relation back.

### 4. α-normalized fabric

Alpha normalization exists to prevent raw frequency, noisy repetition, or one loud source from dominating cognition.

Use α as an interaction-normalization term:

```text
support'(h) = α(h, context) · support(h)
```

Where practical, α should account for:

```text
source reliability
span quality
relation compatibility
language/source agreement
temporal validity
contradiction pressure
route cost
local graph density
```

Do not treat α as an unexplained scalar. It is an engineering handle for normalizing graph motion so the strongest route is not merely the most repeated string.

### 5. Route scoring

Candidate selection should be route-based, not text-search based.

A useful route score can be understood as:

```text
score(route) =
  evidence_support
  × relation_fit
  × α_normalization
  × temporal_fit
  × contradiction_penalty
  × route_coherence
```

Different implementation files may name these differently. Preserve the idea: an answer is selected because it survives graph constraints, not because a keyword query found a paragraph.

### 6. Contradiction mass

Contradictions are not bugs to hide. They are graph pressure to expose or route around.

Track contradiction mass separately from support mass:

```text
support_mass(c)       = total compatible support for claim c
contradiction_mass(c) = total incompatible support against claim c
net_admissibility(c)  = support_mass(c) - contradiction_penalty(c)
```

When contradiction mass is material, the planner should either choose a safer answer, qualify the answer, or surface the conflict. The mouth should not smooth contradiction away as if nothing happened.

### 7. Temporal validity

Facts can expire or change. Time should be part of admissibility when the source data supports it.

Use this mental model:

```text
claim c is valid over interval [t_start, t_end]
query q asks from time tq
candidate admissible only if tq intersects validity interval
```

If the repo has interval or version fields, preserve them. If it does not, do not assert unsupported temporal certainty.

### 8. Proof-carrying answer

A final answer should carry enough proof structure for debugging.

Minimum useful proof payload:

```text
selected candidate
supporting edges/hyperedges
evidence spans
route score or support summary
contradiction summary
planner decision
mouth realization
trace id when tracing is enabled
```

The answer text is the surface. The proof path is the reason it was allowed to speak.

### 9. Mouth is realization, not cognition

The mouth/surface layer should not choose facts. It should realize an already-selected candidate or slot plan.

Correct boundary:

```text
kernel/planner decides what may be said
mouth decides how it is said
```

If an answer is factually wrong, inspect planner/runtime/evidence first. If the selected candidate is good but wording is bad, inspect mouth/surface realization.

### 10. Trace the math path

When `SCCE_TRACE=1`, trace events should help reconstruct the math path without reading the whole repo.

Useful stages:

```text
turn.input
runtime.start
graph.resolve
candidate.score
contradiction.check
planner.select
proof.attach
mouth.generate
turn.output
turn.error
```

Only emit stages that actually exist in the code path. Do not fabricate trace stages.

## Current Repo Shape

Expected workspace packages:

- `packages/kernel` — graph-native cognitive/runtime logic and source-neutral primitives.
- `packages/adapters-node` — Node adapters for Postgres, files, documents, connectors, hydration, and ingestion helpers.
- `packages/server` — HTTP API and workbench serving layer.
- `packages/cli` — local command-line runner.
- `packages/ui` — workbench model/surface code.
- `packages/vscode` — native local-loopback VS Code client for the existing server lane.
- `tools/scce-dev-mcp` — local MCP/debug tooling when present.
- `tools/sealed-eval` — sealing, blind scoring, citation verification, and ablation harness; its presence is not a completed public review.

Expected root commands:

```powershell
pnpm build
pnpm test
pnpm scce
pnpm server
pnpm scce:server
pnpm mcp:build
pnpm mcp:start
pnpm validate
pnpm rehearsal:postgres
pnpm rehearsal:adapter
```

Only use commands that actually exist in `package.json`.

## Token Discipline

Do not read the whole repo. Start every task with targeted discovery.

Recommended first pass:

```powershell
git status --short
jq '.scripts' package.json
pnpm repo:shape
pnpm repo:search
```

When those scripts are missing or broken, use bounded equivalents:

```powershell
fd -e ts -e tsx -e json -e md packages tools docs .vscode | head -300
rg -n "<symbol-or-error>" packages tools docs -g '!dist' -g '!node_modules' -g '!coverage'
```

Prefer this order:

1. Exact error message.
2. Failing test name.
3. Symbol definition.
4. Call sites.
5. Route/CLI entrypoint.
6. Storage/config contract.
7. Small source read.

Avoid broad exploration, duplicate summaries, and “while I’m here” cleanup.

## Debugging Workflow

For failures:

1. Run the smallest relevant command.
2. Capture the first real failure group.
3. Locate the exact source/test files with `rg`/`fd`.
4. Patch the smallest correct behavior.
5. Re-run the targeted check.
6. Re-run `pnpm build`.
7. Re-run `pnpm test` when the targeted check passes.

When trace support exists, enable it with:

```powershell
$env:SCCE_TRACE="1"
$env:SCCE_TRACE_DIR=".scce/traces"
```

Use MCP/debug tools before opening large files:

- `repo_shape`
- `repo_search`
- `repo_symbol`
- `repo_callsites`
- `repo_routes`
- `test_failures`
- `scce_trace_list`
- `scce_trace_read`
- `scce_answer_trace`

Do not add arbitrary shell execution to MCP tooling. Keep MCP results bounded and structured.

## Walsh Math Debug Map

Use this map to avoid token churn when diagnosing bad behavior.

| Symptom | First place to inspect | Likely issue |
|---|---|---|
| Missing facts after ingest | `typed-ingest`, adapters, import/hydration | Evidence did not become typed observations |
| Facts exist but graph is weak | graph construction, hyperedge roles | Relation shape lost provenance/roles |
| Wrong candidate selected | runtime orchestrator, planner, scoring | Route score/admissibility problem |
| Contradiction ignored | proof/evidence/semantic proof modules | Contradiction mass not tracked or not penalized |
| Answer has no evidence | proof-carrying answer path | Candidate selected without attached proof |
| Good candidate, bad wording | mouth/surface realizer | Realization problem, not cognition |
| Cannot debug answer | trace hooks/MCP trace tools | Missing trace stages or oversized trace payloads |
| Slow or token-heavy agent work | MCP repo tools, AGENTS, scripts | Repo not exposing small structured facts |

Patch at the first broken boundary. Do not patch the mouth to hide a bad candidate. Do not use storage behavior as a substitute for cognition. Do not patch docs to claim behavior tests do not prove.

## Architectural Guardrails

Preserve these constraints unless the user explicitly changes the project direction in the repository itself:

- Do not add hidden external-model calls, hosted inference, transformer wrappers, or prompt-stuffing paths.
- Do not implement cognition as broad SQL text search, `ILIKE`, or keyword retrieval.
- Do not introduce English seed ontologies, English cognition enums, or hand-authored English relation taxonomies.
- Do not add TypeDB or a second canonical graph database.
- Do not create a second runtime lane to avoid fixing the first one.
- Do not hide broken behavior behind adapter layers.
- Do not manufacture proof, evidence, or trace events that did not participate in the decision.
- Do not describe filesystem staging or `shell:false` as an OS sandbox. The current patch validator is trusted-host only and must not run untrusted repositories.
- Do not claim broad comparative performance or production readiness without an executed, reproducible public review record.

Multilingual behavior must use language-neutral IDs/primitives and source-derived labels/evidence. English is one corpus language, not the ontology.

## Patch Style

Good patches are small, reviewable, and verified.

For every non-trivial patch:

- Explain the failing behavior.
- Name the exact files changed.
- Explain why the patch is minimal.
- Include commands run and exact results.
- State remaining risk.

Do not claim success unless the command passed.

Do not perform cosmetic rewrites during debugging tasks. Do not rename large areas, reformat unrelated files, or churn docs unless the user asked for documentation.

## Source Boundaries

Use these common paths before guessing:

- CLI entry: `packages/cli/src/index.ts`
- Server entry: `packages/server/src/index.ts`
- API routes: `packages/server/src/routes.ts`
- Kernel entry: `packages/kernel/src/kernel.ts`
- Runtime orchestration: `packages/kernel/src/runtime-orchestrator.ts`
- SCCE runtime types/simulation: `packages/kernel/src/scce-runtime.ts`
- Ingestion: `packages/kernel/src/typed-ingest.ts`, `packages/kernel/src/training-orchestrator.ts`, `packages/adapters-node/src/wikipedia-v3-ingestor.ts`
- Spreadsheet ingestion: `packages/adapters-node/src/spreadsheet-contract.ts`, `packages/adapters-node/src/spreadsheet-parser.ts`, `packages/adapters-node/src/spreadsheet-process.ts`, `packages/adapters-node/src/spreadsheet.ts`
- Hydration/import: `packages/adapters-node/src/hydration-runtime.ts`, `packages/adapters-node/src/scce2/*`
- Mouth/surface: `packages/kernel/src/mouth.ts`, `packages/kernel/src/surface-realizer.ts`, `packages/kernel/src/answer-emitter.ts`
- Proof/evidence: `packages/kernel/src/evidence.ts`, `packages/kernel/src/proof-carrying-answer.ts`, `packages/kernel/src/semantic-proof-engine.ts`, `packages/kernel/src/semantic-proof-system.ts`
- Lifecycle: `packages/kernel/src/brain-lifecycle.ts`, `packages/adapters-node/src/postgres.ts`
- Evaluation boundaries: `packages/kernel/src/evaluation-flags.ts`, `packages/kernel/src/evaluation-trace.ts`, `tools/sealed-eval/integration/*`
- Patch transactions: `packages/kernel/src/patch-transaction.ts`, `packages/adapters-node/src/workspace-patch-transaction.ts`, `packages/adapters-node/src/structured-patch-validation.ts`, `packages/server/src/routes.ts`
- VS Code client: `packages/vscode/src/*`
- Debug trace: `packages/kernel/src/debug/trace.ts`
- MCP tooling: `tools/scce-dev-mcp/src/*`

## Final Response Format for Coding Agents

Use this format after a coding task:

```text
Initial state:
Files inspected:
Files changed:
Patch summary:
Commands run:
Results:
Remaining risk:
Next command:
```

Keep it factual. No victory laps. No invented verification.

## Serious-Version Math Appendix

For work that upgrades SCCE from heuristic-heavy behavior to calibrated, inspectable graph cognition, treat the repository math contract in `docs/SERIOUS_VERSION_MATH_APPENDIX.md` as a required appendix to the serious-version prompt.

When there is a conflict between this appendix and implementation reality, report the conflict explicitly and patch toward source-grounded, one-lane behavior with tests.
