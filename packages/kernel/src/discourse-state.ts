import type { Hasher, JsonValue } from "./types.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";

export const DISCOURSE_SIGNAL_IDS = {
  currentSurfaceSparse: "disc.signal.2b6c4a91",
  priorEvidenceCarrier: "disc.signal.73d9f0a8",
  currentSurfaceSpecific: "disc.signal.c05e411b",
  evidenceContinuity: "disc.signal.6af305e2"
} as const;

export const DISCOURSE_POLICY_IDS = {
  bindEvidenceCarrier: "disc.policy.9d1a2f6c",
  leaveUnbound: "disc.policy.b84f91e3"
} as const;

export interface DiscourseObjectState {
  schema: "scce.discourse_object_state.v1";
  objectId: string;
  stateId: string;
  sessionId?: string;
  selectedTurnId: string;
  mentionIds: string[];
  evidenceIds: string[];
  sourceVersionIds: string[];
  salienceMass: number;
  decayMass: number;
  bindingConfidence: number;
  signalIds: string[];
  policyId: string;
  surfaceHash: string;
  queryConcatenationUsed: false;
  audit: JsonValue;
}

export interface BuildDiscourseObjectStateInput {
  sessionId?: string;
  currentText: string;
  recentTurns: readonly JsonValue[];
  hasher?: Hasher;
  now?: number;
}

interface NormalizedTurn {
  id: string;
  roleId: string;
  text: string;
  evidenceIds: string[];
  sourceVersionIds: string[];
  turnIndex: number;
  createdAt: number;
}

export function buildDiscourseObjectState(input: BuildDiscourseObjectStateInput): DiscourseObjectState | undefined {
  const hasher = input.hasher ?? createHasher();
  const turns = input.recentTurns
    .map(normalizedTurn)
    .filter((turn): turn is NormalizedTurn => Boolean(turn))
    .sort((left, right) => left.turnIndex - right.turnIndex || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  if (!turns.length) return undefined;
  const carrierIndex = findEvidenceCarrierIndex(turns);
  if (carrierIndex < 0) return undefined;
  const carrier = turns[carrierIndex]!;
  const surface = surfaceSpecificity(input.currentText);
  if (surface.unitCount < 1) return undefined;
  const newestIndex = turns.length - 1;
  const turnDistance = Math.max(0, newestIndex - carrierIndex);
  const recencyMass = clamp01(1 - turnDistance / 12);
  const evidenceMass = clamp01(Math.log1p(carrier.evidenceIds.length) / Math.log1p(8));
  const sparseMass = clamp01(1 - surface.specificityMass);
  const bindingConfidence = clamp01(sparseMass * 0.58 + recencyMass * 0.18 + evidenceMass * 0.22);
  const signalIds = [
    ...(surface.specificityMass < 0.72 ? [DISCOURSE_SIGNAL_IDS.currentSurfaceSparse] : [DISCOURSE_SIGNAL_IDS.currentSurfaceSpecific]),
    DISCOURSE_SIGNAL_IDS.priorEvidenceCarrier,
    ...(carrier.evidenceIds.length ? [DISCOURSE_SIGNAL_IDS.evidenceContinuity] : [])
  ];
  if (surface.specificityMass >= 0.72 || bindingConfidence < 0.45) return undefined;
  const objectBasis = {
    sessionId: input.sessionId ?? null,
    selectedTurnId: carrier.id,
    evidenceIds: carrier.evidenceIds.slice(0, 32),
    sourceVersionIds: carrier.sourceVersionIds.slice(0, 16)
  };
  const objectId = `discourse_object_${hasher.digestHex(JSON.stringify(objectBasis)).slice(0, 32)}`;
  const stateId = `discourse_state_${hasher.digestHex(JSON.stringify({ objectBasis, current: input.currentText, now: input.now ?? 0 })).slice(0, 32)}`;
  const mentionIds = turns
    .slice(Math.max(0, carrierIndex - 3), newestIndex + 1)
    .map(turn => turn.id)
    .filter(Boolean);
  return {
    schema: "scce.discourse_object_state.v1",
    objectId,
    stateId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    selectedTurnId: carrier.id,
    mentionIds,
    evidenceIds: uniqueStrings(carrier.evidenceIds).slice(0, 64),
    sourceVersionIds: uniqueStrings(carrier.sourceVersionIds).slice(0, 32),
    salienceMass: clamp01(evidenceMass * 0.46 + recencyMass * 0.34 + sparseMass * 0.2),
    decayMass: clamp01(turnDistance / 12),
    bindingConfidence,
    signalIds: uniqueStrings(signalIds),
    policyId: DISCOURSE_POLICY_IDS.bindEvidenceCarrier,
    surfaceHash: `sha256_${hasher.digestHex(input.currentText).slice(0, 48)}`,
    queryConcatenationUsed: false,
    audit: toJsonValue({
      surface,
      turnDistance,
      evidenceMass,
      recencyMass,
      sparseMass,
      selectedTurnId: carrier.id,
      selectedEvidenceCount: carrier.evidenceIds.length,
      policyId: DISCOURSE_POLICY_IDS.bindEvidenceCarrier
    })
  };
}

export function discourseObjectStateFromMetadata(metadata: JsonValue | undefined): DiscourseObjectState | undefined {
  const record = jsonRecord(metadata);
  const discourse = jsonRecord(record.discourse);
  const active = jsonRecord(discourse.activeObject);
  if (active.schema !== "scce.discourse_object_state.v1") return undefined;
  const objectId = jsonString(active.objectId);
  const stateId = jsonString(active.stateId);
  const selectedTurnId = jsonString(active.selectedTurnId);
  if (!objectId || !stateId || !selectedTurnId) return undefined;
  return {
    schema: "scce.discourse_object_state.v1",
    objectId,
    stateId,
    ...(jsonString(active.sessionId) ? { sessionId: jsonString(active.sessionId)! } : {}),
    selectedTurnId,
    mentionIds: jsonStringArray(active.mentionIds),
    evidenceIds: jsonStringArray(active.evidenceIds),
    sourceVersionIds: jsonStringArray(active.sourceVersionIds),
    salienceMass: jsonNumber(active.salienceMass),
    decayMass: jsonNumber(active.decayMass),
    bindingConfidence: jsonNumber(active.bindingConfidence),
    signalIds: jsonStringArray(active.signalIds),
    policyId: jsonString(active.policyId) ?? "",
    surfaceHash: jsonString(active.surfaceHash) ?? "",
    queryConcatenationUsed: false,
    audit: active.audit ?? null
  };
}

export function discourseEvidenceIdsFromMetadata(metadata: JsonValue | undefined): string[] {
  return discourseObjectStateFromMetadata(metadata)?.evidenceIds ?? [];
}

function findEvidenceCarrierIndex(turns: readonly NormalizedTurn[]): number {
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index]!.evidenceIds.length) return index;
  }
  return -1;
}

function normalizedTurn(value: JsonValue): NormalizedTurn | undefined {
  const record = jsonRecord(value);
  const id = jsonString(record.id);
  const text = jsonString(record.text) ?? "";
  if (!id || !text.trim()) return undefined;
  return {
    id,
    roleId: jsonString(record.roleId) ?? "",
    text,
    evidenceIds: uniqueStrings(jsonStringArray(record.evidenceIds)),
    sourceVersionIds: uniqueStrings(jsonStringArray(record.sourceVersionIds)),
    turnIndex: jsonNumber(record.turnIndex),
    createdAt: jsonNumber(record.createdAt)
  };
}

