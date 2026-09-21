// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createWikipediaV3Ingestor, wikipediaImportCanActivate } from "../wikipedia-v3-ingestor.js";

describe("Wikipedia brain lifecycle activation gate", () => {
  it("allows only a nonempty batch that was not stopped by owner or heap safety", () => {
    expect(wikipediaImportCanActivate({ sources: 1, stoppedByHeapSafetyBound: false, stoppedByOwner: false })).toBe(true);
    expect(wikipediaImportCanActivate({ sources: 0, stoppedByHeapSafetyBound: false, stoppedByOwner: false })).toBe(false);
    expect(wikipediaImportCanActivate({ sources: 12, stoppedByHeapSafetyBound: true, stoppedByOwner: false })).toBe(false);
    expect(wikipediaImportCanActivate({ sources: 12, stoppedByHeapSafetyBound: false, stoppedByOwner: true })).toBe(false);
  });

  it.each([
    { fullTrainingComplete: false, activeBrainVersion: "existing-qualified-brain" },
    { fullTrainingComplete: true, activeBrainVersion: "existing-qualified-brain" },
    { fullTrainingComplete: true, activeBrainVersion: undefined }
  ])("keeps a candidate in VALIDATING until publication qualification: %j", async ({ fullTrainingComplete, activeBrainVersion }) => {
    let lifecycle: any;
    const activateReady = vi.fn(async () => {});
    const brainImports = {
      getLifecycle: async () => lifecycle,
      putLifecycle: async (record: any) => { lifecycle = record; },
      transitionLifecycle: async (input: any) => {
        expect(lifecycle.state).toBe(input.expectedState);
        lifecycle = { ...lifecycle, state: input.toState, validation: input.validation };
        return lifecycle;
      },
      putLedger: async () => {},
      active: async () => ({ activeBrainVersion }),
      activateReady
    };
    const ingestor = createWikipediaV3Ingestor({ storage: { brainImports } as any, config: { runtime: {} } as any });
    const result = { pages: 2, sources: 2, evidence: 2, graphNodes: 2, graphEdges: 1, languageProfiles: 1,
      languageUnits: 1, languagePatterns: 1, ngramModels: 1, ngramObservations: 2, semanticFrames: 1,
      resumedFromOffset: 0, lastCheckpointOffset: 42, stoppedByHeapSafetyBound: false, stoppedByOwner: false, warnings: [] };
    const input = { result, rootUri: "wikipedia://fixture", corpus: { dumpPath: "fixture.xml.bz2", indexPath: "fixture.index" },
      importedAt: 1700000000000, fullTrainingComplete };
    await (ingestor as any).registerActiveWikipediaImport(input);
    expect(lifecycle.state).toBe("VALIDATING");
    expect(activateReady).not.toHaveBeenCalled();
    // A legacy READY marker also cannot substitute for the required qualification records.
    lifecycle.state = "READY";
    await (ingestor as any).registerActiveWikipediaImport(input);
    expect(activateReady).not.toHaveBeenCalled();
    expect(result.warnings.join(" ")).toContain("awaits artifact, replay, learned-speech, calibration and runtime qualification");
    if (activeBrainVersion) expect(result.warnings.join(" ")).toContain("existing-qualified-brain stays active");
  });
});
