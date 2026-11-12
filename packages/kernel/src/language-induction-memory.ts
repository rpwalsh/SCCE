// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { IdFactory } from "./ids.js";
import type { InducedLanguageModel } from "./language-induction.js";
import { semanticInductionProjection } from "./semantic-induction-factors.js";
import { canonicalStringify, clamp01, createHasher, entropy, toJsonValue } from "./primitives.js";
import {
  LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  transferSourceSegmentationReplayRecipe,
  validateLanguageSegmentationWitness,
  validateSourceSegmentationWitness,
  type LanguageSegmentationWitness,
  type SourceSegmentationWitness
} from "./source-segmentation-witness.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceId, Hasher, InformationLabel, JsonValue, LanguageProfile } from "./types.js";
import { pooledLanguageProfileBindingFor, type PooledLanguageProfileBinding } from "./pooled-language-profile-binding.js";

export interface InducedLanguageModelMemoryProjection {
  schema: "scce.induced_language_model.memory_projection.v1";
  modelId: string;
  profileIds: string[];
  patterns: LanguagePatternRecord[];
  skippedReason?: "no_matching_profiles";
}

export const INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID = "kernel.induced_language_memory_projection.v5" as const;
export const INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA = "scce.induced_language_model.syntax_memory.v3" as const;
export const LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA =
  "scce.language_segmentation_witness_manifest.v1" as const;
export const LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA =
  "scce.language_segmentation_witness_ref.v1" as const;
export const INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS: readonly string[] = Object.freeze([
  "scce.induced_language_model.morphology_memory.v1", INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
  "scce.induced_language_model.semantic_memory.v1", "scce.induced_language_model.translation_seed_memory.v1"
]);

