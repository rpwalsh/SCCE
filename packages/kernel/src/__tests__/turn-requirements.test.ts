import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LanguageMemoryRuntimeState } from "../language-memory-runtime.js";
import {
  COGNITIVE_OPERATOR_IDS,
  DEFAULT_COGNITIVE_OPERATOR_MODEL,
  TURN_REQUIREMENT_DIMENSIONS,
  activateCognitiveOperators,
  deriveTurnRequirementField,
  type LearnedRequirementActivation
} from "../turn-requirements.js";

describe("learned turn requirement field", () => {
  it("maps paraphrases with the same learned structural activation to similar fields", () => {
    const structuralActivation: LearnedRequirementActivation = {
      id: "frame.fixture.request.73b1",
      kind: "frame",
      activation: 0.91,
      confidence: 0.86,
      semanticRoleId: "role.fixture.output.139a",
      learnedFrameOrPatternId: "frame.fixture.request.73b1",
      requirementCoefficients: {
        noveltyDemand: 1.7,
        inferentialDepth: 1.2,
        executableArtifactDemand: 1.5,
        formatConstraintStrength: 0.8
      }
    };
    const first = deriveTurnRequirementField({
      requestText: "Compose a fresh mechanism with a bounded interface.",
      activations: [structuralActivation]
    });
    const second = deriveTurnRequirementField({
      requestText: "A new bounded-interface mechanism is what I need.",
      activations: [structuralActivation]
    });

    for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
      expect(Math.abs(first[dimension] - second[dimension])).toBeLessThan(0.000001);
    }
    expect(first.activatedFrameIds).toEqual(["frame.fixture.request.73b1"]);
    expect(second.activatedFrameIds).toEqual(first.activatedFrameIds);
  });

  it("uses fixture-trained non-English language memory to activate compatible operators", () => {
    const fixtureSurface = "새 구조 산출물";
    const requestText = `경계 조건과 함께 ${fixtureSurface}`;
    const languageMemoryState = {
      models: [],
      records: [],
      streamIds: ["stream.fixture.ko"],
      languageHints: ["ko"],
      maxOrder: 0,
      observedSymbolCount: 40,
      vocabularySize: 12,
      importedUnits: [],
      importedPatterns: [],
      importedObservations: [],
      importedSemanticFrames: [{
        id: "frame.fixture.ko.4f19",
        frameJson: {
          surface: fixtureSurface,
          semanticRoleId: "role.fixture.artifact.a50e",
          requirementCoefficients: {
            noveltyDemand: 3.1,
            inferentialDepth: 2.4,
            executableArtifactDemand: 3.4,
            formatConstraintStrength: 1.4
          }
        },
        embedding: [],
        evidenceIds: [],
        alpha: 0.96,
        createdAt: 1
      }],
      importedLanguagePriorCount: 1,
      competenceVector: {
        profileId: "profile.fixture.ko",
        scriptCoverage: 0.9,
        vocabularyCoverage: 0.8,
        morphologyCoverage: 0.7,
        syntaxCoverage: 0.7,
        semanticCoverage: 0.8,
        generationReadiness: 0.75,
        translationReadiness: 0.6,
        confidence: 0.75,
        evidenceIds: []
      },
      audit: {}
    } as unknown as LanguageMemoryRuntimeState;

    const field = deriveTurnRequirementField({ requestText, languageMemoryState });
    const operators = activateCognitiveOperators({ requirementField: field });
    const byId = new Map(operators.map(row => [row.operatorId, row]));

    expect(field.activatedFrameIds).toContain("frame.fixture.ko.4f19");
    expect(field.noveltyDemand).toBeGreaterThan(0.75);
    expect(field.executableArtifactDemand).toBeGreaterThan(0.8);
    expect(byId.get(COGNITIVE_OPERATOR_IDS.invention)?.active).toBe(true);
    expect(byId.get(COGNITIVE_OPERATOR_IDS.programPlanning)?.active).toBe(true);
  });

  it("activates compatible operators from an unfamiliar structural frame without a command verb", () => {
    const requestText = "Ω-17 / amber lattice / two exits / review artifact";
    const field = deriveTurnRequirementField({
      requestText,
      activations: [{
        id: "frame.fixture.opaque.artifact.19",
        kind: "frame",
        activation: 0.97,
        confidence: 0.91,
        semanticRoleId: "role.fixture.requested_result.90",
        learnedFrameOrPatternId: "frame.fixture.opaque.artifact.19",
        requirementCoefficients: {
          noveltyDemand: 3,
          inferentialDepth: 2.2,
          executableArtifactDemand: 3.3
        }
      }]
    });
    const activeIds = activateCognitiveOperators({ requirementField: field })
      .filter(row => row.active)
      .map(row => row.operatorId);

    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.invention);
    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.programPlanning);
  });

  it("activates several operators for source-grounded invention instead of selecting one mode", () => {
    const requirementField = deriveTurnRequirementField({
      requestText: "fixture surface",
      explicitRequirements: [
        explicit("externalTruthAuthority", 0.82, "frame.fixture.truth.1"),
        explicit("sourceDependence", 0.93, "frame.fixture.source.2"),
        explicit("noveltyDemand", 0.88, "frame.fixture.novelty.3"),
        explicit("inferentialDepth", 0.78, "frame.fixture.depth.4")
      ]
    });
    const operators = activateCognitiveOperators({
      requirementField,
      graphSupport: { [COGNITIVE_OPERATOR_IDS.graphPropagation]: 0.35 },
      constructSupport: { [COGNITIVE_OPERATOR_IDS.invention]: 0.25 }
    });
    const activeIds = operators.filter(row => row.active).map(row => row.operatorId);

    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.evidenceActivation);
    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.sourceSynthesis);
    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.graphPropagation);
    expect(activeIds).toContain(COGNITIVE_OPERATOR_IDS.invention);
    expect(activeIds.length).toBeGreaterThanOrEqual(4);
    for (const operator of operators) {
      expect(Number.isFinite(operator.activation)).toBe(true);
      expect(operator.activation).toBeGreaterThanOrEqual(0);
      expect(operator.activation).toBeLessThanOrEqual(1);
    }
  });

  it("retains Unicode character and UTF-8 byte provenance on extracted requirements", () => {
    const requestText = "甲🙂β번역 결과";
    const points = [...requestText];
    const charStart = 3;
    const charEnd = points.length;
    const field = deriveTurnRequirementField({
      requestText,
      activations: [{
        id: "pattern.fixture.transfer.c31d",
        kind: "pattern",
        activation: 0.94,
        confidence: 0.9,
        span: { charStart, charEnd },
        semanticRoleId: "role.fixture.target.034c",
        learnedFrameOrPatternId: "pattern.fixture.transfer.c31d",
        dialogueReferenceId: "turn.fixture.previous.5",
        requirementCoefficients: { semanticPreservation: 2.5, surfaceTransformation: 2.2 }
      }]
    });
    const requirement = field.requiredFeatures.find(row => row.dimension === "semanticPreservation");
    const expectedPrefix = points.slice(0, charStart).join("");

    expect(requirement).toBeDefined();
    expect(requirement?.origin.requestSpan).toEqual({
      text: points.slice(charStart, charEnd).join(""),
      charStart,
      charEnd,
      byteStart: Buffer.byteLength(expectedPrefix, "utf8"),
      byteEnd: Buffer.byteLength(requestText, "utf8")
    });
    expect(requirement?.origin.semanticRoleId).toBe("role.fixture.target.034c");
    expect(requirement?.origin.learnedFrameOrPatternId).toBe("pattern.fixture.transfer.c31d");
    expect(requirement?.origin.dialogueReferenceId).toBe("turn.fixture.previous.5");
    expect(requirement?.status).toBe("inferred");
  });

  it("clamps non-finite field inputs, requirements, supports, and activations", () => {
    const field = deriveTurnRequirementField({
      requestText: "opaque fixture",
      activations: [{
        id: "frame.fixture.nonfinite.1",
        kind: "frame",
        activation: Number.POSITIVE_INFINITY,
        confidence: Number.NaN,
        semanticRoleId: "role.fixture.1",
        learnedFrameOrPatternId: "frame.fixture.nonfinite.1",
        requirementCoefficients: { noveltyDemand: Number.NEGATIVE_INFINITY, inferentialDepth: 4 }
      }],
      explicitRequirements: [explicit("sourceDependence", Number.POSITIVE_INFINITY, "frame.fixture.source.nonfinite")],
      contextContribution: { temporalReasoningDemand: Number.NaN }
    });
    for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
      expect(Number.isFinite(field[dimension])).toBe(true);
      expect(field[dimension]).toBeGreaterThanOrEqual(0);
      expect(field[dimension]).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(field.confidence)).toBe(true);
    for (const requirement of [...field.requiredFeatures, ...field.prohibitedFeatures]) {
      expect(Number.isFinite(requirement.value)).toBe(true);
      expect(Number.isFinite(requirement.confidence)).toBe(true);
    }

    const model = {
      ...DEFAULT_COGNITIVE_OPERATOR_MODEL,
      intercepts: {
        ...DEFAULT_COGNITIVE_OPERATOR_MODEL.intercepts,
        [COGNITIVE_OPERATOR_IDS.analogy]: Number.NaN
      }
    };
    const operators = activateCognitiveOperators({
      requirementField: field,
      graphSupport: { [COGNITIVE_OPERATOR_IDS.analogy]: Number.POSITIVE_INFINITY },
      model
    });
    expect(operators.every(row => Number.isFinite(row.activation) && row.activation >= 0 && row.activation <= 1)).toBe(true);
  });

  it("records every term of the multi-operator activation equation in internal trace", () => {
    const requirementField = deriveTurnRequirementField({
      requestText: "opaque",
      explicitRequirements: [explicit("causalReasoningDemand", 0.9, "frame.fixture.causal.81")]
    });
    const [operator] = activateCognitiveOperators({
      requirementField,
      graphSupport: { [COGNITIVE_OPERATOR_IDS.causalAnalysis]: 0.2 },
      dialogueSupport: { [COGNITIVE_OPERATOR_IDS.causalAnalysis]: 0.1 },
      constructSupport: { [COGNITIVE_OPERATOR_IDS.causalAnalysis]: 0.15 },
      outcomeSupport: { [COGNITIVE_OPERATOR_IDS.causalAnalysis]: -0.05 }
    }).filter(row => row.operatorId === COGNITIVE_OPERATOR_IDS.causalAnalysis);
    const trace = operator?.trace as Record<string, unknown>;

    expect(operator?.active).toBe(true);
    expect(trace.equation).toBe("sigmoid(intercept + requirement + graph + dialogue + construct + outcome)");
    expect(trace.support).toEqual({
      requirement: operator?.support.requirement,
      graph: 0.2,
      dialogue: 0.1,
      construct: 0.15,
      outcome: -0.05
    });
  });

  it("contains no surface-command router in the production requirement module", () => {
    const source = readFileSync(new URL("../turn-requirements.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/requestText\.(?:includes|startsWith|endsWith|match|search)\s*\(/u);
    expect(source).not.toMatch(/(?:keyword|commandWord|triggerWord)s?\s*=\s*\[/iu);
    expect(source).not.toContain("new RegExp");
  });
});

function explicit(dimension: typeof TURN_REQUIREMENT_DIMENSIONS[number], value: number, learnedFrameOrPatternId: string) {
  return {
    dimension,
    value,
    semanticRoleId: "role.fixture.requirement.12",
    learnedFrameOrPatternId
  };
}
