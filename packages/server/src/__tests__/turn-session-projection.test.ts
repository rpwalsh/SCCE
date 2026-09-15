// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
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

import { createDiscourseInterpretationAdjustmentV2, createInMemoryDialogueMemoryStore, toJsonValue, type OwnerInput } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("turn session metadata projection", () => {
  it("requires an exact persisted turn target for typed interpretation feedback", async () => {
    const context = { maxBodyBytes: 1_000_000 } as unknown as ApiContext;
    const server = createServer((request, response) => { void handleRequest(request, response, context); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/turn/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "conversation.fixture",
        status: "corrected",
        correctionText: "the alternate referent",
        interpretationCorrection: { mentionId: "mention.fixture", preferredReferentId: "referent.fixture" }
      })
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "typed interpretation correction requires turnId" });
  });

  it("loads a persisted typed interpretation adjustment before the public turn boundary", async () => {
    const adjustment = createDiscourseInterpretationAdjustmentV2({
      semanticRoleIds: ["role.fixture.subject"],
      requestedSlotIds: ["slot.fixture.subject"],
      learnedFrameIds: ["frame.fixture.lookup"],
      scopeIds: ["source-version.fixture"],
      rejectedReferentIds: ["referent.fixture.rejected"],
      preferredReferentIds: ["referent.fixture.preferred"],
      supportMass: 0.95,
      contradictionMass: 0.95,
      correctionIds: ["correction.fixture"]
    });
    const dialogueMemory = createInMemoryDialogueMemoryStore({
      corrections: [{
        id: "correction.fixture",
        conversationId: "conversation.fixture",
        turnId: "turn.fixture",
        promptHash: "prompt.fixture",
        responseHash: "response.fixture",
        correctionText: "typed correction",
        preferenceDeltaJson: toJsonValue({ interpretationAdjustment: adjustment }),
        createdAt: 1
      }]
    });
    const captured: OwnerInput[] = [];
    const context = {
      runtime: {
        storage: {
          dialogueMemory,
          conversation: { listTurns: async () => [] }
        },
        kernel: {
          turn: async (input: OwnerInput) => {
            captured.push(input);
            throw new Error("typed-adjustment-captured");
          }
        }
      },
      config: {},
      startupReadiness: { snapshot: () => ({ phase: "running", ok: false, complete: false }) }
    } as unknown as ApiContext;
    const server = createServer((request, response) => { void handleRequest(request, response, context); });
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
        conversationId: "conversation.fixture",
        text: "Which referent?",
        metadata: {
          dialogue: {
            previousState: { schema: "untrusted", id: "client" },
            cognitiveState: { schema: "untrusted", id: "client" },
            interpretationAdjustments: [{ schema: "untrusted", id: "client" }]
          }
        }
      })
    });
    expect(response.status).toBe(500);
    expect(captured).toHaveLength(1);
    const metadata = captured[0]?.metadata as Record<string, unknown>;
    const dialogue = metadata.dialogue as Record<string, unknown>;
    expect(dialogue.interpretationAdjustments).toEqual([adjustment]);
    expect(dialogue).not.toHaveProperty("previousState");
    expect(dialogue).not.toHaveProperty("cognitiveState");
    expect(JSON.stringify(dialogue.interpretationAdjustments)).not.toContain("untrusted");
  });

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
            input.runtimeControl?.onProgress?.({
              phase: "runtime.graph_slice.complete",
              observedAtMonotonicMs: performance.now()
            });
            input.runtimeControl?.onProgress?.({
              phase: "runtime.acquisition.primary.search",
              observedAtMonotonicMs: performance.now(),
              cognition: { searchResultCount: 12, requestedSourceLineages: 4 }
            });
            input.runtimeControl?.onProgress?.({
              phase: "runtime.acquisition.primary.ingest",
              observedAtMonotonicMs: performance.now(),
              cognition: { uriHash: "uri.fixture", lineageHash: "lineage.fixture", acceptedLineageCount: 1 }
            });
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
    expect(runtime.initialResponseDeadline).toMatchObject({
      schema: "scce.initial_visible_response.v1",
      clock: "node.performance.v1",
      budgetMs: 10_000
    });
    expect(runtime).not.toHaveProperty("deadline");

    const streamed = await fetch(`http://127.0.0.1:${address.port}/api/turn?stream=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/x-ndjson"
      },
      body: JSON.stringify({
        text: "Continue the session",
        requestedAuthority: "factual",
        sessionId: "session.fixture"
      })
    });
    const frames = (await streamed.text())
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(streamed.headers.get("content-type")).toContain("application/x-ndjson");
    expect(frames[0]).toMatchObject({
      schema: "scce.turn_stream.v1",
      type: "accepted",
      initialVisibleResponseDeadlineMs: 10_000
    });
    expect(frames[0]?.taskId).toEqual(expect.any(String));
    expect(frames[0]?.streamUrl).toContain("/api/turn/task/");
    expect(frames[0]?.cancelUrl).toContain("/api/turn/task/");
    expect(frames.map(frame => frame.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames[1]).toMatchObject({
      schema: "scce.turn_stream.v1",
      type: "progress",
      phase: "runtime.request.received",
      cognition: {
        schema: "scce.turn.progress.v1",
        stateId: "request.received",
        sourceId: "request.body",
        request: {
          textChars: "Continue the session".length,
          requestedAuthorityId: "factual",
          targetLanguageId: null
        }
      }
    });
    expect(Number(frames[1]?.elapsedMs)).toBeGreaterThanOrEqual(0);
    expect(frames[2]).toMatchObject({
      schema: "scce.turn_stream.v1",
      type: "progress",
      phase: "runtime.graph_slice.complete",
      cognition: {
        schema: "scce.turn.progress.v1",
        stateId: "stage.boundary",
        phaseId: "runtime.graph_slice.complete",
        settled: false
      }
    });
    expect(frames.at(-1)).toMatchObject({
      schema: "scce.turn_stream.v1",
      type: "error",
      status: 500
    });
    expect(frames[3]).toMatchObject({
      type: "progress", phase: "runtime.acquisition.primary.search",
      cognition: { searchResultCount: 12, requestedSourceLineages: 4 }
    });
    expect(frames[4]).toMatchObject({
      type: "progress", phase: "runtime.acquisition.primary.ingest",
      cognition: { uriHash: "uri.fixture", lineageHash: "lineage.fixture", acceptedLineageCount: 1 }
    });
    expect(frames[4]).not.toHaveProperty("answer");
    expect(Number(frames[4]?.elapsedMs)).toBeGreaterThanOrEqual(Number(frames[3]?.elapsedMs));

    const taskId = String(frames[0]?.taskId);
    const taskStatus = await fetch(`http://127.0.0.1:${address.port}/api/turn/task/${encodeURIComponent(taskId)}`);
    expect(taskStatus.status).toBe(200);
    await expect(taskStatus.json()).resolves.toMatchObject({
      schema: "scce.turn_task.v1",
      taskId,
      status: "failed"
    });

    const replay = await fetch(`http://127.0.0.1:${address.port}/api/turn/task/${encodeURIComponent(taskId)}/stream?after=1`, {
      headers: { accept: "application/x-ndjson" }
    });
    const replayFrames = (await replay.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(replayFrames.every(frame => Number(frame.sequence) > 1)).toBe(true);
    expect(replayFrames.find(frame => frame.phase === "runtime.acquisition.primary.ingest")?.cognition).toEqual(frames[4]?.cognition);
    expect(replayFrames.at(-1)).toMatchObject({ type: "error", taskId });
  });
});
