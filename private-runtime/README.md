# private-runtime

The engine is public. The accumulated intelligence is not.

Everything under this directory is withheld from the public repository. This README is the
exception, so the boundary is visible rather than implied: a reader can see exactly what a
production instance mounts here, and that the public source does not depend on it existing.

## The split

**Public** — enough to inspect the architecture and run it:

- interfaces, types, graph/hypergraph representations, proof semantics, evidence contracts
- the persistence interfaces and the PostgreSQL schema
- PPF/PageRank/PowerWalk implementations, planner and learning-loop architecture
- the fitting algorithms *and* their source-disjoint holdout acceptance
- bootstrap defaults, the sealed evaluation harness, tests that prove invariants
- `tools/no-hidden-model-check.mjs` and the no-hidden-model attestation

**Private** — the result of running the above against a production corpus:

- calibrated turn-requirement models, judge weights, authority-routing coefficients
- fitted PowerWalk parameters, relation-potential models, promoted alignment artifacts
- production surface-energy weights, ranker checkpoints, learned constructions
- learned language-memory state, promotion thresholds, brain snapshots
- outcome histories used to derive calibration, the failure/tuning corpus
- the best-performing production runtime profile

## Mount points

```
private-runtime/
  brain/               brain snapshots and exports
  calibration/         fitted calibration models and profiles
  checkpoints/         ranker and learned-model checkpoints
  learned-models/      trained artifacts loaded through the public interfaces
  production-profile/  the configuration that produces the best measured results
```

## Why the public build still works

The bootstrap-versus-learned boundary already exists in the source and is not added by this
directory. `turn-requirement-calibration.ts` falls back to `DEFAULT_TURN_REQUIREMENT_MODEL` — an
uncalibrated bootstrap — whenever no stored model is present or the stored one fails validation,
and `calibration-spine.ts` builds calibrated models from accumulated observations when they exist.
The same shape holds elsewhere: load if present, fall back cleanly when absent.

Most learned state is not file-based at all. A brain lives in PostgreSQL (`graph_nodes`,
`graph_edges`, `language_profiles`, `language_patterns`, `ngram_models`, `model_state`,
`calibration_observations`), which the public repository has never contained.

A clone can therefore build the workspace, create a PostgreSQL-backed brain, ingest sources,
construct graph and hypergraph state, run proof and contradiction handling, derive requirement
fields and authority from bootstrap coefficients, plan, reason, realize surfaces, run the
evaluation harnesses, and train its own calibration from its own operation.

What it does not inherit is this instance's accumulated calibration, learned state and tuning.
The public engine is not crippled. It is uncalibrated at birth.

## Open work: the bootstrap table

The private side of this split already has an addressing scheme. Twelve calibration ids route
through `calibration-spine.ts` today — `candidateMass`, `judgeRequirementWeights`, `proofSupport`,
`proofContradiction`, `mouthSurfaceFit`, `retrievalHybridRecall` among them — and
`calibrateRuntimeScore` resolves a fitted model for an id when observations exist, falling back
when they do not. Two of the twelve currently have observations.

The public side does not yet exist. 4,354 decimal literals sit inline across 153 source files,
concentrated in `mouth.ts` (108), `language-memory-runtime.ts` (107), `walsh-surface-energy.ts`
(104), `graph-edge-quality.ts` (88) and `local-evidence-runtime.ts` (83). A handful of house
values recur across unrelated subsystems — `0.18` 214 times, `0.72` 182, `0.25` 179 — which is the
signature of hand-tuning rather than measurement, and 239 sites already self-label
`uncalibrated`, `bootstrap` or `provisional`.

The intended shape is a public bootstrap table giving each of those constants a stable id and a
declared meaning, so that a fitted value from `private-runtime/calibration/` overrides it by id
rather than by editing source. Until then every constant is simultaneously the public default and
the production value, which is the condition this boundary exists to end.

## Note on history

Fitted calibration reports and one localhost credential were removed from git history on
2026-09-12. Commit count, messages, authorship and dates are preserved; only object identifiers
changed. History rewriting reduces reachability, it does not prove erasure — anything previously
published should be treated as disclosed, and credentials rotated regardless.
