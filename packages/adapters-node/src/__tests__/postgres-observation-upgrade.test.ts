// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createPostgresStorageAdapter, schemaStatements } from "../postgres.js";

it("upgrades observation scope indexes without rewriting the corpus and keeps scoped readers on those keys", async () => {
  const statements = schemaStatements('"fixture"');
  expect(statements.some(sql => /ALTER TABLE.*ngram_observations.*GENERATED ALWAYS/iu.test(sql))).toBe(false);
  expect(statements).toContain('CREATE INDEX IF NOT EXISTS idx_fixture_ngram_profile_rank ON "fixture".ngram_observations((metadata_json->>\'profileId\'),count DESC,observed_at DESC)');
  expect(statements).toContain('CREATE INDEX IF NOT EXISTS idx_fixture_ngram_source_system_rank ON "fixture".ngram_observations((metadata_json->>\'sourceSystem\'),count DESC,observed_at DESC)');
  const storage = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: [], maximumExportClass: "restricted" }
  });
  const reads: string[] = [];
  storage.query = async <T,>(sql: string): Promise<T[]> => { reads.push(sql); return []; };
  try {
    await storage.languageMemory.listNgramObservations({ sourceSystem: "wikipedia", profileIds: ["profile.fixture"], limit: 3 });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("observation.metadata_json->>'profileId'");
    expect(reads[0]).toContain("observation.metadata_json->>'sourceSystem'");
    expect(reads[0]).not.toContain("observation.profile_id");
    expect(reads[0]).toContain("LIMIT");
  } finally { await storage.close(); }
});
