import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@scce/adapters-node", async importOriginal => {
  const actual = await importOriginal<typeof import("@scce/adapters-node")>();
  return {
    ...actual,
    assertHydratedRuntimeReady: vi.fn(async () => ({
      activeBrainVersion: "brain.fixture.v1",
      activeImportRunIds: []
    }))
  };
});

import type { OwnerInput } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("turn session metadata projection", () => {
  it("passes typed owner turn acts to the kernel without promoting unrelated nested lookalikes", async () => {
    const assertionAct = {
      schema: "scce.dialogue.turn_act.v1",
      assertionMass: 0.93,
      questionMass: 0.07,
      sourceActivationIds: ["activation.fixture.assertion"]
    } as const;
    const questionTurnAct = {
      schema: "scce.dialogue.turn_act.v1",
      assertionMass: 0.04,
      questionMass: 0.96,
      sourceActivationIds: ["activation.fixture.question"]
    } as const;
    const questionAct = {
      schema: "scce.dialogue.question_act.v1",
      active: true,
      requestedSlotIds: ["slot.fixture.subject"]
    } as const;
    const untrustedTurnAct = {
      schema: "scce.dialogue.turn_act.v1",
      assertionMass: 1,
      questionMass: 0,
      sourceActivationIds: ["activation.untrusted.lookalike"]
    } as const;
    const captured: OwnerInput[] = [];
    const context = {
      runtime: {
        storage: {
          conversation: {
            listTurns: async () => [
              {
                id: "turn.fixture.assertion",
                sessionId: "session.fixture",
                episodeId: "episode.fixture.assertion",
                turnIndex: 1,
                roleId: "session.role.owner",
                text: "Aster is the release codename",
                evidenceIds: [],
                metadata: {
                  schema: "scce.conversation_turn.owner.v1",
                  dialogue: { turnAct: untrustedTurnAct },
                  metadata: {
                    dialogue: { turnAct: assertionAct },
                    unrelated: { dialogue: { turnAct: untrustedTurnAct } }
                  }
                },
                createdAt: 1
              },
              {
                id: "turn.fixture.question",
                sessionId: "session.fixture",
                episodeId: "episode.fixture.question",
                turnIndex: 2,
                roleId: "session.role.owner",
                text: "Which codename is active",
                evidenceIds: [],
                metadata: {
                  schema: "scce.conversation_turn.owner.v1",
                  metadata: {
                    turnAct: questionTurnAct,
                    questionAct,
                    unrelated: { questionAct: { ...questionAct, requestedSlotIds: ["slot.untrusted"] } }
                  }
                },
                createdAt: 2
              }
            ]
          },
          dialogueMemory: {
            listStyleSnapshots: async () => [],
            listInteractionStates: async () => []
          }
        },
        kernel: {
          turn: async (input: OwnerInput) => {
            captured.push(input);
            throw new Error("turn-session-projection-captured");
          }
        }
      },
      config: {},
      startupReadiness: {
        snapshot: () => ({ phase: "running", ok: false, complete: false })
      }
    } as unknown as ApiContext;
    const server = createServer((request, response) => {
      void handleRequest(request, response, context);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Continue the session",
        requestedAuthority: "factual",
        sessionId: "session.fixture",
        metadata: {
          fastLocalEvidenceAnswer: false,
          runtime: {
            fastLocalEvidenceAnswer: false,
            productionBoundedAnswer: false,
            deadline: { schema: "untrusted.deadline" }
          }
        }
      })
    });

    expect(response.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.requestedAuthority).toBe("factual");
    const metadata = captured[0]?.metadata as Record<string, unknown>;
    const session = metadata.session as Record<string, unknown>;
    const recentTurns = session.recentTurns as Array<Record<string, unknown>>;
    const assertionDialogue = recentTurns[0]?.dialogue as Record<string, unknown>;
    const questionDialogue = recentTurns[1]?.dialogue as Record<string, unknown>;
    expect(assertionDialogue.turnAct).toEqual(assertionAct);
    expect(questionDialogue.turnAct).toEqual(questionTurnAct);
    expect(questionDialogue.questionAct).toEqual(questionAct);
    expect(recentTurns[0]).not.toHaveProperty("metadata");
    expect(recentTurns[1]).not.toHaveProperty("metadata");
    expect(JSON.stringify(recentTurns)).not.toContain("activation.untrusted.lookalike");
    expect(JSON.stringify(recentTurns)).not.toContain("slot.untrusted");
    const runtime = metadata.runtime as Record<string, unknown>;
    expect(runtime.fastLocalEvidenceAnswer).toBe(true);
    expect(runtime.productionBoundedAnswer).toBe(true);
    expect(runtime.deadline).toMatchObject({
      schema: "scce.runtime_deadline.v1",
      clock: "node.performance.v1",
      budgetMs: 5_000,
      responseReserveMs: 1_000
    });
    expect(runtime.deadline).not.toMatchObject({ schema: "untrusted.deadline" });
  });
});
