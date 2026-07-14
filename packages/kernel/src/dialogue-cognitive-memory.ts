import {
  deriveDialogueCognitiveStateIdV2,
  isDiscourseProvenanceBindingForReferentV2,
  type DiscourseProvenanceBindingV2,
  type DialogueCognitiveStateV2,
  type DiscourseBindingComponentsV2,
  type DiscourseBindingV2,
  type DiscourseReferentV2,
  type DiscourseSlotBindingV2,
  type DiscourseTemporalIntervalV2,
  type DiscourseTopicV2
} from "./discourse-state.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import type { DialogueMemoryStore, InteractionStateCompareAndSetResult, InteractionStateRecord } from "./storage.js";
import type { Hasher } from "./types.js";

export interface DialogueCognitiveMemoryV2 {
  persist(
    state: DialogueCognitiveStateV2,
    createdAt: number,
    expectedPreviousState: DialogueCognitiveStateV2 | null
  ): Promise<{ record: InteractionStateRecord; result: InteractionStateCompareAndSetResult }>;
  latest(conversationId: string): Promise<DialogueCognitiveStateV2 | undefined>;
}

export function createDialogueCognitiveMemoryV2(input: {
  store: Pick<DialogueMemoryStore, "compareAndPutInteractionState" | "listInteractionStates">;
  hasher: Hasher;
  readLimit?: number;
}): DialogueCognitiveMemoryV2 {
  const readLimit = Math.max(1, Math.min(256, Math.floor(input.readLimit ?? 256)));
  return {
    async persist(state, createdAt, expectedPreviousState) {
      if (expectedPreviousState && (
        expectedPreviousState.conversationId !== state.conversationId
        || expectedPreviousState.turnIndex >= state.turnIndex
      )) throw new Error("dialogue cognitive state predecessor is not monotonic");
      const record = dialogueCognitiveStateInteractionRecordV2({ state, createdAt, hasher: input.hasher });
      const result = await input.store.compareAndPutInteractionState(record, {
        stateSchema: "scce.dialogue_cognitive_state.v2",
        expectedStateId: expectedPreviousState?.id ?? null,
        expectedTurnIndex: expectedPreviousState?.turnIndex ?? null,
        nextStateId: state.id,
        nextTurnIndex: state.turnIndex
      });
      return { record, result };
    },
    async latest(conversationId) {
      if (!nonemptyId(conversationId)) return undefined;
      const records = (await input.store.listInteractionStates({ conversationId, limit: readLimit }))
        .map(record => ({ record, state: dialogueCognitiveStateFromInteractionRecordV2(record, input.hasher) }))
        .filter((row): row is { record: InteractionStateRecord; state: DialogueCognitiveStateV2 } => (
          row.state?.conversationId === conversationId
        ))
        .sort((left, right) => (
          right.state.turnIndex - left.state.turnIndex
          || right.record.createdAt - left.record.createdAt
          || compareCodePoints(right.record.id, left.record.id)
        ));
      return records[0]?.state;
    }
  };
}

export function dialogueCognitiveStateInteractionRecordV2(input: {
  state: DialogueCognitiveStateV2;
  createdAt: number;
  hasher: Hasher;
}): InteractionStateRecord {
  if (!isDialogueCognitiveStateV2(input.state, input.hasher)) {
    throw new Error("invalid dialogue cognitive state v2");
  }
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0) {
    throw new Error("invalid dialogue cognitive state timestamp");
  }
  const stateJson = toJsonValue(input.state);
  const featureRefs = dialogueStateFeatureRefs(input.state);
  const signalRefs = dialogueStateSignalRefs(input.state);
  return {
    id: interactionRecordId(input.state, input.hasher),
    conversationId: input.state.conversationId,
    turnId: input.state.turnId,
    stateJson,
    featureRefs,
    signalRefs,
    createdAt: input.createdAt
  };
}

