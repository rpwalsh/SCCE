import { describe, expect, it } from "vitest";
import { buildDiscourseObjectState } from "../discourse-state.js";

describe("discourse object state", () => {
  it.each(["that?", "그것은?"])("binds sparse continuation %s to prior evidence-bearing object without query concatenation", currentText => {
    const state = buildDiscourseObjectState({
      sessionId: "session_test",
      currentText,
      recentTurns: [
        {
          id: "turn_owner_1",
          roleId: "session.role.owner",
          text: "Ada Lovelace",
          evidenceIds: [],
          createdAt: 100,
          turnIndex: 1
        },
        {
          id: "turn_surface_1",
          roleId: "session.role.assistant",
          text: "source-bound surface",
          evidenceIds: ["evidence_2b6c4a91d3f44705b1e26a9d2b9b6f2a"],
          sourceVersionIds: ["source_version_73d9f0a8d3f44705b1e26a9d2b9b6f2a"],
          createdAt: 101,
          turnIndex: 2
        }
      ]
    });

    expect(state).toBeTruthy();
    expect(state?.objectId).toMatch(/^discourse_object_[0-9a-f]{32}$/u);
    expect(state?.stateId).toMatch(/^discourse_state_[0-9a-f]{32}$/u);
    expect(state?.bindingConfidence).toBeGreaterThan(0.45);
    expect(state?.evidenceIds).toContain("evidence_2b6c4a91d3f44705b1e26a9d2b9b6f2a");
    expect(state?.queryConcatenationUsed).toBe(false);
    for (const signalId of state?.signalIds ?? []) expect(signalId).toMatch(/^disc\.signal\.[0-9a-f]{8}$/u);
  });

  it("does not bind punctuation-only continuation", () => {
    const state = buildDiscourseObjectState({
      sessionId: "session_test",
      currentText: "?",
      recentTurns: [
        {
          id: "turn_surface_1",
          roleId: "session.role.assistant",
          text: "source-bound surface",
          evidenceIds: ["evidence_2b6c4a91d3f44705b1e26a9d2b9b6f2a"],
          createdAt: 101,
          turnIndex: 2
        }
      ]
    });

    expect(state).toBeUndefined();
  });

  it("does not bind a specific new surface to the previous object", () => {
    const state = buildDiscourseObjectState({
      sessionId: "session_test",
      currentText: "Alpha Beta Gamma Delta",
      recentTurns: [
        {
          id: "turn_surface_1",
          roleId: "session.role.assistant",
          text: "source-bound surface",
          evidenceIds: ["evidence_2b6c4a91d3f44705b1e26a9d2b9b6f2a"],
          createdAt: 101,
          turnIndex: 2
        }
      ]
    });

    expect(state).toBeUndefined();
  });
});
