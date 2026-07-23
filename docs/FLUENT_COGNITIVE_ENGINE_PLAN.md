# Fluent Cognitive Engine Delivery Plan

Status: unachieved roadmap and acceptance target. The protected public review is
`NOT_EXECUTED`; current implementation evidence does not establish equivalence to a
general-purpose assistant. See `REPO_COMPLETION_MAP.md` for the verified boundary.

## Objective

SCCE must produce responses that blind reviewers cannot reliably distinguish from
current general-purpose assistants across ordinary conversation, factual and
reasoned questions, open-ended writing, invention, multilingual dialogue, and
software-engineering work.

This is a behavioral target. Internal routing, proof, graph, and trace checks do
not establish success unless the emitted response is also relevant, coherent,
natural, and useful.

## Non-negotiable constraints

- The production runtime remains local and one-lane: evidence and observations,
  graph cognition, candidate selection, a semantic meaning plan, one Mouth, and
  one durable store contract.
- No production response phrase, grammar rule, ontology, intent router, fallback,
  or language profile may be encoded as natural-language source text.
- Language and locale behavior must be learned from ingested corpora. Runtime
  cognition uses opaque profile, role, relation, construct, and discourse IDs.
- The realizer may choose wording, ordering, morphology, cadence, and style. It
  may not choose facts or manufacture evidence.
- Factual assertions retain evidence, inference, contradiction, temporal, and
  certification boundaries. Creative output remains explicitly non-certified.
- A terminal turn always has a Mouth-realized response. Empty internal surfaces
  are continuation signals, not user output.
- Assistant output does not become factual evidence merely because SCCE said it.
- Coding actions require exact workspace identity, reviewed transformations,
  real execution receipts, and explicit mutation authority.

Behavioral fixtures may contain corpus samples. Those samples are training or
acceptance inputs, never production decision logic or canned response material.

## Acceptance definition

The final qualification set is held out by content hash and source identity. It
contains factual, explanatory, conversational, literary, multilingual, and
coding tasks that were not used to tune the runtime.

For each task class, reviewers receive anonymized SCCE and reference-assistant
responses in randomized order. Qualification requires all of the following:

1. Reviewer identification of SCCE is statistically indistinguishable from
   chance within the declared equivalence margin.
2. SCCE quality, relevance, coherence, and usefulness are within the declared
   equivalence margin of the reference systems.
3. Terminal empty-response rate is zero.
4. Exact normalized clause duplication is zero unless repetition was explicitly
   requested by the meaning plan.
5. Required semantic-slot coverage is complete.
6. Every emitted factual unit retains a valid evidence or inference basis.
7. Every emitted literal surface unit is attributable to a learned construction,
   learned form, promoted source span, protected user surface, or correction.
8. Profile purity is complete except where an explicit translation alignment
   authorizes cross-profile material.
9. Multi-turn transcripts preserve referents, corrections, topics, preferences,
   and evidence without concatenating prior prompts.
10. Coding transcripts include real diffs, diagnostics, command receipts, and
    workspace outcomes; unexecuted work is never described as completed.

No claim of equivalence is permitted before the blind qualification passes.

## Production path

```text
Wikipedia and local corpora
-> bounded source ingestion
-> typed observations and exact spans
-> opaque language/profile discovery
-> learned segmentation, forms, constructions, and discourse transitions
-> graph cognition and candidate selection
-> semantic meaning plan
-> profile-local construction decoding
-> semantic/profile/fluency critic
-> Mouth realization
-> proof-carrying response and dialogue-state commit
```

The decoder is a realization component. It receives an already selected meaning
plan and cannot change the selected truth, action, or authorization state.

## Workstream 1: corpus-trained language substrate

The current phrase and n-gram surface path must be replaced by operational
language structures learned from source-aligned examples.

Required artifacts:

- Opaque surface profiles derived from observed segmentation, direction,
  character categories, boundary behavior, and distributional context.
- Document- and sentence-bound sequence models that never learn transitions
  across unrelated source boundaries.
- Unicode-grapheme segmentation with learned boundary probabilities.
- Learned form classes for contextual surface variants and morphology.
- Learned constructions that align semantic roles and typed slots to source
  ordering, attachment material, boundaries, and evidence.
- Learned discourse transitions, genre/cadence distributions, and correction
  influence.
- Content-addressed train, calibration, and holdout partitions.

Original NFC source surfaces are preserved for emission. Case-folded or
normalized forms may support lookup but never replace the learned surface.

## Workstream 2: one learned Mouth path

The current competing text-emission paths are collapsed into one boundary:

```text
selected candidate
-> SurfaceMeaningPlan
-> profile-local LearnedConstruction retrieval
-> slot and form instantiation
-> bounded construction beam
-> learned sequence scoring
-> semantic round-trip and surface critic
-> accepted response
```

The critic rejects, rather than merely penalizes:

- missing required slots;
- profile mixing without an alignment;
- duplicate normalized clauses;
- orphan fragments;
- unsupported factual additions;
- untraceable literal material;
- invalid requested length, sentence-count, or artifact constraints.

If constructed realization is unavailable, the same Mouth lane selects the
strongest profile-compatible source sentence, aligned whole-sentence exemplar,
or already-selected artifact surface. It does not invoke a canned fallback.

## Workstream 3: durable dialogue cognition