export function dialogueCognitiveStateFromInteractionRecordV2(
  record: InteractionStateRecord,
  hasher: Hasher
): DialogueCognitiveStateV2 | undefined {
  if (!Number.isFinite(record.createdAt) || record.createdAt < 0) return undefined;
  if (!isDialogueCognitiveStateV2(record.stateJson, hasher)) return undefined;
  const state = record.stateJson;
  if (record.conversationId !== state.conversationId || record.turnId !== state.turnId) return undefined;
  if (record.id !== interactionRecordId(state, hasher)) return undefined;
  if (!sameStrings(canonicalIds(record.featureRefs), dialogueStateFeatureRefs(state))) return undefined;
  if (!sameStrings(canonicalIds(record.signalRefs), dialogueStateSignalRefs(state))) return undefined;
  return state;
}

export function isDialogueCognitiveStateV2(value: unknown, hasher?: Hasher): value is DialogueCognitiveStateV2 {
  const state = objectRecord(value);
  if (!state
    || state.schema !== "scce.dialogue_cognitive_state.v2"
    || !nonemptyId(state.id)
    || !nonemptyId(state.conversationId)
    || !nonemptyId(state.observationId)
    || !nonemptyId(state.turnId)
    || state.sessionId !== undefined && !nonemptyId(state.sessionId)
    || !nonnegativeInteger(state.turnIndex)
    || state.queryConcatenationUsed !== false
    || !stringIdArray(state.activeTopicIds)
    || !stringIdArray(state.unresolvedMentionIds)
    || !stringIdArray(state.openSlotIds)
    || !stringIdArray(state.preferenceSnapshotIds)
    || !stringIdArray(state.correctionIds)
    || !stringIdArray(state.historyDigestIds)
    || !Array.isArray(state.referents)
    || !state.referents.every(isDiscourseReferentV2)
    || !Array.isArray(state.topics)
    || !state.topics.every(isDiscourseTopicV2)
    || !Array.isArray(state.bindings)
    || !state.bindings.every(isDiscourseBindingV2)) return false;

  const referents = state.referents as unknown as DiscourseReferentV2[];
  const topics = state.topics as unknown as DiscourseTopicV2[];
  const bindings = state.bindings as unknown as DiscourseBindingV2[];
  if (!uniqueIds(referents) || !uniqueIds(topics) || !uniqueIds(bindings)) return false;
  if (String(state.id) !== deriveDialogueCognitiveStateIdV2(state as unknown as DialogueCognitiveStateV2, hasher)) return false;
  const referentIds = new Set(referents.map(item => item.id));
  const topicIds = new Set(topics.map(item => item.id));
  const referentById = new Map(referents.map(item => [item.id, item]));
  const topicById = new Map(topics.map(item => [item.id, item]));
  if (referents.some(referent => {
    const topic = topicById.get(referent.topicId);
    return !topic
      || !topic.referentIds.includes(referent.id)
      || !contradictionCoherent(referent)
      || referent.introducedTurnIndex > referent.lastMentionTurnIndex
      || referent.lastMentionTurnIndex > Number(state.turnIndex);
  })) return false;
  if (topics.some(topic => topic.lastTurnIndex > Number(state.turnIndex)
    || topic.referentIds.some(id => !referentIds.has(id))
    || topic.referentIds.some(id => referentById.get(id)?.topicId !== topic.id)
    || topic.parentTopicId === topic.id
    || topic.parentTopicId !== undefined && !topicIds.has(topic.parentTopicId)
    || topic.supersedesTopicIds.includes(topic.id)
    || topic.supersedesTopicIds.some(id => !topicIds.has(id)))) return false;
  if (bindings.some(binding => {
    const referent = referentById.get(binding.referentId);
    return !referent
      || !topicIds.has(binding.topicId)
      || referent.topicId !== binding.topicId
      || binding.provenanceBindings.some(provenance => (
        provenance.observationId !== state.observationId
        || provenance.mentionId !== binding.mentionId
        || provenance.referentId !== binding.referentId
        || !isDiscourseProvenanceBindingForReferentV2(provenance, referent, hasher)
      ))
      || binding.admitted && (!binding.provenanceBindings.length
        || binding.components.graphRouteCoherence <= 0
        || !sameStrings(
          canonicalIds(binding.provenanceBindings.flatMap(provenance => provenance.contradictionIds)),
          canonicalIds(referent.contradictionIds)
        ))
      || binding.alternatives.some(alternative => !referentIds.has(alternative.referentId));
  })) return false;
  const admittedMentionIds = bindings.filter(binding => binding.admitted).map(binding => binding.mentionId);
  if (new Set(admittedMentionIds).size !== admittedMentionIds.length) return false;
  if ((state.unresolvedMentionIds as unknown as string[]).some(id => admittedMentionIds.includes(id))) return false;
  if ((state.activeTopicIds as unknown as string[]).some(id => !topicIds.has(id))) return false;
  const historyDigestIds = state.historyDigestIds as unknown as string[];
  if (!historyDigestIds.length || historyDigestIds[historyDigestIds.length - 1] !== state.observationId) return false;
  return true;
}

