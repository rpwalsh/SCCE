// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { IdFactory } from "./ids.js";
import type { InducedLanguageModel } from "./language-induction.js";
import { canonicalStringify, clamp01, entropy, toJsonValue } from "./primitives.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceId, InformationLabel, JsonValue, LanguageProfile } from "./types.js";
import { pooledLanguageProfileBindingFor, type PooledLanguageProfileBinding } from "./pooled-language-profile-binding.js";

export interface InducedLanguageModelMemoryProjection {
  schema: "scce.induced_language_model.memory_projection.v1";
  modelId: string;
  profileIds: string[];
  patterns: LanguagePatternRecord[];
  skippedReason?: "no_matching_profiles";
}

export const INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID = "kernel.induced_language_memory_projection.v4" as const;
export const INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA = "scce.induced_language_model.syntax_memory.v1" as const;
export const INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS: readonly string[] = Object.freeze([
  "scce.induced_language_model.morphology_memory.v1", INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
  "scce.induced_language_model.semantic_memory.v1", "scce.induced_language_model.translation_seed_memory.v1"
]);

export type InducedLanguageMemoryModel = Pick<InducedLanguageModel,
  "id" | "audit" | "morphology" | "morphologyClassBindings" | "syntaxTemplates" | "boundarySignals" | "segmentationDocuments"
  | "semanticFrames" | "graphBoundConstructions" | "lexicalClasses" | "relationHypothesisModel" | "translationSeeds">;

export function languageMemoryPatternsFromInducedLanguageModel(input: {
  model: InducedLanguageMemoryModel;
  profiles: readonly LanguageProfile[];
  idFactory: IdFactory;
  updatedAt: number;
  sourceSystem?: string;
  informationLabel?: InformationLabel;
  profileBinding?: PooledLanguageProfileBinding;
}): InducedLanguageModelMemoryProjection {
  const profileIds = sourceVersionIdsFromAudit(input.model.audit);
  const targetProfiles = input.profiles
    .filter(profile => profileIds.size === 0 || profileIds.has(String(profile.sourceVersionId)) || (input.profileBinding && pooledLanguageProfileBindingFor({
      binding: input.profileBinding, profile, sourceVersionIds: profileIds, evidenceIds: evidenceIdsFromAudit(input.model.audit).map(String)
    })))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!targetProfiles.length) {
    return {
      schema: "scce.induced_language_model.memory_projection.v1",
      modelId: input.model.id,
      profileIds: [],
      patterns: [],
      skippedReason: "no_matching_profiles"
    };
  }

  const evidenceIds = evidenceIdsFromAudit(input.model.audit);
  const patterns = targetProfiles.flatMap(profile => patternsForProfile({
    model: input.model,
    profile,
    idFactory: input.idFactory,
    updatedAt: input.updatedAt,
    sourceSystem: input.sourceSystem,
    informationLabel: input.informationLabel,
      ...(input.profileBinding ? { profileBinding: pooledLanguageProfileBindingFor({ binding: input.profileBinding, profile, sourceVersionIds: profileIds, evidenceIds: evidenceIds.map(String) }) } : {}),
    evidenceIds
  }));
  return {
    schema: "scce.induced_language_model.memory_projection.v1",
    modelId: input.model.id,
    profileIds: targetProfiles.map(profile => profile.id),
    patterns
  };
}

