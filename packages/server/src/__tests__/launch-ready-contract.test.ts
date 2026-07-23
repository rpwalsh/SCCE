import { describe, expect, it } from "vitest";
import { exactHydrationSummary, HYDRATION_REQUIREMENTS } from "../../../../tools/launch-ready-contract.mjs";

describe("launch-ready exact hydration contract", () => {
  it("accepts completed warmup with exact counts at every minimum", () => {
    const result = exactHydrationSummary({
      warmup: { phase: "ready", ok: true, complete: true },
      postgres: {
        countSemantics: "postgres_exact_table_counts",
        tableCounts: { ...HYDRATION_REQUIREMENTS }
      }
    });

    expect(result).toMatchObject({ ok: true, countSemantics: "postgres_exact_table_counts", failures: [] });
  });

  it("rejects planner estimates even when they exceed every minimum", () => {
    const overMinimum = Object.fromEntries(
      Object.entries(HYDRATION_REQUIREMENTS).map(([table, minimum]) => [table, minimum * 10])
    );
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
        tableCounts: { ...HYDRATION_REQUIREMENTS }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("runtime warmup is not complete (phase=running)");
  });
});
