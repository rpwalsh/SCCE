// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { induceLearnedConstructions, type AlignedSurfaceExample } from "./language-construction.js";
import type { SourceBoundLanguageConstructionTrainingSet, SourceConstructionGraphBinding } from "./language-construction-memory.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";
import { createLanguageInductionEngine, type GraphBoundConstruction, type InducedLanguageModel, type LanguageInductionDocument } from "./language-induction.js";
import { buildSurfaceLattice, buildSourceAlignmentSurfaceLattice, validateSurfaceLattice, type SurfaceLattice, type SourceAlignmentSurfaceLattice, type SurfaceLatticeUnit } from "./surface-lattice.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import { boundedInductionDocuments } from "./training-orchestrator.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import type { EvidenceSpan, GraphSnapshot, Hasher, JsonValue } from "./types.js";

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
  projection?: SourceAlignmentSurfaceLattice["schema"];
  sourceUnits?: number;
}

type AlignmentSurfaceLattice = SurfaceLattice | SourceAlignmentSurfaceLattice;

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

export interface PreparedConstructionInduction {
  readonly inputDigest: string;
}

export function sourceLanguageInductionDocuments(evidence: readonly EvidenceSpan[]): LanguageInductionDocument[] {
  return evidence.filter(span => span.status === "promoted").map(span => ({
    id: String(span.id), text: span.text, sourceVersionId: span.sourceVersionId, evidenceIds: [span.id]
  }));
}

const preparedConstructionInductions = new WeakMap<PreparedConstructionInduction, InducedLanguageModel | undefined>();

export function prepareConstructionInduction(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
}): PreparedConstructionInduction {
  const documents = boundedInductionDocuments(input.documents);
  const prepared = Object.freeze({ inputDigest: input.hasher.digestHex(canonicalStringify(documents)) });
  const model = documents.length
    ? createLanguageInductionEngine({ hasher: input.hasher }).induce({ documents })
    : undefined;
  preparedConstructionInductions.set(prepared, model);
  return prepared;
}

export function preparedLanguageInductionModel(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}): InducedLanguageModel | undefined {
  const prepared = input.prepared ?? prepareConstructionInduction(input);
  if (!preparedConstructionInductions.has(prepared) || prepared.inputDigest !== input.hasher.digestHex(canonicalStringify(boundedInductionDocuments(input.documents)))) {
    throw new Error("construction induction inputs changed; prepare again");
  }
  return preparedConstructionInductions.get(prepared);
}

