import { afterEach, describe, expect, it } from "vitest";
import type {
  SegmentationPopulationModel,
  SegmentationPopulationModelRecord
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

function model(id: string): SegmentationPopulationModel {
  return {
    schema: "scce.segmentation_population_model.v2",
    id,
    rootPopulationId: "population.fixture",
    populations: [],
    assignments: [],
    selection: {
      fitDocumentIds: ["doc.fit"],
      holdoutDocumentIds: ["doc.holdout"],
      candidates: [{
        populations: 1,
        heldoutDataNats: 2,
        modelNats: 3,
        descriptionNats: 5,
        collapsed: false,
        mergeBlocked: false,
        mergeDescriptionDeltaNats: null,
        heldoutRegressionPopulationIds: []
      }],
      selectedPopulationCount: 0,
      baselineDescriptionNats: 5,
      selectedDescriptionNats: 5,
      mdlGainNats: 0
    },
    audit: {}
  };
}

function record(id = "segmentation_population.fixture"): SegmentationPopulationModelRecord {
  return {
    id,
    model: model(id),
    trainingPlanId: "training.fixture",
    profileIds: ["profile.fixture"],
    sourceVersionIds: ["source.fixture" as never],
    createdAt: 1_000,
    informationLabel: {
      tenantId: "tenant.fixture",
      principals: ["principal.fixture"],
      compartments: [],
      exportClass: "internal",
      mergePolicy: "same_owner"
    }
  };
}

function fixture(rows: Array<Record<string, unknown>>) {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture"
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("SELECT") && sql.includes("segmentation_population_models")) {
      if (sql.includes("WHERE id=$1")) {
        return rows.filter(row => row.id === params[0]) as T[];
      }
      return rows as T[];
    }
    return [];
  };
  return { adapter, calls };
}

describe("Postgres segmentation population store", () => {
  it("persists complete population state and selection metadata", async () => {
    const { adapter, calls } = fixture([]);
    await adapter.segmentationPopulations.putModel(record());
    const insert = calls.find(call =>
      call.sql.includes("INSERT INTO") && call.sql.includes("segmentation_population_models"));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe("segmentation_population.fixture");
    expect(insert!.params[3]).toEqual(["profile.fixture"]);
    expect(insert!.params[4]).toEqual(["source.fixture"]);
  });

  it("hydrates recent models through bounded profile-overlap lookup", async () => {
    const stored = record();
    const { adapter, calls } = fixture([{
      id: stored.id,
      training_plan_id: stored.trainingPlanId,
      model_json: stored.model,
      profile_ids: stored.profileIds,
      source_version_ids: stored.sourceVersionIds,
      information_label: stored.informationLabel,
      created_at: new Date(stored.createdAt)
    }]);
    const rows = await adapter.segmentationPopulations.listRecent({
      profileIds: ["profile.fixture"],
      limit: 3
    });
    expect(rows).toEqual([stored]);
    const select = calls.find(call =>
      call.sql.includes("profile_ids &&") && call.sql.includes("segmentation_population_models"));
    expect(select?.params).toEqual([["profile.fixture"], 3]);
  });
});