export type InducedLanguageMemoryModel = Pick<InducedLanguageModel,
  "id" | "audit" | "morphology" | "morphologyClassBindings" | "syntaxTemplates" | "boundarySignals" | "segmentationWitness"
  | "semanticFrames" | "graphBoundConstructions" | "lexicalClasses" | "relationHypothesisModel" | "translationSeeds" | "semanticInductionFactors">;

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
  const archiveOwnerProfileId = targetProfiles[0]!.id;
  const patterns = targetProfiles.flatMap(profile => patternsForProfile({
    model: input.model,
    profile,
    idFactory: input.idFactory,
    updatedAt: input.updatedAt,
    sourceSystem: input.sourceSystem,
    informationLabel: input.informationLabel,
    archiveOwnerProfileId,
    publishSegmentationWitnesses: profile.id === archiveOwnerProfileId,
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
  archiveOwnerProfileId: string;
  publishSegmentationWitnesses: boolean;
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
    const { semanticInductionProjection: projection, ...ordinaryPayload } = payload;
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
      patternJson: { ...(toJsonValue({
        schema,
        ...base,
        ...ordinaryPayload
      }) as Record<string, JsonValue>), ...(projection ? { semanticInductionProjection: projection } : {}) },
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
  const segmentationDocumentCount = input.model.segmentationWitness.populations.reduce((total, population) => total + population.documents.length, 0);
  const segmentationReference = segmentationWitnessReference(
    input.model.segmentationWitness,
    input.archiveOwnerProfileId,
    input.idFactory
  );
  if (input.publishSegmentationWitnesses && segmentationDocumentCount) {
    for (const population of input.model.segmentationWitness.populations) for (const witness of population.documents) {
      rows.push(sourceSegmentationWitnessPattern({ ...input, witness }));
    }
    rows.push(languageSegmentationWitnessManifestPattern({ ...input, witness: input.model.segmentationWitness }));
  }
  if (input.model.syntaxTemplates.length || input.model.boundarySignals.length || segmentationDocumentCount) {
    add("syntax", INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
      Math.log2(1 + input.model.syntaxTemplates.length + input.model.boundarySignals.length + segmentationDocumentCount) / 10,
      input.model.syntaxTemplates.map(template => template.count),
      {
        templates: input.model.syntaxTemplates.slice(0, 256) as unknown as JsonValue,
        boundarySignals: input.model.boundarySignals.slice(0, 256) as unknown as JsonValue,
        segmentationWitness: segmentationReference as unknown as JsonValue,
        counts: Object.fromEntries(topCounts(input.model.syntaxTemplates.map(template => template.shape.join(" ")), 128))
      });
  }
  if (input.model.semanticInductionFactors
    || input.model.semanticFrames.length
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
        ...(input.model.semanticInductionFactors ? { semanticInductionProjection: semanticInductionProjection({
          factors: input.model.semanticInductionFactors, semanticFrames: input.model.semanticFrames.slice(0, 256),
          graphBoundConstructions: input.model.graphBoundConstructions.slice(0, 256), lexicalClasses: input.model.lexicalClasses.slice(0, 128),
          relationHypothesisModel: input.model.relationHypothesisModel, hasher: { digestHex: value => String(input.idFactory.contentHash(value)).replace(/^sha256_/u, "") }
        }) as unknown as JsonValue } : {}),
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

function segmentationWitnessReference(
  witness: LanguageSegmentationWitness,
  profileId: string,
  idFactory: IdFactory
): {
  schema: typeof LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA;
  manifestPatternId: string;
} {
  return {
    schema: LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
    manifestPatternId: segmentationArchivePatternId(witness.id, profileId, idFactory)
  };
}

function segmentationArchivePatternId(witnessId: string, profileId: string, idFactory: IdFactory): string {
  return `segmentation_archive.${String(idFactory.contentHash(canonicalStringify([witnessId, profileId])))
    .replace(/^sha256_/u, "")}`;
}

function sourceSegmentationWitnessPattern(input: {
  witness: SourceSegmentationWitness;
  model: InducedLanguageMemoryModel;
  profile: LanguageProfile;
  idFactory: IdFactory;
  updatedAt: number;
  informationLabel?: InformationLabel;
}): LanguagePatternRecord {
  const patternJson = transferSourceSegmentationReplayRecipe(
    input.witness,
    toJsonValue(input.witness) as unknown as object
  ) as JsonValue;
  return {
    id: segmentationArchivePatternId(input.witness.id, input.profile.id, input.idFactory),
    profileId: input.profile.id,
    patternKind: "segmentation",
    support: clamp01(Math.log2(1 + input.witness.fullDag.factors.arcs.length) / 16),
    entropy: 0,
    // This is the one canonical evidence body. Projection/profile ownership
    // belongs to the LanguagePatternRecord columns, never inside the witness.
    patternJson,
    evidenceIds: input.witness.evidenceIds.slice(0, 128) as EvidenceId[],
    updatedAt: input.updatedAt,
    informationLabel: input.informationLabel
  };
}

function languageSegmentationWitnessManifestPattern(input: {
  witness: LanguageSegmentationWitness;
  model: InducedLanguageMemoryModel;
  profile: LanguageProfile;
  idFactory: IdFactory;
  updatedAt: number;
  informationLabel?: InformationLabel;
  evidenceIds: readonly EvidenceId[];
}): LanguagePatternRecord {
  const populations = input.witness.populations.map(population => ({
    populationId: population.populationId,
    prior: population.prior,
    sourceWitnesses: population.documents.map(document => ({
      witnessId: document.id,
      patternId: segmentationArchivePatternId(document.id, input.profile.id, input.idFactory)
    }))
  }));
  return {
    id: segmentationArchivePatternId(input.witness.id, input.profile.id, input.idFactory),
    profileId: input.profile.id,
    patternKind: "segmentation",
    support: clamp01(Math.log2(1 + populations.length) / 8),
    entropy: entropy(populations.map(population => population.prior)),
    patternJson: toJsonValue({
      schema: LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
      id: input.witness.id,
      witnessSchema: input.witness.schema,
      populationModelId: input.witness.populationModelId,
      populations,
      audit: input.witness.audit
    }),
    evidenceIds: input.evidenceIds.slice(0, 128),
    updatedAt: input.updatedAt,
    informationLabel: input.informationLabel
  };
}

export interface LanguageSegmentationWitnessReference {
  schema: typeof LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA;
  manifestPatternId: string;
}

export function validateLanguageSegmentationWitnessReference(
  value: unknown
): asserts value is LanguageSegmentationWitnessReference {
  const reference = exactRecord(value, ["schema", "manifestPatternId"], "segmentation witness reference");
  if (reference.schema !== LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA
    || typeof reference.manifestPatternId !== "string" || !reference.manifestPatternId) {
    throw new Error("invalid segmentation witness reference");
  }
}

export function isLanguageSegmentationWitnessReference(value: unknown): value is LanguageSegmentationWitnessReference {
  try {
    validateLanguageSegmentationWitnessReference(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore one logical language witness from its normalized durable rows.
 *
 * This is intentionally an exact-ID read contract. Archive rows are not
 * runtime priors and must never enter generic hydration or compete for its
 * byte budget. The caller first reads the manifest ID carried by syntax v3,
 * then reads exactly the manifest's source pattern IDs and passes those rows
 * here. Missing, duplicate and surplus rows are all rejected.
 */
export function hydrateLanguageSegmentationWitness(input: {
  reference: unknown;
  manifest: LanguagePatternRecord;
  sourceWitnesses: readonly LanguagePatternRecord[];
  hasher?: Hasher;
}): LanguageSegmentationWitness {
  const hasher = input.hasher ?? createHasher();
  validateLanguageSegmentationWitnessReference(input.reference);
  const reference = input.reference;
  if (input.manifest.id !== reference.manifestPatternId) {
    throw new Error("segmentation witness manifest row id differs from its reference");
  }
  const manifest = exactRecord(input.manifest.patternJson,
    ["schema", "id", "witnessSchema", "populationModelId", "populations", "audit"],
    "segmentation witness manifest");
  if (manifest.schema !== LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA
    || manifest.witnessSchema !== LANGUAGE_SEGMENTATION_WITNESS_SCHEMA
    || typeof manifest.id !== "string" || !manifest.id
    || typeof manifest.populationModelId !== "string" || !manifest.populationModelId
    || !Array.isArray(manifest.populations)) {
    throw new Error("invalid segmentation witness manifest");
  }
  if (input.manifest.id !== segmentationArchivePatternIdFromHasher(manifest.id, input.manifest.profileId, hasher)) {
    throw new Error("segmentation witness manifest archive identity changed");
  }

  const referencedPatternIds = new Set<string>();
  const referencedWitnessIds = new Set<string>();
  const populations = manifest.populations.map(value => {
    const population = exactRecord(value, ["populationId", "prior", "sourceWitnesses"], "segmentation witness manifest population");
    if (typeof population.populationId !== "string" || !population.populationId
      || typeof population.prior !== "number" || !Number.isFinite(population.prior)
      || population.prior < 0 || population.prior > 1 || !Array.isArray(population.sourceWitnesses)) {
      throw new Error("invalid segmentation witness manifest population");
    }
    const sources = population.sourceWitnesses.map(value => {
      const source = exactRecord(value, ["witnessId", "patternId"], "segmentation witness manifest source");
      if (typeof source.witnessId !== "string" || !source.witnessId
        || typeof source.patternId !== "string" || !source.patternId
        || referencedPatternIds.has(source.patternId) || referencedWitnessIds.has(source.witnessId)) {
        throw new Error("invalid or repeated segmentation witness manifest source");
      }
      referencedPatternIds.add(source.patternId);
      referencedWitnessIds.add(source.witnessId);
      return { witnessId: source.witnessId, patternId: source.patternId };
    });
    return { populationId: population.populationId, prior: population.prior, sources };
  });

  const supplied = new Map<string, LanguagePatternRecord>();
  for (const row of input.sourceWitnesses) {
    if (supplied.has(row.id)) throw new Error("duplicate source segmentation witness row");
    supplied.set(row.id, row);
  }
  if (supplied.size !== referencedPatternIds.size
    || [...supplied.keys()].some(id => !referencedPatternIds.has(id))) {
    throw new Error("source segmentation witness rows do not exactly match the manifest");
  }

  const restored: LanguageSegmentationWitness = {
    schema: LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
    id: manifest.id,
    populationModelId: manifest.populationModelId,
    populations: populations.map(population => ({
      populationId: population.populationId,
      prior: population.prior,
      documents: population.sources.map(source => {
        const row = supplied.get(source.patternId);
        if (!row) throw new Error(`missing source segmentation witness row ${source.patternId}`);
        const witness = structuredClone(row.patternJson) as unknown;
        validateSourceSegmentationWitness(witness, hasher);
        if (witness.id !== source.witnessId) throw new Error("source segmentation witness id differs from its manifest");
        if (row.profileId !== input.manifest.profileId
          || row.id !== segmentationArchivePatternIdFromHasher(witness.id, row.profileId, hasher)) {
          throw new Error("source segmentation witness archive identity changed");
        }
        return witness;
      })
    })),
    audit: structuredClone(manifest.audit as JsonValue)
  };
  validateLanguageSegmentationWitness(restored, hasher);
  return restored;
}

function segmentationArchivePatternIdFromHasher(witnessId: string, profileId: string, hasher: Hasher): string {
  return `segmentation_archive.${hasher.digestHex(canonicalStringify([witnessId, profileId]))}`;
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

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid ${label} fields`);
  }
  return record;
}
