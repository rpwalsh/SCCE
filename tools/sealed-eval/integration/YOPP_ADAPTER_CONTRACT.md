# SCCE adapter contract

This file, the `yopp-*` adapter basenames, and the `YOPP_EVAL_*` environment names
retain their legacy compatibility identifiers. They refer to the SCCE production
runtime.

The integration adapter must be a thin bridge to the normal production runtime. It must not contain benchmark answers, special prompt cases, alternate retrieval, or a private scoring key.

## Input line

The full question object from `schemas/question.schema.json`.

## Output line

At minimum:

```json
{
  "status": "ok",
  "answer": "...",
  "citations": [
    {
      "documentId": "doc-001",
      "startByte": 10,
      "endByte": 42,
      "sha256": "...",
      "quotedText": "..."
    }
  ],
  "support": {},
  "trace": [],
  "metrics": {}
}
```

## Required trace events

- `turn-start`
- `retrieval-start` / `retrieval-end`
- component `entered`, `bypassed`, and `cache-read`
- `answer-object-created`
- `mouth-candidate-created`
- `final-hard-gate`
- `turn-end`

The trace must avoid proprietary formula values where disclosure is not required. It must still prove which component executed.

## Production adapter

Run `pnpm build` first, then launch `integration/yopp-jsonl-adapter.mjs` from the repository root. The harness supplies:

- `YOPP_EVAL_CONDITION`
- `YOPP_EVAL_SEED`
- `YOPP_EVAL_CLOCK`
- `YOPP_EVAL_RUN_ID`
- `YOPP_EVAL_CORPUS_MANIFEST`
- optionally `YOPP_EVAL_SCOPE` and `YOPP_EVAL_CONFIG_PATH`

The production adapter emits the kernel's `evaluationTrace` component events verbatim. It does not synthesize the generic lifecycle labels above. At present, those exact labels are not all exposed as first-class events by `TurnResult`; `metadata.runtimeEventTypes` records the real kernel event types that did execute. A sealed run requiring the exact generic lifecycle names must remain blocked until those stages exist in the production runtime. This is intentional: an adapter-generated label would not prove that the named kernel stage participated.

Citations are emitted only after exact comparison with the sealed corpus bytes and the persisted source-version and evidence-span contracts. Failed or ambiguous comparisons produce no citation.

At startup the adapter also requires `assertHydratedRuntimeReady` to find a
valid active brain. The durable lifecycle states are `CREATED`, `IMPORTING`,
`VALIDATING`, `READY`, `ACTIVE`, `STOPPED`, `FAILED`, `QUARANTINED`, and
`INCOMPATIBLE`; only `ACTIVE` is eligible for the production run. PostgreSQL
enforces at most one active lifecycle row.

The production knowledge adapter passed a synthetic live rehearsal through a
disposable PostgreSQL schema, including one exact citation and a trace accepted
by the verifier. That is a local rehearsal, not sealed review evidence. A coding
adapter does not exist, so the harness cannot currently execute the public
review's coding track through an equivalent normal-task JSONL boundary.
