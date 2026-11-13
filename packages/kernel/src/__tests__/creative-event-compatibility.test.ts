// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import {
  CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA,
  compileCreativeEventCompatibilityCorpus,
  createLanguageMemoryRuntime,
  parseCreativeEventCompatibilityCorpus,
  compileCreativeRequestFrameFromCompatibilityModels,
  createHasher
} from "../index.js";

describe("persisted creative-event compatibility", () => {
  it("converts persisted code-point request roles before interpreting supplementary characters", () => {
    const requestText = "λ «𝒜» ω «한국어»";
    const row = (partition: "train" | "calibration") => ({ ...example(partition, true), requestText,
      roleBindings: [
        { requestRoleId: "role.first", eventRoleId: "scce.role.patient", accepted: true, requestSpan: { charStart: 3, charEnd: 4 } },
        { requestRoleId: "role.second", eventRoleId: "scce.role.complement", accepted: true, requestSpan: { charStart: 9, charEnd: 12 } }
      ] });
    const corpus = parseCreativeEventCompatibilityCorpus(JSON.stringify({ schema: CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA,
      calibrationId: "fixture.supplementary", minimumAdmissiblePosterior: 1, minimumRolePosterior: 1,
      minimumTrainingSupport: 1, minimumCalibrationSupport: 1, examples: [row("train"), row("calibration")] }))!;
    const hasher = createHasher();
    const compiled = compileCreativeEventCompatibilityCorpus({ corpus, profileId: "profile.supplementary",
      evidenceIds: ["evidence.supplementary" as never], updatedAt: 1, makeId: value => hasher.digestHex(JSON.stringify(value)) });
    const state = createLanguageMemoryRuntime().hydrate({ models: [], patterns: JSON.parse(JSON.stringify(compiled.patterns)) });
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: "λ «𐐀𐐁» ω «ગુજરાતી»", models: state.creativeEventCompatibilityModels, hasher });
    expect(frame?.arguments.map(role => ({ role: role.roleId, text: role.span.text, start: role.span.charStart, end: role.span.charEnd }))).toEqual([
      { role: "role.first", text: "𐐀𐐁", start: 3, end: 5 },
      { role: "role.second", text: "ગુજરાતી", start: 10, end: 17 }
    ]);
  });
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
