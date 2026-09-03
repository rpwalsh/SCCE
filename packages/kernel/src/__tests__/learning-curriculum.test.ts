import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { learningAcquisitionCapabilityPlans } from "../learning-acquisition-runtime.js";
import { curriculumItemFromPlan, learningConsentInput } from "../learning-review.js";
import { requiresExplicitApproval } from "../kernel-input-controls.js";
import { DEFAULT_POLICY } from "../safety.js";

const sourcePlan = (capabilityId: string, query: string) => ({ id: `plan:${query}`, kind: "web", capabilityId, query, expectedValue: 0.8, taskProgress: 0.5, proofValue: 0.5, cost: 0.1, risk: 0.1, permissionPenalty: 0, utility: 0.7, expectedInformationGain: 0.6, rationale: "gap", acquisition: { acquire: true, quarantine: true, extract: true, validate: true, promote: "owner", graphUpdate: true } });

describe("self-set curriculum", () => {
  it("turns a network learning plan into a consent request instead of a read-only auto-run", () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const plans = learningAcquisitionCapabilityPlans({
      episodeId: "episode:1" as never,
      learningLoopPlan: { learningNeeds: [{ sourcePlans: [sourcePlan("network.search", "history of the Bajoran wormhole")] }], globalSources: [] } as never,
      policy: DEFAULT_POLICY,
      connectorsConfigured: true,
      idFactory: createIdFactory({ clock, hasher: createHasher(), deterministicReplay: true }),
      now: 1000
    });
    expect(plans).toHaveLength(1);
    expect(requiresExplicitApproval(plans[0]!)).toBe(true);
    expect(curriculumItemFromPlan(plans[0]!)).toMatchObject({ capabilityId: "network.search", query: "history of the Bajoran wormhole" });
  });

  it("builds one stable consent fingerprint per query", () => {
    const hasher = createHasher();
    expect(learningConsentInput("q", hasher)).toEqual(learningConsentInput("q", hasher));
    expect(learningConsentInput("q", hasher)).not.toEqual(learningConsentInput("other", hasher));
  });
});
