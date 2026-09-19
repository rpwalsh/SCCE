// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  compileBoundaryStatistics,
  mergeBoundaryStatistics,
  type BoundarySufficientStatistics
} from "./boundary-estimator.js";
import type { LanguageInductionDocument } from "./language-induction.js";
import { createHasher } from "./primitives.js";
import {
  learnSegmentationPopulations,
  type SegmentationPopulationModel,
  type SegmentationPopulationTrainingDocument
} from "./segmentation-population.js";
import {
  buildSurfaceLattice,
  collectBoundaryTrainingObservations
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

export function consolidateSegmentationPopulations(
  input: CorpusConsolidationInput
): CorpusConsolidationResult {
  const hasher = input.hasher ?? createHasher();
  const documents = input.documents.filter(document => document.text.trim().length > 0);
  const populationId = `corpus_population.${hasher.digestHex(JSON.stringify(
    documents.map(document => [document.id, document.sourceVersionId ?? null]).sort()
  )).slice(0, 32)}`;

  const windows = consolidationWindows(documents, Math.max(1, Math.floor(
    input.windowCharBudget ?? inductionCharBudget()
  )));
  const trainingDocuments: SegmentationPopulationTrainingDocument[] = [];
  for (const window of windows) {
    // Lattices for one window only. They exist to derive boundary observations and nothing else, so they die
    // with the window and the loop's peak is one window, not the corpus.
    const lattices = window.map(document => ({
      document,
      lattice: buildSurfaceLattice({
        documentId: document.id,
        text: document.text,
        sourceVersionId: document.sourceVersionId,
        evidenceIds: document.evidenceIds,
        hasher
      })
    }));
    const observations = collectBoundaryTrainingObservations({
      lattices: lattices.map(row => row.lattice),
      anchors: lattices.flatMap(({ document }) =>
        (document.boundaryAnchors ?? []).map(anchor => ({ ...anchor, documentId: document.id })))
    });
    for (const { document } of lattices) {
      trainingDocuments.push({
        documentId: document.id,
        sourceFamilyId: document.sourceFamilyId ?? String(document.sourceVersionId ?? document.id),
        statistics: compileBoundaryStatistics({
          populationId,
          observations: observations.filter(observation => observation.sourceDocumentId === document.id),
          sourceDocumentIds: [document.id],
          hasher
        })
      });
    }
  }

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
    statistics,
    documentCount: trainingDocuments.length,
    windowCount: windows.length,
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
