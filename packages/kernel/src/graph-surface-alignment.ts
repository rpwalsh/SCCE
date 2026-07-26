import { induceLearnedConstructions, type AlignedSurfaceExample } from "./language-construction.js";
import type { SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { createLanguageInductionEngine, type GraphBoundConstruction, type LanguageInductionDocument } from "./language-induction.js";
import { buildSurfaceLattice, type SurfaceLattice, type SurfaceLatticeUnit } from "./surface-lattice.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import { clamp01, toJsonValue } from "./primitives.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

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
 * (`pre_predicate` / `post_predicate`), never a thematic grammar label.
 * Calling slots by their real measured position (matching
 * `induceGraphBoundConstructions`'s own `relationDirection: "source"/"target"`
 * convention) makes no claim about which thematic role either position
 * carries in any corpus. The runtime receives opaque graph/surface bindings,
 * not a hidden school-grammar parser.
 *
 * The current solver is a bounded sparse transport approximation, not a
 * dense global Gromov-Wasserstein solver. It searches a local lattice
 * neighborhood around an induced predicate anchor, persists posterior/cost
 * traces, and supports repeated opaque slots through occurrence indexes.
 */
export interface GraphSurfaceAlignmentSet {
  bindingId: string;
  observations: AlignedSurfaceExample[];
  latticeSummaries?: GraphSurfaceLatticeSummary[];
  transportTraces?: GraphSurfaceTransportTrace[];
}

export const GRAPH_SURFACE_ROLE_IDS = {
  prePredicate: "scce.role.pre_predicate",
  predicate: "scce.role.predicate",
  postPredicate: "scce.role.post_predicate"
} as const;

export interface GraphSurfaceLatticeSummary {
  latticeId: string;
  documentId: string;
  units: number;
  edges: number;
  textHash: string;
}

export interface GraphSurfaceTransportCell {
  surfaceUnitId: string;
  roleId: string;
  slotIndex: number;
  occurrenceIndex: number;
  surface: string;
  normalized: string;
  cost: number;
  posterior: number;
  featureCost: number;
  structuralCost: number;
  anchorBonus: number;
  massPenalty: number;
  priorPenalty: number;
  selected: boolean;
}

export interface GraphSurfaceTransportTrace {
  traceId: string;
  latticeId: string;
  constructionId: string;
  predicate: string;
  evidenceIds: string[];
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  objective: {
    solver: "sparse_anchor_transport_v1";
    featureWeight: number;
    structuralWeight: number;
    anchorWeight: number;
    massWeight: number;
    priorWeight: number;
  };
  cells: GraphSurfaceTransportCell[];
}

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
  const tracesByConstructionId = new Map<string, GraphSurfaceTransportTrace[]>();
  const summariesByConstructionId = new Map<string, GraphSurfaceLatticeSummary[]>();

  for (const doc of input.documents) {
    const evidenceIds = (doc.evidenceIds ?? []).map(String);
    if (!evidenceIds.length) continue;
    const lattice = buildSurfaceLattice({
      documentId: doc.id,
      text: doc.text,
      sourceVersionId: doc.sourceVersionId,
      evidenceIds,
      hasher: input.hasher
    });
    const latticeSummary = summarizeLattice(lattice);
    const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
    for (let index = 0; index < lexical.length; index++) {
      const construction = constructionsByPredicate.get(lexical[index]!.normalized);
      if (!construction) continue;
      const existing = observationsByConstructionId.get(construction.id) ?? [];
      if (existing.length >= maxObservations) continue;
      const aligned = alignedExampleForOccurrence({
        text: doc.text,
        lexical,
        lattice,
        index,
        construction,
        profileId: input.profileId,
        evidenceIds,
        hasher: input.hasher,
        ordinal: existing.length
      });
      if (!aligned) continue;
      existing.push(aligned.example);
      observationsByConstructionId.set(construction.id, existing);
      const traces = tracesByConstructionId.get(construction.id) ?? [];
      traces.push(aligned.trace);
      tracesByConstructionId.set(construction.id, traces);
      const summaries = summariesByConstructionId.get(construction.id) ?? [];
      if (!summaries.some(summary => summary.latticeId === latticeSummary.latticeId)) summaries.push(latticeSummary);
      summariesByConstructionId.set(construction.id, summaries);
    }
  }

  const sets: GraphSurfaceAlignmentSet[] = [];
  for (const construction of input.constructions) {
    const observations = observationsByConstructionId.get(construction.id);
    if (!observations || observations.length < 2) continue;
    const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
    sets.push({
      bindingId,
      observations,
      latticeSummaries: summariesByConstructionId.get(construction.id) ?? [],
      transportTraces: tracesByConstructionId.get(construction.id) ?? []
    });
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
  const tracesByBindingId = new Map<string, GraphSurfaceTransportTrace[]>();
  const latticesByBindingId = new Map<string, GraphSurfaceLatticeSummary[]>();

  for (const span of promoted) {
    const evidenceIds = [String(span.id)];
    const lattice = buildSurfaceLattice({
      documentId: String(span.id),
      text: span.text,
      sourceVersionId: span.sourceVersionId,
      evidenceIds,
      hasher: input.hasher
    });
    const latticeSummary = summarizeLattice(lattice);
    const lexical = segmentUnicodeSurfaceV2(span.text, input.hasher).lexicalSegments;
    for (let index = 0; index < lexical.length; index++) {
      const construction = constructionsByPredicate.get(lexical[index]!.normalized);
      if (!construction) continue;
      const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
      const ordinal = bySlotOrdinal.get(bindingId) ?? 0;
      if (ordinal >= maxObservations) continue;
      const aligned = sourceBoundObservationForOccurrence({ span, lexical, lattice, index, construction, hasher: input.hasher });
      if (!aligned) continue;
      bySlotOrdinal.set(bindingId, ordinal + 1);
      const set = setsByBindingId.get(bindingId) ?? { bindingId, observations: [] };
      (set.observations as typeof set.observations[number][]).push(aligned.observation);
      setsByBindingId.set(bindingId, set);
      const traces = tracesByBindingId.get(bindingId) ?? [];
      traces.push(aligned.trace);
      tracesByBindingId.set(bindingId, traces);
      const summaries = latticesByBindingId.get(bindingId) ?? [];
      if (!summaries.some(summary => summary.latticeId === latticeSummary.latticeId)) summaries.push(latticeSummary);
      latticesByBindingId.set(bindingId, summaries);
    }
  }

  return [...setsByBindingId.values()]
    .filter(set => set.observations.length >= 2)
    .map(set => ({
      ...set,
      alignmentSummary: alignmentSummaryJson({
        bindingId: set.bindingId,
        lattices: latticesByBindingId.get(set.bindingId) ?? [],
        traces: tracesByBindingId.get(set.bindingId) ?? []
      })
    }))
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
  lattice: SurfaceLattice;
  index: number;
  construction: GraphBoundConstruction;
  hasher: Hasher;
}): { observation: SourceBoundLanguageConstructionTrainingSet["observations"][number]; trace: GraphSurfaceTransportTrace } | undefined {
  const selected = selectOccurrenceAlignment({
    lexical: input.lexical,
    lattice: input.lattice,
    index: input.index,
    construction: input.construction,
    evidenceIds: [String(input.span.id)],
    hasher: input.hasher
  });
  if (!selected) return undefined;
  const surface = [...input.span.text].slice(selected.surfaceStartCodePoint, selected.surfaceEndCodePoint).join("");
  if (surface !== surface.normalize("NFC")) return undefined;

  return {
    observation: {
      sourceVersionId: String(input.span.sourceVersionId),
      evidenceId: String(input.span.id),
      surfaceStartCodePoint: selected.surfaceStartCodePoint,
      surfaceEndCodePoint: selected.surfaceEndCodePoint,
      roles: selected.roles.map(role => ({
        slotIndex: role.slotIndex,
        occurrenceIndex: role.occurrenceIndex,
        startCodePoint: role.segment.codePointStart - selected.surfaceStartCodePoint,
        endCodePoint: role.segment.codePointEnd - selected.surfaceStartCodePoint
      })),
      ...(selected.nullRoles.length ? { nullRoles: selected.nullRoles } : {})
    },
    trace: selected.trace
  };
}