function constructionInductionFor(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}): readonly GraphBoundConstruction[] {
  return preparedLanguageInductionModel(input)?.graphBoundConstructions ?? [];
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
    const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
    if (!lexical.some(segment => {
      const construction = constructionsByPredicate.get(segment.normalized);
      return construction && (observationsByConstructionId.get(construction.id)?.length ?? 0) < maxObservations;
    })) continue;
    const lattice = buildSurfaceLattice({
      documentId: doc.id,
      text: doc.text,
      sourceVersionId: doc.sourceVersionId,
      evidenceIds,
      hasher: input.hasher
    });
    // A lattice that does not actually cover its own text cannot anchor an alignment: the offsets an aligned
    // example carries would point through a gap. `validateSurfaceLattice` checks exactly that correspondence and
    // had no caller, so a lattice with a hole produced alignment observations that looked well-formed and pointed
    // somewhere else. Skipped rather than thrown, because a lattice truncated at its unit cap is a legitimate
    // partial and the document simply cannot contribute alignments.
    const latticeCheck = validateSurfaceLattice(lattice, doc.text);
    if (!latticeCheck.valid) continue;
    const latticeSummary = summarizeLattice(lattice);
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
  return sets;
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
  preparedInduction?: PreparedConstructionInduction;
  graphSnapshot?: GraphSnapshot;
}): SourceBoundLanguageConstructionTrainingSet[] {
  const promoted = input.evidence.filter(span => span.status === "promoted");
  if (!promoted.length) return [];
  const documents: LanguageInductionDocument[] = promoted.map(span => ({
    id: String(span.id),
    text: span.text,
    evidenceIds: [span.id],
    sourceVersionId: span.sourceVersionId
  }));
  // Corpus ingestors (Gutenberg, OSS docs/code) call this with evidence
  // covering an entire source file's worth of spans -- unlike the live turn
  // path, nothing upstream caps total evidence text size here. induce()'s
  // peak scales with total document text (and superlinearly with any single
  // document's length), not document count, so an unbounded `documents`
  // array here reintroduces the same class of OOM already fixed inside
  // induce() and buildSurfaceLattice for a single large input -- just via
  // many spans instead of one. Reuses the same bound already proven for
  // training-orchestrator.ts's own induce() call site rather than adding a
  // second budgeting scheme.
  const constructions = constructionInductionFor({ documents, hasher: input.hasher, prepared: input.preparedInduction });
  if (!constructions.length) return [];

  const maxObservations = boundedConstructionObservationLimit(input.maxObservationsPerConstruction);
  const constructionsByPredicate = new Map(constructions.map(item => [item.predicate, item]));
  const bySlotOrdinal = new Map<string, number>();
  const setsByBindingId = new Map<string, SourceBoundLanguageConstructionTrainingSet>();
  const tracesByBindingId = new Map<string, GraphSurfaceTransportTrace[]>();
  const latticesByBindingId = new Map<string, GraphSurfaceLatticeSummary[]>();
  const graphBindings = sourceGraphRoleBindings(input.graphSnapshot);

  for (const span of promoted) {
    const evidenceIds = [String(span.id)];
    const lexical = segmentUnicodeSurfaceV2(span.text, input.hasher).lexicalSegments;
    if (!lexical.some(segment => {
      const construction = constructionsByPredicate.get(segment.normalized);
      if (!construction) return false;
      const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
      return (bySlotOrdinal.get(bindingId) ?? 0) < maxObservations;
    })) continue;
    const lattice = buildSourceAlignmentSurfaceLattice({
      documentId: String(span.id),
      text: span.text,
      sourceVersionId: span.sourceVersionId,
      evidenceIds,
      hasher: input.hasher
    });
    const latticeSummary = summarizeLattice(lattice);
    for (let index = 0; index < lexical.length; index++) {
      const construction = constructionsByPredicate.get(lexical[index]!.normalized);
      if (!construction) continue;
      const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
      const ordinal = bySlotOrdinal.get(bindingId) ?? 0;
      if (ordinal >= maxObservations) continue;
      const aligned = sourceBoundObservationForOccurrence({ span, lexical, lattice, index, construction, hasher: input.hasher, graphBindings });
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
  preparedInduction?: PreparedConstructionInduction;
}): HeldOutConstructionCoverageReport[] {
  // Same unbounded-corpus risk as induceSourceBoundConstructionTrainingSets
  // above, reached via the same production compileLanguageTrainingBatch call
  // (evaluateConstructionPromotion, on every batch with held-out evidence) --
  // bounded the same way rather than adding a second scheme.
  const boundedTrainDocuments = boundedInductionDocuments(input.trainDocuments);
  const constructions = constructionInductionFor({ documents: boundedTrainDocuments, hasher: input.hasher, prepared: input.preparedInduction });
  if (!constructions.length) return [];

  const alignments = induceGraphSurfaceAlignments({
    documents: boundedTrainDocuments,
    constructions: [...constructions],
    profileId: input.profileId,
    hasher: input.hasher
  });
  const alignmentByBindingId = new Map(alignments.map(set => [set.bindingId, set]));
  const predicates = new Set(constructions.map(construction => construction.predicate));
  const heldOutByPredicate = new Map<string, {
    occurrences: number;
    pre: Map<string, number>;
    post: Map<string, number>;
    postOccurrences: number;
  }>();
  for (const doc of input.heldOutDocuments) {
    const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
    for (let index = 1; index < lexical.length; index++) {
      const predicate = lexical[index]!.normalized;
      if (!predicates.has(predicate)) continue;
      const counts = heldOutByPredicate.get(predicate) ?? { occurrences: 0, pre: new Map(), post: new Map(), postOccurrences: 0 };
      const left = lexical[index - 1]!.normalized;
      counts.occurrences++;
      counts.pre.set(left, (counts.pre.get(left) ?? 0) + 1);
      const right = lexical[index + 1]?.normalized;
      if (right !== undefined) {
        counts.postOccurrences++;
        counts.post.set(right, (counts.post.get(right) ?? 0) + 1);
      }
      heldOutByPredicate.set(predicate, counts);
    }
  }

  const reports: HeldOutConstructionCoverageReport[] = [];
  for (const construction of constructions) {
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

    const preSlot = construction.slots.find(slot => slot.relationDirection === "source");
    const postSlot = construction.slots.find(slot => slot.relationDirection === "target");
    // Coverage generalizes at the SLOT level, not the exact-adjacency
    // level: a held-out filler counts as covered when training observed
    // it in this slot anywhere (observedFillers), not only when the
    // identical bigram recurs. Exact-token matching demanded bigram
    // recurrence across the split -- verified live on a heterogeneous
    // 150-article batch, constructions recurring 34 times in held-out
    // text scored 0.0 coverage and were rejected wholesale, while only
    // the most formulaic phrasing survived.
    const preCoverageSurfaces = new Set([...trainedPreSurfaces, ...(preSlot?.observedFillers ?? [])]);
    const postCoverageSurfaces = new Set([...trainedPostSurfaces, ...(postSlot?.observedFillers ?? [])]);
    const counts = heldOutByPredicate.get(construction.predicate);
    if (!preSlot || !counts?.occurrences) continue;
    const coveredCount = (values: ReadonlyMap<string, number>, accepted: ReadonlySet<string>) => {
      let total = 0;
      for (const [surface, count] of values) if (accepted.has(surface)) total += count;
      return total;
    };
    reports.push({
      bindingId,
      predicate: construction.predicate,
      trainedPrePredicateVariantCount: trainedPreSurfaces.size,
      trainedPostPredicateVariantCount: trainedPostSurfaces.size,
      heldOutOccurrences: counts.occurrences,
      heldOutPrePredicateCovered: coveredCount(counts.pre, preCoverageSurfaces),
      heldOutPostPredicateOccurrences: counts.postOccurrences,
      heldOutPostPredicateCovered: coveredCount(counts.post, postCoverageSurfaces)
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
  lattice: AlignmentSurfaceLattice;
  index: number;
  construction: GraphBoundConstruction;
  hasher: Hasher;
  graphBindings: ReadonlyMap<string, SourceConstructionGraphBinding>;
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
  const surface = codePointsOf(input.span).slice(selected.surfaceStartCodePoint, selected.surfaceEndCodePoint).join("");
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
        endCodePoint: role.segment.codePointEnd - selected.surfaceStartCodePoint,
        ...(input.graphBindings.has(canonicalStringify([String(input.span.id), role.segment.surface]))
          ? { graphBinding: input.graphBindings.get(canonicalStringify([String(input.span.id), role.segment.surface]))! } : {})
      })),
      ...(selected.nullRoles.length ? { nullRoles: selected.nullRoles } : {})
    },
    trace: selected.trace
  };
}

