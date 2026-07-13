# SCCE Public Review Kit

This kit is a standalone, zero-runtime-dependency evaluation control plane for turning SCCE claims into reviewable evidence.

It does **not** contain benchmark answers, evaluation outcomes, or a substitute for independent evaluators. It provides schemas, chain-of-custody controls, a command protocol, reference retrieval baselines, blinding tools, exact citation verification, scoring aggregation, and ablation reporting needed to produce a reviewable evaluation record.

## What this kit protects against

- Development questions appearing in the benchmark.
- Hardcoded or manually tuned answers.
- Evaluators knowing which system produced an answer.
- Ablations that change labels but not execution.
- Citation spans that do not reconstruct the source bytes.
- Quiet changes to source, brain, corpus, questions, environment, or scoring after preregistration.
- Favorable examples being reported while failures disappear.
- Optional external-model assistance being mixed into a local-only result.
- A result being described as independent when the system owner selected the questions or scored the answers.

## Required roles

1. **System owner** — supplies the executable and documented operating procedure but does not see sealed questions before the run.
2. **Evaluation custodian** — controls corpora, question sets, scoring keys, seal hashes, blinding seed, and unblinding map.
3. **Runner** — performs the clean-machine or air-gapped run and records environment and custody events.
4. **Human judges** — score blinded outputs without system identity.
5. **Observer** — optional independent technical witness who verifies procedure rather than source code.

One person may perform more than one role for development rehearsals. A public review report must disclose every role overlap.

## Quick verification

```
node harness/cli.mjs verify-kit
node --test harness/tests/*.test.mjs
```

## Current integration status

The kit is now installed at `tools/sealed-eval/`. The root package exposes the
seal, run, blind, citation, score, aggregate, ablation, verification, and test
commands. The production adapter at `integration/yopp-jsonl-adapter.mjs` enters the normal
runtime, requires a hydrated active brain, preserves real support state, and
checks citations against exact sealed-corpus bytes. All declared condition IDs
are wired at production boundaries and have independent trace verification.

The current public-review status is `NOT_EXECUTED`. The live PostgreSQL and
knowledge-adapter rehearsals used synthetic material and are local verification
only. A coding adapter is not present, no custodian-controlled protected review plan
has been executed, and the editor extension has not been exercised as an
installed package in an extension host. The trusted-host patch validator is not
an OS sandbox, and its latest live rehearsal was blocked during frozen offline
dependency materialization.

## Evidence rule

No evaluation claim is valid unless the evidence package includes:

- preregistration;
- corpus, question, source, build, brain, configuration, and scorer hashes;
- complete raw answer records, including errors and timeouts;
- exact citation verification;
- blind judgments and unblinding map;
- environment and resource records;
- deviations log;
- ablation configuration and proof that the disabled component did not execute;
- reproducible aggregation code;
- limitations and negative results.
