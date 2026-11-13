// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { executeBoundCapability } from "../bound-capability-runtime.js";
import { CAPABILITY_DEMONSTRATION_SCHEMA, capabilityBindingForRequest, compileCapabilityDemonstrations } from "../capability-construction.js";
import { createRuntimeCapabilities, type RuntimeCapabilityPlanStep } from "../capability-runtime.js";
import { createConnectorCapabilityOperations } from "../connector-capabilities.js";
import { createIdFactory } from "../ids.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import { createCapabilityRegistry, DEFAULT_POLICY } from "../safety.js";
import type { ApprovalPort, ConnectorPort, ScceStorage } from "../storage.js";
import type { CapabilityPlan, EvidenceSpan } from "../types.js";
import { capabilityRuntimeFixture } from "./fixtures/capability-runtime.js";

async function fixture(kind: "email" | "network" = "email", failure?: "partial" | "unknown") {
  const durable = capabilityRuntimeFixture();
  const hasher = createHasher();
  const effects: string[] = [];
  const steps: RuntimeCapabilityPlanStep[] = kind === "network" ? [
    { id: "first", capabilityId: "network.search", payload: { query: "topic", limit: 1 }, dependencyStepIds: [] },
    { id: "second", capabilityId: "network.search", payload: { query: "second", limit: 1 }, dependencyStepIds: ["first"] }
  ] : [
    { id: "draft", capabilityId: "outlook.create_draft", payload: { to: ["owner@example.invalid"], subject: "topic", body: "source body" }, dependencyStepIds: [] },
    { id: "send", capabilityId: "outlook.send_mail", payload: { messageId: null }, dependencyStepIds: ["draft"], resultBindings: [{ path: ["messageId"], predecessorTaskId: "draft", resultPath: ["id"], type: "string" }] },
    { id: "contacts", capabilityId: "outlook.read_contacts", payload: { query: "fixed" }, dependencyStepIds: [failure ? "draft" : "send"] }
  ];
  const sourceText = JSON.stringify({ schema: CAPABILITY_DEMONSTRATION_SCHEMA, examples: [{ request: "σ «topic»", steps,
    bindings: [{ path: ["steps", 0, "payload", kind === "network" ? "query" : "subject"], startCodePoint: 3, endCodePoint: 8 }] }] });
  const contentHash = await durable.blobs.put(new TextEncoder().encode(sourceText), "application/json");
  const evidence = [{ id: "evidence.bound", sourceId: "source.bound", sourceVersionId: "version.bound", contentHash, text: sourceText, status: "promoted" }] as unknown as EvidenceSpan[];
  const patterns = compileCapabilityDemonstrations({ sourceText, owner: { sourceId: evidence[0]!.sourceId, sourceVersionId: evidence[0]!.sourceVersionId, contentHash, profileId: "profile.bound" }, evidence, hasher, updatedAt: 1 });
  const storage = { blobs: durable.blobs, evidence: { getEvidenceBatch: async () => evidence }, languageMemory: { listLanguagePatterns: async () => patterns } } as unknown as ScceStorage;
  const requestText = "σ «fresh»";
  const binding = (await capabilityBindingForRequest({ storage, requestText }))!;
  const connectors = {
    search: async (query: string) => { effects.push(query); return [{ uri: `https://observed.invalid/${query}`, title: query, snippet: "" }]; },
    outlookCreateDraft: async (payload: { subject: string }) => {
      effects.push(`draft:${payload.subject}`);
      if (failure) throw Object.assign(new Error("provider acknowledgement missing"), failure === "partial" ? { messageId: "partial.draft" } : {});
      return { id: "observed.draft" };
    },
    outlookSendDraft: async (id: string) => { effects.push(`send:${id}`); return { id, sent: true }; },
    outlookReadContacts: async () => { effects.push("contacts"); return [{ id: "contact.1" }]; }
  } as unknown as ConnectorPort;
  const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
    operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ outlook: true, network: true }).all() }) });
  const pending = new Map<string, CapabilityPlan>();
  const approved = new Set<string>();
  const fingerprint = (input: { capabilityId: string; input: unknown; approvalScope?: unknown }) => canonicalStringify(input);
  const approvals: ApprovalPort = { isApproved: input => approved.has(fingerprint(input)), observePending(plan) {
    const permission = plan.permission as { allowed?: boolean; dryRun?: boolean };
    if (!permission.allowed || permission.dryRun) pending.set(String(plan.id), structuredClone(plan));
  } };
  const approve = (planId: string) => {
    const plan = pending.get(planId)!;
    approved.add(fingerprint({ capabilityId: plan.capabilityId, input: plan.input, approvalScope: plan.approvalScope }));
    pending.delete(planId);
  };
  const audit: CapabilityPlan[] = [];
  const now = () => 1;
  const run = (overrides: Partial<Parameters<typeof executeBoundCapability>[0]> = {}) => executeBoundCapability({ binding, requestText,
    operationId: "operation.bound", episodeId: "episode.audit" as CapabilityPlan["episodeId"], ownerId: "owner.bound", policyVersionId: "policy.bound",
    policy: { ...DEFAULT_POLICY, alphaRiskCeiling: 1, maxToolCalls: 10, maxNetworkRequests: 10 }, capabilities: restart(), approvals,
    audit: { putPlan: async plan => { audit.push(structuredClone(plan)); }, listByEpisode: async () => audit },
    idFactory: createIdFactory({ hasher, clock: { now }, deterministicReplay: true }), hasher, now, ...overrides });
  return { binding, requestText, run, effects, pending, approved, approvals, approve, audit,
    rebind: (requestText: string) => capabilityBindingForRequest({ storage, requestText }) };
}