function isDiscourseReferentV2(value: unknown): value is DiscourseReferentV2 {
  const item = objectRecord(value);
  return Boolean(item
    && item.schema === "scce.discourse_referent.v2"
    && nonemptyId(item.id)
    && nonemptyId(item.topicId)
    && nonemptyId(item.introducedTurnId)
    && nonnegativeInteger(item.introducedTurnIndex)
    && nonnegativeInteger(item.lastMentionTurnIndex)
    && stringIdArray(item.nodeIds)
    && stringIdArray(item.claimIds)
    && stringIdArray(item.relationIds)
    && stringIdArray(item.evidenceIds)
    && stringIdArray(item.sourceVersionIds)
    && stringIdArray(item.contradictionIds)
    && stringIdArray(item.semanticRoleIds)
    && stringIdArray(item.learnedFrameIds)
    && stringIdArray(item.scopeIds)
    && (item.temporalScope === undefined || isTemporalInterval(item.temporalScope))
    && Array.isArray(item.slotBindings)
    && item.slotBindings.every(isSlotBinding)
    && unitMass(item.salienceMass)
    && unitMass(item.evidenceSupportMass)
    && unitMass(item.contradictionMass)
    && nonemptyId(item.authorityClassId));
}

function isDiscourseTopicV2(value: unknown): value is DiscourseTopicV2 {
  const item = objectRecord(value);
  return Boolean(item
    && item.schema === "scce.discourse_topic.v2"
    && nonemptyId(item.id)
    && nonemptyId(item.statusId)
    && stringIdArray(item.anchorNodeIds)
    && stringIdArray(item.referentIds)
    && stringIdArray(item.claimIds)
    && stringIdArray(item.evidenceIds)
    && (item.parentTopicId === undefined || nonemptyId(item.parentTopicId))
    && stringIdArray(item.supersedesTopicIds)
    && unitMass(item.salienceMass)
    && nonnegativeInteger(item.lastTurnIndex));
}

function isDiscourseBindingV2(value: unknown): value is DiscourseBindingV2 {
  const item = objectRecord(value);
  return Boolean(item
    && item.schema === "scce.discourse_binding.v2"
    && nonemptyId(item.id)
    && nonemptyId(item.mentionId)
    && nonemptyId(item.referentId)
    && nonemptyId(item.topicId)
    && Array.isArray(item.provenanceBindings)
    && item.provenanceBindings.every(isProvenanceBinding)
    && Array.isArray(item.inheritedSlotBindings)
    && item.inheritedSlotBindings.every(isSlotBinding)
    && isBindingComponents(item.components)
    && unitMass(item.rawScore)
    && unitMass(item.confidence)
    && unitMass(item.runnerUpMargin)
    && typeof item.admitted === "boolean"
    && stringIdArray(item.reasonIds)
    && Array.isArray(item.alternatives)
    && item.alternatives.every(alternative => {
      const row = objectRecord(alternative);
      return Boolean(row
        && nonemptyId(row.referentId)
        && unitMass(row.rawScore)
        && unitMass(row.confidence)
        && typeof row.hardAdmissible === "boolean"
        && stringIdArray(row.reasonIds));
    }));
}

