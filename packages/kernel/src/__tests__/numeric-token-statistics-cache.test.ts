// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearFreeFormLexicon, primeFreeFormLexicon } from "../free-form-lexicon.js";
import { trainKneserNey } from "../kneser-ney.js";
import { clearNumericTokenStatisticsCache, deriveNumericTokenStatistics, numericTokenDerivationCount, residentNumericTokenStatistics } from "../numeric-token-statistics.js";

const probes = ["metres", "tonnes", "survey", "in", "the", "north", "hectares", ",", "."];

function decisions(statistics: ReturnType<typeof residentNumericTokenStatistics>): string[] {
  return probes.map(symbol => `${symbol}:${statistics.unit(symbol)}:${statistics.separator(symbol)}`);
}

function corpus(seed: number, unit: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`The survey measured ${(i * 37 + seed) % 900 + 12} ${unit} across the valley in the north.`);
    lines.push(`Records list 1,${String(100 + i * 7 + seed)}.${i % 9} ${unit} for the river.`);
  }
  return lines.join(" ");
}

afterEach(() => {
  clearFreeFormLexicon();
  clearNumericTokenStatisticsCache();
});

describe("numeric token statistics are summed from per-model counts", () => {
  it("derives each model once across set changes and decides as a from-scratch pass would", () => {
    clearNumericTokenStatisticsCache();
    const a1 = trainKneserNey(corpus(1, "metres"), { order: 3 });
    const a2 = trainKneserNey(corpus(2, "tonnes"), { order: 3 });
    const m = trainKneserNey(corpus(3, "hectares"), { order: 3 });

    primeFreeFormLexicon([a1, a2]);
    const first = decisions(residentNumericTokenStatistics());
    expect(numericTokenDerivationCount()).toBe(2);

    primeFreeFormLexicon([a1, a2, m]);
    const widened = decisions(residentNumericTokenStatistics());
    expect(numericTokenDerivationCount()).toBe(3);

    primeFreeFormLexicon([a1, a2]);
    const again = decisions(residentNumericTokenStatistics());
    expect(numericTokenDerivationCount()).toBe(3);

    expect(first).toEqual(decisions(deriveNumericTokenStatistics([a1, a2])));
    expect(widened).toEqual(decisions(deriveNumericTokenStatistics([a1, a2, m])));
    expect(again).toEqual(first);
  });
});
