# SCCE Public Review Contract

This contract defines the evidence required for a reproducible public review of SCCE. It does not assign product status or establish broad performance claims by itself.

## System boundary

The system under review is the normal local production lane:

```text
configuration
-> PostgreSQL-backed runtime
-> hydrated active brain
-> kernel turn or workspace path
-> proof, citation, and component trace
-> final answer or reviewed patch plan
```

The reviewed revision, configuration, corpus, brain, environment, and executable inputs must be identified by cryptographic hash. Any assisted or network-enabled condition must be registered as a separate system condition.

## Required controls

1. Freeze the source revision and generated build identity before protected inputs are disclosed.
2. Record configuration, corpus, brain, dependency lockfile, operating system, hardware, network policy, and resource limits.
3. Keep development fixtures and protected review inputs disjoint.
4. Preserve errors, timeouts, abstentions, and malformed outputs in the raw record.
5. Verify cited byte ranges against the sealed source corpus.
6. Verify that each declared evaluation condition changed the production component trace as specified.
7. Record every deviation from the preregistered procedure.
8. Publish scoring code and aggregation inputs with the review record.

## Review tracks

### Evidence-grounded questions

The knowledge adapter must use the normal hydrated runtime. Review records include answer text, source identity, exact citation spans, proof state, contradiction state, latency, and resource use.

### Workspace tasks

Workspace review requires a protocol that preserves the exact input revision, generated file bytes, validation policy, authorization state, execution state, and receipt. The current sealed JSONL integration does not yet provide a coding-task adapter, so this track is not ready for public execution.

### Runtime operation

Operational review covers clean setup, database lifecycle, restart behavior, trace reproducibility, bounded failure handling, and documented recovery procedures.

### Ablations

Each registered condition must have an immutable configuration, an isolated cache namespace, and a trace verifier that confirms the intended production component was disabled or replaced. Label-only changes are invalid.

## Scoring and reporting

Metrics, thresholds, confidence intervals, and correction procedures must be preregistered. Component metrics remain visible; an aggregate must not obscure a failed integrity requirement. Synthetic rehearsals are integration checks and are reported separately from protected review results.

Allowed status values are:

- `NOT_EXECUTED`: the protected procedure has not run.
- `FAILED`: execution stopped or an integrity requirement failed.
- `INCONCLUSIVE`: execution occurred, but evidence is insufficient for the registered claim.
- `COMPLETED_WITH_LIMITATIONS`: the procedure completed with disclosed scope or deviations.
- `VERIFIED`: every registered integrity and evidence requirement passed.

The current status is `NOT_EXECUTED`.

## Current integration state

The repository contains sealing, custody, blind scoring, exact citation verification, aggregation, ablation, and trace-verification tooling. The production knowledge adapter requires a hydrated active brain and enters the normal kernel path. Synthetic PostgreSQL and adapter rehearsals do not substitute for the protected procedure.

Known gaps include:

- no sealed coding-task adapter;
- no packaged VS Code extension-host trial;
- no completed protected run with an independently controlled input set;
- no available operating-system sandbox for untrusted workspace validation in the current local rehearsal environment.

## Required evidence package

A review record is complete only when it includes:

- preregistration and custody log;
- source, build, corpus, brain, configuration, and scorer hashes;
- raw answer or task records, including failures;
- citation and trace-verification outputs;
- environment and resource records;
- scoring and aggregation outputs;
- deviations, limitations, and negative results;
- instructions sufficient for an independent rerun.
