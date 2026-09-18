// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileCrossLingualTranslationSeeds, type CrossLingualTranslationStorage } from "../cross-lingual-translation.js";

// Brick 2b wiring: read per-language bigrams and closed class, align by structure, store seeds. Validated with
// a fake storage so the plumbing is proven without a live multilingual brain (real validation comes when
// Arabic/Russian are co-trained after English). Two toy languages share nothing at the surface; only a hidden
// structural relabeling connects them.

const N = 8;
function fixedWeights(): number[][] {
  let seed = 1234567;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 1000) / 1000; };
  const w = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) w[i]![j] = 0.05 + next();
  return w;
}
const mass = (w: number[][], i: number) => w[i]!.reduce((a, b) => a + b, 0);

function bigramRows(w: number[][], relabel: (i: number) => number) {
  const rows: Array<{ previous: string; next: string; total: string }> = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) {
    rows.push({ previous: `x${relabel(i)}`, next: `x${relabel(j)}`, total: String(Math.round(w[i]![j]! * 100)) });
  }
  return rows;
}
const closedClass = (w: number[][], relabel: (i: number) => number) =>
  [...Array(N).keys()].sort((a, b) => mass(w, b) - mass(w, a)).map((i, rank) => ({ word: `x${relabel(i)}`, documentShare: 1 - rank * 0.05 }));

function fakeStorage(w: number[][], permutation: number[]) {
  const stored: Array<{ sourceLanguage: string; targetLanguage: string; seeds: unknown[] }> = [];
  const storage: CrossLingualTranslationStorage = {
    table: name => name,
    async query<T>(_sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const language = params[0];
      const rows = language === "source" ? bigramRows(w, i => i) : bigramRows(w, i => 100 + permutation[i]!);
      return rows as unknown as T[];
    },
    languageIdentities: {
      async listIdentities() {
        return [
          { script: "script:Src", closedClass: closedClass(w, i => i), families: [] },
          { script: "script:Tgt", closedClass: closedClass(w, i => 100 + permutation[i]!), families: [] }
        ];
      }
    },
    translationSeeds: {
      async putSeeds(input) { stored.push({ sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seeds: [...input.seeds] }); }
    }
  };
  return { storage, stored };
}

describe("compiling cross-lingual translation seeds from ingested statistics", () => {
  it("aligns two languages and stores seeds, using only bigrams and closed class", async () => {
    const w = fixedWeights();
    const permutation = [3, 5, 0, 7, 1, 6, 2, 4];
    const { storage, stored } = fakeStorage(w, permutation);

    const result = await compileCrossLingualTranslationSeeds(storage, {
      sourceLanguage: "source", targetLanguage: "target",
      sourceScript: "script:Src", targetScript: "script:Tgt",
      observedAt: 1_700_000_000_000
    });

    expect(result.aligned).toBe(N);
    expect(result.seedCount).toBeGreaterThan(0);
    expect(stored).toHaveLength(1);
    // Most seeds are the correct structural correspondence: source x_i -> target x_{100+perm[i]}.
    const seeds = stored[0]!.seeds as Array<{ sourceSymbol: string; targetSymbol: string; basis: string }>;
    let correct = 0;
    for (const seed of seeds) {
      const i = Number(seed.sourceSymbol.slice(1));
      if (seed.targetSymbol === `x${100 + permutation[i]!}`) correct += 1;
      expect(seed.basis).toBe("shared_context");
    }
    expect(correct).toBeGreaterThanOrEqual(6);
  });

  it("is a no-op, not a failure, when a language has no structure yet", async () => {
    const storage: CrossLingualTranslationStorage = {
      table: name => name,
      async query<T>(): Promise<T[]> { return [] as T[]; },
      languageIdentities: { async listIdentities() { return []; } },
      translationSeeds: { async putSeeds() { throw new Error("must not store when there is nothing to align"); } }
    };
    const result = await compileCrossLingualTranslationSeeds(storage, {
      sourceLanguage: "source", targetLanguage: "target", sourceScript: "a", targetScript: "b", observedAt: 0
    });
    expect(result.seedCount).toBe(0);
    expect(result.skippedReason).toBeTruthy();
  });
});
