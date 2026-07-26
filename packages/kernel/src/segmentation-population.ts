import {
  BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA,
  boundaryNegativeLogLikelihood,
  fitBoundaryEstimator,
  mergeBoundaryStatistics,
  type BoundaryEstimatorMixture,
  type BoundaryEstimatorModel,
  type BoundarySufficientStatistics
} from "./boundary-estimator.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const SEGMENTATION_POPULATION_SCHEMA = "scce.segmentation_population_model.v3" as const;

export interface SegmentationPopulationTrainingDocument {
  documentId: string;
  /** Copy/mirror/derivation family. Members are never split across partitions. */
  sourceFamilyId?: string;
  statistics: BoundarySufficientStatistics;
}

export interface SegmentationPopulation {
  id: string;
  prior: number;
  documentIds: string[];
  statistics: BoundarySufficientStatistics;
  estimator: BoundaryEstimatorModel;
  trainingMass: number;
  lineage: {
    parentPopulationId: string;
    selectedPopulationCount: number;
    contentSignature: string;
  };
}

export interface SegmentationPopulationAssignment {
  documentId: string;
  selectedPopulationId: string;
  posterior: Array<{
    populationId: string;
    probability: number;
    negativeLogLikelihood: number;
    averageLogLoss: number;
    documentMass: number;
  }>;
}

export interface SegmentationPopulationModel {
  schema: typeof SEGMENTATION_POPULATION_SCHEMA;
  id: string;
  rootPopulationId: string;
  populations: SegmentationPopulation[];
  assignments: SegmentationPopulationAssignment[];
  assignmentIndex: Record<string, number>;
  selection: {
    fitDocumentIds: string[];
    modelSelectionDocumentIds: string[];
    mergeGuardDocumentIds: string[];
    finalEvaluationDocumentIds: string[];
    sourceFamilyDisjoint: boolean;
    holdoutDocumentIds: string[];
    candidates: Array<{
      populations: number;
      heldoutDataNats: number;
      modelNats: number;
      descriptionNats: number;
      collapsed: boolean;
      mergeBlocked: boolean;
      mergeDescriptionDeltaNats: number | null;
      heldoutRegressionPopulationIds: string[];
    }>;
    selectedPopulationCount: number;
    baselineDescriptionNats: number;
    selectedDescriptionNats: number;
    mdlGainNats: number;
    finalEvaluationNats: number;
  };
  audit: JsonValue;
}

interface CandidateFit {
  populationCount: number;
  assignments: number[];
  estimators: BoundaryEstimatorModel[];
  priors: number[];
  heldoutDataNats: number;
  modelNats: number;
  descriptionNats: number;
  collapsed: boolean;
  mergeBlocked: boolean;
  mergeDescriptionDeltaNats: number | null;
  heldoutRegressionPopulationIds: string[];
}

const MIN_DOCUMENTS_PER_POPULATION = 2;

