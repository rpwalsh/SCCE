// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createRuntimeCapabilities, invokeRuntimeCapabilityPlan, type RuntimeCapabilityPlanStep } from "../capability-runtime.js";
import { createConnectorCapabilityOperations } from "../connector-capabilities.js";
import { createCapabilityRegistry } from "../safety.js";
import { createHasher, canonicalStringify } from "../primitives.js";
import type { ConnectorPort, ScceStorage } from "../storage.js";
import type { EvidenceSpan } from "../types.js";
import { CAPABILITY_DEMONSTRATION_SCHEMA, capabilityBindingForRequest, capabilityBindingVerified, compileCapabilityDemonstrations } from "../capability-construction.js";
import { capabilityRuntimeFixture } from "./fixtures/capability-runtime.js";

const steps = (): RuntimeCapabilityPlanStep[] => [
  { id: "draft", capabilityId: "outlook.create_draft", payload: { to: ["recipient@example.invalid"], subject: "件名", body: "内容" }, dependencyStepIds: [] },
  { id: "send", capabilityId: "outlook.send_mail", payload: { messageId: null }, dependencyStepIds: ["draft"],
    resultBindings: [{ path: ["messageId"], predecessorTaskId: "draft", resultPath: ["id"], type: "string" }] }
];
const hash = (value: unknown) => createHasher().digestHex(canonicalStringify(value));
const identity = { episodeId: "episode.dataflow", goalId: "goal.dataflow", ownerId: "owner.dataflow", policyVersionId: "policy.dataflow", maxDispatches: 10 };

function fixture(create: ConnectorPort["outlookCreateDraft"] = async () => ({ id: "actual.provider.draft" })) {
  const durable = capabilityRuntimeFixture();
  let creates = 0;
  const sent: string[] = [];
  const connectors = { outlookCreateDraft: async (...args: Parameters<NonNullable<typeof create>>) => { creates++; return create!(...args); },
    outlookSendDraft: async (id: string, approved: boolean) => { expect(approved).toBe(true); sent.push(id); return { id, sent: true }; }
  } as unknown as ConnectorPort;
  const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
    operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ outlook: true }).all() }) });
  const run = (extra: Partial<Parameters<typeof invokeRuntimeCapabilityPlan>[0]> = {}) => invokeRuntimeCapabilityPlan({ ...identity, steps: steps(), capabilities: restart(), ...extra });
  return { durable, restart, run, sent, creates: () => creates };
}

