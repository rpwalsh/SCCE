// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExactTransactionWriteCache } from "../exact-transaction-write-cache.js";

describe("exact transaction write cache", () => {
  it("reuses only record instances whose physical write completed", () => {
    const cache = new ExactTransactionWriteCache<{ id: string; value: { n: number } }>();
    const first = { id: "pattern.first", value: { n: 1 } };
    const second = { id: "pattern.second", value: { n: 2 } };
    const completedPhysicalHashes = new Map<string, string>();
    let physicalEncodes = 0;
    const persist = (records: readonly (typeof first)[]) => {
      const pending = cache.pending(records);
      for (const record of pending) {
        completedPhysicalHashes.set(record.id, createHash("sha256").update(JSON.stringify(record)).digest("hex"));
        physicalEncodes++;
      }
      cache.commit(pending);
    };

    expect(cache.pending([first, second])).toEqual([first, second]);
    // Planning alone is not a write: failed/rolled-back work must remain pending.
    expect(cache.pending([first, second])).toEqual([first, second]);

    persist([first, second]);
    expect(cache.pending([first, second])).toEqual([]);
    const secondHash = completedPhysicalHashes.get(second.id);
    persist([second]);
    expect(physicalEncodes).toBe(2);
    expect(completedPhysicalHashes.get(second.id)).toBe(secondHash);
    // Equal JSON is not enough. A clone can carry distinct symbol/non-enumerable
    // codec state and therefore must still be encoded and written.
    const equalClone = { id: first.id, value: { n: first.value.n } };
    expect(cache.pending([equalClone])).toEqual([equalClone]);
    expect(new ExactTransactionWriteCache<typeof first>().pending([first])).toEqual([first]);
  });
});