function surfaceSpecificity(text: string): { unitCount: number; longUnitCount: number; longUnitMax: number; adjacentSpecificPairMax: number; adjacentLongRunMax: number; casedRunMax: number; uncasedLetterMass: number; specificityMass: number } {
  const units = unicodeUnits(text);
  let casedRun = 0;
  let casedRunMax = 0;
  let adjacentLongRun = 0;
  let adjacentLongRunMax = 0;
  let previousUnitLength = 0;
  let adjacentSpecificPairMax = 0;
  let uncasedLetters = 0;
  let letters = 0;
  let longUnitCount = 0;
  let longUnitMax = 0;
  for (const unit of units) {
    const length = [...unit].length;
    longUnitMax = Math.max(longUnitMax, length);
    if (previousUnitLength >= 3 && length >= 3) adjacentSpecificPairMax = Math.max(adjacentSpecificPairMax, previousUnitLength + length);
    previousUnitLength = length;
    if (length >= 4) {
      longUnitCount++;
      adjacentLongRun++;
      adjacentLongRunMax = Math.max(adjacentLongRunMax, adjacentLongRun);
    } else {
      adjacentLongRun = 0;
    }
    if (unitHasCasedLetter(unit)) {
      casedRun++;
      casedRunMax = Math.max(casedRunMax, casedRun);
    } else {
      casedRun = 0;
    }
    for (const char of unit) {
      if (!/\p{L}/u.test(char)) continue;
      letters++;
      const lower = char.toLocaleLowerCase();
      const upper = char.toLocaleUpperCase();
      if (lower === upper) uncasedLetters++;
    }
  }
  const uncasedLetterMass = letters ? clamp01(uncasedLetters / letters) : 0;
  const casedMass = casedRunMax >= 2 ? 0.72 : casedRunMax > 0 ? 0.34 : 0;
  const adjacentMass = adjacentLongRunMax >= 2 || adjacentSpecificPairMax >= 11 ? 0.78 : 0;
  const longTopicMass = longUnitMax >= 8 ? 0.78 : 0;
  const lengthMass = clamp01(longUnitCount / 3) * 0.5 + clamp01(units.length / 10) * 0.2;
  const uncasedSpecificity = uncasedLetterMass > 0
    ? Math.max(clamp01([...text].length / 28) * 0.42, units.length >= 2 ? 0.78 : 0)
    : 0;
  return {
    unitCount: units.length,
    longUnitCount,
    longUnitMax,
    adjacentSpecificPairMax,
    adjacentLongRunMax,
    casedRunMax,
    uncasedLetterMass,
    specificityMass: clamp01(Math.max(casedMass, adjacentMass, longTopicMass, lengthMass + uncasedSpecificity))
  };
}

function unicodeUnits(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    if (/\p{L}|\p{N}/u.test(char)) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out;
}

function unitHasCasedLetter(text: string): boolean {
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    const upper = char.toLocaleUpperCase();
    if (lower !== upper && char === upper && char !== lower) return true;
  }
  return false;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function jsonStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export interface DiscourseTemporalIntervalV2 {
  validFrom: number;
  validTo?: number;
}

export interface DiscourseMentionSpanV2 {
  start: number;
  end: number;
}

export interface DiscourseMentionV2 {
  schema: "scce.discourse_mention.v2";
  id: string;
  /** Present only when the producing lane owns a real offset in the observed surface. */
  span?: DiscourseMentionSpanV2;
  /** Opaque typed identities that caused a span-less graph/proof mention to exist. */
  sourceIdentityIds?: string[];
  kindId: string;
  surfaceHash: string;
  semanticRoleIds: string[];
  requestedSlotIds: string[];
  learnedFrameIds: string[];
  candidateNodeIds: string[];
  candidateReferentIds: string[];
  scopeIds: string[];
}

export interface DiscourseTurnObservationV2 {
  schema: "scce.discourse_turn_observation.v2";
  id: string;
  conversationId: string;
  sessionId?: string;
  turnId: string;
  turnIndex: number;
  roleId: string;
  surfaceHash: string;
  languageProfileId?: string;
  scriptProfileId?: string;
  learnedFrameIds: string[];
  requestedSlotIds: string[];
  explicitAnchorNodeIds: string[];
  scopeIds: string[];
  temporalScope?: DiscourseTemporalIntervalV2;
  mentions: DiscourseMentionV2[];
}

export interface DiscourseProvenanceBindingV2 {
  schema: "scce.discourse_provenance_binding.v2";
  id: string;
  observationId: string;
  mentionId: string;
  referentId: string;
  routeId: string;
  nodeIds: string[];
  claimIds: string[];
  evidenceIds: string[];
  sourceVersionIds: string[];
  contradictionIds: string[];
}

export interface DiscourseSlotBindingV2 {
  slotId: string;
  nodeIds: string[];
  claimIds: string[];
  evidenceIds: string[];
}

export interface DiscourseReferentV2 {
  schema: "scce.discourse_referent.v2";
  id: string;
  topicId: string;
  introducedTurnId: string;
  introducedTurnIndex: number;
  lastMentionTurnIndex: number;
  nodeIds: string[];
  claimIds: string[];
  relationIds: string[];
  evidenceIds: string[];
  sourceVersionIds: string[];
  contradictionIds: string[];
  semanticRoleIds: string[];
  learnedFrameIds: string[];
  scopeIds: string[];
  temporalScope?: DiscourseTemporalIntervalV2;
  slotBindings: DiscourseSlotBindingV2[];
  salienceMass: number;
  evidenceSupportMass: number;
  contradictionMass: number;
  authorityClassId: string;
}

export interface DiscourseTopicV2 {
  schema: "scce.discourse_topic.v2";
  id: string;
  statusId: string;
  anchorNodeIds: string[];
  referentIds: string[];
  claimIds: string[];
  evidenceIds: string[];
  parentTopicId?: string;
  supersedesTopicIds: string[];
  salienceMass: number;
  lastTurnIndex: number;
}

export interface DiscourseRouteSignalV2 {
  mentionId: string;
  referentId: string;
  graphRouteCoherence: number;
  evidenceFit?: number;
  temporalFit?: number;
  topicContinuity?: number;
  contradictionPressure?: number;
  scopeFit?: number;
  topicSwitchPressure?: number;
}

export interface DiscourseBindingComponentsV2 {
  recency: number;
  salience: number;
  semanticRoleFit: number;
  slotFit: number;
  graphRouteCoherence: number;
  learnedFrameFit: number;
  topicContinuity: number;
  evidenceFit: number;
  temporalFit: number;
  contradictionPenalty: number;
  scopePenalty: number;
  topicSwitchPenalty: number;
}

export interface DiscourseBindingAlternativeV2 {
  referentId: string;
  rawScore: number;
  confidence: number;
  hardAdmissible: boolean;
  reasonIds: string[];
}

export interface DiscourseBindingV2 {
  schema: "scce.discourse_binding.v2";
  id: string;
  mentionId: string;
  referentId: string;
  topicId: string;
  provenanceBindings: DiscourseProvenanceBindingV2[];
  inheritedSlotBindings: DiscourseSlotBindingV2[];
  components: DiscourseBindingComponentsV2;
  rawScore: number;
  confidence: number;
  runnerUpMargin: number;
  admitted: boolean;
  reasonIds: string[];
  alternatives: DiscourseBindingAlternativeV2[];
}

export interface DialogueCognitiveStateV2 {
  schema: "scce.dialogue_cognitive_state.v2";
  id: string;
  conversationId: string;
  sessionId?: string;
  observationId: string;
  turnId: string;
  turnIndex: number;
  activeTopicIds: string[];
  referents: DiscourseReferentV2[];
  topics: DiscourseTopicV2[];
  bindings: DiscourseBindingV2[];
  unresolvedMentionIds: string[];
  openSlotIds: string[];
  preferenceSnapshotIds: string[];
  correctionIds: string[];
  historyDigestIds: string[];
  queryConcatenationUsed: false;
  audit: JsonValue;
}

export interface DialogueContextEnvelopeV2 {
  schema: "scce.dialogue_context_envelope.v2";
  stateId: string;
  observationId: string;
  admittedBindings: DiscourseBindingV2[];
  provenanceBindingIds: string[];
  seedNodeIds: string[];
  claimIds: string[];
  evidenceIds: string[];
  sourceVersionIds: string[];
  contradictionIds: string[];
  activeTopicIds: string[];
  unresolvedMentionIds: string[];
  openSlotIds: string[];
  queryConcatenationUsed: false;
  audit: JsonValue;
}

export interface DiscourseResolverWeightsV2 {
  recency: number;
  salience: number;
  semanticRoleFit: number;
  slotFit: number;
  graphRouteCoherence: number;
  learnedFrameFit: number;
  topicContinuity: number;
  evidenceFit: number;
  temporalFit: number;
  contradictionPenalty: number;
  scopePenalty: number;
  topicSwitchPenalty: number;
}

export interface DiscourseResolverConfigV2 {
  weights: DiscourseResolverWeightsV2;
  recencyLambda: number;
  admissionThreshold: number;
  runnerUpMargin: number;
  minimumGraphRouteCoherence: number;
  maximumContradictionMass: number;
  minimumScopeFit: number;
  minimumTemporalFit: number;
  maximumTopicSwitchPressure: number;
  neutralCompatibilityMass: number;
  maxCandidatesPerMention: number;
  maxAlternativesPerBinding: number;
  maxActiveTopics: number;
  maxHistoryDigests: number;
}

export type DiscourseResolverConfigPatchV2 = Partial<Omit<DiscourseResolverConfigV2, "weights">> & {
  weights?: Partial<DiscourseResolverWeightsV2>;
};

