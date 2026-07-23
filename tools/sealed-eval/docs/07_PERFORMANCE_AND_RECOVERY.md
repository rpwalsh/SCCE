# Performance, persistence, and recovery evaluation

Answer quality alone is insufficient for a durable private brain.

## Ingestion and brain construction

Record:

- corpus bytes and document count;
- ingest wall time and CPU time;
- peak RSS;
- database and shard growth;
- checkpoint frequency;
- rejected/corrupt document count;
- completion and validation status;
- brain manifest hash.

## Query

Record per question:

- cold and warm latency;
- CPU time where available;
- peak/process RSS;
- shards touched;
- evidence candidates and graph nodes considered;
- component trace;
- output bytes;
- timeout/error state.

## Restart

Test:

1. clean shutdown;
2. forced process kill;
3. database restart;
4. restart with cache removed;
5. reload brain;
6. repeat locked questions;
7. compare answer/support/citation stability.

## Incremental update

Add a sealed update corpus containing corrections and new facts. Measure:

- update cost;
- changed state;
- unaffected-answer stability;
- corrected-answer behavior;
- old evidence supersession;
- rollback.

## Import failure

Inject failures after each stage. An incomplete brain must never become active. The previous active brain must remain available. Resume must be idempotent.

## Current SCCE implementation

SCCE persists the lifecycle states `CREATED`, `IMPORTING`, `VALIDATING`, `READY`,
`ACTIVE`, `STOPPED`, `FAILED`, `QUARANTINED`, and `INCOMPATIBLE`. Activation
requires `READY`, uses compare-and-swap semantics, returns the previous active
brain to `READY`, and is protected in PostgreSQL by an at-most-one-`ACTIVE`
constraint. A synthetic live PostgreSQL rehearsal verified legacy duplicate
repair, rejection of non-ready activation, preservation of the prior active
brain, replacement, and cleanup.

That rehearsal did not execute the sealed restart, incremental-update, resource,
or injected-failure matrix above. Those results remain `NOT_EXECUTED`.
