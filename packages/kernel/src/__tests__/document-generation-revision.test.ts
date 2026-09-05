// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { DocumentGenerationSessionStore } from "../storage.js";
import type { JsonValue } from "../types.js";
import {
  documentGenerationRequestFromMetadata,
  syncDocumentGenerationRequestForTurn
} from "../document-generation-turn-request.js";

function memoryStore(initial: { id: string; conversationId: string; sessionJson: JsonValue; updatedAt: number }): DocumentGenerationSessionStore {
  let row = { ...initial };
  return {
    async getSession(id, conversationId) {
      return id === row.id && conversationId === row.conversationId ? { ...row } : null;
    },
    async compareAndPutSession(next, expectedUpdatedAt) {
      if (expectedUpdatedAt !== null && expectedUpdatedAt !== row.updatedAt) return { stored: false };
      row = { ...row, sessionJson: next.sessionJson, updatedAt: next.updatedAt };
      return { stored: true };
    }
  } as unknown as DocumentGenerationSessionStore;
}

const sessionJson = {
  plan: {
    nodes: {
      "node.intro": {
        id: "node.intro",
        kind: "section",
        goal: "open the document",
        order: 1,
        content: "first draft",
        completed: false,
        requiredCoverageIds: [],
        referenceIds: [],
        rhetoricalDependsOnIds: [],
        satisfiedCoverageIds: []
      }
    }
  },
  narrative: { events: [] },
  initialFacts: [],
  protectedPassages: []
} as unknown as JsonValue;

describe("document revision from a turn", () => {
  it("rewrites a section, returns the inverse patch, and undoing it restores the original content", async () => {
    const store = memoryStore({ id: "doc.1", conversationId: "conversation.1", sessionJson, updatedAt: 1 });

    const parsedRevise = documentGenerationRequestFromMetadata({
      documentGeneration: { sessionId: "doc.1", action: { type: "revise", revision: { kind: "rewrite", nodeId: "node.intro", content: "second draft" } } }
    } as unknown as JsonValue);
    expect(parsedRevise.status).toBe("ok");
    if (parsedRevise.status !== "ok") return;

    const revised = await syncDocumentGenerationRequestForTurn(store, parsedRevise.request, 2, "conversation.1");
    expect(revised).toMatchObject({ action: "revise", accepted: true });
    if (!revised || !("undoPatch" in revised)) throw new Error("expected an undo patch");
    const stored = await store.getSession("doc.1", "conversation.1");
    expect(JSON.stringify(stored?.sessionJson)).toContain("second draft");

    const parsedUndo = documentGenerationRequestFromMetadata({
      documentGeneration: { sessionId: "doc.1", action: { type: "undo", patch: revised.undoPatch as unknown as JsonValue } }
    } as unknown as JsonValue);
    expect(parsedUndo.status).toBe("ok");
    if (parsedUndo.status !== "ok") return;

    const undone = await syncDocumentGenerationRequestForTurn(store, parsedUndo.request, 3, "conversation.1");
    expect(undone).toEqual({ action: "undo", accepted: true });
    const restored = await store.getSession("doc.1", "conversation.1");
    expect(JSON.stringify(restored?.sessionJson)).toContain("first draft");
    expect(JSON.stringify(restored?.sessionJson)).not.toContain("second draft");
  });

  it("reports an impossible revision rather than writing a broken plan", async () => {
    const store = memoryStore({ id: "doc.1", conversationId: "conversation.1", sessionJson, updatedAt: 1 });
    const parsed = documentGenerationRequestFromMetadata({
      documentGeneration: { sessionId: "doc.1", action: { type: "revise", revision: { kind: "delete", nodeId: "node.missing" } } }
    } as unknown as JsonValue);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;

    const result = await syncDocumentGenerationRequestForTurn(store, parsed.request, 2, "conversation.1");
    expect(result).toMatchObject({ action: "revise", accepted: false });
    const stored = await store.getSession("doc.1", "conversation.1");
    expect(stored?.updatedAt).toBe(1);
  });

  it("rejects a revision request that does not name what to change", () => {
    expect(documentGenerationRequestFromMetadata({
      documentGeneration: { sessionId: "doc.1", action: { type: "revise", revision: { kind: "rewrite" } } }
    } as unknown as JsonValue).status).toBe("malformed");
  });
});