export interface ResolveDiscourseStateV2Input {
  observation: DiscourseTurnObservationV2;
  previousState?: DialogueCognitiveStateV2;
  referents?: readonly DiscourseReferentV2[];
  topics?: readonly DiscourseTopicV2[];
  routeSignals?: readonly DiscourseRouteSignalV2[];
  provenanceBindings?: readonly DiscourseProvenanceBindingV2[];
  config?: DiscourseResolverConfigPatchV2;
  hasher?: Hasher;
}

export interface DiscourseResolutionV2 {
  schema: "scce.discourse_resolution.v2";
  state: DialogueCognitiveStateV2;
  context: DialogueContextEnvelopeV2;
  audit: JsonValue;
}

export const DEFAULT_DISCOURSE_RESOLVER_CONFIG_V2: Readonly<DiscourseResolverConfigV2> = {
  weights: {
    recency: 0.68,
    salience: 0.72,
    semanticRoleFit: 0.9,
    slotFit: 0.82,
    graphRouteCoherence: 1,
    learnedFrameFit: 0.88,
    topicContinuity: 0.76,
    evidenceFit: 0.92,
    temporalFit: 0.8,
    contradictionPenalty: 1,
    scopePenalty: 1,
    topicSwitchPenalty: 0.96
  },
  recencyLambda: 0.16,
  admissionThreshold: 0.56,
  runnerUpMargin: 0.08,
  minimumGraphRouteCoherence: 0.25,
  maximumContradictionMass: 0.64,
  minimumScopeFit: 0.5,
  minimumTemporalFit: 0.25,
  maximumTopicSwitchPressure: 0.64,
  neutralCompatibilityMass: 0.5,
  maxCandidatesPerMention: 32,
  maxAlternativesPerBinding: 8,
  maxActiveTopics: 8,
  maxHistoryDigests: 64
};

const DISCOURSE_V2_REASON_IDS = {
  admitted: "disc2.r.3d09c8a1",
  confidence: "disc2.r.99f31a60",
  margin: "disc2.r.c7a55e28",
  graphRoute: "disc2.r.bf4cd60e",
  proof: "disc2.r.271a506d",
  contradictionCoherence: "disc2.r.f30b862c",
  contradiction: "disc2.r.60d1ca84",
  scope: "disc2.r.7474b8b3",
  temporal: "disc2.r.5a90e174",
  topicSwitch: "disc2.r.d92c3f06"
} as const;

const DISCOURSE_V2_CONFIDENCE_ID = "disc2.conf.81c7342a";

interface ScoredDiscourseCandidateV2 {
  mention: DiscourseMentionV2;
  referent: DiscourseReferentV2;
  components: DiscourseBindingComponentsV2;
  rawScore: number;
  confidence: number;
  hardReasonIds: string[];
  provenanceBindings: DiscourseProvenanceBindingV2[];
  inheritedSlotBindings: DiscourseSlotBindingV2[];
}

export function createDiscourseTurnObservationV2(
  input: Omit<DiscourseTurnObservationV2, "schema" | "id">,
  hasher: Hasher = createHasher()
): DiscourseTurnObservationV2 {
  const content = discourseTurnObservationContentV2(input);
  return {
    schema: "scce.discourse_turn_observation.v2",
    id: `disc2.observation.${hasher.digestHex(canonicalJsonV2(content)).slice(0, 32)}`,
    ...content
  };
}

export function deriveDiscourseTurnObservationIdV2(
  observation: Omit<DiscourseTurnObservationV2, "schema" | "id"> | DiscourseTurnObservationV2,
  hasher: Hasher = createHasher()
): string {
  return `disc2.observation.${hasher.digestHex(canonicalJsonV2(discourseTurnObservationContentV2(observation))).slice(0, 32)}`;
}

export function createDiscourseProvenanceBindingV2(
  input: Omit<DiscourseProvenanceBindingV2, "schema" | "id">,
  hasher: Hasher = createHasher()
): DiscourseProvenanceBindingV2 {
  const content = discourseProvenanceBindingContentV2(input);
  return {
    schema: "scce.discourse_provenance_binding.v2",
    id: `disc2.provenance.${hasher.digestHex(canonicalJsonV2(content)).slice(0, 32)}`,
    ...content
  };
}

export function deriveDiscourseProvenanceBindingIdV2(
  binding: Omit<DiscourseProvenanceBindingV2, "schema" | "id"> | DiscourseProvenanceBindingV2,
  hasher: Hasher = createHasher()
): string {
  return `disc2.provenance.${hasher.digestHex(canonicalJsonV2(discourseProvenanceBindingContentV2(binding))).slice(0, 32)}`;
}

export function deriveDialogueCognitiveStateIdV2(
  state: Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> | DialogueCognitiveStateV2,
  hasher: Hasher = createHasher()
): string {
  return `disc2.state.${hasher.digestHex(canonicalJsonV2(dialogueCognitiveStateContentV2(state))).slice(0, 32)}`;
}

