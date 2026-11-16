// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@scce/adapters-node", async original => ({ ...await original<typeof import("@scce/adapters-node")>(),
  assertHydratedRuntimeReady: vi.fn(async () => ({ activeBrainVersion: "brain.fixture", activeImportRunIds: [] })) }));
import { createInMemoryDialogueMemoryStore, createPatchTransactionPlan, hashPatchContent, type ConversationTurnRecord, type ExecutiveEpisodeId, type OwnerInput, type TurnResult } from "@scce/kernel";
import { trustedHostPatchValidationProvider, type StructuredPatchValidationProvider, type WorkspaceCodingPatchPlanningInput, type WorkspaceCodingPatchPlanningResult } from "@scce/adapters-node";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { bindHttpTurnCancellation } from "../http-turn-cancellation.js";
import { handleRequest, drainDeferredDialoguePersistence, executeWorkspaceCodingTurnPlan, executeWorkspacePatchApiRequest, WORKSPACE_PATCH_REQUEST_SCHEMA, type ApiContext } from "../routes.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

it("distinguishes request-body close from abort and removes all owned listeners", () => {
  const req = Object.assign(new EventEmitter(), { aborted: false }), res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const scope = bindHttpTurnCancellation(req as IncomingMessage, res as ServerResponse);
  req.emit("close"); expect(scope.signal.aborted).toBe(false);
  res.emit("close"); expect(scope.signal.aborted).toBe(true);
  scope.dispose(); expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
});

it("does not cancel after a normally finished response", () => {
  const req = Object.assign(new EventEmitter(), { aborted: false }), res = Object.assign(new EventEmitter(), { writableFinished: true, destroyed: false });
  const scope = bindHttpTurnCancellation(req as IncomingMessage, res as ServerResponse);
  res.emit("close"); expect(scope.signal.aborted).toBe(false); scope.dispose();
});

function contextFor(turn: (input: OwnerInput) => Promise<TurnResult>, memory = createInMemoryDialogueMemoryStore(), turns: ConversationTurnRecord[] = []): ApiContext {
  return { maxBodyBytes: 1000000, runtime: { kernel: { turn }, storage: { dialogueMemory: memory,
    conversation: { listTurns: async () => [], putTurn: async (row: ConversationTurnRecord) => { turns.push(row); } } } },
    config: {}, startupReadiness: { snapshot: () => ({ phase: "running", ok: false, complete: false }) } } as unknown as ApiContext;
}
const observeResponseWrites = (response: ServerResponse) => vi.spyOn(response, "writeHead");
async function listen(context: ApiContext) {
  const done = deferred(), writes: Array<ReturnType<typeof observeResponseWrites>> = [];
  const server = createServer((req, res) => { writes.push(observeResponseWrites(res)); void handleRequest(req, res, context).finally(done.resolve); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address absent");
  const send = (body: object) => { const client = request({ hostname: "127.0.0.1", port: address.port, path: "/api/turn", method: "POST", headers: { "content-type": "application/json" } });
    client.on("error", () => {}); client.end(JSON.stringify(body)); return client; };
  return { done, writes, send };
}

it("wires ordinary HTTP disconnect into the real runtime-control boundary without writing to its closed response", async () => {
  const entered = deferred(), release = deferred(); let signal: AbortSignal | undefined, nextStage = 0;
  const f = await listen(contextFor(async input => { signal = input.runtimeControl?.signal; entered.resolve(); await release.promise;
    signal?.throwIfAborted(); nextStage++; throw Error("unexpected next stage"); }));
  const client = f.send({ text: "opaque fixture request", runtimeControl: { signal: "untrusted JSON" } });
  await entered.promise; expect(signal).toBeInstanceOf(AbortSignal); expect(signal?.aborted).toBe(false);
  client.destroy(); await vi.waitFor(() => expect(signal?.aborted).toBe(true)); release.resolve(); await f.done.promise;
  expect(nextStage).toBe(0); expect(f.writes[0]?.mock.calls).toHaveLength(0);
});

it("keeps ordinary completed request-body close from aborting the kernel", async () => {
  let signal: AbortSignal | undefined;
  const f = await listen(contextFor(async input => { signal = input.runtimeControl?.signal; expect(signal?.aborted).toBe(false); throw Error("fixture.completed"); }));
  const client = f.send({ text: "opaque fixture request" });
  const status = await new Promise<number | undefined>(resolve => client.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }));
  await f.done.promise; expect(status).toBe(500); expect(signal?.aborted).toBe(false);
});

it("finishes the committed kernel result's session persistence after the client closes during finalization", async () => {
  const memory = createInMemoryDialogueMemoryStore(), calibrationEntered = deferred(), release = deferred(), turns: ConversationTurnRecord[] = [];
  const read = memory.listCalibrationObservations.bind(memory); let completed = false, signal: AbortSignal | undefined;
  memory.listCalibrationObservations = async query => { if (completed) { calibrationEntered.resolve(); await release.promise; } return read(query); };
  const result = { episodeId: "episode.completed.fixture", answer: "completed fixture result", epistemicForce: "uncertain", evidence: [], events: [], learningNeeds: [],
    entailment: { verdict: "underdetermined", contradiction: 0, proof: { evidenceIds: [] } }, constructGraph: { artifacts: [], nodes: [], edges: [] },
    emissionGraph: { artifacts: [] } } as unknown as TurnResult;
  const f = await listen(contextFor(async input => { signal = input.runtimeControl?.signal; completed = true; return result; }, memory, turns));
  const client = f.send({ text: "owned completed request", sessionId: "session.completed.fixture" });
  await calibrationEntered.promise; client.destroy(); await vi.waitFor(() => expect(signal?.aborted).toBe(true)); release.resolve();
  await f.done.promise; await drainDeferredDialoguePersistence();
  expect(turns.map(row => row.text)).toEqual(["owned completed request", result.answer]);
  expect(f.writes[0]?.mock.calls).toHaveLength(0);
});

