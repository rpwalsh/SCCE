import type { InformationLabel } from "./types.js";
import type { SegmentationModel } from "./unicode-segmentation-v2.js";

export const SEGMENTATION_AGGREGATE_SCHEMA_V1 = "scce.segmentation_aggregate.v1";

/**
 * Part B step 2: the key a durable per-language-cluster aggregate is scoped
 * under. Per the plan's own correction, "language" alone is not a safe key
 * -- it must also carry the segmentation schema version (so a v1 and v2
 * observation can never silently blend into one aggregate), tenant/
 * information-label isolation, corpus role, and the active brain/import
 * version a document was ingested under (so retiring or replacing an
 * import doesn't leave stale aggregate mass mixed with current data).
 * `languageCluster` is the script id `unicode-segmentation-v2.ts` already
 * derives (`dominantScriptId`) -- the honest unit of clustering available
 * today; a real cross-script language-identification model is separate,
 * later work, not fabricated here.
 */
export interface SegmentationAggregateKey {
  segmentationVersion: string;
  languageCluster: string;
  tenantId: string;
  corpusRole: string;
  activeImportVersion: string;
}

export interface SegmentationAggregate {
  key: SegmentationAggregateKey;
  documentsObserved: number;
  lexicalSegmentsObserved: number;
  /** Same-script adjacent lexical boundaries observed followed by whitespace, summed across every contributing document -- the running numerator for the aggregate's spacing ratio. */
  spacedBoundaryObservations: number;
  totalBoundaryObservations: number;
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface SegmentationAggregateStore {
  /**
   * Folds one document's real `SegmentationModel` boundary evidence into
   * the running aggregate for its key. Never invents evidence -- a
   * document contributes only the observations its own text actually
   * contained.
   */
  observeDocument(input: { key: SegmentationAggregateKey; model: SegmentationModel; observedAt: number }): Promise<SegmentationAggregate>;
  readAggregate(key: SegmentationAggregateKey): Promise<SegmentationAggregate | undefined>;
}

/** Pure fold used by both the in-memory and Postgres-backed store implementations, so the aggregation math has one definition. */
export function foldSegmentationAggregate(
  previous: SegmentationAggregate | undefined,
  key: SegmentationAggregateKey,
  model: SegmentationModel,
  observedAt: number
): SegmentationAggregate {
  let spaced = 0;
  let total = 0;
  for (const signal of model.boundarySignals) {
    if (signal.scriptId !== key.languageCluster) continue;
    total += signal.observations;
    spaced += Math.round(signal.observedSpacedRatio * signal.observations);
  }
  return {
    key,
    documentsObserved: (previous?.documentsObserved ?? 0) + 1,
    lexicalSegmentsObserved: (previous?.lexicalSegmentsObserved ?? 0) + model.lexicalSegments.length,
    spacedBoundaryObservations: (previous?.spacedBoundaryObservations ?? 0) + spaced,
    totalBoundaryObservations: (previous?.totalBoundaryObservations ?? 0) + total,
    firstObservedAt: previous?.firstObservedAt ?? observedAt,
    lastObservedAt: observedAt
  };
}

export function segmentationAggregateSpacedRatio(aggregate: SegmentationAggregate): number | undefined {
  return aggregate.totalBoundaryObservations > 0
    ? aggregate.spacedBoundaryObservations / aggregate.totalBoundaryObservations
    : undefined;
}

/** Deterministic string key for storage/lookup, e.g. as a Postgres composite-key column set or a Map key. */
export function segmentationAggregateKeyId(key: SegmentationAggregateKey): string {
  const parts = [key.segmentationVersion, key.languageCluster, key.tenantId, key.corpusRole, key.activeImportVersion];
  return parts.map(part => part.length + ":" + part).join("|");
}

export function segmentationAggregateInformationLabel(key: SegmentationAggregateKey, principals: readonly string[] = []): InformationLabel {
  return {
    tenantId: key.tenantId,
    principals: [...principals],
    compartments: [],
    exportClass: "internal",
    mergePolicy: "same_owner"
  };
}
