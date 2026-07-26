import {
  compileLanguageConstructionPattern,
  type SourceBoundLanguageConstructionTrainingSet
} from "./language-construction-memory.js";
import {
  evaluateHeldOutConstructionCoverage,
  induceSourceBoundConstructionTrainingSets,
  type HeldOutConstructionCoverageReport
} from "./graph-surface-alignment.js";
import {
  compileSparseAlignmentCandidateSupports,
  type SparseAlignmentCandidateSupport
} from "./sparse-alignment-candidates.js";
import {
  solveSparseFusedUnbalancedTransport,
  type SparseFusedTransportPlan
} from "./sparse-fused-transport.js";
import {
  allocateTransportEvidence,
  type TransportEvidenceAllocation
} from "./transport-evidence-allocation.js";
import {
  compileTypedNullCostModel,
  type TypedNullCostModel
} from "./typed-null-alignment.js";
import type { LanguageMemoryRuntime } from "./language-memory-runtime.js";
import { toJsonValue } from "./primitives.js";
import { buildSurfaceLattice } from "./surface-lattice.js";
import type {
  LanguagePatternRecord,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  SemanticFrameRecord
} from "./storage.js";
import type { ScceStorage } from "./storage.js";
import { dominantScriptId, segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type {
  EvidenceSpan,
  GraphSnapshot,
  Hasher,
  JsonValue,
  LanguageProfile,
  SourceVersionId
} from "./types.js";

/**
 * The single in-memory compilation boundary shared by file ingestion, corpus
 * ingestion, and explicit training. Persistence and source admission remain
 * caller responsibilities, but identical language-bearing input now produces
 * the same family of linguistic artifacts regardless of entry point.
 */
export interface LanguageTrainingBatch {
  streamId: string;
  sourceSystem?: string;
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: EvidenceSpan[];
  createdAt: number;
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  additionalPatterns?: readonly LanguagePatternRecord[];
  graphSnapshot?: GraphSnapshot;
  maxAlignmentCandidateDegree?: number;
}

export interface LanguageTrainingConstructionPromotionPolicy {
  minHeldOutOccurrences?: number;
  minPrePredicateCoverage?: number;
  minPostPredicateCoverage?: number;
}

export interface LanguageTrainingConstructionPromotionReport {
  schema: "scce.language_training.construction_promotion.v1";
  trainEvidence: number;
  heldOutEvidence: number;
  suppliedConstructionSets: number;
  inducedConstructionSets: number;
  promotedSuppliedConstructionSets: number;
  promotedInducedConstructionSets: number;
  rejectedInducedConstructionSets: number;
  thresholds: {
    minHeldOutOccurrences: number;
    minPrePredicateCoverage: number;
    minPostPredicateCoverage: number;
  };
  heldOutCoverage: HeldOutConstructionCoverageReport[];
  rejections: Array<{
    bindingId: string;
    reason: "no_heldout_evidence" | "no_heldout_coverage" | "heldout_occurrences_low" | "pre_predicate_coverage_low" | "post_predicate_coverage_low" | "compile_rejected";
    heldOutOccurrences: number;
    prePredicateCoverage: number;
    postPredicateCoverage?: number;
  }>;
}

export interface CompiledLanguageTrainingBatch {
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  semanticFrames: SemanticFrameRecord[];
  constructionPatterns: LanguagePatternRecord[];
  graphSurfaceAlignmentSummaries: JsonValue[];
  sparseAlignmentCandidateSupports: SparseAlignmentCandidateSupport[];
  sparseAlignmentCandidateSummaries: JsonValue[];
  typedNullCostModel: TypedNullCostModel | null;
  sparseTransportPlans: SparseFusedTransportPlan[];
  transportEvidenceAllocations: TransportEvidenceAllocation[];
  constructionCandidates: number;
  rejectedConstructionCandidates: number;
  constructionPromotion: LanguageTrainingConstructionPromotionReport;
  warnings: string[];
  audit: JsonValue;
}

export function compileLanguageTrainingBatch(input: {
  batch: LanguageTrainingBatch;
  runtime: LanguageMemoryRuntime;
  hasher: Hasher;
}): CompiledLanguageTrainingBatch {
  const { batch } = input;
  const textChunks = boundedTrainingTextChunks(batch.text);
  const memories = textChunks.map((text, index) => input.runtime.train({
    streamId: textChunks.length === 1
      ? batch.streamId
      : `${batch.streamId}#training-chunk-${String(index + 1).padStart(6, "0")}`,
    sourceSystem: batch.sourceSystem,
    profile: batch.profile,
    sourceVersionId: batch.sourceVersionId,
    text,
    evidence: batch.evidence,
    createdAt: batch.createdAt,
    maxOrder: batch.maxOrder,
    maxCountersPerOrder: batch.maxCountersPerOrder,
    vocabularyLimit: batch.vocabularyLimit
  }));
  const inducedSets = induceSourceBoundConstructionTrainingSets({
    evidence: constructionTrainEvidence(batch.evidence, input.hasher),
    profileId: batch.profile.id,
    hasher: input.hasher
  });
  const sparseAlignment = batch.graphSnapshot?.hyperedges.length
    ? compileSparseAlignmentCandidateSupports({
      lattices: batch.evidence.map(span => buildSurfaceLattice({
        documentId: String(span.id),
        text: span.text,
        sourceVersionId: span.sourceVersionId,
        evidenceIds: [span.id],
        hasher: input.hasher
      })),
      nodes: batch.graphSnapshot.nodes,
      hyperedges: batch.graphSnapshot.hyperedges,
      maxCandidateDegree: batch.maxAlignmentCandidateDegree,
      hasher: input.hasher
    })
    : undefined;
  const sparseAlignmentCandidateSupports = sparseAlignment?.supports ?? [];
  const typedNullCostModel = sparseAlignment
    ? compileTypedNullCostModel({
      supports: sparseAlignmentCandidateSupports,
      targetIndex: sparseAlignment.targetIndex,
      hasher: input.hasher
    })
    : null;
  const sparseTransportPlans = sparseAlignment
    ? sparseAlignmentCandidateSupports.map(support =>
      solveSparseFusedUnbalancedTransport({
        support,
        targetIndex: sparseAlignment.targetIndex,
        typedNullCostModel: typedNullCostModel!,
        hasher: input.hasher
      }))
    : [];
  const transportEvidenceAllocations = sparseTransportPlans.map((plan, index) =>
    allocateTransportEvidence({
      plan,
      support: sparseAlignmentCandidateSupports[index]!,
      hasher: input.hasher
    }));
  const sparseAlignmentCandidateSummaries = sparseAlignmentCandidateSupports.map(support =>
    toJsonValue({
      schema: support.schema,
      id: support.id,
      latticeId: support.latticeId,
      targetIndexId: support.targetIndexId,
      incidenceGraphId: support.incidenceGraphId,
      maxCandidateDegree: support.maxCandidateDegree,
      candidateCount: support.candidates.length,
      rowCount: support.rows.length,
      audit: support.audit
    }));
  const constructionPatterns: LanguagePatternRecord[] = [];
  const warnings: string[] = [];
  const promotion = evaluateConstructionPromotion({
    evidence: batch.evidence,
    profileId: batch.profile.id,
    hasher: input.hasher,
    suppliedSets: batch.constructionSets ?? [],
    inducedSets
  });
  const sets = uniqueConstructionWorkItems([
    ...(batch.constructionSets ?? []).map(set => ({ set, evidence: batch.evidence })),
    ...inducedSets
      .filter(set => promotion.promotedInducedBindingIds.has(set.bindingId))
      .map(set => ({ set, evidence: constructionCompileEvidence(batch.evidence, input.hasher) }))
  ]);
  for (const item of sets) {
    const compiled = compileLanguageConstructionPattern({
      bindingId: item.set.bindingId,
      profileId: batch.profile.id,
      observations: item.set.observations,
      evidence: item.evidence,
      hasher: input.hasher,
      updatedAt: batch.createdAt
    });
    if (compiled.status === "compiled") constructionPatterns.push(compiled.pattern);
    else warnings.push(...compiled.issues.map(issue => issue.code));
  }

  return {
    observations: uniqueRecords(memories.flatMap(memory => memory.observations)),
    models: uniqueRecords(memories.flatMap(memory => memory.models)),
    units: uniqueRecords(memories.flatMap(memory => memory.units)),
    patterns: uniquePatterns([
      ...memories.flatMap(memory => memory.patterns),
      ...constructionPatterns,
      ...(batch.additionalPatterns ?? [])
    ]),
    semanticFrames: uniqueRecords(memories.flatMap(memory => memory.semanticFrames)),
    constructionPatterns,
    graphSurfaceAlignmentSummaries: sets
      .map(item => item.set.alignmentSummary)
      .filter((summary): summary is JsonValue => summary !== undefined),
    sparseAlignmentCandidateSupports,
    sparseAlignmentCandidateSummaries,
    typedNullCostModel,
    sparseTransportPlans,
    transportEvidenceAllocations,
    constructionCandidates: (batch.constructionSets?.length ?? 0) + inducedSets.length,
    rejectedConstructionCandidates: promotion.report.rejectedInducedConstructionSets,
    constructionPromotion: promotion.report,
    warnings: [...new Set(warnings)].sort(),
    audit: toJsonValue({
      compiler: "kernel.language_training_batch.v1",
      inputUtf16Length: batch.text.length,
      chunks: textChunks.length,
      chunkUtf16Lengths: textChunks.map(text => text.length),
      completeInputCoverage: textChunks.join("") === batch.text,
      memory: memories.map(memory => jsonObject(memory.audit)),
      suppliedConstructionSets: batch.constructionSets?.length ?? 0,
      inducedConstructionSets: inducedSets.length,
      constructionPromotion: promotion.report as unknown as JsonValue,
      graphSurfaceAlignment: sets
        .map(item => item.set.alignmentSummary)
        .filter(summary => summary !== undefined) as JsonValue[],
      sparseTypedIncidenceAlignment: {
        targetIndexId: sparseAlignment?.targetIndex.id ?? null,
        incidenceGraphId: sparseAlignment?.incidenceGraph.id ?? null,
        typedNullCostModel: typedNullCostModel
          ? {
            id: typedNullCostModel.id,
            schema: typedNullCostModel.schema,
            targetIndexId: typedNullCostModel.targetIndexId,
            trainingSupportIds: typedNullCostModel.trainingSupportIds,
            supervision: typedNullCostModel.supervision,
            calibrated: typedNullCostModel.calibrated,
            surface: typedNullCostModel.surface,
            graph: typedNullCostModel.graph,
            audit: typedNullCostModel.audit
          }
          : null,
        supportCount: sparseAlignmentCandidateSupports.length,
        candidateCount: sparseAlignmentCandidateSupports.reduce(
          (sum, support) => sum + support.candidates.length,
          0
        ),
        summaries: sparseAlignmentCandidateSummaries,
        transportPlans: sparseTransportPlans.map(plan => ({
          id: plan.id,
          status: plan.status,
          transportedCellCount: plan.cells.length,
          iterations: plan.iterations.length,
          finalObjective: plan.iterations.at(-1)?.objective ?? null,
          audit: plan.audit
        })),
        evidenceAllocations: transportEvidenceAllocations.map(allocation => ({
          id: allocation.id,
          status: allocation.status,
          totalTransportMass: allocation.totalTransportMass,
          totalAllocatedMass: allocation.totalAllocatedMass,
          conservationResidual: allocation.conservationResidual,
          unresolvedCandidateCount: allocation.unresolvedCandidateIds.length,
          audit: allocation.audit
        }))
      },
      compiledConstructions: constructionPatterns.length,
      constructionWarnings: [...new Set(warnings)].sort()
    })
  };
}

export async function observeLanguageTrainingSegmentation(input: {
  storage: ScceStorage;
  batch: Pick<LanguageTrainingBatch, "text" | "createdAt">;
  tenantId: string;
  corpusRole: string;
  activeImportVersion: string;
  hasher: Hasher;
}): Promise<void> {
  if (!input.storage.segmentationAggregates || !input.batch.text.trim()) return;
  const model = segmentUnicodeSurfaceV2(input.batch.text, input.hasher);
  await input.storage.segmentationAggregates.observeDocument({
    key: {
      segmentationVersion: model.schemaVersion,
      languageCluster: dominantScriptId(input.batch.text),
      tenantId: input.tenantId,
      corpusRole: input.corpusRole,
      activeImportVersion: input.activeImportVersion
    },
    model,
    observedAt: input.batch.createdAt
  });
}

function uniqueConstructionSets(
  sets: readonly SourceBoundLanguageConstructionTrainingSet[]
): SourceBoundLanguageConstructionTrainingSet[] {
  const byBindingId = new Map<string, SourceBoundLanguageConstructionTrainingSet>();
  for (const set of sets) {
    const current = byBindingId.get(set.bindingId);
    if (!current) {
      byBindingId.set(set.bindingId, set);
      continue;
    }
    byBindingId.set(set.bindingId, {
      bindingId: set.bindingId,
      observations: [...current.observations, ...set.observations].slice(0, 256),
      alignmentSummary: current.alignmentSummary ?? set.alignmentSummary
    });
  }
  return [...byBindingId.values()].sort((left, right) => left.bindingId.localeCompare(right.bindingId));
}

function uniqueConstructionWorkItems(
  items: readonly { set: SourceBoundLanguageConstructionTrainingSet; evidence: readonly EvidenceSpan[] }[]
): Array<{ set: SourceBoundLanguageConstructionTrainingSet; evidence: readonly EvidenceSpan[] }> {
  const merged = uniqueConstructionSets(items.map(item => item.set));
  return merged.map(set => ({
    set,
    evidence: items.find(item => item.set.bindingId === set.bindingId)?.evidence ?? []
  }));
}

function uniquePatterns(patterns: readonly LanguagePatternRecord[]): LanguagePatternRecord[] {
  const byId = new Map<string, LanguagePatternRecord>();
  for (const pattern of patterns) if (!byId.has(pattern.id)) byId.set(pattern.id, pattern);
  return [...byId.values()];
}

function uniqueRecords<T extends { id: string }>(records: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record);
  return [...byId.values()];
}

