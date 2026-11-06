// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { productionReadinessFailures } from "../../../../tools/production-live-question-contract.mjs";

function readyBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    exactCounts: true,
    warmup: { ok: true, complete: true, phase: "ready" },
    postgres: {
      schema: "scce.postgres.status.v1",
      ok: true,
      connected: true,
      countSemantics: "postgres_exact_table_counts",
      tableCounts: {
        sources: 3,
        evidence_spans: 4,
        graph_nodes: 5,
        graph_edges: 6,
        language_profiles: 1,
        language_patterns: 2,
        ngram_models: 1,
        ngram_observations: 0
      },
      activeBrain: { activeBrainVersion: "brain-1", activeImportRunIds: ["run-1"] }
    },
    ...overrides
  };
}

describe("production live question readiness contract", () => {
  it("accepts model-backed language state with no raw observations", () => {
    expect(productionReadinessFailures(readyBody())).toEqual([]);
  });

  it("rejects raw observations and missing model state independently", () => {
    const body = readyBody();
    body.postgres.tableCounts.ngram_observations = 1;
    body.postgres.tableCounts.ngram_models = 0;

    expect(productionReadinessFailures(body)).toContain("postgres.raw_ngram_observations_empty");
    expect(productionReadinessFailures(body)).toContain("postgres.language_state_hydrated");
  });
});