function sourceGraphRoleBindings(graph: GraphSnapshot | undefined): Map<string, SourceConstructionGraphBinding> {
  const result = new Map<string, SourceConstructionGraphBinding>();
  if (!graph) return result;
  const nodes = new Map(graph.nodes.map(node => [String(node.id), node]));
  const bindings = new Map<string, Map<string, SourceConstructionGraphBinding>>();
  for (const edge of graph.hyperedges) for (const port of edge.participantPorts) {
    if (port.realization !== "observed" || !port.nodeId) continue;
    const surface = graphNodeSurface(nodes.get(String(port.nodeId)));
    if (!surface) continue;
    const binding: SourceConstructionGraphBinding = {
      relationId: String(edge.relationId), roleId: port.roleId, valueKind: port.valueKind,
      qualifiers: edge.qualifiers, modality: edge.modality, temporalScope: edge.temporalScope
    };
    for (const evidenceId of port.evidenceIds) {
      const key = canonicalStringify([String(evidenceId), surface]);
      const candidates = bindings.get(key) ?? new Map<string, SourceConstructionGraphBinding>();
      candidates.set(canonicalStringify(binding), binding);
      bindings.set(key, candidates);
    }
  }
  for (const [key, candidates] of bindings) if (candidates.size === 1) result.set(key, [...candidates.values()][0]!);
  return result;
}

