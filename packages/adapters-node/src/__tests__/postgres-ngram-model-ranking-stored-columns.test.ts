// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  ngramModelProfileIdExpression,
  ngramModelSourceSystemExpression,
  ngramModelTrainedMassExpression,
  schemaStatements
} from "../postgres.js";

// Measured live: the profile-scoped listNgramModels shape (query.profileIds, the shape the clean brain is made of --
// one profile per ingested file) costs 21.8s/1.7GB for twelve rows with 462 distinct profiles. 462 values on a
// leading key are 462 index ranges, and a btree cannot emit one global trainedMass DESC order across them, so the
// sort evaluates the ranking key from the heap -- confirmed live: scce3_runtime.ngram_models has no index pairing
// profileId with trainedMass at all (idx_..._ngram_model_profile_updated only orders by updated_at). The existing
// profileId+trainedMass index shape (freshSchemaIndexStatements) is fresh-schema-only because building it against
// model_json (1.68GB of TOAST against a 784kB heap) would hold a write lock for the life of that read. Stored
// narrow columns make the same shape cheap enough to build unconditionally, same contract as source_kind (3af27d4).

const OLD_NGRAM_MODEL_PROFILE_ID_EXPRESSION = "model_json->>'profileId'";
const OLD_NGRAM_MODEL_SOURCE_SYSTEM_EXPRESSION = "model_json->>'sourceSystem'";
const OLD_NGRAM_MODEL_TRAINED_MASS_EXPRESSION = "COALESCE((model_json->'model'->>'totalUnigramCount')::numeric, 0)";

describe("ngram_models ranking and scope keys are stored columns, not per-row model_json detoasts", () => {
  const statements = schemaStatements("fixture");
  const joined = statements.join("\n");

  it("declares profile_id, source_system and trained_mass as the exact expressions the WHERE/ORDER BY used to evaluate", () => {
    const column = statements.find(sql => sql.includes("ALTER TABLE") && sql.includes("ngram_models") && sql.includes("profile_id TEXT GENERATED ALWAYS AS"));
    expect(column).toBeDefined();
    expect(column).toContain(`profile_id TEXT GENERATED ALWAYS AS (${OLD_NGRAM_MODEL_PROFILE_ID_EXPRESSION}) STORED`);
    expect(column).toContain(`source_system TEXT GENERATED ALWAYS AS (${OLD_NGRAM_MODEL_SOURCE_SYSTEM_EXPRESSION}) STORED`);
    expect(column).toContain(`trained_mass NUMERIC GENERATED ALWAYS AS (${OLD_NGRAM_MODEL_TRAINED_MASS_EXPRESSION}) STORED`);
  });

  it("reads the stored columns in the scope-filter and ranking expressions and never touches model_json there", () => {
    expect(ngramModelProfileIdExpression("model")).toBe("model.profile_id");
    expect(ngramModelSourceSystemExpression("model")).toBe("model.source_system");
    expect(ngramModelTrainedMassExpression("model")).toBe("model.trained_mass");
    for (const expression of [ngramModelProfileIdExpression("model"), ngramModelSourceSystemExpression("model"), ngramModelTrainedMassExpression("model")]) {
      expect(expression).not.toContain("model_json");
    }
  });

  it("indexes the stored columns with the scope-key, trained_mass DESC, updated_at DESC, id shape so an ordered index scan serves the profile-scoped and source-system-scoped ranking", () => {
    expect(joined).toMatch(/idx_fixture_ngram_model_profile_id_trained_rank ON "?fixture"?\.ngram_models\s*\(profile_id, trained_mass DESC, updated_at DESC, id\)/u);
    expect(joined).toMatch(/idx_fixture_ngram_model_source_system_trained_rank ON "?fixture"?\.ngram_models\s*\(source_system, trained_mass DESC, updated_at DESC, id\)/u);
  });
});
