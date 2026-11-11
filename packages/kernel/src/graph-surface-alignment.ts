// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { induceLearnedConstructions, type AlignedSurfaceExample } from "./language-construction.js";
import { SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX } from "./language-construction-memory.js";
import type { SourceBoundLanguageConstructionTrainingSet, SourceConstructionGraphBinding } from "./language-construction-memory.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";
import { type GraphBoundConstruction, type InducedLanguageModel, type LanguageInductionDocument } from "./language-induction.js";
import { buildSurfaceLattice, buildSourceAlignmentSurfaceLattice, validateSurfaceLattice, type SurfaceLattice, type SourceAlignmentSurfaceLattice, type SurfaceLatticeUnit } from "./surface-lattice.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import { compileSourceInductionWindows, compileSourceInductionWindowsAsync, compileSourceInductionWindowsFromCorpus, sourceInductionInputDigest, sourceInductionBatches } from "./source-window-induction.js";
import type { SourceInductionBatchExecution } from "./source-induction-execution.js";
import type { CorpusSegmentationBatchLoader } from "./corpus-segmentation-cursor.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import { UNRESOLVED_SEMANTIC_ROLE_ID_PREFIX } from "./opaque-role-induction.js";
import { surfaceSentenceRanges } from "./surface-linguistics.js";
import type { EvidenceSpan, GraphSnapshot, Hasher, JsonValue } from "./types.js";
import { projectSourceOwnedText, type SourceOwnedTextProjection } from "./pooled-language-profile-binding.js";

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
  nullRoleBindingAudit?: NullRoleBindingAudit[];
}

interface NullRoleBindingAudit {
  slotIndex: number;
  occurrenceIndex: number;
  reason: "bound" | "no_typed_anchor" | "multiple_null_roles" | "incompatible_construction_slot"
    | "no_slot_declaration" | "ambiguous_slot_declaration" | "no_matching_fact" | "ambiguous_facts"
    | "no_omitted_port" | "ambiguous_omitted_ports" | "unresolved_omitted_role" | "slot_binding_mismatch";
  candidateFactCount: number;
  omittedPortCount: number;
}

export interface PreparedConstructionInduction {
  readonly inputDigest: string;
}

export function sourceLanguageInductionDocuments(evidence: readonly EvidenceSpan[]): LanguageInductionDocument[] {
  return evidence.filter(span => span.status === "promoted").map(span => ({
    id: String(span.id), text: span.text, sourceVersionId: span.sourceVersionId, evidenceIds: [span.id]
  }));
}

const preparedConstructionInductions = new WeakMap<PreparedConstructionInduction, {
  views: Map<string, ReturnType<typeof compileSourceInductionWindows>>;
  modelCache: NonNullable<Parameters<typeof compileSourceInductionWindows>[0]["modelCache"]>;
  contextDigest: string;
  corpusIdentity?: CorpusSegmentationBatchLoader["identity"];
}>();

export function prepareConstructionInduction(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  additionalDocumentSets?: readonly (readonly LanguageInductionDocument[])[];
  contextDocuments?: readonly LanguageInductionDocument[];
  prepared?: PreparedConstructionInduction;
}): PreparedConstructionInduction {
  const original = input.prepared ? preparedConstructionInductions.get(input.prepared) : undefined;
  const sourceDigest = sourceInductionInputDigest(input.documents, input.hasher, original?.corpusIdentity);
  if (input.prepared && (!original || !original.views.has(sourceDigest))) throw new Error("construction induction inputs changed; prepare again");
  const contextDigest = sourceInductionInputDigest(input.contextDocuments ?? [], input.hasher, original?.corpusIdentity);
  if (input.prepared && original?.contextDigest === contextDigest
    && (input.additionalDocumentSets ?? []).every(documents => original.views.has(sourceInductionInputDigest(documents, input.hasher, original.corpusIdentity)))) return input.prepared;
  if (original?.corpusIdentity) throw new Error("corpus construction views changed; prepare asynchronously again");
  const views = new Map<string, ReturnType<typeof compileSourceInductionWindows>>();
  if (original) views.set(sourceDigest, original.views.get(sourceDigest)!);
  const modelCache = new Map(original?.modelCache);
  for (const documents of [input.documents, ...(input.additionalDocumentSets ?? [])]) {
    const key = sourceInductionInputDigest(documents, input.hasher);
    if (!views.has(key)) {
      const products = compileSourceInductionWindows({ documents, hasher: input.hasher, modelCache });
      views.set(key, key === sourceDigest ? products : Object.freeze({ models: products.models, coverage: products.coverage }));
    }
  }
  const prepared = Object.freeze({ inputDigest: input.hasher.digestHex(canonicalStringify({ sourceDigest,
    viewDigests: [...views.keys()].sort(), contextDigest })) });
  preparedConstructionInductions.set(prepared, { views, modelCache, contextDigest });
  return prepared;
}