export function resolveDiscourseStateV2(input: ResolveDiscourseStateV2Input): DiscourseResolutionV2 {
  const hasher = input.hasher ?? createHasher();
  const config = normalizeDiscourseResolverConfigV2(input.config);
  const observation = createDiscourseTurnObservationV2(input.observation, hasher);
  const previousState = input.previousState?.conversationId === observation.conversationId
    && input.previousState.turnIndex < observation.turnIndex
    && input.previousState.id === deriveDialogueCognitiveStateIdV2(input.previousState, hasher)
    ? input.previousState
    : undefined;
  const mergedReferents = mergeDiscourseRowsById(
    (previousState?.referents ?? []).map(canonicalizeDiscourseReferentV2),
    (input.referents ?? []).map(canonicalizeDiscourseReferentV2)
  );
  const mergedTopics = mergeDiscourseRowsById(
    (previousState?.topics ?? []).map(canonicalizeDiscourseTopicV2),
    (input.topics ?? []).map(canonicalizeDiscourseTopicV2)
  );
  const repairedTopology = repairDiscourseTopologyV2(mergedReferents, mergedTopics);
  const referents = repairedTopology.referents;
  const topics = repairedTopology.topics;
  const routeSignals = discourseRouteSignalMap(input.routeSignals ?? []);
  const provenanceBindings = discourseProvenanceBindingMap(input.provenanceBindings ?? [], hasher);
  const priorActiveTopicIds = canonicalStringSetV2(previousState?.activeTopicIds ?? []);
  const mentions = [...observation.mentions]
    .sort(compareDiscourseMentionsV2);
  const requestedSlotIds = canonicalStringSetV2([
    ...(previousState?.openSlotIds ?? []),
    ...observation.requestedSlotIds,
    ...mentions.flatMap(mention => mention.requestedSlotIds)
  ]);
  const bindings: DiscourseBindingV2[] = [];
  const unresolvedMentionIds: string[] = [];

  for (const mention of mentions) {
    const scoredCandidates = candidateReferentsForMention(mention, referents)
      .map(referent => scoreDiscourseCandidateV2({
        mention,
        referent,
        observation,
        requestedSlotIds,
        priorActiveTopicIds,
        signal: routeSignals.get(discourseRouteSignalKey(mention.id, referent.id)),
        provenanceBindings: provenanceBindings.get(discourseRouteSignalKey(mention.id, referent.id)) ?? [],
        hasher,
        config
      }))
      .sort(compareScoredDiscourseCandidatesV2);
    const hardAdmissibleCandidates = scoredCandidates.filter(candidate => candidate.hardReasonIds.length === 0);
    const selected = hardAdmissibleCandidates[0] ?? scoredCandidates[0];
    if (!selected) {
      unresolvedMentionIds.push(mention.id);
      continue;
    }
    const retainedCandidates = [
      selected,
      ...scoredCandidates.filter(candidate => candidate.referent.id !== selected.referent.id)
    ].slice(0, config.maxCandidatesPerMention);
    const runnerUpPool = selected.hardReasonIds.length === 0
      ? hardAdmissibleCandidates.filter(candidate => candidate.referent.id !== selected.referent.id)
      : scoredCandidates.filter(candidate => candidate.referent.id !== selected.referent.id);
    const runnerUp = runnerUpPool[0];
    const runnerUpMargin = clamp01(selected.confidence - (runnerUp?.confidence ?? 0));
    const reasonIds = [...selected.hardReasonIds];
    if (selected.confidence < config.admissionThreshold) reasonIds.push(DISCOURSE_V2_REASON_IDS.confidence);
    if (runnerUpMargin < config.runnerUpMargin) reasonIds.push(DISCOURSE_V2_REASON_IDS.margin);
    const admitted = reasonIds.length === 0;
    if (admitted) reasonIds.push(DISCOURSE_V2_REASON_IDS.admitted);
    else unresolvedMentionIds.push(mention.id);
    const alternatives = retainedCandidates
      .filter(candidate => candidate.referent.id !== selected.referent.id)
      .slice(0, config.maxAlternativesPerBinding)
      .map(candidate => ({
        referentId: candidate.referent.id,
        rawScore: candidate.rawScore,
        confidence: candidate.confidence,
        hardAdmissible: candidate.hardReasonIds.length === 0,
        reasonIds: canonicalStringSetV2([
          ...candidate.hardReasonIds,
          ...(candidate.confidence < config.admissionThreshold ? [DISCOURSE_V2_REASON_IDS.confidence] : [])
        ])
      }));
    const bindingContent: Omit<DiscourseBindingV2, "schema" | "id"> = {
      mentionId: mention.id,
      referentId: selected.referent.id,
      topicId: selected.referent.topicId,
      provenanceBindings: selected.provenanceBindings,
      inheritedSlotBindings: canonicalizeDiscourseSlotBindingsV2(selected.inheritedSlotBindings),
      components: selected.components,
      rawScore: selected.rawScore,
      confidence: selected.confidence,
      runnerUpMargin,
      admitted,
      reasonIds: canonicalStringSetV2(reasonIds),
      alternatives
    };
    bindings.push({
      schema: "scce.discourse_binding.v2",
      id: `disc2.binding.${hasher.digestHex(canonicalJsonV2({ observationId: observation.id, ...bindingContent })).slice(0, 32)}`,
      ...bindingContent
    });
  }

  const admittedBindings = bindings.filter(binding => binding.admitted);
  const refreshedReferents = refreshAdmittedReferentsV2(referents, admittedBindings, observation.turnIndex);
  const refreshedTopics = refreshAdmittedTopicsV2(topics, refreshedReferents, admittedBindings, observation.turnIndex);
  const activeTopicIds = selectedActiveTopicIdsV2({
    observation,
    admittedBindings,
    referents: refreshedReferents,
    topics: refreshedTopics,
    priorActiveTopicIds,
    maxActiveTopics: config.maxActiveTopics
  });
  const filledSlotIds = new Set(admittedBindings.flatMap(binding => (
    binding.inheritedSlotBindings.filter(proofBearingDiscourseSlotBindingV2).map(slot => slot.slotId)
  )));
  const openSlotIds = requestedSlotIds.filter(slotId => !filledSlotIds.has(slotId));
  const preferenceSnapshotIds = canonicalStringSetV2(previousState?.preferenceSnapshotIds ?? []);
  const correctionIds = canonicalStringSetV2(previousState?.correctionIds ?? []);
  const historyDigestIds = uniqueStrings([...(previousState?.historyDigestIds ?? []), observation.id]).slice(-config.maxHistoryDigests);
  const canonicalUnresolvedMentionIds = canonicalStringSetV2(unresolvedMentionIds);
  const sessionId = observation.sessionId ?? previousState?.sessionId;
  const stateContent = {
    conversationId: observation.conversationId,
    ...(sessionId ? { sessionId } : {}),
    observationId: observation.id,
    turnId: observation.turnId,
    turnIndex: observation.turnIndex,
    activeTopicIds,
    referents: refreshedReferents,
    topics: refreshedTopics,
    bindings,
    unresolvedMentionIds: canonicalUnresolvedMentionIds,
    openSlotIds,
    preferenceSnapshotIds,
    correctionIds,
    historyDigestIds,
    queryConcatenationUsed: false as const
  };
  const stateId = deriveDialogueCognitiveStateIdV2(stateContent, hasher);
  const state: DialogueCognitiveStateV2 = {
    schema: "scce.dialogue_cognitive_state.v2",
    id: stateId,
    ...stateContent,
    audit: toJsonValue({
      confidenceId: DISCOURSE_V2_CONFIDENCE_ID,
      observationId: observation.id,
      mentionCount: mentions.length,
      bindingCount: bindings.length,
      admittedBindingCount: admittedBindings.length,
      queryConcatenationUsed: false
    })
  };
  const admittedProvenanceBindings = admittedBindings.flatMap(binding => binding.provenanceBindings);
  const context: DialogueContextEnvelopeV2 = {
    schema: "scce.dialogue_context_envelope.v2",
    stateId,
    observationId: observation.id,
    admittedBindings,
    provenanceBindingIds: canonicalStringSetV2(admittedProvenanceBindings.map(binding => binding.id)),
    seedNodeIds: canonicalStringSetV2(admittedProvenanceBindings.flatMap(binding => binding.nodeIds)),
    claimIds: canonicalStringSetV2(admittedProvenanceBindings.flatMap(binding => binding.claimIds)),
    evidenceIds: canonicalStringSetV2(admittedProvenanceBindings.flatMap(binding => binding.evidenceIds)),
    sourceVersionIds: canonicalStringSetV2(admittedProvenanceBindings.flatMap(binding => binding.sourceVersionIds)),
    contradictionIds: canonicalStringSetV2(admittedProvenanceBindings.flatMap(binding => binding.contradictionIds)),
    activeTopicIds,
    unresolvedMentionIds: state.unresolvedMentionIds,
    openSlotIds,
    queryConcatenationUsed: false,
    audit: toJsonValue({
      confidenceId: DISCOURSE_V2_CONFIDENCE_ID,
      bindingIds: admittedBindings.map(binding => binding.id),
      provenanceBindingIds: canonicalStringSetV2(admittedProvenanceBindings.map(binding => binding.id)),
      queryConcatenationUsed: false
    })
  };
  return {
    schema: "scce.discourse_resolution.v2",
    state,
    context,
    audit: toJsonValue({
      confidenceId: DISCOURSE_V2_CONFIDENCE_ID,
      config,
      stateId,
      observationId: observation.id,
      queryConcatenationUsed: false
    })
  };
}

function normalizeDiscourseResolverConfigV2(patch: DiscourseResolverConfigPatchV2 | undefined): DiscourseResolverConfigV2 {
  const defaults = DEFAULT_DISCOURSE_RESOLVER_CONFIG_V2;
  const boundedWeight = (value: number | undefined, fallback: number) => clamp01(finiteNumber(value, fallback));
  const boundedCount = (value: number | undefined, fallback: number, maximum: number) => Math.max(1, Math.min(maximum, Math.floor(finiteNumber(value, fallback))));
  return {
    weights: {
      recency: boundedWeight(patch?.weights?.recency, defaults.weights.recency),
      salience: boundedWeight(patch?.weights?.salience, defaults.weights.salience),
      semanticRoleFit: boundedWeight(patch?.weights?.semanticRoleFit, defaults.weights.semanticRoleFit),
      slotFit: boundedWeight(patch?.weights?.slotFit, defaults.weights.slotFit),
      graphRouteCoherence: boundedWeight(patch?.weights?.graphRouteCoherence, defaults.weights.graphRouteCoherence),
      learnedFrameFit: boundedWeight(patch?.weights?.learnedFrameFit, defaults.weights.learnedFrameFit),
      topicContinuity: boundedWeight(patch?.weights?.topicContinuity, defaults.weights.topicContinuity),
      evidenceFit: boundedWeight(patch?.weights?.evidenceFit, defaults.weights.evidenceFit),
      temporalFit: boundedWeight(patch?.weights?.temporalFit, defaults.weights.temporalFit),
      contradictionPenalty: boundedWeight(patch?.weights?.contradictionPenalty, defaults.weights.contradictionPenalty),
      scopePenalty: boundedWeight(patch?.weights?.scopePenalty, defaults.weights.scopePenalty),
      topicSwitchPenalty: boundedWeight(patch?.weights?.topicSwitchPenalty, defaults.weights.topicSwitchPenalty)
    },
    recencyLambda: clamp01(finiteNumber(patch?.recencyLambda, defaults.recencyLambda)),
    admissionThreshold: clamp01(finiteNumber(patch?.admissionThreshold, defaults.admissionThreshold)),
    runnerUpMargin: clamp01(finiteNumber(patch?.runnerUpMargin, defaults.runnerUpMargin)),
    minimumGraphRouteCoherence: clamp01(finiteNumber(patch?.minimumGraphRouteCoherence, defaults.minimumGraphRouteCoherence)),
    maximumContradictionMass: clamp01(finiteNumber(patch?.maximumContradictionMass, defaults.maximumContradictionMass)),
    minimumScopeFit: clamp01(finiteNumber(patch?.minimumScopeFit, defaults.minimumScopeFit)),
    minimumTemporalFit: clamp01(finiteNumber(patch?.minimumTemporalFit, defaults.minimumTemporalFit)),
    maximumTopicSwitchPressure: clamp01(finiteNumber(patch?.maximumTopicSwitchPressure, defaults.maximumTopicSwitchPressure)),
    neutralCompatibilityMass: clamp01(finiteNumber(patch?.neutralCompatibilityMass, defaults.neutralCompatibilityMass)),
    maxCandidatesPerMention: boundedCount(patch?.maxCandidatesPerMention, defaults.maxCandidatesPerMention, 256),
    maxAlternativesPerBinding: boundedCount(patch?.maxAlternativesPerBinding, defaults.maxAlternativesPerBinding, 64),
    maxActiveTopics: boundedCount(patch?.maxActiveTopics, defaults.maxActiveTopics, 64),
    maxHistoryDigests: boundedCount(patch?.maxHistoryDigests, defaults.maxHistoryDigests, 512)
  };
}