function alignedExampleForOccurrence(input: {
  text: string;
  lexical: readonly LexicalSegment[];
  lattice: SurfaceLattice;
  index: number;
  construction: GraphBoundConstruction;
  profileId: string;
  evidenceIds: readonly string[];
  hasher: Hasher;
  ordinal: number;
}): { example: AlignedSurfaceExample; trace: GraphSurfaceTransportTrace } | undefined {
  const selected = selectOccurrenceAlignment({
    lexical: input.lexical,
    lattice: input.lattice,
    index: input.index,
    construction: input.construction,
    evidenceIds: input.evidenceIds,
    hasher: input.hasher
  });
  if (!selected) return undefined;

  const windowStart = selected.surfaceStartUtf16;
  const windowEnd = selected.surfaceEndUtf16;
  const surface = input.text.slice(windowStart, windowEnd);
  if (surface !== surface.normalize("NFC")) return undefined;

  const roleSpans = selected.roles
    .sort((left, right) => left.segment.utf16Start - right.segment.utf16Start || left.roleId.localeCompare(right.roleId))
    .map(role => ({
      roleId: role.roleId,
      occurrenceId: occurrenceIdForRole(role.roleId, role.occurrenceIndex),
      start: role.segment.utf16Start - windowStart,
      end: role.segment.utf16End - windowStart,
      surface: role.segment.surface,
      evidenceIds: input.evidenceIds
    }));
  for (const span of roleSpans) {
    if (surface.slice(span.start, span.end) !== span.surface) return undefined;
  }

  return {
    example: {
      id: `graph_surface_alignment.${input.hasher.digestHex(
        JSON.stringify([input.profileId, input.construction.id, input.ordinal, windowStart, windowEnd, roleSpans])
      ).slice(0, 32)}`,
      profileKey: input.profileId,
      surface,
      evidenceIds: input.evidenceIds,
      roleSpans,
      ...(selected.nullRoles.length
        ? {
          nullRoleOccurrences: selected.nullRoles.map(role => ({
            roleId: roleIdForSlotIndex(role.slotIndex),
            occurrenceId: occurrenceIdForRole(roleIdForSlotIndex(role.slotIndex), role.occurrenceIndex ?? 0),
            evidenceIds: input.evidenceIds
          }))
        }
        : {})
    },
    trace: selected.trace
  };
}

