// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { creativeRetrievalNeedsSourceAnchoring } from "../production-turn-runtime.js";
import { projectRequestAuthority, scoreRequestAuthority, REQUESTED_AUTHORITY_IDS } from "../request-authority.js";
import {
  distinctAuthorityReplayRows,
  replayProjection,
  scoreRequestAuthorityAtAbsoluteLevel
} from "./fixtures/authority-projection-replay.js";
import { TURN_REQUIREMENT_DIMENSIONS, turnRequirementNeutralValue, type TurnRequirementField } from "../turn-requirements.js";

/**
 * 79f6136 rescaled the authority score from the absolute requirement level to deviation from each dimension's
 * neutral. Retrieval's source-anchoring decision was reading a hand-set gap on that score, so the commit silently
 * moved it. These pin the decision to the projection's own named separation and record the measured drift.
 */
describe("authority score-margin rescaling", () => {
  const rows = distinctAuthorityReplayRows();

  it("has a live replay population to decide against", () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it("does not require source anchoring for a creative turn whose authorities separated", () => {
    // The pre-79f6136 gap would have demanded anchoring here; the named separation does not.
    expect(creativeRetrievalNeedsSourceAnchoring("creative", { authorityDistinguishable: true })).toBe(false);
  });

  it("requires source anchoring for a creative turn whose authorities separated nothing", () => {
    expect(creativeRetrievalNeedsSourceAnchoring("creative", { authorityDistinguishable: false })).toBe(true);
  });

  it("requires source anchoring for every non-creative authority regardless of separation", () => {
    for (const authority of REQUESTED_AUTHORITY_IDS) {
      if (authority === "creative") continue;
      expect(creativeRetrievalNeedsSourceAnchoring(authority, { authorityDistinguishable: true })).toBe(true);
      expect(creativeRetrievalNeedsSourceAnchoring(authority, { authorityDistinguishable: false })).toBe(true);
    }
  });

  it("agrees with the rescaled runtime on every requirement field recorded live on 2026-09-16", () => {
    // The migration is behaviour-preserving against what the running server does today; it is the pre-79f6136
    // distribution the literal disagreed with, which the next assertion counts.
    const disagreements = rows.filter(row => {
      const projection = projectRequestAuthority({ requirementField: row.field });
      const byLiteral = projection.requestedAuthority !== "creative" || projection.scoreMargin < 0.12;
      return byLiteral !== creativeRetrievalNeedsSourceAnchoring(projection.requestedAuthority, projection);
    });
    expect(disagreements).toHaveLength(0);
  });

  it("records that the rescaling itself moved the source-anchoring decision on live requests", () => {
    const moved = rows.filter(row => {
      const before = replayProjection(row.field, scoreRequestAuthorityAtAbsoluteLevel);
      const after = replayProjection(row.field, scoreRequestAuthority);
      const anchored = (projection: typeof before) => projection.projectedAuthority !== "creative" || projection.scoreMargin < 0.12;
      return anchored(before) !== anchored(after);
    });
    expect(moved.length).toBeGreaterThan(0);
  });

  /**
   * Why the third site, memoryDecidesAuthority, keeps its own comparison: the named boolean cannot express it.
   * A projection that separates nothing is forced onto the conservative authority, and that authority is exactly
   * the one memoryDecidesAuthority's recall-eligibility guard excludes, so substituting the boolean there would
   * make the term unsatisfiable rather than corrected.
   */
  it("never leaves an indistinguishable projection on a recall-eligible authority", () => {
    const neutralField = {
      ...Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, turnRequirementNeutralValue(dimension)])),
      requiredFeatures: [], prohibitedFeatures: [], activatedFrameIds: [], activatedPatternIds: [],
      activatedPhraseUnitIds: [], activatedDialogueMoveIds: [], activatedConstructIds: [],
      confidence: 0.5, trace: {}
    } as unknown as TurnRequirementField;
    const neutral = projectRequestAuthority({ requirementField: neutralField });
    expect(neutral.authorityDistinguishable).toBe(false);
    expect(neutral.projectedAuthority).toBe("factual");
    for (const row of rows) {
      const projection = projectRequestAuthority({ requirementField: row.field });
      if (projection.authorityDistinguishable) continue;
      expect(projection.projectedAuthority).toBe("factual");
    }
  });
});
