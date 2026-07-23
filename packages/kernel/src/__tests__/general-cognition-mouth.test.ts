import { describe, expect, it } from "vitest";
import {
  GENERAL_COGNITION_SURFACE_BOOTSTRAP,
  boundaryProfileFor,
  scoreSurfaceEnergy,
  toJsonValue,
  type CognitiveProposal,
  type PlannedClaim,
  type SurfaceEnergyComponent,
  type SurfaceEnergyContext,
  type SurfacePlan,
  type TurnRequirementField
} from "../index.js";

describe("general-cognition Mouth surface objective", () => {
  it("implements the exact versioned Q_surface equation when a requirement field is present", () => {
    const context = generalContext();
    const result = scoreSurfaceEnergy({
      id: "surface:general:clean",
      text: "The bounded route preserves the claim, then explains the consequence clearly.",
      force: "bounded",
      languageActivation: 0.72,
      languageFit: 0.81,
      semanticPreservation: 0.93,
      metadata: toJsonValue({ outputFeatureIds: ["requirement:explanation"] })
    }, context);

    const byId = new Map(result.components.map(component => [component.id, component]));
    const expected =
      0.22 * raw(byId, "surface.general.meaning_preservation") +
      0.16 * raw(byId, "surface.general.requirement_coverage") +
      0.13 * raw(byId, "surface.general.coherence") +
      0.12 * raw(byId, "surface.general.learned_language_fit") +
      0.10 * raw(byId, "surface.general.directness") +
      0.09 * raw(byId, "surface.general.structure") +
      0.07 * raw(byId, "surface.general.style_fit") +
      0.06 * raw(byId, "surface.general.surface_novelty") +
      0.05 * raw(byId, "surface.general.rhythm") -
      0.24 * raw(byId, "surface.general.repetition") -
      0.28 * raw(byId, "surface.general.contradiction_leak") -
      0.32 * raw(byId, "surface.general.telemetry_leak") -
      0.70 * raw(byId, "surface.general.fake_factual_authority");
    const contributionTotal = result.components.reduce((total, component) => total + (component.polarity === "support" ? component.contribution : -component.contribution), 0);

    expect(result.valid).toBe(true);
    expect(result.surfaceScore).toBeCloseTo(contributionTotal, 8);
    expect(result.surfaceScore).toBeCloseTo(expected, 7);
    expect(result.energy).toBeCloseTo(-contributionTotal, 8);
    expect(GENERAL_COGNITION_SURFACE_BOOTSTRAP.coefficients.fakeFactualAuthority).toBe(-0.70);
    expect(JSON.stringify(result.trace)).toContain("surface.general_cognition.bootstrap.v1");
    expect(JSON.stringify(result.trace)).toContain("surface-general-cognition.bootstrap.2026-07-12.v1");
  });

  it("hard-rejects telemetry and unsupported externally factual authority", () => {
    const context = generalContext();
    const telemetry = scoreSurfaceEnergy({
      id: "surface:general:telemetry",
      text: "{\"candidateId\":\"candidate:7\",\"graphNodeIds\":[\"node:8\"],\"scoreTrace\":[0.91]}",
      force: "bounded",
      semanticPreservation: 0.92
    }, context);
    expect(telemetry.valid).toBe(false);
    expect(telemetry.hardViolations.map(row => row.id)).toContain("surface.reject.telemetry_leak");

    const graphIdentifiers = scoreSurfaceEnergy({
      id: "surface:general:graph-identifiers",
      text: `visible prose node_${"a".repeat(48)} relation_${"b".repeat(48)}`,
      force: "bounded",
      semanticPreservation: 0.92
    }, context);
    expect(graphIdentifiers.valid).toBe(false);
    expect(graphIdentifiers.hardViolations.map(row => row.id)).toContain("surface.reject.telemetry_leak");
    expect(JSON.stringify(graphIdentifiers.components.find(row => row.id === "surface.general.telemetry_leak")?.trace)).toContain("surface.telemetry.graph_identifier");

    const unsupportedClaim: PlannedClaim = {
      id: "claim:unsupported",
      text: "The external measurement is 91 percent.",
      basis: "unsupported",
      evidenceIds: [],
      priorIds: [],
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: true,
      hypothetical: false,
      trace: {}
    };
    const fakeAuthority = scoreSurfaceEnergy({
      id: "surface:general:fake-authority",
      text: unsupportedClaim.text,
      force: "observed",
      semanticPreservation: 0.96
    }, { ...context, claimBases: [unsupportedClaim], requirementField: { ...context.requirementField!, externalTruthAuthority: 0.92 } });
    expect(fakeAuthority.valid).toBe(false);
    expect(fakeAuthority.hardViolations.map(row => row.id)).toContain("surface.reject.fake_factual_authority");
  });

  it("runs the final gate after formatting and rejects lost negation, uncertainty, code, or format", () => {
    const context: SurfaceEnergyContext = {
      ...generalContext(),
      transformationBaseline: {
        requiredSurfaces: ["not", "may remain uncertain"],
        requiredCodeLiterals: ["route.score()"],
        minimumLineCount: 2,
        minimumListMarkerCount: 1,
        minimumCodeFenceCount: 2
      }
    };
    const damaged = scoreSurfaceEnergy({
      id: "surface:general:damaged-final",
      text: "The route is certain and route score is available.",
      force: "bounded",
      semanticPreservation: 0.9
    }, context);
    expect(damaged.valid).toBe(false);
    expect(damaged.hardViolations.map(row => row.id)).toEqual(expect.arrayContaining([
      "surface.reject.final_transformation_invariant_loss",
      "surface.reject.requested_format_lost"
    ]));
  });
});

