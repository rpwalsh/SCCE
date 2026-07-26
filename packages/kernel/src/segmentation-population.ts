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

export const SEGMENTATION_POPULATION_SCHEMA = "scce.segmentation_population_model.v1" as const;

export interface SegmentationPopulationTrainingDocument {
  documentId: string;
  statistics: BoundarySufficientStatistics;
}

export interface SegmentationPopulation {
  id: string;
  prior: number;
  documentIds: string[];
  statistics: BoundarySufficientStatistics;
  estimator: BoundaryEstimatorModel;
  trainingMass: number;
}

export interface SegmentationPopulationAssignment {
  documentId: string;
  selectedPopulationId: string;
  posterior: Array<{
    populationId: string;
    probability: number;
    averageLogLoss: number;
  }>;
}

export interface SegmentationPopulationModel {
  schema: typeof SEGMENTATION_POPULATION_SCHEMA;
  id: string;
  rootPopulationId: string;
  populations: SegmentationPopulation[];
  assignments: SegmentationPopulationAssignment[];
  selection: {
    fitDocumentIds: string[];
    holdoutDocumentIds: string[];
    candidates: Array<{
      populations: number;
      heldoutDataNats: number;
      modelNats: number;
      descriptionNats: number;
      collapsed: boolean;
    }>;
    selectedPopulationCount: number;
    baselineDescriptionNats: number;
    selectedDescriptionNats: number;
    mdlGainNats: number;
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
}

const MIN_DOCUMENTS_PER_POPULATION = 2;

export function learnSegmentationPopulations(input: {
  rootPopulationId: string;
  documents: readonly SegmentationPopulationTrainingDocument[];
  maxPopulations?: number;
  hasher?: Hasher;
}): SegmentationPopulationModel {
  const hasher = input.hasher ?? createHasher();
  const documents = [...input.documents]
    .filter(document => document.statistics.positiveMass + document.statistics.negativeMass > 0)
    .sort((left, right) => left.documentId.localeCompare(right.documentId));
  const { fit, holdout } = documentDisjointSplit(documents, hasher);
  const maximum = Math.max(1, Math.min(
    Math.floor(input.maxPopulations ?? 8),
    Math.max(1, Math.floor(fit.length / MIN_DOCUMENTS_PER_POPULATION))
  ));
  const candidateFits: CandidateFit[] = [];
  for (let populationCount = 1; populationCount <= maximum; populationCount += 1) {
    candidateFits.push(fitPopulationCandidate({
      rootPopulationId: input.rootPopulationId,
      fit,
      holdout,
      populationCount,
      hasher
    }));
  }
  const legalCandidates = candidateFits.filter(candidate => !candidate.collapsed);
  const baseline = legalCandidates.find(candidate => candidate.populationCount === 1)
    ?? emptyCandidate();
  const selected = legalCandidates
    .sort((left, right) =>
      left.descriptionNats - right.descriptionNats
      || left.populationCount - right.populationCount)[0]
    ?? baseline;

  const finalFit = fitPopulationCandidate({
    rootPopulationId: input.rootPopulationId,
    fit: documents,
    holdout: [],
    populationCount: selected.populationCount,
    hasher
  });
  const finalGroups = groupDocuments(documents, finalFit.assignments, finalFit.populationCount);
  const populations = finalGroups.map((group, index) => {
    const id = `${input.rootPopulationId}.component.${index}`;
    const statistics = mergeBoundaryStatistics(
      group.map(document => document.statistics),
      hasher,
      id
    );
    const estimator = fitBoundaryEstimator({ statistics, hasher });
    return {
      id,
      prior: quantize(group.length / Math.max(1, documents.length)),
      documentIds: group.map(document => document.documentId).sort(),
      statistics,
      estimator,
      trainingMass: quantize(boundaryNegativeLogLikelihood(estimator, statistics).mass)
    };
  });
  const assignments = documents.map(document =>
    assignmentForDocument(document, populations));
  const canonical = {
    schema: SEGMENTATION_POPULATION_SCHEMA,
    rootPopulationId: input.rootPopulationId,
    populations: populations.map(population => ({
      id: population.id,
      prior: population.prior,
      documentIds: population.documentIds,
      statisticsId: population.statistics.id,
      estimatorId: population.estimator.id
    })),
    assignments,
    selection: {
      fitDocumentIds: fit.map(document => document.documentId),
      holdoutDocumentIds: holdout.map(document => document.documentId),
      candidates: candidateFits.map(candidate => ({
        populations: candidate.populationCount,
        heldoutDataNats: candidate.heldoutDataNats,
        modelNats: candidate.modelNats,
        descriptionNats: candidate.descriptionNats,
        collapsed: candidate.collapsed
      })),
      selectedPopulationCount: populations.length,
      baselineDescriptionNats: baseline.descriptionNats,
      selectedDescriptionNats: selected.descriptionNats,
      mdlGainNats: quantize(baseline.descriptionNats - selected.descriptionNats)
    }
  };
  return {
    ...canonical,
    id: `segmentation_population.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    populations,
    audit: toJsonValue({
      learner: "kernel.segmentation_population.heldout_mdl.v1",
      documentDisjointSelection: true,
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
  const assignment = model.assignments.find(row => row.documentId === documentId);
  const weights = new Map(assignment?.posterior.map(row => [row.populationId, row.probability]) ?? []);
  const components = model.populations.map(population => ({
    populationId: population.id,
    weight: weights.get(population.id) ?? population.prior,
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
  const parameterCount = input.populationCount * 8 + Math.max(0, input.populationCount - 1);
  const parameterNats = 0.5 * parameterCount * Math.log(Math.max(2, mass));
  const assignmentNats = input.fit.length * Math.log(input.populationCount);
  const modelNats = quantize(parameterNats + assignmentNats);
  return {
    populationCount: input.populationCount,
    assignments,
    estimators,
    priors,
    heldoutDataNats,
    modelNats,
    descriptionNats: quantize(heldoutDataNats + modelNats),
    collapsed: false
  };
}

function assignmentForDocument(
  document: SegmentationPopulationTrainingDocument,
  populations: readonly SegmentationPopulation[]
): SegmentationPopulationAssignment {
  const rows = populations.map(population => {
    const score = boundaryNegativeLogLikelihood(population.estimator, document.statistics);
    return {
      populationId: population.id,
      averageLogLoss: score.averageLogLoss,
      logWeight: Math.log(Math.max(1e-12, population.prior)) - score.averageLogLoss
    };
  });
  const logZ = logSumExp(rows.map(row => row.logWeight));
  const posterior = rows.map(row => ({
    populationId: row.populationId,
    probability: quantize(clamp01(Math.exp(row.logWeight - logZ))),
    averageLogLoss: row.averageLogLoss
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
  const ranked = documents.map(document => ({
    document,
    rank: hasher.digestHex(`segmentation-population-holdout\u001f${document.documentId}`)
  })).sort((left, right) => left.rank.localeCompare(right.rank));
  const holdoutCount = Math.max(1, Math.floor(documents.length / 5));
  const holdoutIds = new Set(ranked.slice(0, holdoutCount).map(row => row.document.documentId));
  return {
    fit: documents.filter(document => !holdoutIds.has(document.documentId)),
    holdout: documents.filter(document => holdoutIds.has(document.documentId))
  };
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
    collapsed: false
  };
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