export function preparedLanguageInductionModel(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}): InducedLanguageModel | undefined {
  const products = preparedLanguageInductionProducts(input);
  if (products.models.length > 1) throw new Error("source induction has multiple window models; consume its complete products");
  return products.fullModel;
}

export function preparedLanguageInductionProducts(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}): ReturnType<typeof compileSourceInductionWindows> {
  const prepared = input.prepared ?? prepareConstructionInduction(input);
  const original = preparedConstructionInductions.get(prepared);
  const products = original?.views.get(sourceInductionInputDigest(input.documents, input.hasher, original.corpusIdentity));
  if (!products) {
    throw new Error("construction induction inputs changed; prepare again");
  }
  return products;
}

interface AsyncConstructionInductionInput {
  documents: readonly LanguageInductionDocument[]; hasher: Hasher; corpusLoader?: CorpusSegmentationBatchLoader;
  additionalDocumentSets?: readonly (readonly LanguageInductionDocument[])[]; contextDocuments?: readonly LanguageInductionDocument[];
  prepared?: PreparedConstructionInduction; execution?: SourceInductionBatchExecution; signal?: AbortSignal;
}

export function prepareConstructionInductionAsync(input: AsyncConstructionInductionInput & { execution: SourceInductionBatchExecution }): Promise<PreparedConstructionInduction> {
  return prepareConstructionInductionAsynchronously(input);
}

export function prepareConstructionInductionFromCorpus(input: AsyncConstructionInductionInput & { corpusLoader: CorpusSegmentationBatchLoader }): Promise<PreparedConstructionInduction> {
  return prepareConstructionInductionAsynchronously(input);
}

async function prepareConstructionInductionAsynchronously(input: AsyncConstructionInductionInput): Promise<PreparedConstructionInduction> {
  const previous = input.prepared ? preparedConstructionInductions.get(input.prepared) : undefined;
  if (input.prepared && (!previous || !previous.views.has(sourceInductionInputDigest(input.documents, input.hasher, previous.corpusIdentity)))) throw new Error("construction induction inputs changed; prepare again");
  const source = input.corpusLoader?.identity;
  const corpusIdentity = source ? Object.freeze({ id: source.id, featureContextId: source.featureContextId, normalizationContractId: source.normalizationContractId,
    sourceInventory: Object.freeze({ ...source.sourceInventory }) }) : previous?.corpusIdentity;
  const original = previous && canonicalStringify(previous.corpusIdentity ?? null) === canonicalStringify(corpusIdentity ?? null) ? previous : undefined;
  const sourceDigest = sourceInductionInputDigest(input.documents, input.hasher, corpusIdentity);
  const contextDigest = sourceInductionInputDigest(input.contextDocuments ?? [], input.hasher, corpusIdentity);
  if (input.prepared && original?.contextDigest === contextDigest
    && (input.additionalDocumentSets ?? []).every(documents => original.views.has(sourceInductionInputDigest(documents, input.hasher, corpusIdentity)))) return input.prepared;
  if (!input.corpusLoader && original?.corpusIdentity) throw new Error("corpus construction views changed; prepare asynchronously again");
  const views = new Map<string, ReturnType<typeof compileSourceInductionWindows>>();
  if (original?.views.has(sourceDigest)) views.set(sourceDigest, original.views.get(sourceDigest)!);
  const modelCache = new Map(original?.modelCache);
  const corpusLoader: CorpusSegmentationBatchLoader | undefined = input.corpusLoader && corpusIdentity
    ? { identity: corpusIdentity, resolve: preparations => input.corpusLoader!.resolve(preparations) } : undefined;
  // A later qualification view must see the exact cache retired by the earlier source view.
  for (const documents of [input.documents, ...(input.additionalDocumentSets ?? [])]) {
    const key = sourceInductionInputDigest(documents, input.hasher, corpusIdentity);
    if (!views.has(key)) {
      const products = input.execution ? await compileSourceInductionWindowsAsync({ documents, hasher: input.hasher, modelCache, execution: input.execution,
        ...(corpusLoader ? { corpusLoader } : {}), ...(input.signal ? { signal: input.signal } : {}) })
        : corpusLoader ? await compileSourceInductionWindowsFromCorpus({ documents, hasher: input.hasher, corpusLoader, modelCache })
          : compileSourceInductionWindows({ documents, hasher: input.hasher, modelCache });
      views.set(key, key === sourceDigest ? products : Object.freeze({ models: products.models, coverage: products.coverage }));
    }
  }
  const prepared = Object.freeze({ inputDigest: input.hasher.digestHex(canonicalStringify({ sourceDigest,
    viewDigests: [...views.keys()].sort(), contextDigest, ...(corpusIdentity ? { corpusIdentity,
      corpusCoverageDigests: [...views].map(([key, products]) => [key, products.coverage.inputDigest]).sort() } : {}) })) });
  preparedConstructionInductions.set(prepared, { views, modelCache, contextDigest, ...(corpusIdentity ? { corpusIdentity } : {}) });
  return prepared;
}

