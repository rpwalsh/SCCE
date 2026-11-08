// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { exactHydrationSummary, HYDRATION_REQUIREMENTS } from "../../../../tools/launch-ready-contract.mjs";
import { STORAGE_STATUS_POPULATION_LIMITS, type StoragePopulationProbe } from "../../../kernel/src/storage.js";

function boundedBody() {
  const tablePopulation: Record<string, StoragePopulationProbe> = Object.fromEntries(Object.entries(STORAGE_STATUS_POPULATION_LIMITS.launch).map(([table, cap]) => [table,
    { sampledRows: table === "ngram_observations" ? 0 : cap, cap, exact: table === "ngram_observations", capReached: table !== "ngram_observations" }]));
  return { warmup: { phase: "ready", ok: true, complete: true }, postgres: { detail: "population", countSemantics: "postgres_bounded_population",
    tablePopulation } };
}

describe("launch-ready measured population contract", () => {
  it("accepts completed warmup with exact counts at every minimum", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "ready", ok: true, complete: true },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
        detail: "exact",
        tableCounts: { ...HYDRATION_REQUIREMENTS, ngram_observations: 0 }
      }
    });

    expect(result).toMatchObject({ ok: true, countSemantics: "postgres_exact_table_counts", failures: [] });
  });

  it("rejects planner estimates even when they exceed every minimum", () => {
    const overMinimum = {
      ...Object.fromEntries(Object.entries(HYDRATION_REQUIREMENTS).map(([table, minimum]) => [table, minimum * 10])),
      ngram_observations: 0
    };
    const result = exactHydrationSummary({
      warmup: { phase: "ready", ok: true, complete: true },
      postgres: {
        countSemantics: "postgres_planner_estimate",
        tableCounts: overMinimum
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("readiness population is not measured (semantics=postgres_planner_estimate)");
  });

  it("rejects exact counts while warmup is still running", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "running", ok: false, complete: false },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
        detail: "exact",
        tableCounts: { ...HYDRATION_REQUIREMENTS, ngram_observations: 0 }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("runtime warmup is not complete (phase=running)");
  });

  it("requires model-backed language state and zero raw observations", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "ready", ok: true, complete: true },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
        detail: "exact",
        tableCounts: { ...HYDRATION_REQUIREMENTS, ngram_models: 0, ngram_observations: 7 }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("hydration table ngram_models has 0, expected at least 1");
    expect(result.failures).toContain("hydration table ngram_observations has 7, expected 0");
  });

  it("keeps every existing population bar and accepts bounded evidence at the same minima", () => {
    expect(STORAGE_STATUS_POPULATION_LIMITS.launch).toEqual({ ...HYDRATION_REQUIREMENTS, ngram_observations: 1 });
    const result = exactHydrationSummary(boundedBody());
    expect(result).toMatchObject({ ok: true, countSemantics: "postgres_bounded_population", failures: [] });
    expect(result.measurements.graph_nodes).toEqual({ sampledRows: 250000, cap: 250000, exact: false, capReached: true });
  });

  it.each(Object.entries(HYDRATION_REQUIREMENTS))("rejects %s one row below its unchanged minimum", (table, minimum) => {
    const body = boundedBody();
    body.postgres.tablePopulation[table] = { sampledRows: minimum - 1, cap: minimum, exact: true, capReached: false };
    expect(exactHydrationSummary(body).failures).toContain(`hydration table ${table} has ${minimum - 1}, expected at least ${minimum}`);
  });

  it("rejects one observed raw row, insufficient probe caps, and falsely exact capped measurements", () => {
    const raw = boundedBody();
    raw.postgres.tablePopulation.ngram_observations = { sampledRows: 1, cap: 1, exact: false, capReached: true };
    expect(exactHydrationSummary(raw).failures).toContain("hydration table ngram_observations has 1, expected 0");
    const small = boundedBody();
    small.postgres.tablePopulation.graph_nodes = { sampledRows: 1, cap: 1, exact: false, capReached: true };
    expect(exactHydrationSummary(small).ok).toBe(false);
    const falseExact = boundedBody();
    falseExact.postgres.tablePopulation.graph_nodes!.exact = true;
    expect(exactHydrationSummary(falseExact).ok).toBe(false);
  });
});
