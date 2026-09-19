// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  compileRelationPromotionModel,
  consolidationPopulationId,
  createHasher,
  fitConsolidatedPopulations,
  inductionCharBudget,
  measureWindow,
  createBoundaryFeatureContextAccumulator,
  CONSOLIDATION_WINDOW_POPULATION_ID,
  evidenceToLanguageDocument,
  forgetConsolidatedPromotion,
  forgetFittedPopulation,
  joinInformationLabels,
  normalizeInformationLabel,
  type InformationLabel,
  type CorpusConsolidationResult,
  type EvidenceSpan,
  type LanguageInductionDocument,
  type Hasher,
  type RelationObservation,
  type SegmentationPopulationTrainingDocument,
  type SemanticCandidateChannel,
  type ScceStorage,
  type SourceVersionId
} from "@scce/kernel";

/**
 * The consolidation pass, run against a real corpus.
 *
 * Ingestion ingests the firehose; this runs afterwards and does the fitting. It streams every promoted span out
 * of Postgres in id order, measures boundary statistics over all of them, fits the segmentation population
 * model once to convergence, and persists it -- which is what the next ingest run then reads instead of fitting
 * a population per shard.
 */
export interface ConsolidateCorpusOptions {
  storage: ScceStorage;
  /** Spans per database page. A read size, not a modeling parameter. */
  pageSize?: number;
  /** Stop after this many documents, for a bounded rehearsal against a large corpus. */
  maxDocuments?: number;
  /**
   * How many documents' boundary statistics are held for the population fit.
   *
   * Every document is still read, measured, and folded into the corpus feature context. What is bounded is
   * only the set whose PER-DOCUMENT statistics stay resident for clustering, because learnSegmentationPopulations
   * needs them individually and they do not compress: measured at ~740 rows a document and still growing
   * linearly at 400 documents, so holding all of them died at 5,500 with a 7GB heap exhausted.
   *
   * The fit does not need all of them. Held-out log loss over a disjoint set measured 0.146 at 100 documents,
   * 0.115 at 200 and 0.118 at 400 -- it plateaus, and more documents buy noise. The default sits well past
   * that plateau and inside the heap, and the sample is drawn across the whole corpus by a hash of document id
   * rather than by arrival, so a later consolidation of a larger corpus draws on the newer documents too.
   */
  fitSampleDocuments?: number;
  /** Characters of document text held alive at once during measurement. */
  windowCharBudget?: number;
  /** "converge" escalates the descent budget until the quantization floor is reached. */
  fitIterations?: number | "converge";
  /** Fallback label, used only when not one contributing span carried one. */
  informationLabel?: InformationLabel;
  /** Report progress while streaming, because a full corpus read is not instant. */
  onProgress?(progress: { documents: number; spans: number }): void;
}

export interface ConsolidateCorpusResult extends CorpusConsolidationResult {
  spansRead: number;
  /** Documents measured and folded into the corpus feature context: every one that was read. */
  documentsMeasured: number;
  /** Documents whose per-document statistics were retained for the population fit. */
  documentsFitted: number;
  modelId: string;
  persisted: boolean;
  elapsedMs: number;
  /** The relation promotion fit, absent when the brain records no observations. */
  relationPromotion?: {
    modelId: string;
    observations: number;
    /** Every observation the table holds, so a bounded fit's scope is visible against it. */
    observationsOnFile: number;
    decisions: number;
    promoted: number;
    persisted: boolean;
  };
}

/** Never widens: a model derived from labelled spans carries their join, and an unlabelled corpus refuses. */
function consolidatedLabel(
  labels: ReadonlyMap<string, InformationLabel>,
  fallback: InformationLabel | undefined
): InformationLabel {
  if (labels.size) return joinInformationLabels([...labels.values()], { explicitMergeAuthority: false });
  if (fallback) return normalizeInformationLabel(fallback);
  throw new Error("consolidation will not label a model it cannot derive a label for; pass informationLabel");
}

/**
 * Algorithm R's replacement slot for the nth document considered, drawn from a hash of its id.
 *
 * Standard reservoir sampling picks j uniform on [0, n) for the nth item and replaces reservoir[j] when j is
 * below the reservoir size. The only departure here is the source of j: a hash of the document id rather than
 * a random number generator, so the same corpus read in the same order selects the same documents and the fit
 * is replayable. Each document contributes one independent draw, which is what Algorithm R requires, so the
 * inclusion probability is the standard k/n.
 *
 * Exported for the test that checks the sample really does span the stream rather than favouring its start.
 */
