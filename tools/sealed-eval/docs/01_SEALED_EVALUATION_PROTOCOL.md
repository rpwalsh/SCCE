# Sealed evaluation protocol

## Stage A — preregistration

Before the system owner receives the question set, the custodian records:

- evaluation purpose;
- corpus classes and exclusion rules;
- question categories and target counts;
- systems and ablations;
- resource limits;
- scoring rubric;
- objective keys, if any;
- statistical plan;
- stopping rules;
- disqualification conditions;
- disclosure and reporting rules.

The preregistration is hashed and included in the seal.

## Stage B — private corpus and question construction

The custodian should use material that was not part of development, demonstrations, documentation, test fixtures, prompts, or prior conversations with the system owner.

Question authors should include:

- direct questions;
- paraphrases with intentionally low lexical overlap;
- cross-document joins;
- multi-hop questions;
- temporal changes and superseded facts;
- contradictions;
- unanswerable questions;
- misleading premises;
- exact-location citation tests;
- canary questions designed to expose hardcoding;
- negative controls unrelated to the corpus.

The system owner receives only the corpus/question hashes until the frozen run environment is ready.

## Stage C — frozen environment

Capture and hash:

- source tree and git state;
- build output;
- dependency lockfile;
- executable command;
- configuration;
- brain manifest;
- database schema and migration version;
- hardware and operating system;
- network state;
- injected clock and seed;
- process allowlist;
- evaluation harness.

No code change is permitted after the seal without logging a deviation and resealing.

## Stage D — run

- Mount or copy sealed inputs.
- Verify hashes before execution.
- Randomize system/condition order using a custodian-controlled seed.
- Run identical questions and constraints.
- Preserve every output, stderr stream, timeout, crash, and empty response.
- Do not rerun selected failures unless the preregistered retry rule allows it; retain all attempts.
- Record custody events as an append-only hash chain.

## Stage E — blind scoring

- Replace system IDs with opaque aliases.
- Remove only metadata that trivially reveals identity; retain answer content verbatim.
- Randomize answer order within each question.
- Judges score independently.
- Lock and hash judgments before unblinding.
- Resolve adjudication under a preregistered policy.

## Stage F — verification and reporting

- Verify exact citations against source bytes.
- Apply objective keys.
- Aggregate blind scores.
- Unblind.
- Compute paired baseline and ablation comparisons.
- Report all categories, failures, deviations, and underpowered results.
- Hash the completed evidence package.
