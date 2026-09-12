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

## Note on history

Fitted calibration reports and one localhost credential were removed from git history on
2026-09-12. Commit count, messages, authorship and dates are preserved; only object identifiers
changed. History rewriting reduces reachability, it does not prove erasure — anything previously
published should be treated as disclosed, and credentials rotated regardless.