interface SelectedRoleAlignment {
  roleId: string;
  slotIndex: number;
  occurrenceIndex: number;
  segment: LexicalSegment;
  unitId: string;
  cell: GraphSurfaceTransportCell;
}

interface OccurrenceAlignmentSelection {
  surfaceStartUtf16: number;
  surfaceEndUtf16: number;
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  roles: SelectedRoleAlignment[];
  nullRoles: Array<{ slotIndex: number; occurrenceIndex?: number }>;
  trace: GraphSurfaceTransportTrace;
}

function selectOccurrenceAlignment(input: {
  lexical: readonly LexicalSegment[];
  lattice: SurfaceLattice;
  index: number;
  construction: GraphBoundConstruction;
  evidenceIds: readonly string[];
  hasher: Hasher;
}): OccurrenceAlignmentSelection | undefined {
  const predicate = input.lexical[input.index];
  if (!predicate) return undefined;
  const unitByLexicalKey = lexicalLatticeUnitMap(input.lattice);
  const predicateUnit = unitByLexicalKey.get(lexicalKey(predicate));
  const roles: SelectedRoleAlignment[] = [{
    roleId: GRAPH_SURFACE_ROLE_IDS.predicate,
    slotIndex: 1,
    occurrenceIndex: 0,
    segment: predicate,
    unitId: predicateUnit?.id ?? syntheticUnitId(input.hasher, predicate),
    cell: transportCell({
      unit: predicateUnit,
      segment: predicate,
      roleId: GRAPH_SURFACE_ROLE_IDS.predicate,
      slotIndex: 1,
      occurrenceIndex: 0,
      predicateIndex: input.index,
      segmentIndex: input.index,
      observedFillers: [predicate.normalized],
      expectedSide: "same",
      selected: true
    })
  }];
  const cells: GraphSurfaceTransportCell[] = [roles[0]!.cell];
  const nullRoles: Array<{ slotIndex: number; occurrenceIndex?: number }> = [];
  const usedIndexes = new Set<number>([input.index]);

  const slots = input.construction.slots
    .map((slot, slotOrdinal) => ({
      slot,
      slotIndex: slotIndexForConstructionSlot(slot.relationDirection),
      occurrenceIndex: occurrenceIndexForSlot(input.construction.slots, slotOrdinal),
      roleId: roleIdForSlotIndex(slotIndexForConstructionSlot(slot.relationDirection))
    }))
    .sort((left, right) => left.slotIndex - right.slotIndex || left.occurrenceIndex - right.occurrenceIndex);

  for (const slot of slots) {
    const candidates = candidateCellsForSlot({
      lexical: input.lexical,
      lattice: input.lattice,
      unitByLexicalKey,
      predicateIndex: input.index,
      slotIndex: slot.slotIndex,
      occurrenceIndex: slot.occurrenceIndex,
      roleId: slot.roleId,
      observedFillers: slot.slot.observedFillers,
      expectedSide: slot.slot.relationDirection === "source" ? "before" : slot.slot.relationDirection === "target" ? "after" : "either",
      hasher: input.hasher
    });
    cells.push(...candidates.map(candidate => candidate.cell));
    const selected = candidates
      .filter(candidate => !usedIndexes.has(candidate.segmentIndex))
      .sort((left, right) => left.cell.cost - right.cell.cost || Math.abs(left.segmentIndex - input.index) - Math.abs(right.segmentIndex - input.index))[0];
    if (!selected || selected.cell.posterior < 0.08) {
      nullRoles.push({ slotIndex: slot.slotIndex, occurrenceIndex: slot.occurrenceIndex });
      continue;
    }
    usedIndexes.add(selected.segmentIndex);
    selected.cell.selected = true;
    roles.push({
      roleId: slot.roleId,
      slotIndex: slot.slotIndex,
      occurrenceIndex: slot.occurrenceIndex,
      segment: selected.segment,
      unitId: selected.cell.surfaceUnitId,
      cell: selected.cell
    });
  }

  const semanticRoles = roles.filter(role => role.roleId !== GRAPH_SURFACE_ROLE_IDS.predicate);
  if (!semanticRoles.length) return undefined;
  const surfaceStartUtf16 = Math.min(...roles.map(role => role.segment.utf16Start));
  const surfaceEndUtf16 = Math.max(...roles.map(role => role.segment.utf16End));
  const surfaceStartCodePoint = Math.min(...roles.map(role => role.segment.codePointStart));
  const surfaceEndCodePoint = Math.max(...roles.map(role => role.segment.codePointEnd));
  const trace: GraphSurfaceTransportTrace = {
    traceId: `graph_surface_transport.${input.hasher.digestHex(JSON.stringify([
      input.lattice.id,
      input.construction.id,
      input.index,
      surfaceStartCodePoint,
      surfaceEndCodePoint,
      input.evidenceIds
    ])).slice(0, 32)}`,
    latticeId: input.lattice.id,
    constructionId: input.construction.id,
    predicate: input.construction.predicate,
    evidenceIds: input.evidenceIds.map(String).sort(),
    surfaceStartCodePoint,
    surfaceEndCodePoint,
    objective: {
      solver: "sparse_anchor_transport_v1",
      featureWeight: 0.42,
      structuralWeight: 0.22,
      anchorWeight: 0.24,
      massWeight: 0.08,
      priorWeight: 0.04
    },
    cells: cells.sort((left, right) => left.cost - right.cost || left.roleId.localeCompare(right.roleId))
  };
  return { surfaceStartUtf16, surfaceEndUtf16, surfaceStartCodePoint, surfaceEndCodePoint, roles, nullRoles, trace };
}

