// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { productionReadinessFailures } from "../../../../tools/production-live-question-contract.mjs";
import { STORAGE_STATUS_POPULATION_LIMITS } from "../../../kernel/src/storage.js";

function readyBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    exactCounts: false,
    warmup: { ok: true, complete: true, phase: "ready" },
    postgres: {
      schema: "scce.postgres.status.v1",
      ok: true,
      connected: true,
      detail: "population",
      countSemantics: "postgres_bounded_population",
      tablePopulation: Object.fromEntries(Object.entries(STORAGE_STATUS_POPULATION_LIMITS.questions).map(([table, cap]) => [table,
        { sampledRows: table === "ngram_observations" ? 0 : cap, cap, exact: table === "ngram_observations", capReached: table !== "ngram_observations" }])),
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
    body.postgres.tablePopulation.ngram_observations = { sampledRows: 1, cap: 1, exact: false, capReached: true };
    body.postgres.tablePopulation.ngram_models = { sampledRows: 0, cap: 1, exact: true, capReached: false };

    expect(productionReadinessFailures(body)).toContain("postgres.raw_ngram_observations_empty");
    expect(productionReadinessFailures(body)).toContain("postgres.language_state_hydrated");
  });

  it.each(["sources", "evidence_spans", "graph_nodes", "graph_edges", "language_profiles", "language_patterns", "ngram_models"])("requires nonempty %s even with bounded probes", table => {
    const body = readyBody();
    body.postgres.tablePopulation[table] = { sampledRows: 0, cap: 1, exact: true, capReached: false };
    expect(productionReadinessFailures(body).length).toBeGreaterThan(0);
  });

  it("rejects estimated population and absent active import metadata", () => {
    const estimates = readyBody();
    estimates.postgres.countSemantics = "postgres_planner_estimate";
    expect(productionReadinessFailures(estimates)).toContain("postgres.population_measurements");
    const inactive = readyBody();
    inactive.postgres.activeBrain.activeImportRunIds = [];
    expect(productionReadinessFailures(inactive)).toContain("postgres.active_import");
  });
});
