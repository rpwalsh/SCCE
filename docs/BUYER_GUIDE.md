# SCCE v3 Buyer Guide

## What SCCE Is

SCCE v3 is a local-first cognitive runtime for turning large bodies of source material into inspectable reasoning, language, and software-workflow behavior.

The system is built around typed memory, graph activation, learned language priors, proof-aware certification, and runtime replay. Its design goal is not to hide knowledge inside an opaque answer box. Its design goal is to let a buyer ask:

- What data shaped this answer?
- Which parts are source-certified?
- Which parts are learned priors or inferences?
- Which graph paths activated?
- Which surface candidate was selected?
- What would the system need to learn next?

SCCE can speak without proof. Proof is not a hard requirement for conversation, invention, planning, or explanation. Proof controls certification. If SCCE says something creative, speculative, source-bound, prior-bound, or invented, the runtime should preserve that force instead of pretending every sentence is certified fact.

## Why This Matters

Most high-value deployments do not only need good answers. They need answers that can be inspected, replayed, constrained, corrected, and improved from local data.

SCCE is aimed at settings where:

- The owner has private corpora, codebases, papers, operational logs, documents, and trained local assets.
- Data movement must be controlled.
- Workflows need durable state, replay, and audit.
- Users need ordinary language, not telemetry dumps.
- Engineers need to see why the system chose a path.
- Safety rails must protect users without turning the product into a refusal machine.

The current v3 repository is not a finished commercial deployment. It is a serious runtime core with source-only and controlled-hydration paths that now exercise the main chain: ingestion contracts, graph memory, semantic proof, language memory, Mouth realization, Walsh surface energy, ProgramGraph, workspace runtime, and replay-oriented traces.

## The Core Chain

SCCE uses a layered chain:

1. Source and hydration layer
   - Imports source material and learned priors.
   - Preserves force class: direct evidence, language prior, concept prior, program prior, profile excerpt evidence, unknown prior.
   - Writes durable rows when hydration is enabled.

2. Cognitive graph layer
   - Converts useful observations into graph nodes, edges, and hyperedges.
   - Keeps support, activation, source identity, and relation identity inspectable.

3. alpha field and PPF layer
   - Activates graph neighborhoods from the current request.
   - Uses alpha coupling and personalized Perron-Frobenius style propagation to rank paths.
   - Separates central answer material from context and background.

4. Semantic proof layer
   - Certifies only what admissible evidence can certify.
   - Does not block the Mouth from speaking when proof is absent.
   - Marks the difference between certified fact, source-bound statement, prior-bound inference, contradiction, and insufficient evidence.

5. Question slot planning layer
   - Determines what kind of answer the question asks for.
   - Selects facts that fill required answer slots.
   - Stops unrelated facts from dominating merely because they have graph mass.

6. Language and Mouth layer
   - Uses learned language priors and discourse planning to realize human-readable surfaces.
   - Does not treat raw snippets, n-grams, or graph labels as finished answers.

7. Walsh surface energy layer
   - Scores candidate surfaces for semantic preservation, proof boundary, force match, contradiction pressure, repetition, fragmentation, style fit, detail fit, language support, actionability, and compression fit.
   - Selects the lowest-energy usable surface.
   - Keeps traceable energy components.

8. Replay and inspection layer
   - Keeps enough structure to inspect what happened and replay a turn.

## What Buyers Should Expect Today

The current system should be evaluated as a serious alpha runtime core, not as a finished product claim.

What is present:

- Source-only turn paths.
- Controlled PostgreSQL hydration paths.
- pgvector-aware schema direction.
- SCCE2/V2 shard inspection and import work.
- Concept-prior and language-prior memory surfaces.
- Typed semantic proof adapter and engine.
- Question slot planning for answer relevance.
- ProgramGraph runtime and artifact emission planning.
- Workspace analysis promoted into graph, proof, learning, and program records.
- Walsh surface energy selection with inspectable trace.
- Local git discipline and source-only packaging.

What still needs proof at deployment scale:

- Large real corpus hydration without operator babysitting.
- Full v2 brain coverage across all supported shard/profile formats.
- Long-running Postgres durability under consumer hardware pressure.
- High-quality multilingual learned language generation from hydrated profiles.
- Live server/API turn path under realistic load.
- Broad question battery across known topics, code tasks, reasoning tasks, and invention tasks.
- Buyer-grade observability dashboards.

## Commercial Fit

SCCE is most attractive where the buyer values ownership, inspection, and local data advantage more than a simple hosted chat surface.

Good candidate use cases:

- Engineering knowledge systems over private repositories.
- Research intelligence over papers, notes, and source archives.
- Safety-sensitive assistant workflows where proof and force must be visible.
- Local personal or organizational memory systems.
- Tool-using agents that must explain what they can prove and what they are merely inferring.

Poor candidate use cases right now:

- A drop-in generic hosted chatbot replacement with no data preparation.
- A fully proven benchmark winner out of the box.
- A product that can be installed by a nontechnical buyer with no local setup.

## What Makes It Different

SCCE's differentiation is not one clever prompt. It is the combination of:

- Durable memory.
- Typed force classes.
- Inspectable graph activation.
- Proof-aware certification.
- Learned language priors.
- ProgramGraph artifact planning.
- Walsh surface energy.
- Replayable runtime state.

That combination is the product thesis: answer quality should improve with owned data while remaining inspectable enough for serious engineering review.

## Evaluation Checklist

A buyer should ask for a live demo that proves:

- A real corpus is hydrated into PostgreSQL.
- The same question changes after hydration.
- The answer contains natural language, not trace keys.
- Certified claims cite direct evidence spans.
- Prior-bound claims are not mislabeled as certified.
- A workspace question uses source-backed records.
- A code artifact plan emits real files and validation commands.
- The same turn can be inspected and replayed.
- The system handles unsupported topics without echoing the question or fabricating certification.

## Bottom Line

SCCE v3 is becoming a credible inspectable cognitive runtime. It is not enough to claim superiority from source code alone. The win condition is live hydration plus a strong question and task battery where SCCE uses local data, explains itself, writes useful artifacts, and speaks naturally without confusing invention with proof.