function patternsForProfile(input: {
  model: InducedLanguageMemoryModel;
  profile: LanguageProfile;
  idFactory: IdFactory;
  updatedAt: number;
  sourceSystem?: string;
  informationLabel?: InformationLabel;
  evidenceIds: readonly EvidenceId[];
  profileBinding?: ReturnType<typeof pooledLanguageProfileBindingFor>;
}): LanguagePatternRecord[] {
  const rows: LanguagePatternRecord[] = [];
  const base = {
    componentRecipe: INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
    modelId: input.model.id,
    profileId: input.profile.id,
    sourceVersionId: input.profile.sourceVersionId,
    ...(input.profileBinding ? { parentSourceVersionIds: input.profileBinding.parents, sourceFamilyIds: input.profileBinding.families, profileBindingDigest: input.profileBinding.inputDigest } : {}),
    ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {})
  };
  const add = (
    patternKind: LanguagePatternRecord["patternKind"],
    schema: string,
    support: number,
    values: readonly number[],
    payload: Record<string, JsonValue>
  ) => {
    rows.push({
      id: `induced_language_memory_pattern_${String(input.idFactory.contentHash(canonicalStringify({
        modelId: input.model.id,
        profileId: input.profile.id,
        patternKind,
        schema
      }))).replace(/^sha256_/u, "")}`,
      profileId: input.profile.id,
      patternKind,
      support: clamp01(support),
      entropy: entropy(values),
      patternJson: toJsonValue({
        schema,
        ...base,
        ...payload
      }),
      evidenceIds: input.evidenceIds.slice(0, 128),
      updatedAt: input.updatedAt,
      informationLabel: input.informationLabel
    });
  };

  if (input.model.morphology.length || input.model.morphologyClassBindings.length) {
    add("morphology", "scce.induced_language_model.morphology_memory.v1",
      Math.log2(1 + input.model.morphology.length + input.model.morphologyClassBindings.length) / 10,
      input.model.morphology.map(rule => rule.symbolCount),
      {
        rules: input.model.morphology.slice(0, 256) as unknown as JsonValue,
        classBindings: input.model.morphologyClassBindings.slice(0, 256) as unknown as JsonValue,
        counts: Object.fromEntries(topCounts(input.model.morphology.flatMap(rule => [rule.pattern, ...rule.examples]), 128))
      });
  }
  if (input.model.syntaxTemplates.length || input.model.boundarySignals.length || input.model.segmentationDocuments.length) {
    add("syntax", INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
      Math.log2(1 + input.model.syntaxTemplates.length + input.model.boundarySignals.length) / 10,
      input.model.syntaxTemplates.map(template => template.count),
      {
        templates: input.model.syntaxTemplates.slice(0, 256) as unknown as JsonValue,
        boundarySignals: input.model.boundarySignals.slice(0, 256) as unknown as JsonValue,
        segmentationDocuments: input.model.segmentationDocuments as unknown as JsonValue,
        counts: Object.fromEntries(topCounts(input.model.syntaxTemplates.map(template => template.shape.join(" ")), 128))
      });
  }
  if (input.model.semanticFrames.length
    || input.model.graphBoundConstructions.length
    || input.model.lexicalClasses.length
    || input.model.relationHypothesisModel.observationCount > 0) {
    add("semantic_role", "scce.induced_language_model.semantic_memory.v1",
      Math.log2(1 + input.model.semanticFrames.length + input.model.graphBoundConstructions.length + input.model.lexicalClasses.length) / 11,
      input.model.semanticFrames.map(frame => frame.support),
      {
        semanticFrames: input.model.semanticFrames.slice(0, 256) as unknown as JsonValue,
        graphBoundConstructions: input.model.graphBoundConstructions.slice(0, 256) as unknown as JsonValue,
        lexicalClasses: input.model.lexicalClasses.slice(0, 128) as unknown as JsonValue,
        relationHypothesisModel: input.model.relationHypothesisModel as unknown as JsonValue,
        counts: Object.fromEntries(topCounts([
          ...input.model.semanticFrames.map(frame => frame.predicate),
          ...input.model.semanticFrames.flatMap(frame => frame.roles.flatMap(role => [role.name, role.filler])),
          ...input.model.graphBoundConstructions.flatMap(construction => [construction.predicate, ...construction.slots.flatMap(slot => slot.observedFillers)])
        ], 128))
      });
  }
  if (input.model.translationSeeds.length) {
    add("semantic_role", "scce.induced_language_model.translation_seed_memory.v1",
      Math.log2(1 + input.model.translationSeeds.length) / 10,
      input.model.translationSeeds.map(seed => seed.score),
      {
        translationSeeds: input.model.translationSeeds.slice(0, 256) as unknown as JsonValue,
        counts: Object.fromEntries(topCounts(input.model.translationSeeds.flatMap(seed => [seed.sourceSymbol, seed.targetSymbol]), 128))
      });
  }
  return rows;
}

function sourceVersionIdsFromAudit(audit: JsonValue): ReadonlySet<string> {
  const row = recordOf(audit);
  const values = Array.isArray(row.sourceVersionIds) ? row.sourceVersionIds : [];
  return new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
}

function evidenceIdsFromAudit(audit: JsonValue): EvidenceId[] {
  const row = recordOf(audit);
  const values = Array.isArray(row.evidenceIds) ? row.evidenceIds : [];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(value => value as EvidenceId);
}

function topCounts(values: readonly string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit));
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