describe("durable observed-result capability dataflow", () => {
  it("approves concrete payloads, binds the observed provider ID, and replays a cold restart without duplicate effects", async () => {
    const f = fixture();
    const draft = await f.run();
    expect(draft.disposition).toBe("not_ready");
    expect(draft.pendingTask).toEqual({ taskId: "draft", capabilityId: "outlook.create_draft", inputRef: hash(steps()[0]!.payload), payload: steps()[0]!.payload });
    expect(f.creates()).toBe(0);
    const approvedDraft = [{ taskId: "draft", inputRef: draft.pendingTask!.inputRef }];
    const send = await f.run({ approvals: approvedDraft });
    expect(send.disposition).toBe("not_ready");
    expect(send.pendingTask).toEqual({ taskId: "send", capabilityId: "outlook.send_mail", inputRef: hash({ messageId: "actual.provider.draft" }), payload: { messageId: "actual.provider.draft" } });
    expect(f.creates()).toBe(1);
    expect(f.sent).toEqual([]);
    await expect(f.run({ approvals: [...approvedDraft, { taskId: "send", inputRef: hash({ messageId: null }) }] })).rejects.toThrow(/concrete resolved payload/);
    const done = await f.run({ approvals: [...approvedDraft, { taskId: "send", inputRef: send.pendingTask!.inputRef }] });
    expect(done.disposition).toBe("succeeded");
    expect(done.observations.map(row => ({ taskId: row.taskId, result: row.observation.result }))).toEqual([
      { taskId: "draft", result: { id: "actual.provider.draft" } }, { taskId: "send", result: { id: "actual.provider.draft", sent: true } }
    ]);
    expect(f.sent).toEqual(["actual.provider.draft"]);
    const replay = await f.run();
    expect(replay.disposition).toBe("succeeded");
    expect(replay.observations).toEqual(done.observations);
    expect(replay.taskInputs).toEqual(done.taskInputs);
    expect(replay.taskInputs).toContainEqual({ taskId: "send", capabilityId: "outlook.send_mail", inputRef: hash({ messageId: "actual.provider.draft" }), payload: { messageId: "actual.provider.draft" } });
    expect(f.creates()).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.durable.values.size).toBe(2);
    const changed = steps();
    changed[0]!.payload = { to: ["attacker@example.invalid"], subject: "件名", body: "内容" };
    await expect(f.run({ steps: changed })).rejects.toThrow(/goal identity changed/);
    await expect(f.run({ ownerId: "other.owner" })).rejects.toThrow(/ownership/);
  });

  it("resumes a journal interruption after the provider receipt and before outcome without repeating the effect", async () => {
    const f = fixture();
    const append = f.durable.journal.append;
    let interrupt = true;
    f.durable.journal.append = async input => {
      if (interrupt && input.events.some(event => event.type === "outcome_recorded")) {
        interrupt = false;
        throw new Error("outcome journal interruption");
      }
      return append(input);
    };
    const approvals = [{ taskId: "draft", inputRef: hash(steps()[0]!.payload) }];
    await expect(f.run({ approvals })).rejects.toThrow("outcome journal interruption");
    expect(f.creates()).toBe(1);
    const resumed = await f.run({ approvals });
    expect(resumed.pendingTask?.payload).toEqual({ messageId: "actual.provider.draft" });
    expect(resumed.observations).toHaveLength(1);
    expect(f.creates()).toBe(1);
    expect(f.durable.values.size).toBe(1);
  });

  it("feeds nested search observations into a fetch and schedules a static successor after the bound task", async () => {
    const durable = capabilityRuntimeFixture();
    const fetched: string[] = [];
    let searches = 0, contacts = 0;
    const connectors = { search: async () => { searches++; return [{ uri: "https://observed.invalid/resource", title: "Observed", snippet: "" }]; },
      fetch: async (uri: string) => { fetched.push(uri); return { uri, bytes: new TextEncoder().encode("observed bytes"), mediaType: "text/plain", metadata: {} }; },
      outlookReadContacts: async () => { contacts++; return [{ id: "contact.observed" }]; }
    } as unknown as ConnectorPort;
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ network: true, outlook: true }).all() }) });
    const plan: RuntimeCapabilityPlanStep[] = [
      { id: "search", capabilityId: "network.search", payload: { query: "観測", limit: 1 }, dependencyStepIds: [] },
      { id: "fetch", capabilityId: "network.fetch", payload: { uri: null }, dependencyStepIds: ["search"],
        resultBindings: [{ path: ["uri"], predecessorTaskId: "search", resultPath: [0, "uri"], type: "string" }] },
      { id: "contacts", capabilityId: "outlook.read_contacts", payload: { query: "観測" }, dependencyStepIds: ["fetch"] }
    ];
    const approvals = [{ taskId: "search", inputRef: hash(plan[0]!.payload) }, { taskId: "contacts", inputRef: hash(plan[2]!.payload) }];
    const run = (extra: { taskId: string; inputRef: string }[] = []) => invokeRuntimeCapabilityPlan({ ...identity, capabilities: restart(), steps: plan, approvals: [...approvals, ...extra] });
    const pending = await run();
    expect(pending.pendingTask?.payload).toEqual({ uri: "https://observed.invalid/resource" });
    expect(contacts).toBe(0);
    const done = await run([{ taskId: "fetch", inputRef: pending.pendingTask!.inputRef }]);
    expect(done.disposition).toBe("succeeded");
    expect(done.observations.map(row => row.taskId)).toEqual(["search", "fetch", "contacts"]);
    expect({ searches, fetched, contacts }).toEqual({ searches: 1, fetched: ["https://observed.invalid/resource"], contacts: 1 });
  });

  it.each([false, true])("stops after a partial or unknown predecessor outcome (partial=%s)", async partial => {
    const f = fixture(async () => { throw Object.assign(new Error("lost acknowledgement"), partial ? { messageId: "partial.draft" } : {}); });
    const approved = [{ taskId: "draft", inputRef: hash(steps()[0]!.payload) }];
    expect((await f.run({ approvals: approved })).disposition).toBe(partial ? "failed" : "indeterminate");
    expect((await f.run({ approvals: approved })).disposition).toBe(partial ? "failed" : "indeterminate");
    expect(f.creates()).toBe(1);
    expect(f.sent).toEqual([]);
    expect((await f.durable.executive().load(identity.episodeId)).tasks.send).toBeUndefined();
  });

  it("rejects missing edges and overlapping bindings before effects, and refuses missing or wrong typed observations", async () => {
    const f = fixture(async () => ({ id: 42 }));
    const wrong = steps();
    await expect(f.run({ approvals: [{ taskId: "other.task", inputRef: "other.payload" }] })).rejects.toThrow(/exact task identities/);
    const reserved = steps();
    reserved[1]!.id = "constructor";
    await expect(f.run({ steps: reserved })).rejects.toThrow(/state object property/);
    wrong[1]!.dependencyStepIds = [];
    await expect(f.run({ steps: wrong })).rejects.toThrow(/predecessor result binding/);
    expect((await f.durable.executive().load(identity.episodeId)).status).toBe("unopened");
    const duplicate = steps();
    duplicate[1]!.resultBindings!.push(duplicate[1]!.resultBindings![0]!);
    await expect(f.run({ steps: duplicate })).rejects.toThrow(/overlapping/);
    await expect(f.run({ approvals: [{ taskId: "draft", inputRef: hash(steps()[0]!.payload) }] })).rejects.toThrow(/type mismatch/);
    expect(f.sent).toEqual([]);
    expect(f.creates()).toBe(1);
  });

  it("learns opaque multilingual plan surfaces from source evidence and executes their observed dependency", async () => {
    const f = fixture();
    const request = "送付 «件名» 内容 «内容»";
    const example = { request, steps: steps(), bindings: [
      { path: ["steps", 0, "payload", "subject"], startCodePoint: 4, endCodePoint: 6 },
      { path: ["steps", 0, "payload", "body"], startCodePoint: 12, endCodePoint: 14 }
    ] };
    const sourceText = JSON.stringify({ schema: CAPABILITY_DEMONSTRATION_SCHEMA, examples: [example] });
    const contentHash = await f.durable.blobs.put(new TextEncoder().encode(sourceText), "application/json");
    const evidence = [{ id: "evidence.plan", sourceId: "source.plan", sourceVersionId: "version.plan", contentHash, text: sourceText, status: "promoted" }] as unknown as EvidenceSpan[];
    const owner = { sourceId: evidence[0]!.sourceId, sourceVersionId: evidence[0]!.sourceVersionId, contentHash, profileId: "profile.plan" };
    const patterns = compileCapabilityDemonstrations({ sourceText, owner, evidence, hasher: createHasher(), updatedAt: 1 });
    const storage = { blobs: f.durable.blobs, evidence: { getEvidenceBatch: async () => evidence }, languageMemory: { listLanguagePatterns: async () => patterns } } as unknown as ScceStorage;
    const fresh = "送付 «新しい件名» 内容 «新的内容»";
    const bound = await capabilityBindingForRequest({ storage, requestText: fresh });
    expect(capabilityBindingVerified(bound, fresh)).toBe(true);
    expect(bound?.steps?.[0]?.payload).toEqual({ to: ["recipient@example.invalid"], subject: "新しい件名", body: "新的内容" });
    expect(bound?.steps?.[1]?.resultBindings).toEqual(steps()[1]!.resultBindings);
    const first = await f.run({ steps: bound!.steps! });
    const second = await f.run({ steps: bound!.steps!, approvals: [{ taskId: "draft", inputRef: first.pendingTask!.inputRef }] });
    expect(second.pendingTask?.payload).toEqual({ messageId: "actual.provider.draft" });
    const last = await f.run({ steps: bound!.steps!, approvals: [{ taskId: "send", inputRef: second.pendingTask!.inputRef }] });
    expect(last.disposition).toBe("succeeded");
    expect(f.sent).toEqual(["actual.provider.draft"]);
    bound!.steps![1]!.capabilityId = "telephone.call";
    expect(capabilityBindingVerified(bound, fresh)).toBe(false);
  });
});
