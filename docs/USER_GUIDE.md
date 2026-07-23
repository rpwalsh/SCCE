# SCCE v3 User Guide

## Current Product Boundary

SCCE is an active local runtime with specific verified engineering paths and material remaining work. Local checks and synthetic PostgreSQL or adapter rehearsals do not establish general answer quality, scale, or production readiness.

The VS Code client can inspect status, submit approved local operations, and apply an operator-selected content-addressed patch plan after review. The server can generate an exact-byte plan from a strict full-file proposal. Its separate coding-request route is strict and non-mutating and has two tested TypeScript paths: source-proven unused type-only import removal and one official TypeScript LanguageService fix for an existing requested file. Compiler fixes use structured `diagnosticCodes` (`--diagnostic-code=<integer>` in the CLI); request prose does not select a code action, and the structured scope must resolve to one candidate. The compiler uses durable snapshot files plus the TypeScript standard library and must resolve an exact project config from the source-observed direct `tsc` invocation. The selected compiler-owned action may close over as many as 32 files and 128 exact text changes, including bounded TypeScript or JavaScript creation under existing snapshot directories. The returned plan remains unauthorized and unexecuted pending compiler, typecheck, and test validation. Arbitrary feature synthesis remains unsupported.

A packaged VSIX has been installed and activated in an isolated VS Code 1.96.4
profile, where its commands and readiness request were observed. That smoke test did
not cover visual layout, restart recovery, or a live patch round trip. Trusted-host
validation remains the default and must not be used for code that is untrusted with
the server's host authority. The optional digest-pinned Docker path passed a local
networkless smoke test, but the Docker daemon, operator, image supply chain, and host
kernel remain trusted deployment components.

## What You Can Ask

SCCE accepts local prompts for factual questions, explanation, planning, workspace inspection, and bounded creative construction. Output quality depends on the available evidence, hydrated graph state, and calibration.

You can ask normal questions:

- Who was Ada Lovelace and what was her contribution to computer science?
- What is relativity?
- What does this workspace implement?
- What should we fix first?
- Invent a compression algorithm for this data shape.

SCCE does not require every useful answer to be certified. It can speak from learned priors, graph associations, source-bound excerpts, qualified inference, or creative construction. What matters is that it does not label unsupported material as certified and does not end an ordinary turn with a canned low-support refusal.

## How To Read Answers

The system has several answer forces:

- Certified fact: supported by admissible direct evidence.
- Source-bound: tied to a source/profile/excerpt but not generalized beyond it.
- Prior-bound: learned from imported material and useful for association or explanation.
- Inference: reasoned from active graph structure.
- Conjecture: plausible but not certified.
- Creative: invented or designed for the task.
- Contradicted: blocked or pressured by contrary evidence.

Normal answers should be readable. The force and trace should be inspectable, but the answer itself should not be a dump of proof keys, telemetry, database fields, semantic role identifiers, or workflow notation. The Mouth is the realization boundary: it consumes learned language memory and permitted source-bound surfaces without choosing facts.

## What Proof Means

Proof is certification, not permission to speak.

If you ask SCCE to invent, brainstorm, design, explain from learned priors, or reason from incomplete data, it should do that. If you ask whether a statement is source-certified, SCCE should only certify what direct evidence can support.

This distinction is important:

- "Say something useful" can use language priors, concept priors, inference, and invention.
- "Prove this is true" needs direct source/version/span evidence.

## Low Support Is A Recovery State

Insufficient support does not authorize a final refusal. It triggers one bounded recovery transition:

```text
detect the missing support
-> learn from eligible local material or perform a configured search/fetch
-> admit returned material through canonical typed ingestion
-> preserve source, version, span, language, and time metadata
-> replan once
-> answer with the resulting force
```

The recovery step is bounded to prevent an open-ended search loop. Search or fetched text does not become factual support until canonical ingestion has created source-backed observations and evidence spans.

After replanning, SCCE should answer with the strongest honest form available: a supported fact or correction, a source-bounded account, or a qualified inference or prior. If the single acquisition attempt is exhausted and a factual or reasoned turn remains under-supported, the current user policy itself licenses one bounded creative continuation; the original request does not need to be framed as a creative task.

Generic graph or language state alone is not enough. The selected continuation must use an admitted `learned_continuation` or `learned_structural_composition` realization, carry nonempty source-piece lineage, keep repetition bounded, and add meaningful material not copied from the question. Structural composition records the exact request-owned code-point and UTF-8 byte spans it binds into learned source structure; those spans are constraints and do not become factual evidence. The candidate must pass non-echo, risk, and unsupported-fact checks, carry an `invented` claim basis, cite no evidence, record `generated_not_evidence` provenance, and make no factual-certification claim. This makes the invention inspectable without pretending it is a discovered fact.

