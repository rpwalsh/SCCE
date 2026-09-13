# T5 — What is actually inside `language.hydrate`, and what the turn reads back

Measured from `C:/Users/react/fuggit/.scce/traces/*.jsonl` (290 files, 114 MB). **942 `language.hydrate.start`
events, 779 complete episodes** (start + all parts + `loaded` + `built`). Read-only; no production code changed,
no server touched, no SQL run. Consumption traced statically in `packages/kernel/src`.

Hydration is not one thing. It is **two serial database phases, a parallel fan-out, and a CPU build**, and the
serial phase that dominates it is serial only because of a query that returns nothing.

## Decomposition (mean per hydration, n=779; p50 / p90 in ms where useful)

| # | class | call | position | mean ms | share | rows p50/mean | JSON MB mean | consumed by the turn? |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | **n-gram models** | `listNgramModels` | **SERIAL, blocks 2-6** | **17,278** (p50 12,822, p90 31,020) | **58.7%** | 5 / 5.5 | **34.8** | **YES** — `state.models` gates `roleLanguageSpeaks` (turn 2431) and `deriveClosedClassWords` (3974); raw `.models` → `surfaceLanguageModels` → `composeEvidenceGroundedAnswer` (2538, 2640) |
| 2 | n-gram observations | `listNgramObservations` | parallel, gated on #1 | 7.6 (ran in 48/779) | 0.03% | **0 / 0** | **0.0** | **NO — returned 0 rows in 48 of 48 executions** |
| 3 | language units | `listLanguageUnits` | parallel | 2,416 (p90 4,853) | 8.2% | 1,536 / 2,971 | 6.8 | **partly** — importer slices to 4,096; mean 2,093 survive (30% discarded, ~50% at p90). Readers: `generationPieces` (generative mouth), `competenceFromRuntime`, `uniqueUnitVocabularySize` |
| 4 | **language patterns** | `listLanguagePatterns` | parallel — **the parallel block's critical path** | **6,959** (p50 2,692, p90 19,131, max 232,525) | **23.6%** | 707 / 681 | 20.7 | **YES** — `state.importedPatterns` (turn 2549-2553), construction bundles. 681 loaded → 434 imported |
| 5 | semantic frames | `listSemanticFrames` | parallel | 1,466 (p90 3,610) | 5.0% | 768 / 1,725 | 7.0 | **partly** — importer slices to 2,048; p90 loads 6,144, so **two thirds are discarded before any reader**. Readers: `generationPieces`, `answer-realization.ts:69` (ids into a trace) |
| 6 | persisted language profiles | `listLanguageProfiles` | parallel | not separately traced | — | 512 | — | **YES** — `roleProfiles` → `surfaceProfile` (turn 3799) |
| 7 | **segmentation populations** | `segmentationPopulations.listRecent` | parallel | not separately traced | — | — | — | **NO — zero readers.** Only occurrences of `segmentationPopulationModels` in the whole repo are the three inside `surface-language-runtime.ts` itself (352/397/517), the `never[]` stub in `evaluation-runtime-bypass.ts`, and one unit test |
| 8 | construction evidence | `evidence.getEvidenceBatch` | SERIAL after 2-7 | 240 (with dedupe) | 0.8% | 74 / 113 | 6.1 | **YES** — `importedConstructionBundles` / `importedReversibleConstructions` (turn 3890) |
| 9 | brain import head | `brainImports.active()` | SERIAL pre-flight | before `start`, untraced | — | — | — | YES — `importRunId` |
| 10 | request-control patterns | `listLanguagePatterns({sourceSystem:"corrections", limit:2048})` | SERIAL pre-flight | before `start`, untraced | — | — | — | **split**: the compatibility subset is merged into #4 internally (**used**); the returned `requestControlPatterns` field has **no production reader** (only the `never[]` stub) |
| 11 | `hydrateFromImportedBrain` | CPU, no I/O | serial | **4,439** (p90 8,825) | **15.1%** | — | — | YES — produces `state`, the only thing the turn really consumes |
| | **total to `built`** | | | **29,441** (p50 31,068) | 100% | | **~75 MB JSON** | |

Parts 2-5 run concurrently, so the wall clock is `#1 + max(#2..#5) + #8 + #11` ≈ 17.3 + 7.0 + 0.24 + 4.4 ≈ 28.9 s,
which matches the measured 29.4 s mean. **Do not add the part columns.**

Cache behaviour, from 6,943 `language.cache.lookup` events: `hit-language` 5,420, `hit-exact` 77,
`hit-superset` 24, **`miss-durable` 1,158 (16.7% pay the full cost)**, `miss-resident` 264. T12's in-turn figure
(145 invocations, 16.15 s each, 26.4% of turn wall) is the subset of these misses that landed inside a
`turn.input`→`turn.output` window; the remaining ~634 episodes are warmup and off-path prefetch.

## What is loaded and never read

1. **`listNgramObservations` — 0 rows, 48 of 48 executions.** Its guard comment says observations are read only for
   a scope with no persisted model. Measured, that scope never occurs: every time the guard let the query run, it
   came back empty. This is not merely free — see below, it is the reason #1 is serial.
2. **`segmentationPopulations.listRecent` → `segmentationPopulationModels`.** Loaded, returned, cached, and read by
   nothing in production. Its cost is unmeasured because it emits no `part` event, which is itself the finding:
   a class nobody reads is also a class nobody instrumented.
