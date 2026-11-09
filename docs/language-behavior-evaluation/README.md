# SCCE language behavior: measured evidence

Measured November 8, 2026, Pacific time. This is an assessment of SCCE's symbolic/statistical language components and their integration. No neural language model, external inference or LLM benchmark is involved.

**Limited corpus learning and construction realization are demonstrated. Broad English comprehension and useful conversation remain unestablished. A specific request-artifact upgrade gap is confirmed.**

## Scope

The tested core source is `1ac82eac41b5f33b7f58fb1dc485c7a9fa83e2e7`. The available checkpoint contains earlier Dolly/dialogue and Alice material, documentation fixtures, 36 acquired Wikipedia articles and learned structures from only two of those articles. This is a separate database from the Windows candidate reported to have learned 29 articles. These results do not assess a newer Windows executable or database.

Backend: PostgreSQL 18.6 through PGlite 0.5.15; CPU execution. Native PostgreSQL deployment performance is not qualified by this run.

## What works at component level

| Check | Observed result | What it establishes |
| --- | --- | --- |
| Wikipedia n-gram sequence preference | Ordinary word order preferred in 7/8 pairs; one tie | Stored sequence counts contain local English ordering information |
| Dialogue n-gram sequence preference | Ordinary word order preferred in 8/8 pairs | Same limited finding for dialogue training |
| Stored construction hydration | 12/12 selected bundles verified; no rejection | Stored examples and their evidence can reconstruct usable construction records |
| Typed surface realization | 12/12 original source phrases recovered exactly | The realizer can execute the learned slot/literal programs |
| Observed-filler substitution | 12/12 attempts realized; seven outputs absent from their own bundle's examples | The compositor can substitute witnessed fillers; this does not establish grammatical or semantic correctness |

The sequence controls compare an English phrase with a permutation of the same words. Example: `she put the book on the table` versus `table the on book the put she`. The metric is the language runtime's information score; lower is preferred. No training is performed during this comparison. Wikipedia contributes one persisted n-gram structure here. Dialogue has 374 persisted structures; the normal runtime selector chooses 36 for that cohort. These are data structures, not neural models.

The eight pairs are small positive controls, not a representative held-out corpus or a fluency benchmark. We did not establish that every control phrase was absent from all training material.

The construction probe deterministically selects the first 12 Wikipedia source-example patterns by support descending, then ID. It hydrates them with their real evidence, builds typed meaning-slot plans from their stored roles, and calls the production `realizeLearnedSurface` function. It does not ask the chat router to infer those roles.

This reveals a limitation as well as functioning machinery: substitutions include `a net effect`, but also `single particular argue`. Both were accepted by the compositor. The latter is evidence that accepting a slot substitution does not, by itself, validate English grammar. These are short source fragments, not complete-sentence tests. Novelty was checked against each bundle's examples only, not against the entire corpus.

## What the complete input-to-answer path did

Six reading tasks, three instruction tasks, two grammar tasks and four open-ended tasks were fixed before execution. A separate private-fact control checked how uncertainty is expressed. The engine received each prompt, not the accepted answers or grading criteria.

| Category | Tasks | Outcome |
| --- | ---: | --- |
| Active/passive roles, object, negation, pronoun, later state | 6 | Six blank responses |
| Exact copy, reverse word order, select a list item | 3 | Three blank responses |
| Subject/verb agreement and past tense | 2 | Two blank responses |
| Paraphrase, invented definition, question generation, relevant conversation | 4 | Three blank responses; definition task timed out |
| Unknown private fact, assessed separately | 1 | Blank response; internal insufficient-support state; no invented serial number |

**No English task produced a successful user-facing answer: 14 blank responses and one runtime timeout.** Eleven tasks have predefined exact acceptance criteria; all eleven failed those criteria. The timeout does not establish linguistic inability. Blank replies establish a failure of the complete interface under the measured conditions, not the absence of learning in every component.

Examples:

| Prompt | Expected behavior | Actual text |
| --- | --- | --- |
| `Lena thanked Omar after the rehearsal. Who was thanked? Answer with only the name.` | `Omar` | Empty |
| `Reply with exactly these three words and nothing else: amber violet teal` | `amber violet teal` | Empty |
| `Correct this sentence: The two otters swims. Output only the corrected sentence.` | `The two otters swim.` | Empty |

The trace usually reports `content_plan.no_supported_relation` / `no_selected_owner_discriminates_asked_relation`, with `insufficient_support`. That is internal metadata, not a verbal answer. It must not be quoted as though SCCE explained its uncertainty to the user.

## Confirmed request-artifact upgrade gap

The request classifier is not wholly absent from the database:

