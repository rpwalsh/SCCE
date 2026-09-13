# Compute-efficiency proxy (G9)

A compute-efficiency proxy. CPU-seconds are not joules; this host exposes no package-energy counter, so there is no joules column rather than an estimated one.

Built from 2652 measured turns in `.scce/traces`, 2026-09-09T20:49:11.293Z to 2026-09-13T04:25:17.731Z.

## Per turn, SCCE

| condition | n | CPU-s p50 | CPU-s p95 | wall-s p50 | wall-s p95 | peak RSS p50 | peak RSS p95 | GPU-s | API tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| warm | 2078 | 6.17 | 20.50 | 6.70 | 17.97 | 3.04 GiB | 4.44 GiB | 0 | 0 |
| cold | 210 | 14.56 | 49.81 | 16.81 | 42.55 | 2.90 GiB | 4.47 GiB | 0 | 0 |

How much of that CPU column can be this turn's own work: over warm turns the whole process burned 0.984 CPU-seconds per wall-second at p50 and 1.684 at p95. At the median the entire process, background included, stayed under one busy core, so the turn's own CPU cannot exceed the figure above and the room between them is small.

## Per request, warm

25 of 220 request groups, by sample count, covering 2078 of 2078 warm turns (the rest carry no request text in the trace). All 220 groups are in the JSON artifact.

| request | n | CPU-s p50 | CPU-s p95 | wall-s p50 | wall-s p95 | GPU-s | API tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| What is the capital of Alabama? | 55 | 5.01 | 15.34 | 4.61 | 11.01 | 0 | 0 |
| What is the capital of Azerbaijan? | 51 | 5.33 | 16.47 | 5.45 | 9.72 | 0 | 0 |
| What is the capital of Japan? | 46 | 4.05 | 33.03 | 3.81 | 16.51 | 0 | 0 |
| who were the characters in gene rodenberry's Andromeda? | 45 | 6.06 | 9.75 | 6.13 | 9.33 | 0 | 0 |
| what is anarchism? | 44 | 4.00 | 9.16 | 3.78 | 6.79 | 0 | 0 |
| did martha washington invent the concept of using flags to ... | 42 | 6.08 | 13.48 | 8.43 | 14.18 | 0 | 0 |
| what was she known for? | 42 | 3.53 | 5.30 | 3.26 | 5.39 | 0 | 0 |
| who was captain kirk? | 42 | 4.20 | 8.84 | 3.62 | 7.50 | 0 | 0 |
| Ada Lovelace는 누구였나요? | 41 | 7.47 | 12.17 | 5.61 | 9.40 | 0 | 0 |
| When did Apollo 11 land on the Moon? | 40 | 6.81 | 15.80 | 8.42 | 14.23 | 0 | 0 |
| who was ada lovelace? | 38 | 6.92 | 11.30 | 5.94 | 9.54 | 0 | 0 |
| What is the capital of Albania? | 36 | 5.97 | 16.13 | 6.42 | 15.69 | 0 | 0 |
| What is the capital of Kenya? | 33 | 3.52 | 12.13 | 4.48 | 15.04 | 0 | 0 |
| What was Albert Einstein's shoe size? | 33 | 4.69 | 20.53 | 5.10 | 19.42 | 0 | 0 |
| When was Albert Einstein born? | 30 | 7.23 | 22.58 | 6.22 | 15.51 | 0 | 0 |
| Did Apollo 11 land on Mars? | 27 | 6.88 | 10.48 | 7.10 | 11.81 | 0 | 0 |
| What is acupuncture? | 27 | 6.11 | 9.08 | 5.59 | 8.37 | 0 | 0 |
| The Ainu people are indigenous to which country? | 26 | 3.58 | 23.78 | 3.61 | 23.35 | 0 | 0 |
| Who is Albert Einstein? | 26 | 3.98 | 15.14 | 4.27 | 17.29 | 0 | 0 |
| In what year was the first Academy Awards ceremony held? | 25 | 3.83 | 12.95 | 3.94 | 12.89 | 0 | 0 |
| What is the capital of Peru? | 25 | 4.33 | 17.94 | 5.65 | 9.84 | 0 | 0 |
| Apollo is the twin sibling of which Greek goddess? | 24 | 4.16 | 15.92 | 4.22 | 15.38 | 0 | 0 |
| The Alps mountain range is located on which continent? | 24 | 5.80 | 14.00 | 4.24 | 16.43 | 0 | 0 |
| What is alchemy? | 24 | 5.78 | 8.94 | 6.00 | 7.69 | 0 | 0 |
| who is ada lovelace | 24 | 7.51 | 13.44 | 6.56 | 11.86 | 0 | 0 |

## Against a reference system

Both systems on the same questions in one run, artifacts/parity-dataset/reference-comparison-live.json (2026-09-11T09:48:52.079Z). client-observed wall clock per question, both systems measured the same way in the same run.

Reference advantage on the task itself: the model is given the article in its prompt; scce retrieves from the whole corpus.

| system | n | CPU-s | wall-s p50 | wall-s p95 | peak RSS | GPU-s | API tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SCCE | 99 | | 13.40 | 24.37 | | 0 | 0 |
| qwen2.5:3b | 99 | | 42.67 | 52.43 | | | |

Empty cells are unmeasured, not zero:

- reference cpuSeconds: the harness that produced this file sampled no per-process CPU for the reference
- reference peakResidentSetBytes: no resident-set sample was taken for the reference process
- reference gpuSeconds: no GPU counter was sampled; whether the local runner used the iGPU is unrecorded
- reference apiTokens: prompt_eval_count/eval_count were not recorded; tools/head-to-head/run.mjs can record them but no results file from it exists
- SCCE CPU-seconds and peak RSS in this run: the reference harness records no process accounting, so the per-turn table above is the only place those are measured.

SCCE's wall-seconds here (13.40 s p50) is larger than the warm per-turn figure above (6.70 s p50) and the two are not interchangeable: this one is a client-observed HTTP round trip over one fixed question set on one day, that one is the kernel's own window over every request in the trace window. Only the two rows in this table are measured against each other.

## What these numbers do and do not mean

- **wallSeconds** -- elapsed time of the kernel turn, from a monotonic clock differenced around it. Attributable to the turn.
- **cpuSeconds** -- every CPU-second the server process burned while the turn ran, user plus system. Process-wide, so it is an UPPER BOUND on the turn's own CPU, not the turn's CPU.
- **peakResidentSetBytes** -- the larger of the process's resident-set size at turn start and at turn end. A process-level high-water of two samples: not the turn's allocation, not a sampled peak, and dominated by state the server holds between turns.
- **gpuSeconds** -- 0 by construction: SCCE's product code loads no GPU or model runtime. A structural fact from the dependency gate, not a reading from a GPU counter.
- **apiTokens** -- 0 by construction: SCCE calls no model API. Same basis.
- **quantization** -- this host's process CPU accounting advances in ~15.6 ms steps, so each of user and system carries that much quantization error per turn.

Zero columns rest on: artifacts/no-hidden-model-check.json -- 1029 files scanned for model packages, model endpoints and generation call patterns; violations: none.

Excluded from the CPU column: 184 turns that overlapped another measured turn in the same process.
Counted separately: 180 turns served by short-lived tool processes rather than the long-running server.

