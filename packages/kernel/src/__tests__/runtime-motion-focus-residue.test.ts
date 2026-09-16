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

  it("does not speak a focus that drops a content unit the turn's own anchors carried", async () => {
    const session = conversationalSession();
    const turn = await session.turn(REQUEST);

    const anchors = (turn.trace.find(row => row.stage === "turn.source_anchor_audit")?.support?.anchors ?? []) as string[];
    const select = turn.trace.find(row => row.stage === "mouth.deterministic.select");
    const units = (select?.support?.units ?? []) as string[];
    const spokenSurface = ((select?.support?.rows ?? []) as { head: string }[])[0]?.head ?? "";
    expect(anchors.length).toBeGreaterThan(0);
    expect(units.length).toBeGreaterThan(0);
    expect(spokenSurface).not.toBe("");

    // Stated over the turn's own measurements: a request content unit some anchor kept must survive the focus.
    const recoverable = units.filter(unit => anchors.some(anchor => anchorSymbolUnits(anchor).includes(unit)));
    const spokenUnits = new Set(anchorSymbolUnits(spokenSurface));
    expect(recoverable.filter(unit => !spokenUnits.has(unit))).toEqual([]);
  }, 600_000);
});
