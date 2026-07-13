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
