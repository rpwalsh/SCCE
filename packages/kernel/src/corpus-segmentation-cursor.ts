// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BoundaryStatisticsRow, BoundarySufficientStatistics } from "./boundary-estimator.js";
import type { JsonValue } from "./types.js";

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
  rows(): AsyncIterable<readonly BoundaryStatisticsRow[]>;
  sourceDocuments(): AsyncIterable<readonly string[]>;
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

/** Collections belong to one immutable run; keys use ASCII byte ordering. */
export interface CorpusSegmentationScratch {
  readonly pageRows: number;
  readonly maxPageBytes: number;
  pages(query: { collection: string; afterKey?: string; prefix?: string; pageRows: number; maxPageBytes: number }): AsyncIterable<readonly CorpusSegmentationScratchRow[]>;
  putMany(collection: string, rows: readonly CorpusSegmentationScratchRow[]): Promise<void>;
  deleteCollection(collection: string): Promise<void>;
  count(collection: string): Promise<number>;
  digestChunks(chunks: AsyncIterable<Uint8Array>): Promise<string>;
}

export interface CorpusSegmentationDocumentCursor {
  readonly documentCount: number;
  readonly sourceInventory: SegmentationSourceInventory;
  documents(): AsyncIterable<readonly CorpusSegmentationDocument[]>;
  statistics(document: CorpusSegmentationDocument): BoundaryStatisticsCursor;
  readonly scratch: CorpusSegmentationScratch;
}
