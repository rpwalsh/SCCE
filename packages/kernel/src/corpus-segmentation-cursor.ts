// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BoundaryStatisticsRow, BoundarySufficientStatistics } from "./boundary-estimator.js";
import type { JsonValue } from "./types.js";
import type { CompiledBoundaryFeatureContext } from "./surface-lattice.js";
import type { SegmentationPopulationInferenceModel } from "./segmentation-population.js";

export interface SegmentationSourceInventory {
  id: string;
  count: number;
}

export interface BoundaryStatisticsCursorHeader extends Omit<BoundarySufficientStatistics, "rows" | "sourceDocumentIds"> {
  rowCount: number;
  sourceInventory: SegmentationSourceInventory;
}

/** Each opening replays the same complete canonical order from the frozen run. */
export interface BoundaryStatisticsCursor {
  header: BoundaryStatisticsCursorHeader;
  storage?: { rowsCollection: string; sourceDocumentsCollection: string };
  rows(): AsyncIterable<readonly BoundaryStatisticsRow[]>;
  sourceDocuments(): AsyncIterable<readonly string[]>;
  dispose?(): Promise<void>;
}

export interface CorpusSegmentationDocument {
  ordinal: number;
  documentId: string;
  sourceFamilyId: string;
  statistics: BoundaryStatisticsCursorHeader;
}

export interface CorpusSegmentationScratchRow {
  orderKey: string;
  value: JsonValue;
}

export type BoundaryFitNumericSection = "training" | "calibration";
export interface BoundaryFitNumericBinding {
  statisticsId: string;
  headerDigest: string;
  rowWidth: number;
  rowCount: number;
}
/** Private fit-lifetime replay of already validated numeric columns; canonical statistics stay in their source store. */
export interface BoundaryFitNumericReplay {
  readonly pageRows: number;
  readonly maxPageBytes: number;
  append(section: BoundaryFitNumericSection, binding: BoundaryFitNumericBinding, values: Float64Array): Promise<void>;
  seal(section: BoundaryFitNumericSection, binding: BoundaryFitNumericBinding): Promise<void>;
  pages(section: BoundaryFitNumericSection, binding: BoundaryFitNumericBinding): AsyncIterable<Float64Array>;
  dispose(): Promise<void>;
}

/** Collections belong to one immutable run; keys use ASCII byte ordering. */
export interface CorpusSegmentationScratch {
  readonly pageRows: number;
  readonly maxPageBytes: number;
  pages(query: { collection: string; afterKey?: string; prefix?: string; pageRows: number; maxPageBytes: number }): AsyncIterable<readonly CorpusSegmentationScratchRow[]>;
  putMany(collection: string, rows: readonly CorpusSegmentationScratchRow[]): Promise<void>;
  deleteCollection(collection: string): Promise<void>;
  count(collection: string): Promise<number>;
  digestChunks(chunks: AsyncIterable<Uint8Array>): Promise<string>;
  /** A private lease for the append/rebuild collections owned by ONE boundary-statistics merge. */
  boundaryMergeScratch?(): { scratch: CorpusSegmentationScratch; dispose(): Promise<void> };
  boundaryFitNumericReplay?(): Promise<BoundaryFitNumericReplay>;
}

export interface CorpusSegmentationDocumentCursor {
  readonly documentCount: number;
  readonly sourceInventory: SegmentationSourceInventory;
  documents(): AsyncIterable<readonly CorpusSegmentationDocument[]>;
  statistics(document: CorpusSegmentationDocument): BoundaryStatisticsCursor;
  readonly scratch: CorpusSegmentationScratch;
}

export interface PreparedCorpusSegmentationMeasurement {
  readonly id: string;
  readonly documentId: string;
  readonly requiredClassIds: readonly string[];
  readonly requiredContextKeys: readonly string[];
}

export interface CorpusSegmentationContextSlice {
  featureContext: CompiledBoundaryFeatureContext;
  binding: {
    measurementId: string;
    snapshotId: string;
    sourceInventory: SegmentationSourceInventory;
    contextId: string;
    normalizationContractId: string;
    valueDigest: string;
  };
}

export interface VerifiedCorpusSegmentation {
  populationInference: SegmentationPopulationInferenceModel;
  slices: readonly { preparation: PreparedCorpusSegmentationMeasurement; contextSlice: CorpusSegmentationContextSlice }[];
}

export interface CorpusSegmentationBatchLoader {
  readonly identity: Pick<SegmentationPopulationInferenceModel, "id" | "featureContextId" | "sourceInventory" | "normalizationContractId">;
  resolve(preparations: readonly PreparedCorpusSegmentationMeasurement[]): Promise<VerifiedCorpusSegmentation>;
}
