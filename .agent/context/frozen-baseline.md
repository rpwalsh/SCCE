# Frozen baseline

The comparison is meaningless if either side moves. Freeze and record.

## Reference system
- model: `qwen2.5:3b`, digest `357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`
- quantization: Q4_K_M · parameters 3.1B · context 32768 · format gguf
- engine: ollama, local, `http://127.0.0.1:11434`
- hardware: 8 cores, ~16.7 GB RAM, no discrete GPU

## Harness
`node tools/head-to-head/run.mjs --suite artifacts/head-to-head/suite.json`
Charges each side its OWN process CPU: it samples the ollama process, not just the client, so the figures are
attributable rather than wall-clock guesses. Grading is deterministic in `grade.mjs`; a verdict must not depend on
which harness asked.

## Suite
311 items. Graded non-Wikipedia coverage was added after an audit found two existing items answerable by echoing
the question back, proven against the real grader.

## Standing result, 40-item slice, 2026-09-13

| | SCCE | qwen2.5:3b |
| --- | ---: | ---: |
| correct | 29/40 | 6/40 |
| wrong | 2 | 34 |
| declined when answerable | 9 | 0 |
| fabricated | 0 | 0 |
| wall s/item | 23.48 | 4.33 |
| CPU s/item | 25.79 | 0.47 |
| peak RSS | 3919 MB | 57 MB |

**Accuracy is already won: 29 against 6, with nothing fabricated.** The losses are elsewhere. Nine answerable
questions declined puts the ceiling at 38, not 29, and that is the largest recoverable block. Compute is 5x slower
and 55x more CPU-expensive, which is the claim to stop making until the eager work is gone.

The GPU column is hardcoded 0 for both sides. If ollama is using the integrated GPU the reference is understated,
so treat its CPU figure as a lower bound.
