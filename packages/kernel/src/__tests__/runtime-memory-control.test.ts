import { describe, expect, it, vi } from "vitest";
import { createClock } from "../primitives.js";
import { createRuntimeMemoryControl } from "../runtime-memory-control.js";

describe("runtime memory control", () => {
  it("shares a concurrent brain summary and does not let an invalidated read repopulate the resident cache", async () => {
    let releaseFirst!: (value: unknown) => void;
    let releaseSecond!: (value: unknown) => void;
    const firstSummary = new Promise(resolve => { releaseFirst = resolve; });
    const secondSummary = new Promise(resolve => { releaseSecond = resolve; });
    const summarize = vi.fn()
      .mockReturnValueOnce(firstSummary)
      .mockReturnValueOnce(secondSummary);
    const control = createRuntimeMemoryControl({
      deps: {
        storage: {
          brainImports: { summarize },
          corrections: { listRules: vi.fn(async () => []) },
          dialogueMemory: undefined
        }
      } as never,
      clock: createClock({ fixedTime: 1000, stepMs: 1 })
    });

    const first = control.activeBrainMarker();
    const joined = control.activeBrainMarker();
    expect(summarize).toHaveBeenCalledTimes(1);

    control.invalidate();
    const afterInvalidation = control.activeBrainMarker();
    expect(summarize).toHaveBeenCalledTimes(2);

    releaseFirst(summary("stale"));
    releaseSecond(summary("current"));
    await expect(first).resolves.toMatchObject({ activeBrainVersion: "stale" });
    await expect(joined).resolves.toMatchObject({ activeBrainVersion: "stale" });
    await expect(afterInvalidation).resolves.toMatchObject({ activeBrainVersion: "current" });

    await expect(control.activeBrainMarker()).resolves.toMatchObject({ activeBrainVersion: "current" });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent correction reads and reloads them after invalidation", async () => {
    const listRules = vi.fn()
      .mockResolvedValueOnce([{ id: "rule.old" }])
      .mockResolvedValueOnce([{ id: "rule.new" }]);
    const control = createRuntimeMemoryControl({
      deps: {
        storage: {
          brainImports: { summarize: vi.fn(async () => summary("brain")) },
          corrections: { listRules },
          dialogueMemory: undefined
        }
      } as never,
      clock: createClock({ fixedTime: 1000, stepMs: 1 })
    });

    await expect(Promise.all([control.correctionRulesCached(), control.correctionRulesCached()]))
      .resolves.toEqual([[{ id: "rule.old" }], [{ id: "rule.old" }]]);
    expect(listRules).toHaveBeenCalledTimes(1);

    control.invalidate();
    await expect(control.correctionRulesCached()).resolves.toEqual([{ id: "rule.new" }]);
    expect(listRules).toHaveBeenCalledTimes(2);
  });
});

function summary(activeBrainVersion: string) {
  return {
    activeBrainVersion,
    activeImportRunIds: [],
    importedLanguagePriorCount: 0,
    importedGraphPriorCount: 0,
    importedDirectEvidenceCount: 0,
    profileExcerptEvidenceCount: 0,
    importedLearnedPriorCount: 0,
    importedProgramPriorCount: 0,
    unknownPriorCount: 0,
    runs: []
  };
}
