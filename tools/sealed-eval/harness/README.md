# Harness

The harness uses only Node.js standard-library modules.

## Commands

```text
verify-kit
hash-tree --root=<path> --out=<json>
seal --evaluation-id=<id> --prereg=<file> --corpus=<manifest> --questions=<jsonl> [--source=<dir>] [--build=<dir>] [--brain=<manifest>] --out=<seal.json>
verify-seal --seal=<seal.json> --prereg=<file> --corpus=<manifest> --questions=<jsonl> ...
custody-append --file=<jsonl> --actor=<name> --event=<event> [--details=<json>]
run-systems --plan=<run-plan.json>
blind --answers=<raw.jsonl> --seed=<secret> --out=<blinded.jsonl> --map=<private-map.json>
verify-citations --answers=<raw.jsonl> --corpus=<manifest.json> --out=<verification.jsonl>
score-objective --answers=<raw.jsonl> --questions=<questions.jsonl> --out=<scores.jsonl>
aggregate --judgments=<judgments.jsonl> [--objective=<scores.jsonl>] [--map=<private-map.json>] --out=<report.json>
ablation-report --aggregate=<report.json> --manifest=<ablation.json> --out=<report.json>
```

## JSONL system protocol

A system in `jsonl-stdio` mode receives one question object per line on stdin and must return exactly one answer object per line on stdout. Stderr is captured separately. Do not write logging text to stdout.

The harness adds run/system/condition metadata to returned records. It preserves malformed output as a failure record.

## SCCE integration reality

From the repository root, the command wrappers are `pnpm eval:kit:verify`,
`pnpm eval:seal`, `pnpm eval:verify-seal`, `pnpm eval:run`,
`pnpm eval:blind`, `pnpm eval:verify-citations`, `pnpm eval:score`,
`pnpm eval:aggregate`, `pnpm eval:ablation`, and `pnpm eval:validate`.

The SCCE production adapter at `integration/yopp-jsonl-adapter.mjs` (a retained
compatibility basename) implements the knowledge/question protocol
through the normal built runtime. `integration/yopp-trace-verifier.mjs` verifies
the kernel's component trace; it is not a replacement for the citation verifier
or the run harness. There is no `yopp-coding-adapter.mjs`, so coding tasks and
patches are not yet supported by a sealed JSONL task protocol.

The harness includes local tests, and the SCCE adapter has a synthetic
live-rehearsal path. Those checks are local verification only. No
custodian-controlled protected review plan has been executed. Current public-review
status: `NOT_EXECUTED`.
