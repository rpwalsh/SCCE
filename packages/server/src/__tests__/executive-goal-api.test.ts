// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeBuildTestAdapter, runLocalExecutiveGoal, type ScceRuntimeConfig, type LocalExecutiveGoalRequest } from "@scce/adapters-node";
import { ApprovalSession } from "../../../adapters-node/src/approval-session.js";
import { createDurableExecutiveEpisode, createExecutiveEpisodeMachine, createHasher, createRuntimeCapabilities, createConnectorCapabilityOperations, createCapabilityRegistry, DEFAULT_POLICY, toJsonValue, type ConstructGraph, type ExecutiveEvent } from "@scce/kernel";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { handleRequest, type ApiContext } from "../routes.js";

describe("local executive goal HTTP lane", () => {
  it("requires existing session consent before executing a real local program and replays its stable episode", async () => {
    const root = await mkdtemp(join(tmpdir(), "scce-goal-api-"));
    const effect = join(root, "effect.txt");
    const events: ExecutiveEvent[] = [];
    const executive = createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(createHasher()), maxConflictRetries: 1, journal: {
      read: async episodeId => ({ episodeId, revision: events.length, events: structuredClone(events) }),
      append: async input => { if (events.some(event => event.commandId === input.commandId)) return { status: "duplicate", revision: events.length }; if (events.length !== input.expectedRevision) return { status: "conflict", revision: events.length }; events.push(...input.events); return { status: "appended", revision: events.length }; }
    } });
    let approvals = new ApprovalSession();
    const buildTest = new NodeBuildTestAdapter({ runtime: { tempRoot: join(root, "runs") } } as ScceRuntimeConfig);
    const { blobs } = capabilityRuntimeFixture();
    const capabilities = createRuntimeCapabilities({ executive, blobs,
      operations: createConnectorCapabilityOperations({ buildTest, blobs, capabilities: createCapabilityRegistry({ process: true }).all() }) });
    const content = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(effect)},'once');`;
    const artifact = { artifactId: "artifact.local", path: "main.mjs", content, contentHash: `sha256_${createHasher().digestHex(content)}`, mediaType: "text/javascript", role: "source" };
    const request: LocalExecutiveGoalRequest = { schema: "scce.local_executive_goal.v1", episodeId: "episode.api.local", goalId: "goal.api.local", tasks: [{ id: "task.local", dependencyTaskIds: [], construct: { id: "construct.local", artifacts: [artifact], program: { id: "program.local", files: [artifact], nodes: [], edges: [], language: "javascript", packageManager: "node", entrypoint: "main.mjs", build: { command: process.execPath, args: ["--check", "main.mjs"], cwd: "." }, test: { command: process.execPath, args: ["main.mjs"], cwd: "." } } } as unknown as ConstructGraph }] };
    const context = { runtime: { approvals, executive, capabilities, runExecutiveGoal: (request: LocalExecutiveGoalRequest) => runLocalExecutiveGoal({ request, capabilities, ownerId: "owner", policy: DEFAULT_POLICY, approved: approvals.isApproved({ capabilityId: "process.build_test", input: toJsonValue(request) }) }) },
      config: { server: { url: "http://127.0.0.1:0" } }, maxBodyBytes: 1_000_000, startupReadiness: { snapshot: () => ({ phase: "ready", complete: true }) } } as unknown as ApiContext;
    const server = createServer((req, res) => { void handleRequest(req, res, context); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no local test listener");
    const url = `http://127.0.0.1:${address.port}`;
    const run = () => fetch(`${url}/api/executive/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    try {
      const pending = await run();
      expect(pending.status, await pending.text()).toBe(202);
      await expect(readFile(effect)).rejects.toMatchObject({ code: "ENOENT" });
      const plan = approvals.snapshot().pending[0]!;
      await fetch(`${url}/api/session/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.planId }) });
      const executed = await run();
      expect(executed.status).toBe(200);
      expect((await executed.json()).disposition).toBe("succeeded");
      approvals = new ApprovalSession();
      context.runtime.approvals = approvals;
      expect((await run()).status).toBe(200);
      expect(await readFile(effect, "utf8")).toBe("once");
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("cleanup escaped temporary root");
      await rm(root, { recursive: true, force: true });
    }
  });
});
