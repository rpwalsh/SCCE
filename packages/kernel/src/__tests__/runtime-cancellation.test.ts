// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createScceKernel } from "../kernel.js";
import { createHasher, canonicalStringify } from "../primitives.js";
import { createRuntimeCapabilities, invokeRuntimeCapability, invokeRuntimeCapabilityPlan, type CapabilityOperation } from "../capability-runtime.js";
import { createCapabilityRegistry } from "../safety.js";
import { capabilityRuntimeFixture } from "./fixtures/capability-runtime.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const kernelFor = (storage: ReturnType<typeof storageFixtureForEvaluation>["storage"]) => createScceKernel({ storage,
  files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw Error("unexpected execution"); } } });

it("rejects an already-cancelled turn before its first storage read", async () => {
  const f = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 }); let reads = 0;
  f.storage.languageMemory.readRevision = async () => { reads++; return "revision.fixture"; };
  const controller = new AbortController(), reason = Error("owner cancelled"); controller.abort(reason);
  await expect(kernelFor(f.storage).turn({ text: "opaque", runtimeControl: { signal: controller.signal } })).rejects.toBe(reason);
  expect(reads).toBe(0); expect(f.events).toHaveLength(0);
});

it("stops after an admitted read settles instead of starting the next cognition stage", async () => {
  const f = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 }), entered = deferred(), release = deferred(); let patternReads = 0;
  f.storage.languageMemory.readRevision = async () => { entered.resolve(); await release.promise; return "revision.fixture"; };
  f.storage.languageMemory.listLanguagePatterns = async () => { patternReads++; return []; };
  const controller = new AbortController(), reason = Error("owner cancelled");
  const pending = kernelFor(f.storage).turn({ text: "opaque", runtimeControl: { signal: controller.signal } });
  await entered.promise; controller.abort(reason); release.resolve();
  await expect(pending).rejects.toBe(reason); expect(patternReads).toBe(0); expect(f.events).toHaveLength(0);
});

const capability = () => createCapabilityRegistry({ outlook: true }).all().find(row => row.id === "outlook.send_mail")!;
const request = { episodeId: "episode.cancellation", taskId: "task.cancellation", ownerId: "owner.fixture", policyVersionId: "policy.fixture", approved: true };

it("checks cancellation after durable approval/dispatch awaits and before calling the executor", async () => {
  const durable = capabilityRuntimeFixture(), controller = new AbortController(), executive = durable.executive(); let effects = 0;
  const guarded: typeof executive = { ...executive, async dispatchClaim(command) {
    const result = await executive.dispatchClaim(command);
    controller.abort(Error("closed after intent"));
    return result;
  } };
  const capabilities = createRuntimeCapabilities({ executive: guarded, blobs: durable.blobs, operations: [{ capability: capability(), phase: "commit", inputSchema: {},
    validate() {}, execute: async () => { effects++; return { completed: true }; } }] });
  const result = await invokeRuntimeCapability({ ...request, capabilities, capabilityId: capability().id, payload: {}, signal: controller.signal });
  expect(effects).toBe(0); expect(result.disposition).toBe("failed");
  expect(result.observation?.cancelledBeforeExecution).toBe(true); expect(result.receipt?.status).toBe("failed");
  expect(Object.values((await durable.executive().load(request.episodeId)).receipts)).toHaveLength(1);
});

it("retains the completed effect and its receipt while cancelling the next goal dispatch", async () => {
  const durable = capabilityRuntimeFixture(), controller = new AbortController(), entered = deferred(), release = deferred(), effects: string[] = [];
  const operation: CapabilityOperation = { capability: capability(), phase: "commit", inputSchema: {}, validate() {}, async execute(payload) {
    effects.push(String((payload as { step: string }).step)); entered.resolve(); await release.promise; return { completed: true };
  } };
  const capabilities = createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs, operations: [operation] });
  const steps = ["first", "second"].map((id, i) => ({ id, capabilityId: capability().id, payload: { step: id }, dependencyStepIds: i ? ["first"] : [] }));
  const approvals = steps.map(step => ({ taskId: step.id, inputRef: createHasher().digestHex(canonicalStringify(step.payload)) }));
  const run = () => invokeRuntimeCapabilityPlan({ capabilities, episodeId: request.episodeId, goalId: "goal.fixture", ownerId: request.ownerId,
    policyVersionId: request.policyVersionId, maxDispatches: 2, steps, approvals, signal: controller.signal });
  const pending = run(); await entered.promise; controller.abort(Error("client closed during effect")); release.resolve();
  const result = await pending; expect(result.disposition).toBe("cancelled"); expect(effects).toEqual(["first"]);
  expect(result.observations).toHaveLength(1); expect(result.observations[0]?.observation.result).toEqual({ completed: true });
  const state = await durable.executive().load(request.episodeId);
  expect(state.tasks.first?.status).toBe("succeeded"); expect(Object.values(state.receipts).map(row => row.status)).toEqual(["succeeded"]);
  expect(Object.values(state.attempts).some(row => row.taskId === "second")).toBe(false);
  expect((await run()).observations).toEqual(result.observations); expect(effects).toEqual(["first"]);
});