function candidateCellsForSlot(input: {
  lexical: readonly LexicalSegment[];
  lattice: SurfaceLattice;
  unitByLexicalKey: ReadonlyMap<string, SurfaceLatticeUnit>;
  predicateIndex: number;
  slotIndex: number;
  occurrenceIndex: number;
  roleId: string;
  observedFillers: readonly string[];
  expectedSide: "before" | "after" | "same" | "either";
  hasher: Hasher;
}): Array<{ segment: LexicalSegment; segmentIndex: number; cell: GraphSurfaceTransportCell }> {
  const fillerSet = new Set(input.observedFillers.map(normalizeSurfaceKey));
  if (!fillerSet.size) return [];
  const maxWindow = 8;
  const candidates: Array<{ segment: LexicalSegment; segmentIndex: number; cell: GraphSurfaceTransportCell }> = [];
  for (let index = Math.max(0, input.predicateIndex - maxWindow); index <= Math.min(input.lexical.length - 1, input.predicateIndex + maxWindow); index++) {
    if (index === input.predicateIndex) continue;
    const segment = input.lexical[index]!;
    if (!fillerSet.has(normalizeSurfaceKey(segment.normalized))) continue;
    const unit = input.unitByLexicalKey.get(lexicalKey(segment));
    candidates.push({
      segment,
      segmentIndex: index,
      cell: transportCell({
        unit,
        segment,
        roleId: input.roleId,
        slotIndex: input.slotIndex,
        occurrenceIndex: input.occurrenceIndex,
        predicateIndex: input.predicateIndex,
        segmentIndex: index,
        observedFillers: input.observedFillers,
        expectedSide: input.expectedSide,
        selected: false,
        hasher: input.hasher
      })
    });
  }
  const normalizer = candidates.reduce((sum, candidate) => sum + Math.exp(-candidate.cell.cost * 4), 0);
  for (const candidate of candidates) candidate.cell.posterior = normalizer > 0 ? clamp01(Math.exp(-candidate.cell.cost * 4) / normalizer) : 0;
  return candidates.sort((left, right) => right.cell.posterior - left.cell.posterior || left.cell.cost - right.cell.cost);
}

