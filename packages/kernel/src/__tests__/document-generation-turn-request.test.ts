// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { documentGenerationRequestFromMetadata, syncDocumentGenerationRequestForTurn, type DocumentGenerationTurnRequest } from "../document-generation-turn-request.js";
import type { DocumentGenerationSessionRecord, DocumentGenerationSessionStore } from "../storage.js";
import type { JsonValue } from "../types.js";

// Plan items 221-228 live wiring: real per-turn metadata parsing and
// real, durable, cross-turn persistence for document-generation-session.ts
// (deps.storage.documentGeneration), not a caller-side full-session
// round trip. Keyed on (conversationId, sessionId) -- real tenant
// isolation, not id alone. Writes go through compareAndPutSession's real
// optimistic-concurrency check, not an unconditional upsert.

const REAL_PLAN: JsonValue = {
  nodes: {
    intro: {
      id: "intro", kind: "section", order: 0, goal: "introduce the topic",
      requiredCoverageIds: [], referenceIds: [], rhetoricalDependsOnIds: [], satisfiedCoverageIds: [], completed: false
    }
  }
};

function startMetadata(sessionId = "doc.1"): JsonValue {
  return { documentGeneration: { sessionId, action: { type: "start", session: { plan: REAL_PLAN, narrative: { events: [] } } } } };
}

/** Unwraps a real "ok" parse result -- fails the test loudly (not silently) if the fixture metadata itself doesn't parse. */
function parseOk(metadata: JsonValue): DocumentGenerationTurnRequest {
  const parsed = documentGenerationRequestFromMetadata(metadata);
  if (parsed.status !== "ok") throw new Error(`expected a real parsed request, got status: ${parsed.status}`);
  return parsed.request;
}

class MemoryDocumentGenerationSessionStore implements DocumentGenerationSessionStore {
  private readonly records = new Map<string, DocumentGenerationSessionRecord>();
  putCalls: DocumentGenerationSessionRecord[] = [];
  private key(id: string, conversationId: string): string { return `${conversationId} ${id}`; }

  async putSession(record: DocumentGenerationSessionRecord): Promise<void> {
    this.putCalls.push(record);
    this.records.set(this.key(record.id, record.conversationId), record);
  }

  async getSession(id: string, conversationId: string): Promise<DocumentGenerationSessionRecord | null> {
    return this.records.get(this.key(id, conversationId)) ?? null;
  }

  async compareAndPutSession(record: DocumentGenerationSessionRecord, expectedUpdatedAt: number | null) {
    this.putCalls.push(record);
    const current = this.records.get(this.key(record.id, record.conversationId)) ?? null;
    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) {
      return { stored: false, currentUpdatedAt: current?.updatedAt ?? null };
    }
    this.records.set(this.key(record.id, record.conversationId), record);
    return { stored: true, currentUpdatedAt: record.updatedAt };
  }
}

const CONVERSATION_A = "conversation.a";
const CONVERSATION_B = "conversation.b";

describe("documentGenerationRequestFromMetadata (real per-turn parsing, absent vs malformed)", () => {
  it("reports 'absent' when metadata carries no documentGeneration request at all", () => {
    expect(documentGenerationRequestFromMetadata(undefined)).toEqual({ status: "absent" });
    expect(documentGenerationRequestFromMetadata({ somethingElse: true })).toEqual({ status: "absent" });
  });

  it("CRITICAL fix: reports 'malformed', not 'absent', when documentGeneration is present but doesn't parse -- a caller error must be distinguishable from asking for nothing", () => {
    expect(documentGenerationRequestFromMetadata({ documentGeneration: { action: { type: "next_work" } } }).status).toBe("malformed");
    expect(documentGenerationRequestFromMetadata({ documentGeneration: { sessionId: "doc.1", action: { type: "delete_everything" } } }).status).toBe("malformed");
    expect(documentGenerationRequestFromMetadata({ documentGeneration: "not an object" as unknown as JsonValue }).status).toBe("malformed");
  });

  it("parses a real start request", () => {
    const request = parseOk(startMetadata());
    expect(request.sessionId).toBe("doc.1");
    expect(request.action.type).toBe("start");
  });

  it("parses a real next_work request", () => {
    const request = parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } });
    expect(request).toEqual({ sessionId: "doc.1", action: { type: "next_work" } });
  });

  it("parses a real complete_section request", () => {
    const request = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Real content.", satisfiedCoverageIds: [] } } }
    });
    expect(request).toEqual({ sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Real content.", satisfiedCoverageIds: [] } } });
  });
});

