# SCCE/Yopp Source Map

Generated from repo-intelligence passes: AGENTS.md guidance, targeted package manifests,
kernel/adapters symbol maps, madge dependency scan, and existing architecture docs.

## Repository Shape

- **Root**: `scce-v3` monorepo (pnpm workspaces)
- **Package manager**: pnpm 10.28.2
- **Runtime**: Node.js + TypeScript + PostgreSQL

## Workspace Packages

| Package | Name | Role | Dependencies |
|---------|------|------|--------------|
| packages/kernel | @scce/kernel | Core cognitive engine | none (pure runtime) |
| packages/adapters-node | @scce/adapters-node | Node adapters + storage + ingestion | @scce/kernel, pg, mammoth, xlsx, typescript |
| packages/cli | @scce/cli | CLI entry point | @scce/kernel, @scce/adapters-node |
| packages/server | @scce/server | Server/API entry point | @scce/kernel, @scce/adapters-node, @scce/ui |
| packages/ui | @scce/ui | UI surface | none declared |

**Dependency health**: `madge` circular scan reported `No circular dependency found!` across
`packages` for `.ts/.tsx` files.

## Kernel Modules (packages/kernel/src)

The kernel is one compiled graph. Key modules by function:

**Cognition core**
- `kernel.ts` — `ScceKernel` owns the turn pipeline: ingest, train, turn, replay, inspect, benchmark
- `alpha.ts` — Alpha relation classifier and trace builder
- `ppf.ts` — Personalized Perron-Frobenius ranking
- `field.ts` — Alpha field activation
- `alpha-field-persistence.ts` — Fingerprint-based alpha field caching
- `powerwalk.ts` — PowerWalk ranking
- `graph-analytics.ts` — Connected components, centrality, spectral, k-core

**Answer pipeline**
- `question-slot-planner.ts` — Converts requests into answer contracts (requiredSlots, answerCore, context)
- `candidate.ts` — Candidate generation (ccrCandidate, graphInferenceCandidate, creativeCandidate, learningCandidate)
- `judge.ts` — Candidate selection under policy
- `answer-emitter.ts` — Evidence-grounded answer composition (ccrCandidates, evidenceCandidates, selectDiverse)
- `mouth.ts` — LanguageMemory realization + Walsh surface energy → spoken output
- `walsh-surface-energy.ts` — Surface candidate scoring

**Proof and trust**
- `semantic-proof-engine.ts` / `semantic-proof-adapter.ts` / `proof-calculus.ts` / `proof-carrying-answer.ts`
- `entailment.ts` — Semantic entailment with proof-gated verdicts
- `audit.ts` — Event chain verification, proof/construct/forecast/capability summarization
- `answer-emitter.ts` — Embedded evidence-diversity selection

**Graph management**
- `graphbuild.ts` — Source graph builder (nodes, edges, evidence binding)
- `graph-edge-quality.ts` — Edge quality scoring
- `action-graph.ts` — Action graph from capability plans
- `causal.ts` / `causal-discovery.ts` / `causal-estimation.ts` / `causal-math.ts` — Causal cognition stack

**Language and memory**
- `language-memory-runtime.ts` — N-gram/language-memory runtime (hydrate, observe, train, score, suggest, generate, realize, correct)
- `language.ts` / `language-induction.ts` — Language acquisition/induction
- `kneser-ney.ts` — Kneser-Ney n-gram model
- `localization-memory.ts` / `localization.ts` — Localization/locale support
- `correction-memory.ts` — Style/correction rule memory

**Learning and adaptation**
- `learning-loop.ts` — Gap detection, planning, quarantine, promotion
- `learning.ts` — Learning controller (goals, promotion, language/graph learning plans)
- `developer-intelligence.ts` — Repo snapshot → engineering corpus → symbol/dependency/build/test graphs
- `code-learning.ts` — Code knowledge graph, blueprint generation
- `functional-cognition.ts` — Functional self/goal scoring, policy evolution
- `latent.ts` — Latent concept learner
- `counterfactual-cognition.ts` — Counterfactual simulation

**Ingestion and evidence**
- `evidence.ts` — Evidence extraction (byte-indexed chunking, paragraph/section detection)
- `ingestion-planner.ts` — Ingest plan (media classification, chunk, quarantine, transaction)
- `ingestion-lanes.ts` — Lane classification, observation profiling

**Governance and control**
- `governed-action.ts` — Governed action envelope (attest, propose, plan, verify)
- `connector-governance.ts` — Connector capability/quota/validation
- `control-plane-profiles.ts` — Control detail profile resolution, boundary profiles
- `admission.ts` — Source admission controller
- `construct-substrate.ts` — Construct assembly (responsibilities, boundaries, workbench, persistence)
- `legacy-detail-signal-adapter.ts` — Legacy detail signal bridge

**Identity and events**
- `ids.ts` — `IdFactory` (episode, event, run, artifact, node, edge, claim, proof, etc.)
- `events.ts` — Event factory + ledger hashing

**Developer and workspace support**
- `brain-shards.ts` — SCCE2 brain shard inspection and import
- `engineering-corpus.ts` / `engineering-corpus-runtime.ts` — Engineering corpus projection and command ranking
- `benchmarks.ts` — Benchmark scoring (correctness, evidence, auditability, build/test, tool use, multilingual, safety, efficiency, novelty)
- `semantic-proof-system.ts` — Semantic proof system (used by ENGINEERING_GUIDE)
- `semantic-proof-adapter.ts` — Proof engine adapter

## Adapters-node Modules (packages/adapters-node/src)