If connector, graph, and language state are all empty, there is no honest knowledge material to synthesize. The planner must select a non-assertive answer using only source-derived content that actually exists; it may not compensate with hardcoded phrases or fabricated facts. If a fluent surface cannot yet be realized, the Mouth may return an empty internal surface so the kernel completes its terminal selection. The Mouth then realizes the selected answer; the empty internal surface is never the user-facing answer.

Sparse or source-only cold-start realization is not a fluent-assistant claim. Current output may be fragmentary until a compatible learned language profile is hydrated.

## What Hydration Does

Hydration loads a corpus or shard into the SCCE runtime memory.

Hydrated data can affect:

- Graph nodes and relations.
- alpha activation.
- Personalized propagation ranking.
- LanguageMemory profile and suggestions.
- Mouth surface selection.
- ProgramGraph planning.
- Inspect and replay metadata.

Hydration changes the graph material available for activation and may change an answer. A changed answer is not, by itself, evidence of improved quality.

## Inspecting The Brain

Useful inspection commands include:

```powershell
pnpm scce inspect brain
pnpm scce inspect language
pnpm scce inspect graph-priors
```

For hydration:

```powershell
pnpm scce hydrate plan <path>
pnpm scce hydrate import <path> --plan <planId>
```

The inspection output should show counts, force classes, warnings, and import runs. Unknown and unsupported sections should be visible, not hidden.

## Asking Workspace Questions

SCCE can analyze a local workspace and promote source-backed records into the runtime chain.

Useful questions:

- What is implemented here?
- What is missing?
- What should we fix first?
- Which commands are available?
- What source files support this answer?

Workspace answers should come from promoted workspace records, not from a static report template. The answer should still be ordinary language.

## Asking Creative Questions

Creative answers are allowed.

Examples:

- Invent a new compression algorithm for a streaming wiki shard.
- Design a local ingestion safety rail for an 8 GB free RAM laptop.
- Propose a CLI layout for a project that has no server yet.

Creative output is not certified fact. Creative authority permits invention and design; it does not certify factual claims embedded in the result. Any factual claim still needs its own evidence or qualified force, and citations may not be manufactured after generation.

## Asking Factual Questions

For factual questions, SCCE should use relevant graph support and answer slots.

For a question like:

```text
Who was Albert Einstein?
```

The expected answer shape is not a random list of connected facts. It should prioritize identity, field, known-for material, and major contribution before secondary facts.

For a question like:

```text
Who are the main characters in Star Trek?
```

The expected answer shape should prioritize character/cast relations. Producer, composer, network, and episode-count facts are context, not the answer core.

### False premises and changing facts

A question can contain a false attribution or assume that a changing fact was always true. SCCE should not echo the premise and should not infer a negative answer merely because positive support is missing.

For example:

```text
Did Martha Washington invent the idea of using flags to represent nation states?
```

This requires evidence for both the attribution and the convention's earlier development. A negative answer is admissible when contradiction evidence or a temporally earlier source-backed history defeats the premise. The response should then correct the attribution and explain the supported development of the convention, rather than merely saying that the original claim lacked support. If that evidence cannot be acquired in the bounded recovery transition, SCCE should distinguish what is established from what remains unresolved. Any terminal invention must remain explicitly invented and cannot supply the missing historical negation.

## What To Do When Answers Are Weak

If an answer is weak, inspect before guessing:

1. Check whether the relevant graph cluster exists.
2. Check whether there are direct evidence spans.
3. Check whether there are language priors for fluent surface generation.
4. Check whether the question slot planner selected the right core facts.
5. Check whether Walsh surface energy rejected the best candidate.

Common causes of weak answers include:

- The data is missing.
- The graph has support but planning selected the wrong facts.
- The Mouth had meaning but weak language priors.

## Operational Checks

Hydration changes the graph material available for activation; it does not by itself establish better answers. Before relying on a deployment, verify that its corpus is hydrated, its schema is current, its server path is live, and replay works for the intended workload.

Run repository checks against the exact checkout in use:

```powershell
pnpm build
pnpm test
pnpm validate
$env:SCCE_DATABASE_URL="postgresql://<user>:<password>@<host>:<port>/<database>"
pnpm scce db migrate
pnpm scce db verify
pnpm rehearsal:postgres
pnpm rehearsal:adapter
```

Database-dependent checks require a configured PostgreSQL URL, and the server does not
migrate the schema automatically. Normal startup binds the socket before background
warmup; use `GET /api/ready` for database readiness. Passing local checks establishes
only the contracts those commands exercise.

## Practical Rule

Ask naturally, then inspect the resulting evidence and trace.

SCCE is designed as an inspectable cognitive runtime; use its evidence and trace surfaces during operation.