export function learnSegmentationPopulations(input: {
  rootPopulationId: string;
  documents: readonly SegmentationPopulationTrainingDocument[];
  maxPopulations?: number;
  mergeDescriptionMarginNats?: number;
  heldoutRegressionToleranceNats?: number;
  hasher?: Hasher;
}): SegmentationPopulationModel {
  const hasher = input.hasher ?? createHasher();
  const documents = [...input.documents]
    .filter(document => document.statistics.positiveMass + document.statistics.negativeMass > 0)
    .sort((left, right) => left.documentId.localeCompare(right.documentId));
  const partitions = sourceFamilyDisjointPartitions(documents, hasher);
  const fit = partitions.fit;
  const selection = partitions.modelSelection;
  const mergeGuard = [...partitions.modelSelection, ...partitions.mergeGuard];
  const maximum = Math.max(1, Math.min(
    Math.floor(input.maxPopulations ?? 8),
    Math.max(1, Math.floor(fit.length / MIN_DOCUMENTS_PER_POPULATION))
  ));
  const candidateFits: CandidateFit[] = [];
  for (let populationCount = 1; populationCount <= maximum; populationCount += 1) {
    candidateFits.push(fitPopulationCandidate({
      rootPopulationId: input.rootPopulationId,
      fit,
      holdout: selection,
      populationCount,
      hasher
    }));
  }
  applyMergeGuards({
    candidates: candidateFits,
    holdout: mergeGuard,
    descriptionMarginNats: Math.max(0, input.mergeDescriptionMarginNats ?? 1),
    heldoutRegressionToleranceNats: Math.max(
      0,
      input.heldoutRegressionToleranceNats ?? 0.01
    )
  });
  const legalCandidates = candidateFits.filter(candidate =>
    !candidate.collapsed && !candidate.mergeBlocked);
  const baseline = candidateFits.find(candidate =>
    candidate.populationCount === 1 && !candidate.collapsed)
    ?? emptyCandidate();
  const selected = legalCandidates
    .sort((left, right) =>
      left.descriptionNats - right.descriptionNats
      || left.populationCount - right.populationCount)[0]
    ?? baseline;

  const finalTrainingDocuments = [
    ...partitions.fit,
    ...partitions.modelSelection,
    ...partitions.mergeGuard
  ].sort((left, right) => left.documentId.localeCompare(right.documentId));
  const finalFit = fitPopulationCandidate({
    rootPopulationId: input.rootPopulationId,
    fit: finalTrainingDocuments,
    holdout: [],
    populationCount: selected.populationCount,
    hasher
  });
  const finalGroups = groupDocuments(
    finalTrainingDocuments,
    finalFit.assignments,
    finalFit.populationCount
  );
  const populations = finalGroups.map((group, index) => {
    const provisionalId = `${input.rootPopulationId}.candidate.final.${index}`;
    const provisionalStatistics = mergeBoundaryStatistics(
      group.map(document => document.statistics),
      hasher,
      provisionalId
    );
    const provisionalEstimator = fitCalibratedEstimatorForDocuments(group, provisionalId, hasher);
    const prior = quantize(group.length / Math.max(1, finalTrainingDocuments.length));
    const contentSignature = hasher.digestHex(JSON.stringify({
      rootPopulationId: input.rootPopulationId,
      prior,
      positiveMass: provisionalStatistics.positiveMass,
      negativeMass: provisionalStatistics.negativeMass,
      rows: provisionalStatistics.rows,
      weights: provisionalEstimator.weights,
      intercept: provisionalEstimator.intercept,
      calibration: provisionalEstimator.calibration
    }));
    const id = `${input.rootPopulationId}.component.${contentSignature.slice(0, 32)}`;
    const statistics = mergeBoundaryStatistics(group.map(document => document.statistics), hasher, id);
    const estimator = fitCalibratedEstimatorForDocuments(group, id, hasher);
    return {
      id,
      prior,
      documentIds: group.map(document => document.documentId).sort(),
      statistics,
      estimator,
      trainingMass: quantize(boundaryNegativeLogLikelihood(estimator, statistics).mass),
      lineage: {
        parentPopulationId: input.rootPopulationId,
        selectedPopulationCount: selected.populationCount,
        contentSignature
      }
    };
  });
  const assignments = documents.map(document =>
    assignmentForDocument(document, populations));
  const assignmentIndex = Object.fromEntries(assignments.map((assignment, index) => [
    assignment.documentId,
    index
  ]));
  const finalEvaluationNats = quantize(partitions.finalEvaluation.reduce((sum, document) =>
    sum + mixtureNegativeLogLikelihood(
      document.statistics,
      populations.map(population => population.estimator),
      populations.map(population => population.prior)
    ), 0));
  const canonical = {
    schema: SEGMENTATION_POPULATION_SCHEMA,
    rootPopulationId: input.rootPopulationId,
    populations: populations.map(population => ({
      id: population.id,
      prior: population.prior,
      documentIds: population.documentIds,
      statisticsId: population.statistics.id,
      estimatorId: population.estimator.id,
      lineage: population.lineage
    })),
    assignments,
    assignmentIndex,
    selection: {
      fitDocumentIds: fit.map(document => document.documentId),
      modelSelectionDocumentIds: selection.map(document => document.documentId),
      mergeGuardDocumentIds: partitions.mergeGuard.map(document => document.documentId),
      finalEvaluationDocumentIds: partitions.finalEvaluation.map(document => document.documentId),
      sourceFamilyDisjoint: true,
      holdoutDocumentIds: selection.map(document => document.documentId),
      candidates: candidateFits.map(candidate => ({
        populations: candidate.populationCount,
        heldoutDataNats: candidate.heldoutDataNats,
        modelNats: candidate.modelNats,
        descriptionNats: candidate.descriptionNats,
        collapsed: candidate.collapsed,
        mergeBlocked: candidate.mergeBlocked,
        mergeDescriptionDeltaNats: candidate.mergeDescriptionDeltaNats,
        heldoutRegressionPopulationIds: candidate.heldoutRegressionPopulationIds
      })),
      selectedPopulationCount: populations.length,
      baselineDescriptionNats: baseline.descriptionNats,
      selectedDescriptionNats: selected.descriptionNats,
      mdlGainNats: quantize(baseline.descriptionNats - selected.descriptionNats),
      finalEvaluationNats
    }
  };
  return {
    ...canonical,
    id: `segmentation_population.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    populations,
    audit: toJsonValue({
      learner: "kernel.segmentation_population.source_family_mdl.v3",
      documentDisjointSelection: true,
      sourceFamilyDisjointSelection: true,
      posterior: "generative_document_nll",
      languageLabelsOrLanguageSpecificRoutingUsed: false,
      unicodeStructuralPropertiesMayBeUniversalFeatures: true,
      mergeGuard: {
        descriptionMarginNats: Math.max(0, input.mergeDescriptionMarginNats ?? 1),
        heldoutRegressionToleranceNats: Math.max(
          0,
          input.heldoutRegressionToleranceNats ?? 0.01
        ),
        childPopulationHeldoutNonRegressionRequired: true
      },
      minimumDocumentsPerPopulation: MIN_DOCUMENTS_PER_POPULATION,
      candidatePopulationCounts: candidateFits.length,
      collapsedCandidatesRejected: candidateFits.filter(candidate => candidate.collapsed).length
    })
  };
}

export function boundaryMixtureForDocument(
  model: SegmentationPopulationModel,
  documentId: string,
  hasher: Hasher = createHasher()
): BoundaryEstimatorMixture {
  if (!model.populations.length) throw new Error("segmentation population model is empty");
  const assignmentPosition = model.assignmentIndex[documentId];
  const assignment = assignmentPosition === undefined
    ? undefined
    : model.assignments[assignmentPosition];
  if (!assignment) {
    throw new Error(
      `unseen document ${documentId} requires boundaryMixtureForStatistics`
    );
  }
  return boundaryMixtureFromAssignment(model, assignment, documentId, hasher);
}

export function boundaryMixtureForStatistics(
  model: SegmentationPopulationModel,
  documentId: string,
  statistics: BoundarySufficientStatistics,
  hasher: Hasher = createHasher()
): BoundaryEstimatorMixture {
  if (!model.populations.length) throw new Error("segmentation population model is empty");
  const assignment = assignmentForDocument({ documentId, statistics }, model.populations);
  return boundaryMixtureFromAssignment(model, assignment, documentId, hasher);
}

function boundaryMixtureFromAssignment(
  model: SegmentationPopulationModel,
  assignment: SegmentationPopulationAssignment,
  documentId: string,
  hasher: Hasher
): BoundaryEstimatorMixture {
  const weights = new Map(assignment.posterior.map(row => [row.populationId, row.probability]));
  const components = model.populations.map(population => ({
    populationId: population.id,
    weight: weights.get(population.id) ?? 0,
    estimator: population.estimator
  }));
  const canonical = {
    schema: BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA,
    populationModelId: model.id,
    documentId,
    components: components.map(component => ({
      populationId: component.populationId,
      weight: component.weight,
      estimatorId: component.estimator.id
    }))
  };
  return {
    schema: BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA,
    id: `boundary_estimator_mixture.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    populationModelId: model.id,
    components
  };
}

