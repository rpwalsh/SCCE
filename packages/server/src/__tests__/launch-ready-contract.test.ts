// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { exactHydrationSummary, HYDRATION_REQUIREMENTS } from "../../../../tools/launch-ready-contract.mjs";

describe("launch-ready exact hydration contract", () => {
  it("accepts completed warmup with exact counts at every minimum", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "ready", ok: true, complete: true },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
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
    expect(result.failures).toContain("readiness counts are not exact (semantics=postgres_planner_estimate)");
  });

  it("rejects exact counts while warmup is still running", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "running", ok: false, complete: false },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
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
        tableCounts: { ...HYDRATION_REQUIREMENTS, ngram_models: 0, ngram_observations: 7 }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("hydration table ngram_models has 0, expected at least 1");
    expect(result.failures).toContain("hydration table ngram_observations has 7, expected 0");
  });
});
