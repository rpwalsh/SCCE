# SCCE ingestion-to-runtime build plan

Status: frozen implementation contract. Translation scope is fixed below:
English <-> German and English <-> Latin are mandatory in both directions.
No Wikipedia ingestion into `scce6_runtime` has started. Existing scce5 records
are audit material.
Implementation has started. Parser/source-preservation regressions, the real
300-page parser audit, and Postgres page/trainer rollback checks pass in disposable
storage. Full dump/index hashes are verified. Factory-identified candidate-to-graph
bindings and a bounded graph/requirement/graph refinement are implemented; focused
runtime/ablation regressions and the build pass. Full-suite results are recorded in
`INGESTION_RECOVERY_AUDIT.md`. Publication
qualification, canonical interrupted-build equivalence and learned-speech
acceptance remain unfinished; new Wikipedia candidates stay in VALIDATING.

## Deliverable and boundaries

Deliver one reproducible brain snapshot, with an immutable corpus manifest,
source evidence, trained artifacts, evaluation and calibration records,
activation manifest, and a real-server test report. Report measured build
time, resource use, answer quality and known capability limits. The delivered
conversational test brain must demonstrably speak English using language
learned from the selected Wikipedia corpus. Storage integrity and completed
training jobs alone do not qualify it.

The final scope is Wikipedia, then OSS code and Project Gutenberg, plus the
multilingual monolingual/aligned corpora required below, through the same
ingestion/training/calibration contracts. Final acceptance additionally
requires a reproducible win against a pinned Qwen baseline in every declared
task domain. Chat, creative writing, coding and truthful corpus-grounded
answering are mandatory domains and cannot be removed because a build fails
them. This is a release requirement to demonstrate, not an achieved result
or a guarantee of superiority on every possible future prompt.

The capability inventory also includes the existing reasoned, translation
and action authorities, durable dialogue/task state, runtime acquisition and
learning from observed outcomes. Each requires explicit qualification below;
being present in the code is not proof that it works. The same published brain
must perform the qualified tasks and transitions through the existing runtime.

Performance is a first-class acceptance target: move full-build completion
from days toward hours on this machine while preserving capabilities, evidence,
calibration and recovery, with bounded CPU, RAM, database and disk demand.
This is a target to measure, not a promised speedup. Include all required work
through a qualified, restartable server, not just the source-reading phase.

### Mandatory learned-speech gate

Run this gate as soon as a bounded trained build can be loaded by the real
server, repeat it after restart, and preserve it through every optimization:

- Ask unseen question formulations about facts supported by the ingested
  corpus. Require understandable, grammatical, relevant answers.
- Hold factual support, intent, temporal scope and conversational context
  fixed while varying unseen question phrasing. Require materially equivalent
  supported answer content; different surface wording is acceptable. Score
  claim/slot coverage and unsupported additions, not identical answer strings.
  Failure on paraphrases blocks qualification even if a familiar wording works.
- Require composed answers using learned constructions and supported facts,
  plus follow-up questions that test referent and conversational continuity.
  Returning article excerpts alone does not demonstrate learned realization.
- Include insufficient-evidence cases: the planner must withhold unsupported
  assertions, and the learned mouth must express the resulting decision.
- Trace the actual path from Wikipedia source versions to training outputs,
  loaded language artifacts, selected content/slot plan and realized answer.
  Rule out canned response templates, hidden external-model generation and
  serving stored answer strings as substitutes for this path.
- Use a controlled ablation of Wikipedia-trained language artifacts to test
  their causal contribution. Restore the same snapshot afterward.
- Freeze the final question set and scoring criteria outside training and
  calibration. Record content accuracy, grammar/comprehensibility, coherence,
  supported-answer coverage and trace validity; model counts are not scores.

A build failing this gate is an ingestion/training diagnostic fixture, not
the conversational brain promised for testing. Diagnose source coverage,
learner output, persistence, hydration, planning and realization before
assuming that more articles will solve the failure. Extend training data
when measurements show inadequate coverage. The article count never waives
the speech requirement.

Keep one Postgres store and the existing kernel, import/training, proof and
mouth paths. Runtime CPU workers, if measured to help, are bounded by the
actual machine's resources.

Freeze the yopp full-English-Wikipedia dump and matching index as input;
record file identity, page/revision identity, normalization version, code
revision, configuration, seed and training partitions. Cache verified
identities and detect source changes rather than rehashing 26 GB on every
restart. Do not reuse an old cursor for changed input or normalization.

Add immutable corpus manifests for OSS repositories and Gutenberg books.
Pin repository URLs/commit IDs, file hashes, languages, declared licenses and
fork lineage; pin book IDs, editions/translations, author/source provenance
and text hashes. Inventory existing local material before acquisition. Keep
raw code/books and analyzed derivatives distinct. Preserve chapter/dialogue
structure for books and syntax/symbol/dependency structure for code. Track
duplicate editions, mirrors and forks so they do not create independent votes.

### Multilingual corpus acquisition and identity

Acquire both native-language text for linguistic induction and genuine
parallel/aligned material for the fixed translation pairs. Wikipedia interlanguage
links, matching book titles and shared topics identify comparable material;
they do not establish sentence-level translation equivalence by themselves.
Inventory local material first. The inspected `yopp/data` directory currently
contains only `wiki`; this is not a machine-wide claim about corpus availability.

Initial acquisition candidates, checked against their providers' documentation:

The user also authorizes Bible translations and multilingual Wikipedia as
corpus sources. Pin editions, translation lineage and verse/section identifiers;
verify versification and omissions before pairing Bible passages. Keep translated
versions within their source family and holdout partition. Wikipedia language
editions retain their own dump/revision identities and require verified alignment.