it.each(["before_dispatch", "during_root_resolution", "during_preparation", "during_validation"] as const)("respects workspace transaction dispatch at %s", async phase => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-cancel-workspace-")), controller = new AbortController();
  const entered = deferred(), release = deferred(), durable = capabilityRuntimeFixture(); let providerCalls = 0;
  const executive = durable.executive(); let executiveEpisodeId: ExecutiveEpisodeId | undefined;
  const guardedExecutive: typeof executive = { ...executive, async dispatchClaim(command) {
    const result = await executive.dispatchClaim(command); executiveEpisodeId = command.episodeId;
    if (phase === "during_preparation") { entered.resolve(); await release.promise; }
    return result;
  } };
  try {
    await writeFile(path.join(root, "value.txt"), "before");
    const plan = createPatchTransactionPlan({ operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }] });
    // The existing compiler handoff fixture contract; the plan hash is computed from the actual owned mutation.
    const result = { statusId: "scce.workspace.compiler_patch.selected.v1", plan,
      selection: { selected: { patchPlan: plan, execution: { state: "not_executed" } } },
      authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
      execution: { state: "not_executed", receipt: null } } as unknown as WorkspaceCodingPatchPlanningResult;
    const policy = { schemaVersion: "scce.patch-validation-policy.v1" as const, id: "owned-cancel-validation.v1",
      commands: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }], timeoutMs: 5000,
      maxOutputBytes: 16384, maxWorkspaceFiles: 10, maxWorkspaceBytes: 1048576 };
    const workspace = { id: "workspace.cancel.fixture", rootPath: root };
    const context = { config: { policy: { allowMutation: true }, runtime: { allowedRoots: [root], tools: {} } },
      runtime: { executive: guardedExecutive, storage: { workspace: { async latestWorkspace() {
        if (phase === "before_dispatch") { entered.resolve(); await release.promise; } return workspace;
      } } }, approvals: { isApproved: () => true } },
      patchValidation: { resolvePolicy: () => policy, provider: { ...trustedHostPatchValidationProvider, async execute(input: Parameters<StructuredPatchValidationProvider["execute"]>[0]) {
        providerCalls++; entered.resolve(); await release.promise;
        return trustedHostPatchValidationProvider.execute(input);
      } } } } as unknown as ApiContext;
    const input: WorkspaceCodingPatchPlanningInput = { workspaceId: workspace.id, expectedWorkspaceUpdatedAt: 1,
      requestId: "request.cancel.fixture", requestText: "Apply the owned workspace fixture change", requestedPaths: ["value.txt"],
      validationPlan: { validatorId: policy.id, checks: ["tests"] } };
    if (phase === "during_root_resolution") {
      const pending = executeWorkspacePatchApiRequest({ request: { schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
        workspaceId: workspace.id, plan, validationPolicyId: policy.id }, workspace, allowedRoots: [root], policy,
        provider: context.patchValidation!.provider, executive: guardedExecutive, signal: controller.signal });
      // This call has entered the first realpath await; cancellation precedes any durable dispatch or transaction.
      controller.abort(Error("client disconnected"));
      await expect(pending).rejects.toThrow("workspace.request.cancelled_before_dispatch");
      expect(executiveEpisodeId).toBeUndefined(); expect(providerCalls).toBe(0);
      expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before");
      return;
    }
    const pending = executeWorkspaceCodingTurnPlan(context, input, result, controller.signal);
    await entered.promise; controller.abort(Error("client disconnected")); release.resolve();
    const execution = await pending;
    if (phase === "before_dispatch" || phase === "during_preparation") {
      expect(execution).toEqual({ state: "not_executable", reason: "workspace.request.cancelled_before_dispatch" });
      expect(providerCalls).toBe(0); expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("before");
      if (phase === "during_preparation") {
        expect(executiveEpisodeId).toBeDefined();
        const state = await executive.load(executiveEpisodeId!);
        expect(Object.values(state.receipts).map(row => row.status)).toEqual(["failed"]);
        expect(Object.values(state.receipts)[0]?.attestationRef).toBe(`workspace.patch.cancelled_before_dispatch.${plan.planHash}`);
        expect(Object.values(state.tasks).map(row => row.status)).toEqual(["failed"]);
      }
    } else {
      expect(execution.state).toBe("applied"); expect(providerCalls).toBe(1);
      if (execution.state !== "applied") throw Error("owned transaction did not complete");
      expect(execution.receipt.planHash).toBe(plan.planHash);
      expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after");
      expect(executiveEpisodeId).toBeDefined();
      const state = await executive.load(executiveEpisodeId!);
      expect(Object.values(state.receipts).map(row => row.status)).toEqual(["succeeded"]);
    }
  } finally {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("scce-cancel-workspace-")) throw Error("invalid cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});