function scoreDiscourseCandidateV2(input: {
  mention: DiscourseMentionV2;
  referent: DiscourseReferentV2;
  observation: DiscourseTurnObservationV2;
  requestedSlotIds: readonly string[];
  priorActiveTopicIds: readonly string[];
  signal?: DiscourseRouteSignalV2;
  provenanceBindings: readonly DiscourseProvenanceBindingV2[];
  hasher: Hasher;
  config: DiscourseResolverConfigV2;
}): ScoredDiscourseCandidateV2 {
  const { mention, referent, observation, signal, config } = input;
  const validProvenanceBindings = canonicalizeCandidateProvenanceBindingsV2({
    bindings: input.provenanceBindings,
    observationId: observation.id,
    mentionId: mention.id,
    referent,
    hasher: input.hasher
  });
  const contradictionCoherent = discourseContradictionCoherentV2(referent)
    && sameCanonicalStringSetV2(
      validProvenanceBindings.flatMap(binding => binding.contradictionIds),
      referent.contradictionIds
    );
  const candidateNodeFit = setCompatibilityMass(mention.candidateNodeIds, referent.nodeIds, config.neutralCompatibilityMass);
  const roleFit = setCompatibilityMass(mention.semanticRoleIds, referent.semanticRoleIds, config.neutralCompatibilityMass);
  const requestedSlotIds = new Set(input.requestedSlotIds);
  const provedNodeIds = new Set(validProvenanceBindings.flatMap(binding => binding.nodeIds));
  const provedClaimIds = new Set(validProvenanceBindings.flatMap(binding => binding.claimIds));
  const provedEvidenceIds = new Set(validProvenanceBindings.flatMap(binding => binding.evidenceIds));
  const inheritedSlotBindings = canonicalizeDiscourseSlotBindingsV2(
    referent.slotBindings.filter(slot => requestedSlotIds.has(slot.slotId)
      && proofBearingDiscourseSlotBindingV2(slot)
      && slot.nodeIds.every(id => provedNodeIds.has(id))
      && slot.claimIds.every(id => provedClaimIds.has(id))
      && slot.evidenceIds.every(id => provedEvidenceIds.has(id)))
  );
  const filledSlotIds = new Set(inheritedSlotBindings.map(slot => slot.slotId));
  const slotFit = requestedSlotIds.size
    ? clamp01(filledSlotIds.size / requestedSlotIds.size)
    : config.neutralCompatibilityMass;
  const frameFit = setCompatibilityMass(
    canonicalStringSetV2([...observation.learnedFrameIds, ...mention.learnedFrameIds]),
    referent.learnedFrameIds,
    config.neutralCompatibilityMass
  );
  const explicitAnchorFit = setIntersectionMass(observation.explicitAnchorNodeIds, referent.nodeIds);
  const graphRouteCoherence = clamp01(signal?.graphRouteCoherence ?? 0);
  const temporalFitBase = temporalCompatibilityMass(observation.temporalScope, referent.temporalScope, config.neutralCompatibilityMass);
  const temporalFit = clamp01(signal?.temporalFit === undefined ? temporalFitBase : Math.min(temporalFitBase, clamp01(signal.temporalFit)));
  const scopeFitBase = setRequiredScopeFit(canonicalStringSetV2([...observation.scopeIds, ...mention.scopeIds]), referent.scopeIds);
  const scopeFit = clamp01(signal?.scopeFit === undefined ? scopeFitBase : Math.min(scopeFitBase, clamp01(signal.scopeFit)));
  const topicContinuityBase = observation.explicitAnchorNodeIds.length
    ? explicitAnchorFit
    : input.priorActiveTopicIds.length
      ? input.priorActiveTopicIds.includes(referent.topicId) ? 1 : 0
      : config.neutralCompatibilityMass;
  const topicContinuity = clamp01(signal?.topicContinuity === undefined ? topicContinuityBase : Math.min(topicContinuityBase, clamp01(signal.topicContinuity)));
  const evidenceFitBase = validProvenanceBindings.length ? clamp01(referent.evidenceSupportMass) : 0;
  const evidenceFit = clamp01(signal?.evidenceFit === undefined ? evidenceFitBase : Math.min(evidenceFitBase, clamp01(signal.evidenceFit)));
  const topicSwitchPenaltyBase = observation.explicitAnchorNodeIds.length && explicitAnchorFit === 0 ? 1 : 0;
  const topicSwitchPenalty = clamp01(Math.max(topicSwitchPenaltyBase, signal?.topicSwitchPressure ?? 0));
  const contradictionPenalty = clamp01(Math.max(referent.contradictionMass, signal?.contradictionPressure ?? 0));
  const components: DiscourseBindingComponentsV2 = {
    recency: clamp01(Math.exp(-config.recencyLambda * Math.max(0, observation.turnIndex - referent.lastMentionTurnIndex))),
    salience: clamp01(referent.salienceMass),
    semanticRoleFit: roleFit,
    slotFit,
    graphRouteCoherence,
    learnedFrameFit: frameFit,
    topicContinuity,
    evidenceFit,
    temporalFit,
    contradictionPenalty,
    scopePenalty: clamp01(1 - scopeFit),
    topicSwitchPenalty
  };
  const positiveRows: Array<[number, number]> = [
    [config.weights.recency, components.recency],
    [config.weights.salience, components.salience],
    [config.weights.semanticRoleFit, components.semanticRoleFit],
    [config.weights.slotFit, components.slotFit],
    [config.weights.graphRouteCoherence, components.graphRouteCoherence],
    [config.weights.learnedFrameFit, components.learnedFrameFit],
    [config.weights.topicContinuity, components.topicContinuity],
    [config.weights.evidenceFit, components.evidenceFit],
    [config.weights.temporalFit, components.temporalFit]
  ];
  const penaltyRows: Array<[number, number]> = [
    [config.weights.contradictionPenalty, components.contradictionPenalty],
    [config.weights.scopePenalty, components.scopePenalty],
    [config.weights.topicSwitchPenalty, components.topicSwitchPenalty]
  ];
  const positiveMass = boundedWeightedMean(positiveRows);
  const penaltyMass = boundedWeightedMean(penaltyRows);
  const rawScore = clamp01(positiveMass * (1 - penaltyMass));
  const hardReasonIds: string[] = [];
  if (!signal || graphRouteCoherence < config.minimumGraphRouteCoherence) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.graphRoute);
  if (!validProvenanceBindings.length) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.proof);
  if (!contradictionCoherent) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.contradictionCoherence);
  if (contradictionPenalty > config.maximumContradictionMass) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.contradiction);
  if (scopeFit < config.minimumScopeFit) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.scope);
  if (temporalFit < config.minimumTemporalFit) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.temporal);
  if (topicSwitchPenalty > config.maximumTopicSwitchPressure) hardReasonIds.push(DISCOURSE_V2_REASON_IDS.topicSwitch);
  return {
    mention,
    referent,
    components,
    rawScore,
    confidence: rawScore,
    hardReasonIds,
    provenanceBindings: validProvenanceBindings,
    inheritedSlotBindings
  };
}

function candidateReferentsForMention(mention: DiscourseMentionV2, referents: readonly DiscourseReferentV2[]): DiscourseReferentV2[] {
  const explicitReferentIds = new Set(canonicalStringSetV2(mention.candidateReferentIds));
  if (explicitReferentIds.size) return referents.filter(referent => explicitReferentIds.has(referent.id));
  const candidateNodeIds = new Set(canonicalStringSetV2(mention.candidateNodeIds));
  if (candidateNodeIds.size) {
    const nodeMatched = referents.filter(referent => referent.nodeIds.some(nodeId => candidateNodeIds.has(nodeId)));
    if (nodeMatched.length) return nodeMatched;
  }
  return [...referents];
}

