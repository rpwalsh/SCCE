# T22-conversational-construction-source

status: open
claimed_by:

T21 asked whether a withheld chat turn can be given words instead of "". It cannot, today. This is the audit that
settles it and the list of learned artifacts that would change the answer. Measured offline at 75c2cdd with the
sparse-turn chat fixture (`packages/kernel/src/__tests__/chat-session-fixture.ts`): after an evidence-bearing turn,
"fuck off" -> `""`, "thanks" -> `""`, "no thats wrong" -> `"wrong"`.

## What exists, and what is reachable from a production turn

| producer | needs evidence | reachable for a no-evidence dialogue turn |
| --- | --- | --- |
| `semanticLearnedConstructionCandidate` | yes -- certified evidence span ids, a single core fact, a matching bundle | no |
| `semanticReversibleConstructionCandidate` | yes -- same certification boundary | no |
| `semanticAntiUnifiedConstructionCandidate` | yes -- plus `semanticInput.authority === "factual"` and one relation | no |
| `constructAnchoredCandidate` | program/workspace only | no |
| `generatedCandidatesFromFrames` | needs `discoursePlan.units` and realization frames from the plan | reached only when Mouth is |
| `conversationMemoryCandidate` | **no** -- generates from language memory with zero evidence | **no, for two reasons** |
| `clarificationCandidate` | yes -- facts carrying `evidenceIds` | no |
| `supportBoundaryCandidate` | verdict must be `contradicted` or `source_bound_only` | no |
| dialogue-pragmatics `realizeDialogueResponse` | every surface is cut from `answerGraph.claims` / `supportLinks` / `caveats` / `actions` | words, but none without claims |
| `construction-grammar-selection.ts` | training-time MDL over paired constructions | **unreachable from a turn** -- callers are `language-training-batch.ts` -> `ingestion-runtime.ts` / `training-runtime.ts` only |
| `responseForm` / `ActivatedResponseForm` | produced by `selectResponseForm` (`turn-requirements.ts`) | consumed ONLY as `surfaceLayout.sentencesPerBlock` -> `responseSentenceBudget` and as two trace fields. **No realizer reads it.** |

`conversationMemoryCandidate` (`mouth.ts`) is the only producer in the system that realizes from language memory
alone. It is unreachable for this case twice over:

1. `createMouth.speak` (`mouth.ts:636`) hands the whole turn to `createDeterministicMouth` whenever the selected
   candidate is a terminal non-assertive runtime-motion candidate -- which is exactly what a no-evidence dialogue
   turn selects. Instrumented: on the three sparse turns the learned Mouth's candidate assembly is **never entered**.
2. Even when entered, its own gate `verdict === "unknown" || verdict === "underdetermined"` returns `undefined`,
   and a zero-evidence turn is always one of those.

The deterministic Mouth is not a realizer. On those turns it holds exactly one surface: the runtime-motion
candidate's `answer`, built by `runtimeMotionFocusSurface(requestText, unresolvedSlots, focusAnchors)` -- a span cut
out of the request. `"fuck"`, `"thanks"`, `"wrong"`. Two of the three are then emptied downstream as prompt echo.

## Why the gate must not simply be opened

Opening (1) and (2) re-opens the fabrication defect the gate was written for: with no evidence, learned generation
would answer "What is the boiling point of tungsten?" with prose sampled from whatever corpus is resident. The only
thing that separates "thanks" (a conversational move that deserves a learned conversational surface) from an
unanswerable factual question (which must withhold) is the request's communicative act.

`classifyRequestCommunicativeAct` (`request-communicative-act.ts`) is wired and called every turn
(`production-turn-runtime.ts:1282`) and returns `inert_unconfigured`, because nothing ever writes the
`language_patterns` rows it hydrates from -- `compileRequestCommunicativeActModel` and
`requestCommunicativeActPatterns` have **no production callers**. That status now travels on the result and appears
in the typed withholding record, so the inert classifier can no longer be mistaken for a working one.

## What the owner must supply for the turn to speak instead

Three artifacts, in this order. None is a code change alone.

1. **A request-act model.** Corpus: owner turns joined to their outcomes by episode id -- `conversation_turns`
   (owner `text`) joined to `conversation_outcome_records` (`turn_id = episodeId`), which is the join T17a already
   specifies and which nothing performs. Training call: `compileRequestCommunicativeActModel(observations)` then
   `requestCommunicativeActPatterns(model)`, persisted as `language_patterns` rows with
   `pattern_json->>'sourceSystem' = 'request_communicative_act'`. Promotion: the loader reads the newest group by
   `updatedAt`. Gate before claiming it works: **count how many accepted outcomes carry an owner surface at all.**
   The act inventory is also too small -- it is ambiguous/challenge/repair/neutral, and greeting, thanks and
   rejection are not acts in it, so the inventory has to grow with the corpus that supports it.
2. **A conversational corpus for the language memory.** Every resident n-gram model is encyclopedic prose. A
   conversational lane generating from that corpus produces article sentences whatever the act says. Needed: an
   ingested corpus of dialogue turns, trained via the existing `trainKneserNey` / language-memory path, and
   promoted into a profile that the turn's role hydration will actually select for a dialogue-role request.
3. **Conversational construction bundles.** `construction-grammar-selection.ts` already selects paired
   anti-unified constructions by description length at training time, and Mouth already consumes the bundles it
   produces (`languageMemory.importedConstructionBundles`) -- but only through the three evidence-certified
   candidate producers. A conversational bundle needs a binding that is not a `fact.relationId`, which is a real
   design question, not a wiring one: what does a construction for a dialogue move bind to?

Only after 1 and 2 does opening the two gates in `mouth.ts` become a measurement rather than a gamble. The
measurement to run then: with a trained conversational corpus resident, does `conversationMemoryCandidate` return an
admissible surface for "thanks", and does an unanswerable factual question still withhold?

## What shipped instead (T21 closed, this task opened)

The turn now reports `TurnResult.withheld` -- `scce.runtime.withheld_surface.v1` -- carrying a typed reason id, the
answer basis reason ids, the truth state, the evidence count, the entailment verdict, the unresolved requirement
ids the judge-selected candidate missed, the turn's learning needs, and the status of every component that would
have had to speak. The server's 422 carries that record as `detail`, so a surface renders its own message from a
reason id and the kernel never holds a reply string.
