// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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

import { clearCorpusIdentitySignals, primeCorpusIdentitySignals, type OwnerInput } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

// The corpus the fixture arbitration is titled with.
const TITLES = ["abba", "albert einstein", "서울"];
// The closed class a warm process carries from the previous turn's priming.
const CLOSED_CLASS = new Set(["who", "is", "what", "did", "he", "win", "when", "were", "they", "the", "of"]);

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  clearCorpusIdentitySignals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("session evidence carry is decided by what the corpus measures the request to name", () => {
  it("does not inherit the previous subject's evidence for a lowercase request naming a corpus subject", async () => {
    const turn = await capturedTurn({
      text: "who is albert einstein",
      staleIdentities: ["abba"],
      carrierEvidenceIds: ["evidence:abba-refs"]
    });

    expect(turn.runtimeEvidenceIds).not.toContain("evidence:abba-refs");
    expect(turn.runtimeEvidenceIds).toEqual([]);
    expect(turn.sessionContextEvidence).toBe(false);
    expect(turn.metadata).not.toHaveProperty("discourse");
  });

  it("does not inherit for a short lowercase request whose letters the old surface rule counted as weak", async () => {
    const turn = await capturedTurn({
      text: "who is abba",
      staleIdentities: ["albert einstein"],
      carrierEvidenceIds: ["evidence:einstein"]
    });

    expect(turn.runtimeEvidenceIds).toEqual([]);
    expect(turn.sessionContextEvidence).toBe(false);
  });

  it("still inherits the conversation's evidence for an anaphoric follow-up that names no subject", async () => {
    const turn = await capturedTurn({
      text: "what did he win",
      staleIdentities: ["albert einstein"],
      carrierEvidenceIds: ["evidence:einstein"]
    });

    expect(turn.runtimeEvidenceIds).toContain("evidence:einstein");
    expect(turn.sessionContextEvidence).toBe(true);
    expect(turn.metadata).toHaveProperty("discourse");
  });

  it("stands alone on an uncased script naming a corpus subject", async () => {
    const turn = await capturedTurn({
      text: "서울의",
      staleIdentities: ["abba"],
      carrierEvidenceIds: ["evidence:abba-refs"]
    });

    expect(turn.runtimeEvidenceIds).toEqual([]);
    expect(turn.sessionContextEvidence).toBe(false);
  });
});

async function capturedTurn(input: { text: string; staleIdentities: string[]; carrierEvidenceIds: string[] }) {
  // A warm process: the signal a server reads before the turn is the PREVIOUS request's identity set.
  primeCorpusIdentitySignals({
    closedClass: CLOSED_CLASS,
    identities: new Set(input.staleIdentities),
    spread: new Map(),
    concentration: 0
  });
  const captured: OwnerInput[] = [];
  const context = {
    maxBodyBytes: 1_000_000,
    runtime: {
      storage: {
        evidence: {
          // Shaped like the postgres arbitration: which of the corpus's own titles appear in this request.
          sourceIdentityArbitration: async ({ text }: { text: string }) => {
            const normalized = ` ${String(text).normalize("NFC").toLocaleLowerCase()} `;
            const unspaced = !normalized.trim().includes(" ");
            return {
              identities: TITLES.filter(title => normalized.includes(` ${title} `) || (unspaced && normalized.includes(title))),
              spread: new Map<string, number>()
            };
          }
        },
        conversation: {
          listTurns: async () => [
            {
              id: "turn.fixture.request",
              sessionId: "session.fixture",
              episodeId: "episode.fixture.request",
              turnIndex: 0,
              roleId: "session.role.owner",
              text: "tell me something",
              evidenceIds: [],
              metadata: { schema: "scce.conversation_turn.owner.v1" },
              createdAt: 1
            },
            {
              id: "turn.fixture.carrier",
              sessionId: "session.fixture",
              episodeId: "episode.fixture.carrier",
              turnIndex: 1,
              roleId: "session.role.assistant",
              text: "the carrier answer",
              evidenceIds: input.carrierEvidenceIds,
              metadata: { schema: "scce.conversation_turn.owner.v1" },
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
        turn: async (owner: OwnerInput) => {
          captured.push(owner);
          throw new Error("turn-session-evidence-carry-captured");
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
    body: JSON.stringify({ text: input.text, sessionId: "session.fixture" })
  });
  expect(response.status).toBe(500);
  expect(captured).toHaveLength(1);
  const metadata = captured[0]?.metadata as Record<string, unknown>;
  const runtime = metadata.runtime as Record<string, unknown>;
  return {
    metadata,
    runtimeEvidenceIds: metadata.runtimeEvidenceIds as string[],
    sessionContextEvidence: runtime.sessionContextEvidence === true
  };
}
