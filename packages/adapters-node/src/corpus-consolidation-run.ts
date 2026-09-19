// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  consolidateSegmentationPopulations,
  createHasher,
  evidenceToLanguageDocument,
  forgetFittedPopulation,
  joinInformationLabels,
  normalizeInformationLabel,
  type InformationLabel,
  type CorpusConsolidationResult,
  type EvidenceSpan,
  type LanguageInductionDocument,
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
  modelId: string;
  persisted: boolean;
  elapsedMs: number;
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

  const documents: LanguageInductionDocument[] = [];
  // A model fitted from these spans is derived from every one of them, so it cannot carry a looser label than
  // the strictest contributor. Joined, not assumed.
  const labels = new Map<string, InformationLabel>();
  let spansRead = 0;
  let afterId: string | undefined;
  for (;;) {
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
      documents.push(evidenceToLanguageDocument(span));
      if (options.maxDocuments !== undefined && documents.length >= options.maxDocuments) break;
    }
    options.onProgress?.({ documents: documents.length, spans: spansRead });
    if (page.length < pageSize) break;
    if (options.maxDocuments !== undefined && documents.length >= options.maxDocuments) break;
  }
  if (!documents.length) {
    throw new Error("consolidation found no promoted evidence spans; ingest first");
  }

  const consolidated = consolidateSegmentationPopulations({
    documents,
    hasher,
    ...(options.windowCharBudget === undefined ? {} : { windowCharBudget: options.windowCharBudget }),
    ...(options.fitIterations === undefined ? {} : { fitIterations: options.fitIterations })
  });

  let persisted = false;
  if (store) {
    const sourceVersionIds = [...new Set(documents
      .map(document => document.sourceVersionId)
      .filter((id): id is SourceVersionId => id !== undefined))].sort();
    await store.putModel({
      id: consolidated.model.id,
      model: consolidated.model,
      // The pass that produced it, so a later operator can tell a consolidated fit from a shard's.
      trainingPlanId: `corpus_consolidation.${consolidated.model.rootPopulationId}`,
      profileIds: [],
      sourceVersionIds,
      createdAt: Date.now(),
      informationLabel: consolidatedLabel(labels, options.informationLabel)
    });
    persisted = true;
    // A process that consolidates and then keeps ingesting must read the new model, not the cached old one.
    forgetFittedPopulation(store);
  }

  return {
    ...consolidated,
    spansRead,
    modelId: consolidated.model.id,
    persisted,
    elapsedMs: Date.now() - startedAt
  };
}
