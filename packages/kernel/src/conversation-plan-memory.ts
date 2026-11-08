// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, toJsonValue } from "./primitives.js";
import type { DialogueMemoryStore, InteractionStateRecord } from "./storage.js";
import type { Hasher } from "./types.js";
import type { DurableLanguageConstructionBundle } from "./language-construction-memory.js";

export const CONVERSATION_PLAN_STATE_SCHEMA = "scce.conversation_plan_state.v1";

/** A selected realization's source form and turn-owned arguments confer no documentary authority. */
export interface ConversationPlanReceipt {
  schema: "scce.conversation_plan_receipt.v1";
  authority: "conversation_bound";
  externallyFactual: false;
  evidenceIds: [];
  planId: string;
  continuationKey: string;
  bundleId: string;
  constructionId: string;
  realizationId: string;
  profileId: string;
  sourceVersionIds: string[];
  surfaceHash: string;
  roles: Array<{ roleId: string; occurrenceId: string; sourceTurnId: string; startCodePoint: number; endCodePoint: number }>;
  realizationSteps: Array<{ id: string; order: number; kind: "literal" | "slot"; startCodePoint: number; endCodePoint: number }>;
}

export interface ConversationPlanState {
  schema: typeof CONVERSATION_PLAN_STATE_SCHEMA;
  id: string;
  conversationId: string;
  turnId: string;
  turnIndex: number;
  previousStateId: string | null;
  receipt: ConversationPlanReceipt;
}

export function conversationPlanReceiptIsCurrent(receipt: ConversationPlanReceipt, bundles: readonly DurableLanguageConstructionBundle[]): boolean {
  if (!validReceipt(receipt)) return false;
  const bundle = bundles.find(bundle => bundle.id === receipt.bundleId && bundle.targetProfileId === receipt.profileId);
  const construction = bundle?.constructions.find(construction => construction.id === receipt.constructionId);
  return Boolean(bundle && construction
    && canonicalStringify([...bundle.sourceVersionIds].sort()) === canonicalStringify([...receipt.sourceVersionIds].sort())
    && receipt.roles.length === construction.roleOccurrences.length
    && receipt.roles.every(role => construction.roleOccurrences.some(occurrence => occurrence.roleId === role.roleId && occurrence.occurrenceId === role.occurrenceId)));
}

export function createConversationPlanMemory(input: { store: Pick<DialogueMemoryStore, "listInteractionStates" | "compareAndPutInteractionState">; hasher: Hasher }) {
  const stateId = (state: Omit<ConversationPlanState, "id">) => `conversation_plan.${input.hasher.digestHex(canonicalStringify(state))}`;
  const decode = (row: InteractionStateRecord, conversationId: string): ConversationPlanState | undefined => {
    const state = row.stateJson as unknown as ConversationPlanState;
    if (!state || state.schema !== CONVERSATION_PLAN_STATE_SCHEMA || state.conversationId !== conversationId
      || row.conversationId !== conversationId || row.id !== state.id || row.turnId !== state.turnId
      || typeof state.turnId !== "string" || !state.turnId
      || (state.previousStateId !== null && (typeof state.previousStateId !== "string" || !state.previousStateId))
      || !Number.isSafeInteger(state.turnIndex) || state.turnIndex < 1 || !validReceipt(state.receipt)) return undefined;
    const { id, ...material } = state;
    return id === stateId(material) ? structuredClone(state) : undefined;
  };
  return {
    async latest(conversationId: string): Promise<ConversationPlanState | undefined> {
      const rows = await input.store.listInteractionStates({ conversationId, headSchema: CONVERSATION_PLAN_STATE_SCHEMA, limit: 1 });
      return rows[0] ? decode(rows[0], conversationId) : undefined;
    },
    async persist(inputState: { conversationId: string; turnId: string; receipt: ConversationPlanReceipt; createdAt: number; previous?: ConversationPlanState }) {
      if (!validReceipt(inputState.receipt) || !inputState.conversationId || !inputState.turnId
        || (inputState.previous && inputState.previous.conversationId !== inputState.conversationId)) throw new Error("invalid conversation plan ownership");
      if (inputState.previous) {
        const { id, ...previous } = inputState.previous;
        if (id !== stateId(previous) || !validReceipt(previous.receipt)) throw new Error("invalid previous conversation plan");
      }
      const material: Omit<ConversationPlanState, "id"> = { schema: CONVERSATION_PLAN_STATE_SCHEMA, conversationId: inputState.conversationId,
        turnId: inputState.turnId, turnIndex: (inputState.previous?.turnIndex ?? 0) + 1, previousStateId: inputState.previous?.id ?? null, receipt: structuredClone(inputState.receipt) };
      const state = { ...material, id: stateId(material) };
      const result = await input.store.compareAndPutInteractionState({ id: state.id, conversationId: state.conversationId, turnId: state.turnId,
        stateJson: toJsonValue(state), featureRefs: [state.receipt.bundleId, state.receipt.constructionId],
        signalRefs: [state.receipt.planId, state.receipt.continuationKey], createdAt: inputState.createdAt }, {
        stateSchema: CONVERSATION_PLAN_STATE_SCHEMA, expectedStateId: inputState.previous?.id ?? null,
        expectedTurnIndex: inputState.previous?.turnIndex ?? null, nextStateId: state.id, nextTurnIndex: state.turnIndex });
      return { state, result };
    }
  };
}

function validReceipt(receipt: ConversationPlanReceipt): boolean {
  return Boolean(receipt && receipt.schema === "scce.conversation_plan_receipt.v1" && receipt.authority === "conversation_bound"
    && receipt.externallyFactual === false && Array.isArray(receipt.evidenceIds) && receipt.evidenceIds.length === 0
    && [receipt.planId, receipt.continuationKey, receipt.bundleId, receipt.constructionId, receipt.realizationId, receipt.profileId, receipt.surfaceHash].every(value => typeof value === "string" && value.length > 0)
    && Array.isArray(receipt.sourceVersionIds) && receipt.sourceVersionIds.length > 0 && receipt.sourceVersionIds.every(value => typeof value === "string" && value.length > 0)
    && new Set(receipt.sourceVersionIds).size === receipt.sourceVersionIds.length
    && Array.isArray(receipt.roles) && receipt.roles.length > 0 && receipt.roles.every(role => role
      && [role.roleId, role.occurrenceId, role.sourceTurnId].every(value => typeof value === "string" && value.length > 0)
      && Number.isSafeInteger(role.startCodePoint) && Number.isSafeInteger(role.endCodePoint) && role.startCodePoint >= 0 && role.endCodePoint > role.startCodePoint)
    && new Set(receipt.roles.map(role => role.occurrenceId)).size === receipt.roles.length
    && Array.isArray(receipt.realizationSteps) && receipt.realizationSteps.length > 0 && receipt.realizationSteps.every((step, order) => step && typeof step.id === "string" && step.id && step.order === order
      && (step.kind === "literal" || step.kind === "slot") && Number.isSafeInteger(step.startCodePoint) && Number.isSafeInteger(step.endCodePoint)
      && step.startCodePoint >= 0 && step.endCodePoint > step.startCodePoint
      && (order === 0 || step.startCodePoint >= receipt.realizationSteps[order - 1]!.endCodePoint))
    && new Set(receipt.realizationSteps.map(step => step.id)).size === receipt.realizationSteps.length);
}
