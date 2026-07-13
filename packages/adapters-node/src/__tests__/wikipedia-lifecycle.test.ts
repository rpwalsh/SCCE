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
