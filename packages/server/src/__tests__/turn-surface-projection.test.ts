// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@scce/adapters-node", async importOriginal => {
  const actual = await importOriginal<typeof import("@scce/adapters-node")>();
  return {
    ...actual,
    assertHydratedRuntimeReady: vi.fn(async () => ({ activeBrainVersion: "brain.fixture.v1", activeImportRunIds: [] }))
  };
});

import { handleRequest, type ApiContext } from "../routes.js";
import { turnTaskRegistryFor } from "../turn-task-registry.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function memoryStorage(): never {
  return { events: { append: async () => {}, readEpisode: async () => [] } } as never;
}

async function listeningServer(context: ApiContext): Promise<string> {
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
  return `http://127.0.0.1:${address.port}`;
}

describe("turn surface projection", () => {
  it("renders a completed turn task as surface state a client can draw without re-deriving it", async () => {
    const storage = memoryStorage();
    const registry = turnTaskRegistryFor(storage);
    const task = registry.create({ requestId: "request.fixture.surface" });
    registry.append(task.taskId, {
      type: "result",
      value: {
        answer: "Ada Lovelace wrote the first published algorithm.",
        episodeId: "episode.fixture.surface",
        entailment: { force: "assert" },
        evidence: [{ id: "evidence.1", textPreview: "the first published algorithm", alpha: 0.91, status: "admitted" }],
        events: [{ id: "event.1", typeId: "TurnStarted", payload: { text: "who wrote it" } }]
      }
    });

    const origin = await listeningServer({
      runtime: { storage },
      config: { server: { url: "http://127.0.0.1:8787" } },
      startupReadiness: { snapshot: () => ({ phase: "running", ok: true, complete: true }) }
    } as unknown as ApiContext);

    const response = await fetch(`${origin}/api/turn/task/${encodeURIComponent(task.taskId)}/surface`);
    expect(response.status).toBe(200);
    const surface = await response.json() as {
      serverUrl: string;
      trace: unknown[];
      panes: { id: string; items: { label: string }[] }[];
      status: { episodeId?: string; force?: string; requestInFlight: boolean };
    };
    expect(surface.serverUrl).toBe("http://127.0.0.1:8787");
    expect(surface.trace).toHaveLength(1);
    expect(surface.status.episodeId).toBe("episode.fixture.surface");
    expect(surface.status.force).toBe("assert");
    expect(surface.status.requestInFlight).toBe(false);
    const source = surface.panes.find(pane => pane.id === "source");
    expect(source?.items.some(item => item.label.includes("the first published algorithm"))).toBe(true);
  });

  it("reports a task with no result frame rather than inventing an empty surface", async () => {
    const storage = memoryStorage();
    const registry = turnTaskRegistryFor(storage);
    const task = registry.create({ requestId: "request.fixture.failing" });
    registry.append(task.taskId, { type: "error", error: "turn failed" });

    const origin = await listeningServer({
      runtime: { storage },
      config: { server: { url: "http://127.0.0.1:8787" } },
      startupReadiness: { snapshot: () => ({ phase: "running", ok: true, complete: true }) }
    } as unknown as ApiContext);

    const response = await fetch(`${origin}/api/turn/task/${encodeURIComponent(task.taskId)}/surface`);
    expect(response.status).toBe(409);
  });
});