function constructionInductionFor(input: {
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}): readonly GraphBoundConstruction[] {
  return preparedLanguageInductionProducts(input).models.flatMap(model => model.graphBoundConstructions);
}

function indexConstructionVariants(constructions: readonly GraphBoundConstruction[]): Map<string, GraphBoundConstruction[]> {
  const index = new Map<string, GraphBoundConstruction[]>();
  for (const construction of constructions) {
    const variants = index.get(construction.predicate) ?? [];
    variants.push(construction);
    index.set(construction.predicate, variants);
  }
  return index;
}

function constructionOwnsOffset(construction: GraphBoundConstruction, documentId: string, offset: number): boolean {
  return !construction.sourceWindows?.length || construction.sourceWindows.some(window =>
    window.ownerDocumentId === documentId && offset >= window.startUtf16 && offset < window.endUtf16);
}

export function induceGraphSurfaceAlignments(input: {
  documents: readonly LanguageInductionDocument[];
  constructions: readonly GraphBoundConstruction[];
  profileId: string;
  hasher: Hasher;
  maxObservationsPerConstruction?: number;
}): GraphSurfaceAlignmentSet[] {
  const maxObservations = boundedConstructionObservationLimit(input.maxObservationsPerConstruction);
  const constructionsByPredicate = indexConstructionVariants(input.constructions);
  const observationsByConstructionId = new Map<string, AlignedSurfaceExample[]>();
  const tracesByConstructionId = new Map<string, GraphSurfaceTransportTrace[]>();
  const summariesByConstructionId = new Map<string, GraphSurfaceLatticeSummary[]>();

  for (const doc of input.documents) {
    const evidenceIds = (doc.evidenceIds ?? []).map(String);
    if (!evidenceIds.length) continue;
    const lexical = segmentUnicodeSurfaceV2(doc.text, input.hasher).lexicalSegments;
    const sentenceRanges = surfaceSentenceRanges(doc.text);
    if (!lexical.some(segment => {
      return (constructionsByPredicate.get(segment.normalized) ?? []).some(construction =>
        constructionOwnsOffset(construction, doc.sourceWindow?.ownerDocumentId ?? doc.id, segment.utf16Start + (doc.sourceWindow?.startUtf16 ?? 0))
        && (observationsByConstructionId.get(construction.id)?.length ?? 0) < maxObservations);
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
      for (const construction of constructionsByPredicate.get(lexical[index]!.normalized) ?? []) {
        if (!constructionOwnsOffset(construction, doc.sourceWindow?.ownerDocumentId ?? doc.id, lexical[index]!.utf16Start + (doc.sourceWindow?.startUtf16 ?? 0))) continue;
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
          sentenceRanges,
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
  inductionDocuments?: readonly LanguageInductionDocument[];
  textProjection?: SourceOwnedTextProjection;
  graphSnapshot?: GraphSnapshot;
}): SourceBoundLanguageConstructionTrainingSet[] {
  const promoted = input.evidence.filter(span => span.status === "promoted");
  if (!promoted.length) return [];
  const canonicalDocuments: LanguageInductionDocument[] = promoted.map(span => ({
    id: String(span.id),
    text: span.text,
    evidenceIds: [span.id],
    sourceVersionId: span.sourceVersionId
  }));
  const documents = input.inductionDocuments ? [...input.inductionDocuments] : canonicalDocuments;
  const promotedById = new Map(promoted.map(span => [String(span.id), span]));
  if (documents.length !== promoted.length || new Set(documents.map(document => document.id)).size !== documents.length) {
    throw new Error("source-bound construction projection is not source-owned");
  }
  for (const document of documents) {
    const span = promotedById.get(document.id);
    const expected = span ? projectSourceOwnedText({ text: span.text, sourceVersionId: span.sourceVersionId,
      sourceCodePointStart: span.charStart, projection: input.textProjection }) : undefined;
    if (!span || document.sourceVersionId !== span.sourceVersionId || document.sourceWindow !== undefined
      || document.evidenceIds?.length !== 1 || String(document.evidenceIds[0]) !== String(span.id)
      || document.text !== expected || document.text.length !== span.text.length
      || [...document.text].length !== [...span.text].length) {
      throw new Error("source-bound construction projection is not source-owned");
    }
  }
  const documentsById = new Map(documents.map(document => [document.id, document]));
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
  const constructionsByPredicate = indexConstructionVariants(constructions);
  const bySlotOrdinal = new Map<string, number>();
  const setsByBindingId = new Map<string, SourceBoundLanguageConstructionTrainingSet>();
  const summariesByBindingId = new Map<string, ReturnType<typeof createGraphSurfaceTraceSummaryAccumulator>>();
  const latticesByBindingId = new Map<string, GraphSurfaceLatticeSummary[]>();
  const slotGraphBindings = new Map<string, Map<string, Map<string, SourceConstructionGraphBinding>>>();
  const pendingNullRoleBindings: Array<{
    bindingId: string;
    observation: SourceBoundLanguageConstructionTrainingSet["observations"][number];
    evidenceId: string;
    construction: GraphBoundConstruction;
    roles: Array<{ surface: string; graphBinding?: SourceConstructionGraphBinding }>;
    nullRoles: Array<{ slotIndex: number; occurrenceIndex?: number }>;
    facts: readonly SourceGraphFact[];
  }> = [];
  const graphBindings = sourceGraphRoleBindings(input.graphSnapshot);

  for (const canonicalSpan of promoted) {
    const span = { ...canonicalSpan, text: documentsById.get(String(canonicalSpan.id))!.text };
    const evidenceIds = [String(span.id)];
    const lexical = segmentUnicodeSurfaceV2(span.text, input.hasher).lexicalSegments;
    const sentenceRanges = surfaceSentenceRanges(span.text);
    if (!lexical.some(segment => {
      return (constructionsByPredicate.get(segment.normalized) ?? []).some(construction =>
        constructionOwnsOffset(construction, String(span.id), segment.utf16Start)
        && (bySlotOrdinal.get(sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate)) ?? 0) < maxObservations);
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
      for (const construction of constructionsByPredicate.get(lexical[index]!.normalized) ?? []) {
        if (!constructionOwnsOffset(construction, String(span.id), lexical[index]!.utf16Start)) continue;
        const bindingId = sourceRelationConstructionBindingId(input.hasher, input.profileId, construction.predicate);
        const ordinal = bySlotOrdinal.get(bindingId) ?? 0;
        if (ordinal >= maxObservations) continue;
        const aligned = sourceBoundObservationForOccurrence({ span, lexical, lattice, index, construction, hasher: input.hasher, graphBindings, sentenceRanges });
        if (!aligned) continue;
        bySlotOrdinal.set(bindingId, ordinal + 1);
        const set = setsByBindingId.get(bindingId) ?? { bindingId, observations: [] };
        (set.observations as typeof set.observations[number][]).push(aligned.observation);
        setsByBindingId.set(bindingId, set);
        for (const role of aligned.observation.roles) {
          if (!role.graphBinding) continue;
          const declarations = slotGraphBindings.get(bindingId) ?? new Map<string, Map<string, SourceConstructionGraphBinding>>();
          const key = `${role.slotIndex}\u0001${role.occurrenceIndex ?? 0}`;
          const variants = declarations.get(key) ?? new Map<string, SourceConstructionGraphBinding>();
          variants.set(canonicalStringify(role.graphBinding), role.graphBinding);
          declarations.set(key, variants);
          slotGraphBindings.set(bindingId, declarations);
        }
        if (aligned.nullRoleBindingContext) pendingNullRoleBindings.push({ bindingId, observation: aligned.observation, ...aligned.nullRoleBindingContext });
        const summary = summariesByBindingId.get(bindingId) ?? createGraphSurfaceTraceSummaryAccumulator();
        summary.observe(aligned.trace);
        summariesByBindingId.set(bindingId, summary);
        const summaries = latticesByBindingId.get(bindingId) ?? [];
        if (!summaries.some(summary => summary.latticeId === latticeSummary.latticeId)) summaries.push(latticeSummary);
        latticesByBindingId.set(bindingId, summaries);
        break;
      }
    }
  }

  for (const pending of pendingNullRoleBindings) {
    const declarations = slotGraphBindings.get(pending.bindingId) ?? new Map();
    const bindingResult = bindSourceNullRoles({
      evidenceId: pending.evidenceId,
      construction: pending.construction,
      roles: pending.roles,
      nullRoles: pending.nullRoles,
      facts: pending.facts,
      slotGraphBindings: declarations
    });
    summariesByBindingId.get(pending.bindingId)!.observeNullRoleAudit(bindingResult.audit);
    const set = setsByBindingId.get(pending.bindingId);
    const rows = set?.observations as SourceBoundLanguageConstructionTrainingSet["observations"][number][] | undefined;
    const index = rows?.indexOf(pending.observation) ?? -1;
    if (!rows || index < 0) continue;
    rows[index] = {
      ...pending.observation,
      nullRoles: pending.observation.nullRoles?.map(role => {
        const binding = bindingResult.bindings.get(`${role.slotIndex}\u0001${role.occurrenceIndex ?? 0}`);
        return binding ? { ...role, graphBinding: binding } : role;
      })
    };
  }

  return [...setsByBindingId.values()]
    .filter(set => set.observations.length >= 2)
    .map(set => ({
      ...set,
      alignmentSummary: summariesByBindingId.get(set.bindingId)!.summary({
        bindingId: set.bindingId,
        lattices: latticesByBindingId.get(set.bindingId) ?? []
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
  const constructions = constructionInductionFor({ documents: input.trainDocuments, hasher: input.hasher, prepared: input.preparedInduction });
  if (!constructions.length) return [];

  const alignments = induceGraphSurfaceAlignments({
    documents: [...sourceInductionBatches(input.trainDocuments, input.hasher)].flatMap(batch => batch.documents),
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
  graphBindings: SourceGraphRoleBindingIndex;
  sentenceRanges: readonly { startUtf16: number; endUtf16: number }[];
}): { observation: SourceBoundLanguageConstructionTrainingSet["observations"][number]; trace: GraphSurfaceTransportTrace;
  nullRoleBindingContext?: {
    evidenceId: string;
    construction: GraphBoundConstruction;
    roles: Array<{ surface: string; graphBinding?: SourceConstructionGraphBinding }>;
    nullRoles: Array<{ slotIndex: number; occurrenceIndex?: number }>;
    facts: readonly SourceGraphFact[];
  } } | undefined {
  const selected = selectOccurrenceAlignment({
    lexical: input.lexical,
    lattice: input.lattice,
    index: input.index,
    construction: input.construction,
    evidenceIds: [String(input.span.id)],
    hasher: input.hasher,
    sentenceRanges: input.sentenceRanges
  });
  if (!selected) return undefined;
  const surface = codePointsOf(input.span).slice(selected.surfaceStartCodePoint, selected.surfaceEndCodePoint).join("");
  if (surface !== surface.normalize("NFC")) return undefined;
  const graphBoundRoles = selected.roles.map(role => ({
    role,
    graphBinding: input.graphBindings.byEvidenceSurface.get(canonicalStringify([String(input.span.id), role.segment.surface]))
  }));
  const evidenceId = String(input.span.id);
  const facts = input.graphBindings.factsByEvidence.get(evidenceId) ?? [];

  return {
    observation: {
      sourceVersionId: String(input.span.sourceVersionId),
      evidenceId: String(input.span.id),
      surfaceStartCodePoint: selected.surfaceStartCodePoint,
      surfaceEndCodePoint: selected.surfaceEndCodePoint,
      roles: graphBoundRoles.map(({ role, graphBinding }) => ({
        slotIndex: role.slotIndex,
        occurrenceIndex: role.occurrenceIndex,
        startCodePoint: role.segment.codePointStart - selected.surfaceStartCodePoint,
        endCodePoint: role.segment.codePointEnd - selected.surfaceStartCodePoint,
        ...(graphBinding ? { graphBinding } : {})
      })),
      ...(selected.nullRoles.length ? { nullRoles: selected.nullRoles } : {})
    },
    trace: selected.trace,
    ...(selected.nullRoles.length ? { nullRoleBindingContext: { evidenceId, construction: input.construction,
      roles: graphBoundRoles.map(({ role, graphBinding }) => ({ surface: role.segment.surface, graphBinding })), nullRoles: selected.nullRoles, facts } } : {})
  };
}

interface SourceGraphPort {
  binding: SourceConstructionGraphBinding;
  surface?: string;
  realization: "observed" | "omitted";
  nodeId: string | null;
  evidenceIds: readonly string[];
}

interface SourceGraphFact {
  id: string;
  relationId: string;
  qualifiers: JsonValue;
  modality: JsonValue;
  temporalScope: JsonValue;
  evidenceIds: readonly string[];
  ports: readonly SourceGraphPort[];
}

interface SourceGraphRoleBindingIndex {
  byEvidenceSurface: ReadonlyMap<string, SourceConstructionGraphBinding>;
  factsByEvidence: ReadonlyMap<string, readonly SourceGraphFact[]>;
}

function sourceGraphRoleBindings(graph: GraphSnapshot | undefined): SourceGraphRoleBindingIndex {
  const result = new Map<string, SourceConstructionGraphBinding>();
  const factsByEvidence = new Map<string, SourceGraphFact[]>();
  if (!graph) return { byEvidenceSurface: result, factsByEvidence };
  const nodes = new Map(graph.nodes.map(node => [String(node.id), node]));
  const bindings = new Map<string, Map<string, SourceConstructionGraphBinding>>();
  for (const edge of graph.hyperedges) {
    const ports = edge.participantPorts.map(port => {
      const binding: SourceConstructionGraphBinding = {
        relationId: String(edge.relationId), roleId: port.roleId, valueKind: port.valueKind,
        qualifiers: edge.qualifiers, modality: edge.modality, temporalScope: edge.temporalScope
      };
      const surface = port.realization === "observed" && port.nodeId
        ? graphNodeSurface(nodes.get(String(port.nodeId))) : undefined;
      if (surface) for (const evidenceId of port.evidenceIds) {
        const key = canonicalStringify([String(evidenceId), surface]);
        const candidates = bindings.get(key) ?? new Map<string, SourceConstructionGraphBinding>();
        candidates.set(canonicalStringify(binding), binding);
        bindings.set(key, candidates);
      }
      return { binding, surface, realization: port.realization, nodeId: port.nodeId === null ? null : String(port.nodeId), evidenceIds: port.evidenceIds.map(String) };
    });
    const fact: SourceGraphFact = {
      id: String(edge.id), relationId: String(edge.relationId), qualifiers: edge.qualifiers,
      modality: edge.modality, temporalScope: edge.temporalScope,
      evidenceIds: edge.evidenceIds.map(String), ports
    };
    for (const evidenceId of fact.evidenceIds) {
      const facts = factsByEvidence.get(evidenceId) ?? [];
      facts.push(fact);
      factsByEvidence.set(evidenceId, facts);
    }
  }
  for (const [key, candidates] of bindings) if (candidates.size === 1) result.set(key, [...candidates.values()][0]!);
  return { byEvidenceSurface: result, factsByEvidence };
}

function bindSourceNullRoles(input: {
  evidenceId: string;
  construction: GraphBoundConstruction;
  roles: readonly { surface: string; graphBinding?: SourceConstructionGraphBinding }[];
  nullRoles: readonly { slotIndex: number; occurrenceIndex?: number }[];
  facts: readonly SourceGraphFact[];
  slotGraphBindings: ReadonlyMap<string, ReadonlyMap<string, SourceConstructionGraphBinding>>;
}): { bindings: Map<string, SourceConstructionGraphBinding>; audit: NullRoleBindingAudit[] } {
  const bindings = new Map<string, SourceConstructionGraphBinding>();
  if (!input.nullRoles.length) return { bindings, audit: [] };
  const anchors = input.roles.filter((row): row is typeof row & { graphBinding: SourceConstructionGraphBinding } => Boolean(row.graphBinding));
  const audits: NullRoleBindingAudit[] = [];
  const reasonForAll = (reason: NullRoleBindingAudit["reason"], candidateFactCount = 0, omittedPortCount = 0) => {
    for (const role of input.nullRoles) audits.push({ slotIndex: role.slotIndex, occurrenceIndex: role.occurrenceIndex ?? 0, reason, candidateFactCount, omittedPortCount });
  };
  if (!anchors.length) { reasonForAll("no_typed_anchor"); return { bindings, audit: audits }; }
  if (input.nullRoles.length !== 1) { reasonForAll("multiple_null_roles"); return { bindings, audit: audits }; }
  const nullRole = input.nullRoles[0]!;
  const constructionSlot = input.construction.slots.find((slot, index) =>
    slotIndexForConstructionSlot(slot.relationDirection) === nullRole.slotIndex
    && occurrenceIndexForSlot(input.construction.slots, index) === (nullRole.occurrenceIndex ?? 0));
  if (!constructionSlot) {
    reasonForAll("incompatible_construction_slot");
    return { bindings, audit: audits };
  }
  const declaredBindings = input.slotGraphBindings.get(`${nullRole.slotIndex}\u0001${nullRole.occurrenceIndex ?? 0}`);
  if (!declaredBindings?.size) { reasonForAll("no_slot_declaration"); return { bindings, audit: audits }; }
  if (declaredBindings.size !== 1) { reasonForAll("ambiguous_slot_declaration"); return { bindings, audit: audits }; }
  const declaredBinding = [...declaredBindings.values()][0]!;
  const anchorScopes = new Set(anchors.map(({ graphBinding }) => canonicalStringify({
    relationId: graphBinding.relationId, qualifiers: graphBinding.qualifiers ?? {},
    modality: graphBinding.modality ?? {}, temporalScope: graphBinding.temporalScope ?? {}
  })));
  if (anchorScopes.size !== 1) { reasonForAll("no_matching_fact"); return { bindings, audit: audits }; }
  const matchingFacts = input.facts.filter(fact => fact.evidenceIds.includes(input.evidenceId)
    && anchors.every(anchor => fact.ports.filter(port => port.realization === "observed" && port.nodeId !== null
      && port.surface === anchor.surface && port.evidenceIds.includes(input.evidenceId)
      && sameGraphBinding(port.binding, anchor.graphBinding)).length === 1)
    && fact.ports.filter(port => port.realization === "observed" && port.nodeId !== null && port.evidenceIds.includes(input.evidenceId)).length === anchors.length);
  if (!matchingFacts.length) { reasonForAll("no_matching_fact"); return { bindings, audit: audits }; }
  if (matchingFacts.length !== 1) { reasonForAll("ambiguous_facts", matchingFacts.length); return { bindings, audit: audits }; }
  const fact = matchingFacts[0]!;
  const omitted = fact.ports.filter(port => port.realization === "omitted" && port.nodeId === null && port.evidenceIds.includes(input.evidenceId));
  if (!omitted.length) { reasonForAll("no_omitted_port", 1); return { bindings, audit: audits }; }
  if (omitted.length !== 1) { reasonForAll("ambiguous_omitted_ports", 1, omitted.length); return { bindings, audit: audits }; }
  const port = omitted[0]!;
  if (!port.binding.roleId || port.binding.roleId.startsWith(UNRESOLVED_SEMANTIC_ROLE_ID_PREFIX) || !port.binding.valueKind) {
    reasonForAll("unresolved_omitted_role", 1, 1);
    return { bindings, audit: audits };
  }
  if (!sameGraphBinding(port.binding, declaredBinding)) {
    reasonForAll("slot_binding_mismatch", 1, 1);
    return { bindings, audit: audits };
  }
  bindings.set(`${nullRole.slotIndex}\u0001${nullRole.occurrenceIndex ?? 0}`, port.binding);
  audits.push({ slotIndex: nullRole.slotIndex, occurrenceIndex: nullRole.occurrenceIndex ?? 0, reason: "bound", candidateFactCount: 1, omittedPortCount: 1 });
  return { bindings, audit: audits };
}

function sameGraphBinding(left: SourceConstructionGraphBinding, right: SourceConstructionGraphBinding): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
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
  sentenceRanges: readonly { startUtf16: number; endUtf16: number }[];
}): { example: AlignedSurfaceExample; trace: GraphSurfaceTransportTrace } | undefined {
  const selected = selectOccurrenceAlignment({
    lexical: input.lexical,
    lattice: input.lattice,
    index: input.index,
    construction: input.construction,
    evidenceIds: input.evidenceIds,
    hasher: input.hasher,
    sentenceRanges: input.sentenceRanges
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
  sentenceRanges: readonly { startUtf16: number; endUtf16: number }[];
}): OccurrenceAlignmentSelection | undefined {
  const predicate = input.lexical[input.index];
  if (!predicate) return undefined;
  const sentenceRange = input.sentenceRanges.find(range => predicate.utf16Start >= range.startUtf16 && predicate.utf16End <= range.endUtf16);
  if (!sentenceRange) return undefined;
  const unitByLexicalKey = lexicalLatticeUnitMap(input.lattice);
  const predicateUnit = unitByLexicalKey.get(lexicalKey(predicate));
  const roles: SelectedRoleAlignment[] = [{
    roleId: GRAPH_SURFACE_ROLE_IDS.predicate,
    slotIndex: SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX,
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
      sentenceRange,
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
  sentenceRange: { startUtf16: number; endUtf16: number };
  hasher: Hasher;
}): Array<{ segment: LexicalSegment; segmentIndex: number; cell: GraphSurfaceTransportCell }> {
  const fillerSet = normalizedFillerSet(input.observedFillers);
  if (!fillerSet.size) return [];
  const maxWindow = 8;
  const candidates: Array<{ segment: LexicalSegment; segmentIndex: number; cell: GraphSurfaceTransportCell }> = [];
  for (let index = Math.max(0, input.predicateIndex - maxWindow); index <= Math.min(input.lexical.length - 1, input.predicateIndex + maxWindow); index++) {
    if (index === input.predicateIndex) continue;
    const segment = input.lexical[index]!;
    if (segment.utf16Start < input.sentenceRange.startUtf16 || segment.utf16End > input.sentenceRange.endUtf16) continue;
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
  if (slotIndex === SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX) return GRAPH_SURFACE_ROLE_IDS.predicate;
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

/** Source-bound compilation emits sufficient statistics, so candidate cells need not survive their occurrence. */
export function createGraphSurfaceTraceSummaryAccumulator() {
  let traceCount = 0, selectedCellCount = 0, posteriorSum = 0, costSum = 0, evaluatedNullRoles = 0, boundNullRoles = 0;
  let firstObjective: GraphSurfaceTransportTrace["objective"] | undefined;
  const nullRoleReasons = new Map<string, number>();
  const observeNullRoleAudit = (rows: readonly NullRoleBindingAudit[]) => {
    for (const row of rows) {
      evaluatedNullRoles++; if (row.reason === "bound") boundNullRoles++;
      nullRoleReasons.set(row.reason, (nullRoleReasons.get(row.reason) ?? 0) + 1);
    }
  };
  return {
    observe(trace: GraphSurfaceTransportTrace): void {
      if (!traceCount) firstObjective = { ...trace.objective };
      traceCount++;
      for (const cell of trace.cells) if (cell.selected) {
        selectedCellCount++; posteriorSum += cell.posterior; costSum += cell.cost;
      }
      observeNullRoleAudit(trace.nullRoleBindingAudit ?? []);
    },
    observeNullRoleAudit,
    summary(input: { bindingId: string; lattices: readonly GraphSurfaceLatticeSummary[] }): JsonValue { return toJsonValue({
    schema: "scce.graph_surface_alignment.summary.v1",
    bindingId: input.bindingId,
    latticeCount: input.lattices.length,
    traceCount,
    selectedCellCount,
    meanSelectedPosterior: selectedCellCount
      ? posteriorSum / selectedCellCount
      : 0,
    meanSelectedCost: selectedCellCount
      ? costSum / selectedCellCount
      : 0,
    nullRoleBindingAudit: {
      evaluated: evaluatedNullRoles,
      bound: boundNullRoles,
      reasons: [...nullRoleReasons].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => ({ reason, count }))
    },
    lattices: input.lattices,
    objective: firstObjective ?? {
      solver: "sparse_anchor_transport_v1",
      featureWeight: 0.42,
      structuralWeight: 0.22,
      anchorWeight: 0.24,
      massWeight: 0.08,
      priorWeight: 0.04
    }
  }); }
  };
}