Conversation memory becomes a typed graph rather than recent-text reuse. The
durable state records turn observations, mentions, graph referents, topic frames,
admitted and unresolved bindings, scoped corrections and preferences, and typed
history compaction.

Binding combines recency, salience, semantic-role and slot fit, graph-route
coherence, learned-frame fit, topic continuity, evidence support, and temporal
fit. Contradiction, scope mismatch, and topic-switch pressure remain separate
penalties. Ambiguous references stay unresolved rather than being guessed.

Cross-language continuity uses graph and frame identities, not shared words.
Owner instructions, external-world claims, and assistant statements retain
different authority classes.

## Workstream 4: open-ended and literary behavior

Creative cognition produces a semantic scene, progression, constraint, and
artifact plan before realization. Corpus-learned genre, cadence, prosody,
parallelism, and discourse constructions control the surface. The request is not
copied into a word bag.

Poetry, narrative, analogy, design, and invention require explicit semantic
progression, learned genre/cadence distributions, requested structural
constraints, entity and tense continuity, non-echo and fragment rejection, and
no factual certification for invented claims.

## Workstream 5: software-engineering agent

The existing exact patch transaction remains the only mutation lane. The coding
loop becomes:

```text
workspace revision
-> semantic program observations
-> durable task constraint graph
-> verified transformation candidates
-> staged candidate workspace
-> governed command execution
-> typed diagnostic observations
-> bounded repair iteration
-> reviewed patch plan
-> approved transaction
-> mutation and validation receipts
-> conversational explanation
```

The first complete family is TypeScript compiler repair. It must include a
revision-bound semantic index, exact symbols/references/calls/diagnostics,
source-observed commands, atomic multi-file transformations, staged validation,
diagnostic-driven revision, cancellation, and durable follow-up context.

Subsequent transformation families are admitted only when their preconditions,
postconditions, validation commands, and rollback behavior are independently
verifiable.

## Workstream 6: scale and lifecycle

Wikipedia and local-folder learning must be incremental and bounded:

- streaming extraction and profile-local aggregation;
- content-addressed shards and checkpoints;
- no raw code, logs, or numeric tables in general prose training unless a typed
  lane explicitly authorizes their surface role;
- deterministic merge and activation;
- corpus/source/version provenance on every learned artifact;
- bounded memory, disk, and decode work;
- replacement and rollback through the existing brain lifecycle.

Low-resource profiles report measured coverage and uncertainty. They are not
silently backed by another profile. Constructed-language quality depends on the
quality and breadth of the supplied corpus, not a hardcoded special case.

## Implementation sequence

### Milestone 0: truthful baseline

- Preserve representative failed and successful transcripts.
- Reject empty, duplicated, mixed-profile, and fragmented output.
- Separate architectural checks from user-visible quality checks.

Exit: the existing poor outputs fail for the correct reasons.

### Milestone 1: learned constructions

- Implement aligned construction and form-class induction.
- Partition decoding strictly by opaque profile.
- Preserve corpus order, spacing, punctuation, and attachment behavior.
- Prove deterministic slot substitution on diverse Unicode surfaces.

Exit: held-out construction reconstruction preserves every required anchor and
rejects shuffled, duplicated, or cross-profile corruptions.

### Milestone 2: one nonempty Mouth

- Convert every selected candidate into a semantic meaning plan.
- Retire secondary text emission.
- Make learned construction decoding authoritative.
- Require critic acceptance and extend terminal realization to every authority.

Exit: all authority classes produce coherent, nonempty, nonduplicated surfaces
without canned language.

### Milestone 3: cognitive conversation memory

- Add typed referents, topics, bindings, corrections, and scoped preferences.
- Route graph activation from admitted dialogue identities.
- Commit turns, state, and pragmatics atomically.

Exit: coreference, ellipsis, correction, topic-switch, ambiguity, long-history,
and cross-language transcripts pass with inspectable bindings.

### Milestone 4: open-ended fluency

- Add semantic progression and learned genre/prosody control.
- Add bounded revision when the surface critic rejects a draft.

Exit: held-out creative prompts satisfy meaning, structure, continuity, and
human fluency requirements without echo or phrase salad.

### Milestone 5: coding loop

- Add the semantic program index and task graph.
- Connect staged execution receipts to diagnostic observations.
- Implement bounded repair iteration and durable task follow-up.
- Expose the same task in CLI, server, and VS Code.

Exit: hidden repository tasks are solved through reviewed exact changes and real
receipts, including multi-file and second-diagnostic repairs.

### Milestone 6: corpus and profile scale

- Train and activate profile-local artifacts from full Wikipedia and configured
  local corpora.
- Exercise unrelated scripts, locale/register variation, mixed-script inputs,
  and low-resource profiles without production language branches.

Exit: quality scales with corpus coverage while profile isolation and provenance
remain intact.

### Milestone 7: blind equivalence qualification

- Run held-out blind comparisons against current reference assistants.
- Publish per-task confidence intervals, failure classes, latency, and resource
  requirements.

Exit: every declared equivalence margin passes. Until then, SCCE is described by
the capabilities actually demonstrated.

## Current execution wave

The first parallel wave is intentionally foundational:

1. Corpus-aligned learned construction induction and deterministic decoding.
2. Typed referent/topic/slot resolution with ambiguity margins.
3. Revision-bound TypeScript semantic program indexing.

The next wave integrates those modules into the single kernel/Mouth/runtime lane.
No parallel answer path or coding-agent runtime will be introduced.