function evaluateConstructionPromotion(input: {
  evidence: readonly EvidenceSpan[];
  profileId: string;
  hasher: Hasher;
  suppliedSets: readonly SourceBoundLanguageConstructionTrainingSet[];
  inducedSets: readonly SourceBoundLanguageConstructionTrainingSet[];
  policy?: LanguageTrainingConstructionPromotionPolicy;
}): { promotedInducedBindingIds: ReadonlySet<string>; report: LanguageTrainingConstructionPromotionReport } {
  const thresholds = {
    minHeldOutOccurrences: Math.max(1, Math.floor(input.policy?.minHeldOutOccurrences ?? 2)),
    minPrePredicateCoverage: clampUnit(input.policy?.minPrePredicateCoverage ?? 0.5),
    minPostPredicateCoverage: clampUnit(input.policy?.minPostPredicateCoverage ?? 0.5)
  };
  const split = splitConstructionEvidence(input.evidence, input.hasher);
  const coverage = split.heldOut.length
    ? evaluateHeldOutConstructionCoverage({
      trainDocuments: evidenceDocuments(split.train),
      heldOutDocuments: evidenceDocuments(split.heldOut),
      profileId: input.profileId,
      hasher: input.hasher
    })
    : [];
  const coverageByBindingId = new Map(coverage.map(row => [row.bindingId, row]));
  const promoted = new Set<string>();
  const rejections: LanguageTrainingConstructionPromotionReport["rejections"] = [];

  for (const set of input.inducedSets) {
    const report = coverageByBindingId.get(set.bindingId);
    const preCoverage = report ? ratio(report.heldOutPrePredicateCovered, report.heldOutOccurrences) : 0;
    const postCoverage = report && report.heldOutPostPredicateOccurrences > 0
      ? ratio(report.heldOutPostPredicateCovered, report.heldOutPostPredicateOccurrences)
      : undefined;
    const reason = !split.heldOut.length
      ? "no_heldout_evidence"
      : !report
        ? "no_heldout_coverage"
        : report.heldOutOccurrences < thresholds.minHeldOutOccurrences
          ? "heldout_occurrences_low"
          : preCoverage < thresholds.minPrePredicateCoverage
            ? "pre_predicate_coverage_low"
            : postCoverage !== undefined && postCoverage < thresholds.minPostPredicateCoverage
              ? "post_predicate_coverage_low"
              : undefined;
    if (!reason) {
      promoted.add(set.bindingId);
      continue;
    }
    rejections.push({
      bindingId: set.bindingId,
      reason,
      heldOutOccurrences: report?.heldOutOccurrences ?? 0,
      prePredicateCoverage: preCoverage,
      ...(postCoverage === undefined ? {} : { postPredicateCoverage: postCoverage })
    });
  }

  return {
    promotedInducedBindingIds: promoted,
    report: {
      schema: "scce.language_training.construction_promotion.v1",
      trainEvidence: split.train.length,
      heldOutEvidence: split.heldOut.length,
      suppliedConstructionSets: input.suppliedSets.length,
      inducedConstructionSets: input.inducedSets.length,
      promotedSuppliedConstructionSets: input.suppliedSets.length,
      promotedInducedConstructionSets: promoted.size,
      rejectedInducedConstructionSets: rejections.length,
      thresholds,
      heldOutCoverage: coverage,
      rejections
    }
  };
}

