# SCCE v3 User Guide

## Current Product Boundary

SCCE is an active local runtime with specific verified engineering paths and material remaining work. Local checks and synthetic PostgreSQL or adapter rehearsals do not establish general answer quality, scale, or production readiness.

The VS Code client can inspect status, submit approved local operations, and apply an operator-selected content-addressed patch plan after review. The server can generate an exact-byte plan from a strict full-file proposal. Its separate coding-request route is strict and non-mutating, but no successful production coding family is demonstrated: a generic existing-module request fails closed with `422` because generated ProgramGraph data lacks verified repair lineage.

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

SCCE should not require every answer to be proven before it says anything. It can speak from learned priors, graph associations, source-bound excerpts, or creative construction. What matters is that it does not label unsupported material as certified.

## How To Read Answers

The system has several answer forces:

- Certified fact: supported by admissible direct evidence.
- Source-bound: tied to a source/profile/excerpt but not generalized beyond it.
- Prior-bound: learned from imported material and useful for association or explanation.
- Inference: reasoned from active graph structure.
- Conjecture: plausible but not certified.
- Creative: invented or designed for the task.
- Contradicted: blocked or pressured by contrary evidence.

Normal answers should be readable. The force and trace should be inspectable, but the answer itself should not be a dump of proof keys, telemetry, or database fields.

## What Proof Means

Proof is certification, not permission to speak.

If you ask SCCE to invent, brainstorm, design, explain from learned priors, or reason from incomplete data, it should do that. If you ask whether a statement is source-certified, SCCE should only certify what direct evidence can support.

This distinction is important:

- "Say something useful" can use language priors, concept priors, inference, and invention.
- "Prove this is true" needs direct source/version/span evidence.

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

Creative output is not certified fact. It may be useful or actionable, but it remains unsupported unless evidence is attached and evaluated under the applicable proof rules.

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

## Good User Expectations

Additional hydrated data changes the available graph material. Whether it improves results must be established by evaluation.

Do not treat the runtime as complete before:

- The corpus is hydrated.
- The schema has migrated.
- The server path is live.
- Replay has been tested.
- The question battery shows behavior across many topics.
- Calibration has been fitted and checked on representative held-out work.
- The exact editor package has passed the specific host behaviors required for the deployment.
- Validation isolation and its Docker/host trust boundary have been reviewed for the deployment.

The public-review harness is evidence-collection infrastructure. The protected public-review procedure has not been executed.

## Verified Local Checks

Run the following against the exact checkout under review:

```powershell
pnpm validate
pnpm rehearsal:postgres
pnpm rehearsal:adapter
pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>
pnpm load:gate --prompts <prompts.json|jsonl> --workload-id <immutable-id>
pnpm vscode:test:host
```

The calibration and load commands require caller-supplied data; neither has been run
with a representative release dataset. The PostgreSQL rehearsals also remain
unexecuted in the current release record because no database password was configured.
The local Docker and extension-host smoke tests establish only the behaviors they
observed. They are not production certification, independent review, or a substitute
for reviewing the Docker daemon, operator, image supply chain, and host kernel.

## Practical Rule

Ask naturally, then inspect the resulting evidence and trace.

SCCE is designed as an inspectable cognitive runtime; use its evidence and trace surfaces during operation.
