// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  REQUESTED_AUTHORITY_IDS,
  operationalAuthorityForProjection,
  projectRequestAuthority
} from "../request-authority.js";
import {
  DEFAULT_TURN_REQUIREMENT_MODEL,
  TURN_REQUIREMENT_DIMENSIONS,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "../turn-requirements.js";

function fieldFrom(
  values: Record<TurnRequirementDimension, number>,
  contributed: TurnRequirementDimension[]
): TurnRequirementField {
  return {
    ...values,
    requiredFeatures: [],
    prohibitedFeatures: [],
    activatedFrameIds: [],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    contributedDimensions: contributed,
    confidence: 0.5,
    trace: null
  };
}

/** sigmoid(intercept_d): the value a dimension takes when nothing contributed to it. */
function neutralField(): Record<TurnRequirementDimension, number> {
  return Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => {
    const intercept = DEFAULT_TURN_REQUIREMENT_MODEL.intercepts[dimension] ?? 0;
    return [dimension, 1 / (1 + Math.exp(-intercept))];
  })) as Record<TurnRequirementDimension, number>;
}

// Requirement values copied verbatim from the live server trace
// 2026-09-16T21-33-57-972Z-trace_mu4mbluc_lwwsl1, stage runtime.dialogue_act.classify.
const TUNGSTEN_FIELD: Record<TurnRequirementDimension, number> = {
  externalTruthAuthority: 0.22499096203124933,
  sourceDependence: 0.2557925361469118,
  noveltyDemand: 0.03832351830316184,
  inferentialDepth: 0.142420951180791,
  semanticPreservation: 0.2381842531693024,
  surfaceTransformation: 0.21250528857797352,
  executableArtifactDemand: 0.06887504627537178,
  actionCommitment: 0.07535885464904307,
  dialogueDependence: 0.6037216763157924,
  uncertaintyTolerance: 0.5478319969595061,
  formatConstraintStrength: 0.19781611144141825,
  audienceAdaptation: 0.20752214262865992,
  brevityDetailBalance: 0.5606543830329552,
  temporalReasoningDemand: 0.20287945519399692,
  causalReasoningDemand: 0.20953053407564232,
  counterfactualDemand: 0.20434374954989684
};

const GREETING_FIELD: Record<TurnRequirementDimension, number> = {
  externalTruthAuthority: 0.19781611144141825,
  sourceDependence: 0.19781611144141825,
  noveltyDemand: 0.19781611144141825,
  inferentialDepth: 0.18869190502182834,
  semanticPreservation: 0.19781611144141825,
  surfaceTransformation: 0.19781611144141825,
  executableArtifactDemand: 0.19781611144141825,
  actionCommitment: 0.19781611144141825,
  dialogueDependence: 0.37595920679979616,
  uncertaintyTolerance: 0.5,
  formatConstraintStrength: 0.19781611144141825,
  audienceAdaptation: 0.19781611144141825,
  brevityDetailBalance: 0.5,
  temporalReasoningDemand: 0.19781611144141825,
  causalReasoningDemand: 0.19781611144141825,
  counterfactualDemand: 0.19781611144141825
};

describe("request authority is scored on requirement evidence, not on coefficient mass", () => {
  it("ranks no authority above another when the requirement field carries no contribution", () => {
    const projection = projectRequestAuthority({
      // Declares every dimension contributed so the intercept-only floor cannot mask the scoring bias.
      requirementField: fieldFrom(neutralField(), [...TURN_REQUIREMENT_DIMENSIONS])
    });
    const scores = REQUESTED_AUTHORITY_IDS.map(authority => projection.scores[authority]);
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(spread).toBeLessThan(1e-9);
  });

  it("routes a measured physical-property question to factual, not translation", () => {
    const projection = projectRequestAuthority({
      requirementField: fieldFrom(TUNGSTEN_FIELD, [
        "externalTruthAuthority", "sourceDependence", "noveltyDemand", "inferentialDepth",
        "semanticPreservation", "surfaceTransformation", "executableArtifactDemand",
        "actionCommitment", "dialogueDependence", "uncertaintyTolerance", "audienceAdaptation",
        "brevityDetailBalance", "temporalReasoningDemand", "causalReasoningDemand", "counterfactualDemand"
      ])
    });
    expect(projection.projectedAuthority).toBe("factual");
    expect(operationalAuthorityForProjection({ projection, activeOperatorIds: [] })).toBe("factual");
  });

  it("never demotes a dialogue-only greeting into the translation lane", () => {
    const projection = projectRequestAuthority({
      requirementField: fieldFrom(GREETING_FIELD, ["inferentialDepth", "dialogueDependence"])
    });
    expect(projection.projectedAuthority).not.toBe("translation");
    expect(operationalAuthorityForProjection({ projection, activeOperatorIds: [] })).not.toBe("translation");
  });
});
