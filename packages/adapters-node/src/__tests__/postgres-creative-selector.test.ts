// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

it("preserves header admission and returns creative selectors without decoding observation bodies", async () => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "selector", informationAccess: {
    tenantId: "fixture", principalId: "owner", compartments: [], maximumExportClass: "restricted"
  } });
  const calls: string[] = [];
  const value = { schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, reliability: "source_observed", id: "observed",
    requestFrameAnchors: [{ lexicalKeys: ["opaque"] }], sourceUtterancePrerequisites: { recipe: "opaque", requests: [] },
    sourceObservations: { schema: "scce.creative_source_observation_factors.v1" } };
  adapter.query = async <T>(sql: string): Promise<T[]> => { calls.push(sql); return [{ id: "observed", profile_id: "profile",
    pattern_kind: "semantic_role", support: 1, entropy: 0, pattern_json: value, evidence_ids: ["owner"], updated_at: new Date(1),
    information_label: { tenantId: "fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" }
  }] as T[]; };
  try {
    const [selector] = await adapter.languageMemory.listLanguagePatterns({ view: "creative_selector", patternSchemas: [CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA], limit: 2048 });
    expect(selector!.patternJson).toEqual({ schema: value.schema, reliability: value.reliability, id: value.id,
      requestFrameAnchors: value.requestFrameAnchors, sourceUtterancePrerequisites: value.sourceUtterancePrerequisites });
    expect(calls).toHaveLength(2);
    const read = calls.find(sql => sql.includes("pattern_headers AS MATERIALIZED"))!;
    expect(read).toContain("candidates AS MATERIALIZED");
    expect(read).toContain("admitted AS (");
    expect(read).toContain('"sourceUtterancePrerequisites" jsonb');
    expect(read).not.toContain('"sourceObservations" jsonb');
    expect(read).toContain("pattern.pattern_kind<>'source_compilation'");
    await expect(adapter.languageMemory.listLanguagePatterns({ patternIds: ["observed"], limit: 1 }))
      .rejects.toThrow("source observation factors");
  } finally { await adapter.close(); }
});
