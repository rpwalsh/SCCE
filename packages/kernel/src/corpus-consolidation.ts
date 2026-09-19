// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  compileBoundaryStatistics,
  mergeBoundaryStatistics,
  type BoundarySufficientStatistics
} from "./boundary-estimator.js";
import type { LanguageInductionDocument } from "./language-induction.js";
import { createHasher } from "./primitives.js";
import type { SegmentationPopulationModelStore } from "./segmentation-population-persistence.js";
import {
  learnSegmentationPopulations,
  type SegmentationPopulationModel,
  type SegmentationPopulationTrainingDocument
} from "./segmentation-population.js";
import {
  buildSurfaceLattice,
  collectBoundaryTrainingObservations,
  compileAccumulatedBoundaryFeatureContext,
  createBoundaryFeatureContextAccumulator,
  observeLatticesForFeatureContext,
  type BoundaryFeatureContextAccumulator,
  type CompiledBoundaryFeatureContext
} from "./surface-lattice.js";
import { boundedInductionDocuments, inductionCharBudget } from "./training-orchestrator.js";
import type { Hasher } from "./types.js";

/**
 * Separation of powers, the second half.
 *
 * Ingestion ingests the firehose. This is the pass that runs afterwards: it reads the corpus back, measures
 * boundary sufficient statistics over it, and fits the segmentation population model ONCE, to convergence,
 * over everything -- instead of once per shard, on a bounded slice, at a partial iteration budget.
 *
 * Two things it does that a shard fit structurally cannot:
 *  - cross-document recurrence is measured across a window of the corpus rather than within one shard, and the
 *    model-selection split is source-family-disjoint over the whole population rather than over one shard's;
 *  - the descent is asked for convergence and the result REPORTS whether it got there, so a partial fit is
 *    visible instead of an iteration count masquerading as an optimum.
 *
 * Memory is bounded by windowing, not by sampling: cross-document features need many lattices alive at once, so
 * documents are processed in windows sized by the same char budget already proven for induce(), and only the
 * per-document statistics (small, mergeable) survive a window. The fit then sees every document's statistics.
 */
export interface CorpusConsolidationInput {
  documents: readonly LanguageInductionDocument[];
  hasher?: Hasher;
  /** Characters of document text held alive at once. Defaults to induce()'s proven bound. */
  windowCharBudget?: number;
  /**
   * Descent budget for the consolidated fit. A number is that budget exactly. "converge" escalates the budget
   * until the descent reports it reached the quantization floor, or until doubling it stops shrinking the step
   * -- both measured, neither a chosen iteration count. Left unset it uses the estimator's own default.
   */
  fitIterations?: number | "converge";
  maxPopulations?: number;
}

export interface CorpusConsolidationResult {
  model: SegmentationPopulationModel;
  /**
   * Corpus-wide cross-document recurrence. A shard that is handed this with the population skips its bootstrap
   * lattice pass and, measured, compresses better than deriving either alone.
   */
  boundaryFeatureContext?: CompiledBoundaryFeatureContext;
  /** Merged over every document, which is what makes this a corpus fit rather than a shard fit. */
  statistics: BoundarySufficientStatistics;
  documentCount: number;
  windowCount: number;
  /** True only when every retained population's descent reported convergence. */
  converged: boolean;
  populations: Array<{
    id: string;
    prior: number;
    documents: number;
    converged: boolean;
    iterationsRun: number;
    iterationCeiling: number;
    /** Zero exactly when the descent reached the quantization floor. */
    largestStepAtStop: number;
  }>;
  /** Every budget the escalation tried, and what the descent reported at it. Empty for a fixed budget. */
  escalation: Array<{ iterations: number; converged: boolean; worstStep: number }>;
}

/**
 * The consuming half: ingest reads the consolidated population rather than fitting one.
 *
 * Cached per store for the life of the process, because a shard must not pay a database read to find out
 * something that only changes when the offline consolidation pass runs -- and per-page database work is a
 * defect under the turn latency contract. Consolidation runs after ingest, never during it, so a value read
 * once at the start of a run is the value that holds for the whole run.
 */
const fittedPopulationByStore = new WeakMap<object, Promise<SegmentationPopulationModel | undefined>>();

export function loadFittedPopulation(
  store: SegmentationPopulationModelStore | undefined
): Promise<SegmentationPopulationModel | undefined> {
  if (!store) return Promise.resolve(undefined);
  const cached = fittedPopulationByStore.get(store);
  if (cached) return cached;
  const pending = store.listRecent({ limit: 1 })
    .then(records => records[0]?.model)
    // A brain with no consolidation yet has none, and induce() falls back to fitting. Never fatal to an ingest.
    .catch(() => undefined);
  fittedPopulationByStore.set(store, pending);
  return pending;
}

/**
 * The context that was fitted with the population, from the same record.
 *
 * Read together, never separately: pairing a corpus population with a shard context measured worse than
 * deriving both per shard, so a caller that cannot get both should pass neither.
 */