function selectedActiveTopicIdsV2(input: {
  observation: DiscourseTurnObservationV2;
  admittedBindings: readonly DiscourseBindingV2[];
  referents: readonly DiscourseReferentV2[];
  topics: readonly DiscourseTopicV2[];
  priorActiveTopicIds: readonly string[];
  maxActiveTopics: number;
}): string[] {
  const explicitAnchorIds = new Set(canonicalStringSetV2(input.observation.explicitAnchorNodeIds));
  const explicitTopicIds = explicitAnchorIds.size
    ? canonicalStringSetV2([
      ...input.referents.filter(referent => referent.nodeIds.some(id => explicitAnchorIds.has(id))).map(referent => referent.topicId),
      ...input.topics.filter(topic => topic.anchorNodeIds.some(id => explicitAnchorIds.has(id))).map(topic => topic.id)
    ])
    : [];
  const admittedTopicIds = canonicalStringSetV2(input.admittedBindings.map(binding => binding.topicId));
  if (explicitAnchorIds.size) return prioritizedStringSetV2(admittedTopicIds, explicitTopicIds, input.maxActiveTopics);
  return prioritizedStringSetV2(admittedTopicIds, input.priorActiveTopicIds, input.maxActiveTopics);
}

function discourseRouteSignalMap(signals: readonly DiscourseRouteSignalV2[]): Map<string, DiscourseRouteSignalV2> {
  const ordered = signals.map(canonicalizeDiscourseRouteSignalV2).sort((left, right) => {
    const keyOrder = compareCodePointsV2(
      discourseRouteSignalKey(left.mentionId, left.referentId),
      discourseRouteSignalKey(right.mentionId, right.referentId)
    );
    if (keyOrder !== 0) return keyOrder;
    return compareCodePointsV2(canonicalJsonV2(left), canonicalJsonV2(right));
  });
  const out = new Map<string, DiscourseRouteSignalV2>();
  for (const signal of ordered) {
    const key = discourseRouteSignalKey(signal.mentionId, signal.referentId);
    if (!out.has(key)) out.set(key, signal);
  }
  return out;
}

function discourseProvenanceBindingMap(
  bindings: readonly DiscourseProvenanceBindingV2[],
  hasher: Hasher
): Map<string, DiscourseProvenanceBindingV2[]> {
  const out = new Map<string, DiscourseProvenanceBindingV2[]>();
  for (const binding of bindings) {
    if (binding.schema !== "scce.discourse_provenance_binding.v2") continue;
    const canonical = createDiscourseProvenanceBindingV2(binding, hasher);
    if (canonical.id !== binding.id) continue;
    const key = discourseRouteSignalKey(canonical.mentionId, canonical.referentId);
    const rows = out.get(key) ?? [];
    if (!rows.some(row => row.id === canonical.id)) rows.push(canonical);
    out.set(key, rows.sort((left, right) => compareCodePointsV2(left.id, right.id)));
  }
  return out;
}

function canonicalizeCandidateProvenanceBindingsV2(input: {
  bindings: readonly DiscourseProvenanceBindingV2[];
  observationId: string;
  mentionId: string;
  referent: DiscourseReferentV2;
  hasher: Hasher;
}): DiscourseProvenanceBindingV2[] {
  const byId = new Map<string, DiscourseProvenanceBindingV2>();
  for (const binding of input.bindings) {
    const canonical = createDiscourseProvenanceBindingV2(binding, input.hasher);
    if (canonical.id !== binding.id
      || canonical.observationId !== input.observationId
      || canonical.mentionId !== input.mentionId
      || canonical.referentId !== input.referent.id
      || !isDiscourseProvenanceBindingForReferentV2(canonical, input.referent, input.hasher)) continue;
    byId.set(canonical.id, canonical);
  }
  return [...byId.values()].sort((left, right) => compareCodePointsV2(left.id, right.id));
}

export function isDiscourseProvenanceBindingForReferentV2(
  binding: DiscourseProvenanceBindingV2,
  referent: DiscourseReferentV2,
  hasher: Hasher = createHasher()
): boolean {
  if (binding.schema !== "scce.discourse_provenance_binding.v2"
    || binding.id !== deriveDiscourseProvenanceBindingIdV2(binding, hasher)
    || !binding.observationId.trim()
    || !binding.mentionId.trim()
    || !binding.referentId.trim()
    || !binding.routeId.trim()
    || binding.referentId !== referent.id) return false;
  const allowedNodeIds = canonicalStringSetV2([
    ...referent.nodeIds,
    ...referent.slotBindings.flatMap(slot => slot.nodeIds)
  ]);
  const allowedClaimIds = canonicalStringSetV2([
    ...referent.claimIds,
    ...referent.slotBindings.flatMap(slot => slot.claimIds)
  ]);
  const allowedEvidenceIds = canonicalStringSetV2([
    ...referent.evidenceIds,
    ...referent.slotBindings.flatMap(slot => slot.evidenceIds)
  ]);
  return binding.evidenceIds.length > 0
    && binding.sourceVersionIds.length > 0
    && binding.nodeIds.length + binding.claimIds.length > 0
    && isSubsetV2(binding.nodeIds, allowedNodeIds)
    && isSubsetV2(binding.claimIds, allowedClaimIds)
    && isSubsetV2(binding.evidenceIds, allowedEvidenceIds)
    && isSubsetV2(binding.sourceVersionIds, referent.sourceVersionIds)
    && isSubsetV2(binding.contradictionIds, referent.contradictionIds);
}

function discourseRouteSignalKey(mentionId: string, referentId: string): string {
  return `${mentionId}\u001f${referentId}`;
}

function compareScoredDiscourseCandidatesV2(left: ScoredDiscourseCandidateV2, right: ScoredDiscourseCandidateV2): number {
  return right.confidence - left.confidence || right.rawScore - left.rawScore || compareCodePointsV2(left.referent.id, right.referent.id);
}

function setCompatibilityMass(left: readonly string[], right: readonly string[], neutral: number): number {
  const leftSet = new Set(canonicalStringSetV2(left));
  const rightSet = new Set(canonicalStringSetV2(right));
  if (!leftSet.size && !rightSet.size) return neutral;
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection++;
  return clamp01(intersection / new Set([...leftSet, ...rightSet]).size);
}

function setIntersectionMass(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(canonicalStringSetV2(left));
  const rightSet = new Set(canonicalStringSetV2(right));
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection++;
  return clamp01(intersection / Math.max(1, Math.min(leftSet.size, rightSet.size)));
}

function setRequiredScopeFit(required: readonly string[], available: readonly string[]): number {
  const requiredSet = new Set(canonicalStringSetV2(required));
  const availableSet = new Set(canonicalStringSetV2(available));
  if (!requiredSet.size) return 1;
  if (!availableSet.size) return 0;
  let intersection = 0;
  for (const value of requiredSet) if (availableSet.has(value)) intersection++;
  return clamp01(intersection / requiredSet.size);
}

function isSubsetV2(values: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(canonicalStringSetV2(allowed));
  return canonicalStringSetV2(values).every(value => allowedSet.has(value));
}

