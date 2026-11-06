// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { conversationTurnSurfacesFromMetadata } from "../production-turn-runtime.js";

describe("conversation surface ownership", () => {
  it("preserves the actual owner and assistant roles through the Mouth handoff", () => {
    const turns = conversationTurnSurfacesFromMetadata({ session: { sessionId: "conversation", recentTurns: [
      { id: "assistant", turnIndex: 2, roleId: "session.role.assistant", text: "An assistant proposal." },
      { id: "owner", turnIndex: 1, roleId: "session.role.owner", text: "An owner observation." }
    ] } });
    expect(turns.map(turn => [turn.turnId, turn.roleId])).toEqual([
      ["owner", "session.role.owner"], ["assistant", "session.role.assistant"]
    ]);
  });

  it("does not invent owner authority for a turn whose role is absent", () => {
    expect(conversationTurnSurfacesFromMetadata({ session: { sessionId: "conversation", recentTurns: [
      { id: "untyped", text: "Unattributed wording." }
    ] } })[0]?.roleId).toBeUndefined();
  });
});