function transportCell(input: {
  unit?: SurfaceLatticeUnit;
  segment: LexicalSegment;
  roleId: string;
  slotIndex: number;
  occurrenceIndex: number;
  predicateIndex: number;
  segmentIndex: number;
  observedFillers: readonly string[];
  expectedSide: "before" | "after" | "same" | "either";
  selected: boolean;
  hasher?: Hasher;
}): GraphSurfaceTransportCell {
  const observed = input.observedFillers.map(normalizeSurfaceKey);
  const normalized = normalizeSurfaceKey(input.segment.normalized);
  const exactAnchor = observed.includes(normalized);
  const distance = Math.abs(input.segmentIndex - input.predicateIndex);
  const featureCost = exactAnchor ? 0.04 : 0.72;
  const structuralCost = input.expectedSide === "same"
    ? 0
    : clamp01(distance / 8);
  const wrongSide = input.expectedSide === "before"
    ? input.segmentIndex > input.predicateIndex
    : input.expectedSide === "after"
      ? input.segmentIndex < input.predicateIndex
      : false;
  const priorPenalty = wrongSide ? 0.32 : 0;
  const anchorBonus = exactAnchor ? 0.24 : 0;
  const massPenalty = input.unit ? clamp01(1 / Math.max(1, input.unit.recurrenceCount + 1)) * 0.08 : 0.08;
  const boundaryFit = input.unit
    ? 1 - ((input.unit.boundaryBefore.bootstrapBoundaryProbability + input.unit.boundaryAfter.bootstrapBoundaryProbability) / 2)
    : 0.5;
  const cost = clamp01(0.42 * featureCost + 0.22 * structuralCost + 0.08 * massPenalty + 0.04 * priorPenalty + 0.24 * boundaryFit - anchorBonus);
  const hasher = input.hasher;
  return {
    surfaceUnitId: input.unit?.id ?? (hasher ? syntheticUnitId(hasher, input.segment) : `surface_unit.synthetic.${input.segment.codePointStart}.${input.segment.codePointEnd}`),
    roleId: input.roleId,
    slotIndex: input.slotIndex,
    occurrenceIndex: input.occurrenceIndex,
    surface: input.segment.surface,
    normalized,
    cost,
    posterior: input.selected ? 1 : 0,
    featureCost,
    structuralCost,
    anchorBonus,
    massPenalty,
    priorPenalty,
    selected: input.selected
  };
}

