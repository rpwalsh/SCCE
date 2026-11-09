// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  compileLanguageConstructionPatterns,
  createUniversalCreativeEventConstructionCompiler,
  isCreativeEventConstructionPattern,
  isLanguageConstructionPattern,
  LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS,
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  type CreativeEventConstructionCompiler,
  type SourceBoundLanguageConstructionTrainingSet
} from "./language-construction-memory.js";
import { compileCreativeSourceCorrespondences } from "./creative-source-correspondence.js";
import { compileCreativeSourceUtterancePatterns } from "./creative-source-utterance.js";
import { compileSourceReferenceBindingPattern, type SourceReferenceBindingDeclaration } from "./source-reference-bindings.js";
import type { TranscriptTurn } from "./dialogue-communicative-act-learning.js";
import type { CorpusSegmentationBatchLoader } from "./corpus-segmentation-cursor.js";
import {
  evaluateHeldOutConstructionCoverage,
  induceSourceBoundConstructionTrainingSets,
  prepareConstructionInduction,
  prepareConstructionInductionFromCorpus,
  preparedLanguageInductionProducts,
  sourceLanguageInductionDocuments,
  type PreparedConstructionInduction,
  type HeldOutConstructionCoverageReport
} from "./graph-surface-alignment.js";
import {
  compileSparseAlignmentCandidateSupports,
  type SparseAlignmentCandidateSupport
} from "./sparse-alignment-candidates.js";
import {
  createSparseTransportPlanRetentionInterner,
  prepareSparseTransportSolver,
  type SparseFusedTransportPlan
} from "./sparse-fused-transport.js";
import {
  createTransportEvidenceAllocationRetentionInterner,
  allocateTransportEvidence,
  type TransportEvidenceAllocation
} from "./transport-evidence-allocation.js";
import {
  compileTypedNullCostModel,
  type TypedNullCostModel
} from "./typed-null-alignment.js";
import {
  compilePopulationOrderingModel,
  type PopulationOrderingModel
} from "./population-ordering.js";
import {
  compileCrossDocumentAlignmentModel,
  type CrossDocumentAlignmentModel
} from "./cross-document-alignment.js";
import {
  compileAlignmentAlternativeSet,
  alignmentAlternativeSeriesId,
  extractAlignmentAlternatives,
  type AlignmentAlternativeSet
} from "./alignment-alternatives.js";
import {
  compileAlignmentCommunityRouting,
  compileCoarseToFineAlignmentResult,
  type AlignmentCommunityRouting,
  type CoarseToFineAlignmentResult
} from "./coarse-to-fine-alignment.js";
import {
  compileAlignmentCalibrationModel,
  type AlignmentCalibrationModel,
  type AlignmentCalibrationObservation
} from "./alignment-calibration.js";
import {
  compileAlignmentPromotionModel,
  type AlignmentPromotionModel,
  type AlignmentPromotionObservation
} from "./alignment-promotion.js";
import {
  compileAutomaticAlignmentEvaluation,
  type AutomaticAlignmentEvaluation
} from "./alignment-heldout-evaluation.js";
import {
  compileReversibleConstructionPattern,
  compileReversibleConstructions,
  reversibleConstructionCreationSnapshotId,
  type ReversibleConstruction,
  type ReversibleConstructionRejection
} from "./reversible-construction.js";
import {
  compilePairedAntiUnifiedConstructions,
  compilePairedAntiUnifiedPatterns,
  type PairedAntiUnifiedConstruction
} from "./paired-anti-unification.js";
import {
  selectConstructionGrammarByDescriptionLength,
  type ConstructionGrammarSelection
} from "./construction-grammar-selection.js";
import {
  admittedPairedAntiUnifiedConstructions,
  compileGraphCorrelatedVariabilityModel,
  type GraphCorrelatedVariabilityModel
} from "./graph-correlated-variability.js";
import {
  compileOptionalNullRealizationModel,
  compileOptionalNullRealizationPatterns,
  type OptionalNullRealizationModel
} from "./optional-null-realization.js";
import type { LanguageMemoryRuntime } from "./language-memory-runtime.js";
import { canonicalStringify, createClock, toJsonValue } from "./primitives.js";
import { canonicalGraphemeSegmenter } from "./normalization-contract.js";
import { sourceInductionBatches } from "./source-window-induction.js";
import { inductionCharBudget } from "./training-orchestrator.js";
import { createIdFactory } from "./ids.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "./language-induction-memory.js";
import type { PooledLanguageProfileBinding } from "./pooled-language-profile-binding.js";
import { LANGUAGE_TRAINING_BATCH_RECIPE_ID, LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "./language-training-recipe.js";
import { stampSourceLanguageCompilation } from "./source-language-compilation.js";
import { CORPUS_ROLE_IDS, corpusRoleIdForSourceSystem } from "./corpus-registry.js";
import { buildSurfaceLattice } from "./surface-lattice.js";
import { evidenceSourceFamilyId } from "./source-family.js";
import type {
  LanguagePatternRecord,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  SemanticFrameRecord
} from "./storage.js";
import type { ScceStorage } from "./storage.js";
import { dominantScriptId, reconstructFromSegmentationModel, segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type { InformationLabel } from "./types.js";
import { segmentationAggregateInformationLabel, segmentationAggregateKeyId, segmentationAggregateSpacedRatio } from "./segmentation-aggregate.js";
import type {
  EvidenceSpan,
  GraphSnapshot,
  Hasher,
  JsonValue,
  LanguageProfile,
  SourceVersionId,
  SourceId,
  ContentHash
} from "./types.js";

export { LANGUAGE_TRAINING_BATCH_RECIPE_ID } from "./language-training-recipe.js";

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
  canonicalSource?: { sourceId: SourceId; contentHash: ContentHash };
  text: string;
  evidence: EvidenceSpan[];
  transcriptTurns?: readonly TranscriptTurn[];
  sourceReferenceBindings?: SourceReferenceBindingDeclaration;
  createdAt: number;
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
  retainNgramObservations?: boolean;
  /** Relearn source-owned constructions without replacing an existing full language compilation. */
  artifactScope?: "construction_only";
  /** Train the language layer only: n-gram observations, models, units, frames. No construction induction or alignment. */
  languageOnly?: boolean;
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  preparedInduction?: PreparedConstructionInduction;
  segmentationIdentity?: JsonValue;
  profileBinding?: PooledLanguageProfileBinding;
  /** Owned durable evidence for construction learning; n-grams and graph alignment still use this document's evidence. */
  constructionEvidence?: readonly EvidenceSpan[];
  constructionContextDocuments?: readonly import("./language-induction.js").LanguageInductionDocument[];
  additionalPatterns?: readonly LanguagePatternRecord[];
  graphSnapshot?: GraphSnapshot;
  maxAlignmentCandidateDegree?: number;
  /**
   * Peak-memory bound on surface<->graph alignment (confirmed V8 heap OOM,
   * 3398MB against a 3072MB cap, on a real 21k-source corpus). Alignment
   * builds a full surface lattice per evidence span and cross-products it
   * against every graph target at `maxAlignmentCandidateDegree`, so its
   * cost scales with total lattice mass -- but the only cap upstream was
   * the *storage* chunk size (`maxChunkBytes`, 128KB here), which is far
   * too coarse a unit for alignment. These bound the aggregate rather than
   * the individual dimensions.
   *
   * Windowing is also more correct, not merely cheaper: surface<->graph
   * alignment is local, so a unit at the far end of a 128KB article is not
   * a legitimate candidate for a target at the other end. A prefix window
   * keeps every `sourceUtf16Start/End` offset valid, so construction
   * provenance is unaffected.
   */
  maxAlignmentTextBytes?: number;
  maxAlignmentLattices?: number;
  alignmentAlternativePredecessorSets?: readonly AlignmentAlternativeSet[];
  alignmentCalibrationObservations?: readonly AlignmentCalibrationObservation[];
  alignmentPromotionObservations?: readonly AlignmentPromotionObservation[];
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
  sourceObservedInducedConstructionSets: number;
  failedInducedConstructionSets: number;
  trainDocumentIds: string[];
  heldOutDocumentIds: string[];
  qualificationSample?: JsonValue;
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
  preparedInduction?: PreparedConstructionInduction;
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  semanticFrames: SemanticFrameRecord[];
  constructionPatterns: LanguagePatternRecord[];
  reversibleConstructionPatterns: LanguagePatternRecord[];
  pairedAntiUnifiedConstructionPatterns: LanguagePatternRecord[];
  optionalNullRealizationPatterns: LanguagePatternRecord[];
  graphSurfaceAlignmentSummaries: JsonValue[];
  sparseAlignmentCandidateSupports: SparseAlignmentCandidateSupport[];
  sparseAlignmentCandidateSummaries: JsonValue[];
  alignmentCommunityRoutings: AlignmentCommunityRouting[];
  coarseToFineAlignments: CoarseToFineAlignmentResult[];
  alignmentCalibrationModel: AlignmentCalibrationModel;
  alignmentPromotionModel: AlignmentPromotionModel;
  alignmentHeldoutEvaluation: AutomaticAlignmentEvaluation;
  reversibleConstructions: ReversibleConstruction[];
  reversibleConstructionRejections: ReversibleConstructionRejection[];
  pairedAntiUnifiedConstructions: PairedAntiUnifiedConstruction[];
  admittedPairedAntiUnifiedConstructions: PairedAntiUnifiedConstruction[];
  constructionGrammarSelection: ConstructionGrammarSelection;
  graphCorrelatedVariabilityModel: GraphCorrelatedVariabilityModel;
  optionalNullRealizationModel: OptionalNullRealizationModel;
  pairedAntiUnifiedConstructionRejections:
    ReturnType<typeof compilePairedAntiUnifiedConstructions>["rejections"];
  typedNullCostModel: TypedNullCostModel | null;
  populationOrderingModel: PopulationOrderingModel | null;
  crossDocumentAlignmentModel: CrossDocumentAlignmentModel | null;
  sparseTransportPlans: SparseFusedTransportPlan[];
  transportEvidenceAllocations: TransportEvidenceAllocation[];
  alignmentAlternativeSets: AlignmentAlternativeSet[];
  alternativeTransportEvidenceAllocations: TransportEvidenceAllocation[];
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
  creativeEventCompiler?: CreativeEventConstructionCompiler;
}): CompiledLanguageTrainingBatch {
  const { batch } = input;
  const formalCode = Boolean(batch.sourceSystem && corpusRoleIdForSourceSystem(batch.sourceSystem) === CORPUS_ROLE_IDS.softwareSymbolic);
  const induceNaturalLanguage = !formalCode && !batch.languageOnly;
  const textChunks = boundedTrainingTextChunks(batch.text);
  const memories = batch.artifactScope === "construction_only" ? [] : textChunks.map((text, index) => input.runtime.train({
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
    vocabularyLimit: batch.vocabularyLimit,
    retainObservations: batch.retainNgramObservations,
    retainSemanticFrames: index === 0
  }));
  const ownedConstructionEvidence = batch.constructionEvidence ?? batch.evidence;
  const constructionEvidence = induceNaturalLanguage ? batch.evidence.filter(span => span.status === "promoted") : [];
  const induction = prepareLanguageTrainingInduction({ evidence: constructionEvidence, constructionEvidence: induceNaturalLanguage ? ownedConstructionEvidence : [],
    constructionContextDocuments: induceNaturalLanguage ? batch.constructionContextDocuments : [], hasher: input.hasher,
    prepared: induceNaturalLanguage ? batch.preparedInduction : undefined });
  const preparedInduction = induction.prepared;
  const constructionSplit = induceNaturalLanguage ? induction.split : splitConstructionEvidence(formalCode ? [] : ownedConstructionEvidence, input.hasher);
  const inducedLanguageProducts = induceNaturalLanguage
    ? preparedLanguageInductionProducts({ documents: sourceLanguageInductionDocuments(constructionEvidence), hasher: input.hasher, prepared: preparedInduction })
    : undefined;
  const inducedLanguagePatterns = inducedLanguageProducts?.models.flatMap(model => languageMemoryPatternsFromInducedLanguageModel({
    model, profiles: [batch.profile],
    idFactory: createIdFactory({ hasher: input.hasher, clock: createClock({ fixedTime: 0 }), namespace: "source-language-induction", deterministicReplay: true }),
    sourceSystem: batch.sourceSystem, updatedAt: batch.createdAt,
    ...(batch.profileBinding ? { profileBinding: batch.profileBinding } : {})
  }).patterns) ?? [];
  if (inducedLanguageProducts) inducedLanguagePatterns.push({
    id: `source_induction_coverage_${input.hasher.digestHex(canonicalStringify([batch.profile.id, inducedLanguageProducts.coverage]))}`,
    profileId: batch.profile.id, patternKind: "source_compilation", support: 0, entropy: 0,
    patternJson: toJsonValue({ ...inducedLanguageProducts.coverage, profileId: batch.profile.id, sourceVersionId: batch.sourceVersionId }),
    evidenceIds: constructionEvidence.map(span => span.id), updatedAt: batch.createdAt
  });
  const inducedSets = induceSourceBoundConstructionTrainingSets({
    evidence: constructionEvidence,
    profileId: batch.profile.id,
    hasher: input.hasher,
    preparedInduction,
    graphSnapshot: batch.graphSnapshot
  });
  const maxAlignmentTextBytes = Math.max(512, Math.min(65536, Math.floor(batch.maxAlignmentTextBytes ?? 8192)));
  const maxAlignmentLattices = Math.max(1, Math.min(64, Math.floor(batch.maxAlignmentLattices ?? 8)));
  const alignmentLattices = !formalCode && batch.graphSnapshot?.hyperedges.length
    ? batch.evidence.slice(0, maxAlignmentLattices).map(span => buildSurfaceLattice({
      documentId: String(span.id),
      sourceFamilyId: evidenceSourceFamilyId(span),
      // Prefix window: offsets stay anchored at 0 so every construction's
      // recorded source coordinates remain exact.
      text: alignmentWindowText(span.text, maxAlignmentTextBytes),
      sourceVersionId: span.sourceVersionId,
      evidenceIds: [span.id],
      hasher: input.hasher
    }))
    : [];
  const sparseAlignment = alignmentLattices.length
    ? compileSparseAlignmentCandidateSupports({
      lattices: alignmentLattices,
      nodes: batch.graphSnapshot!.nodes,
      hyperedges: batch.graphSnapshot!.hyperedges,
      maxCandidateDegree: batch.maxAlignmentCandidateDegree,
      hasher: input.hasher
    })
    : undefined;
  const sparseAlignmentCandidateSupports = sparseAlignment?.supports ?? [];
  const transportSolver = sparseAlignment ? prepareSparseTransportSolver({ targetIndex: sparseAlignment.targetIndex }) : undefined;
  if (sparseAlignment && transportSolver) sparseAlignment.targetIndex = transportSolver.targetIndex;
  const alignmentCommunityRoutings = sparseAlignment
    ? sparseAlignmentCandidateSupports.map(support =>
      compileAlignmentCommunityRouting({
        support,
        targetIndex: sparseAlignment.targetIndex,
        hasher: input.hasher
      }))
    : [];
  const routedAlignmentSupports = alignmentCommunityRoutings.map(routing =>
    routing.routedSupport);
  const planRetentionInterner = createSparseTransportPlanRetentionInterner();
  const evidenceAllocationRetentionInterner = createTransportEvidenceAllocationRetentionInterner();
  const typedNullCostModel = sparseAlignment
    ? compileTypedNullCostModel({
      supports: routedAlignmentSupports,
      targetIndex: sparseAlignment.targetIndex,
      hasher: input.hasher
    })
    : null;
  const populationOrderingModel = sparseAlignment
    ? compilePopulationOrderingModel({
      supports: routedAlignmentSupports,
      hasher: input.hasher
    })
    : null;
  const initialSparseTransportPlans = sparseAlignment
    ? routedAlignmentSupports.map(support =>
      planRetentionInterner.compact(transportSolver!.solve({
        support,
        typedNullCostModel: typedNullCostModel!,
        populationOrderingModel: populationOrderingModel!,
        hasher: input.hasher
      })))
    : [];
  const crossDocumentAlignmentModel = sparseAlignment
    ? compileCrossDocumentAlignmentModel({
      supports: routedAlignmentSupports,
      plans: initialSparseTransportPlans,
      targetIndex: sparseAlignment.targetIndex,
      hasher: input.hasher
    })
    : null;
  // Cross-document compilation materializes projections and estimates, with no plan aliases.
  initialSparseTransportPlans.length = 0;
  const sparseTransportPlans = sparseAlignment
    ? routedAlignmentSupports.map(support =>
      planRetentionInterner.compact(transportSolver!.solve({
        support,
        typedNullCostModel: typedNullCostModel!,
        populationOrderingModel: populationOrderingModel!,
        crossDocumentAlignmentModel: crossDocumentAlignmentModel!,
        hasher: input.hasher
      })))
    : [];
  const retainedAlternatives = sparseAlignment
    ? sparseTransportPlans.map((plan, index) => {
      const support = routedAlignmentSupports[index]!;
      const extracted = extractAlignmentAlternatives({
        basePlan: plan,
        support,
        targetIndex: sparseAlignment.targetIndex,
        solver: transportSolver,
        typedNullCostModel: typedNullCostModel!,
        populationOrderingModel: populationOrderingModel!,
        crossDocumentAlignmentModel: crossDocumentAlignmentModel!,
        retentionPolicy: planRetentionInterner,
        hasher: input.hasher
      });
      const evidenceAllocations = extracted.plans.map(alternativePlan =>
        evidenceAllocationRetentionInterner.compact(allocateTransportEvidence({
          plan: alternativePlan,
          support,
          hasher: input.hasher
        })));
      const set = compileAlignmentAlternativeSet({
          seriesId: alignmentAlternativeSeriesId({
            support,
            targetIndex: sparseAlignment.targetIndex,
            hasher: input.hasher
          }),
          plans: extracted.plans,
          evidenceAllocations,
          attemptedBranchCount: extracted.attemptedBranchCount,
          totalBranchCount: extracted.totalBranchCount,
          branchSearchBudget: extracted.branchSearchBudget,
          predecessorSets: batch.alignmentAlternativePredecessorSets,
          omittedSearchBranchCount: extracted.omittedSearchBranchCount,
          hasher: input.hasher
        });
      return {
        evidenceAllocations,
        set,
        result: compileCoarseToFineAlignmentResult({
          routing: alignmentCommunityRoutings[index]!,
          primaryPlan: plan,
          alternativeSet: set,
          hasher: input.hasher
        })
      };
    })
    : [];
  const alignmentAlternativeSets = retainedAlternatives.map(item => item.set);
  const coarseToFineAlignments = retainedAlternatives.map(item => item.result);
  const transportEvidenceAllocations = retainedAlternatives.map((item, index) =>
    item.evidenceAllocations.find(allocation =>
      allocation.transportPlanId === sparseTransportPlans[index]!.id)!);
  const alternativeTransportEvidenceAllocations = retainedAlternatives.flatMap(
    (item, index) => item.evidenceAllocations.filter(allocation =>
      allocation.transportPlanId !== sparseTransportPlans[index]!.id)
  );
  const alignmentHeldoutEvaluation = sparseAlignment
    ? compileAutomaticAlignmentEvaluation({
      alternativeSets: alignmentAlternativeSets,
      supports: routedAlignmentSupports,
      lattices: alignmentLattices,
      referencePlans: sparseTransportPlans,
      evidenceAllocations: retainedAlternatives.flatMap(item =>
        item.evidenceAllocations),
      targetIndex: sparseAlignment.targetIndex,
      hasher: input.hasher
    })
    : {
      artifacts: [],
      promotionObservations: [],
      calibrationObservations: [],
      candidateRecall: {
        evaluatedPlanCount: 0,
        heldoutFamilyEvaluations: 0,
        minimum: 0,
        mean: 0,
        perfectCount: 0
      }
    };
  const alignmentCalibrationModel = compileAlignmentCalibrationModel({
    observations: [
      ...alignmentHeldoutEvaluation.calibrationObservations,
      ...(batch.alignmentCalibrationObservations ?? [])
    ],
    hasher: input.hasher
  });
  const alignmentPromotionModel = compileAlignmentPromotionModel({
    alternativeSets: alignmentAlternativeSets,
    observations: [
      ...alignmentHeldoutEvaluation.promotionObservations,
      ...(batch.alignmentPromotionObservations ?? [])
    ],
    hasher: input.hasher
  });
  // A series accumulates: each set already carries its predecessors, so the newest supersedes the rest. Handing
  // the compiler every generation of a series threw on the duplicate key and lost the whole batch's constructions
  // -- the ingestion lane already collapses them this way.
  const alignmentAlternativeSetsBySeries = new Map<string, AlignmentAlternativeSet>();
  for (const set of alignmentAlternativeSets) alignmentAlternativeSetsBySeries.set(set.seriesId, set);
  const reversibleConstructionCompilation = sparseAlignment
    ? compileReversibleConstructions({
      alternativeSets: [...alignmentAlternativeSetsBySeries.values()],
      promotionModel: alignmentPromotionModel,
      calibrationModel: alignmentCalibrationModel,
      supports: routedAlignmentSupports,
      targetIndex: sparseAlignment.targetIndex,
      lattices: alignmentLattices,
      evidenceAllocations: retainedAlternatives.flatMap(item =>
        item.evidenceAllocations),
      profileId: batch.profile.id,
      creationSnapshotId: reversibleConstructionCreationSnapshotId({
        sourceVersionId: String(batch.sourceVersionId),
        graphNodeIds: batch.graphSnapshot!.nodes.map(node => String(node.id)),
        graphEdgeIds: batch.graphSnapshot!.edges.map(edge => String(edge.id)),
        hyperedgeIds: batch.graphSnapshot!.hyperedges.map(edge => String(edge.id)),
        hasher: input.hasher
      }),
      createdAt: batch.createdAt,
      hasher: input.hasher
    })
    : { constructions: [], rejections: [] };
  const reversibleConstructionPatterns =
    reversibleConstructionCompilation.constructions.map(
      compileReversibleConstructionPattern
    );
  const pairedAntiUnifiedCompilation =
    compilePairedAntiUnifiedConstructions({
      constructions: reversibleConstructionCompilation.constructions,
      createdAt: batch.createdAt,
      creationSnapshotId: `paired_anti_unification_snapshot.${
        input.hasher.digestHex(reversibleConstructionCompilation.constructions
          .map(construction => construction.id).sort().join("\u001f")).slice(0, 40)
      }`,
      hasher: input.hasher
    });
  const graphCorrelatedVariabilityModel =
    compileGraphCorrelatedVariabilityModel({
      constructions: pairedAntiUnifiedCompilation.constructions,
      hasher: input.hasher
    });
  const admittedPairedConstructions =
    admittedPairedAntiUnifiedConstructions({
      constructions: pairedAntiUnifiedCompilation.constructions,
      model: graphCorrelatedVariabilityModel
    });
  const constructionGrammar = selectConstructionGrammarByDescriptionLength({
    constructions: admittedPairedConstructions.map(row => row.construction)
  });
  const retainedPairedConstructions = admittedPairedConstructions.filter(row =>
    constructionGrammar.selection.retainedConstructionIds.includes(row.construction.id));
  const pairedAntiUnifiedConstructionPatterns =
    retainedPairedConstructions.flatMap(({ construction, admission }) =>
      compilePairedAntiUnifiedPatterns(construction, admission));
  const optionalNullRealizationModel =
    compileOptionalNullRealizationModel({
      constructions: reversibleConstructionCompilation.constructions,
      hasher: input.hasher
    });
  const optionalNullRealizationPatterns =
    compileOptionalNullRealizationPatterns(
      optionalNullRealizationModel,
      batch.createdAt
    );
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
    evidence: ownedConstructionEvidence,
    profileId: batch.profile.id,
    hasher: input.hasher,
    suppliedSets: batch.constructionSets ?? [],
    inducedSets,
    split: constructionSplit,
    preparedInduction: !induceNaturalLanguage ? undefined : preparedInduction,
    qualificationDocuments: induction.qualificationDocuments,
    qualificationSample: induction.qualificationSample,
    languageOnly: !induceNaturalLanguage
  });
  const sets = uniqueConstructionSets([...(batch.constructionSets ?? []), ...inducedSets]);
  // Source observation is retained independently of document-heldout generalization qualification.
  const suppliedBindingIds = new Set((batch.constructionSets ?? []).map(set => set.bindingId));
  let failedConstructions = 0;
  const compiledSets = compileLanguageConstructionPatterns({
    profileId: batch.profile.id,
    evidence: batch.evidence,
    hasher: input.hasher,
    updatedAt: batch.createdAt,
    storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
    sets: sets.map(set => ({ ...set,
      ...(!suppliedBindingIds.has(set.bindingId) ? {
        acquisitionStatus: "source_observed" as const
      } : {})
    }))
  });
  let compiledIndex = 0;
  for (const compiled of compiledSets) {
    const set = sets[compiledIndex++]!;
    if (compiled.status === "compiled") {
      if (!suppliedBindingIds.has(set.bindingId)) compiled.pattern.patternJson = {
        ...jsonObject(compiled.pattern.patternJson), constructionQualification: promotion.promotedInducedBindingIds.has(set.bindingId) ? "document_heldout_qualified" : "unqualified"
      };
      constructionPatterns.push(compiled.pattern);
      if (compiled.bundle.acquisitionStatus === "source_observed" && !promotion.promotedInducedBindingIds.has(set.bindingId)) promotion.report.sourceObservedInducedConstructionSets++;
    } else {
      failedConstructions++;
      if (!suppliedBindingIds.has(set.bindingId)) promotion.report.failedInducedConstructionSets++;
      warnings.push(...compiled.issues.map(issue => issue.code));
    }
  }

  const creativeEventCompiler = induceNaturalLanguage ? input.creativeEventCompiler ?? createUniversalCreativeEventConstructionCompiler() : undefined;
  const creativeEventCompilation = creativeEventCompiler?.compile({ profileId: batch.profile.id, evidence: batch.evidence,
    hasher: input.hasher, updatedAt: batch.createdAt, preparedInduction });
  const creativePatterns = creativeEventCompilation?.status === "compiled" ? creativeEventCompilation.patterns ?? [creativeEventCompilation.pattern] : [];
  const ownedCreativePatterns = input.creativeEventCompiler ? creativePatterns.map(pattern => structuredClone(pattern)) : creativePatterns;
  constructionPatterns.push(...ownedCreativePatterns.filter(isLanguageConstructionPattern));
  promotion.report.sourceObservedInducedConstructionSets += ownedCreativePatterns.filter(isCreativeEventConstructionPattern).length;
  if (creativeEventCompilation?.status === "rejected" && creativeEventCompilation.issues.some(issue => issue.code !== LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction)) {
    warnings.push(...creativeEventCompilation.issues.map(issue => issue.code));
  }
  const sourceReferences = batch.sourceReferenceBindings
    ? compileSourceReferenceBindingPattern({ declaration: batch.sourceReferenceBindings, text: batch.text, profileId: batch.profile.id,
      evidence: batch.evidence, hasher: input.hasher, updatedAt: batch.createdAt }) : undefined;
  warnings.push(...(sourceReferences?.issues.map(issue => issue.code) ?? []));
  const referenceBindings = sourceReferences?.bindings ? [sourceReferences.bindings] : [];
  const sourceCorrespondencePatterns = batch.transcriptTurns && creativeEventCompilation?.status === "compiled"
    ? compileCreativeSourceCorrespondences({ turns: batch.transcriptTurns, profileId: batch.profile.id, updatedAt: batch.createdAt,
      evidence: batch.evidence, events: (creativeEventCompilation.bundles ?? [creativeEventCompilation.bundle]).flatMap(bundle => bundle.creativeEvents ?? []),
      referenceBindings, hasher: input.hasher }) : [];
  let sourceUtteranceCandidates = 0;
  let compiledSourceUtterances = 0;
  if (sourceCorrespondencePatterns.length && creativeEventCompilation?.status === "compiled") {
    const eventBundles = creativeEventCompilation.bundles ?? [creativeEventCompilation.bundle];
    const utterances = compileCreativeSourceUtterancePatterns({ patterns: sourceCorrespondencePatterns,
      events: eventBundles.flatMap(bundle => bundle.creativeEvents ?? []), eventBundles,
      profileId: batch.profile.id, evidence: batch.evidence, referenceBindings, hasher: input.hasher, updatedAt: batch.createdAt });
    constructionPatterns.push(...utterances.patterns);
    sourceUtteranceCandidates = utterances.candidateCount;
    compiledSourceUtterances = utterances.patterns.length;
    promotion.report.sourceObservedInducedConstructionSets += compiledSourceUtterances;
    warnings.push(...utterances.rejectionCodes);
    for (const pattern of sourceCorrespondencePatterns) {
      const prerequisites = utterances.prerequisitesByModelId.get(pattern.id);
      if (prerequisites) pattern.patternJson = toJsonValue({ ...jsonObject(pattern.patternJson), sourceUtterancePrerequisites: prerequisites });
    }
  }

  let units = uniqueRecords(memories.flatMap(memory => memory.units));
  let patterns = uniquePatterns([
    ...memories.flatMap(memory => memory.patterns), ...inducedLanguagePatterns, ...constructionPatterns, ...reversibleConstructionPatterns,
    ...pairedAntiUnifiedConstructionPatterns, ...optionalNullRealizationPatterns, ...(batch.additionalPatterns ?? []), ...sourceCorrespondencePatterns,
    ...(sourceReferences?.pattern ? [sourceReferences.pattern] : []),
    ...(sourceCorrespondencePatterns.length ? [{
      id: `source_creative_surface_${input.hasher.digestHex(canonicalStringify([batch.profile.id, batch.sourceVersionId, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID]))}`,
      profileId: batch.profile.id, patternKind: "source_compilation" as const, support: sourceCorrespondencePatterns.length, entropy: 0,
      evidenceIds: [...new Set(sourceCorrespondencePatterns.flatMap(pattern => pattern.evidenceIds))], updatedAt: batch.createdAt,
      patternJson: toJsonValue({ schema: "scce.creative_source_surface_acquisition_receipt.v1", recipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
        profileId: batch.profile.id, sourceVersionId: batch.sourceVersionId, sourceTextHash: input.hasher.digestHex(batch.text),
        modelPatternIds: sourceCorrespondencePatterns.map(pattern => pattern.id).sort() })
    }] : []),
    ...ownedCreativePatterns.filter(pattern => !isLanguageConstructionPattern(pattern))
  ]);
  let semanticFrames = uniqueRecords(memories.flatMap(memory => memory.semanticFrames));
  const rawModels = uniqueRecords(memories.flatMap(memory => memory.models));
  const compileOptions = jsonObject(memories[0]?.audit ?? {}).trainingOptions;
  const stamped = batch.canonicalSource && batch.sourceSystem && compileOptions
    ? stampSourceLanguageCompilation({ owner: { ...batch.canonicalSource, sourceVersionId: batch.sourceVersionId }, profileId: batch.profile.id,
      sourceSystem: batch.sourceSystem, streamId: batch.streamId, text: batch.text, chunks: textChunks, models: rawModels,
      options: { ...(compileOptions as unknown as { maxOrder: number; maxCountersPerOrder: number; vocabularyLimit: number }),
        ...(batch.segmentationIdentity ? { segmentationIdentity: batch.segmentationIdentity } : {}),
        languageOnly: Boolean(batch.languageOnly), retainNgramObservations: batch.retainNgramObservations !== false },
      artifacts: { units, patterns, semanticFrames }, hasher: input.hasher }) : undefined;
  const models = stamped?.models ?? rawModels;
  if (stamped) { units = stamped.units; patterns = stamped.patterns; semanticFrames = stamped.semanticFrames; }
  const patternsById = new Map<string, LanguagePatternRecord>();
  for (const pattern of patterns) if (!patternsById.has(pattern.id)) patternsById.set(pattern.id, pattern);
  return {
    ...(inducedLanguageProducts ? { preparedInduction } : {}),
    observations: uniqueRecords(memories.flatMap(memory => memory.observations)),
    models, units, patterns, semanticFrames,
    constructionPatterns: constructionPatterns.map(record => patternsById.get(record.id) ?? record),
    reversibleConstructionPatterns,
    pairedAntiUnifiedConstructionPatterns,
    optionalNullRealizationPatterns,
    graphSurfaceAlignmentSummaries: sets
      .map(set => set.alignmentSummary)
      .filter((summary): summary is JsonValue => summary !== undefined),
    sparseAlignmentCandidateSupports,
    sparseAlignmentCandidateSummaries,
    alignmentCommunityRoutings,
    coarseToFineAlignments,
    alignmentCalibrationModel,
    alignmentPromotionModel,
    alignmentHeldoutEvaluation,
    reversibleConstructions: reversibleConstructionCompilation.constructions,
    reversibleConstructionRejections:
      reversibleConstructionCompilation.rejections,
    pairedAntiUnifiedConstructions:
      pairedAntiUnifiedCompilation.constructions,
    admittedPairedAntiUnifiedConstructions:
      retainedPairedConstructions.map(row => row.construction),
    constructionGrammarSelection: constructionGrammar.selection,
    graphCorrelatedVariabilityModel,
    optionalNullRealizationModel,
    pairedAntiUnifiedConstructionRejections:
      pairedAntiUnifiedCompilation.rejections,
    typedNullCostModel,
    populationOrderingModel,
    crossDocumentAlignmentModel,
    sparseTransportPlans,
    transportEvidenceAllocations,
    alignmentAlternativeSets,
    alternativeTransportEvidenceAllocations,
    constructionCandidates: (batch.constructionSets?.length ?? 0) + inducedSets.length,
    rejectedConstructionCandidates: failedConstructions,
    constructionPromotion: promotion.report,
    warnings: [...new Set(warnings)].sort(),
    audit: toJsonValue({
      compiler: LANGUAGE_TRAINING_BATCH_RECIPE_ID,
      corpusRole: batch.sourceSystem ? corpusRoleIdForSourceSystem(batch.sourceSystem) : null,
      naturalLanguageInduction: induceNaturalLanguage,
      sourceReferenceBindings: { basis: sourceReferences?.bindings?.basis ?? batch.sourceReferenceBindings?.basis ?? null,
        patterns: sourceReferences?.pattern ? 1 : 0, occurrences: sourceReferences?.bindings?.occurrences.length ?? 0,
        completeProperties: sourceReferences?.bindings?.completeProperties.length ?? 0, issues: sourceReferences?.issues ?? [] },
      creativeEventCompilerId: creativeEventCompiler?.id ?? null,
      creativeSurfaceAcquisitionRecipe: sourceCorrespondencePatterns.length ? CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID : null,
      creativeEventCompilation: creativeEventCompilation?.status ?? null,
      creativeEventSourceCoverage: creativeEventCompilation?.status === "compiled" ? creativeEventCompilation.coverage ?? null : null,
      sourceInductionCoverage: inducedLanguageProducts?.coverage ?? null,
      inputUtf16Length: batch.text.length,
      chunks: textChunks.length,
      chunkUtf16Lengths: textChunks.map(text => text.length),
      completeInputCoverage: textChunks.join("") === batch.text,
      memory: memories.map(memory => jsonObject(memory.audit)),
      suppliedConstructionSets: batch.constructionSets?.length ?? 0,
      inducedConstructionSets: inducedSets.length,
      constructionPromotion: promotion.report as unknown as JsonValue,
      graphSurfaceAlignment: sets
        .map(set => set.alignmentSummary)
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
        populationOrderingModel: populationOrderingModel
          ? {
            id: populationOrderingModel.id,
            schema: populationOrderingModel.schema,
            trainingSupportIds: populationOrderingModel.trainingSupportIds,
            estimateCount: populationOrderingModel.estimates.length,
            globalBackoffCount: populationOrderingModel.globalBackoff.length,
            audit: populationOrderingModel.audit
          }
          : null,
        crossDocumentAlignmentModel: crossDocumentAlignmentModel
          ? {
            id: crossDocumentAlignmentModel.id,
            schema: crossDocumentAlignmentModel.schema,
            sourceFamilyIds: crossDocumentAlignmentModel.sourceFamilyIds,
            projectionCount: crossDocumentAlignmentModel.projections.length,
            estimateCount: crossDocumentAlignmentModel.estimates.length,
            pairwiseDistances: crossDocumentAlignmentModel.pairwiseDistances,
            audit: crossDocumentAlignmentModel.audit
          }
          : null,
        supportCount: sparseAlignmentCandidateSupports.length,
        communityRoutings: alignmentCommunityRoutings.map(routing => ({
          id: routing.id,
          parentSupportId: routing.parentSupportId,
          routedSupportId: routing.routedSupport.id,
          communityCount: routing.communities.length,
          omittedCandidateCount: routing.routes.reduce(
            (sum, route) => sum + route.omittedCandidateCount,
            0
          ),
          audit: routing.audit
        })),
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
        alignmentAlternativeSets: alignmentAlternativeSets.map(set => ({
          id: set.id,
          hypothesisCount: set.hypotheses.length,
          posteriorScope: set.posteriorScope,
          exactGlobalPosteriorClaimed: set.exactGlobalPosteriorClaimed,
          omittedSearchBranchCount: set.omittedSearchBranchCount,
          audit: set.audit
        })),
        coarseToFineAlignments: coarseToFineAlignments.map(result => ({
          id: result.id,
          routingId: result.routingId,
          primaryPlanId: result.primaryPlanId,
          alternativeSetId: result.alternativeSetId,
          termination: result.termination,
          finalObjective: result.finalObjective,
          work: result.work,
          audit: result.audit
        })),
        alignmentCalibrationModel,
        alignmentPromotionModel,
        alignmentHeldoutEvaluation,
        reversibleConstructions: reversibleConstructionCompilation.constructions,
        reversibleConstructionRejections:
          reversibleConstructionCompilation.rejections,
        pairedAntiUnifiedConstructions:
          pairedAntiUnifiedCompilation.constructions,
        admittedPairedAntiUnifiedConstructions:
          admittedPairedConstructions.map(row => row.construction),
        graphCorrelatedVariabilityModel,
        optionalNullRealizationModel,
        pairedAntiUnifiedConstructionRejections:
          pairedAntiUnifiedCompilation.rejections,
        evidenceAllocations: transportEvidenceAllocations.map(allocation => ({
          id: allocation.id,
          status: allocation.status,
          totalTransportMass: allocation.totalTransportMass,
          totalAllocatedMass: allocation.totalAllocatedMass,
          conservationResidual: allocation.conservationResidual,
          unresolvedCandidateCount: allocation.unresolvedCandidateIds.length,
          audit: allocation.audit
        })),
        alternativeEvidenceAllocationCount:
          alternativeTransportEvidenceAllocations.length
      },
      compiledConstructions: constructionPatterns.length,
      sourceUtteranceConstructions: { candidates: sourceUtteranceCandidates, compiled: compiledSourceUtterances,
        rejected: sourceUtteranceCandidates - compiledSourceUtterances },
      compiledReversibleConstructions: reversibleConstructionPatterns.length,
      compiledPairedAntiUnifiedConstructions:
        pairedAntiUnifiedCompilation.constructions.length,
      admittedPairedAntiUnifiedConstructions:
        admittedPairedConstructions.length,
      compiledOptionalNullRealizationPatterns:
        optionalNullRealizationPatterns.length,
      constructionWarnings: [...new Set(warnings)].sort()
    })
  };
}