| Purpose | Candidate and admission requirement |
| --- | --- |
| English/German parallel training | [Europarl v7](https://www.statmt.org/europarl/) supplies German-English sentence pairs and a source release with document metadata. Preserve/reconstruct document identity for holdouts; retain known benchmark exclusions and audit alignment/noise. Add separately identified prose domains before claiming broad translation quality. |
| Esperanto diagnostic and Latin/German supplemental sentence pairs | [Tatoeba exports](https://tatoeba.org/en/downloads) provide sentence IDs, language, translation links and original/translation metadata. Extract directly linked pairs, deduplicate reciprocal links and retain attribution/review metadata. Count and inspect eligible pairs before assuming adequate supervision. |
| Latin texts and matching English editions | [Perseus canonical Latin literature](https://github.com/PerseusDL/canonical-latinLit) provides versionable XML texts and translations. Check each edition's language, citation structure and terms; its metadata is explicitly work in progress. Matching passages require verified alignment, not file-order pairing. |

These are acquisition candidates, not downloaded, qualified or sufficient
corpora. Pin exact releases/commits, URLs, file hashes, source licenses and
attribution before importing. Preserve original text/XML, derived surfaces,
work/edition/translator IDs, language, register/period where known, script,
orthography and normalization version. Parallel records bind both source
versions, both evidence spans, segment IDs and the origin/quality of alignment.
Source-provided links are observations to validate; induced alignments remain
learned candidates. Qwen output cannot supply training translations or labels.

Partition whole works, editions, translation families and connected translation
clusters across fit/calibration/final test before creating sentence shards.
Keep both directions of a pair and mirrored copies in the same partition.
Translations of one work do not become independent factual witnesses. Record
accepted/rejected pairs, unique works/families, tokens per language, coverage,
alignment quality and missing supervision. Preserve case, diacritics and
meaning-bearing distinctions in originals; any normalization has a traced
derivative. Stream and checkpoint acquisition/preprocessing under the same
resource budgets; include multilingual stages in the total-build forecast.

## 1. Source correctness and a reproducible baseline

- Finish parsing repairs: nested links/images, quantities carried by
  templates, entities, malformed markup, large-page and Unicode boundaries.
- Preserve original wikitext separately from normalized evidence with the
  existing source-derivative contract. Record unsupported templates and
  clipping. Never present partial expansion as a lossless MediaWiki render.
- Test Bonn's missing quantity and Albedo's leaked image caption using
  captured real input. Test offsets, hashes, provenance and reconstruction.
- Trace source-family identity through real ingestion, relation candidates,
  alignment and promotion. Ten Wikipedia articles must retain the declared
  Wikipedia dependency family; replays and derivatives cannot create votes.
- Measure the current stages on a fixed, representative sample. Audit the
  four outstanding full-suite failures before changing expectations.

Gate: exact source/derivative bytes and evidence coordinates pass; known
parser regressions pass; unsupported coverage is visible; unrelated test
failures are resolved or explicitly established as remaining blockers.

Relevant boundaries: `wikipedia.ts`, `wikipedia-markup.ts`,
`wikipedia-v3-ingestor.ts`, `typed-ingest.ts`, `source-family.ts` and their tests.

## 2. One artifact and authority contract

Reuse the types and routing already present in storage, learning updates,
hydration and runtime memory. Define a shared artifact header containing:

`kind, forceClass, producer, input IDs/hashes, compiler/configuration IDs,
normalization version, dependency families, information label, payload hash,
evaluation references, artifact version`.

The registry derives the destination from the artifact kind and validates
the producer and allowed force class. Producers cannot select arbitrary
stores or promote their own authority by changing JSON metadata.

Authoritative write invariant: no production path may write a canonical
learned artifact directly to its backing store except through the artifact
registry/committer. This includes corpus training, imports and online learning.
Low-level store methods remain implementation details of that boundary.

### Registry scope: learned artifacts versus other durable records

A canonical learned artifact is a durable candidate or qualified model,
statistical state or induced structure intended to affect cognition across
episodes independently of its producing episode. Its authority and reuse are
governed by the registry even before it becomes eligible for runtime use.
Examples include language models/constructions, learned relation/role priors,
alignment models, promoted learned graph structure, program priors, learned
selection policies and fitted calibration models. User-specific or
conversation-scoped models are included when they serve this learned role.

The following records are not canonical learned artifacts merely because
they are durable or can be read by a later turn:

| Record class | Existing write/authority contract to preserve |
| --- | --- |
| Immutable source observations, evidence and direct provenance topology | Source/ingest validation, identity, information labels and evidence transactions. |
| Audit/events, evaluation records and execution receipts | Their typed recorder/evaluator contracts and actual observed provenance. |
| Leases, work-item state and checkpoints | Queue/recovery transactions and stage-completion invariants. |
| Conversation/task state, resumable snapshots and working memory | Existing episode/state ownership, isolation and persistence contracts. |
| Transient caches | Derived, version-bound copies of authoritative state, never independent canonical learned state. |

These exclusions do not waive atomicity, identity or authority checks and do
not route every operational update through learned-artifact qualification.
Classification follows the payload's semantic role, not its table name or
JSON wrapper. A learned policy embedded in an event or task snapshot remains
a learned artifact; source facts remain evidence when reused across episodes.
If observations or receipts are aggregated into a reusable model, the resulting
model crosses the learned-artifact committer even though its inputs do not.

Before enforcing the boundary, inventory existing durable write entry points
and explicitly register each kind's classification, producer, allowed force,
store, consumers and owning write contract. Use a closed, versioned mapping;
unknown kinds fail validation rather than gaining an implicit exemption.
Tests must cover both rejected learned-artifact bypasses and permitted ordinary
dialogue, task, lease, source and receipt writes. Shared transactions may still
commit learned artifacts together with their events and completion records.

| Owner | Permitted assertion |
| --- | --- |
| Ingestor | This source and observation were recorded. |
| Trainer | These inputs produced this candidate model. |
| Calibrator | These measured outcomes support this score mapping. |
| Evaluator | This version passed these recorded checks. |
| Promoter | This evaluated artifact may be used with this force class. |
| Proof | This claim has admissible source evidence. |
| Runtime | Execute against this active, compatible artifact set. |
| Outcome recorder | This result followed this traced execution. |

Gate: invalid producer/kind/force combinations are rejected. Language and
concept priors cannot certify facts; tenant/information labels survive
every transition. Architecture tests reject production paths that bypass the
committer. These are logical boundaries, not mandatory new services.

Artifact qualification and publication have explicit states:

`CANDIDATE -> EVALUATED_PASS -> QUALIFIED -> STAGED -> ACTIVE -> SUPERSEDED`.

`INVALIDATED` blocks activation or reuse until a replacement version earns
qualification. A qualified artifact can belong to an unpublished brain;
qualification alone never makes it visible to runtime. Publication state is
scoped to the artifact's brain-manifest membership so shared immutable
artifacts can participate in multiple snapshots. Map these records to the
existing brain lifecycle rather than treating them as the same state machine.

### Source, graph and realization bindings

The two later graph-interface notes add these requirements to the same lane:

- Preserve exact source/version/evidence -> observation -> semantic candidate
  -> graph projection links at production time. Include only observation IDs
  actually consumed by that candidate; missing ancestry is explicit, not inferred
  from all observations on the page. Shared participants and merged hyperedges
  must retain each occurrence's provenance without creating independent votes.
- Keep all four existing semantic channels and their admission rules. A named
  policy must preserve the current source-declared zero-arity exception; source
  declaration alone does not authorize arbitrary semantic projection. Weak prose
  remains candidate material until the existing promotion checks pass.
- Persist promotion inputs, source families, decisions and evaluation references
  through the learned-artifact committer. Distinguish occurrence IDs from reusable
  relation/role identities. Derive roles from the existing primitives and opaque
  role model; the notes' example English relation names are not an ontology.
- Bind qualified semantic frames and constructions to their actual relation,
  hyperedge, role/port, language-population and evidence IDs. Reuse the sparse
  alignment target index for both directions. Runtime realization resolves forms
  for the selected relation; importing a frame does not make it relevant to every
  answer. The mouth still cannot select facts or repair missing proof.
- Summarize evidenced graph structure after retrieval/activation: observed
  participant joins, actual temporal validity, source-family diversity and the
  existing causal/contradiction channels. Count a hyperedge and its incidence
  projection once. Volume diagnostics do not establish semantic support.
- Add one bounded structural refinement of the requirement field. Its closed
  dimension mask and contribution bounds must preserve explicit request intent,
  prohibitions and authority. Graph size cannot create creative or action intent.
  Keep structural applicability, learned estimates and calibrated scores distinct.
- The subsequent implementation instruction fixes the alternation at two graph
  activations: initial requirements -> first activation -> one refinement ->
  second activation with conditioned seeds -> operators/proposals. Reuse the
  current field engine and bounded slice; do not iterate to convergence or add
  another runtime lane. Use the ID factory for new artifact and trace identities.
  `no_graph_sandwich_refinement` preserves the first pass and bypasses both the
  refinement and the second pass. Measure requirement, seed/field, operator,
  proposal and latency deltas; do not call this paper-validated or quality-proven
  before the corresponding experiments have actually run.
- Record graph, frame and construction IDs that actually contributed to operator,
  proposal, proof and realization decisions. Measure runtime usefulness from real
  traces; absence of use alone never authorizes deleting evidence or topology.

Qualification requires unseen request -> learned frame/requirement -> graph seed
-> admitted relation -> changed proposal selection -> bound learned construction
-> answer, after restart as well. Independently ablate graph activation and the
graph/frame alignment, preserve evidence and request intent, measure degradation,
and restore the same snapshot. An index, a stored binding or an isolated unit test
does not satisfy this causal runtime gate. Index/materialized-adjacency speedups
must preserve these identities and be measured on the real bounded retrieval path.

## 3. Durable work, recovery and short commits

- Seal immutable training manifests referencing source/evidence versions
  before source progress advances beyond recoverable learning input.
- Track source, training and derived-learning watermarks separately.
- Persist dependencies and stage states, with attempts, leases and recovery
  of abandoned work. A bounded queue supplies explicit backpressure.
- An upstream identity change invalidates its transitive descendants for
  the replacement build, unless the compiler contract explicitly proves
  independence from the changed field. Traverse persisted dependency edges,
  queue affected work and block stale descendants from qualification or
  publication within that build. This is replacement-build staleness: creating,
  failing or abandoning a newer build never revokes the currently active
  immutable snapshot or marks its pinned old inputs stale. Scope dependency
  traversal and staleness to the candidate build even when artifacts are shared.
- Integrity revocation is a separate explicit operation for an already-published
  artifact whose integrity or admissibility has failed. Record its reason and
  evidence, identify every dependent published snapshot and make affected
  snapshots unavailable without rewriting their immutable contents. A newer
  source/corpus version alone is not such a revocation. Preserve unrelated
  branches and unaffected snapshots. Test that creating/recomputing/aborting
  candidate B leaves active A's manifest, availability and behavior unchanged
  until explicit activation, while a genuine revocation blocks all and only
  the dependent snapshots.
- Compute outside write transactions. Validate the expected input versions
  and atomically commit outputs, statistics deltas, events and completion.
- Deduplicate additive observations/statistics by semantic occurrence and
  stage contribution. Content-addressed IDs alone are not sufficient.
- Pin canonical training partitions where algorithms are batch-sensitive.
  Prove merge equivalence before changing them. Scheduling never changes
  source identity or source independence.

Gate: forced termination before/after every commit boundary, duplicate input,
retry, changed input and expired leases produce the expected durable state.
For fixed inputs/compiler/configuration, uninterrupted and resumed builds
have matching semantic outputs, counts, manifests and evaluation results.
Define this equivalence by machine comparison of canonical, sorted records:

- the same canonical artifact IDs and payload hashes;
- the same artifact kinds, force classes and information labels;
- the same dependency edges and compiler/configuration bindings;
- the same evaluation dispositions and evaluation-artifact hashes;
- the same calibration input identities, partition assignments and model hashes;
- the same active manifest hash, including the pinned calibration model set.

Matching counts alone does not pass. Only execution metadata explicitly
excluded by the versioned canonicalization contract, such as attempt logs
and execution timestamps, may differ. Source/event times and validity
intervals remain semantic data and cannot be discarded to force a match.

## 4. Explicit training, evaluation and promotion stages

Refactor the existing shard procedure into typed stages rather than adding
a second training implementation:

`observations -> language/relation candidates -> evaluations -> promoted
relation graph -> alignment candidates/evaluations -> constructions and
cycle tests -> qualified artifacts`.

Record raw relation observations before learned decisions derived from them.
Promotion decision and canonical graph admission must commit together.
Persist canonical alignment-series state instead of reconstructing operational
state from the latest 1,024 audit events. Add actual input/output hashes and
compiler/configuration versions to replay validation; counts are not hashes.

Preserve the distinction between evidence/provenance graph topology and
semantic graph projection. Quantify overlap before removing either producer.
Measure both alignment passes separately and compare their dependencies and
outputs before sharing or eliminating work.

Gate: a failed stage leaves downstream artifacts unavailable. Failed replay
validation blocks promotion. Zero eligible candidates is a recorded valid
outcome, not a fabricated success or an instruction to relax promotion rules.

## 5. Calibration and capability qualification

Use stable fit/calibration/final-test partitions, with document or dependency
family separation appropriate to the learner. Record raw scores, features,
model versions, trace IDs and independently observed labels/outcomes.
Do not train calibration against its own predictions or tune on the final test.
Split OSS by repository/fork lineage and books by work/edition lineage where
required; adjacent snippets or copies of the same work do not make independent
holdouts. Requalify earlier Wikipedia speech and factual behavior after adding
OSS and Gutenberg so the combined corpus cannot silently regress them.

Check language held-out loss, surface/graph recovery, unsupported additions,
contradictions, proof accuracy, abstention and coverage. Check calibration
with log loss, Brier score, reliability curves and sample counts. Freeze
acceptance tolerances before evaluating the candidate snapshot.

Wikipedia's declared single dependency family cannot supply independent
corroboration by being split into pages. Gates needing additional independent
sources remain unmet until suitable sources are available; the system may
still answer source-qualified questions using admissible direct evidence.

Gate: every enabled learned capability has its required evaluation and
calibration status. Missing supervision stays explicit; no synthetic
"calibrated" marker replaces measured outcomes. Learned English realization
is required for this deliverable and cannot be marked optional or inapplicable.

### Runtime-consumer compatibility

Audit the existing `production-turn-runtime.ts`, `request-authority.ts`,
dialogue/task stores, program runtime, creative generation, translation,
capability dispatcher and calibration/outcome machinery. Reuse their contracts;
do not introduce a second router, conversation store, story engine or trainer.
The existing authorities are `factual`, `reasoned`, `creative`, `translation`,
`program` and `action`. Conversation is persistent context across authorities,
not a new authority enum. Authority projection informs the existing candidate
and judge path; it must not become an invented hard partition of candidates.

For every required artifact family, record and test:

`producer -> durable kind/store -> force/corpus role -> active manifest ->
hydration/read query -> consuming subsystem -> real-turn use`.

Bind each authority's entry conditions, operator IDs, required artifacts,
calibrators, stores, allowed force classes, proof obligations, completion
persistence and outcome-learning path. Trace the actual consumed IDs and
decisions; use controlled ablations where needed to show causal contribution.
Artifacts that cannot reach their production consumer fail this gate even
when their rows and hashes are valid. An identity fallback is not learned use.

Consumer traces distinguish actual participation using these labels:

| Label | Required evidence |
| --- | --- |
| `hydrated` | The named version was loaded or made accessible to the consumer. |
| `eligible` | Its force, scope, version and dependency checks admitted it for this operation. |
| `considered` | The consumer actually examined or evaluated it. |
| `selected` | The consumer chose it for a specified candidate or operation. |
| `contributed` | It produced an observed, non-identity effect on a named computation, score, plan, realization or decision. |

Bind these observations to artifact/manifest IDs, consumer, turn and the actual
intermediate result or decision. They describe observed participation, not
a mandatory stage sequence: aggregate contributions need not imply individual
selection. Do not infer downstream labels from hydration or synthesize stages
absent from the live code path. Mark unmeasured contribution explicitly.
A `contributed` trace is auditable attribution, not sufficient causal proof
by itself; the required ablations and matched controls establish influence.

### Capability acceptance matrix

The user-selected translation scope is now fixed:

| Stage | Pair/directions | Release obligation |
| --- | --- | --- |
| Early diagnostic | English -> Esperanto and Esperanto -> English | Exercise linguistic induction, alignment and realization on held-out material before scaling; diagnostic success is not final translation qualification or a required Qwen win. |
| Mandatory | English -> German and German -> English | Qualify and beat the pinned Qwen comparator separately in each direction. |
| Mandatory | English -> Latin and Latin -> English | Qualify and beat the pinned Qwen comparator separately in each direction; insufficient aligned data remains a prerequisite to resolve. |
| First stretch | English <-> Ancient Greek | Outside the initial mandatory win contract; require a separate corpus and qualification before advertising support. |
| Further stretch/later | English <-> Welsh or Irish; Spanish/French and other pairs | Deferred and not silently added to the initial release gate. Chinese/Japanese/Arabic and Korean are outside the initial mandatory scope. |

The four mandatory directions cannot be dropped or averaged together after
results are seen. Record genre, register/period and orthographic coverage in
the corpus and evaluation manifests before testing. Proposed morphological
advantages over Qwen are hypotheses to test, not established advantages or
justification to weaken its evaluation. Freeze supported tasks and environments
before final testing; language pairs and directions are already fixed here.
Apply each row through ordinary server APIs, including restart where state
or learned outcomes should be durable. Keep developmental fixtures separate
from sealed final evaluation. Record quality and latency for each row.

| Capability | Required qualification |
| --- | --- |
| Factual answering | Source-bound proof, citations/spans, contradiction and temporal handling, answerable coverage, abstention and source-qualified answers. Learned priors cannot certify facts. |
| Conversation | 10-30 turn references, topic changes, corrections and task continuity; restart mid-conversation; durable/resident state precedence over stale caller metadata; tenant/conversation isolation; bounded memory; irrelevant evidence cannot suppress appropriate dialogue. Measure continuity, reference resolution, correction uptake, repetition and contradiction. |
| Creative generation | Constraint and requested-length retention, character/plot continuity, style, novelty, copying/repetition, complete sentences/paragraphs, extended generation, revision and continuation. Trace learned constructions into the existing invention/candidate/judge/Mouth path. |
| Program/coding | Repository and symbol grounding, bounded features, bug repair, cross-file refactoring, architecture constraints, compiler/test failures, observed repair/replanning and restart resumption. Measure passing builds/tests, task completion, correct-file/symbol use, unrelated edits and iterations to success. |
| Reasoned answering | Held-out relational composition, causal and temporal questions, contradiction handling and proof obligations. Show graph/field/relation contributions to selection rather than decorative traces. |
| Translation | Each mandatory direction above: meaning, omissions/unsupported additions, entities/numbers/dates, terminology, morphology, target fluency, alignment/construction consumption and untranslated residue. Qualified bilingual judges assess modern-language quality; Latin requires competent Latin evaluators. chrF/BLEU and cycle checks are supporting diagnostics, not proof of preserved meaning. |
| Actions | Existing authorization, planning, preview/commit boundaries, receipts, failure handling and observed outcomes in controlled environments. Proposed execution is not completed execution. |
| Runtime acquisition and learning | A permitted new source enters the same evidence/authority path; a real correction, preference or execution outcome produces durable learning, survives restart and measurably changes a later applicable decision. Verify credit assignment and negative outcomes as well as successes. |

Ingesting encyclopedic prose, books and code alone does not establish dialogue,
translation, task execution or feedback competence. Inventory missing supervision
and outcome evidence for each row. Translation needs actual suitable language
pair evidence; code/action calibration needs observed execution outcomes;
preferences need independently recorded choices. Record gaps and acquire or
produce the required legitimate training/evaluation observations through the
existing machinery. Do not label a missing prerequisite inapplicable to pass a
required capability, or imply English-only data establishes multilingual skill.

### Linguistic training and translation integration

Train the existing language-neutral learners on the admitted corpus: learned
segmentation/boundaries, morpheme and lexical populations, inflection/agreement,
syntactic ordering/role structure, lexical/phrase and graph/surface alignment,
then reversible constructions and target-language realization. Preserve the
source-derived linguistic annotations as supervised observations where used;
do not replace induction with hand-authored language rules or an English
ontology. Raw word counts, dictionary substitution and round-trip agreement
alone do not demonstrate this training path.

Use `language-corpus-trainer.ts`, `training-orchestrator.ts`, the existing
alignment/construction learners and the production translation/Mouth path.
Trace each required linguistic artifact through the common committer,
qualification, manifest, hydration and actual consumer contribution. Integrate
parallel-corpus observations into these contracts rather than adding a second
translation trainer/runtime. Fit preservation/alignment/realization calibrators
from held-out observed outcomes with language/direction/task identity; shared
models require measured transfer and separate per-direction reliability.

Treat language identity separately from script. English, German, Latin and
Esperanto must keep distinct learned profiles even where all use Latin script.
Use stable internal language/profile IDs and source-derived aliases. Neither a
shared script nor cognate overlap establishes language equivalence or semantic
translation support.

Live-code gaps found while fixing this scope must be repaired and tested:

- `cross-lingual-translation.ts::closedClassFor` selects the first identity by
  script. Its source and target selections can therefore use the same closed
  class for these pairs. Bind the selection to the correct language/profile
  identity and add same-script separation/contrast tests.
- Its structural seed compiler reads `ngram_observations`, while
  `language-corpus-trainer.ts` offers `skipNgramObservationPersistence` with
  a comment claiming those rows have no learning consumer. That claim conflicts
  with this reader. Preserve its required signal or move the reader to verified
  equivalent durable statistics before omitting writes. Test translation with
  the actual optimized persistence settings and a resumed build.
- `multilingual-alignment.ts::AlignmentCorpusInput` has text pairs and
  corpus-level evidence references. Admission must also preserve the paired
  source-version/span identities described above through learned outputs;
  extend the existing input/provenance contract where necessary.

Qualify unseen inflected forms and combinations, agreement/role preservation,
word-order changes, compounds, negation, ambiguity, names, numbers and dates.
Keep supported factual content stable across paraphrases. Use document-level
translation as well as isolated sentences, and test restart/hydration plus
ablation of learned morphology, alignment and constructions where supported.
Show their contribution to the real output. Re-run English speech, corpus QA,
creative and coding gates after multilingual training to catch interference.

### Routing, cross-capability behavior and outcome authority

Use held-out ambiguous request pairs and multi-turn sequences to exercise
requirement inference, authority projection and operator selection. Include a
conversational observation, a factual question, a creative request and a code
repair request about the same subject; do not replace learned routing with a
test-specific keyword classifier.

Authority-routing non-regression: adding a corpus role may add support, but
must not change a previously qualified authority decision unless a new or
changed artifact is actually admissible to that decision through the existing
force, corpus-role and requirement contracts. For fixed requests, context,
configuration and seeds, adding inadmissible material must leave the relevant
authority scores and decision unchanged. Trace any legitimate change to the
admissible artifact and its measured contribution. Test before/after OSS and
Gutenberg additions, including large increases in creative-language mass and
duplicate prose, plus a positive control where admissible new evidence should
affect the decision. Language frequency alone cannot elevate factual authority.

Required combinations include factual answers followed by challenges/corrections,
historically constrained creative work, creative revision referencing earlier
paragraphs, code repairs followed by "fix the other caller", translation with
factual preservation, and actions whose observed results affect later routing.
Exercise restart during dialogue, creative continuation and program tasks.

Owner feedback on generated work may teach preference/ranking through the
documented learning path; the generated contents never become world evidence.
A generated patch remains a proposal; observed compiler/test output establishes
only what that execution actually tested. Failed execution cannot be recorded
as successful learning. Assistant utterances cannot silently become factual
evidence, and conversation/tenant state must remain isolated throughout.

### Causal online-learning gate

Use an isolated test build and a task where a verified outcome or correction
should change a later decision. Record the baseline turn's decision A, active
artifact/calibration identities and real consumer trace. Persist the actual
outcome through the existing recorder and learning path, then qualify/publish
the resulting learned changes through the normal committer and manifest rules.
Restart from Postgres alone and issue an equivalent later turn. Require the
appropriate decision B and trace the changed artifact's actual contribution
to routing, scoring or selection; a newly stored row or a changed answer alone
does not demonstrate learning.

Keep unrelated evidence, task context, runtime settings and random seeds fixed.
Run a matched control with the prior learned artifact/calibration set and an
otherwise equivalent restart; restoring the prior set must remove the measured
learning effect. Include a no-update control and unrelated-task regression
checks to rule out restart, prompt-history or general drift as the explanation.
Apply this to corrections, preference learning and execution-outcome learning
where claimed. Each required case must pass before that learning capability
is qualified, and all force/proof boundaries continue to apply.

### Qualification records in the existing manifest machinery

The inspected `cognitive-capability-manifest.ts` currently reports mechanism
statuses such as `active`, `inert_unconfigured`, `diagnostic_only` and `failed`,
plus learned-artifact state. That is not yet task-level quality certification.
Extend and integrate this machinery; do not build a redundant capability system
or reinterpret `active` as qualified.

Preserve separate operational and qualification facts. Qualification must
distinguish unavailable, available-but-unqualified, qualified and degraded,
using a representation compatible with existing types. Bind required active
artifact IDs, calibration set, runtime configuration, supported scope,
evaluation IDs/results and actual consumer traces. Dependency invalidation
invalidates the affected qualifications for a replacement build as well.
Runtime readiness and advertised capabilities must honor these records.

Record availability reasons separately from qualification evidence. Missing
required training, calibration or evaluation prerequisites means unqualified,
with explicit dependency IDs/reasons. A previously qualified capability whose
database, hydrator or executor is temporarily down retains its version-bound
qualification record but is currently unavailable and cannot report ready.
It need not retrain solely because infrastructure recovers; verify the same
qualified dependencies and consumer health before restoring readiness. Changed
or invalidated artifacts still require requalification. Test missing
prerequisites, transient infrastructure outage/recovery and actual quality
degradation as distinct cases rather than conflating them in one status.

## 6. Backend publication and server handoff

- Build manifests from actual artifact identities, dependencies and terminal
  stage outcomes. Each required stage must be complete or explicitly
  inapplicable for a justified reason, and its required evaluation must pass.
- Write candidates without changing the active snapshot. Prevent updates to
  staged artifacts from leaking through currently active graph/model rows.
- Restore required indexes, verify storage contracts and publish the active
  manifest atomically. Retain the prior active manifest for rollback.
- Hydrate the server from that manifest through existing typed consumers;
  bind caches to the active artifact/configuration/calibration version.
- Distinguish process health, active-brain readiness, corpus progress and
  capability qualification. A successful bounded batch is not whole-corpus
  completion, and a healthy database is not proof of a trained brain.

The active manifest binds `brainVersion`, `graphArtifactSetId`,
`languageArtifactSetId`, `programArtifactSetId`, `calibrationModelSetId`,
`runtimeConfigHash` and `capabilityQualificationSetId`, with explicit absence
for capabilities outside this
build's declared scope. Learned English and the program artifacts needed for
the mandatory coding tasks are required in the final build. The exact
calibration model set is part of brain identity, hydration, cache keys,
rollback and answer traces. A newly fitted calibrator requires a qualified
manifest revision; it cannot silently replace the active set. Qualification
records are equally version-bound; old passing results cannot certify a changed
artifact set. Required capabilities cannot be reclassified out of scope to
make a failed build publishable.

Gate: restart the real server from Postgres alone and exercise its ordinary
API. Verify graph selection, evidence-backed proof, language realization,
calibration selection, abstention and trace reconstruction. An incomplete
build cannot displace the active version or become ready via an alternate path.
Test that qualified/staged artifacts remain invisible, invalidated artifacts
cannot activate, and graph/language/calibration versions cannot be mixed.
The mandatory learned-speech gate must pass through this server path; a
trainer-only generation demo does not satisfy server handoff.
Exercise the whole capability matrix and its transitions on the candidate
snapshot through the existing server lane before final activation. Online
learning that changes canonical learned artifacts uses the same committer,
qualification and publication rules; authorized dialogue/task state updates
retain their existing persistence contract and cannot bypass evidence rules.

## 7. Performance without changing the accepted result

### Measurement and hours target

Measure an unchanged baseline on fixed representative input before optimizing.
Keep parser corrections as the correctness baseline, so apparent speed gains
cannot come from losing quantities, skipping difficult pages or omitting work.
Pin old/new code revisions, corpus, logical compiler contract and configuration.
Profile critical-path wall time separately from nested CPU/DB stage totals;
nested timings must not be added as independent elapsed time.

The audited trace processed 855 articles in 140.21 minutes, about 6.1/minute.
It includes 81.70 minutes of language training (75.12 compiling) and 45.57
minutes in page transactions. These identify investigation targets, not an
extrapolation for the full dump or proof of a particular speedup.

Use two explicit clocks: source-to-durable-evidence and source-to-qualified,
restartable brain. The latter includes queue drain, training, derived learning,
evaluation, calibration, index work, publication and runtime acceptance.
Report corpus acquisition and external/human evaluation time separately and
also show the total time to final acceptance; do not conceal either as free.

Set a numeric hours budget and resource ceilings after the machine inventory
and baseline, before optimized scale trials. For a fixed manifest with N
eligible documents and budget H hours, the required completed-build average
is N/(3600*H) documents/second. Also measure bytes, tokens, graph/statistic
growth and the slowest dependent stage: article count alone is not a workload
model. Compare the 300/3,000/30,000 measurements, long-input tails and larger
samples as needed. Include mature database/index size and accumulated-model
cost so a fast empty-database prefix does not masquerade as sustained speed.

Publish the measured speedup, scaling curve and forecast interval. If hours
are not supported on this machine with the complete pipeline, state the
remaining bottleneck and achievable range. A forecast is not a completed run.

### Optimization sequence

Optimize measured cost in this order:

1. Remove CPU work from transaction lifetimes; inspect slow SQL plans,
   round trips, triggers and index maintenance on an isolated benchmark.
2. Batch compatible writes with staging/COPY or set-based merge while
   preserving labels, constraints, provenance and atomic publication.
3. Replace justified historical rescans with mergeable sufficient statistics
   and dirty sets for affected relations, populations and communities.
4. Persist reusable alignment postings/state and avoid repeated serialization
   of immutable objects. Reuse component hashes only when identities bind
   all relevant inputs.
5. Add bounded CPU concurrency with a serialized commit boundary where needed.
   Record continuation state instead of silently dropping work at a budget.

Overlap source parsing, immutable observation production, training and commits
only through the durable dependency queue. Maintain separate source,
durable-ingest, training, derived-learning and publication watermarks. Source
progress can advance only after its required downstream input is durable;
the final build cannot complete with an unreported training backlog. Batch
independent work while retaining pinned learner partitions and reduction order
where results depend on them. Measure commit contention before adding workers.

Incremental sufficient statistics must prove equivalence to full recomputation
on supported operations, including retry and invalidation; if an algorithm
cannot merge exactly, retain its canonical computation. Removing an alignment
pass, graph producer or artifact family requires dependency/output and consumer
evidence that its work is redundant. Do not silently replace a learner with
an approximation or skip rare/expensive cases to hit throughput targets.

### Resource limits on this machine

Inventory logical CPUs, available RAM, disk capacity/throughput and database
working set before choosing worker/batch counts. Persist the benchmark's CPU
concurrency ceiling, process/worker and Postgres memory budgets, maximum
in-flight bytes, queue/staging/WAL limits and minimum free-disk headroom.
Bound by bytes/work as well as article count: a few large pages can exceed a
count-only queue. Reserve measured headroom for the OS and any serving workload;
record whether the timed build is exclusive or concurrent with serving.

Backpressure stops admission when the slow stage or a resource limit is reached.
Persist resumable progress before a controlled pause; never drop work to stay
within budget. Include low disk, memory pressure, slow database, worker failure
and exhausted retry budget in recovery tests. Measure peak memory, paging,
CPU, I/O, WAL growth, lock waits, transaction duration and backlog age. Disk
projections include raw sources, derivatives, artifacts, indexes, staging and
WAL. Worker increases require demonstrated throughput benefit within all limits.

Gate: deterministic/recovery and quality checks still pass. Report end-to-end
time including training, evaluation, calibration and publication, plus
documents/MiB per second, CPU/RAM, DB time, queue depth, stage age and
historical-work/new-work ratio. Compare identical corpus/compiler/configuration
and equivalent output, not a shortened pipeline.
For optimization-only changes require canonical artifact/manifest equivalence
and the full runtime-consumer/capability regression gates, including learned
speech and durable feedback. An intentional semantic algorithm change needs
its own compiler identity and fresh qualification; it cannot claim exact
equivalence from matching counts. Resource ceilings are acceptance gates, too.

## 8. Controlled build and acceptance

Use fixture and isolated benchmark storage first. Keep `scce6_runtime` empty
until parser, authority, recovery, publication and runtime-consumer compatibility
gates pass in isolated storage. Then build a fixed
300-article diagnostic corpus, restart/verify it, and scale to representative 3,000
and 30,000-article sets. These are measurement checkpoints, not declarations
that the brain can speak. Qualify the conversational test brain only when
the mandatory learned-speech gate passes. Choose final benchmark size from the measured curve;
include long articles and difficult markup rather than only the dump prefix.

For each diagnostic build, record reproducible commands, the input manifest,
stage report, crash/replay results, real-server quality/calibration report and
resource/throughput measurements. Forecast full-dump completion with a stated range
only after scale measurements. A full Wikipedia run follows qualification;
it is not the first diagnostic experiment.

## 9. Complete the full corpus build and beat the pinned Qwen baseline

After the common pipeline passes its diagnostic gates, ingest the declared
Wikipedia corpus, then the pinned OSS, Gutenberg and multilingual manifests.
Run the Esperanto diagnostic in isolated storage before scaling the required
German/Latin directions. Use the same
durable work, artifact committer, evaluation, calibration and publication
contracts for every corpus. Existing `oss-corpus.ts`, `gutenberg-corpus.ts` and
`github-oss-acquisition.ts` are integration points, not alternative authorities.
Measure completion and failures separately for each corpus and each stage.
Ingestion completion alone cannot trigger final release; required training,
calibration, publication, learned speech and comparison gates must pass.

### Comparator and experimental contract

Pin Qwen family/version, size, weight digest, quantization, runtime/version,
context limit, decoding configuration, tools and resource budgets before the
final experiment. The user-selected comparator is `qwen2.5:3b`. A local manifest
exists and the current runner defaults to that tag. Verify the local weights
and record immutable model/quantization/runtime identities during preflight;
the tag alone is not a reproducible model identity or proof it is runnable.
Qwen runs only as the comparator, never as SCCE's language or reasoning backend.

Comparator preflight must register a versioned, machine-readable win contract
for each domain/task family before development comparison results are collected
or inspected. It specifies the primary metric and direction, scoring/rating
rubric, practical win margin, sample size and stopping rule, paired uncertainty
method, multiple-comparison treatment, and handling of ties, abstentions,
timeouts, failures and missing ratings. Include the sealed task inventory and
resource budgets by immutable reference. Validate the scorer against independent
fixtures before scoring candidate outputs. A comparison campaign cannot start
with an undefined win contract; bind its hash to every result and the release
record. Disclose any previously seen comparison results rather than presenting
retrospective threshold selection as preregistration. Later contract changes
create a new declared campaign and require fresh sealed confirmation.

Use the same tasks, accessible documents/repositories, tool permissions and
declared execution budgets. For corpus answering, give Qwen access to the
same corpus through a recorded retrieval setup. Report end-to-end comparison
and an identical-evidence control separately. Charge retrieval, tool execution,
failures and retries to the system that used them. Record warm/cold conditions
and run both on the same machine without overlapping resource contention.

Freeze the capability/task inventory before evaluating. Cover every claimed
supported task family, including the following required domains:

| Domain | Required evaluation |
| --- | --- |
| Chat | Held-out multi-turn conversations; blind ratings of relevance, instruction following, referent continuity, coherence and grammatical speech. |
| Creative writing | New prompts with explicit constraints; blind paired ratings of narrative coherence, originality, voice, prose and constraint satisfaction; detect substantial copying from training books. |
| Coding | Held-out repository tasks requiring implementation, repair and refactoring; executable hidden tests, build/type checks and regression checks, plus requirement compliance. Code explanation alone is insufficient. |
| Truthful corpus answering | Questions across Wikipedia, OSS and Gutenberg; evidence-supported claims, verifiable citations/spans, answerable coverage, contradiction handling and unanswerable controls. |
| Reasoning | Held-out relational, causal and temporal tasks with checkable conclusions, constraints and source-bound support where required. |
| Translation | English -> German, German -> English, English -> Latin and Latin -> English, scored separately under the preregistered directional win contracts; qualified blinded bilingual assessment of meaning and fluency, with morphology/terminology and omission/addition checks. |
| Actions and outcome learning | Equivalent authorized environments/tools, observed task completion, side-effect compliance, failure recovery and later correction uptake; include restart and multi-turn task resumption. |

The section 5 capability matrix defines the scope beyond the original four
domains. Freeze its concrete tasks and conditions before comparison and include
cross-capability cases; unavailable or unqualified required capabilities remain
visible failures, not omitted benchmark rows. Compare results under equal
external resources without requiring Qwen to share SCCE's internal design.

Use independent, blinded human ratings for open-ended quality, with a fixed
rubric and disagreement handling; use executable and evidence-based checks
where objective outcomes exist. Qwen cannot be its own sole judge, and
answer-substring checks cannot establish creative or conversational quality.
The current `tools/head-to-head` suite leaves conversational items ungraded
and scores factual items by strings: extend and validate it together with
the existing sealed-evaluation infrastructure before making this claim.
Execute repository tests in a real isolated runner or explicitly trusted
fixtures, consistent with the existing validator's trusted-host boundary.

Keep tuning/development tasks separate from the sealed final evaluation.
Audit corpus/test overlap; record uncertainty about Qwen's pretraining exposure
rather than claiming it is known clean. Do not feed sealed prompts, answers
or ratings back into training/calibration. If final-test results guide another
iteration, use a fresh sealed set to confirm that iteration.

### Release decision

Apply the exact win contract registered during comparator preflight; do not
choose metrics or thresholds at release time. SCCE must demonstrate a quality
win in each required domain and each declared
task family covered by the claim. An aggregate score cannot hide a losing
domain. A tie or insufficient evidence is not a win.

Set latency, memory and throughput acceptance budgets separately and report
them alongside quality. A faster wrong answer does not satisfy the quality
gate. Publish per-domain and per-corpus results, failed/abstained cases,
resource measurements, raw blinded outputs and exact model/brain manifests.
Limit the claim to the tested Qwen version and declared evaluation conditions.

If any required domain fails, the build remains unqualified for final release.
Use development diagnostics to repair the failing learner/runtime boundary,
retrain/recalibrate affected descendants and repeat qualification. Do not
rename the failure, drop the domain or lower the acceptance bar after seeing
the result. Final delivery is the qualified full-corpus snapshot plus the
reproducible comparison evidence package.

## Execution order and evidence

The architecture and translation scope in this implementation contract are
frozen. Execute the specified gates. Further architecture changes require a concrete contradiction
or missing contract demonstrated by live code, a failing test or measured
behavior; record that evidence and the smallest necessary amendment. Routine
implementation choices within these boundaries do not require redesign or
another planning/approval round.

Correctness and identity -> artifact/authority contracts -> durable work ->
stage qualification -> server handoff and runtime-consumer/capability checks
-> measured optimization -> controlled
build -> full-corpus multilingual qualification -> sealed Qwen comparison. Keep
intermediate changes small and testable. Do not introduce worker
fan-out before recovery and publication tests pass.

The existing trace (855 articles in 140.21 minutes) identifies language
compilation and database persistence as substantial costs, not a proven
full-corpus forecast. The current code already delays block completion until
training commits; the durable queue replaces that conservative coupling only
after it passes the same failure tests.

Parser reference contracts: [MediaWiki templates](https://www.mediawiki.org/wiki/Help:Templates),
[MediaWiki images](https://www.mediawiki.org/wiki/Help:Images), and
[Wikipedia conversion templates](https://en.wikipedia.org/wiki/Template:Convert).
Project invariants remain governed by `SERIOUS_VERSION_MATH_APPENDIX.md`.