function fitPopulationCandidate(input: {
  rootPopulationId: string;
  fit: readonly SegmentationPopulationTrainingDocument[];
  holdout: readonly SegmentationPopulationTrainingDocument[];
  populationCount: number;
  hasher: Hasher;
}): CandidateFit {
  if (!input.fit.length) {
    return { ...emptyCandidate(), populationCount: input.populationCount, collapsed: input.populationCount > 1 };
  }
  if (input.populationCount > 1
    && input.fit.length < input.populationCount * MIN_DOCUMENTS_PER_POPULATION) {
    return { ...emptyCandidate(), populationCount: input.populationCount, collapsed: input.populationCount > 1 };
  }
  let assignments = initialAssignments(input.fit, input.populationCount);
  let estimators: BoundaryEstimatorModel[] = [];
  let priors: number[] = [];
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const groups = groupDocuments(input.fit, assignments, input.populationCount);
    const minimum = input.populationCount === 1 ? 1 : MIN_DOCUMENTS_PER_POPULATION;
    if (groups.some(group => group.length < minimum)) {
      return { ...emptyCandidate(), populationCount: input.populationCount, collapsed: true };
    }
    estimators = groups.map((group, index) => fitBoundaryEstimator({
      statistics: mergeBoundaryStatistics(
        group.map(document => document.statistics),
        input.hasher,
        `${input.rootPopulationId}.candidate.${input.populationCount}.${index}`
      ),
      hasher: input.hasher
    }));
    priors = groups.map(group => group.length / input.fit.length);
    const costs = input.fit.map(document => estimators.map(estimator =>
      boundaryNegativeLogLikelihood(estimator, document.statistics).averageLogLoss));
    const next = repairCollapsedAssignments(
      costs.map(row => indexOfMinimum(row)),
      costs,
      input.populationCount,
      minimum
    );
    if (!next) return { ...emptyCandidate(), populationCount: input.populationCount, collapsed: true };
    if (next.every((value, index) => value === assignments[index])) break;
    assignments = next;
  }
  const finalGroups = groupDocuments(input.fit, assignments, input.populationCount);
  estimators = finalGroups.map((group, index) => fitBoundaryEstimator({
    statistics: mergeBoundaryStatistics(
      group.map(document => document.statistics),
      input.hasher,
      `${input.rootPopulationId}.candidate.${input.populationCount}.${index}`
    ),
    hasher: input.hasher
  }));
  priors = finalGroups.map(group => group.length / input.fit.length);
  const heldoutDataNats = quantize(input.holdout.reduce((sum, document) =>
    sum + mixtureNegativeLogLikelihood(document.statistics, estimators, priors), 0));
  const mass = input.fit.reduce((sum, document) =>
    sum + (document.statistics.positiveMass + document.statistics.negativeMass) / 1_024, 0);
  const parametersPerEstimator = (estimators[0]?.weights.length ?? 0) + 1;
  const parameterCount = input.populationCount * parametersPerEstimator
    + Math.max(0, input.populationCount - 1);
  const parameterNats = 0.5 * parameterCount * Math.log(Math.max(2, mass));
  const assignmentNats = assignments.reduce((sum, assignment) =>
    sum - Math.log(Math.max(1e-12, priors[assignment] ?? 0)), 0);
  const modelNats = quantize(parameterNats + assignmentNats);
  return {
    populationCount: input.populationCount,
    assignments,
    estimators,
    priors,
    heldoutDataNats,
    modelNats,
    descriptionNats: quantize(heldoutDataNats + modelNats),
    collapsed: false,
    mergeBlocked: false,
    mergeDescriptionDeltaNats: null,
    heldoutRegressionPopulationIds: []
  };
}