1. Direct inspection finds 2,048 legacy `scce.request_communicative_act_pattern.v1` records. They have usable class counts and form a classifier when loaded directly with `requestCommunicativeActModelFromPatterns`.
2. All 2,048 pass the configured information-label access predicate. The issue is not this owner's read access.
3. All have no current `componentRecipe` and no record-level evidence links.
4. The actual PostgreSQL adapter, called with the same options as production classifier hydration, returns **zero rows**. Its reader requires the source-owned recipe `kernel.dialogue_request_communicative_act.v2`, evidence links and a published source projection.
5. The live turns consequently report the classifier as `inert_unconfigured`.

Here, **legacy** means old SCCE training-artifact format. The current reader intentionally enforces stronger ownership/provenance requirements. The checkpoint was upgraded sufficiently to pass schema readiness, but not sufficiently to supply a usable current request-classifier artifact. Database row counts hid that distinction.

This is one confirmed integration blocker. It has not been demonstrated to be the sole cause of the comprehension, grammar or realization failures. In particular, source-fragment substitution quality needs its own assessment.

## Method and safeguards

- Prompts and rubrics: `cases.json`, SHA-256 `9e1859556498492d54a0cc71521831e7789151b407cef1d022dcd53f93e0d6f1`.
- None of the 16 full prompt strings occurred verbatim in the checkpoint's stored blobs before the run. This is a narrow contamination check, not proof of globally novel vocabulary or meanings.
- Direct production-kernel turns were used. The schema and active-brain readiness check passed. HTTP/server transport and its dialogue bridge were not tested.
- Web acquisition was disabled; network request allowance was zero. No corpus-training calls or external inference were requested.
- Each case used a new runtime and an outer database transaction that was deliberately rolled back. Before/after application row counts, language-memory revision and active metadata matched.
- Each turn had a 60-second kernel budget and a 65-second abort signal. One task aborted after approximately 67 seconds. Other turns completed in roughly 41–64 seconds. These cold-start PGlite measurements are not native deployment latency claims.
- The main diagnostic disabled functional-cognition capability authorization and dream cycling. Existing synthetic request-requirement bootstrap remained enabled. Those conditions are recorded in the raw report. Component probes are independent of these toggles; request admission was also checked using the original configuration.
- A follow-up repeated the exact-copy task while preserving the original configuration's functional-cognition authorization (`true`). It also returned a blank answer with the classifier `inert_unconfigured`; the database guard passed again. This does not attribute every failure to the same cause.
- Main-run harness revision was frozen in commit `703e0ffadf0fe51a4fff55ccb78e0df813d13a8a`. Later harness changes add explicit offset/configuration controls; the baseline prompts, accepted answers and grading criteria remain unchanged.
- Open-ended blank responses were reviewed against the predefined rubrics. The timeout is marked unassessable, rather than counted as evidence of grammatical inability.

## Repair and next qualification

Rebuild the request classifier from its actual accepted source conversations into the current source-owned format, retain the real evidence ownership, and publish its active source projection. Keep the admission guards. Do not manufacture ownership for the old global records or restore access by weakening provenance checks.

Then rerun the frozen prompts and add separate held-out tests for typed meaning-to-surface generation, interpretation of grammatical contrasts, and role-preserving round trips. Use multiple unseen fillers and sentence structures; merely replaying source fragments cannot establish those properties. Evaluate complete sentences, not just slot-program execution.

A brain should not be declared language-ready from schema migration success, n-gram counts, or successful batch persistence. Its required artifacts must be admitted and its claimed language behaviors must be demonstrated. More Wikipedia ingestion does not, by itself, rebuild this missing request artifact or certify sentence grammar.

## Evidence and reproduction

- [Assessment and rubric review](assessment.json)
- [Every prompt, answer and runtime reason](results.json)
- [Database rollback and prompt-preexistence checks](database-guard.json)
- [Sequence scores and direct classifier inspection](component-results.json)
- [Construction replay and substitution outputs](construction-results.json)
- [Actual production-reader admission check](request-admission.json)
- [Original functional-authorization control](config-control-results.json)
- [Control rollback checks](config-control-database-guard.json)
- [Frozen cases](../../tools/language-behavior-evaluation/cases.json)
- [Runtime harness](../../tools/language-behavior-evaluation/run.mjs)
- [Component probe](../../tools/language-behavior-evaluation/components.mjs)
- [Typed construction probe](../../tools/language-behavior-evaluation/constructions.mjs)

With the matching SCCE build available, the following commands use the existing local configuration. Use fresh output filenames:

```sh
node tools/language-behavior-evaluation/run.mjs --config=scce.config.json --out=language-results.json
node tools/language-behavior-evaluation/components.mjs --config=scce.config.json --out=language-component-results.json
node tools/language-behavior-evaluation/request-admission.mjs scce.config.json request-admission-results.json
```

The runtime harness's successful exit means measurement completed, not that language tasks passed. Inspect the recorded statuses and assessment. The construction probe exports `constructionDiagnostic(client, schema)` for a PostgreSQL-compatible query client and uses a read-only transaction.
