import { resolveDetailProfileId } from "./control-plane-profiles.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { normalizeSourceLanguageAlias } from "./language.js";
import type {
  CapabilityPlan,
  EpistemicForce,
  JsonValue,
  LanguageProfile
} from "./types.js";

export function translationTargetFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, JsonValue>;
  for (const key of ["translationTarget", "targetLanguage", "target_language", "translateTo"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function sourceLanguageAliasFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, JsonValue>;
  for (const key of ["sourceLanguage", "source_language", "language", "languageTag", "locale"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const alias = normalizeSourceLanguageAlias(value);
    if (alias) return alias;
  }
  return undefined;
}

export function surfaceDetailProfileIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, JsonValue>;
  const explicit = record.detailProfileId;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const vector = numericVector(record.detailVector ?? record.surfaceDetailVector);
  if (vector?.length) return resolveDetailProfileId({ registerVector: vector, styleDensity: vector[0] });
  return undefined;
}

function numericVector(value: JsonValue | undefined): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    out.push(Math.max(0, Math.min(1, item)));
  }
  return out;
}

export function styleProfileIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, JsonValue>).styleProfileId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function registerIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, JsonValue>).registerId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function mergeCorrectionRules<T extends { id: string; updatedAt: number; weight: number }>(
  stored: readonly T[],
  detected: readonly T[]
): T[] {
  const byId = new Map<string, T>();
  for (const rule of [...stored, ...detected]) {
    const existing = byId.get(rule.id);
    if (!existing || rule.updatedAt > existing.updatedAt || rule.weight > existing.weight) {
      byId.set(rule.id, rule);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
    .slice(0, 128);
}

export function runtimeLanguageProfile(now: number): LanguageProfile {
  return {
    id: "surface-und",
    sourceVersionId: "source_version_surface_runtime" as never,
    scripts: [{ script: "und", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: now
  };
}

export function requiresExplicitApproval(plan: CapabilityPlan): boolean {
  const permission = plan.permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return false;
  const record = permission as Record<string, JsonValue>;
  return record.requiresExplicitApproval === true
    || record.mode === "explicit"
    || record.allowed === false && plan.phase === "commit";
}

export function pcaForceForMouthSurface(
  spoken: { surfacePlan?: { audit?: JsonValue } },
  selectedForce: EpistemicForce
): EpistemicForce {
  const policy = jsonRecord(jsonRecord(spoken.surfacePlan?.audit).forceAwareAnswerPolicy);
  const policyId = typeof policy.policyId === "string" ? policy.policyId : "";
  const boundaryId = typeof policy.boundaryId === "string" ? policy.boundaryId : "";
  const certifies = policy.allowsExternalFactCertification === true;
  if (!certifies && policyId === "learned_prior_summary" && boundaryId === "import_bound") {
    return "conjectured";
  }
  return selectedForce;
}
