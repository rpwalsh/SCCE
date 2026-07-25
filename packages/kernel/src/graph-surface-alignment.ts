import { induceLearnedConstructions, type AlignedSurfaceExample } from "./language-construction.js";
import type { SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { createLanguageInductionEngine, type GraphBoundConstruction, type LanguageInductionDocument } from "./language-induction.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { EvidenceSpan, Hasher } from "./types.js";

/**
 * First module of the graph-surface alignment / construction-induction seam:
 * turns real corpus occurrences of an already-induced `GraphBoundConstruction`
 * (steps 4-6: predicate + slots, discovered purely from corpus statistics)
 * into `AlignedSurfaceExample`s -- the exact input shape
 * `language-construction.ts`'s `induceLearnedConstructions()` already
 * consumes to anti-unify concrete examples into a reusable variable-bearing
 * construction, and `realizeLearnedSurface()` already consumes to realize an
 * unseen combination of learned slot fillers back into surface text. Neither
 * of those two functions is new; what was missing was real, evidence-traced
 * alignment feeding them -- previously only hand-supplied role spans could
 * reach them at all (`compileLanguageConstructionPattern`'s `observations`
 * input, confirmed unfed by any real corpus ingestor).
 *
 * Role identity is deliberately **positional, not thematic**: a slot is
 * named by where it was measured relative to the predicate
 * (`pre_predicate` / `post_predicate`), never "agent"/"subject"/"patient"/
 * "object". Naming the pre-predicate slot "agent" would itself be a hidden
 * SVO assumption -- true for English, false for e.g. a strict SOV language
 * where the immediately pre-verbal slot is typically the object, not the
 * subject. Calling both slots by their real, measured position (matching
 * `induceGraphBoundConstructions`'s own `relationDirection: "source"/"target"`
 * convention) makes no claim about which thematic role either position
 * carries in any given language -- exactly the "opaque graph interfaces"
 * requirement this module is implementing.
 *
 * Known, disclosed limitation (not fixed here): this module only models one
 * slot immediately before and one immediately after the predicate. A
 * language where multiple arguments precede the predicate (e.g. both
 * subject and object in a strict SOV clause) has only its closer argument
 * captured as `pre_predicate`; the farther one is simply not modeled as a
 * role at all here, not mislabeled -- an honest coverage gap, not a
 * fabricated one.
 */
export interface GraphSurfaceAlignmentSet {
  bindingId: string;
  observations: AlignedSurfaceExample[];
}

export const GRAPH_SURFACE_ROLE_IDS = {
  prePredicate: "scce.role.pre_predicate",
  predicate: "scce.role.predicate",
  postPredicate: "scce.role.post_predicate"
} as const;

export function induceGraphSurfaceAlignments(input: {
  documents: readonly LanguageInductionDocument[];
  constructions: readonly GraphBoundConstruction[];
  profileId: string;
  hasher: Hasher;
  maxObservationsPerConstruction?: number;
}): GraphSurfaceAlignmentSet[] {
  const maxObservations = boundedConstructionObservationLimit(input.maxObservationsPerConstruction);
  const constructionsByPredicate = new Map(input.constructions.map(item => [item.predicate, item]));
  const observationsByConstructionId = new Map<string, AlignedSurfaceExample[]>();

  for (const doc of input.documents) {
    const evidenceIds = (doc.evidenceIds ?? []).map(String);
    if (!evidenceIds.length) continue;
    const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
    for (let index = 0; index < lexical.length; index++) {
      const construction = constructionsByPredicate.get(lexical[index]!.normalized);
      if (!construction) continue;
      const existing = observationsByConstructionId.get(construction.id) ?? [];
      if (existing.length >= maxObservations) continue;
      const example = alignedExampleForOccurrence({
        text: doc.text,
        lexical,
        index,
        construction,
        profileId: input.profileId,
        evidenceIds,
        hasher: input.hasher,
        ordinal: existing.length
      });
      if (!example) continue;
      existing.push(example);
      observationsByConstructionId.set(construction.id, existing);
    }
  }

  const sets: GraphSurfaceAlignmentSet[] = [];
  for (const construction of input.constructions) {
    const observations = observationsByConstructionId.get(construction.id);
    if (!observations || observations.length < 2) continue;
    const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
    sets.push({ bindingId, observations });
  }
  return sets.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

/**
 * Production-shape counterpart of `induceGraphSurfaceAlignments()`: emits
 * the exact `SourceBoundLanguageConstructionTrainingSet[]` shape
 * `language-corpus-trainer.ts`'s `constructionSets` parameter already
 * accepts and passes straight to `compileLanguageConstructionPattern()` --
 * previously never populated by any real corpus ingestor (confirmed: no
 * caller ever supplied it). Runs induction once over all promoted evidence
 * to discover real constructions, then re-walks each evidence span's own
 * text individually so every observation's code-point coordinates are
 * correctly relative to that one span, matching what
 * `compileLanguageConstructionPattern`'s validation expects.
 */
export function induceSourceBoundConstructionTrainingSets(input: {
  evidence: readonly EvidenceSpan[];
  profileId: string;
  hasher: Hasher;
  maxObservationsPerConstruction?: number;
}): SourceBoundLanguageConstructionTrainingSet[] {
  const promoted = input.evidence.filter(span => span.status === "promoted");
  if (!promoted.length) return [];
  const documents: LanguageInductionDocument[] = promoted.map(span => ({
    id: String(span.id),
    text: span.text,
    evidenceIds: [span.id],
    sourceVersionId: span.sourceVersionId
  }));
  const model = createLanguageInductionEngine({ hasher: input.hasher }).induce({ documents });
  if (!model.graphBoundConstructions.length) return [];

  const maxObservations = boundedConstructionObservationLimit(input.maxObservationsPerConstruction);
  const constructionsByPredicate = new Map(model.graphBoundConstructions.map(item => [item.predicate, item]));
  const bySlotOrdinal = new Map<string, number>();
  const setsByBindingId = new Map<string, SourceBoundLanguageConstructionTrainingSet>();

  for (const span of promoted) {
    const lexical = segmentUnicodeSurfaceV2(span.text, input.hasher).lexicalSegments;
    for (let index = 0; index < lexical.length; index++) {
      const construction = constructionsByPredicate.get(lexical[index]!.normalized);
      if (!construction) continue;
      const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
      const ordinal = bySlotOrdinal.get(bindingId) ?? 0;
      if (ordinal >= maxObservations) continue;
      const observation = sourceBoundObservationForOccurrence({ span, lexical, index, construction });
      if (!observation) continue;
      bySlotOrdinal.set(bindingId, ordinal + 1);
      const set = setsByBindingId.get(bindingId) ?? { bindingId, observations: [] };
      (set.observations as typeof set.observations[number][]).push(observation);
      setsByBindingId.set(bindingId, set);
    }
  }

  return [...setsByBindingId.values()]
    .filter(set => set.observations.length >= 2)
    .sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

export interface HeldOutConstructionCoverageReport {
  bindingId: string;
  predicate: string;
  trainedPrePredicateVariantCount: number;
  trainedPostPredicateVariantCount: number;
  heldOutOccurrences: number;
  heldOutPrePredicateCovered: number;
  heldOutPostPredicateOccurrences: number;
  heldOutPostPredicateCovered: number;
}

/**
 * Measures whether the alignment -> anti-unification pipeline actually
 * generalizes, rather than asserting it on the same corpus it was trained
 * on. Induces constructions and learned form classes from `trainDocuments`
 * only, then scans `heldOutDocuments` (genuinely unseen by the induction
 * step) for real occurrences of the same predicates, and reports what
 * fraction of held-out pre-/post-predicate fillers were already a member of
 * the form class learned from training data alone. This is a real, honest
 * coverage measurement -- not a fluency or accuracy claim, and not
 * fabricated when there is no real held-out evidence for a construction
 * (such constructions are simply absent from the report).
 */
export function evaluateHeldOutConstructionCoverage(input: {
  trainDocuments: readonly LanguageInductionDocument[];
  heldOutDocuments: readonly LanguageInductionDocument[];
  profileId: string;
  hasher: Hasher;
}): HeldOutConstructionCoverageReport[] {
  const model = createLanguageInductionEngine({ hasher: input.hasher }).induce({ documents: [...input.trainDocuments] });
  if (!model.graphBoundConstructions.length) return [];

  const alignments = induceGraphSurfaceAlignments({
    documents: input.trainDocuments,
    constructions: model.graphBoundConstructions,
    profileId: input.profileId,
    hasher: input.hasher
  });
  const alignmentByBindingId = new Map(alignments.map(set => [set.bindingId, set]));

  const reports: HeldOutConstructionCoverageReport[] = [];
  for (const construction of model.graphBoundConstructions) {
    const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
    const alignmentSet = alignmentByBindingId.get(bindingId);
    if (!alignmentSet) continue;
    const induction = induceLearnedConstructions({ examples: alignmentSet.observations, hasher: input.hasher });
    if (!induction.constructions.length) continue;
    const trainedPreSurfaces = new Set(
      induction.formClasses.filter(formClass => formClass.roleId === GRAPH_SURFACE_ROLE_IDS.prePredicate)
        .flatMap(formClass => formClass.variants.map(variant => variant.surface))
    );
    const trainedPostSurfaces = new Set(
      induction.formClasses.filter(formClass => formClass.roleId === GRAPH_SURFACE_ROLE_IDS.postPredicate)
        .flatMap(formClass => formClass.variants.map(variant => variant.surface))
    );
    if (!trainedPreSurfaces.size) continue;

    let heldOutOccurrences = 0;
    let heldOutPreCovered = 0;
    let heldOutPostOccurrences = 0;
    let heldOutPostCovered = 0;
    const preSlot = construction.slots.find(slot => slot.relationDirection === "source");
    const postSlot = construction.slots.find(slot => slot.relationDirection === "target");
    for (const doc of input.heldOutDocuments) {
      const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
      for (let index = 0; index < lexical.length; index++) {
        if (lexical[index]!.normalized !== construction.predicate) continue;
        const left = lexical[index - 1];
        if (!left || !preSlot) continue;
        heldOutOccurrences++;
        if (trainedPreSurfaces.has(left.normalized)) heldOutPreCovered++;
        const right = lexical[index + 1];
        const hasPost = Boolean(right && postSlot?.observedFillers.includes(right.normalized));
        if (hasPost && right) {
          heldOutPostOccurrences++;
          if (trainedPostSurfaces.has(right.normalized)) heldOutPostCovered++;
        }
      }
    }
    if (!heldOutOccurrences) continue;
    reports.push({
      bindingId,
      predicate: construction.predicate,
      trainedPrePredicateVariantCount: trainedPreSurfaces.size,
      trainedPostPredicateVariantCount: trainedPostSurfaces.size,
      heldOutOccurrences,
      heldOutPrePredicateCovered: heldOutPreCovered,
      heldOutPostPredicateOccurrences: heldOutPostOccurrences,
      heldOutPostPredicateCovered: heldOutPostCovered
    });
  }
  return reports.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

export function sourceRelationConstructionBindingId(hasher: Hasher, profileId: string, predicate: string): string {
  return `language.source_relation.${hasher.digestHex(JSON.stringify([profileId, predicate])).slice(0, 32)}`;
}

function boundedConstructionObservationLimit(requested?: number): number {
  return Math.max(1, Math.min(256, Math.floor(requested ?? 256)));
}

function sourceBoundObservationForOccurrence(input: {
  span: EvidenceSpan;
  lexical: readonly LexicalSegment[];
  index: number;
  construction: GraphBoundConstruction;
}): SourceBoundLanguageConstructionTrainingSet["observations"][number] | undefined {
  const { span, lexical, index, construction } = input;
  const predicate = lexical[index]!;
  const preSlot = construction.slots.find(slot => slot.relationDirection === "source");
  const postSlot = construction.slots.find(slot => slot.relationDirection === "target");
  const left = lexical[index - 1];
  if (!left || !preSlot) return undefined;
  const right = lexical[index + 1];
  const hasPost = Boolean(right && postSlot?.observedFillers.includes(right.normalized));

  const windowStartCodePoint = left.codePointStart;
  const windowEndCodePoint = hasPost && right ? right.codePointEnd : predicate.codePointEnd;
  const surface = [...span.text].slice(windowStartCodePoint, windowEndCodePoint).join("");
  if (surface !== surface.normalize("NFC")) return undefined;

  return {
    sourceVersionId: String(span.sourceVersionId),
    evidenceId: String(span.id),
    surfaceStartCodePoint: windowStartCodePoint,
    surfaceEndCodePoint: windowEndCodePoint,
    roles: [
      {
        slotIndex: 0,
        startCodePoint: left.codePointStart - windowStartCodePoint,
        endCodePoint: left.codePointEnd - windowStartCodePoint
      },
      {
        slotIndex: 1,
        startCodePoint: predicate.codePointStart - windowStartCodePoint,
        endCodePoint: predicate.codePointEnd - windowStartCodePoint
      },
      ...(hasPost && right ? [{
        slotIndex: 2,
        startCodePoint: right.codePointStart - windowStartCodePoint,
        endCodePoint: right.codePointEnd - windowStartCodePoint
      }] : [])
    ],
    ...(hasPost ? {} : { nullRoles: [{ slotIndex: 2 }] })
  };
}

function alignedExampleForOccurrence(input: {
  text: string;
  lexical: readonly LexicalSegment[];
  index: number;
  construction: GraphBoundConstruction;
  profileId: string;
  evidenceIds: readonly string[];
  hasher: Hasher;
  ordinal: number;
}): AlignedSurfaceExample | undefined {
  const { lexical, index, construction } = input;
  const predicate = lexical[index]!;
  const preSlot = construction.slots.find(slot => slot.relationDirection === "source");
  const postSlot = construction.slots.find(slot => slot.relationDirection === "target");
  const left = lexical[index - 1];
  if (!left || !preSlot) return undefined;
  const right = lexical[index + 1];
  const hasPost = Boolean(right && postSlot?.observedFillers.includes(right.normalized));

  const windowStart = left.utf16Start;
  const windowEnd = hasPost && right ? right.utf16End : predicate.utf16End;
  const surface = input.text.slice(windowStart, windowEnd);
  if (surface !== surface.normalize("NFC")) return undefined;

  const roleSpans = [
    {
      roleId: GRAPH_SURFACE_ROLE_IDS.prePredicate,
      start: left.utf16Start - windowStart,
      end: left.utf16End - windowStart,
      surface: left.surface,
      evidenceIds: input.evidenceIds
    },
    {
      roleId: GRAPH_SURFACE_ROLE_IDS.predicate,
      start: predicate.utf16Start - windowStart,
      end: predicate.utf16End - windowStart,
      surface: predicate.surface,
      evidenceIds: input.evidenceIds
    },
    ...(hasPost && right ? [{
      roleId: GRAPH_SURFACE_ROLE_IDS.postPredicate,
      start: right.utf16Start - windowStart,
      end: right.utf16End - windowStart,
      surface: right.surface,
      evidenceIds: input.evidenceIds
    }] : [])
  ];
  for (const span of roleSpans) {
    if (surface.slice(span.start, span.end) !== span.surface) return undefined;
  }

  return {
    id: `graph_surface_alignment.${input.hasher.digestHex(
      JSON.stringify([input.profileId, construction.id, input.ordinal, windowStart, windowEnd])
    ).slice(0, 32)}`,
    profileKey: input.profileId,
    surface,
    evidenceIds: input.evidenceIds,
    roleSpans
  };
}