export function fitSampleSlot(documentId: string, consideredSoFar: number, hasher: Hasher): number {
  const digest = hasher.digestHex(`corpus-consolidation-fit-sample${documentId}`);
  const draw = Number.parseInt(digest.slice(0, 8), 16) / 0x100000000;
  return Math.floor(draw * Math.max(1, consideredSoFar));
}

export async function consolidateCorpus(
  options: ConsolidateCorpusOptions
): Promise<ConsolidateCorpusResult> {
  const startedAt = Date.now();
  const store = options.storage.segmentationPopulations;
  if (!options.storage.evidence.listPromotedEvidenceSpans) {
    throw new Error("consolidation requires a storage adapter that can stream promoted evidence spans");
  }
  const hasher = createHasher();
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 500));

  // Windowed AS IT READS. An earlier version pushed every span into one array and windowed afterwards, so the
  // whole promoted corpus's text was resident before a single window was measured -- the lattices were bounded
  // and the input was not. Now only the current window's text is alive; what survives a window is its
  // statistics, plus one identity row per document for the population id.
  const windowCharBudget = Math.max(1, Math.floor(options.windowCharBudget ?? inductionCharBudget()));
  const trainingDocuments: SegmentationPopulationTrainingDocument[] = [];
  const fitSampleDocuments = Math.max(1, Math.floor(options.fitSampleDocuments ?? 2000));
  let sampledDocuments = 0;
  // Recurrence accumulated across every window, so the shard that later reads it sees the corpus, not a shard.
  const featureContext = createBoundaryFeatureContextAccumulator();
  const identities: Array<{ id: string; sourceVersionId?: SourceVersionId }> = [];
  // A model fitted from these spans is derived from every one of them, so it cannot carry a looser label than
  // the strictest contributor. Joined, not assumed.
  const labels = new Map<string, InformationLabel>();
  const sourceVersions = new Set<SourceVersionId>();
  // Relation observations key on the SOURCE id, not the source version, so a bounded run has to collect the
  // ids it can actually match against. Verified against the live table rather than inferred.
  const sourceIds = new Set<string>();
  let pending: LanguageInductionDocument[] = [];
  let pendingChars = 0;
  let windowCount = 0;
  let documentCount = 0;
  let spansRead = 0;
  let afterId: string | undefined;

  // A reservoir, so the sample spans the whole corpus without knowing its size in advance and without holding
  // more than the sample. The draw comes from a hash of the document id rather than a random source, so the
  // same corpus in the same order yields the same fit and replay holds.
  let documentsConsidered = 0;
  const considerForFit = (document: SegmentationPopulationTrainingDocument): void => {
    documentsConsidered += 1;
    if (trainingDocuments.length < fitSampleDocuments) {
      trainingDocuments.push(document);
      sampledDocuments += 1;
      return;
    }
    const slot = fitSampleSlot(document.documentId, documentsConsidered, hasher);
    if (slot < fitSampleDocuments) trainingDocuments[slot] = document;
  };

  const flushWindow = (): void => {
    if (!pending.length) return;
    // Every document is measured: the feature context is corpus-wide and depends on all of them. Only the
    // sampled documents' per-document statistics are retained past this call; the rest are released with the
    // window, which is what keeps the pass inside a heap.
    const measured = measureWindow({
      documents: pending,
      populationId: CONSOLIDATION_WINDOW_POPULATION_ID,
      hasher,
      featureContext
    });
    for (const document of measured) considerForFit(document);
    windowCount += 1;
    pending = [];
    pendingChars = 0;
  };

  streaming: for (;;) {
    const page: EvidenceSpan[] = await options.storage.evidence.listPromotedEvidenceSpans({
      limit: pageSize,
      ...(afterId ? { afterId } : {})
    });
    if (!page.length) break;
    spansRead += page.length;
    afterId = String(page[page.length - 1]!.id);
    for (const span of page) {
      if (!span.text.trim()) continue;
      if (span.informationLabel) {
        labels.set(JSON.stringify(span.informationLabel), span.informationLabel);
      }
      const document = evidenceToLanguageDocument(span);
      if (pending.length && pendingChars + document.text.length > windowCharBudget) flushWindow();
      pending.push(document);
      pendingChars += document.text.length;
      identities.push({
        id: document.id,
        ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {})
      });
      if (document.sourceVersionId) sourceVersions.add(document.sourceVersionId);
      if (span.sourceId) sourceIds.add(String(span.sourceId));
      documentCount += 1;
      if (options.maxDocuments !== undefined && documentCount >= options.maxDocuments) break streaming;
    }
    options.onProgress?.({ documents: documentCount, spans: spansRead });
    if (page.length < pageSize) break;
  }
  flushWindow();
  if (!trainingDocuments.length) {
    throw new Error("consolidation found no promoted evidence spans; ingest first");
  }

  const consolidated = fitConsolidatedPopulations({
    trainingDocuments,
    populationId: consolidationPopulationId(identities, hasher),
    windowCount,
    hasher,
    featureContext,
    ...(options.fitIterations === undefined ? {} : { fitIterations: options.fitIterations })
  });

  let persisted = false;
  if (store) {
    const sourceVersionIds = [...sourceVersions].sort();
    await store.putModel({
      id: consolidated.model.id,
      model: consolidated.model,
      // The pass that produced it, so a later operator can tell a consolidated fit from a shard's.
      trainingPlanId: `corpus_consolidation.${consolidated.model.rootPopulationId}`,
      profileIds: [],
      sourceVersionIds,
      createdAt: Date.now(),
      informationLabel: consolidatedLabel(labels, options.informationLabel),
      // Stored with the model because a shard must read the pair or neither.
      ...(consolidated.boundaryFeatureContext
        ? { boundaryFeatureContext: consolidated.boundaryFeatureContext }
        : {})
    });
    persisted = true;
    // A process that consolidates and then keeps ingesting must read the new model, not the cached old one.
    forgetFittedPopulation(store);
  }

  // Bounded runs fit relations over the same source versions the population fit saw, never the whole table.
  const relationPromotion = await consolidateRelationPromotion(
    options,
    hasher,
    labels,
    options.maxDocuments === undefined ? undefined : sourceIds
  );

  return {
    ...consolidated,
    spansRead,
    documentsMeasured: documentCount,
    documentsFitted: Math.min(sampledDocuments, trainingDocuments.length),
    modelId: consolidated.model.id,
    persisted,
    elapsedMs: Date.now() - startedAt,
    ...(relationPromotion ? { relationPromotion } : {})
  };
}

