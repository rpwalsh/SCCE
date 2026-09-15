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

## Local Qwen CPU/GPU efficiency rehearsal

From the repository root, prepare a new directory and run the existing persistent
JSONL adapter lane. The default 168-question set is an already-used development
workload, not a fresh holdout. Stop unrelated benchmark/build work before timing.

```powershell
node tools/sealed-eval/harness/prepare-local-efficiency.mjs --out=.tmp/efficiency-cpu-a --device=cpu
node tools/sealed-eval/harness/cli.mjs run-systems --plan=.tmp/efficiency-cpu-a/plan.json
node tools/sealed-eval/harness/cli.mjs efficiency-report --answers=.tmp/efficiency-cpu-a/results/raw-answers.jsonl --measurements=.tmp/efficiency-cpu-a/results/run-measurements.jsonl --questions=tools/sealed-eval/artifacts/run-20260818/questions-bare.jsonl --out=.tmp/efficiency-cpu-a/efficiency.json
```

Prepare separate `--device=gpu` and `--order=qwen-first` repetitions in new
directories. The generator does not restart Ollama: the daemon must already be
running with the intended CPU/Vulkan configuration. The reference adapter pins
decoding, threads, context and local model digest, and rejects device fallback.
Each condition keeps one adapter process; Qwen keeps its model resident. There
is no explicit warmup, and the generated cold plan refuses to run when an
Ollama model is already resident. First-answer latency and subsequent p50/p95
are separate.

The Windows sensor records processor-package RAPL energy and raw counter readings.
`run-measurements.jsonl` hashes the inputs and raw telemetry. Missing, stale,
reset or discontinuous telemetry yields unavailable energy, not zero. The
preflight `host-configuration.json` records hardware/driver versions, OS build,
active power scheme, battery/AC state, Node/Ollama versions, model identity,
declared command settings, and Git revision/dirty state without environment
secrets; its hash is attached to the measurement. The
condition denominator includes startup, idle/background package activity and
failed answers. A correct objective task earns one point; correct tasks/kJ and
score points/kJ are consequently equal under this binary rubric. Correct
tasks/second/watt is correct tasks/joule. These measurements exclude earlier
SCCE training/ingestion and do not measure wall-outlet, whole-machine, or
GPU-only energy.
The prepared plan records preprocessing and timeout differences explicitly.