const fittedContextByStore = new WeakMap<object, Promise<CompiledBoundaryFeatureContext | undefined>>();

export function loadFittedFeatureContext(
  store: SegmentationPopulationModelStore | undefined
): Promise<CompiledBoundaryFeatureContext | undefined> {
  if (!store) return Promise.resolve(undefined);
  const cached = fittedContextByStore.get(store);
  if (cached) return cached;
  const pending = store.listRecent({ limit: 1 })
    .then(records => records[0]?.boundaryFeatureContext)
    .catch(() => undefined);
  fittedContextByStore.set(store, pending);
  return pending;
}

/** Drops the cached population, for a process that consolidates and then keeps ingesting. */
export function forgetFittedPopulation(store: SegmentationPopulationModelStore | undefined): void {
  if (store) {
    fittedPopulationByStore.delete(store);
    fittedContextByStore.delete(store);
  }
}

/** Windows of documents sized by a char budget, so a window's lattices fit the bound induce() already proved. */
function consolidationWindows(
  documents: readonly LanguageInductionDocument[],
  budget: number
): LanguageInductionDocument[][] {
  const windows: LanguageInductionDocument[][] = [];
  let pending: LanguageInductionDocument[] = [];
  let used = 0;
  for (const document of documents) {
    const bounded = boundedInductionDocuments([document])[0];
    if (!bounded) continue;
    if (pending.length && used + bounded.text.length > budget) {
      windows.push(pending);
      pending = [];
      used = 0;
    }
    pending.push(bounded);
    used += bounded.text.length;
  }
  if (pending.length) windows.push(pending);
  return windows;
}

/**
 * Measures one window and returns only its statistics, so a caller streaming out of a database never holds the
 * corpus. The lattices here were always bounded; the INPUT was not -- an array caller accumulates every
 * document's text before the first window is measured. Streaming callers use this plus fitConsolidatedPopulations.
 */
export function measureWindow(input: {
  documents: readonly LanguageInductionDocument[];
  populationId: string;
  hasher: Hasher;
  /** Folded into, so recurrence is counted across every window rather than within one. */
  featureContext?: BoundaryFeatureContextAccumulator;
}): SegmentationPopulationTrainingDocument[] {
  const bounded = input.documents
    .map(document => boundedInductionDocuments([document])[0])
    .filter((document): document is LanguageInductionDocument => document !== undefined);
  if (!bounded.length) return [];
  // Lattices for this window only. They derive boundary observations and die with the call.
  const lattices = bounded.map(document => buildSurfaceLattice({
    documentId: document.id,
    text: document.text,
    sourceVersionId: document.sourceVersionId,
    evidenceIds: document.evidenceIds,
    hasher: input.hasher
  }));
  if (input.featureContext) observeLatticesForFeatureContext(input.featureContext, lattices);
  const observations = collectBoundaryTrainingObservations({
    lattices,
    anchors: bounded.flatMap(document =>
      (document.boundaryAnchors ?? []).map(anchor => ({ ...anchor, documentId: document.id })))
  });
  return bounded.map(document => ({
    documentId: document.id,
    sourceFamilyId: document.sourceFamilyId ?? String(document.sourceVersionId ?? document.id),
    statistics: compileBoundaryStatistics({
      populationId: input.populationId,
      observations: observations.filter(observation => observation.sourceDocumentId === document.id),
      sourceDocumentIds: [document.id],
      hasher: input.hasher
    })
  }));
}

/**
 * The id every window's statistics are measured under.
 *
 * Deliberately constant rather than a hash of the corpus: a streaming caller does not know the whole document
 * set until the stream ends, and cannot retroactively re-measure windows it has already dropped the text for.
 * Per-document statistics are merged under the corpus id below, and nothing compares the two.
 */
export const CONSOLIDATION_WINDOW_POPULATION_ID = "corpus_population.window";

/** The fitted population's own id, derived from the document identities the stream actually saw. */
export function consolidationPopulationId(
  documents: readonly { id: string; sourceVersionId?: unknown }[],
  hasher: Hasher
): string {
  const key = documents.map(document => [document.id, document.sourceVersionId ?? null]).sort();
  return "corpus_population." + hasher.digestHex(JSON.stringify(key)).slice(0, 32);
}

export function consolidateSegmentationPopulations(
  input: CorpusConsolidationInput
): CorpusConsolidationResult {
  const hasher = input.hasher ?? createHasher();
  const documents = input.documents.filter(document => document.text.trim().length > 0);
  const populationId = consolidationPopulationId(documents, hasher);
  const windows = consolidationWindows(documents, Math.max(1, Math.floor(
    input.windowCharBudget ?? inductionCharBudget()
  )));
  const trainingDocuments: SegmentationPopulationTrainingDocument[] = [];
  const featureContext = createBoundaryFeatureContextAccumulator();
  for (const window of windows) {
    trainingDocuments.push(...measureWindow({
      documents: window,
      populationId: CONSOLIDATION_WINDOW_POPULATION_ID,
      hasher,
      featureContext
    }));
  }
  return fitConsolidatedPopulations({
    trainingDocuments,
    populationId,
    windowCount: windows.length,
    hasher,
    featureContext,
    ...(input.fitIterations === undefined ? {} : { fitIterations: input.fitIterations }),
    ...(input.maxPopulations === undefined ? {} : { maxPopulations: input.maxPopulations })
  });
}