/** What a corpus has actually observed about one script's word spacing, once enough boundaries exist to say. */
export interface SegmentationSpacingEvidence {
  keyId: string;
  languageCluster: string;
  spacedRatio: number;
  boundaryObservations: number;
  label: InformationLabel;
}

export interface PreparedLanguageTrainingSegmentation {
  key: {
    segmentationVersion: string;
    languageCluster: string;
    tenantId: string;
    corpusRole: string;
    activeImportVersion: string;
  };
  model: ReturnType<typeof segmentUnicodeSurfaceV2>;
  observedAt: number;
  principals: readonly string[];
}

/** Pure segmentation work performed before the durable aggregate write boundary. */
export function prepareLanguageTrainingSegmentation(input: {
  batch: Pick<LanguageTrainingBatch, "text" | "createdAt">;
  tenantId: string;
  corpusRole: string;
  activeImportVersion: string;
  hasher: Hasher;
  principals?: readonly string[];
}): PreparedLanguageTrainingSegmentation | undefined {
  if (input.corpusRole === CORPUS_ROLE_IDS.softwareSymbolic || !input.batch.text.trim()) return undefined;
  const model = segmentUnicodeSurfaceV2(input.batch.text, input.hasher);
  if (input.hasher.digestHex(reconstructFromSegmentationModel(model)) !== model.reconstructionHash) {
    throw new Error("segmentation model does not reconstruct its own surface; refusing to fold it into the corpus aggregate");
  }
  return {
    key: {
      segmentationVersion: model.schemaVersion,
      languageCluster: dominantScriptId(input.batch.text),
      tenantId: input.tenantId,
      corpusRole: input.corpusRole,
      activeImportVersion: input.activeImportVersion
    },
    model,
    observedAt: input.batch.createdAt,
    principals: input.principals ?? []
  };
}

