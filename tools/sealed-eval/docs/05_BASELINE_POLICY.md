# Baseline policy

Keyword search alone is not an adequate comparative baseline for a broad system evaluation.

## Required baseline classes

1. **Lexical retrieval** — included independent BM25 reference.
2. **Character/subword retrieval** — included independent n-gram reference.
3. **Vector retrieval** — evaluator-selected implementation.
4. **Graph-aware or structured retrieval** — evaluator-selected implementation.
5. **Competent local model over the same corpus** — where hardware permits.
6. **Human search baseline** — optional but valuable for high-consequence tasks.

The included reference adapters contain no third-party runtime code. They establish a minimum reference point. Additional baselines can be invoked through the same JSONL process contract and remain external to SCCE.

## Fairness controls

- Identical source corpus bytes.
- Identical questions.
- Identical time cutoff.
- Disclosed preprocessing.
- Equal or explicitly reported hardware budgets.
- No hidden internet for one system and air-gap for another.
- Separate identities for optional hosted-model assistance.
- Equivalent opportunity to index/ingest before timed answering.
- Report ingest/index cost separately from answer latency.

## Licensing

The harness does not require a paid algorithm license. The included BM25 and n-gram references are independently implemented from public mathematical descriptions. External baseline programs retain their own licenses and are not linked into SCCE.

## Current baseline status

The reference BM25 and character n-gram adapters are present. No stronger,
version-pinned comparison system has been configured or run in a
custodian-sealed plan. Reference-adapter availability does not change the
public-review status of `NOT_EXECUTED`.
