// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  TURN_REQUIREMENT_DIMENSIONS,
  turnRequirementNeutralValue,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "../../turn-requirements.js";
import {
  REQUESTED_AUTHORITY_IDS,
  authorityRequirementCoefficients,
  projectRequestAuthority,
  type RequestAuthorityProjection
} from "../../request-authority.js";
import { clamp01 } from "../../primitives.js";
import { calibrated } from "../../calibrations/prod-calibrations.js";
import type { RequestedAuthority } from "../../types.js";
import { AUTHORITY_PROJECTION_LIVE_20260916 } from "./authority-projection-live-20260916.js";

export interface ReplayRow {
  field: TurnRequirementField;
  programPlanningActive: boolean;
  actionPlanningActive: boolean;
  recordedAuthority: RequestedAuthority;
  recordedMargin: number;
  /** Identity of the inputs the projector actually reads, so the population can be deduplicated. */
  scoringKey: string;
}

/** The live rows, parsed. Dimension values and the contributed-dimension set are the projector's whole input. */
export function authorityReplayRows(): ReplayRow[] {
  return AUTHORITY_PROJECTION_LIVE_20260916
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [dims, mask, flags, authority, margin] = line.split("#");
      const values = dims!.split(",").map(Number);
      const contributedDimensions = TURN_REQUIREMENT_DIMENSIONS
        .filter((_, index) => (BigInt(mask!) >> BigInt(index)) & 1n);
      const field = {
        ...Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map((dimension, index) => [dimension, values[index]!])),
        requiredFeatures: [],
        prohibitedFeatures: [],
        activatedFrameIds: [],
        activatedPatternIds: [],
        activatedPhraseUnitIds: [],
        activatedDialogueMoveIds: [],
        activatedConstructIds: [],
        contributedDimensions: [...contributedDimensions],
        confidence: 0.5,
        trace: {
          dimensions: Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [
            dimension,
            { intercept: dimension === "uncertaintyTolerance" ? 0 : -1.4 }
          ]))
        }
      } as unknown as TurnRequirementField;
      return {
        field,
        programPlanningActive: flags![0] === "1",
        actionPlanningActive: flags![1] === "1",
        recordedAuthority: authority as RequestedAuthority,
        recordedMargin: Number(margin),
        scoringKey: `${dims}#${mask}#${flags}`
      };
    });
}

/**
 * The turn raises inferentialDepth to compositionDemandTarget AFTER projecting authority and BEFORE emitting
 * TurnRequirementsBuilt, so a recorded field sitting on one of that function's output levels no longer carries
 * the value the projector read. Those rows cannot be replayed and are excluded from the population.
 */
const COMPOSITION_DEMAND_LEVELS = [0.58, 0.67, 0.76, 0.85, 0.92];

export function replayableAuthorityRow(row: ReplayRow): boolean {
  return !COMPOSITION_DEMAND_LEVELS.some(level => Math.abs(row.field.inferentialDepth - level) < 1e-9);
}

/** One row per distinct projector input. Repeats in the log are the same request asked again. */
export function distinctAuthorityReplayRows(): ReplayRow[] {
  const seen = new Set<string>();
  return authorityReplayRows().filter(replayableAuthorityRow).filter(row => {
    if (seen.has(row.scoringKey)) return false;
    seen.add(row.scoringKey);
    return true;
  });
}

/**
 * The scorer as it stood before 79f6136: the absolute requirement level, intercept included. Kept here rather
 * than in the kernel because nothing in production may score this way again; it exists to measure the change.
 */
export function scoreRequestAuthorityAtAbsoluteLevel(
  field: TurnRequirementField,
  authority: RequestedAuthority
): number {
  const coefficients = authorityRequirementCoefficients(authority);
  const logit = TURN_REQUIREMENT_DIMENSIONS.reduce((sum, dimension) => (
    sum + (coefficients[dimension] ?? 0) * field[dimension]
  ), 0);
  return clamp01(calibrated("request_authority.projection_bias") + logit / calibrated("request_authority.projection_scale"));
}

export interface ReplayedProjection {
  projectedAuthority: RequestedAuthority;
  scoreMargin: number;
  authorityScoreSpread: number;
  authorityDistinguishable: boolean;
  contributionPresent: boolean;
}

const AUTHORITY_SIGNAL_DIMENSIONS = new Set<TurnRequirementDimension>(
  REQUESTED_AUTHORITY_IDS.flatMap(authority => Object.keys(authorityRequirementCoefficients(authority)) as TurnRequirementDimension[])
);

/** projectRequestAuthority's own arithmetic over a supplied scorer, so both eras run the same downstream logic. */
export function replayProjection(
  field: TurnRequirementField,
  score: (field: TurnRequirementField, authority: RequestedAuthority) => number
): ReplayedProjection {
  const scores = Object.fromEntries(
    REQUESTED_AUTHORITY_IDS.map(authority => [authority, score(field, authority)])
  ) as Record<RequestedAuthority, number>;
  const ranked = REQUESTED_AUTHORITY_IDS
    .map(authority => ({ authority, score: scores[authority] }))
    .sort((left, right) => right.score - left.score || (left.authority < right.authority ? -1 : left.authority > right.authority ? 1 : 0));
  const contributionPresent = field.contributedDimensions === undefined
    ? true
    : field.contributedDimensions.some(dimension => AUTHORITY_SIGNAL_DIMENSIONS.has(dimension));
  const spread = REQUESTED_AUTHORITY_IDS.reduce((high, authority) => Math.max(high, scores[authority]), 0)
    - REQUESTED_AUTHORITY_IDS.reduce((low, authority) => Math.min(low, scores[authority]), Infinity);
  const distinguishable = spread > 0;
  const neutral = !contributionPresent || !distinguishable;
  return {
    projectedAuthority: neutral ? "factual" : (ranked[0]?.authority ?? "factual"),
    scoreMargin: neutral ? 0 : clamp01((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)),
    authorityScoreSpread: spread,
    authorityDistinguishable: distinguishable,
    contributionPresent
  };
}

/** The deviation-scored projection exactly as production computes it. */
export function liveProjection(field: TurnRequirementField): RequestAuthorityProjection {
  return projectRequestAuthority({ requirementField: field });
}

export { turnRequirementNeutralValue };
