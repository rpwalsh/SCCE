import { clamp01, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export type ControlDetailProfileId = string;
export type BoundaryProfileId = string;

export interface DetailProfilePolicy {
  id: ControlDetailProfileId;
  density: number;
  sequence: number;
  maxSentenceCount: number;
  maxSupportPoints: number;
  maxCaveats: number;
  maxExamples: number;
  maxInstructions: number;
  baseSurfaceUnitTarget: number;
  audit: JsonValue;
}

export interface BoundaryProfile {
  id: BoundaryProfileId;
  scriptId?: string;
  sentenceForms: string[];
  inlineForms: string[];
  terminalForms: string[];
  repeatedBoundaryPenalty: number;
  learnedBoundaryWeight: number;
  profileBoundaryWeight: number;
  boundarySource: "profile" | "learned_prior" | "structural_fallback";
  audit: JsonValue;
}

export interface ConstructForceEvidence {
  signalId: string;
  source: "construct_graph" | "semantic_proof" | "field_state" | "language_target" | "correction_rule";
  weight: number;
  support: number;
}

export interface ConstructForceInferenceRow<TForce extends string = string> {
  id: TForce;
  weight: number;
  source: string;
  evidence: ConstructForceEvidence[];
}

export interface ConstructForceInferenceResult<TForce extends string = string> {
  rows: Array<ConstructForceInferenceRow<TForce>>;
  audit: JsonValue;
}

export const DETAIL_PROFILE_IDS = [
  "surface.detail.profile.0",
  "surface.detail.profile.1",
  "surface.detail.profile.2",
  "surface.detail.profile.3"
] as const;

const DETAIL_PROFILES: Record<ControlDetailProfileId, Omit<DetailProfilePolicy, "sequence" | "audit"> & { sequenceFloor: number }> = {
  [DETAIL_PROFILE_IDS[0]]: {
    id: DETAIL_PROFILE_IDS[0],
    density: 0.28,
    sequenceFloor: 0.12,
    maxSentenceCount: 2,
    maxSupportPoints: 1,
    maxCaveats: 1,
    maxExamples: 1,
    maxInstructions: 1,
    baseSurfaceUnitTarget: 18
  },
  [DETAIL_PROFILE_IDS[1]]: {
    id: DETAIL_PROFILE_IDS[1],
    density: 0.58,
    sequenceFloor: 0.2,
    maxSentenceCount: 4,
    maxSupportPoints: 3,
    maxCaveats: 2,
    maxExamples: 1,
    maxInstructions: 3,
    baseSurfaceUnitTarget: 24
  },
  [DETAIL_PROFILE_IDS[2]]: {
    id: DETAIL_PROFILE_IDS[2],
    density: 0.86,
    sequenceFloor: 0.34,
    maxSentenceCount: 6,
    maxSupportPoints: 5,
    maxCaveats: 3,
    maxExamples: 2,
    maxInstructions: 3,
    baseSurfaceUnitTarget: 34
  },
  [DETAIL_PROFILE_IDS[3]]: {
    id: DETAIL_PROFILE_IDS[3],
    density: 0.72,
    sequenceFloor: 0.75,
    maxSentenceCount: 7,
    maxSupportPoints: 6,
    maxCaveats: 2,
    maxExamples: 1,
    maxInstructions: 4,
    baseSurfaceUnitTarget: 28
  }
};

export function resolveDetailProfileId(input: {
  explicitProfileId?: string;
  styleDensity?: number;
  registerVector?: readonly number[];
}): ControlDetailProfileId {
  if (input.explicitProfileId && DETAIL_PROFILES[input.explicitProfileId]) return input.explicitProfileId;
  const registerMass = input.registerVector?.reduce((sum, value) => sum + Math.abs(value), 0) ?? 0;
  const sequence = input.registerVector?.[1] ?? 0;
  if (sequence > 0.68) return DETAIL_PROFILE_IDS[3]!;
  if (clamp01(input.styleDensity ?? 0.58) < 0.42) return DETAIL_PROFILE_IDS[0]!;
  if (clamp01(input.styleDensity ?? 0.58) > 0.78 || registerMass > 3.5) return DETAIL_PROFILE_IDS[2]!;
  return DETAIL_PROFILE_IDS[1]!;
}

export function detailPolicyForProfile(detailProfileId: ControlDetailProfileId, registerVector: readonly number[] | undefined): DetailProfilePolicy {
  const raw = DETAIL_PROFILES[detailProfileId] ?? DETAIL_PROFILES[DETAIL_PROFILE_IDS[1]]!;
  const sequenceMass = clamp01(Math.abs(registerVector?.[1] ?? 0));
  const sequence = Math.max(raw.sequenceFloor, sequenceMass);
  return {
    id: raw.id,
    density: raw.density,
    sequence,
    maxSentenceCount: raw.maxSentenceCount,
    maxSupportPoints: raw.maxSupportPoints,
    maxCaveats: raw.maxCaveats,
    maxExamples: raw.maxExamples,
    maxInstructions: raw.maxInstructions,
    baseSurfaceUnitTarget: raw.baseSurfaceUnitTarget,
    audit: toJsonValue({
      profileId: raw.id,
      density: raw.density,
      sequence,
      maxSentenceCount: raw.maxSentenceCount,
      maxSupportPoints: raw.maxSupportPoints,
      maxCaveats: raw.maxCaveats,
      baseSurfaceUnitTarget: raw.baseSurfaceUnitTarget
    })
  };
}

export function detailProfileFromVector(vector: readonly number[] | undefined): ControlDetailProfileId | undefined {
  if (!vector?.length) return undefined;
  const density = clamp01(vector[0] ?? 0.5);
  const sequence = clamp01(vector[1] ?? 0);
  if (sequence > 0.68) return DETAIL_PROFILE_IDS[3]!;
  if (density < 0.36) return DETAIL_PROFILE_IDS[0]!;
  if (density > 0.74) return DETAIL_PROFILE_IDS[2]!;
  return DETAIL_PROFILE_IDS[1]!;
}

export function profileOrderIndex(detailProfileId: ControlDetailProfileId): number {
  const index = DETAIL_PROFILE_IDS.indexOf(detailProfileId as never);
  return index < 0 ? 1 : index;
}

export function boundaryProfileFor(input: { scriptId?: string; metadata?: JsonValue }): BoundaryProfile {
  const learned = boundaryProfileFromMetadata(input.metadata);
  if (learned) return learned;
  const scriptId = input.scriptId ?? "script.any";
  const forms = formsForScript(scriptId);
  return {
    id: `surface.boundary.profile.${hashSmall(scriptId)}`,
    scriptId,
    sentenceForms: forms.sentenceForms,
    inlineForms: forms.inlineForms,
    terminalForms: forms.terminalForms,
    repeatedBoundaryPenalty: 0.24,
    learnedBoundaryWeight: 0.52,
    profileBoundaryWeight: 0.34,
    boundarySource: "profile",
    audit: toJsonValue({ source: "boundary-profile.script", scriptId, formCount: forms.sentenceForms.length + forms.inlineForms.length })
  };
}

export function boundaryFormsForKind(profile: BoundaryProfile, kind: "sentence" | "inline"): string[] {
  return kind === "sentence" ? profile.sentenceForms : profile.inlineForms;
}

export function isTerminalBoundary(profile: BoundaryProfile, value: string): boolean {
  return profile.terminalForms.includes(value);
}

export function isInlineBoundary(profile: BoundaryProfile, value: string): boolean {
  return profile.inlineForms.includes(value);
}

function boundaryProfileFromMetadata(value: JsonValue | undefined): BoundaryProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  const raw = record.boundaryProfile;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const profile = raw as Record<string, JsonValue>;
  const sentenceForms = stringList(profile.sentenceForms);
  const inlineForms = stringList(profile.inlineForms);
  const terminalForms = stringList(profile.terminalForms);
  if (!sentenceForms.length || !inlineForms.length) return undefined;
  return {
    id: typeof profile.id === "string" ? profile.id : `surface.boundary.profile.${hashSmall(JSON.stringify(raw))}`,
    scriptId: typeof profile.scriptId === "string" ? profile.scriptId : undefined,
    sentenceForms,
    inlineForms,
    terminalForms: terminalForms.length ? terminalForms : sentenceForms,
    repeatedBoundaryPenalty: clamp01(typeof profile.repeatedBoundaryPenalty === "number" ? profile.repeatedBoundaryPenalty : 0.24),
    learnedBoundaryWeight: clamp01(typeof profile.learnedBoundaryWeight === "number" ? profile.learnedBoundaryWeight : 0.52),
    profileBoundaryWeight: clamp01(typeof profile.profileBoundaryWeight === "number" ? profile.profileBoundaryWeight : 0.34),
    boundarySource: "profile",
    audit: toJsonValue({ source: "boundary-profile.metadata", profileId: profile.id ?? null })
  };
}

function formsForScript(scriptId: string): { sentenceForms: string[]; inlineForms: string[]; terminalForms: string[] } {
  const normalized = scriptId.toLocaleLowerCase();
  if (normalized.includes("arab")) return { sentenceForms: ["؟", "."], inlineForms: ["،", ":"], terminalForms: ["؟", "."] };
  if (normalized.includes("deva")) return { sentenceForms: ["।", "."], inlineForms: [":", ";"], terminalForms: ["।", "."] };
  if (normalized.includes("hani") || normalized.includes("jpan") || normalized.includes("kana")) return { sentenceForms: ["。", "."], inlineForms: ["、", ":"], terminalForms: ["。", "."] };
  return { sentenceForms: ["."], inlineForms: [":", ";"], terminalForms: [".", "!", "?"] };
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.slice(0, 16);
}

function hashSmall(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