describe("source-bound action policy and durable execution", () => {
  it("requires each concrete approval, replays cold observations, and rejects changed inputs under an operation identity", async () => {
    const f = await fixture();
    const draft = await f.run();
    expect(draft.report.disposition).toBe("not_ready");
    expect(f.effects).toEqual([]);
    const pendingDraft = [...f.pending.values()][0]!;
    expect(pendingDraft.approvalScope?.taskId).toBe("draft");
    f.approve(String(pendingDraft.id));
    const send = await f.run();
    expect(f.effects).toEqual(["draft:fresh"]);
    const pendingSend = [...f.pending.values()][0]!;
    expect(pendingSend.input).toEqual({ messageId: "observed.draft" });
    expect(pendingSend.approvalScope?.inputRef).toBe(createHasher().digestHex(canonicalStringify(pendingSend.input)));
    f.approve(String(pendingSend.id));
    const done = await f.run();
    expect(done.report.disposition).toBe("succeeded");
    expect(f.effects).toEqual(["draft:fresh", "send:observed.draft", "contacts"]);
    f.approved.clear();
    const replay = await f.run();
    expect(replay.actions.map(row => row.observation)).toEqual(done.actions.map(row => row.observation));
    expect(f.effects).toHaveLength(3);
    await expect(f.run({ operationId: "other.operation" })).resolves.toMatchObject({ report: { disposition: "not_ready" } });
    expect(f.effects).toHaveLength(3);
    const changedRequest = "σ «different»";
    await expect(f.run({ binding: (await f.rebind(changedRequest))!, requestText: changedRequest })).rejects.toThrow(/goal identity changed/);
    f.binding.steps![0]!.payload = { to: ["other@example.invalid"], subject: "changed", body: "changed" };
    await expect(f.run()).rejects.toThrow(/not verified/);
    expect(send.actions.find(row => row.taskId === "contacts")?.status).toBeUndefined();
  });

  it.each(["tools", "network"] as const)("honors the configured %s budget across iterations and resumes without duplicate effects", async budget => {
    const f = await fixture("network");
    const policy = { ...DEFAULT_POLICY, alphaRiskCeiling: 1, maxToolCalls: budget === "tools" ? 1 : 10, maxNetworkRequests: budget === "network" ? 1 : 10 };
    const first = await f.run({ policy });
    expect(f.effects).toEqual(["fresh"]);
    expect(first.actions.find(row => row.taskId === "first")?.disposition).toBe("succeeded");
    expect(first.actions.find(row => row.taskId === "second")?.status).toBe("planned");
    expect(first.actions.find(row => row.taskId === "second")?.disposition).toBe(budget === "tools" ? "budget_exhausted" : "not_ready");
    expect((await f.run({ policy })).report.disposition).toBe("succeeded");
    expect(f.effects).toEqual(["fresh", "second"]);
  });

  it.each(["partial", "unknown"] as const)("keeps %s outcomes local to the attempted task and stops unexecuted successors", async failure => {
    const f = await fixture("email", failure);
    const approvals: ApprovalPort = { isApproved: () => true, observePending: () => {} };
    const first = await f.run({ approvals });
    expect(first.report.disposition).toBe(failure === "partial" ? "failed" : "indeterminate");
    expect(first.actions.find(row => row.taskId === "draft")?.disposition).toBe(first.report.disposition);
    expect(first.actions.find(row => row.taskId === "contacts")).toMatchObject({ status: "planned", disposition: "not_ready" });
    expect(first.plans.find(row => row.capabilityId === "outlook.read_contacts")?.result).toMatchObject({ disposition: "not_ready" });
    expect(f.effects).toEqual(["draft:fresh"]);
    expect((await f.run({ approvals })).report.disposition).toBe(first.report.disposition);
    expect(f.effects).toHaveLength(1);
  });

  it("dispatches no provider effects when the configured tool budget is zero", async () => {
    const f = await fixture("network");
    const result = await f.run({ policy: { ...DEFAULT_POLICY, maxToolCalls: 0 } });
    expect(result.report.disposition).toBe("budget_exhausted");
    expect(f.effects).toEqual([]);
    expect(result.actions.every(action => action.status === "planned" && action.disposition === "budget_exhausted")).toBe(true);
  });

  it("freezes learned plan inputs and authority material against callback mutation", async () => {
    const f = await fixture("network");
    let calls = 0;
    const approvals: ApprovalPort = {
      isApproved(input) {
        calls++;
        f.binding.steps![0]!.payload = { query: "changed.outside", limit: 1 };
        f.binding.patternIds.push("changed.pattern");
        if (input.input && typeof input.input === "object" && !Array.isArray(input.input)) input.input.query = "changed.callback.payload";
        if (input.approvalScope) input.approvalScope.taskId = "changed.callback.scope";
        return true;
      },
      observePending(plan) {
        plan.permission = { allowed: false, dryRun: true };
        plan.input = { query: "changed.pending.payload", limit: 1 };
      }
    };
    const done = await f.run({ approvals });
    expect(done.report.disposition).toBe("succeeded");
    expect(f.effects).toEqual(["fresh", "second"]);
    expect(calls).toBeGreaterThan(0);
    expect(done.plans.every(plan => plan.approvalScope?.taskId !== "changed.callback.scope")).toBe(true);
    await expect(f.run()).rejects.toThrow(/not verified/);
  });
});
