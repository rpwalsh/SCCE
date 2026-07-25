import type { AlignedSurfaceExample } from "./language-construction.js";
import type { SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { createLanguageInductionEngine, type GraphBoundConstruction, type LanguageInductionDocument } from "./language-induction.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { EvidenceSpan, Hasher } from "./types.js";

/**
 * First module of the graph-surface alignment / construction-induction seam:
 * turns real corpus occurrences of an already-induced `GraphBoundConstruction`
 * (steps 4-6: predicate + arg0/arg1 slots, discovered purely from corpus
 * statistics) into `AlignedSurfaceExample`s -- the exact input shape
 * `language-construction.ts`'s `induceLearnedConstructions()` already
 * consumes to anti-unify concrete examples into a reusable variable-bearing
 * construction, and `realizeLearnedSurface()` already consumes to realize an
 * unseen combination of learned slot fillers back into surface text. Neither
 * of those two functions is new; what was missing was real, evidence-traced
 * alignment feeding them -- previously only hand-supplied role spans could
 * reach them at all (`compileLanguageConstructionPattern`'s `observations`
 * input, confirmed unfed by any real corpus ingestor).
 *
 * These are deliberately surface-relative roles. Corpus adjacency alone
 * cannot establish semantic agency or patienthood, so the aligner records
 * before/predicate/after positions and leaves semantic-role binding to typed
 * graph evidence.
 */
export interface GraphSurfaceAlignmentSet {
  bindingId: string;
  observations: AlignedSurfaceExample[];
}

export const GRAPH_SURFACE_ROLE_IDS = {
  beforePredicate: "scce.surface_role.before_predicate",
  predicate: "scce.surface_role.predicate",
  afterPredicate: "scce.surface_role.after_predicate"
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
    const bindingId = sourceRelationConstructionBindingId(
      input.hasher,
      input.profileId,
      construction.predicate
    );
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

export function sourceRelationConstructionBindingId(hasher: Hasher, profileId: string, predicate: string): string {
  return `language.source_relation.${hasher.digestHex(JSON.stringify([profileId, predicate])).slice(0, 32)}`;
}

function boundedConstructionObservationLimit(requested?: number): number {
  // compileLanguageConstructionPattern() deliberately rejects more than 256
  // source observations. Keep the producer on the same contract so common
  // constructions do not become guaranteed compiler rejections.
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
  const arg0Slot = construction.slots.find(slot => slot.relationDirection === "source");
  const arg1Slot = construction.slots.find(slot => slot.relationDirection === "target");
  const left = lexical[index - 1];
  if (!left || !arg0Slot) return undefined;
  const right = lexical[index + 1];
  const hasPatient = Boolean(right && arg1Slot?.observedFillers.includes(right.normalized));

  const windowStartCodePoint = left.codePointStart;
  const windowEndCodePoint = hasPatient && right ? right.codePointEnd : predicate.codePointEnd;
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
      ...(hasPatient && right ? [{
        slotIndex: 2,
        startCodePoint: right.codePointStart - windowStartCodePoint,
        endCodePoint: right.codePointEnd - windowStartCodePoint
      }] : [])
    ],
    ...(hasPatient ? {} : { nullRoles: [{ slotIndex: 2 }] })
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
  const arg0Slot = construction.slots.find(slot => slot.relationDirection === "source");
  const arg1Slot = construction.slots.find(slot => slot.relationDirection === "target");
  const left = lexical[index - 1];
  if (!left || !arg0Slot) return undefined;
  const right = lexical[index + 1];
  const hasPatient = Boolean(right && arg1Slot?.observedFillers.includes(right.normalized));

  const windowStart = left.utf16Start;
  const windowEnd = hasPatient && right ? right.utf16End : predicate.utf16End;
  const surface = input.text.slice(windowStart, windowEnd);
  if (surface !== surface.normalize("NFC")) return undefined;

  const roleSpans = [
    {
      roleId: GRAPH_SURFACE_ROLE_IDS.beforePredicate,
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
    ...(hasPatient && right ? [{
      roleId: GRAPH_SURFACE_ROLE_IDS.afterPredicate,
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