function isProvenanceBinding(value: unknown): value is DiscourseProvenanceBindingV2 {
  const item = objectRecord(value);
  return Boolean(item
    && item.schema === "scce.discourse_provenance_binding.v2"
    && nonemptyId(item.id)
    && nonemptyId(item.observationId)
    && nonemptyId(item.mentionId)
    && nonemptyId(item.referentId)
    && nonemptyId(item.routeId)
    && stringIdArray(item.nodeIds)
    && stringIdArray(item.claimIds)
    && stringIdArray(item.evidenceIds)
    && stringIdArray(item.sourceVersionIds)
    && stringIdArray(item.contradictionIds));
}

function isBindingComponents(value: unknown): value is DiscourseBindingComponentsV2 {
  const item = objectRecord(value);
  return Boolean(item && [
    "recency",
    "salience",
    "semanticRoleFit",
    "slotFit",
    "graphRouteCoherence",
    "learnedFrameFit",
    "topicContinuity",
    "evidenceFit",
    "temporalFit",
    "contradictionPenalty",
    "scopePenalty",
    "topicSwitchPenalty"
  ].every(key => unitMass(item[key])));
}

function isSlotBinding(value: unknown): value is DiscourseSlotBindingV2 {
  const item = objectRecord(value);
  return Boolean(item
    && nonemptyId(item.slotId)
    && stringIdArray(item.nodeIds)
    && stringIdArray(item.claimIds)
    && stringIdArray(item.evidenceIds));
}

function isTemporalInterval(value: unknown): value is DiscourseTemporalIntervalV2 {
  const item = objectRecord(value);
  return Boolean(item
    && finiteNumber(item.validFrom)
    && (item.validTo === undefined || finiteNumber(item.validTo))
    && (item.validTo === undefined || Number(item.validTo) >= Number(item.validFrom)));
}

function interactionRecordId(state: DialogueCognitiveStateV2, hasher: Hasher): string {
  return `interaction.discourse.v2.${hasher.digestHex(canonicalStringify(state)).slice(0, 40)}`;
}

function dialogueStateFeatureRefs(state: DialogueCognitiveStateV2): string[] {
  return canonicalIds([
    ...state.activeTopicIds,
    ...state.openSlotIds,
    ...state.referents.flatMap(item => [...item.nodeIds, ...item.claimIds]),
    ...state.topics.flatMap(item => item.anchorNodeIds),
    ...state.bindings.flatMap(item => item.provenanceBindings.flatMap(binding => [
      ...binding.nodeIds,
      ...binding.claimIds,
      ...binding.sourceVersionIds
    ]))
  ]);
}

function dialogueStateSignalRefs(state: DialogueCognitiveStateV2): string[] {
  return canonicalIds([
    ...state.bindings.map(item => item.id),
    ...state.bindings.flatMap(item => item.provenanceBindings.flatMap(binding => [
      binding.id,
      ...binding.evidenceIds,
      ...binding.contradictionIds
    ])),
    ...state.unresolvedMentionIds,
    ...state.referents.flatMap(item => [...item.evidenceIds, ...item.contradictionIds])
  ]);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonemptyId) && new Set(value).size === value.length;
}

function nonemptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.normalize("NFC") === value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unitMass(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function contradictionCoherent(referent: DiscourseReferentV2): boolean {
  return referent.contradictionIds.length === 0
    ? referent.contradictionMass === 0
    : referent.contradictionMass > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(nonemptyId))].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map(item => item.id)).size === values.length;
}