function constructionTrainEvidence(evidence: readonly EvidenceSpan[], hasher: Hasher): EvidenceSpan[] {
  return splitConstructionEvidence(evidence, hasher).train;
}

function constructionCompileEvidence(evidence: readonly EvidenceSpan[], hasher: Hasher): EvidenceSpan[] {
  const split = splitConstructionEvidence(evidence, hasher);
  return split.heldOut.length ? split.train : [...evidence];
}

function splitConstructionEvidence(evidence: readonly EvidenceSpan[], hasher: Hasher): { train: EvidenceSpan[]; heldOut: EvidenceSpan[] } {
  const promoted = evidence
    .filter(span => span.status === "promoted")
    .sort((left, right) => {
      const source = String(left.sourceVersionId).localeCompare(String(right.sourceVersionId));
      if (source) return source;
      const offset = left.charStart - right.charStart;
      if (offset) return offset;
      return String(left.id).localeCompare(String(right.id));
    });
  if (promoted.length < 3) return { train: promoted, heldOut: [] };

  const heldOut: EvidenceSpan[] = [];
  const train: EvidenceSpan[] = [];
  for (let index = 0; index < promoted.length; index++) {
    const span = promoted[index]!;
    const digest = hasher.digestHex(`${span.sourceVersionId}\u001f${span.id}`);
    const offset = Number.parseInt(digest.slice(0, 2), 16) % 5;
    ((index + offset) % 5 === 4 ? heldOut : train).push(span);
  }
  if (!heldOut.length) {
    heldOut.push(promoted[promoted.length - 1]!);
    train.splice(train.findIndex(span => span.id === heldOut[0]!.id), 1);
  }
  if (train.length < 2) {
    return { train: promoted, heldOut: [] };
  }
  return { train, heldOut };
}

function evidenceDocuments(evidence: readonly EvidenceSpan[]): Array<{ id: string; text: string; evidenceIds: EvidenceSpan["id"][]; sourceVersionId: EvidenceSpan["sourceVersionId"] }> {
  return evidence.map(span => ({
    id: String(span.id),
    text: span.text,
    evidenceIds: [span.id],
    sourceVersionId: span.sourceVersionId
  }));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? clampUnit(numerator / denominator) : 0;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function boundedTrainingTextChunks(text: string, maxUtf16Length = 150_000): string[] {
  if (!text.length) return [""];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxUtf16Length);
    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(maxUtf16Length * 0.75), start + 1);
      const boundary = lastTrainingBoundary(text, searchStart, end);
      if (boundary > start) end = boundary;
      if (end > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
    }
    if (end <= start) end = Math.min(text.length, start + maxUtf16Length);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function lastTrainingBoundary(text: string, minimum: number, end: number): number {
  for (let index = end; index >= minimum; index--) {
    const char = text[index - 1];
    if (char === "\n" || char === "\r" || char === "." || char === "!" || char === "?"
      || char === "\u3002" || char === "\uff01" || char === "\uff1f" || /\s/u.test(char ?? "")) {
      return index;
    }
  }
  return end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
