// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { anchorSymbolUnits } from "../primitives.js";
import { runtimeMotionFocusAnchor } from "../runtime-motion.js";
import { conversationalSession } from "./conversational-session-fixture.js";

const REQUEST = "What did Einstein discover?";
/** The anchors the live turn ranked for this request, traced at `turn.source_anchor_audit` on 2026-09-16. */
const LIVE_ANCHORS = ["what did einstein discover", "einstein discover", "did einstein"];

describe("collapsing the anchor set to one runtime-motion focus preserves the request's discriminative units", () => {
  it("keeps a content unit that another available anchor retained", () => {
    // `did einstein` is the last anchor enumerated and the one that destroys `discover`.
    const measured = runtimeMotionFocusAnchor(REQUEST, LIVE_ANCHORS, ["what", "did"]);
    expect(measured.basis).toBe("discriminative_residue");
    expect(measured.droppedContentUnits).toEqual([]);
    expect(anchorSymbolUnits(measured.anchor ?? "")).toEqual(expect.arrayContaining(["einstein", "discover"]));
  });

  it("reports an unmeasured scaffolding class as its own state rather than ranking on nothing", () => {
    const unmeasured = runtimeMotionFocusAnchor(REQUEST, LIVE_ANCHORS, []);
    expect(unmeasured.basis).toBe("closed_class_unmeasured");
  });

  it.each([REQUEST, REQUEST.slice(0, -1)])("does not turn an inert dialogue prior into an answer to a cold factual request: %s", async request => {
    const session = conversationalSession();
    const turn = await session.turn(request);

    const anchors = (turn.trace.find(row => row.stage === "turn.source_anchor_audit")?.support?.anchors ?? []) as string[];
    expect(anchors.length).toBeGreaterThan(0);
    expect(turn.result.answer).toBe("");
    expect(turn.trace.some(row => row.stage === "mouth.deterministic.select")).toBe(false);
    const conversationMemory = turn.trace.find(row => row.stage === "mouth.conversation_memory.candidate")?.support as Record<string, unknown> | undefined;
    expect(conversationMemory?.reason).toBe("no_active_non_neutral_owner_act");
    const selected = turn.trace.find(row => row.stage === "mouth.candidate.select")?.support as Record<string, unknown> | undefined;
    expect(selected?.selectedSource).toBe("none");
    expect((selected?.contentPlanAdmission as { status?: string } | undefined)?.status).toBe("insufficient_support");
  }, 600_000);
});
