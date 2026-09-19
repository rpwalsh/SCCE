// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { SegmentationPopulationModel } from "./segmentation-population.js";
import type { InformationLabel, SourceVersionId } from "./types.js";

export interface SegmentationPopulationModelRecord {
  id: string;
  model: SegmentationPopulationModel;
  /**
   * Corpus-wide cross-document recurrence measured by the same pass that fitted the model.
   *
   * Stored with the model because the two only work together: measured, a shard handed the population with a
   * shard-scoped context compresses WORSE than one that derives both itself (3.637 tokens/type against 3.356),
   * while the pair beats both (3.281). The estimator was fitted against corpus-level features and has to be
   * fed them.
   */
  boundaryFeatureContext?: import("./surface-lattice.js").CompiledBoundaryFeatureContext;
  trainingPlanId: string;
  profileIds: string[];
  sourceVersionIds: SourceVersionId[];
  createdAt: number;
  informationLabel: InformationLabel;
}

export interface SegmentationPopulationModelStore {
  putModel(record: SegmentationPopulationModelRecord): Promise<void>;
  readById(id: string): Promise<SegmentationPopulationModelRecord | undefined>;
  listRecent(query?: {
    profileIds?: readonly string[];
    limit?: number;
  }): Promise<SegmentationPopulationModelRecord[]>;
}