export async function observePreparedLanguageTrainingSegmentation(input: {
  storage: ScceStorage;
  prepared: PreparedLanguageTrainingSegmentation;
}): Promise<SegmentationSpacingEvidence | undefined> {
  if (!input.storage.segmentationAggregates) return undefined;
  const aggregate = await input.storage.segmentationAggregates.observeDocument({
    key: input.prepared.key,
    model: input.prepared.model,
    observedAt: input.prepared.observedAt
  });
  const spacedRatio = segmentationAggregateSpacedRatio(aggregate);
  if (spacedRatio === undefined || aggregate.totalBoundaryObservations < MINIMUM_SPACING_EVIDENCE_OBSERVATIONS) return undefined;
  return {
    keyId: segmentationAggregateKeyId(input.prepared.key),
    languageCluster: input.prepared.key.languageCluster,
    spacedRatio,
    boundaryObservations: aggregate.totalBoundaryObservations,
    label: segmentationAggregateInformationLabel(input.prepared.key, input.prepared.principals)
  };
}

export async function observeLanguageTrainingSegmentation(input: {
  storage: ScceStorage;
  batch: Pick<LanguageTrainingBatch, "text" | "createdAt">;
  tenantId: string;
  corpusRole: string;
  activeImportVersion: string;
  hasher: Hasher;
  principals?: readonly string[];
}): Promise<SegmentationSpacingEvidence | undefined> {
  const prepared = prepareLanguageTrainingSegmentation(input);
  return prepared ? observePreparedLanguageTrainingSegmentation({ storage: input.storage, prepared }) : undefined;
}