function applyMergeGuards(input: {
  candidates: CandidateFit[];
  holdout: readonly SegmentationPopulationTrainingDocument[];
  descriptionMarginNats: number;
  heldoutRegressionToleranceNats: number;
}): void {
  for (const coarse of input.candidates) {
    if (coarse.collapsed) continue;
    const fine = input.candidates.find(candidate =>
      !candidate.collapsed
      && candidate.populationCount === coarse.populationCount + 1);
    if (!fine) continue;
    const descriptionDelta = quantize(coarse.descriptionNats - fine.descriptionNats);
    const regressions: string[] = [];
    const lossesByFinePopulation = new Map<number, Array<{ fine: number; coarse: number }>>();
    for (const document of input.holdout) {
      const fineLosses = fine.estimators.map(estimator =>
        boundaryNegativeLogLikelihood(estimator, document.statistics).averageLogLoss);
      const coarseLosses = coarse.estimators.map(estimator =>
        boundaryNegativeLogLikelihood(estimator, document.statistics).averageLogLoss);
      const fineIndex = indexOfMinimum(fineLosses);
      const rows = lossesByFinePopulation.get(fineIndex) ?? [];
      rows.push({
        fine: fineLosses[fineIndex] ?? Number.POSITIVE_INFINITY,
        coarse: Math.min(...coarseLosses)
      });
      lossesByFinePopulation.set(fineIndex, rows);
    }
    for (let index = 0; index < fine.populationCount; index += 1) {
      const rows = lossesByFinePopulation.get(index) ?? [];
      if (!rows.length) {
        const estimator = fine.estimators[index]!;
        const redundant = fine.estimators.some((other, otherIndex) =>
          otherIndex !== index && estimatorDistance(estimator, other) <= 1e-6);
        if (!redundant) {
          regressions.push(`candidate.${fine.populationCount}.population.${index}.missing_evaluation_coverage`);
        }
        continue;
      }
      const fineMean = rows.reduce((sum, row) => sum + row.fine, 0) / rows.length;
      const coarseMean = rows.reduce((sum, row) => sum + row.coarse, 0) / rows.length;
      if (coarseMean > fineMean + input.heldoutRegressionToleranceNats) {
        regressions.push(`candidate.${fine.populationCount}.population.${index}`);
      }
    }
    coarse.mergeDescriptionDeltaNats = descriptionDelta;
    coarse.heldoutRegressionPopulationIds = regressions;
    coarse.mergeBlocked = descriptionDelta >= -input.descriptionMarginNats
      || regressions.length > 0;
  }
}