function alignedExampleForOccurrence(input: {
  text: string;
  lexical: readonly LexicalSegment[];
  lattice: AlignmentSurfaceLattice;
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
  lattice: AlignmentSurfaceLattice;
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
  lattice: AlignmentSurfaceLattice;
  unitByLexicalKey: ReadonlyMap<string, SurfaceLatticeUnit>;
  predicateIndex: number;
  slotIndex: number;
  occurrenceIndex: number;
  roleId: string;
  observedFillers: readonly string[];
  expectedSide: "before" | "after" | "same" | "either";
  hasher: Hasher;
}): Array<{ segment: LexicalSegment; segmentIndex: number; cell: GraphSurfaceTransportCell }> {
  const fillerSet = normalizedFillerSet(input.observedFillers);
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
  const normalized = normalizeSurfaceKey(input.segment.normalized);
  const exactAnchor = normalizedFillerSet(input.observedFillers).has(normalized);
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
    ? 1 - ((input.unit.boundaryBefore.boundaryProbability + input.unit.boundaryAfter.boundaryProbability) / 2)
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

const lexicalUnitMapByLattice = new WeakMap<AlignmentSurfaceLattice, Map<string, SurfaceLatticeUnit>>();

function lexicalLatticeUnitMap(lattice: AlignmentSurfaceLattice): Map<string, SurfaceLatticeUnit> {
  const cached = lexicalUnitMapByLattice.get(lattice);
  if (cached) return cached;
  const out = new Map<string, SurfaceLatticeUnit>();
  for (const unit of lattice.units) {
    if (!unit.proposalSources.includes("lexical")) continue;
    out.set(`${unit.codePointStart}\u0001${unit.codePointEnd}\u0001${unit.normalized}`, unit);
  }
  lexicalUnitMapByLattice.set(lattice, out);
  return out;
}

function lexicalKey(segment: LexicalSegment): string {
  return `${segment.codePointStart}\u0001${segment.codePointEnd}\u0001${normalizeSurfaceKey(segment.normalized)}`;
}

function normalizeSurfaceKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

const codePointsBySpan = new WeakMap<EvidenceSpan, string[]>();

function codePointsOf(span: EvidenceSpan): string[] {
  const cached = codePointsBySpan.get(span);
  if (cached) return cached;
  const points = [...span.text];
  codePointsBySpan.set(span, points);
  return points;
}

const normalizedFillerSetByArray = new WeakMap<readonly string[], Set<string>>();

function normalizedFillerSet(fillers: readonly string[]): Set<string> {
  const cached = normalizedFillerSetByArray.get(fillers);
  if (cached) return cached;
  const set = new Set(fillers.map(normalizeSurfaceKey));
  normalizedFillerSetByArray.set(fillers, set);
  return set;
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

function summarizeLattice(lattice: AlignmentSurfaceLattice): GraphSurfaceLatticeSummary {
  return {
    latticeId: lattice.id,
    documentId: lattice.documentId,
    units: lattice.units.length,
    edges: "edges" in lattice ? lattice.edges.length : 0,
    textHash: lattice.textHash,
    ...("sourceUnitCount" in lattice ? { projection: lattice.schema, sourceUnits: lattice.sourceUnitCount } : {})
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