const MINIMUM_SPACING_EVIDENCE_OBSERVATIONS = 64;

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
  split?: { train: EvidenceSpan[]; heldOut: EvidenceSpan[] };
  preparedInduction?: PreparedConstructionInduction;
  languageOnly?: boolean;
  qualificationDocuments?: { train: readonly import("./language-induction.js").LanguageInductionDocument[]; heldOut: readonly import("./language-induction.js").LanguageInductionDocument[] };
  qualificationSample?: JsonValue;
}): { promotedInducedBindingIds: ReadonlySet<string>; report: LanguageTrainingConstructionPromotionReport } {
  // Cold-start calibration (2026-08-17): the prior defaults (2 held-out
  // occurrences, 0.5/0.5 coverage) rejected ~97% of induced constructions
  // per book (A Tale of Two Cities: 863 candidates -> 26 promoted,
  // verified in the live training report), which starved the Mouth's
  // generation inventory to the point where the runtime could not compose
  // a single original sentence. One held-out occurrence with a third of
  // predicate coverage still requires the construction to generalize
  // beyond its training split -- it is a validation gate, not a rubber
  // stamp -- while letting a single-book corpus contribute its real
  // recurring constructions. Revisit with corpus-scale calibration once
  // the construction inventory supports held-out generation scoring.
  const thresholds = {
    minHeldOutOccurrences: Math.max(1, Math.floor(input.policy?.minHeldOutOccurrences ?? 1)),
    minPrePredicateCoverage: clampUnit(input.policy?.minPrePredicateCoverage ?? 1 / 3),
    minPostPredicateCoverage: clampUnit(input.policy?.minPostPredicateCoverage ?? 1 / 3)
  };
  const split = input.split ?? splitConstructionEvidence(input.evidence, input.hasher);
  const coverage = !input.languageOnly && split.heldOut.length
    ? evaluateHeldOutConstructionCoverage({
      trainDocuments: input.qualificationDocuments?.train ?? evidenceDocuments(split.train),
      heldOutDocuments: input.qualificationDocuments?.heldOut ?? evidenceDocuments(split.heldOut),
      profileId: input.profileId,
      hasher: input.hasher,
      preparedInduction: input.preparedInduction
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
    // Strong predicate recurrence is generalization evidence in its own
    // right: a construction whose predicate independently recurs 8+ times
    // in the held-out slice has demonstrated cross-split generality even
    // when its exact slot fillers are all novel (verified live: recurring
    // 34 times with every filler unseen scored 0.0 coverage and was
    // rejected, while only formulaic phrasing survived). The override
    // demands 8x the recurrence the coverage path needs.
    const strongRecurrence = Boolean(report && report.heldOutOccurrences >= Math.max(8, thresholds.minHeldOutOccurrences * 8));
    const reason = !split.heldOut.length
      ? "no_heldout_evidence"
      : !report
        ? "no_heldout_coverage"
        : strongRecurrence
          ? undefined
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
      sourceObservedInducedConstructionSets: 0,
      failedInducedConstructionSets: 0,
      trainDocumentIds: [...new Set(split.train.map(evidenceSourceFamilyId))].sort(),
      heldOutDocumentIds: [...new Set(split.heldOut.map(evidenceSourceFamilyId))].sort(),
      ...(input.qualificationSample ? { qualificationSample: input.qualificationSample } : {}),
      thresholds,
      heldOutCoverage: coverage,
      rejections
    }
  };
}

