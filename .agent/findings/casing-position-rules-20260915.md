# Casing and word-position rules still reachable from a production turn (2026-09-15)

Read-only inventory at d9b9d31. Totals: 56 reachable casing sites (13 are letterhood tests by case comparison,
11 also decide by position), 12 position-only sites (23 including casing+position), 1 unreachable
(adapters-node language-control-hygiene.ts isWordChar). Code-identifier casing (code-request.ts CAMEL_OR_SNAKE,
CODE_PUNCTUATION; issue-symbol-localization tokenize; oss-corpus splitIdentifierSurface) is a property of the
programming language and is listed separately, not as a violation.

Abbreviations: kpa kernel-answer-primitives, sli surface-linguistics, ae answer-emitter, lev local-evidence-runtime,
lgpr learned-graph-prior-runtime, lmr language-memory-runtime, PTR production-turn-runtime, R server routes.

## Highest risk, decided by casing on the main turn path
| site | decides | reach |
| --- | --- | --- |
| R:1555 sourceSurfaceStrongEnough | two consecutive cased words = strong surface; otherwise REUSE SESSION EVIDENCE | /api/turn R:807. Lowercase chat turns all reuse prior evidence |
| kpa:63 genericQuestionSignal | letterhood by case: uncased-script names are generic; len<=2, repeat>0.72 | ~25 retrieval callers (T18) |
| kpa:115 surfaceEntityRuns + kpa:203 hasPriorAnchorSignal + kpa:110 acronymLikeUnit | entity runs from uppercase words | lev collection names, spanIsAboutAnchor, prose-relation-channel (ingest), translation protectedTermClasses |
| ae:336 private surfaceEntityRuns | name mass, collection/member list signals with many hand-set weights | composeEvidenceGroundedAnswer PTR:3172 |
| lev:1446 sentenceNamesEntityOutsideRequest | non-first cased word = category member | answerCoversRequest, PTR:2317/3172 |
| lev:1111/1128 lowercase/dangling fragment | sentence starting lowercase is a fragment | proposeSourceExactEvidenceAnswer PTR:2317 |
| lev:2981 evidenceAnchorFitForRequest | title-unit position <=2 in request, 0.67 | PTR:1990 source identity admission |
| lev:3243/3252/3301 source anchors | uppercase >=4 chars, sole unit >=5 | PTR:6344 |
| evidence-gist:22/31 | lowercase-initial share = prose, capitalized share = table salad | PTR:2317, mouth speak |
| semantic-obligations:223/942 | [A-Z] runs are entities, [A-Z]{2,} protected terms block | entailment on every turn |
| sli:211 structurallyCompleteSurface, sli:301 sourceDerivedCasingHints | cased sentence opener, casing table from non-first words | mouth speak, creative realization |
| lgpr:2065 priorRequestAnchors, lgpr:978 cognitiveTopicForRequest | cased 3-4 char units, first word kept if it recurs cased | attachLearnedGraphPriorConstruct PTR:4550 |
| PTR:5116 inline | drop first span sentence if it starts lowercase | direct |
| evidence.ts:274 detectSections | ALL-CAPS line is a heading | ingest |

## Position-only
| site | decides | reach |
| --- | --- | --- |
| lev:1120 requestLeadingScaffoldingUnit | first request word <=5 chars is scaffolding | PTR:2640, evidenceForRequest PTR:2290, mouth coverage |
| lev:1299-1308 answerCoversRequest | request's last content unit may be missing | PTR:2317/3172 |
| mouth:7360 mouthCoverageUnits | exclude the request's leading word | speak |
| lev:2049, 2269, 3033, 3460 | request head / title position rules | temporal plans, PTR:1990/2290 |
| lmr:266 | last two words closed-class and unlicensed = reject | creative, speak |
| mouth:5233, 7291; PTR:4814 | first unit skipped / fragment / nominal head | speak, direct |

## Suggested order
1. R:1555 session-evidence reuse (chat correctness; ABBA repeated answers).
2. kpa:63 letterhood (T18; uncased scripts; property test against cased inputs).
3. lev:1120 + mouth:7360 leading-word scaffolding -> corpus closed class (already on the turn).
4. semantic-obligations [A-Z] entities -> corpusNamedRuns.
5. surfaceEntityRuns family, only after a capitals-gate pool_admission vs selected_evidence comparison.
