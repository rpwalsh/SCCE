import { describe, expect, it } from "vitest";

import {
  CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA,
  compileCreativeEventCompatibilityCorpus,
  createLanguageMemoryRuntime,
  parseCreativeEventCompatibilityCorpus
} from "../index.js";

describe("persisted creative-event compatibility", () => {
  it("compiles held-out outcomes into a hydrated calibrated model", () => {
    const corpus = parseCreativeEventCompatibilityCorpus(JSON.stringify({
      schema: CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA,
      calibrationId: "calibration.fixture.compatibility.v1",
      minimumAdmissiblePosterior: 0.5,
      minimumRolePosterior: 0.5,
      minimumTrainingSupport: 1,
      minimumCalibrationSupport: 2,
      examples: [
        example("train", true),
        example("calibration", true),
        example("calibration", false)
      ]
    }));
    expect(corpus).toBeDefined();
    const compiled = compileCreativeEventCompatibilityCorpus({
      corpus: corpus!,
      profileId: "profile.fixture.compatibility",
      evidenceIds: [],
      updatedAt: 17,
      makeId: value => `id:${JSON.stringify(value).length}`
    });
    expect(compiled.patterns).toHaveLength(1);

    const state = createLanguageMemoryRuntime().hydrate({
      models: [],
      patterns: compiled.patterns
    });
    expect(state.creativeEventCompatibilityModels).toHaveLength(1);
    expect(state.creativeEventCompatibilityModels[0]).toMatchObject({
      calibrationId: "calibration.fixture.compatibility.v1",
      reliability: "calibrated",
      requestCompilerId: "compiler.request.fixture",
      eventCompilerId: "compiler.event.fixture",
      eventCompatibilities: [{
        requestFrameId: "frame.fixture",
        eventRelationId: "relation.fixture",
        posterior: 0.5,
        support: 3
      }],
      roleCompatibilities: [{
        requestFrameId: "frame.fixture",
        requestRoleId: "frame.fixture:role:argument:0",
        eventRoleId: "scce.role.patient",
        posterior: 0.5,
        support: 3
      }]
    });
    expect(state.importedPatterns).toEqual([]);
  });
});

function example(partition: "train" | "calibration", accepted: boolean) {
  return {
    requestText: "opaque request surface",
    requestFrameId: "frame.fixture",
    requestCompilerId: "compiler.request.fixture",
    eventCompilerId: "compiler.event.fixture",
    eventRelationId: "relation.fixture",
    partition,
    accepted,
    roleBindings: [{
      requestRoleId: "frame.fixture:role:argument:0",
      eventRoleId: "scce.role.patient",
      accepted
    }]
  };
}