/**
 * Relation promotion, fitted once over every observation the corpus holds.
 *
 * Ingest decided this per block, which meant re-reading the observation table and re-deciding every seed in the
 * corpus each time -- 172k observations and 171,836 seeds per block, measured live, with throughput falling from
 * 576 to 85 sources an hour as the table grew. Deciding once over the whole population is both cheaper and
 * better evidenced: promotion measures corroboration across independent source families, and a block sees a
 * handful of them where the corpus holds all of them.
 */
async function consolidateRelationPromotion(
  options: ConsolidateCorpusOptions,
  hasher: ReturnType<typeof createHasher>,
  labels: ReadonlyMap<string, InformationLabel>,
  boundToSourceIds: ReadonlySet<string> | undefined
): Promise<ConsolidateCorpusResult["relationPromotion"]> {
  const observationStore = options.storage.relationObservations;
  if (!observationStore) return undefined;
  const records = await observationStore.list();
  if (!records.length) return undefined;
  // A bounded run must not fit relations over the whole table while its label was derived from a slice: the
  // model would be built from more sources than its label reflects. Bounded runs fit the same population.
  const scoped = boundToSourceIds
    ? records.filter(row => boundToSourceIds.has(String(row.sourceId)))
    : records;
  if (!scoped.length) return undefined;
  const priorObservations: RelationObservation[] = scoped.map(row => ({
    candidateId: row.candidateId,
    relationSeedId: row.relationSeedId,
    channel: row.channel as SemanticCandidateChannel,
    sourceId: row.sourceId,
    sourceFamilyId: row.sourceFamilyId,
    signature: row.signature
  }));
  // No candidates: every observation is already a persisted sufficient statistic, and the compiler merges the
  // two the same way regardless of which side they arrive on.
  const model = compileRelationPromotionModel({ candidates: [], priorObservations, hasher });
  const store = options.storage.relationPromotionModels;
  if (store) {
    await store.putModel({
      id: model.id,
      model,
      // A bounded fit says so, so nothing later mistakes a rehearsal for a corpus-wide model.
      basis: boundToSourceIds ? "corpus_consolidation_bounded" : "corpus_consolidation",
      observationCount: priorObservations.length,
      createdAt: Date.now(),
      informationLabel: consolidatedLabel(labels, options.informationLabel)
    });
    forgetConsolidatedPromotion(store);
  }
  return {
    modelId: model.id,
    observations: priorObservations.length,
    observationsOnFile: records.length,
    decisions: model.decisions.length,
    promoted: model.decisions.filter(decision => decision.promoted).length,
    persisted: Boolean(store)
  };
}