function generalContext(): SurfaceEnergyContext {
  const requirements = requirementField();
  const proposal = cognitiveProposal();
  return {
    requirementField: requirements,
    selectedProposal: proposal,
    claimBases: proposal.claims,
    requiredOutputFeatures: requirements.requiredFeatures,
    prohibitedOutputFeatures: requirements.prohibitedFeatures,
    surfacePlan: surfacePlan(),
    expectedForce: "bounded",
    proofVerdict: "source_bound_only",
    fieldSummary: { contradictionPressure: 0.04, actionability: 0.62 },
    languagePrior: { activation: 0.72, fit: 0.81, support: 0.55, surfaces: ["A generic repeated answer."] },
    styleVector: [0.58, 0.42, 0.2],
    requiredEntities: [],
    requiredNumbers: [],
    requiredCaveats: []
  };
}

function requirementField(): TurnRequirementField {
  return {
    externalTruthAuthority: 0.2,
    sourceDependence: 0.35,
    noveltyDemand: 0.28,
    inferentialDepth: 0.78,
    semanticPreservation: 0.9,
    surfaceTransformation: 0.64,
    executableArtifactDemand: 0.1,
    actionCommitment: 0.1,
    dialogueDependence: 0.2,
    uncertaintyTolerance: 0.7,
    formatConstraintStrength: 0.3,
    audienceAdaptation: 0.55,
    brevityDetailBalance: 0.5,
    temporalReasoningDemand: 0.2,
    causalReasoningDemand: 0.4,
    counterfactualDemand: 0.1,
    requiredFeatures: [],
    prohibitedFeatures: [],
    activatedFrameIds: ["frame:fixture"],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 0.82,
    trace: {}
  };
}

function cognitiveProposal(): CognitiveProposal {
  const claim: PlannedClaim = {
    id: "claim:bounded-route",
    text: "The bounded route preserves the claim.",
    basis: "reasoned_inference",
    evidenceIds: [],
    priorIds: ["prior:route"],
    graphNodeIds: [],
    graphEdgeIds: ["edge:route"],
    externallyFactual: false,
    hypothetical: false,
    trace: {}
  };
  return {
    id: "proposal:bounded-route",
    operatorActivations: [],
    claims: [claim],
    relations: [],
    steps: [],
    artifacts: [],
    evidenceIds: [],
    priorIds: ["prior:route"],
    graphNodeIds: [],
    semanticFrameIds: ["frame:fixture"],
    constructIds: [],
    satisfiedRequirementIds: [],
    missedRequirementIds: [],
    quality: {
      reasoning: {
        premiseValidity: 0.84,
        relationContinuity: 0.82,
        requirementCoverage: 0.88,
        explanatoryPower: 0.8,
        contradictionHandling: 0.9,
        temporalConsistency: 0.86,
        simplicity: 0.72,
        usefulness: 0.82,
        unsupportedLeapRate: 0,
        internalContradiction: 0,
        score: 0.84
      },
      baseQuality: 0.84,
      diversity: 0.65,
      mmr: 0.79,
      hardFailures: []
    },
    trace: {}
  };
}

function surfacePlan(): SurfacePlan {
  const pointId = "surface:general:point";
  return {
    thesis: pointId,
    orderedPoints: [{
      id: pointId,
      constructNodeId: "construct:general",
      proposition: "The bounded route preserves the claim.",
      force: "bounded",
      evidenceIds: [],
      role: "answer",
      support: 0.72,
      contradiction: 0.02,
      realizationConstraints: {}
    }],
    realizationFrames: [],
    requiredTerms: [],
    forbiddenSurfaces: [],
    evidenceBindings: [],
    forceBindings: [{ pointId, force: "bounded", constructForce: "InferenceConstruct", support: 0.72, contradiction: 0.02 }],
    caveatBindings: [],
    constructForces: [{ id: "InferenceConstruct", weight: 1, source: "fixture" }],
    targetLanguage: "fixture-language",
    targetScript: "fixture-script",
    styleProfileId: "surface.style.fixture",
    style: { name: "fixture", density: 0.58, formality: 0.42, creativity: 0.2, exposeProofTerms: false },
    detailProfileId: "surface.detail.1",
    boundaryProfile: boundaryProfileFor({ scriptId: "fixture-script" }),
    audit: {}
  };
}

function raw(components: Map<string, SurfaceEnergyComponent>, id: string): number {
  const component = components.get(id);
  if (!component) throw new Error(`missing component ${id}`);
  return component.raw;
}