**Storage**
- `postgres.ts` — `PostgresStorageAdapter`. Implements every durable store:
  - Event ledger, ingestion checkpoints, blob store
  - Evidence store (source versions, evidence spans, promotion, searchEvidence)
  - Graph store (nodes, edges, hyperedges, temporal slice, alpha materialization)
  - Quarantine store, proof store, construct store, capability audit store
  - Forecast store, benchmark store, model store
  - Language memory store (ngram models/observations, units, patterns, semantic frames, translation alignments)
  - Brain import store, correction memory store, localization store
  - Flow cache (PPF cache, alpha trace), self-rewrite store, workspace store

**Runtime and config**
- `runtime.ts` — `NodeScceRuntime` creation
- `config.ts` — `readScceRuntimeConfig` (from `scce.config.json`), `validateConfig`
- `secrets.ts` — Secret encrypt/decrypt, redaction

**Connectors and external access**
- `connector-policy.ts` — `ConnectorPolicyGate` (quota/allowlist/redaction)
- `connectors.ts` — `ConfiguredConnectorAdapter` (fetch, web search: DDG/Bing/Brave/SerpApi/Tavily, Outlook, YouTube, telephone)

**Document ingestion**
- `document.ts` — Extract text from PDFs, DOCX, workbooks, images; bounded reads
- `document-pipeline.ts` — Document pipeline plan + admission
- `files.ts` — `NodeFileIngestAdapter` (streamPath, checkpointing)

**Corpus ingestion**
- `wikipedia.ts` / `wikipedia-v3-ingestor.ts` — Wikipedia dump ingestion
- `engineering-corpus-folder.ts` — Engineering corpus folder inspection/dry-run
- `repo-intelligence-folder.ts` — Repo intelligence (source facts, diagnostics, graph analysis)

**Workspace and developer tooling**
- `workspace-runtime.ts` — `WorkspaceRuntime` (init, ingest, project, answer, report)
- `hydration-runtime.ts` — Brain hydration plan + import
- `code-graph.ts` — Source code fact extraction (TS + structural fallback)
- `program-repair.ts` — Program artifact repair
- `approval-session.ts` — Approval workflow
- `language-control-hygiene.ts` — Language control hygiene scanner

**Other**
- `process.ts` — Build/test adapter

## CLI and Server

- `packages/cli/src/index.ts` — CLI entry. Commands include:
  - `scce` — main runtime CLI
  - `hygiene language-control` — language control scan
  - `scce:server` — launch server
- `packages/server/src/index.ts` — Server/API entry

## Configuration

- `scce.config.json` — Runtime config (DB connection, connectors, quotas, policy)
- `tsconfig.base.json` — Base TypeScript config
- `vitest.config.ts` — Test runner config
- `pnpm-workspace.yaml` — Workspace layout
- `AGENTS.md` — Agent guidance (Codex tool-first workflow + prohibitions)
- `package.json` — Root with repo scripts + devDependencies

## Repo Scripts (Codex shortcut commands)

- `pnpm repo:shape` — tokei repo shape (excludes node_modules, dist, .git)
- `pnpm repo:search` — rg --files with standard exclusions
- `pnpm repo:deps` — madge circular dependency scan
- `pnpm repo:cruise` — dependency-cruiser architecture check
- `pnpm repo:dead` — knip dead code / unused dep scan
- `pnpm repo:exports` — ts-prune unused exports
- `pnpm repo:docs` — typedoc API docs
- `pnpm scce:audit` — aggregate: shape + deps + dead + test

## Multilingual Contract

See `docs/MULTILINGUAL_CONTRACT.md`. Summary:
- No English seed labels / enums / taxonomies / hand-authored relation names
- All linguistic labels source-derived or language-neutral IDs
- English is one corpus language, not the ontology

## Current Documentation

- `docs/ARCHITECTURE.md` — Runtime spine, SCCE2 brain bridge, brain hydration, math placement, large-input guardrails
- `docs/ENGINEERING_GUIDE.md` — Runtime principle, call stack, mathematical spine, surface selection rules, testing expectations
- `docs/USER_GUIDE.md` — User-facing guide
- `docs/BUYER_GUIDE.md` — Buyer guide
- `docs/WORKSPACE_RUNTIME.md` — Workspace runtime guide
- `docs/MULTILINGUAL_CONTRACT.md` — Multilingual contract

## What The Tools Revealed

1. **SCCE is graph-native**: durable state is PostgreSQL via `PostgresStorageAdapter`; no in-memory hot brain.
2. **One brain, one trainer, one runtime, one mouth**: `kernel.ts` orchestrates; `mouth.ts` realizes; proof is separate from speech.
3. **No circular deps**: workspace packages form a DAG.
4. **Heavy math/statistics layer**: Perron-Frobenius, causal discovery, causal estimation, Kneser-Ney, spectral graph analytics.
5. **Rich adapter layer**: web search, document extraction, Wikipedia ingestion, engineering-corp ingestion, repo intelligence.
6. **Strong test hooks**: focused vitest suites exist under `packages/*/src/__tests__/`.
7. **SCCE2 bridge exists**: `brain-shards.ts`, `hydration-runtime.ts`, and adapters maintain backward-compatible brain import.
8. **Workspace runtime is first-class**: `workspace-runtime.ts` and `repo-intelligence-folder.ts` support source-backed workspace QA.
9. **Postgres schema is large**: evidence, graph, proof, construct, forecast, benchmark, model, language memory, brain import, correction, localization, flow cache, self-rewrite, workspace.
10. **Codex token budget is now protected**: `AGENTS.md` mandates tool-first discovery and bans English seed ontology, ILIKE RAG, TypeDB, adapter sprawl.