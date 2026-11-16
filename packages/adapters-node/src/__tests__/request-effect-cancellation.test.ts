// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ConnectorPolicyGate } from "../connector-policy.js";
import { connectorConfigForRuntime } from "../connector-governance-bridge.js";
import { runProcess } from "../document.js";
import type { ScceRuntimeConfig } from "../config.js";
import { createRuntimeCapabilities, invokeRuntimeCapabilityPlan } from "../../../kernel/src/capability-runtime.js";
import { createCapabilityRegistry } from "../../../kernel/src/safety.js";
import { createHasher, canonicalStringify } from "../../../kernel/src/primitives.js";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";

const config = () => ({ policy: { allowMutation: true, requireTwoPhaseCommit: false, dryRunByDefault: false, maxNetworkRequests: 2,
  maxToolCalls: 2, maxSpendCents: 100, alphaRiskCeiling: 1, encryptSecretsAtRest: false },
  connectors: { web: { enabled: true, allowedHosts: ["example.com"], maxBytes: 8 } } } as unknown as ScceRuntimeConfig);

it("lets one dispatched write settle through the real signal mask and persists its receipt before stopping the next step", async () => {
  const gate = new ConnectorPolicyGate(config()), controller = new AbortController(), durable = capabilityRuntimeFixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pendingWrite = new Promise<void>(resolve => { release = resolve; });
  const capability = createCapabilityRegistry({ outlook: true }).all().find(row => row.id === "outlook.send_mail")!, effects: string[] = [];
  const capabilities = createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
    requestSignal: () => gate.requestSignal(), withDispatchedEffect: operation => gate.withRequestCancellationMasked(operation),
    operations: [{ capability, phase: "commit", inputSchema: {}, validate() {}, async execute(payload) {
      effects.push(String((payload as { step: string }).step)); expect(gate.requestSignal()).toBeUndefined(); enter();
      await pendingWrite; expect(gate.requestSignal()).toBeUndefined(); return { committed: true };
    } }] });
  const steps = ["first", "second"].map((id, i) => ({ id, capabilityId: capability.id, payload: { step: id }, dependencyStepIds: i ? ["first"] : [] }));
  await gate.withRequestBudget(async () => {
    const pending = invokeRuntimeCapabilityPlan({ capabilities, episodeId: "episode.mask", goalId: "goal.mask", ownerId: "owner.fixture",
      policyVersionId: "policy.fixture", maxDispatches: 2, steps,
      approvals: steps.map(step => ({ taskId: step.id, inputRef: createHasher().digestHex(canonicalStringify(step.payload)) })) });
    await entered; controller.abort(Error("client disconnected")); release();
    const result = await pending;
    expect(result.disposition).toBe("cancelled"); expect(effects).toEqual(["first"]); expect(gate.requestSignal()).toBe(controller.signal);
    const state = await durable.executive().load("episode.mask");
    expect(Object.values(state.receipts).map(row => row.status)).toEqual(["succeeded"]);
    expect(Object.values(state.attempts).some(row => row.taskId === "second")).toBe(false);
  }, controller.signal);
});

it("masks only the dispatched scope's request signal while retaining the original call and byte budgets", async () => {
  const cfg = config(), gate = new ConnectorPolicyGate(cfg), controller = new AbortController();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);
  try { await gate.withRequestBudget(async () => {
    expect(gate.requestSignal()).toBe(controller.signal);
    gate.begin({ connector: "web", operation: "fetch", uri: "https://example.com/first" });
    await gate.withRequestCancellationMasked(async () => {
      controller.abort(Error("client disconnected")); expect(gate.requestSignal()).toBeUndefined();
      await Promise.resolve();
      vi.setSystemTime(60001);
      gate.begin({ connector: "web", operation: "fetch", uri: "https://example.com/second" });
      expect(gate.snapshot().usedNetworkRequests).toBe(2);
    });
    expect(gate.requestSignal()).toBe(controller.signal); expect(gate.snapshot().usedNetworkRequests).toBe(2);
    expect(() => gate.begin({ connector: "web", operation: "fetch", uri: "https://example.com/third" })).toThrow(/quota/u);
    expect(connectorConfigForRuntime(cfg, "web", cfg.policy).limits.maxBytesPerResponse).toBe(8);
  }, controller.signal); } finally { vi.useRealTimers(); }
});

it("ends the mask when its operation settles even for an async descendant that outlives it", async () => {
  const gate = new ConnectorPolicyGate(config()), controller = new AbortController(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); let descendant!: Promise<AbortSignal | undefined>;
  await gate.withRequestBudget(async () => {
    await gate.withRequestCancellationMasked(async () => { descendant = (async () => { await barrier; return gate.requestSignal(); })(); });
    controller.abort(Error("client disconnected")); release();
    expect(await descendant).toBe(controller.signal);
  }, controller.signal);
});

it("retains independent operation time and output-byte limits inside the protected effect scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-cancel-effect-")), gate = new ConnectorPolicyGate(config()), controller = new AbortController();
  try {
    await gate.withRequestBudget(async () => gate.withRequestCancellationMasked(async () => {
      controller.abort(Error("client disconnected"));
      const timed = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 40, signal: gate.requestSignal() });
      expect(timed.stderr).toBe("document extraction timed out");
      const bounded = await runProcess(process.execPath, ["-e", "process.stdout.write('owned-fixture-output');setInterval(()=>{},1000)"],
        { cwd: root, timeoutMs: 3000, maxOutputBytes: 8, signal: gate.requestSignal() });
      expect(bounded.stderr).toBe("document extraction exceeded output byte limit");
    }), controller.signal);
  } finally {
    const target = path.resolve(root); if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("scce-cancel-effect-")) throw Error("invalid cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});
