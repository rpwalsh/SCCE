// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createConversationPlanMemory, conversationPlanReceiptIsCurrent, type ConversationPlanReceipt } from "../conversation-plan-memory.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import { createHasher, toJsonValue } from "../primitives.js";
import type { DurableLanguageConstructionBundle } from "../language-construction-memory.js";

const hasher = createHasher();
const receipt = (): ConversationPlanReceipt => ({ schema: "scce.conversation_plan_receipt.v1", authority: "conversation_bound", externallyFactual: false,
  evidenceIds: [], planId: "plan.1", continuationKey: "act.1", bundleId: "bundle.1", constructionId: "construction.1", realizationId: "realization.1",
  profileId: "profile.1", sourceVersionIds: ["source.1"], surfaceHash: hasher.digestHex("λ→β"),
  roles: [{ roleId: "role.1", occurrenceId: "occurrence.1", sourceTurnId: "turn.1", startCodePoint: 0, endCodePoint: 1 }],
  realizationSteps: [{ id: "step.1", order: 0, kind: "slot", startCodePoint: 0, endCodePoint: 1 }, { id: "step.2", order: 1, kind: "literal", startCodePoint: 1, endCodePoint: 3 }] });

it("restores only the exact conversation head and keeps caller mutations outside durable state", async () => {
  const store = createInMemoryDialogueMemoryStore(), memory = createConversationPlanMemory({ store, hasher }), plan = receipt();
  const first = await memory.persist({ conversationId: "conversation.1", turnId: "turn.1", receipt: plan, createdAt: 1 });
  expect(first.result.stored).toBe(true);
  plan.roles[0]!.startCodePoint = 8;
  const cold = createConversationPlanMemory({ store, hasher });
  const restored = await cold.latest("conversation.1");
  expect(restored).toMatchObject({ id: first.state.id, turnIndex: 1, receipt: { externallyFactual: false, evidenceIds: [] } });
  restored!.receipt.roles[0]!.endCodePoint = 99;
  expect((await cold.latest("conversation.1"))!.receipt.roles[0]!.endCodePoint).toBe(1);
  expect(await cold.latest("conversation.2")).toBeUndefined();
  await expect(memory.persist({ conversationId: "conversation.2", turnId: "turn.2", receipt: receipt(), previous: first.state, createdAt: 2 }))
    .rejects.toThrow("invalid conversation plan ownership");
});

it("uses the existing CAS to reject stale concurrent continuations", async () => {
  const store = createInMemoryDialogueMemoryStore(), memory = createConversationPlanMemory({ store, hasher });
  const first = await memory.persist({ conversationId: "conversation.1", turnId: "turn.1", receipt: receipt(), createdAt: 1 });
  const second = await memory.persist({ conversationId: "conversation.1", turnId: "turn.2", receipt: receipt(), previous: first.state, createdAt: 2 });
  const stale = await memory.persist({ conversationId: "conversation.1", turnId: "turn.3", receipt: receipt(), previous: first.state, createdAt: 3 });
  expect(second.result.stored).toBe(true);
  expect(stale.result).toMatchObject({ stored: false, reason: "state_conflict" });
  expect((await memory.latest("conversation.1"))!.id).toBe(second.state.id);
});

it("rejects malformed, factual and duplicate-role receipts before writing", async () => {
  const memory = createConversationPlanMemory({ store: createInMemoryDialogueMemoryStore(), hasher });
  const malformed = [
    { ...receipt(), externallyFactual: true }, { ...receipt(), evidenceIds: ["evidence.foreign"] },
    { ...receipt(), roles: [receipt().roles[0], receipt().roles[0]] },
    { ...receipt(), roles: [{ ...receipt().roles[0], startCodePoint: -1 }] },
    { ...receipt(), realizationSteps: [{ ...receipt().realizationSteps[0], order: 1 }] }
  ];
  for (const value of malformed) await expect(memory.persist({ conversationId: "conversation.1", turnId: "turn.1", receipt: value as ConversationPlanReceipt, createdAt: 1 }))
    .rejects.toThrow("invalid conversation plan ownership");
  expect(await memory.latest("conversation.1")).toBeUndefined();
});

it("does not restore a tampered state retaining its old digest", async () => {
  const store = createInMemoryDialogueMemoryStore(), memory = createConversationPlanMemory({ store, hasher });
  const first = await memory.persist({ conversationId: "conversation.1", turnId: "turn.1", receipt: receipt(), createdAt: 1 });
  await store.putInteractionState({ id: first.state.id, conversationId: "conversation.1", turnId: "turn.1", createdAt: 1,
    stateJson: toJsonValue({ ...first.state, receipt: { ...first.state.receipt, bundleId: "bundle.foreign" } }), featureRefs: [], signalRefs: [] });
  expect(await memory.latest("conversation.1")).toBeUndefined();
});

it("does not grant continuation eligibility through a revoked, foreign or partial current bundle", () => {
  const bundle = { id: "bundle.1", targetProfileId: "profile.1", sourceVersionIds: ["source.1"], constructions: [{ id: "construction.1",
    roleOccurrences: [{ roleId: "role.1", occurrenceId: "occurrence.1" }] }] } as unknown as DurableLanguageConstructionBundle;
  expect(conversationPlanReceiptIsCurrent(receipt(), [bundle])).toBe(true);
  for (const bundles of [[], [{ ...bundle, targetProfileId: "profile.foreign" }], [{ ...bundle, sourceVersionIds: ["source.updated"] }], [{ ...bundle, constructions: [] }]])
    expect(conversationPlanReceiptIsCurrent(receipt(), bundles)).toBe(false);
  expect(conversationPlanReceiptIsCurrent({ ...receipt(), roles: [...receipt().roles, ...receipt().roles] }, [bundle])).toBe(false);
});