function sameCanonicalStringSetV2(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = canonicalStringSetV2(left);
  const canonicalRight = canonicalStringSetV2(right);
  return canonicalLeft.length === canonicalRight.length
    && canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function discourseContradictionCoherentV2(referent: DiscourseReferentV2): boolean {
  const contradictionCount = canonicalStringSetV2(referent.contradictionIds).length;
  return contradictionCount === 0 ? referent.contradictionMass === 0 : referent.contradictionMass > 0;
}

function temporalCompatibilityMass(left: DiscourseTemporalIntervalV2 | undefined, right: DiscourseTemporalIntervalV2 | undefined, neutral: number): number {
  if (!left || !right) return neutral;
  const leftEnd = Number.isFinite(left.validTo) ? left.validTo! : Number.POSITIVE_INFINITY;
  const rightEnd = Number.isFinite(right.validTo) ? right.validTo! : Number.POSITIVE_INFINITY;
  return Math.max(left.validFrom, right.validFrom) <= Math.min(leftEnd, rightEnd) ? 1 : 0;
}

function boundedWeightedMean(rows: readonly (readonly [number, number])[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const [rawWeight, rawValue] of rows) {
    const weight = clamp01(finiteNumber(rawWeight, 0));
    if (weight <= 0) continue;
    numerator += weight * clamp01(finiteNumber(rawValue, 0));
    denominator += weight;
  }
  return denominator > 0 ? clamp01(numerator / denominator) : 0;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function proofBearingDiscourseSlotBindingV2(binding: DiscourseSlotBindingV2): boolean {
  return canonicalStringSetV2(binding.evidenceIds).length > 0
    && canonicalStringSetV2([...binding.nodeIds, ...binding.claimIds]).length > 0;
}

function canonicalizeDiscourseSlotBindingV2(binding: DiscourseSlotBindingV2): DiscourseSlotBindingV2 {
  return {
    slotId: binding.slotId.trim(),
    nodeIds: canonicalStringSetV2(binding.nodeIds),
    claimIds: canonicalStringSetV2(binding.claimIds),
    evidenceIds: canonicalStringSetV2(binding.evidenceIds)
  };
}

function canonicalizeDiscourseSlotBindingsV2(bindings: readonly DiscourseSlotBindingV2[]): DiscourseSlotBindingV2[] {
  const byContent = new Map<string, DiscourseSlotBindingV2>();
  for (const binding of bindings.map(canonicalizeDiscourseSlotBindingV2)) {
    const key = canonicalJsonV2(binding);
    if (!byContent.has(key)) byContent.set(key, binding);
  }
  return [...byContent.values()].sort((left, right) => (
    compareCodePointsV2(left.slotId, right.slotId)
    || compareCodePointsV2(canonicalJsonV2(left), canonicalJsonV2(right))
  ));
}

function discourseTurnObservationContentV2(
  observation: Omit<DiscourseTurnObservationV2, "schema" | "id"> | DiscourseTurnObservationV2
): Omit<DiscourseTurnObservationV2, "schema" | "id"> {
  const mentions = observation.mentions.map(canonicalizeDiscourseMentionV2).sort((left, right) => (
    compareDiscourseMentionsV2(left, right)
  ));
  const sessionId = observation.sessionId?.trim();
  const languageProfileId = observation.languageProfileId?.trim();
  const scriptProfileId = observation.scriptProfileId?.trim();
  return {
    conversationId: observation.conversationId.trim(),
    ...(sessionId ? { sessionId } : {}),
    turnId: observation.turnId.trim(),
    turnIndex: Math.max(0, Math.floor(finiteNumber(observation.turnIndex, 0))),
    roleId: observation.roleId.trim(),
    surfaceHash: observation.surfaceHash.trim(),
    ...(languageProfileId ? { languageProfileId } : {}),
    ...(scriptProfileId ? { scriptProfileId } : {}),
    learnedFrameIds: canonicalStringSetV2(observation.learnedFrameIds),
    requestedSlotIds: canonicalStringSetV2(observation.requestedSlotIds),
    explicitAnchorNodeIds: canonicalStringSetV2(observation.explicitAnchorNodeIds),
    scopeIds: canonicalStringSetV2(observation.scopeIds),
    ...(observation.temporalScope ? { temporalScope: canonicalizeDiscourseTemporalIntervalV2(observation.temporalScope) } : {}),
    mentions
  };
}

function canonicalizeDiscourseMentionV2(mention: DiscourseMentionV2): DiscourseMentionV2 {
  const span = mention.span
    ? (() => {
      const start = Math.max(0, Math.floor(finiteNumber(mention.span?.start, 0)));
      const end = Math.max(start, Math.floor(finiteNumber(mention.span?.end, start)));
      return { start, end };
    })()
    : undefined;
  const sourceIdentityIds = canonicalStringSetV2(mention.sourceIdentityIds ?? []);
  if (!span && !sourceIdentityIds.length) throw new Error("discourse mention requires a real span or source identity");
  return {
    schema: "scce.discourse_mention.v2",
    id: mention.id.trim(),
    ...(span ? { span } : {}),
    ...(sourceIdentityIds.length ? { sourceIdentityIds } : {}),
    kindId: mention.kindId.trim(),
    surfaceHash: mention.surfaceHash.trim(),
    semanticRoleIds: canonicalStringSetV2(mention.semanticRoleIds),
    requestedSlotIds: canonicalStringSetV2(mention.requestedSlotIds),
    learnedFrameIds: canonicalStringSetV2(mention.learnedFrameIds),
    candidateNodeIds: canonicalStringSetV2(mention.candidateNodeIds),
    candidateReferentIds: canonicalStringSetV2(mention.candidateReferentIds),
    scopeIds: canonicalStringSetV2(mention.scopeIds)
  };
}

function compareDiscourseMentionsV2(left: DiscourseMentionV2, right: DiscourseMentionV2): number {
  const leftStart = left.span?.start ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.span?.start ?? Number.MAX_SAFE_INTEGER;
  const leftEnd = left.span?.end ?? Number.MAX_SAFE_INTEGER;
  const rightEnd = right.span?.end ?? Number.MAX_SAFE_INTEGER;
  return leftStart - rightStart || leftEnd - rightEnd || compareCodePointsV2(left.id, right.id);
}

function discourseProvenanceBindingContentV2(
  binding: Omit<DiscourseProvenanceBindingV2, "schema" | "id"> | DiscourseProvenanceBindingV2
): Omit<DiscourseProvenanceBindingV2, "schema" | "id"> {
  return {
    observationId: binding.observationId.trim(),
    mentionId: binding.mentionId.trim(),
    referentId: binding.referentId.trim(),
    routeId: binding.routeId.trim(),
    nodeIds: canonicalStringSetV2(binding.nodeIds),
    claimIds: canonicalStringSetV2(binding.claimIds),
    evidenceIds: canonicalStringSetV2(binding.evidenceIds),
    sourceVersionIds: canonicalStringSetV2(binding.sourceVersionIds),
    contradictionIds: canonicalStringSetV2(binding.contradictionIds)
  };
}

function dialogueCognitiveStateContentV2(
  state: Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> | DialogueCognitiveStateV2
): Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> {
  return {
    conversationId: state.conversationId,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    observationId: state.observationId,
    turnId: state.turnId,
    turnIndex: state.turnIndex,
    activeTopicIds: state.activeTopicIds,
    referents: state.referents,
    topics: state.topics,
    bindings: state.bindings,
    unresolvedMentionIds: state.unresolvedMentionIds,
    openSlotIds: state.openSlotIds,
    preferenceSnapshotIds: state.preferenceSnapshotIds,
    correctionIds: state.correctionIds,
    historyDigestIds: state.historyDigestIds,
    queryConcatenationUsed: false
  };
}

function canonicalizeDiscourseReferentV2(referent: DiscourseReferentV2): DiscourseReferentV2 {
  return {
    schema: "scce.discourse_referent.v2",
    id: referent.id.trim(),
    topicId: referent.topicId.trim(),
    introducedTurnId: referent.introducedTurnId.trim(),
    introducedTurnIndex: Math.floor(finiteNumber(referent.introducedTurnIndex, 0)),
    lastMentionTurnIndex: Math.floor(finiteNumber(referent.lastMentionTurnIndex, 0)),
    nodeIds: canonicalStringSetV2(referent.nodeIds),
    claimIds: canonicalStringSetV2(referent.claimIds),
    relationIds: canonicalStringSetV2(referent.relationIds),
    evidenceIds: canonicalStringSetV2(referent.evidenceIds),
    sourceVersionIds: canonicalStringSetV2(referent.sourceVersionIds),
    contradictionIds: canonicalStringSetV2(referent.contradictionIds),
    semanticRoleIds: canonicalStringSetV2(referent.semanticRoleIds),
    learnedFrameIds: canonicalStringSetV2(referent.learnedFrameIds),
    scopeIds: canonicalStringSetV2(referent.scopeIds),
    ...(referent.temporalScope ? { temporalScope: canonicalizeDiscourseTemporalIntervalV2(referent.temporalScope) } : {}),
    slotBindings: canonicalizeDiscourseSlotBindingsV2(referent.slotBindings),
    salienceMass: clamp01(finiteNumber(referent.salienceMass, 0)),
    evidenceSupportMass: clamp01(finiteNumber(referent.evidenceSupportMass, 0)),
    contradictionMass: clamp01(finiteNumber(referent.contradictionMass, 0)),
    authorityClassId: referent.authorityClassId.trim()
  };
}

function canonicalizeDiscourseTopicV2(topic: DiscourseTopicV2): DiscourseTopicV2 {
  return {
    schema: "scce.discourse_topic.v2",
    id: topic.id.trim(),
    statusId: topic.statusId.trim(),
    anchorNodeIds: canonicalStringSetV2(topic.anchorNodeIds),
    referentIds: canonicalStringSetV2(topic.referentIds),
    claimIds: canonicalStringSetV2(topic.claimIds),
    evidenceIds: canonicalStringSetV2(topic.evidenceIds),
    ...(topic.parentTopicId ? { parentTopicId: topic.parentTopicId.trim() } : {}),
    supersedesTopicIds: canonicalStringSetV2(topic.supersedesTopicIds),
    salienceMass: clamp01(finiteNumber(topic.salienceMass, 0)),
    lastTurnIndex: Math.floor(finiteNumber(topic.lastTurnIndex, 0))
  };
}

function canonicalizeDiscourseTemporalIntervalV2(interval: DiscourseTemporalIntervalV2): DiscourseTemporalIntervalV2 {
  return {
    validFrom: finiteNumber(interval.validFrom, 0),
    ...(interval.validTo !== undefined ? { validTo: finiteNumber(interval.validTo, interval.validFrom) } : {})
  };
}

function canonicalizeDiscourseRouteSignalV2(signal: DiscourseRouteSignalV2): DiscourseRouteSignalV2 {
  return {
    mentionId: signal.mentionId.trim(),
    referentId: signal.referentId.trim(),
    graphRouteCoherence: clamp01(finiteNumber(signal.graphRouteCoherence, 0)),
    ...(signal.evidenceFit !== undefined ? { evidenceFit: clamp01(finiteNumber(signal.evidenceFit, 0)) } : {}),
    ...(signal.temporalFit !== undefined ? { temporalFit: clamp01(finiteNumber(signal.temporalFit, 0)) } : {}),
    ...(signal.topicContinuity !== undefined ? { topicContinuity: clamp01(finiteNumber(signal.topicContinuity, 0)) } : {}),
    ...(signal.contradictionPressure !== undefined ? { contradictionPressure: clamp01(finiteNumber(signal.contradictionPressure, 1)) } : {}),
    ...(signal.scopeFit !== undefined ? { scopeFit: clamp01(finiteNumber(signal.scopeFit, 0)) } : {}),
    ...(signal.topicSwitchPressure !== undefined ? { topicSwitchPressure: clamp01(finiteNumber(signal.topicSwitchPressure, 1)) } : {})
  };
}

function refreshAdmittedReferentsV2(
  referents: readonly DiscourseReferentV2[],
  admittedBindings: readonly DiscourseBindingV2[],
  turnIndex: number
): DiscourseReferentV2[] {
  const confidenceByReferent = new Map<string, number>();
  for (const binding of admittedBindings) {
    confidenceByReferent.set(
      binding.referentId,
      Math.max(confidenceByReferent.get(binding.referentId) ?? 0, clamp01(binding.confidence))
    );
  }
  return referents.map(referent => {
    const confidence = confidenceByReferent.get(referent.id);
    if (confidence === undefined) return canonicalizeDiscourseReferentV2(referent);
    return canonicalizeDiscourseReferentV2({
      ...referent,
      lastMentionTurnIndex: Math.max(referent.lastMentionTurnIndex, Math.floor(finiteNumber(turnIndex, referent.lastMentionTurnIndex))),
      salienceMass: clamp01(referent.salienceMass + (1 - referent.salienceMass) * confidence)
    });
  }).sort((left, right) => compareCodePointsV2(left.id, right.id));
}

function repairDiscourseTopologyV2(
  referents: readonly DiscourseReferentV2[],
  topics: readonly DiscourseTopicV2[]
): { referents: DiscourseReferentV2[]; topics: DiscourseTopicV2[] } {
  const canonicalTopics = dedupeDiscourseRowsById(topics.map(canonicalizeDiscourseTopicV2));
  const topicIds = new Set(canonicalTopics.map(topic => topic.id));
  const canonicalReferents = dedupeDiscourseRowsById(referents.map(canonicalizeDiscourseReferentV2))
    .filter(referent => topicIds.has(referent.topicId));
  const referentIdsByTopic = new Map<string, string[]>();
  for (const referent of canonicalReferents) {
    const rows = referentIdsByTopic.get(referent.topicId) ?? [];
    rows.push(referent.id);
    referentIdsByTopic.set(referent.topicId, rows);
  }
  const repairedTopics = canonicalTopics.map(topic => canonicalizeDiscourseTopicV2({
    ...topic,
    referentIds: canonicalStringSetV2(referentIdsByTopic.get(topic.id) ?? []),
    ...(topic.parentTopicId && topicIds.has(topic.parentTopicId) && topic.parentTopicId !== topic.id
      ? { parentTopicId: topic.parentTopicId }
      : { parentTopicId: undefined }),
    supersedesTopicIds: topic.supersedesTopicIds.filter(id => topicIds.has(id) && id !== topic.id)
  }));
  return {
    referents: canonicalReferents.sort((left, right) => compareCodePointsV2(left.id, right.id)),
    topics: repairedTopics.sort((left, right) => compareCodePointsV2(left.id, right.id))
  };
}

function refreshAdmittedTopicsV2(
  topics: readonly DiscourseTopicV2[],
  referents: readonly DiscourseReferentV2[],
  admittedBindings: readonly DiscourseBindingV2[],
  turnIndex: number
): DiscourseTopicV2[] {
  const repaired = repairDiscourseTopologyV2(referents, topics);
  const bindingsByTopic = new Map<string, DiscourseBindingV2[]>();
  for (const binding of admittedBindings) {
    const rows = bindingsByTopic.get(binding.topicId) ?? [];
    rows.push(binding);
    bindingsByTopic.set(binding.topicId, rows);
  }
  return repaired.topics.map(topic => {
    const topicBindings = bindingsByTopic.get(topic.id) ?? [];
    if (!topicBindings.length) return topic;
    const confidence = Math.max(...topicBindings.map(binding => clamp01(binding.confidence)));
    const provenance = topicBindings.flatMap(binding => binding.provenanceBindings);
    return canonicalizeDiscourseTopicV2({
      ...topic,
      anchorNodeIds: [...topic.anchorNodeIds, ...provenance.flatMap(binding => binding.nodeIds)],
      claimIds: [...topic.claimIds, ...provenance.flatMap(binding => binding.claimIds)],
      evidenceIds: [...topic.evidenceIds, ...provenance.flatMap(binding => binding.evidenceIds)],
      salienceMass: clamp01(topic.salienceMass + (1 - topic.salienceMass) * confidence),
      lastTurnIndex: Math.max(topic.lastTurnIndex, Math.floor(finiteNumber(turnIndex, topic.lastTurnIndex)))
    });
  }).sort((left, right) => compareCodePointsV2(left.id, right.id));
}

function mergeDiscourseRowsById<T extends { id: string }>(
  previousRows: readonly T[],
  currentRows: readonly T[]
): T[] {
  const out = new Map<string, T>();
  for (const row of dedupeDiscourseRowsById(previousRows)) out.set(row.id, row);
  for (const row of dedupeDiscourseRowsById(currentRows)) out.set(row.id, row);
  return [...out.values()].sort((left, right) => compareCodePointsV2(left.id, right.id));
}

function dedupeDiscourseRowsById<T extends { id: string }>(rows: readonly T[]): T[] {
  const ordered = [...rows].sort((left, right) => (
    compareCodePointsV2(left.id, right.id)
    || compareCodePointsV2(canonicalJsonV2(left), canonicalJsonV2(right))
  ));
  const out = new Map<string, T>();
  for (const row of ordered) out.set(row.id, row);
  return [...out.values()].sort((left, right) => compareCodePointsV2(left.id, right.id));
}

function prioritizedStringSetV2(primary: readonly string[], secondary: readonly string[], limit: number): string[] {
  const first = canonicalStringSetV2(primary);
  const firstSet = new Set(first);
  return [...first, ...canonicalStringSetV2(secondary).filter(value => !firstSet.has(value))].slice(0, limit);
}

function canonicalStringSetV2(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort(compareCodePointsV2);
}

function compareCodePointsV2(left: string, right: string): number {
  const leftPoints = [...left].map(symbol => symbol.codePointAt(0) ?? 0);
  const rightPoints = [...right].map(symbol => symbol.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJsonV2(value: unknown): string {
  return JSON.stringify(canonicalJsonValueV2(value)) ?? "null";
}

function canonicalJsonValueV2(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalJsonValueV2);
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareCodePointsV2)) {
    if (record[key] !== undefined) out[key] = canonicalJsonValueV2(record[key]);
  }
  return out;
}