function estimatorDistance(
  left: BoundaryEstimatorModel,
  right: BoundaryEstimatorModel
): number {
  const width = Math.max(left.weights.length, right.weights.length);
  let distance = Math.abs(left.intercept - right.intercept);
  for (let index = 0; index < width; index += 1) {
    distance += Math.abs((left.weights[index] ?? 0) - (right.weights[index] ?? 0));
  }
  return distance / Math.max(1, width + 1);
}

function assignmentForDocument(
  document: SegmentationPopulationTrainingDocument,
  populations: readonly SegmentationPopulation[]
): SegmentationPopulationAssignment {
  const rows = populations.map(population => {
    const score = boundaryNegativeLogLikelihood(population.estimator, document.statistics);
    return {
      populationId: population.id,
      negativeLogLikelihood: score.negativeLogLikelihood,
      averageLogLoss: score.averageLogLoss,
      documentMass: score.mass,
      logWeight: Math.log(Math.max(1e-12, population.prior)) - score.negativeLogLikelihood
    };
  });
  const logZ = logSumExp(rows.map(row => row.logWeight));
  const posterior = rows.map(row => ({
    populationId: row.populationId,
    probability: quantize(clamp01(Math.exp(row.logWeight - logZ))),
    negativeLogLikelihood: row.negativeLogLikelihood,
    averageLogLoss: row.averageLogLoss,
    documentMass: row.documentMass
  })).sort((left, right) =>
    right.probability - left.probability
    || left.populationId.localeCompare(right.populationId));
  return {
    documentId: document.documentId,
    selectedPopulationId: posterior[0]!.populationId,
    posterior
  };
}

function mixtureNegativeLogLikelihood(
  statistics: BoundarySufficientStatistics,
  estimators: readonly BoundaryEstimatorModel[],
  priors: readonly number[]
): number {
  return -logSumExp(estimators.map((estimator, index) =>
    Math.log(Math.max(1e-12, priors[index] ?? 0))
    - boundaryNegativeLogLikelihood(estimator, statistics).negativeLogLikelihood));
}

