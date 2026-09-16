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

import { RUNTIME_WITHHELD_REASON_IDS, RUNTIME_WITHHELD_SURFACE_SCHEMA, withheldSurfaceForTurn, type TurnResult } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("a withheld turn survives transport as typed data, not as an error string", () => {
  it("returns 422 carrying the kernel's own withheld record on the non-streaming turn endpoint", async () => {
    const port = await fixtureServer(withheldTurn());
    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "thanks", sessionId: "session.fixture" })
    });

    expect(response.status).toBe(422);
    const body = await response.json() as { detail?: Record<string, unknown> };
    expect(body.detail?.schema).toBe(RUNTIME_WITHHELD_SURFACE_SCHEMA);
    expect(body.detail?.reasonId).toBe(RUNTIME_WITHHELD_REASON_IDS.noAdmittedEvidence);
    expect(body.detail?.evidenceCount).toBe(0);
  });

  it("carries the same record on the streaming turn path instead of collapsing it to a message", async () => {
    const port = await fixtureServer(withheldTurn());
    const response = await fetch(`http://127.0.0.1:${port}/api/turn?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ text: "thanks", sessionId: "session.fixture" })
    });

    expect(response.status).toBe(200);
    const frames = (await response.text()).split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    const terminal = frames.reverse().find(frame => frame.type === "error" || frame.type === "result");
    expect(terminal).toBeDefined();
    expect(terminal?.status).toBe(422);
    const detail = terminal?.detail as Record<string, unknown> | undefined;
    expect(detail?.schema).toBe(RUNTIME_WITHHELD_SURFACE_SCHEMA);
    expect(detail?.reasonId).toBe(RUNTIME_WITHHELD_REASON_IDS.noAdmittedEvidence);
  });

  it("does not attach that schema to a runtime failure, so the two are never conflated", async () => {
    const port = await fixtureServer(null);
    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "thanks", sessionId: "session.fixture" })
    });

    expect(response.status).toBe(500);
    const body = await response.json() as { detail?: Record<string, unknown> };
    expect(body.detail?.schema).not.toBe(RUNTIME_WITHHELD_SURFACE_SCHEMA);
  });

  it("does not attach that schema to an unknown request either", async () => {
    const port = await fixtureServer(withheldTurn());
    const response = await fetch(`http://127.0.0.1:${port}/api/turn/nothing/here`, { method: "POST" });
    expect(response.status).toBe(404);
    const body = await response.json() as { detail?: Record<string, unknown> };
    expect(body.detail?.schema).not.toBe(RUNTIME_WITHHELD_SURFACE_SCHEMA);
  });
});

/** A turn the kernel itself declared speechless: the withheld record is the kernel's, not the fixture's. */
function withheldTurn(): TurnResult {
  const result = {
    answer: "",
    evidence: [],
    learningNeeds: [],
    epistemicForce: "insufficient_support",
    entailment: { verdict: "unsupported" },
    constructGraph: {},
    episodeId: "episode.fixture"
  } as unknown as TurnResult;
  const withheld = withheldSurfaceForTurn(result);
  if (!withheld) throw new Error("fixture turn was not withheld");
  return { ...result, withheld };
}

async function fixtureServer(result: TurnResult | null): Promise<number> {
  const context = {
    maxBodyBytes: 1_000_000,
    runtime: {
      storage: {
        evidence: { sourceIdentityArbitration: async () => ({ identities: [], spread: new Map<string, number>() }) },
        conversation: { listTurns: async () => [] },
        dialogueMemory: { listStyleSnapshots: async () => [], listInteractionStates: async () => [] }
      },
      kernel: {
        turn: async () => {
          if (!result) throw new Error("fixture runtime failure");
          return result;
        }
      }
    },
    config: { server: { url: "http://127.0.0.1:3873" } },
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
  return address.port;
}
