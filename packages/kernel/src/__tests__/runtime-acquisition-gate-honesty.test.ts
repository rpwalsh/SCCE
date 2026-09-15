// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createRuntimeAcquisition } from "../runtime-acquisition.js";
import { createEventFactory } from "../events.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { ApprovalPort, ScceKernelDeps } from "../storage.js";
import type { EpisodeId, IngestResult, ScceEvent } from "../types.js";

const GATE = { reason: "public-network-acquisition-disabled", gate: "SCCE_ALLOW_AUTOMATIC_WEB" };

function fixture(approvals: ApprovalPort) {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1000, stepMs: 1 });
  const idFactory = createIdFactory({ clock, hasher });
  const eventFactory = createEventFactory({ clock, hasher, idFactory });
  const episodeId = "episode.gate" as EpisodeId;
  const plans: unknown[] = [];
  const events: ScceEvent[] = [];
  const deps = {
    storage: { capabilities: { putPlan: async (plan: unknown) => { plans.push(plan); } } },
    approvals,
    connectors: { search: async () => [], fetch: async () => { throw new Error("must not fetch"); } }
  } as unknown as ScceKernelDeps;
  const acquisition = createRuntimeAcquisition({
    deps, eventFactory, hasher, failures: [], now: clock.now,
    append: async event => event,
    ingest: async () => ({ sources: 0, evidence: 0, promotedEvidenceIds: [], events: [] }) as unknown as IngestResult
  });
  return { acquisition, episodeId, plans, events };
}

const turn = (f: ReturnType<typeof fixture>) => ({
  ownerInput: { text: "α β γ" }, episodeId: f.episodeId, requestedAuthority: "reasoned" as const, trigger: "coherence_support_failure" as const, events: f.events
});

describe("runtime acquisition reports who refused the network", () => {
  it("reports a missing deployment gate as disabled_explicitly with the variable name, never as the owner's decision", async () => {
    const f = fixture({ isApproved: () => false, isRejected: () => true, disabledReason: () => GATE, observePending: () => {} });
    const motion = await f.acquisition.learnHydrateReplan(turn(f));
    expect(motion.status).toBe("disabled_explicitly");
    expect(motion.disabled).toEqual(GATE);
    expect(motion.failures).toContain("public-network-acquisition-disabled");
    expect(motion.failures).not.toContain("owner-consent-refused");
    expect(motion.consent).toBeUndefined();
    expect(f.plans).toHaveLength(0);
    const planned = f.events.find(event => event.typeId === "RuntimeMotionPlanned");
    expect(JSON.stringify(planned?.payload)).toContain("SCCE_ALLOW_AUTOMATIC_WEB");

    const deferred = await f.acquisition.runtimeMotionDeferredByDeadline({
      requestText: "α β γ", episodeId: f.episodeId, requestedAuthority: "reasoned", trigger: "coherence_support_failure", connectorConfigured: true
    });
    expect(deferred.status).toBe("disabled_explicitly");
    expect(deferred.disabled).toEqual(GATE);
    expect(deferred.failures).not.toContain("owner-consent-refused");
  });

  it("still reports an owner decline as refused by the owner", async () => {
    const f = fixture({ isApproved: () => false, isRejected: () => true, disabledReason: () => undefined, observePending: () => {} });
    const motion = await f.acquisition.learnHydrateReplan(turn(f));
    expect(motion.status).toBe("refused");
    expect(motion.failures).toContain("owner-consent-refused");
    expect(motion.disabled).toBeUndefined();
  });

  it("asks before searching when neither the owner nor a gate has decided", async () => {
    const f = fixture({ isApproved: () => false, isRejected: () => false, observePending: () => {} });
    const motion = await f.acquisition.learnHydrateReplan(turn(f));
    expect(motion.status).toBe("awaiting_consent");
    expect(f.plans).toHaveLength(1);
  });
});