function documentDisjointSplit(
  documents: readonly SegmentationPopulationTrainingDocument[],
  hasher: Hasher
): {
  fit: SegmentationPopulationTrainingDocument[];
  holdout: SegmentationPopulationTrainingDocument[];
} {
  if (documents.length < 4) return { fit: [...documents], holdout: [] };
  const families = [...new Set(documents.map(document =>
    document.sourceFamilyId?.trim() || document.documentId))]
    .map(familyId => ({
      familyId,
      rank: hasher.digestHex(`segmentation-population-holdout\u001f${familyId}`)
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank));
  const holdoutCount = Math.max(1, Math.floor(families.length / 5));
  const holdoutFamilies = new Set(families.slice(0, holdoutCount).map(row => row.familyId));
  return {
    fit: documents.filter(document =>
      !holdoutFamilies.has(document.sourceFamilyId?.trim() || document.documentId)),
    holdout: documents.filter(document =>
      holdoutFamilies.has(document.sourceFamilyId?.trim() || document.documentId))
  };
}

function sourceFamilyDisjointPartitions(
  documents: readonly SegmentationPopulationTrainingDocument[],
  hasher: Hasher
): {
  fit: SegmentationPopulationTrainingDocument[];
  modelSelection: SegmentationPopulationTrainingDocument[];
  mergeGuard: SegmentationPopulationTrainingDocument[];
  finalEvaluation: SegmentationPopulationTrainingDocument[];
} {
  if (documents.length < 8) {
    return { fit: [...documents], modelSelection: [], mergeGuard: [], finalEvaluation: [] };
  }
  const byFamily = new Map<string, SegmentationPopulationTrainingDocument[]>();
  for (const document of documents) {
    const family = document.sourceFamilyId?.trim() || document.documentId;
    const bucket = byFamily.get(family) ?? [];
    bucket.push(document);
    byFamily.set(family, bucket);
  }
  const rankedFamilies = [...byFamily.keys()].sort((left, right) => {
    const leftRank = hasher.digestHex(`segmentation-population-partition\u001f${left}`);
    const rightRank = hasher.digestHex(`segmentation-population-partition\u001f${right}`);
    return leftRank.localeCompare(rightRank) || left.localeCompare(right);
  });
  const familyCount = rankedFamilies.length;
  if (familyCount < 4) {
    return { fit: [...documents], modelSelection: [], mergeGuard: [], finalEvaluation: [] };
  }
  const finalCount = Math.max(1, Math.floor(familyCount * 0.15));
  const guardCount = Math.max(1, Math.floor(familyCount * 0.15));
  const selectionCount = Math.max(1, Math.floor(familyCount * 0.2));
  const finalFamilies = new Set(rankedFamilies.slice(0, finalCount));
  const guardFamilies = new Set(rankedFamilies.slice(finalCount, finalCount + guardCount));
  const selectionFamilies = new Set(rankedFamilies.slice(
    finalCount + guardCount,
    finalCount + guardCount + selectionCount
  ));
  const groups = {
    fit: [] as SegmentationPopulationTrainingDocument[],
    modelSelection: [] as SegmentationPopulationTrainingDocument[],
    mergeGuard: [] as SegmentationPopulationTrainingDocument[],
    finalEvaluation: [] as SegmentationPopulationTrainingDocument[]
  };
  for (const document of documents) {
    const family = document.sourceFamilyId?.trim() || document.documentId;
    if (finalFamilies.has(family)) groups.finalEvaluation.push(document);
    else if (guardFamilies.has(family)) groups.mergeGuard.push(document);
    else if (selectionFamilies.has(family)) groups.modelSelection.push(document);
    else groups.fit.push(document);
  }
  return groups;
}

function fitCalibratedEstimatorForDocuments(
  documents: readonly SegmentationPopulationTrainingDocument[],
  populationId: string,
  hasher: Hasher
): BoundaryEstimatorModel {
  const split = documentDisjointSplit(documents, hasher);
  const trainingStatistics = mergeBoundaryStatistics(
    split.fit.map(document => document.statistics),
    hasher,
    populationId
  );
  const calibrationStatistics = split.holdout.length
    ? mergeBoundaryStatistics(
      split.holdout.map(document => document.statistics),
      hasher,
      populationId
    )
    : undefined;
  return fitBoundaryEstimator({
    statistics: trainingStatistics,
    calibrationStatistics,
    calibrationShards: split.holdout.map(document => document.statistics),
    hasher
  });
}

function initialAssignments(
  documents: readonly SegmentationPopulationTrainingDocument[],
  populationCount: number
): number[] {
  const ranked = documents.map((document, index) => ({
    index,
    signature: documentSignature(document.statistics)
  })).sort((left, right) =>
    left.signature - right.signature
    || documents[left.index]!.documentId.localeCompare(documents[right.index]!.documentId));
  const assignments = new Array<number>(documents.length).fill(0);
  for (let rank = 0; rank < ranked.length; rank += 1) {
    assignments[ranked[rank]!.index] = Math.min(
      populationCount - 1,
      Math.floor(rank * populationCount / ranked.length)
    );
  }
  return assignments;
}

function documentSignature(statistics: BoundarySufficientStatistics): number {
  const mass = Math.max(1, statistics.positiveMass + statistics.negativeMass);
  let signature = statistics.positiveMass / mass;
  for (const row of statistics.rows) {
    const rowMass = row.positiveMass + row.negativeMass;
    for (let index = 0; index < row.featuresFixed.length; index += 1) {
      signature += (index + 1) * (row.featuresFixed[index] ?? 0)
        / statistics.scale * rowMass / mass / 64;
    }
  }
  return signature;
}

function repairCollapsedAssignments(
  assignments: number[],
  costs: readonly (readonly number[])[],
  populationCount: number,
  minimum: number
): number[] | undefined {
  const next = [...assignments];
  const counts = populationCounts(next, populationCount);
  for (let target = 0; target < populationCount; target += 1) {
    while (counts[target]! < minimum) {
      let best: { index: number; donor: number; penalty: number } | undefined;
      for (let index = 0; index < next.length; index += 1) {
        const donor = next[index]!;
        if (counts[donor]! <= minimum) continue;
        const penalty = (costs[index]?.[target] ?? Number.POSITIVE_INFINITY)
          - (costs[index]?.[donor] ?? Number.POSITIVE_INFINITY);
        if (!best || penalty < best.penalty || (penalty === best.penalty && index < best.index)) {
          best = { index, donor, penalty };
        }
      }
      if (!best || !Number.isFinite(best.penalty)) return undefined;
      next[best.index] = target;
      counts[best.donor] = counts[best.donor]! - 1;
      counts[target] = counts[target]! + 1;
    }
  }
  return next;
}

function groupDocuments(
  documents: readonly SegmentationPopulationTrainingDocument[],
  assignments: readonly number[],
  populationCount: number
): SegmentationPopulationTrainingDocument[][] {
  const groups = Array.from({ length: populationCount }, () => [] as SegmentationPopulationTrainingDocument[]);
  for (let index = 0; index < documents.length; index += 1) {
    groups[assignments[index] ?? 0]!.push(documents[index]!);
  }
  return groups;
}

function populationCounts(assignments: readonly number[], populationCount: number): number[] {
  const counts = new Array<number>(populationCount).fill(0);
  for (const assignment of assignments) counts[assignment] = counts[assignment]! + 1;
  return counts;
}

function indexOfMinimum(values: readonly number[]): number {
  let selected = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[selected]!) selected = index;
  }
  return selected;
}

function logSumExp(values: readonly number[]): number {
  if (!values.length) return 0;
  const maximum = Math.max(...values);
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

function emptyCandidate(): CandidateFit {
  return {
    populationCount: 1,
    assignments: [],
    estimators: [],
    priors: [],
    heldoutDataNats: 0,
    modelNats: 0,
    descriptionNats: 0,
    collapsed: false,
    mergeBlocked: false,
    mergeDescriptionDeltaNats: null,
    heldoutRegressionPopulationIds: []
  };
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