3. **The returned `requestControlPatterns` field.** The query is needed (its compatibility subset joins #4), but
   the `learnedRequestControlPatterns` array handed back to the caller has no reader.
4. **Diagnostic-only reads.** `surfaceLanguage.patterns.length`, `.units.length`, `.semanticFrames.length`
   (production-turn-runtime 2568-2570) are counters in a trace event. Per the mission, that is diagnostics, not
   cognition — they are not evidence that the raw arrays are consumed. **The turn reads exactly four things off the
   hydration result: `.state`, `.models`, `.surfaceProfile`, and three `.length`s.** `.observations`,
   `.constructionEvidence`, `.segmentationPopulationModels`, `.corpusPlan`, `.clusterMembers` and
   `.requestControlPatterns` are never read as arrays by any turn code; where they matter they matter only through
   `.state`, which #11 already built.

## Ranked deferral candidates

**D1. Delete `listNgramObservations` and its gate; move `listNgramModels` into the same `Promise.all`. (~7.0 s,
24% of hydration, expected zero semantic change.)** This is the whole finding. `listNgramModels` is awaited
*alone* — not for its own sake, but to compute `persistedModelsPresent`, which exists only to decide whether to run
query #2. Measured, #2 is always empty, so the gate's single observed outcome is "skip a no-op". Removing it lets
models overlap the parallel block: the load phase becomes `max(17.3, 7.0)` instead of `17.3 + 7.0`.
Cost if deferred: none — no class is dropped, only a serialization.

**D2. Drop `segmentationPopulations.listRecent`. (Unknown but non-zero; one fewer table in the fan-out.)**
Cost if deferred: nothing measurable can be lost, because nothing reads it. Instrument it first if a number is
wanted — it is currently invisible.

**D3. Push the importer's own caps into the SQL `LIMIT` for units and frames. (Part of #3+#5's 3.9 s, plus a share
of #11's 4.4 s build and ~14 MB of JSON.)** `hydrateFromImportedBrain` slices units to 4,096 and frames to 2,048
*after* loading. At p90 the query returns 8,192 units and 6,144 frames — **the transport, the parse and the sort
are paid for records the importer then throws away.** This is the highest-risk item on the list and must not be
done blind; see verification.

**D4. Do not defer #4 (patterns) or #1 (models) themselves.** Both are consumed. #4's tail is where the pain is
(p50 2.7 s, p90 19.1 s, max 232 s) — that is a query-plan or byte-budget question, not a deferral question, and it
belongs to a different task.

**D5. Stop returning `observations`, `segmentationPopulationModels` and `requestControlPatterns` from the
hydration value.** Not a speed change; it shrinks the cached entry and removes three fields that a future reader
would reasonably assume are live. An inert field must not look active.

## What an implementer must verify (acceptance is semantic equivalence, not speed)

1. **`state.models` id-set and length identical.** It gates `roleLanguageSpeaks` (2431) and the closed-class
   derivation (3974-3975). A shorter model list silently changes admission.
2. **`language.hydrate.built` counters identical per `languageId`**: `importedUnits`, `importedPatterns`,
   `constructionBundles`, `rejectedBundles`. These are already in the trace, so the before/after is free. Current
   means: 2,092.6 / 433.7 / 39.4 / 7.8.
3. **For D3 only — the SQL `ORDER BY` must be the exact key the importer slices on.** The importer sorts units by
   `alpha` desc then `text` then `id` codepoint, and frames by `alpha` desc then `id`. If the adapter's ordering
   differs, a pushed-down `LIMIT` keeps a *different* 4,096 records and the answer can change while every count
   stays the same. **This is the one deferral in the list that can break semantics without breaking a counter.**
   Verify by hashing the ordered id list of `importedUnits`/`importedSemanticFrames` before and after.
4. **`constructionEvidenceIds` unchanged** — it is derived from the imported patterns, so a pattern change
   propagates into #8.
5. **Gates**: `node tools/capitals-probe.mjs` 7/7 and `node tools/conversation-probe.mjs` with no regressing turn,
   run against a warm server by the integrator. Wall-clock alone is a FAIL per Phase 2.
6. **Expect the trace counters at production-turn-runtime 2568-2570 to change** under D3. They are diagnostics, so
   that is not a semantic regression — but it does mean those three numbers stop being comparable across the
   change, and a reviewer must not read the drop as lost cognition.

## Honest limits

- 779 episodes from whatever traffic wrote these files; not a controlled distribution. p90/max on #4 shows the tail
  is real but its cause is not measured here.
- #6, #7, #9 and #10 emit no `part` event, so their cost is folded into the parallel block and is **not separately
  measurable from the current trace**. D2's saving is therefore stated as "unknown, non-zero", not as a number.
- "Never read" is a static conclusion over `packages/kernel/src` and `packages/server/src`, by field name. It is
  strong for `segmentationPopulationModels` (five total occurrences repo-wide, all accounted for) and for
  `.observations` off this value; a dynamic read through an index or spread would not be caught by it.
- The 0-rows result for #2 is sound for the 48 executions traced. It does not prove the observation path is dead in
  principle — it proves the guard has never once selected a scope that had any.
- No before/after uncertainty pair exists anywhere in hydration, so T12's "0 bits" stands: this is 26% of turn wall
  whose information contribution remains unmeasured, not measured-as-zero.
