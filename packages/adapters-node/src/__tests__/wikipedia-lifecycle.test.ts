// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { wikipediaImportCanActivate } from "../wikipedia-v3-ingestor.js";

describe("Wikipedia brain lifecycle activation gate", () => {
  it("allows only a nonempty batch that was not stopped by owner or heap safety", () => {
    expect(wikipediaImportCanActivate({ sources: 1, stoppedByHeapSafetyBound: false, stoppedByOwner: false })).toBe(true);
    expect(wikipediaImportCanActivate({ sources: 0, stoppedByHeapSafetyBound: false, stoppedByOwner: false })).toBe(false);
    expect(wikipediaImportCanActivate({ sources: 12, stoppedByHeapSafetyBound: true, stoppedByOwner: false })).toBe(false);
    expect(wikipediaImportCanActivate({ sources: 12, stoppedByHeapSafetyBound: false, stoppedByOwner: true })).toBe(false);
  });
});