export const SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID = "kernel.source_owned_construction_context.v1" as const;

function qualificationWindowSample(documents: readonly import("./language-induction.js").LanguageInductionDocument[], hasher: Hasher) {
  const budget = inductionCharBudget();
  if (documents.reduce((total, document) => total + Buffer.byteLength(document.text), 0) <= budget) return [...documents];
  const candidates = [...sourceInductionBatches(documents, hasher)].flatMap(batch => batch.documents)
    .map(document => ({ document, bytes: Buffer.byteLength(document.text), rank: hasher.digestHex(document.id) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.document.id.localeCompare(right.document.id));
  let used = 0;
  return candidates.filter(candidate => {
    if (used + candidate.bytes > budget) return false;
    used += candidate.bytes; return true;
  }).map(candidate => candidate.document);
}

interface LanguageTrainingInductionInput {
  evidence: readonly EvidenceSpan[];
  constructionEvidence?: readonly EvidenceSpan[];
  constructionContextDocuments?: readonly import("./language-induction.js").LanguageInductionDocument[];
  hasher: Hasher;
  prepared?: PreparedConstructionInduction;
}

function planLanguageTrainingInduction(input: LanguageTrainingInductionInput) {
  const documents = sourceLanguageInductionDocuments(input.evidence);
  const owned = [...new Map([...(input.constructionEvidence ?? []), ...input.evidence].map(span => [String(span.id), span])).values()];
  const currentIds = new Set(input.evidence.map(span => String(span.id)));
  const parents = new Map(owned.map(span => [String(span.id), span]));
  const boundaries = new Map<string, Set<number>>();
  const context = input.constructionContextDocuments ?? sourceLanguageInductionDocuments(owned.filter(span => !currentIds.has(String(span.id))));
  for (const document of context) {
    const owner = document.sourceWindow?.ownerDocumentId ?? document.id;
    const parent = parents.get(owner);
    const start = document.sourceWindow?.startUtf16 ?? 0;
    const end = document.sourceWindow?.endUtf16 ?? document.text.length;
    if (!parent || parent.status !== "promoted" || document.sourceVersionId !== parent.sourceVersionId
      || !document.evidenceIds?.length || document.evidenceIds.some(id => String(id) !== String(parent.id))
      || String(parent.contentHash).replace(/^sha256_/u, "") !== input.hasher.digestHex(parent.text)
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > parent.text.length
      || parent.text.slice(start, end) !== document.text
      || document.sourceFamilyId !== undefined && document.sourceFamilyId !== evidenceSourceFamilyId(parent)) throw new Error("construction context window is not source-owned");
    let points = boundaries.get(owner);
    if (!points) {
      points = new Set([...canonicalGraphemeSegmenter().segment(parent.text)].map(segment => segment.index));
      points.add(parent.text.length); boundaries.set(owner, points);
    }
    if (!points.has(start) || !points.has(end)) throw new Error("construction context window splits an owned grapheme");
  }
  const sourceContext = context.map(document => ({ ...document, sourceFamilyId: evidenceSourceFamilyId(parents.get(document.sourceWindow?.ownerDocumentId ?? document.id)!) }));
  const sampledContext = qualificationWindowSample(sourceContext, input.hasher);
  const sampledOwners = new Set([...currentIds, ...sampledContext.flatMap(document => document.evidenceIds ?? []).map(String)]);
  const split = splitConstructionEvidence(owned.filter(span => sampledOwners.has(String(span.id))), input.hasher);
  const fit = new Set(split.train.map(span => String(span.id)));
  const heldOut = new Set(split.heldOut.map(span => String(span.id)));
  const sampledCurrent = qualificationWindowSample(documents.map(document => ({ ...document,
    sourceFamilyId: evidenceSourceFamilyId(parents.get(document.id)!) })), input.hasher);
  const all = [...sampledCurrent, ...sampledContext];
  const qualificationDocuments = {
    train: all.filter(document => document.evidenceIds?.every(id => fit.has(String(id)))),
    heldOut: all.filter(document => document.evidenceIds?.every(id => heldOut.has(String(id))))
  };
  const heldFamilies = new Set(split.heldOut.map(evidenceSourceFamilyId));
  if (split.train.some(span => heldFamilies.has(evidenceSourceFamilyId(span)))) throw new Error("construction qualification families overlap");
  const describe = (selected: typeof documents) => ({ utf16Length: selected.reduce((total, document) => total + document.text.length, 0),
    byteLength: selected.reduce((total, document) => total + Buffer.byteLength(document.text), 0), windows: selected.map(document => ({
      ownerDocumentId: document.sourceWindow?.ownerDocumentId ?? document.id, startUtf16: document.sourceWindow?.startUtf16 ?? 0,
      endUtf16: document.sourceWindow?.endUtf16 ?? document.text.length, sourceVersionId: document.sourceVersionId,
      evidenceIds: document.evidenceIds, sourceFamilyId: document.sourceFamilyId ?? evidenceSourceFamilyId(parents.get(document.sourceWindow?.ownerDocumentId ?? document.id)!) })) });
  const qualificationSample = toJsonValue({ schema: "scce.construction_qualification_sample.v1", completeSourceProof: false,
    current: describe(sampledCurrent), prior: describe(sampledContext), fitFamilies: [...new Set(split.train.map(evidenceSourceFamilyId))].sort(),
    heldOutFamilies: [...heldFamilies].sort() });
  return { documents, sampledContext, qualificationDocuments, qualificationSample, split };
}

export function prepareLanguageTrainingInduction(input: LanguageTrainingInductionInput) {
  const plan = planLanguageTrainingInduction(input);
  const prepared = prepareConstructionInduction({ documents: plan.documents, hasher: input.hasher, contextDocuments: plan.sampledContext,
    additionalDocumentSets: plan.split.heldOut.length ? [plan.qualificationDocuments.train] : [], ...(input.prepared ? { prepared: input.prepared } : {}) });
  return { prepared, qualificationDocuments: plan.qualificationDocuments, qualificationSample: plan.qualificationSample, split: plan.split };
}

export async function prepareLanguageTrainingInductionFromCorpus(input: LanguageTrainingInductionInput & { corpusLoader: CorpusSegmentationBatchLoader }) {
  const plan = planLanguageTrainingInduction(input);
  const prepared = await prepareConstructionInductionFromCorpus({ documents: plan.documents, hasher: input.hasher, contextDocuments: plan.sampledContext,
    additionalDocumentSets: plan.split.heldOut.length ? [plan.qualificationDocuments.train] : [], corpusLoader: input.corpusLoader,
    ...(input.prepared ? { prepared: input.prepared } : {}) });
  return { prepared, qualificationDocuments: plan.qualificationDocuments, qualificationSample: plan.qualificationSample, split: plan.split };
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
  const documents = new Map<string, EvidenceSpan[]>();
  for (const span of promoted) {
    const key = evidenceSourceFamilyId(span);
    const spans = documents.get(key) ?? [];
    spans.push(span);
    documents.set(key, spans);
  }
  const orderedDocuments = [...documents.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (orderedDocuments.length < 3) return { train: promoted, heldOut: [] };

  const heldOut: EvidenceSpan[] = [];
  const train: EvidenceSpan[] = [];
  for (let index = 0; index < orderedDocuments.length; index++) {
    const [documentId, spans] = orderedDocuments[index]!;
    const digest = hasher.digestHex(documentId);
    // Every version and chunk of a source family stays in one partition.
    const offset = Number.parseInt(digest.slice(0, 2), 16) % 3;
    ((index + offset) % 3 === 2 ? heldOut : train).push(...spans);
  }
  if (!heldOut.length) {
    const [documentId, spans] = orderedDocuments[orderedDocuments.length - 1]!;
    heldOut.push(...spans);
    for (let index = train.length - 1; index >= 0; index--) {
      if (evidenceSourceFamilyId(train[index]!) === documentId) train.splice(index, 1);
    }
  }
  while (new Set(train.map(evidenceSourceFamilyId)).size < 2) {
    const documentId = evidenceSourceFamilyId(heldOut[0]!);
    for (let index = heldOut.length - 1; index >= 0; index--) {
      if (evidenceSourceFamilyId(heldOut[index]!) === documentId) train.push(...heldOut.splice(index, 1));
    }
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

function boundedTrainingTextChunks(text: string, maxUtf16Length = LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT): string[] {
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

/** Bounded prefix of a span's text for alignment only, cut on a UTF-8 boundary so the window never splits a character. Never used for evidence identity, n-gram training, or persistence -- only to bound lattice mass. */
function alignmentWindowText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buffer.length;
  while (end > 0 && (buffer[end] !== undefined) && ((buffer[end]! & 0xc0) === 0x80)) end--;
  return buffer.subarray(0, end).toString("utf8");
}
