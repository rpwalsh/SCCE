// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { SourceLearningApplication, type LearnSourceResult } from "../source-learning-application.js";

describe("source learning application", () => {
  it("coalesces identical operation retries and rejects a conflicting payload", async () => {
    const result = { source: {} as LearnSourceResult["source"], evidenceId: "evidence", languageProfileId: "profile" };
    const learnSource = vi.fn(async () => result);
    const application = new SourceLearningApplication({ learnSource });
    const input = { operationId: "source-operation-123", namespace: "owner", canonicalUri: "urn:test:source", mediaType: "text/plain",
      sourceBytes: new TextEncoder().encode("Exact source."), observedAt: 1 };
    expect(await Promise.all([application.learn(input), application.learn(input)])).toEqual([result, result]);
    expect(learnSource).toHaveBeenCalledTimes(1);
    expect(() => application.learn({ ...input, sourceBytes: new TextEncoder().encode("Different source.") })).toThrow(/different input/u);
  });
});
