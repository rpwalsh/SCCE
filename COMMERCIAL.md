# Commercial licensing

SCCE's source is published for inspection only (see [LICENSE](LICENSE)).
Running it beyond personal evaluation requires a commercial license.

## What you are licensing

A self-contained cognitive runtime that:

- **Proves what it says.** Every answer is bound to ingested evidence with
  an inspectable proof route — no hallucination by construction, because
  there is no generative model to hallucinate. When it doesn't know, it
  says so.
- **Runs where your data must stay.** CPU-only, PostgreSQL-backed, zero
  network dependency at inference time. Suitable for air-gapped,
  regulated, and privacy-critical environments where LLM APIs and GPU
  clusters are non-starters.
- **Is auditable end to end.** Sealed evaluation harness with
  cryptographic custody chain, 1,600+ kernel tests, and a no-hidden-model
  gate that verifies the shipped runtime contains no neural network.

## Verified performance

On this repository's sealed cloze benchmark (168 questions, real Wikipedia
corpus, 2026-08-20): 157/168 exact answers vs 158/168 for a tuned BM25
reference on identical evidence, at ~2.5s median turn latency on desktop
hardware. Methodology and custody chain: [docs/EVALUATION_PROTOCOL.md](docs/EVALUATION_PROTOCOL.md).

## Use cases

- Grounded question answering over private document sets
- Evidence-bound assistants for compliance-sensitive workflows
- Workspace-aware coding assistance with bounded, reviewable changes
- Research platform for non-neural cognitive architectures

## Getting a license

Open an issue at [github.com/rpwalsh/SCCE/issues](https://github.com/rpwalsh/SCCE/issues)
with the label `licensing`, or contact the repository owner. Evaluation
licenses for proof-of-concept deployments are available.
