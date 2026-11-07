// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CODE_REQUEST_BOOTSTRAP_DEMAND_MODEL, codeLanguageForRequirementState, codeRequestCorroborated, codeRequestDemand, codeRequestObservedRequirements, codeRequestRecognized, codeRequestRequirements, codeRequestSignal, typedProgramBehaviorFromMetadata } from "../code-request.js";
import { clearProdCalibrations, installProdCalibrations } from "../calibrations/prod-calibrations.js";
import { operationalAuthorityForProjection, projectRequestAuthority } from "../request-authority.js";
import { COGNITIVE_OPERATOR_IDS, DEFAULT_COGNITIVE_OPERATOR_MODEL, activateCognitiveOperators, deriveTurnRequirementField } from "../turn-requirements.js";

const recognized = (text: string) => codeRequestRecognized(codeRequestSignal(text));

describe("code request structure", () => {
  it("recognizes a named language corroborated by code shape", () => {
    const signal = codeRequestSignal("Write a TypeScript function named longestCommonPrefix that takes an array of strings.");
    expect(codeRequestRecognized(signal)).toBe(true);
    expect(signal.language).toBe("typescript");
    expect(signal.observations.map(observation => observation.kind)).toEqual([
      "formal_language", "identifier_shape"
    ]);
    expect(signal.observations.every(observation => observation.detectorId.startsWith("code.detector."))).toBe(true);
  });

  it("recognizes a request that names a code path, and takes the language from the extension", () => {
    const signal = codeRequestSignal("Fix the off-by-one in packages/kernel/src/mouth.ts please");
    expect(codeRequestRecognized(signal)).toBe(true);
    expect(signal.language).toBe("typescript");
    expect(signal.paths).toEqual(["packages/kernel/src/mouth.ts"]);
  });

  it("recognizes a fenced block in a named language", () => {
    expect(recognized("Why does this python fail?\n```\nprint(1)\n```")).toBe(true);
  });

  it("leaves ordinary prose alone even when it contains a short language alias", () => {
    expect(recognized("Where did the crew go after the war with the Klingons?")).toBe(false);
    expect(recognized("Season one, two, and three were released on April 28, September 22, and December 15, respectively.")).toBe(false);
    expect(recognized("Explain what Ada Lovelace did with the Analytical Engine.")).toBe(false);
    expect(recognized("In plain words, what is a Postgres GIN index good for?")).toBe(false);
  });

  it("tilts on a bare language name without corroborating shape, and leaves the projection to decide", () => {
    const bare = codeRequestSignal("Who created Rust?");
    expect(codeRequestRecognized(bare)).toBe(true);
    expect(codeRequestCorroborated(bare)).toBe(false);
    expect(codeRequestRequirements("Who created Rust?", bare)[0]!.value).toBeLessThan(0.6);
    const artifact = codeRequestSignal("Write a TypeScript function named chunk() that splits an array.");
    expect(codeRequestCorroborated(artifact)).toBe(true);
    expect(codeRequestRequirements("x", artifact)[0]!.value).toBeGreaterThan(0.9);
  });

  it("emits explicit executable-artifact requirements only for recognized requests", () => {
    const request = "Write a TypeScript function named chunk() that splits an array.";
    const requirements = codeRequestRequirements(request, codeRequestSignal(request));
    expect(requirements.map(row => row.dimension)).toEqual(["executableArtifactDemand", "formatConstraintStrength", "externalTruthAuthority"]);
    expect(requirements[0]!.value).toBeGreaterThan(0.6);
    expect(requirements.every(row => row.status === "explicit" && row.polarity === "required")).toBe(true);
    expect(codeRequestRequirements("Who created Star Trek?", codeRequestSignal("Who created Star Trek?"))).toEqual([]);
  });

  it("keeps structural corroboration typed and independent of relation vocabulary", () => {
    const signal = codeRequestSignal("Crea una función doble(x) => 2x en TypeScript.");
    expect(signal.observations.map(observation => observation.kind)).toEqual([
      "formal_language", "call_shape", "code_punctuation"
    ]);
    expect(codeRequestCorroborated(signal)).toBe(true);
    expect(signal.observations.some(observation => observation.kind === "formal_language")).toBe(true);
  });

  it("calibrates typed code structure outside the detector path", () => {
    const signal = codeRequestSignal("Crea una funci\u00f3n doble(x) => 2x en TypeScript.");
    const model = { ...CODE_REQUEST_BOOTSTRAP_DEMAND_MODEL, formal_language: 0.05, call_shape: 0.05, code_punctuation: 0.05 };
    expect(codeRequestDemand(signal.observations, model)).toBeCloseTo(0.15, 8);
    expect(codeRequestSignal("Crea una funci\u00f3n doble(x) => 2x en TypeScript.", { demandModel: model }).demand).toBeCloseTo(0.15, 8);
  });

  it("uses an installed calibration for the implicit demand model", () => {
    const request = "Create double(x) => 2x.";
    const baseline = codeRequestSignal(request).demand;
    installProdCalibrations({
      "code_request.demand.call_shape": 0.01,
      "code_request.demand.code_punctuation": 0.01,
      "code_request.demand.owner_behavior_example": 0.01
    });
    try {
      expect(codeRequestSignal(request).demand).toBeLessThan(baseline);
    } finally {
      clearProdCalibrations();
    }
  });

  it("routes structural observations through requirements and operators before selecting a code language", () => {
    const factualSignal = codeRequestSignal("Who created Rust?");
    const factualField = deriveTurnRequirementField({ requestText: "Who created Rust?", explicitRequirements: codeRequestObservedRequirements("Who created Rust?", factualSignal) });
    const factualOperators = activateCognitiveOperators({ requirementField: factualField });
    expect(factualField.executableArtifactDemand).toBeLessThan(0.5);
    expect(codeLanguageForRequirementState({ signal: factualSignal, requirementField: factualField, operators: factualOperators })).toBeUndefined();

    const programRequest = "Write a TypeScript function named chunk() that splits an array.";
    const programSignal = codeRequestSignal(programRequest);
    const programField = deriveTurnRequirementField({ requestText: programRequest, explicitRequirements: codeRequestObservedRequirements(programRequest, programSignal) });
    const programOperators = activateCognitiveOperators({ requirementField: programField });
    expect(programField.executableArtifactDemand).toBeGreaterThan(0.8);
    expect(programOperators.some(operator => operator.operatorId === COGNITIVE_OPERATOR_IDS.programPlanning && operator.active)).toBe(true);
    expect(codeLanguageForRequirementState({ signal: programSignal, requirementField: programField, operators: programOperators })).toBe("typescript");
  });

  it("does not turn a factual language mention into code evidence, while path structure does", () => {
    const factualSignal = codeRequestSignal("What is Rust used for?");
    expect(codeRequestObservedRequirements("What is Rust used for?", factualSignal)).toEqual([]);

    const pathRequest = "Inspect packages/kernel/src/mouth.ts for the selected candidate route.";
    const pathSignal = codeRequestSignal(pathRequest);
    const pathRequirements = codeRequestObservedRequirements(pathRequest, pathSignal);
    expect(pathSignal.paths).toEqual(["packages/kernel/src/mouth.ts"]);
    expect(pathRequirements.some(requirement => requirement.dimension === "executableArtifactDemand")).toBe(true);
  });

  it("projects an explicit call/result example without reading relation prose", () => {
    const request = "Create a function double(x) such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22.";
    const signal = codeRequestSignal(request);
    expect(codeRequestRecognized(signal)).toBe(true);
    expect(signal.behaviorRequirements[0]).toMatchObject({
      callableId: "double",
      arguments: [3],
      expectedResult: 6,
      verificationRole: "fit",
      relationSurface: "returns",
      requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
    });
    expect(signal.behaviorRequirements.map(requirement => requirement.verificationRole)).toEqual(["fit", "fit", "fit", "held_out"]);
    expect(codeRequestSignal("Explain double(3) in prose.").behaviorRequirements).toEqual([]);
    expect(codeRequestSignal("Compare double(3) against 6.").behaviorRequirements).toEqual([]);
    expect(codeRequestSignal("double(3) returns 6.").behaviorRequirements).toEqual([]);
  });

  it("recognizes typed declaration parameters as the owner of call/result examples", () => {
    const request = "Create a function double(x: number): number such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a test proving it.";
    const signal = codeRequestSignal(request);
    const field = deriveTurnRequirementField({
      requestText: request,
      explicitRequirements: codeRequestObservedRequirements(request, signal)
    });

    expect(signal.behaviorRequirements).toHaveLength(4);
    expect(signal.behaviorRequirements.map(requirement => requirement.callableId)).toEqual(["double", "double", "double", "double"]);
    expect(projectRequestAuthority({
      requirementField: field,
      typedProgramBehaviorRequirementIds: signal.behaviorRequirements.map(requirement => requirement.id)
    }).requestedAuthority).toBe("program");
  });

  it("routes owner call/result contracts to program authority without a language-name or learned-score cue", () => {
    const request = "Create a function double(x) such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a test proving it.";
    const signal = codeRequestSignal(request);
    expect(signal.language).toBeUndefined();
    expect(signal.behaviorRequirements).toHaveLength(4);
    const field = deriveTurnRequirementField({
      requestText: request,
      explicitRequirements: codeRequestObservedRequirements(request, signal)
    });
    const projection = projectRequestAuthority({
      requirementField: field,
      typedProgramBehaviorRequirementIds: signal.behaviorRequirements.map(requirement => requirement.id)
    });
    const operators = activateCognitiveOperators({ requirementField: field });

    expect(projection.requestedAuthority).toBe("program");
    expect(projection.explicitOverride).toBe(false);
    expect(projection.trace).toMatchObject({
      selectionSource: "typed_owner_behavior_contract",
      typedProgramBehaviorRequirementIds: signal.behaviorRequirements.map(requirement => requirement.id)
    });
    expect(operationalAuthorityForProjection({
      projection,
      activeOperatorIds: operators.filter(operator => operator.active).map(operator => operator.operatorId)
    })).toBe("program");
    expect(projectRequestAuthority({ requirementField: field, explicitAuthority: "factual", typedProgramBehaviorRequirementIds: signal.behaviorRequirements.map(requirement => requirement.id) }).requestedAuthority).toBe("factual");
  });

  it("activates program planning from typed owner obligations despite a competing factual language control", () => {
    const request = "Create a function double(x) such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a test proving it.";
    const signal = codeRequestSignal(request);
    const typedIds = signal.behaviorRequirements.map(requirement => requirement.id);
    const requirementField = deriveTurnRequirementField({
      requestText: request,
      explicitRequirements: codeRequestObservedRequirements(request, signal),
      activations: [{
        id: "pattern.learned.factual-source-control",
        kind: "frame",
        activation: 1,
        requirementCoefficients: { externalTruthAuthority: 3, sourceDependence: 3 },
        semanticRoleId: "role.learned.factual-source-control",
        learnedFrameOrPatternId: "frame.learned.factual-source-control"
      }]
    });
    const model = {
      ...DEFAULT_COGNITIVE_OPERATOR_MODEL,
      id: "fixture.factual-language-control",
      intercepts: { ...DEFAULT_COGNITIVE_OPERATOR_MODEL.intercepts, [COGNITIVE_OPERATOR_IDS.programPlanning]: -4 },
      requirementWeights: { ...DEFAULT_COGNITIVE_OPERATOR_MODEL.requirementWeights, [COGNITIVE_OPERATOR_IDS.programPlanning]: {} }
    };
    const learnedOnly = activateCognitiveOperators({ model, requirementField });
    const typedActivation = activateCognitiveOperators({ model, requirementField, typedProgramBehaviorRequirementIds: typedIds });
    const typedProjection = projectRequestAuthority({ requirementField, typedProgramBehaviorRequirementIds: typedIds });
    const factualProjection = projectRequestAuthority({ requirementField, explicitAuthority: "factual", typedProgramBehaviorRequirementIds: typedIds });

    expect(learnedOnly.some(operator => operator.operatorId === COGNITIVE_OPERATOR_IDS.programPlanning && operator.active)).toBe(false);
    expect(typedActivation.find(operator => operator.operatorId === COGNITIVE_OPERATOR_IDS.programPlanning)).toMatchObject({
      active: true,
      trace: expect.objectContaining({ typedProgramBehaviorRequirementIds: typedIds })
    });
    expect(operationalAuthorityForProjection({ projection: typedProjection, activeOperatorIds: typedActivation.filter(operator => operator.active).map(operator => operator.operatorId) })).toBe("program");
    expect(factualProjection.requestedAuthority).toBe("factual");
    const factualActivation = activateCognitiveOperators({ model, requirementField });
    expect(operationalAuthorityForProjection({ projection: factualProjection, activeOperatorIds: factualActivation.filter(operator => operator.active).map(operator => operator.operatorId) })).toBe("factual");
  });

  it("leaves ordinary arithmetic requests outside the owner behavior program lane", () => {
    const request = "What is 17 + 25?";
    const signal = codeRequestSignal(request);
    const field = deriveTurnRequirementField({
      requestText: request,
      explicitRequirements: codeRequestObservedRequirements(request, signal)
    });

    expect(signal.behaviorRequirements).toEqual([]);
    expect(projectRequestAuthority({ requirementField: field, typedProgramBehaviorRequirementIds: signal.behaviorRequirements.map(requirement => requirement.id) }).requestedAuthority).toBe("factual");
  });

  it("keeps an opaque Unicode source relation and held-out split without an English template", () => {
    const request = "κ(x); κ(1) ↦ 2, κ(2)↦-4, κ(3) ↦ 6, κ(11) ↦ 22";
    const signal = codeRequestSignal(request);
    expect(signal.behaviorRequirements.map(requirement => requirement.relationSurface)).toEqual(["↦", "↦", "↦", "↦"]);
    expect(signal.behaviorRequirements[1]?.expectedResult).toBe(-4);
    expect(signal.behaviorRequirements.map(requirement => requirement.verificationRole)).toEqual(["fit", "fit", "fit", "held_out"]);
    expect(signal.behaviorRequirements.map(requirement => requirement.callableId)).toEqual(["κ", "κ", "κ", "κ"]);
  });

  it("derives typed owner requirement provenance from the canonical contract", () => {
    const metadata = (id: string, requestHash: string, charStart: number) => ({
      programBehavior: {
        schema: "scce.program.owner_behavior.v1",
        behaviorRequirements: [{
          id,
          requestHash,
          callableId: "fn_7",
          arguments: [3],
          expectedResult: 9,
          verificationRole: "fit",
          relationSurface: "::",
          sourceSpan: { charStart, charEnd: charStart + 1 }
        }]
      }
    });
    const first = typedProgramBehaviorFromMetadata(metadata("forged-a", "sha256:fake-a", 900));
    const second = typedProgramBehaviorFromMetadata(metadata("forged-b", "sha256:fake-b", 2));

    expect(first).toEqual(second);
    expect(first.behaviorRequirements[0]).toMatchObject({
      id: expect.stringMatching(/^owner\.program\.requirement\.[0-9a-f]{40}$/u),
      requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      sourceSpan: {
        charStart: expect.any(Number),
        charEnd: expect.any(Number)
      }
    });
    expect(first.behaviorRequirements[0]!.requestHash).not.toBe("sha256:fake-a");
    expect(first.behaviorRequirements[0]!.sourceSpan.charEnd).toBeGreaterThan(first.behaviorRequirements[0]!.sourceSpan.charStart);
  });
});
