// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA, BOUNDARY_FEATURE_ORDER, type BoundaryEstimatorInferenceModel } from "./boundary-estimator.js";
import type { BoundaryStatisticsCursor, BoundaryStatisticsCursorHeader, CorpusSegmentationDocument, CorpusSegmentationDocumentCursor,
  CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "./corpus-segmentation-cursor.js";
import { segmentationOrdinalKey, segmentationScratchRows, sortSegmentationScratch } from "./corpus-segmentation-sort.js";
import { fitPagedBoundaryEstimator, forEachCanonicalBoundaryRow, pagedBoundaryNegativeLogLikelihood } from "./paged-boundary-estimator.js";
import { mergePagedBoundaryStatistics } from "./paged-boundary-statistics.js";
import { SEGMENTATION_POPULATION_INFERENCE_SCHEMA, SEGMENTATION_MIN_DOCUMENTS_PER_POPULATION, SegmentationSignaturePass,
  segmentationMaximumPopulationCount, segmentationSourcePartitionCounts, segmentationLogSumExp, preferSegmentationCollapseMove,
  type SegmentationPopulationInferenceModel } from "./segmentation-population.js";
import { boundaryFitQuantize as quantize } from "./boundary-fit-math.js";
import { createHasher, toJsonValue } from "./primitives.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { POPULATION_COLLAPSE_DEFAULT_MINIMUM_DIVERGENCE } from "./population-collapse-guard.js";
import type { Hasher, JsonValue } from "./types.js";

type Partition = "fit" | "modelSelection" | "mergeGuard" | "finalEvaluation";
interface OwnedDocument { document: CorpusSegmentationDocument; rank: number }
interface Assignment extends OwnedDocument { population: number; costs?: number[] }
interface Candidate {
  populationCount: number; assignments: string; estimators: BoundaryEstimatorInferenceModel[]; priors: number[];
  heldoutDataNats: number; modelNats: number; descriptionNats: number; collapsed: boolean; mergeBlocked: boolean;
  mergeDescriptionDeltaNats: number | null; heldoutRegressionPopulationIds: string[];
}
function object(value: JsonValue | unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid paged segmentation record");
  return value as Record<string, JsonValue>;
}
function text(value: unknown): string { if (typeof value !== "string" || !value || value.includes("\u0000")) throw new Error("invalid paged segmentation identity"); return value; }
function finite(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid paged segmentation number"); return value; }
function integer(value: unknown): number { const number = finite(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid paged segmentation ordinal"); return number; }

async function cleanupAll(operations: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Population cursor cleanup failed");
}
async function cleanupFailure(error: unknown, operations: readonly (() => Promise<void>)[]): Promise<never> {
  try { await cleanupAll(operations); }
  catch (cleanup) { throw new AggregateError([error, cleanup], "Population fitting and cursor cleanup failed"); }
  throw error;
}
async function withCleanup<T>(operation: () => Promise<T>, operations: readonly (() => Promise<void>)[]): Promise<T> {
  let result: T;
  try { result = await operation(); }
  catch (error) { return cleanupFailure(error, operations); }
  await cleanupAll(operations);
  return result;
}
function owned(value: unknown): OwnedDocument {
  const row = object(value); const doc = object(row.document); const statistics = object(doc.statistics); const inventory = object(statistics.sourceInventory);
  text(statistics.id); text(statistics.populationId); text(statistics.normalizationContractId); text(inventory.id); integer(inventory.count);
  if (statistics.schema !== "scce.boundary_statistics.v2" || statistics.scale !== 1_000_000 || !Array.isArray(statistics.featureOrder)
    || statistics.featureOrder.join("\u001f") !== BOUNDARY_FEATURE_ORDER.join("\u001f")) throw new Error("incompatible paged segmentation statistics");
  for (const field of ["rowCount", "positiveMass", "negativeMass", "anchoredMass", "latentMass"]) integer(statistics[field]);
  const documentId = text(doc.documentId);
  return { rank: integer(row.rank), document: { ordinal: integer(doc.ordinal), documentId, sourceFamilyId: text(doc.sourceFamilyId).trim() || documentId,
    statistics: statistics as unknown as BoundaryStatisticsCursorHeader } };
}

async function joinDocumentCollections(work: PagedPopulationWorkspace, sources: readonly string[], target: string, sort: boolean): Promise<void> {
  const raw = `${target}.raw`; await work.scratch.deleteCollection(raw); let index = 0;
  for (const source of sources) for await (const item of work.docs(source)) await work.write(raw, index++, item);
  if (sort) await sortSegmentationScratch(work.scratch, raw, target, (left, right) => {
    const a = owned(left.value); const b = owned(right.value);
    return a.document.documentId.localeCompare(b.document.documentId) || a.rank - b.rank;
  });
  else { await work.scratch.deleteCollection(target); for await (const page of work.scratch.pages({ collection: raw, pageRows: work.scratch.pageRows, maxPageBytes: work.scratch.maxPageBytes })) await work.scratch.putMany(target, page); }
  await work.scratch.deleteCollection(raw);
}

async function calibrationSplit(work: PagedPopulationWorkspace, assignments: string, population: number, name: string): Promise<{ fit: string; holdout: string }> {
  const prefix = `${work.prefix}.${name}`; const group = `${prefix}.documents`; await work.scratch.deleteCollection(group);
  for await (const item of work.assignments(assignments)) if (item.population === population) await work.write(group, item.rank, { document: item.document, rank: item.rank });
  const empty = `${prefix}.empty`; await work.scratch.deleteCollection(empty);
  if (await work.scratch.count(group) < 4) return { fit: group, holdout: empty };
  const raw = `${prefix}.families.raw`; await work.scratch.deleteCollection(raw);
  for await (const item of work.docs(group)) await work.write(raw, item.rank, { family: item.document.sourceFamilyId, first: item.rank,
    hash: work.hasher.digestHex(`segmentation-population-holdout\u001f${item.document.sourceFamilyId}`) });
  const sorted = `${prefix}.families.byId`;
  await sortSegmentationScratch(work.scratch, raw, sorted, (left, right) => {
    const a = text(object(left.value).family); const b = text(object(right.value).family); return a < b ? -1 : a > b ? 1 : 0;
  });
  const unique = `${prefix}.families.unique`; await work.scratch.deleteCollection(unique);
  let previous: string | undefined; let count = 0;
  for await (const row of segmentationScratchRows(work.scratch, sorted)) {
    const family = text(object(row.value).family); if (family === previous) continue; previous = family;
    await work.write(unique, count++, row.value);
  }
  const ranked = `${prefix}.families.ranked`;
  await sortSegmentationScratch(work.scratch, unique, ranked, (left, right) => text(object(left.value).hash).localeCompare(text(object(right.value).hash))
    || integer(object(left.value).first) - integer(object(right.value).first));
  const lookup = `${prefix}.families.lookup`; await work.scratch.deleteCollection(lookup);
  const heldoutCount = Math.max(1, Math.floor(count / 5)); let rank = 0;
  for await (const row of segmentationScratchRows(work.scratch, ranked)) await work.scratch.putMany(lookup, [{ orderKey: familyKey(text(object(row.value).family)), value: rank++ < heldoutCount }]);
  const fit = `${prefix}.fit`; const holdout = `${prefix}.holdout`;
  await work.scratch.deleteCollection(fit); await work.scratch.deleteCollection(holdout);
  for await (const item of work.docs(group)) {
    const key = familyKey(item.document.sourceFamilyId); let held: boolean | undefined;
    for await (const page of work.scratch.pages({ collection: lookup, prefix: key, pageRows: work.scratch.pageRows, maxPageBytes: work.scratch.maxPageBytes })) {
      for (const row of page) if (row.orderKey === key && typeof row.value === "boolean") held = row.value;
    }
    if (held === undefined) throw new Error("calibration family partition is missing");
    await work.write(held ? holdout : fit, item.rank, item);
  }
  for (const collection of [raw, sorted, unique, ranked, lookup, group]) await work.scratch.deleteCollection(collection);
  return { fit, holdout };
}

async function fitCalibratedGroup(work: PagedPopulationWorkspace, assignments: string, population: number, populationId: string, label: string): Promise<BoundaryEstimatorInferenceModel> {
  const split = await calibrationSplit(work, assignments, population, `${label}.calibration`);
  let training: BoundaryStatisticsCursor | undefined, heldout: BoundaryStatisticsCursor | undefined;
  return withCleanup(async () => {
    training = await work.merged(split.fit, populationId, `${label}.training`);
    heldout = await work.scratch.count(split.holdout) ? await work.merged(split.holdout, populationId, `${label}.heldout`) : undefined;
    return fitPagedBoundaryEstimator({ statistics: training, calibrationStatistics: heldout,
      calibrationShards: () => work.sources(split.holdout), hasher: work.hasher, numericReplay: work.scratch.boundaryFitNumericReplay });
  }, [() => training?.dispose?.() ?? Promise.resolve(), () => heldout?.dispose?.() ?? Promise.resolve(),
    () => work.scratch.deleteCollection(split.fit), () => work.scratch.deleteCollection(split.holdout)]);
}

async function applyPagedMergeGuards(work: PagedPopulationWorkspace, candidates: Candidate[], holdout: string,
  descriptionMarginNats: number, heldoutRegressionToleranceNats: number): Promise<void> {
  for (const coarse of candidates) {
    if (coarse.collapsed) continue;
    const fine = candidates.find(candidate => !candidate.collapsed && candidate.populationCount === coarse.populationCount + 1);
    if (!fine) continue;
    const sums = Array.from({ length: fine.populationCount }, () => ({ fine: 0, coarse: 0, count: 0 }));
    for await (const item of work.docs(holdout)) {
      const fineLosses: number[] = []; const coarseLosses: number[] = [];
      for (const estimator of fine.estimators) fineLosses.push((await pagedBoundaryNegativeLogLikelihood(estimator, work.source.statistics(item.document))).averageLogLoss);
      for (const estimator of coarse.estimators) coarseLosses.push((await pagedBoundaryNegativeLogLikelihood(estimator, work.source.statistics(item.document))).averageLogLoss);
      let index = 0; for (let current = 1; current < fineLosses.length; current++) if (fineLosses[current]! < fineLosses[index]!) index = current;
      sums[index]!.fine += fineLosses[index]!; sums[index]!.coarse += Math.min(...coarseLosses); sums[index]!.count++;
    }
    const regressions: string[] = [];
    for (let index = 0; index < fine.populationCount; index++) {
      const sum = sums[index]!;
      if (!sum.count) {
        const estimator = fine.estimators[index]!;
        const redundant = fine.estimators.some((other, otherIndex) => {
          if (otherIndex === index) return false;
          const width = Math.max(estimator.weights.length, other.weights.length); let distance = Math.abs(estimator.intercept - other.intercept);
          for (let feature = 0; feature < width; feature++) distance += Math.abs((estimator.weights[feature] ?? 0) - (other.weights[feature] ?? 0));
          return distance / Math.max(1, width + 1) <= 1e-6;
        });
        if (!redundant) regressions.push(`candidate.${fine.populationCount}.population.${index}.missing_evaluation_coverage`);
      } else if (sum.coarse / sum.count > sum.fine / sum.count + heldoutRegressionToleranceNats) regressions.push(`candidate.${fine.populationCount}.population.${index}`);
    }
    coarse.mergeDescriptionDeltaNats = quantize(coarse.descriptionNats - fine.descriptionNats);
    coarse.heldoutRegressionPopulationIds = regressions;
    coarse.mergeBlocked = coarse.mergeDescriptionDeltaNats >= -descriptionMarginNats || regressions.length > 0;
  }
}

async function inventory(work: PagedPopulationWorkspace, collection: string) {
  const encoder = new TextEncoder(); let count = 0;
  async function* bytes() { yield encoder.encode("["); let first = true;
    for await (const item of work.docs(collection)) { if (!first) yield encoder.encode(","); first = false; count++; yield encoder.encode(JSON.stringify(item.document.documentId)); }
    yield encoder.encode("]"); }
  return { id: `segmentation_documents.${await work.scratch.digestChunks(bytes())}`, count };
}

async function* statisticRows(source: BoundaryStatisticsCursor) { for await (const page of source.rows()) for (const row of page) yield row; }
async function pagedCollapseGuard(left: BoundaryStatisticsCursor, right: BoundaryStatisticsCursor) {
  const normalizer = async (source: BoundaryStatisticsCursor) => {
    let raw = 0; for await (const row of statisticRows(source)) raw = raw + row.positiveMass + row.negativeMass;
    let normalized = 0; if (raw > 0) for await (const row of statisticRows(source)) normalized += (row.positiveMass + row.negativeMass) / raw;
    return { raw, normalized };
  };
  const a = await normalizer(left); const b = await normalizer(right);
  const first = statisticRows(left); const second = statisticRows(right); let pLoss = 0; let qLoss = 0;
  try { for (;;) {
    const x = await first.next(); const y = await second.next(); if (x.done && y.done) break;
    const p = !x.done && a.raw > 0 && a.normalized > 0 ? ((x.value.positiveMass + x.value.negativeMass) / a.raw) / a.normalized : 0;
    const q = !y.done && b.raw > 0 && b.normalized > 0 ? ((y.value.positiveMass + y.value.negativeMass) / b.raw) / b.normalized : 0;
    const mean = (p + q) / 2;
    if (p > 0) { if (mean <= 0) throw new Error("unreachable zero population mixture"); pLoss += p * Math.log2(p / mean); }
    if (q > 0) { if (mean <= 0) throw new Error("unreachable zero population mixture"); qLoss += q * Math.log2(q / mean); }
  } } finally { await first.return(undefined); await second.return(undefined); }
  const divergence = Math.max(0, Math.min(1, 0.5 * pLoss + 0.5 * qLoss));
  return { divergence, distance: Math.sqrt(divergence), distinct: divergence >= POPULATION_COLLAPSE_DEFAULT_MINIMUM_DIVERGENCE,
    minimumDivergence: POPULATION_COLLAPSE_DEFAULT_MINIMUM_DIVERGENCE };
}

export interface PagedSegmentationPopulationResult {
  model: SegmentationPopulationInferenceModel;
  artifacts: { assignments: string; partitions: Record<Partition, string>; populationStatistics: readonly BoundaryStatisticsCursor[] };
}

export function validatePagedSegmentationInference(value: unknown, hasher: Hasher = createHasher()): SegmentationPopulationInferenceModel {
  const header = object(value);
  if (header.schema !== SEGMENTATION_POPULATION_INFERENCE_SCHEMA) throw new Error("incompatible corpus segmentation inference schema");
  text(header.id); text(header.rootPopulationId); text(header.normalizationContractId); text(header.featureContextId);
  const sourceInventory = object(header.sourceInventory); text(sourceInventory.id); integer(sourceInventory.count);
  if (!Array.isArray(header.populations) || !header.populations.length || !Array.isArray(header.collapseGuard)) throw new Error("corpus population inference is incomplete");
  const ids = new Set<string>(); let totalPrior = 0;
  for (const raw of header.populations) {
    const population = object(raw); const id = text(population.id);
    if (ids.has(id)) throw new Error("corpus population identity repeats"); ids.add(id);
    const prior = finite(population.prior); if (prior <= 0 || prior > 1) throw new Error("invalid corpus population prior"); totalPrior += prior;
    text(population.statisticsId); if (finite(population.trainingMass) <= 0) throw new Error("empty corpus population training mass");
    const estimator = object(population.estimator);
    if (estimator.schema !== BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA || estimator.populationId !== id
      || !Array.isArray(estimator.featureOrder) || estimator.featureOrder.join("\u001f") !== BOUNDARY_FEATURE_ORDER.join("\u001f")
      || !Array.isArray(estimator.weights) || estimator.weights.length !== BOUNDARY_FEATURE_ORDER.length) throw new Error("invalid corpus population estimator");
    estimator.weights.forEach(finite); finite(estimator.intercept); text(estimator.trainingStatisticsId);
    const iterations = integer(estimator.iterations); if (!iterations || iterations > 512) throw new Error("invalid corpus population fit settings");
    const l2 = finite(estimator.l2); if (l2 < 0 || l2 > 10) throw new Error("invalid corpus population regularization");
    const training = object(estimator.training); integer(training.examples); finite(training.positiveMass); finite(training.negativeMass); finite(training.logLoss);
    const estimatorSources = object(estimator.sourceInventory); text(estimatorSources.id); integer(estimatorSources.count);
    const calibration = object(estimator.calibration); finite(calibration.intercept);
    const slope = finite(calibration.slope); if (slope < 0.05 || slope > 10) throw new Error("invalid corpus population calibration");
    if (calibration.method !== "platt_heldout" && calibration.method !== "identity_no_holdout") throw new Error("invalid corpus population calibration method");
    if (calibration.method === "platt_heldout") { text(calibration.heldoutStatisticsId); const heldout = object(calibration.heldoutSourceInventory); text(heldout.id); integer(heldout.count); }
    integer(calibration.examples); integer(calibration.shardCount); finite(calibration.mass);
    for (const metric of ["logLoss", "brier", "expectedCalibrationError", "anchorPrecision", "anchorRecall", "predictiveCompressionGainNats", "shardLogLossStdDev"]) if (calibration[metric] !== null) finite(calibration[metric]);
    const { id: estimatorId, audit: _audit, ...estimatorCanonical } = estimator;
    if (estimatorId !== `boundary_estimator_inference.${canonicalDigestHex(estimatorCanonical, hasher).slice(0, 40)}`) throw new Error("corpus population estimator digest changed");
  }
  if (Math.abs(totalPrior - 1) > header.populations.length / 1_000_000_000_000) throw new Error("corpus population priors do not sum to one");
  const selection = object(header.selection);
  if (selection.sourceFamilyDisjoint !== true || integer(selection.selectedPopulationCount) !== header.populations.length || !Array.isArray(selection.candidates) || !selection.candidates.length) throw new Error("corpus population selection is incomplete");
  for (const metric of ["baselineDescriptionNats", "selectedDescriptionNats", "mdlGainNats", "finalEvaluationNats"]) finite(selection[metric]);
  for (let index = 0; index < selection.candidates.length; index++) {
    const candidate = object(selection.candidates[index]);
    if (integer(candidate.populations) !== index + 1 || typeof candidate.collapsed !== "boolean" || typeof candidate.mergeBlocked !== "boolean"
      || !Array.isArray(candidate.heldoutRegressionPopulationIds)) throw new Error("invalid corpus population selection candidate");
    candidate.heldoutRegressionPopulationIds.forEach(text);
    for (const metric of ["heldoutDataNats", "modelNats", "descriptionNats"]) finite(candidate[metric]);
    if (candidate.mergeDescriptionDeltaNats !== null) finite(candidate.mergeDescriptionDeltaNats);
  }
  const partitions = object(header.partitionInventories); let documents = 0;
  for (const partition of ["fit", "modelSelection", "mergeGuard", "finalEvaluation"]) {
    const inventory = object(partitions[partition]); text(inventory.id); documents += integer(inventory.count);
  }
  const assignments = object(header.assignmentInventory); text(assignments.id);
  if (integer(assignments.count) !== documents || !documents) throw new Error("corpus population assignment inventory is incomplete");
  for (const raw of header.collapseGuard) {
    const guard = object(raw);
    if (!ids.has(text(guard.leftPopulationId)) || !ids.has(text(guard.rightPopulationId)) || guard.leftPopulationId === guard.rightPopulationId) throw new Error("invalid population collapse ownership");
    const divergence = finite(guard.divergence); const threshold = finite(guard.minimumDivergence);
    if (divergence < 0 || divergence > 1 || threshold < 0 || threshold > 1 || guard.distance !== Math.sqrt(divergence) || guard.distinct !== (divergence >= threshold)) throw new Error("invalid population collapse measurement");
  }
  if (header.collapseGuard.length !== header.populations.length * (header.populations.length - 1) / 2) throw new Error("population collapse guard inventory is incomplete");
  const { id, ...canonical } = header;
  if (id !== `segmentation_population_inference.${canonicalDigestHex(canonical, hasher).slice(0, 40)}`) throw new Error("corpus population inference digest changed");
  return value as SegmentationPopulationInferenceModel;
}

export async function learnPagedSegmentationPopulations(input: {
  rootPopulationId: string; source: CorpusSegmentationDocumentCursor; namespace: string; featureContextId: string;
  maxPopulations?: number; mergeDescriptionMarginNats?: number; heldoutRegressionToleranceNats?: number; hasher?: Hasher;
}): Promise<PagedSegmentationPopulationResult> {
  const populationStatistics: BoundaryStatisticsCursor[] = [];
  try { return await learnPagedSegmentationPopulationsInner(input, populationStatistics); }
  catch (error) { return cleanupFailure(error, populationStatistics.map(cursor => () => cursor.dispose?.() ?? Promise.resolve())); }
}

async function learnPagedSegmentationPopulationsInner(input: Parameters<typeof learnPagedSegmentationPopulations>[0],
  populationStatistics: BoundaryStatisticsCursor[]): Promise<PagedSegmentationPopulationResult> {
  text(input.rootPopulationId); text(input.namespace); text(input.featureContextId);
  const work = new PagedPopulationWorkspace(input.source, input.rootPopulationId, input.namespace, input.hasher ?? createHasher());
  await work.prepare();
  const documentCount = await work.scratch.count(work.documents);
  if (!documentCount) throw new Error("corpus population fit has no measured nonempty documents");
  const maximum = segmentationMaximumPopulationCount(await work.scratch.count(work.partitions.fit), input.maxPopulations);
  const candidates: Candidate[] = [];
  for (let populationCount = 1; populationCount <= maximum; populationCount++) candidates.push(await work.fitCandidate(work.partitions.fit,
    work.partitions.modelSelection, populationCount, `candidate.${populationCount}`));
  const mergeGuard = `${input.namespace}.mergeGuardDocuments`;
  await joinDocumentCollections(work, [work.partitions.modelSelection, work.partitions.mergeGuard], mergeGuard, false);
  await applyPagedMergeGuards(work, candidates, mergeGuard, Math.max(0, input.mergeDescriptionMarginNats ?? 1), Math.max(0, input.heldoutRegressionToleranceNats ?? 0.01));
  const baseline = candidates.find(candidate => candidate.populationCount === 1 && !candidate.collapsed) ?? emptyCandidate(1, "");
  const selected = candidates.filter(candidate => !candidate.collapsed && !candidate.mergeBlocked)
    .sort((left, right) => left.descriptionNats - right.descriptionNats || left.populationCount - right.populationCount)[0] ?? baseline;
  const finalDocuments = `${input.namespace}.finalTrainingDocuments`;
  await joinDocumentCollections(work, [work.partitions.fit, work.partitions.modelSelection, work.partitions.mergeGuard], finalDocuments, true);
  const finalFit = await work.scratch.count(finalDocuments) === await work.scratch.count(work.partitions.fit) ? selected
    : await work.fitCandidate(finalDocuments, `${input.namespace}.emptyHoldout`, selected.populationCount, "final");
  if (finalFit.collapsed || !finalFit.estimators.length) throw new Error("selected corpus population collapsed during final fit");
  for (const candidate of candidates) if (candidate.assignments && candidate.assignments !== finalFit.assignments) await work.scratch.deleteCollection(candidate.assignments);
  const populations: SegmentationPopulationInferenceModel["populations"] = [];
  for (let group = 0; group < finalFit.populationCount; group++) {
    let groupCount = 0; for await (const item of work.assignments(finalFit.assignments)) if (item.population === group) groupCount++;
    const provisionalId = `${input.rootPopulationId}.candidate.final.${group}`;
    const provisionalStatistics = await work.merged(finalFit.assignments, provisionalId, `population.${group}.provisional`, group);
    await withCleanup(async () => {
      const provisionalEstimator = await fitCalibratedGroup(work, finalFit.assignments, group, provisionalId, `population.${group}.provisionalFit`);
      const prior = quantize(groupCount / Math.max(1, await work.scratch.count(finalDocuments)));
      const contentSignature = canonicalDigestHex({ rootPopulationId: input.rootPopulationId, prior, statisticsId: provisionalStatistics.header.id,
        weights: provisionalEstimator.weights, intercept: provisionalEstimator.intercept, calibration: provisionalEstimator.calibration }, work.hasher);
      const id = `${input.rootPopulationId}.component.${contentSignature.slice(0, 32)}`;
      const statistics = await work.merged(finalFit.assignments, id, `population.${group}.statistics`, group);
      // Retain ownership immediately: later fitting/evaluation can fail before this becomes a returned live artifact.
      populationStatistics.push(statistics);
      const estimator = await fitCalibratedGroup(work, finalFit.assignments, group, id, `population.${group}.finalFit`);
      const trainingMass = (await pagedBoundaryNegativeLogLikelihood(estimator, statistics)).mass;
      populations.push({ id, prior, statisticsId: statistics.header.id, estimator, trainingMass });
    }, [() => provisionalStatistics.dispose?.() ?? Promise.resolve()]);
  }
  const assignments = `${input.namespace}.finalAssignments`; await work.scratch.deleteCollection(assignments);
  for await (const item of work.docs(work.documents)) {
    const scores: Array<{ populationId: string; negativeLogLikelihood: number; averageLogLoss: number; documentMass: number; logWeight: number }> = [];
    for (const population of populations) {
      const score = await pagedBoundaryNegativeLogLikelihood(population.estimator, work.source.statistics(item.document));
      scores.push({ populationId: population.id, negativeLogLikelihood: score.negativeLogLikelihood, averageLogLoss: score.averageLogLoss,
        documentMass: score.mass, logWeight: Math.log(Math.max(1e-12, population.prior)) - score.negativeLogLikelihood });
    }
    const logZ = segmentationLogSumExp(scores.map(row => row.logWeight));
    const posterior = scores.map(row => ({ populationId: row.populationId, probability: quantize(Math.max(0, Math.min(1, Math.exp(row.logWeight - logZ)))),
      negativeLogLikelihood: row.negativeLogLikelihood, averageLogLoss: row.averageLogLoss, documentMass: row.documentMass }))
      .sort((left, right) => right.probability - left.probability || left.populationId.localeCompare(right.populationId));
    await work.write(assignments, item.rank, { documentId: item.document.documentId, selectedPopulationId: posterior[0]!.populationId, posterior });
  }
  let finalEvaluationNats = 0;
  for await (const item of work.docs(work.partitions.finalEvaluation)) finalEvaluationNats += await work.mixtureLoss(item.document, populations.map(row => row.estimator), populations.map(row => row.prior));
  finalEvaluationNats = quantize(finalEvaluationNats);
  const collapseGuard: SegmentationPopulationInferenceModel["collapseGuard"] = [];
  for (let left = 0; left < populations.length; left++) for (let right = left + 1; right < populations.length; right++) collapseGuard.push({
    leftPopulationId: populations[left]!.id, rightPopulationId: populations[right]!.id,
    ...await pagedCollapseGuard(populationStatistics[left]!, populationStatistics[right]!) });
  const partitionInventories = {} as SegmentationPopulationInferenceModel["partitionInventories"];
  for (const partition of Object.keys(work.partitions) as Partition[]) partitionInventories[partition] = await inventory(work, work.partitions[partition]);
  const encoder = new TextEncoder(); let assignmentCount = 0;
  async function* assignmentBytes() { yield encoder.encode("["); let first = true;
    for await (const row of segmentationScratchRows(work.scratch, assignments)) { if (!first) yield encoder.encode(","); first = false; assignmentCount++; yield encoder.encode(JSON.stringify(row.value)); }
    yield encoder.encode("]"); }
  const assignmentInventory = { id: `segmentation_assignments.${await work.scratch.digestChunks(assignmentBytes())}`, count: assignmentCount };
  const canonical = { schema: SEGMENTATION_POPULATION_INFERENCE_SCHEMA, rootPopulationId: input.rootPopulationId, sourceInventory: input.source.sourceInventory,
    normalizationContractId: work.normalizationContractId, featureContextId: input.featureContextId, populations, partitionInventories, assignmentInventory, collapseGuard,
    selection: { sourceFamilyDisjoint: true, selectedPopulationCount: populations.length, baselineDescriptionNats: baseline.descriptionNats,
      selectedDescriptionNats: selected.descriptionNats, mdlGainNats: quantize(baseline.descriptionNats - selected.descriptionNats), finalEvaluationNats,
      candidates: candidates.map(candidate => ({ populations: candidate.populationCount, heldoutDataNats: candidate.heldoutDataNats, modelNats: candidate.modelNats,
        descriptionNats: candidate.descriptionNats, collapsed: candidate.collapsed, mergeBlocked: candidate.mergeBlocked,
        mergeDescriptionDeltaNats: candidate.mergeDescriptionDeltaNats, heldoutRegressionPopulationIds: candidate.heldoutRegressionPopulationIds })) } };
  const model = { ...canonical, id: `segmentation_population_inference.${canonicalDigestHex(canonical, work.hasher).slice(0, 40)}` };
  validatePagedSegmentationInference(model, work.hasher);
  await work.scratch.deleteCollection(finalFit.assignments);
  await work.scratch.deleteCollection(finalDocuments);
  await work.scratch.deleteCollection(mergeGuard);
  await work.scratch.deleteCollection(work.documents);
  return { model, artifacts: { assignments, partitions: work.partitions, populationStatistics } };
}
function assignment(value: JsonValue): Assignment {
  const row = object(value); const result: Assignment = { ...owned(value), population: integer(row.population) };
  if (row.costs !== undefined) { if (!Array.isArray(row.costs)) throw new Error("invalid paged segmentation costs"); result.costs = row.costs.map(finite); }
  return result;
}
function familyKey(family: string): string { return `${Buffer.from(family, "utf16le").toString("hex")}.`; }
function emptyCandidate(populationCount: number, assignments: string, collapsed = false): Candidate {
  return { populationCount, assignments, estimators: [], priors: [], heldoutDataNats: 0, modelNats: 0, descriptionNats: 0,
    collapsed, mergeBlocked: false, mergeDescriptionDeltaNats: null, heldoutRegressionPopulationIds: [] };
}

export class PagedPopulationWorkspace {
  readonly scratch: CorpusSegmentationScratch;
  readonly hasher: Hasher;
  readonly prefix: string;
  readonly documents: string;
  readonly partitions: Record<Partition, string>;
  normalizationContractId = "";
  constructor(readonly source: CorpusSegmentationDocumentCursor, readonly rootPopulationId: string, readonly namespace: string, hasher = createHasher()) {
    this.scratch = source.scratch; this.hasher = hasher; this.prefix = namespace; this.documents = `${namespace}.documents`;
    this.partitions = { fit: `${namespace}.partition.fit`, modelSelection: `${namespace}.partition.modelSelection`,
      mergeGuard: `${namespace}.partition.mergeGuard`, finalEvaluation: `${namespace}.partition.finalEvaluation` };
  }
  async *docs(collection: string): AsyncGenerator<OwnedDocument> {
    for await (const row of segmentationScratchRows(this.scratch, collection)) yield owned(row.value);
  }
  async *assignments(collection: string): AsyncGenerator<Assignment> {
    for await (const row of segmentationScratchRows(this.scratch, collection)) yield assignment(row.value);
  }
  async write(collection: string, rank: number, value: unknown): Promise<void> {
    await this.scratch.putMany(collection, [{ orderKey: segmentationOrdinalKey(rank), value: JSON.parse(JSON.stringify(value)) as JsonValue }]);
  }
  async prepare(): Promise<void> {
    const raw = `${this.prefix}.rawDocuments`; await this.scratch.deleteCollection(raw);
    const owners = `${this.prefix}.rawOwners`; await this.scratch.deleteCollection(owners);
    let count = 0; let rank = 0;
    for await (const page of this.source.documents()) for (const document of page) {
      const checked = owned({ document, rank: document.ordinal }); count++;
      await this.scratch.putMany(owners, [{ orderKey: `o.${segmentationOrdinalKey(document.ordinal)}`, value: document.documentId },
        { orderKey: `d.${familyKey(document.documentId)}`, value: document.ordinal }]);
      if (this.normalizationContractId && checked.document.statistics.normalizationContractId !== this.normalizationContractId) throw new Error("corpus normalization contracts differ");
      this.normalizationContractId = checked.document.statistics.normalizationContractId;
      if (document.statistics.positiveMass + document.statistics.negativeMass <= 0) continue;
      await this.write(raw, rank++, checked);
    }
    if (count !== this.source.documentCount) throw new Error("corpus document inventory changed");
    if (await this.scratch.count(owners) !== count * 2) throw new Error("corpus document ownership repeats");
    await this.scratch.deleteCollection(owners);
    const byIdentity = `${this.prefix}.documentsByIdentity`;
    await sortSegmentationScratch(this.scratch, raw, byIdentity, (left, right) => {
      const a = owned(left.value).document.documentId; const b = owned(right.value).document.documentId;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    let lastIdentity: string | undefined;
    for await (const item of this.docs(byIdentity)) {
      if (item.document.documentId === lastIdentity) throw new Error("corpus document identity repeats"); lastIdentity = item.document.documentId;
    }
    await sortSegmentationScratch(this.scratch, byIdentity, this.documents, (left, right) => {
      const a = owned(left.value); const b = owned(right.value);
      return a.document.documentId.localeCompare(b.document.documentId) || a.rank - b.rank;
    });
    await this.scratch.deleteCollection(byIdentity);
    await this.scratch.deleteCollection(raw);
    const familyRaw = `${this.prefix}.familyRaw`; await this.scratch.deleteCollection(familyRaw);
    let previous: string | undefined; rank = 0;
    for await (const item of this.docs(this.documents)) {
      if (previous === item.document.documentId) throw new Error("corpus document identity repeats"); previous = item.document.documentId;
      await this.write(this.documents, rank, { ...item, rank });
      const family = item.document.sourceFamilyId;
      await this.write(familyRaw, rank, { family, first: rank, hash: this.hasher.digestHex(`segmentation-population-partition\u001f${family}`) }); rank++;
    }
    const familyById = `${this.prefix}.familyById`;
    await sortSegmentationScratch(this.scratch, familyRaw, familyById, (left, right) => {
      const a = text(object(left.value).family); const b = text(object(right.value).family); return a < b ? -1 : a > b ? 1 : 0;
    });
    const uniqueFamilies = `${this.prefix}.uniqueFamilies`; await this.scratch.deleteCollection(uniqueFamilies);
    previous = undefined; let families = 0;
    for await (const row of segmentationScratchRows(this.scratch, familyById)) {
      const family = text(object(row.value).family); if (family === previous) continue; previous = family;
      await this.write(uniqueFamilies, families++, row.value);
    }
    const familyRanks = `${this.prefix}.familyRanks`;
    await sortSegmentationScratch(this.scratch, uniqueFamilies, familyRanks, (left, right) => {
      const a = object(left.value); const b = object(right.value);
      return text(a.hash).localeCompare(text(b.hash)) || text(a.family).localeCompare(text(b.family)) || integer(a.first) - integer(b.first);
    });
    const familyLookup = `${this.prefix}.familyLookup`; await this.scratch.deleteCollection(familyLookup);
    const counts = segmentationSourcePartitionCounts(await this.scratch.count(this.documents), families);
    rank = 0;
    for await (const row of segmentationScratchRows(this.scratch, familyRanks)) {
      const partition: Partition = rank < counts.finalCount ? "finalEvaluation" : rank < counts.finalCount + counts.guardCount ? "mergeGuard"
        : rank < counts.finalCount + counts.guardCount + counts.selectionCount ? "modelSelection" : "fit";
      const family = text(object(row.value).family);
      await this.scratch.putMany(familyLookup, [{ orderKey: familyKey(family), value: partition }]); rank++;
    }
    for (const collection of Object.values(this.partitions)) await this.scratch.deleteCollection(collection);
    rank = 0;
    for await (const item of this.docs(this.documents)) {
      const key = familyKey(item.document.sourceFamilyId); let partition: Partition | undefined;
      for await (const page of this.scratch.pages({ collection: familyLookup, prefix: key, pageRows: this.scratch.pageRows, maxPageBytes: this.scratch.maxPageBytes })) {
        for (const row of page) if (row.orderKey === key) partition = text(row.value) as Partition;
      }
      if (!partition) throw new Error("corpus family partition is missing");
      await this.write(this.partitions[partition], rank, { ...item, rank }); rank++;
    }
    for (const collection of [familyRaw, familyById, uniqueFamilies, familyRanks, familyLookup]) await this.scratch.deleteCollection(collection);
  }
  async *sources(collection: string, population?: number): AsyncGenerator<BoundaryStatisticsCursor> {
    for await (const row of segmentationScratchRows(this.scratch, collection)) {
      const item = population === undefined ? owned(row.value) : assignment(row.value);
      if (population !== undefined && (item as Assignment).population !== population) continue;
      yield this.source.statistics(item.document);
    }
  }
  async merged(collection: string, populationId: string, name: string, population?: number): Promise<BoundaryStatisticsCursor> {
    return mergePagedBoundaryStatistics({ sources: () => this.sources(collection, population), scratch: this.scratch, populationId,
      collectionPrefix: `${this.prefix}.${name}`, hasher: this.hasher });
  }
  async mixtureLoss(document: CorpusSegmentationDocument, estimators: readonly BoundaryEstimatorInferenceModel[], priors: readonly number[]): Promise<number> {
    const terms: number[] = [];
    for (let index = 0; index < estimators.length; index++) terms.push(Math.log(Math.max(1e-12, priors[index] ?? 0))
      - (await pagedBoundaryNegativeLogLikelihood(estimators[index]!, this.source.statistics(document))).negativeLogLikelihood);
    return -segmentationLogSumExp(terms);
  }
  async fitCandidate(fit: string, holdout: string, populationCount: number, label: string): Promise<Candidate> {
    const n = await this.scratch.count(fit); const candidatePrefix = `${this.prefix}.${label}`;
    if (!n || populationCount > 1 && n < populationCount * SEGMENTATION_MIN_DOCUMENTS_PER_POPULATION) return emptyCandidate(populationCount, "", populationCount > 1);
    const signatures = `${candidatePrefix}.signatures`; await this.scratch.deleteCollection(signatures);
    for await (const item of this.docs(fit)) {
      const pass = new SegmentationSignaturePass(item.document.statistics);
      await forEachCanonicalBoundaryRow(this.source.statistics(item.document), row => pass.add(row));
      await this.write(signatures, item.rank, { ...item, signature: pass.signature });
    }
    const ranked = `${candidatePrefix}.ranked`;
    await sortSegmentationScratch(this.scratch, signatures, ranked, (left, right) => finite(object(left.value).signature) - finite(object(right.value).signature)
      || owned(left.value).document.documentId.localeCompare(owned(right.value).document.documentId));
    let assignments = `${candidatePrefix}.assignment.0`; await this.scratch.deleteCollection(assignments);
    let position = 0;
    for await (const row of segmentationScratchRows(this.scratch, ranked)) {
      const item = owned(row.value);
      await this.write(assignments, item.rank, { ...item, population: Math.min(populationCount - 1, Math.floor(position++ * populationCount / n)) });
    }
    await this.scratch.deleteCollection(signatures); await this.scratch.deleteCollection(ranked);
    let estimators: BoundaryEstimatorInferenceModel[] = []; let priors: number[] = []; let changed = true;
    const refit = async (): Promise<boolean> => {
      const counts = new Array<number>(populationCount).fill(0);
      for await (const item of this.assignments(assignments)) { if (item.population >= populationCount) throw new Error("invalid population assignment"); counts[item.population] = counts[item.population]! + 1; }
      const minimum = populationCount === 1 ? 1 : SEGMENTATION_MIN_DOCUMENTS_PER_POPULATION;
      if (counts.some(count => count < minimum)) return false;
      estimators = []; priors = counts.map(count => count / n);
      for (let group = 0; group < populationCount; group++) {
        const statistics = await this.merged(assignments, `${this.rootPopulationId}.candidate.${populationCount}.${group}`, `${label}.fit.${group}`, group);
        await withCleanup(async () => { estimators.push(await fitPagedBoundaryEstimator({ statistics, hasher: this.hasher, numericReplay: this.scratch.boundaryFitNumericReplay })); },
          [() => statistics.dispose?.() ?? Promise.resolve()]);
      }
      return true;
    };
    for (let iteration = 0; iteration < 12; iteration++) {
      if (!await refit()) return emptyCandidate(populationCount, assignments, true);
      const next = `${candidatePrefix}.assignment.${iteration + 1}`; await this.scratch.deleteCollection(next);
      const counts = new Array<number>(populationCount).fill(0);
      for await (const item of this.docs(fit)) {
        const costs: number[] = [];
        for (const estimator of estimators) costs.push((await pagedBoundaryNegativeLogLikelihood(estimator, this.source.statistics(item.document))).averageLogLoss);
        let population = 0; for (let index = 1; index < costs.length; index++) if (costs[index]! < costs[population]!) population = index;
        counts[population] = counts[population]! + 1; await this.write(next, item.rank, { ...item, costs, population });
      }
      const minimum = populationCount === 1 ? 1 : SEGMENTATION_MIN_DOCUMENTS_PER_POPULATION;
      for (let target = 0; target < populationCount; target++) while (counts[target]! < minimum) {
        let best: { item: Assignment; index: number; penalty: number } | undefined;
        for await (const item of this.assignments(next)) {
          if (counts[item.population]! <= minimum) continue;
          if (!item.costs || item.costs.length !== populationCount) throw new Error("population cost inventory is missing");
          const penalty = item.costs[target]! - item.costs[item.population]!;
          if (preferSegmentationCollapseMove({ index: item.rank, penalty }, best)) best = { item, index: item.rank, penalty };
        }
        if (!best || !Number.isFinite(best.penalty)) return emptyCandidate(populationCount, next, true);
        counts[best.item.population] = counts[best.item.population]! - 1; counts[target] = counts[target]! + 1;
        await this.write(next, best.item.rank, { ...best.item, population: target });
      }
      changed = false;
      const previous = this.assignments(assignments); const current = this.assignments(next);
      try {
        for (;;) { const a = await previous.next(); const b = await current.next();
          if (a.done || b.done) { if (a.done !== b.done) throw new Error("population assignment inventory changed"); break; }
          if (a.value.rank !== b.value.rank) throw new Error("population assignment order changed");
          if (a.value.population !== b.value.population) changed = true;
        }
      } finally { await previous.return(undefined); await current.return(undefined); }
      await this.scratch.deleteCollection(assignments); assignments = next;
      if (!changed) break;
    }
    if (changed && !await refit()) return emptyCandidate(populationCount, assignments, true);
    let heldoutDataNats = 0; for await (const item of this.docs(holdout)) heldoutDataNats += await this.mixtureLoss(item.document, estimators, priors);
    heldoutDataNats = quantize(heldoutDataNats);
    let mass = 0; for await (const item of this.docs(fit)) mass += (item.document.statistics.positiveMass + item.document.statistics.negativeMass) / 1_024;
    const parametersPerEstimator = (estimators[0]?.weights.length ?? 0) + 1;
    const parameterCount = populationCount * parametersPerEstimator + Math.max(0, populationCount - 1);
    const parameterNats = 0.5 * parameterCount * Math.log(Math.max(2, mass));
    let assignmentNats = 0; for await (const item of this.assignments(assignments)) assignmentNats -= Math.log(Math.max(1e-12, priors[item.population] ?? 0));
    const modelNats = quantize(parameterNats + assignmentNats);
    return { populationCount, assignments, estimators, priors, heldoutDataNats, modelNats, descriptionNats: quantize(heldoutDataNats + modelNats),
      collapsed: false, mergeBlocked: false, mergeDescriptionDeltaNats: null, heldoutRegressionPopulationIds: [] };
  }
}
