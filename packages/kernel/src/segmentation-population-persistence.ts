import type { SegmentationPopulationModel } from "./segmentation-population.js";
import type { InformationLabel, SourceVersionId } from "./types.js";

export interface SegmentationPopulationModelRecord {
  id: string;
  model: SegmentationPopulationModel;
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
