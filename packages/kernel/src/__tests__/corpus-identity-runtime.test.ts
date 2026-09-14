// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCorpusIdentitySignals,
  concentrationThreshold,
  corpusIdentitySignals
} from "../corpus-identity.js";
import {
  primeCorpusIdentityForTurn,
  resetCorpusIdentityMeasurements
} from "../corpus-identity-runtime.js";
import type { EvidenceStore } from "../storage.js";

type IdentityEvidence = Pick<EvidenceStore, "sourceIdentityArbitration" | "sourceSpreadDistribution">;

beforeEach(() => {
  resetCorpusIdentityMeasurements();
  clearCorpusIdentitySignals();
});

afterEach(() => {
  resetCorpusIdentityMeasurements();
  clearCorpusIdentitySignals();
});

describe("corpus identity runtime measurements", () => {
  it("isolates request, spread, and threshold measurements by evidence store", async () => {
    const requestText = "alpha beta";
    const distributionA = [1, 1, 100, 100];
    const distributionB = [10, 10, 1_000, 1_000];
    let arbitrationCallsA = 0;
    let arbitrationCallsB = 0;
    let distributionCallsA = 0;
    let distributionCallsB = 0;
    const storeA: IdentityEvidence = {
      sourceIdentityArbitration: async () => {
        arbitrationCallsA += 1;
        return {
          identities: ["alpha"],
          spread: new Map([["alpha beta", 100], ["alpha", 1], ["beta", 100]])
        };
      },
      sourceSpreadDistribution: async () => {
        distributionCallsA += 1;
        return distributionA;
      }
    };
    const storeB: IdentityEvidence = {
      sourceIdentityArbitration: async () => {
        arbitrationCallsB += 1;
        return {
          identities: ["beta"],
          spread: new Map([["alpha beta", 1_000], ["alpha", 1_000], ["beta", 10]])
        };
      },
      sourceSpreadDistribution: async () => {
        distributionCallsB += 1;
        return distributionB;
      }
    };

    await primeCorpusIdentityForTurn({ requestText, closedClass: new Set(), evidence: storeA });
    await primeCorpusIdentityForTurn({ requestText, closedClass: new Set(), evidence: storeB });

    expect(arbitrationCallsA).toBe(1);
    expect(arbitrationCallsB).toBe(1);
    expect(distributionCallsA).toBe(1);
    expect(distributionCallsB).toBe(1);
    expect(corpusIdentitySignals()).toEqual({
      closedClass: new Set(),
      identities: new Set(["beta"]),
      spread: new Map([["alpha beta", 1_000], ["alpha", 1_000], ["beta", 10]]),
      concentration: concentrationThreshold(distributionB, 1_000)
    });

    await primeCorpusIdentityForTurn({ requestText, closedClass: new Set(), evidence: storeB });
    expect(arbitrationCallsB).toBe(1);
    expect(distributionCallsB).toBe(1);
  });

  it("retries a failed threshold measurement without remeasuring warm request arbitration", async () => {
    const distribution = [2, 2, 200, 200];
    let arbitrationCalls = 0;
    let distributionCalls = 0;
    const evidence: IdentityEvidence = {
      sourceIdentityArbitration: async () => {
        arbitrationCalls += 1;
        return { identities: ["alpha"], spread: new Map([["alpha", 2]]) };
      },
      sourceSpreadDistribution: async () => {
        distributionCalls += 1;
        if (distributionCalls === 1) throw new Error("transient distribution failure");
        return distribution;
      }
    };

    await primeCorpusIdentityForTurn({ requestText: "alpha", closedClass: new Set(), evidence });
    expect(corpusIdentitySignals()?.concentration).toBe(0);

    await primeCorpusIdentityForTurn({ requestText: "alpha", closedClass: new Set(), evidence });
    expect(distributionCalls).toBe(2);
    expect(arbitrationCalls).toBe(1);
    expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold(distribution, 200));
  });

  it("keeps an omitted spread unknown while remembering that arbitration answered the run", async () => {
    let arbitrationCalls = 0;
    const traces: Array<{ measured: number }> = [];
    const evidence: IdentityEvidence = {
      sourceIdentityArbitration: async () => {
        arbitrationCalls += 1;
        return { identities: ["named source"], spread: new Map() };
      }
    };

    await primeCorpusIdentityForTurn({
      requestText: "named source",
      closedClass: new Set(),
      evidence,
      onTrace: record => traces.push(record)
    });
    await primeCorpusIdentityForTurn({
      requestText: "named source",
      closedClass: new Set(),
      evidence,
      onTrace: record => traces.push(record)
    });

    expect(arbitrationCalls).toBe(1);
    expect(corpusIdentitySignals()?.spread.has("named source")).toBe(false);
    expect(traces.map(trace => trace.measured)).toEqual([3, 0]);
  });

  it("fences pending measurement work when the cache is reset", async () => {
    let releaseDistribution = (_distribution: number[]) => {};
    const pendingDistribution = new Promise<number[]>(resolve => { releaseDistribution = resolve; });
    let arbitrationCalls = 0;
    let distributionCalls = 0;
    const evidence: IdentityEvidence = {
      sourceIdentityArbitration: async () => {
        arbitrationCalls += 1;
        return { identities: ["alpha"], spread: new Map([["alpha", 1]]) };
      },
      sourceSpreadDistribution: async () => {
        distributionCalls += 1;
        if (distributionCalls === 1) return pendingDistribution;
        return [3, 3, 300, 300];
      }
    };

    const stalePrime = primeCorpusIdentityForTurn({ requestText: "alpha", closedClass: new Set(), evidence });
    resetCorpusIdentityMeasurements();
    releaseDistribution([1, 1, 100, 100]);
    await stalePrime;

    expect(corpusIdentitySignals()).toBeUndefined();
    expect(arbitrationCalls).toBe(0);

    await primeCorpusIdentityForTurn({ requestText: "alpha", closedClass: new Set(), evidence });
    expect(distributionCalls).toBe(2);
    expect(arbitrationCalls).toBe(1);
    expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold([3, 3, 300, 300], 300));
  });
});