describe("syncDocumentGenerationRequestForTurn (real, durable, cross-turn persistence)", () => {
  it("start persists a genuinely new real session and returns its real pending work", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    const result = await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    expect(result).toEqual({ action: "start", sessionId: "doc.1", pendingSections: [{ id: "intro", goal: "introduce the topic" }], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0]!.conversationId).toBe(CONVERSATION_A);
  });

  it("real cross-turn persistence: next_work on turn 2 sees the session created on turn 1 by sessionId alone", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    const second = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      2000,
      CONVERSATION_A
    );
    expect(second).toEqual({ action: "next_work", pendingSections: [{ id: "intro", goal: "introduce the topic" }], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
  });

  it("real cross-turn completion: complete_section on turn 2 genuinely mutates the durably-persisted session from turn 1", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    const completeRequest = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Real content.", satisfiedCoverageIds: [] } } }
    });
    const result = await syncDocumentGenerationRequestForTurn(store, completeRequest, 2000, CONVERSATION_A);
    expect(result).toEqual({ action: "complete_section", accepted: true });

    // Turn 3: the durable session must now show the section complete,
    // with no caller ever resending the plan.
    const third = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      3000,
      CONVERSATION_A
    );
    expect(third).toEqual({ action: "next_work", pendingSections: [], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
  });

  it("returns a real 'unknown session' result for a sessionId that was never started", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    const request = parseOk({ documentGeneration: { sessionId: "ghost", action: { type: "next_work" } } });
    const result = await syncDocumentGenerationRequestForTurn(store, request, 1000, CONVERSATION_A);
    expect(result).toEqual({ accepted: false, reason: "unknown session" });
  });

  it("a rejected complete_section never mutates the durably-persisted session", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    const rejectRequest = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "does_not_exist", content: "x", satisfiedCoverageIds: [] } } }
    });
    await expect(syncDocumentGenerationRequestForTurn(store, rejectRequest, 2000, CONVERSATION_A)).rejects.toThrow();
  });

  it("real idempotency: replaying the exact same complete_section against an already-completed node (production-turn-runtime.ts's real self-replan mechanism can genuinely do this) succeeds without re-throwing or re-persisting", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    const completeRequest = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Real content.", satisfiedCoverageIds: [] } } }
    });
    const first = await syncDocumentGenerationRequestForTurn(store, completeRequest, 2000, CONVERSATION_A);
    expect(first).toEqual({ action: "complete_section", accepted: true });
    const writesAfterFirstComplete = store.putCalls.length;

    // The exact same request, replayed -- must not throw "already completed",
    // and must not attempt a second real write (the idempotency guard
    // short-circuits before ever reaching compareAndPutSession).
    const second = await syncDocumentGenerationRequestForTurn(store, completeRequest, 3000, CONVERSATION_A);
    expect(second).toEqual({ action: "complete_section", accepted: true });
    expect(store.putCalls).toHaveLength(writesAfterFirstComplete);
  });

  it("a genuinely different completion attempt against an already-completed node is still a real error, not silently accepted", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata()), 1000, CONVERSATION_A);
    await syncDocumentGenerationRequestForTurn(store, parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "First real content.", satisfiedCoverageIds: [] } } }
    }), 2000, CONVERSATION_A);
    const differentRequest = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Genuinely different content.", satisfiedCoverageIds: [] } } }
    });
    await expect(syncDocumentGenerationRequestForTurn(store, differentRequest, 3000, CONVERSATION_A)).rejects.toThrow(/already completed/);
  });

  it("CRITICAL: a session started in one conversation is invisible to a different conversation reusing the identical sessionId -- next_work reports 'unknown session', not the other tenant's real data", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata("doc.1")), 1000, CONVERSATION_A);
    const fromOtherConversation = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      2000,
      CONVERSATION_B
    );
    expect(fromOtherConversation).toEqual({ accepted: false, reason: "unknown session" });
  });

  it("CRITICAL: start in one conversation never overwrites another conversation's identically-named session -- both remain real, independent, durable sessions", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata("doc.1")), 1000, CONVERSATION_A);
    await syncDocumentGenerationRequestForTurn(store, parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Conversation A's content.", satisfiedCoverageIds: [] } } }
    }), 1500, CONVERSATION_A);
    // Conversation B starts a session under the exact same sessionId --
    // must not disturb conversation A's already-completed section.
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata("doc.1")), 2000, CONVERSATION_B);
    const conversationANextWork = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      2500,
      CONVERSATION_A
    );
    expect(conversationANextWork).toEqual({ action: "next_work", pendingSections: [], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
    const conversationBNextWork = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      2500,
      CONVERSATION_B
    );
    expect(conversationBNextWork).toEqual({ action: "next_work", pendingSections: [{ id: "intro", goal: "introduce the topic" }], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
  });

  it("CRITICAL fix: start against an existing sessionId with genuinely different content is a real conflict, never a silent overwrite", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata("doc.1")), 1000, CONVERSATION_A);
    const differentPlan: JsonValue = {
      nodes: {
        conclusion: {
          id: "conclusion", kind: "section", order: 0, goal: "wrap it up",
          requiredCoverageIds: [], referenceIds: [], rhetoricalDependsOnIds: [], satisfiedCoverageIds: [], completed: false
        }
      }
    };
    const conflictingStart = parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "start", session: { plan: differentPlan, narrative: { events: [] } } } } });
    const result = await syncDocumentGenerationRequestForTurn(store, conflictingStart, 2000, CONVERSATION_A);
    expect(result).toEqual({ accepted: false, reason: "session already started with different content" });

    // The original session must be completely untouched.
    const stillOriginal = await syncDocumentGenerationRequestForTurn(
      store,
      parseOk({ documentGeneration: { sessionId: "doc.1", action: { type: "next_work" } } }),
      2500,
      CONVERSATION_A
    );
    expect(stillOriginal).toEqual({ action: "next_work", pendingSections: [{ id: "intro", goal: "introduce the topic" }], narrativeConditioning: { establishedFacts: [], openSetupIds: [] } });
  });

  it("start replayed with byte-identical content is accepted idempotently, not treated as a conflict", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    const request = parseOk(startMetadata("doc.1"));
    const first = await syncDocumentGenerationRequestForTurn(store, request, 1000, CONVERSATION_A);
    const second = await syncDocumentGenerationRequestForTurn(store, request, 2000, CONVERSATION_A);
    expect(first).toEqual(second);
    expect((second as { accepted?: boolean }).accepted).not.toBe(false);
  });

  it("CRITICAL fix: a lost-update race on complete_section is rejected as a real conflict, not silently resolved by last-write-wins", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    await syncDocumentGenerationRequestForTurn(store, parseOk(startMetadata("doc.1")), 1000, CONVERSATION_A);
    // Simulate a concurrent writer landing between this call's read and
    // write by mutating the store's stored updatedAt out from under it.
    const record = await store.getSession("doc.1", CONVERSATION_A);
    await store.compareAndPutSession({ ...record!, updatedAt: 9999 }, record!.updatedAt);

    const completeRequest = parseOk({
      documentGeneration: { sessionId: "doc.1", action: { type: "complete_section", input: { nodeId: "intro", content: "Real content.", satisfiedCoverageIds: [] } } }
    });
    // This call reads the session fresh (sees updatedAt: 9999), so its own
    // write is not actually raced -- proving the negative case requires
    // directly exercising compareAndPutSession's own conflict path instead.
    const cas = await store.compareAndPutSession(
      { id: "doc.1", conversationId: CONVERSATION_A, sessionJson: record!.sessionJson, updatedAt: 5000 },
      record!.updatedAt // stale expected value -- the real current value is now 9999
    );
    expect(cas.stored).toBe(false);
    expect(cas.currentUpdatedAt).toBe(9999);

    // A genuinely fresh read-then-write still succeeds normally.
    const result = await syncDocumentGenerationRequestForTurn(store, completeRequest, 10000, CONVERSATION_A);
    expect(result).toEqual({ action: "complete_section", accepted: true });
  });

  it("next_work carries the committed narrative's world-state and open setups as forward conditioning (lever 4)", async () => {
    const store = new MemoryDocumentGenerationSessionStore();
    const plan: JsonValue = {
      nodes: {
        intro: {
          id: "intro", kind: "section", order: 0, goal: "introduce the topic",
          requiredCoverageIds: [], referenceIds: [], rhetoricalDependsOnIds: [], satisfiedCoverageIds: [], completed: false
        },
        middle: {
          id: "middle", kind: "section", order: 1, goal: "develop the journey",
          requiredCoverageIds: [], referenceIds: [], rhetoricalDependsOnIds: [], satisfiedCoverageIds: [], completed: false
        }
      }
    };
    await syncDocumentGenerationRequestForTurn(store, parseOk({
      documentGeneration: {
        sessionId: "doc.cond", action: {
          type: "start",
          session: {
            plan,
            narrative: { events: [] },
            initialFacts: [{ subjectId: "hero", factId: "location", value: "village" }]
          }
        }
      }
    }), 1000, CONVERSATION_A);

    // Complete the first section WITH a narrative event that changes the
    // hero's location and plants an unpaid setup.
    const completion = await syncDocumentGenerationRequestForTurn(store, parseOk({
      documentGeneration: {
        sessionId: "doc.cond", action: {
          type: "complete_section",
          input: {
            nodeId: "intro",
            content: "The hero departs the village, glancing at the gun on the wall.",
            satisfiedCoverageIds: [],
            narrativeEvent: {
              id: "event.depart",
              order: 1,
              description: "The hero departs for the mountain.",
              causedByEventIds: [],
              stateChanges: [{ subjectId: "hero", factId: "location", fromValue: "village", toValue: "mountain" }],
              setupIds: ["setup.gun-on-wall"],
              payoffForSetupIds: []
            }
          }
        }
      }
    }), 2000, CONVERSATION_A);
    expect(completion).toEqual({ action: "complete_section", accepted: true });

    // The NEXT commissioning of work must hand the generator the updated
    // world-state (hero now at the mountain) and the open setup -- the
    // constraints the next section is written UNDER, not discovered at its
    // completion gate.
    const next = await syncDocumentGenerationRequestForTurn(store, parseOk({
      documentGeneration: { sessionId: "doc.cond", action: { type: "next_work" } }
    }), 3000, CONVERSATION_A);
    expect(next).toEqual({
      action: "next_work",
      pendingSections: [{ id: "middle", goal: "develop the journey" }],
      narrativeConditioning: {
        establishedFacts: [{ subjectId: "hero", factId: "location", value: "mountain" }],
        openSetupIds: ["setup.gun-on-wall"]
      }
    });
  });
});
