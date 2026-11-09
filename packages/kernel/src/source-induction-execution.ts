// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LanguageInductionDocument, InducedLanguageModel } from "./language-induction.js";
import type { InducedLanguageMemoryModel } from "./language-induction-memory.js";
import type { CorpusSegmentationBatchLoader, PreparedCorpusSegmentationMeasurement, VerifiedCorpusSegmentation } from "./corpus-segmentation-cursor.js";
import type { SourceInductionWindow } from "./source-window-induction.js";

export interface SourceInductionBatch {
  documents: LanguageInductionDocument[];
  windows: SourceInductionWindow[];
}
export interface SourceInductionBatchIdentity { batchKey: string; corpusBinding?: string }
export interface SourceInductionBatchProduct { compact: InducedLanguageMemoryModel; fullModel?: InducedLanguageModel }
export interface SourceInductionBatchJob {
  ordinal: number;
  batch: SourceInductionBatch;
  retainFullModel: boolean;
  corpusIdentity?: CorpusSegmentationBatchLoader["identity"];
  batchBudgetUtf16: number;
  windowCapUtf16: number;
  jobDigest: string;
}
/** A leased pure-computation session. Public preparation descriptors cross the port; private measurement handles do not. */
export interface SourceInductionBatchSession {
  readonly jobDigest: string;
  readonly preparations: readonly PreparedCorpusSegmentationMeasurement[];
  verify(corpus?: VerifiedCorpusSegmentation): Promise<SourceInductionBatchIdentity>;
  induce(): Promise<SourceInductionBatchProduct>;
  close(): Promise<void>;
}
export interface SourceInductionBatchExecution {
  readonly concurrency: number;
  open(job: SourceInductionBatchJob): Promise<SourceInductionBatchSession>;
  /** Close cancels outstanding work, drains owned resources, and is idempotent. */
  close(reason?: unknown): Promise<void>;
}