/** Fits from statistics the caller already measured, so nothing in this path sees document text. */
export function fitConsolidatedPopulations(input: {
  trainingDocuments: readonly SegmentationPopulationTrainingDocument[];
  populationId: string;
  windowCount: number;
  hasher?: Hasher;
  fitIterations?: number | "converge";
  maxPopulations?: number;
  featureContext?: BoundaryFeatureContextAccumulator;
}): CorpusConsolidationResult {
  const hasher = input.hasher ?? createHasher();
  const populationId = input.populationId;
  const trainingDocuments = [...input.trainingDocuments];

  const statistics = mergeBoundaryStatistics(
    trainingDocuments.map(document => document.statistics),
    hasher,
    populationId
  );
  const learn = (fitIterations?: number): SegmentationPopulationModel => learnSegmentationPopulations({
    rootPopulationId: populationId,
    documents: trainingDocuments,
    ...(input.maxPopulations === undefined ? {} : { maxPopulations: input.maxPopulations }),
    ...(fitIterations === undefined ? {} : { fitIterations }),
    hasher
  });

  const escalation: Array<{ iterations: number; converged: boolean; worstStep: number }> = [];
  let model: SegmentationPopulationModel;
  if (input.fitIterations === "converge") {
    // Doubling, because the cost of reaching the floor is not knowable in advance -- measured at ~64,000
    // iterations for a 24-document corpus, against a default budget of 96. Escalation stops on convergence, or
    // when a doubled budget no longer shrinks the worst step, which is the descent saying it has stalled.
    let attempt = learn(undefined);
    let budget = worstCeiling(attempt);
    escalation.push(attemptReport(budget, attempt));
    while (!allConverged(attempt)) {
      const previousStep = escalation[escalation.length - 1]!.worstStep;
      budget *= 2;
      const next = learn(budget);
      const report = attemptReport(budget, next);
      escalation.push(report);
      const stalled = report.worstStep >= previousStep;
      attempt = next;
      if (report.converged || stalled) break;
    }
    model = attempt;
  } else {
    model = learn(input.fitIterations);
  }

  const populations = model.populations.map(population => {
    const descent = descentAudit(population.estimator.audit);
    return {
      id: population.id,
      prior: population.prior,
      documents: population.documentIds.length,
      converged: descent.converged,
      iterationsRun: descent.iterationsRun,
      iterationCeiling: descent.iterationCeiling,
      largestStepAtStop: descent.largestStepAtStop
    };
  });
  return {
    model,
    ...(input.featureContext
      ? { boundaryFeatureContext: compileAccumulatedBoundaryFeatureContext(input.featureContext, hasher) }
      : {}),
    statistics,
    documentCount: trainingDocuments.length,
    windowCount: input.windowCount,
    converged: populations.length > 0 && populations.every(population => population.converged),
    populations,
    escalation
  };
}

function allConverged(model: SegmentationPopulationModel): boolean {
  return model.populations.length > 0
    && model.populations.every(population => descentAudit(population.estimator.audit).converged);
}

/** The budget the most-constrained population actually ran under, which is what doubling has to beat. */
function worstCeiling(model: SegmentationPopulationModel): number {
  return Math.max(1, ...model.populations.map(population =>
    descentAudit(population.estimator.audit).iterationCeiling));
}

function attemptReport(
  iterations: number,
  model: SegmentationPopulationModel
): { iterations: number; converged: boolean; worstStep: number } {
  const steps = model.populations.map(population =>
    descentAudit(population.estimator.audit).largestStepAtStop);
  return {
    iterations,
    converged: allConverged(model),
    worstStep: steps.length ? Math.max(...steps) : Number.POSITIVE_INFINITY
  };
}

/** The descent's own report, read off the estimator audit rather than re-derived. */
function descentAudit(audit: unknown): {
  converged: boolean;
  iterationsRun: number;
  iterationCeiling: number;
  largestStepAtStop: number;
} {
  const descent = audit && typeof audit === "object" && !Array.isArray(audit)
    ? audit as Record<string, unknown>
    : {};
  return {
    converged: descent.converged === true,
    iterationsRun: typeof descent.iterationsRun === "number" ? descent.iterationsRun : 0,
    iterationCeiling: typeof descent.iterationCeiling === "number" ? descent.iterationCeiling : 0,
    largestStepAtStop: typeof descent.largestStepAtStop === "number"
      ? descent.largestStepAtStop
      : Number.POSITIVE_INFINITY
  };
}
