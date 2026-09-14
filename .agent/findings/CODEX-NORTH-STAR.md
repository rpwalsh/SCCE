# Qwen comparison: verified handoff assessment

Read-only assessment of `artifacts/head-to-head/results-final.json`, generated
2026-09-13T22:59:22.485Z, against qwen2.5:3b. No answers were regraded.

Counting stored `correct` and `declined` verdicts gives SCCE **238/311** and
Qwen **145/311**. The bulletin's 237 omits the one correct SCCE answer in the
abstention workload: that workload has 1 correct answer plus 52 refusals.

| Workload | SCCE correct behavior | Qwen correct behavior |
| --- | ---: | ---: |
| Cloze | 135/160 | 29/160 |
| Abstention | 53/59 | 34/59 |
| Factual | 28/50 | 50/50 |
| Book | 2/12 | 10/12 |
| Conversational | 10/12 | 12/12 |
| Relation | 7/7 | 7/7 |
| Direct | 3/5 | 3/5 |
| Code | 0/6 | 0/6 |

The owner restated the target in `.agent/BULLETIN.md`: beat the reference at
every workload. The aggregate lead does not satisfy that target. Parity in
the three losing workloads requires 22 more factual, 8 book, and 2
conversational answers. Code capability is not established by a tie at zero.
Perfect-score reference workloads require a harder benchmark to demonstrate
strict superiority rather than parity.

Recorded mean latency: SCCE 19,815 ms, Qwen 5,204 ms. Recorded fabricated
verdicts on unanswerable items: SCCE 6, Qwen 24. These are this grader's
measurements, not a general unsupported-claim rate or energy comparison.

Limits: substring-based answer grading and refusal-marker false positives;
repeated development against these questions; patches newer than this run;
subsequent corpus re-ingestion. The runner sends a model tag and prompt to
Ollama without explicit seed or generation options. The result file does not
bind an immutable model digest, code commit, and corpus snapshot.

The bulletin's 20-row relation-potential comparison reports no changed
answers despite improved component ranking. Causal graph-operator benefit
and fresh held-out generalization remain separate acceptance requirements.

Next measurement should be one coordinated run of the updated build and
corpus, followed by an untouched held-out set with frozen configurations.