function lexicalLatticeUnitMap(lattice: SurfaceLattice): Map<string, SurfaceLatticeUnit> {
  const out = new Map<string, SurfaceLatticeUnit>();
  for (const unit of lattice.units) {
    if (unit.kind !== "lexical") continue;
    out.set(`${unit.codePointStart}\u0001${unit.codePointEnd}\u0001${unit.normalized}`, unit);
  }
  return out;
}

function lexicalKey(segment: LexicalSegment): string {
  return `${segment.codePointStart}\u0001${segment.codePointEnd}\u0001${normalizeSurfaceKey(segment.normalized)}`;
}

function normalizeSurfaceKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function syntheticUnitId(hasher: Hasher, segment: LexicalSegment): string {
  return `surface_unit.synthetic.${hasher.digestHex(JSON.stringify([
    segment.codePointStart,
    segment.codePointEnd,
    segment.surface
  ])).slice(0, 24)}`;
}

function slotIndexForConstructionSlot(direction: "source" | "target"): number {
  return direction === "source" ? 0 : 2;
}

function roleIdForSlotIndex(slotIndex: number): string {
  if (slotIndex === 0) return GRAPH_SURFACE_ROLE_IDS.prePredicate;
  if (slotIndex === 1) return GRAPH_SURFACE_ROLE_IDS.predicate;
  if (slotIndex === 2) return GRAPH_SURFACE_ROLE_IDS.postPredicate;
  return `scce.role.aligned_slot_${slotIndex}`;
}

function occurrenceIndexForSlot(slots: readonly GraphBoundConstruction["slots"][number][], slotOrdinal: number): number {
  const direction = slots[slotOrdinal]?.relationDirection;
  if (!direction) return 0;
  return slots.slice(0, slotOrdinal).filter(slot => slot.relationDirection === direction).length;
}

function occurrenceIdForRole(roleId: string, occurrenceIndex: number): string {
  return occurrenceIndex === 0 ? roleId : `${roleId}#${occurrenceIndex}`;
}

function summarizeLattice(lattice: SurfaceLattice): GraphSurfaceLatticeSummary {
  return {
    latticeId: lattice.id,
    documentId: lattice.documentId,
    units: lattice.units.length,
    edges: lattice.edges.length,
    textHash: lattice.textHash
  };
}

function alignmentSummaryJson(input: {
  bindingId: string;
  lattices: readonly GraphSurfaceLatticeSummary[];
  traces: readonly GraphSurfaceTransportTrace[];
}): JsonValue {
  const selectedCells = input.traces.flatMap(trace => trace.cells.filter(cell => cell.selected));
  return toJsonValue({
    schema: "scce.graph_surface_alignment.summary.v1",
    bindingId: input.bindingId,
    latticeCount: input.lattices.length,
    traceCount: input.traces.length,
    selectedCellCount: selectedCells.length,
    meanSelectedPosterior: selectedCells.length
      ? selectedCells.reduce((sum, cell) => sum + cell.posterior, 0) / selectedCells.length
      : 0,
    meanSelectedCost: selectedCells.length
      ? selectedCells.reduce((sum, cell) => sum + cell.cost, 0) / selectedCells.length
      : 0,
    lattices: input.lattices,
    objective: input.traces[0]?.objective ?? {
      solver: "sparse_anchor_transport_v1",
      featureWeight: 0.42,
      structuralWeight: 0.22,
      anchorWeight: 0.24,
      massWeight: 0.08,
      priorWeight: 0.04
    }
  });
}
