// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, isLanguageConstructionPattern, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2
} from "./language-construction-memory.js";
import { CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA } from "./creative-event-compatibility.js";
import { OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA } from "./optional-null-realization.js";
import { PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA } from "./paired-anti-unification.js";
import { REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA } from "./reversible-construction.js";
import { REQUEST_REQUIREMENT_PATTERN_SCHEMA } from "./request-requirement-learning.js";
import { INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA } from "./language-induction-memory.js";
import type { LanguagePatternRecord, LanguageUnitRecord, SemanticFrameRecord } from "./storage.js";
import type { JsonValue } from "./types.js";

export const SOURCE_CONSTRUCTION_READ_BUDGET = Object.freeze({ limit: 512, maxTotalJsonBytes: 8 * 1024 * 1024 });

export const REQUEST_SEED_PATTERN_JSON_FIELDS = [
  "schema", "profileId", "sourceId", "sourceVersionId", "parentSourceVersionIds", "profileBindingDigest",
  "sourceSystem", "corpusRoleId", "languageId", "componentRecipe", "compilerRecipe", "sourceCompilationId", "contentDigest",
  "surface", "anchor", "matchMode", "semanticRoleId", "requirementCoefficients", "requirementTargets",
  "requirementTargetBounds", "responseForm", "responseExtent", "requestSpanRole", "structuralDelta",
  "rules", "classBindings", "boundarySignals", "counts", "requestConstructionCandidate", "sourceConstructionCandidate", "conversationalBindingId", "bindingId",
  "contextualQaRequestForm", "contextualQaRequestFeatures"
] as const;

export const REQUEST_SEED_FRAME_JSON_FIELDS = [
  "schema", "profileId", "sourceId", "sourceVersionId", "parentSourceVersionIds", "profileBindingDigest",
  "sourceSystem", "corpusRoleId", "languageId", "componentRecipe", "compilerRecipe", "sourceCompilationId",
  "surface", "semanticRoleId", "requirementCoefficients"
] as const;

/**
 * Hard decoded-input contract for the prediction/scoring operation. The four
 * family budgets sum to this value; the runtime also measures the projected
 * records after authorization and rejects an over-budget aggregate.
 */
export const PREDICTION_SCORING_MAX_DECODED_BYTES = 64 * 1024 * 1024;
export const PREDICTION_SCORING_DECODED_BYTE_BUDGETS = Object.freeze({
  ngramModels: 48 * 1024 * 1024,
  languageUnits: 8 * 1024 * 1024,
  languagePatterns: 4 * 1024 * 1024,
  semanticFrames: 4 * 1024 * 1024
});

/** Known scalar/statistical inputs consumed by score, candidate generation, and discourse probes. */
export const PREDICTION_SCORING_PATTERN_JSON_FIELDS = [
  ...REQUEST_SEED_PATTERN_JSON_FIELDS,
  "sentenceCount", "paragraphCount", "sentenceSymbolLengths", "paragraphSymbolLengths",
  "dialogueTurnMarkers", "paragraphShapeTransitions", "dialogueTurnRate"
] as const;

export const PREDICTION_SCORING_FRAME_JSON_FIELDS = REQUEST_SEED_FRAME_JSON_FIELDS;

/** Unit metadata is not a general body in this view; only learned boundary/cadence hints are causal. */
export const PREDICTION_SCORING_UNIT_METADATA_FIELDS = [
  "boundarySignals", "boundaries", "separators", "connectors", "transitions", "joiners", "cadence"
] as const;

/** Bodies compiled for other operations; prediction/scoring must not detoast or hydrate them. */
export const PREDICTION_SCORING_DEFERRED_PATTERN_SCHEMAS = [
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2,
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
  REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA,
  PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA,
  OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA,
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA
] as const;

export function requestSeedSemanticFrame(frame: SemanticFrameRecord): SemanticFrameRecord | undefined {
  const row = record(frame.frameJson);
  const coefficients = row.requirementCoefficients;
  if (typeof row.surface !== "string" || !row.surface.trim()
    || !coefficients || typeof coefficients !== "object" || Array.isArray(coefficients)) return undefined;
  const projected: Record<string, JsonValue> = {};
  for (const key of REQUEST_SEED_FRAME_JSON_FIELDS) if (row[key] !== undefined) projected[key] = row[key]!;
  return { ...frame, frameJson: projected, embedding: [] };
}

export function predictionScoringSemanticFrame(frame: SemanticFrameRecord): SemanticFrameRecord | undefined {
  const row = record(frame.frameJson);
  const coefficients = row.requirementCoefficients;
  if (typeof row.surface !== "string" || !row.surface.trim()
    || !coefficients || typeof coefficients !== "object" || Array.isArray(coefficients)) return undefined;
  const projected: Record<string, JsonValue> = {};
  for (const key of PREDICTION_SCORING_FRAME_JSON_FIELDS) if (row[key] !== undefined) projected[key] = row[key]!;
  return { ...frame, frameJson: projected, embedding: [] };
}

export function predictionScoringLanguageUnit(unit: LanguageUnitRecord): LanguageUnitRecord {
  const metadata = record(unit.metadata);
  const projectedMetadata: Record<string, JsonValue> = {};
  for (const key of PREDICTION_SCORING_UNIT_METADATA_FIELDS) {
    if (metadata[key] !== undefined) projectedMetadata[key] = metadata[key]!;
  }
  return { ...unit, features: [], competenceVector: [], metadata: projectedMetadata };
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Opaque source-learned binding header; it carries no reply text or role fillers. */
export function conversationalConstructionBinding(pattern: LanguagePatternRecord): string | undefined {
  const row = record(pattern.patternJson);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) return undefined;
  if (typeof row.conversationalBindingId === "string") return row.conversationalBindingId;
  const bundle = record(row.bundle);
  return typeof bundle.bindingId === "string" && bundle.bindingId.startsWith("surface.conversational_act.binding.")
    && Array.isArray(bundle.sourceExamples) && bundle.sourceExamples.some(example => typeof record(example).antecedent === "object")
    ? bundle.bindingId : undefined;
}

/** Only explicit graph-port declarations select a later source program read. */
export function requestConstructionCandidate(pattern: LanguagePatternRecord): boolean {
  const row = record(pattern.patternJson);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) return false;
  if (row.requestConstructionCandidate === true) return true;
  const examples = record(row.bundle).sourceExamples;
  return Array.isArray(examples) && examples.some(example => {
    const nullRoles = record(example).nullRoles;
    return Array.isArray(nullRoles) && nullRoles.some(role => {
      const binding = record(role).graphBinding;
      return binding !== null && typeof binding === "object" && !Array.isArray(binding);
    });
  });
}

export function sourceConstructionCandidate(pattern: LanguagePatternRecord): boolean {
  const row = record(pattern.patternJson);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) return false;
  if (row.sourceConstructionCandidate === true) return true;
  const examples = record(row.bundle).sourceExamples;
  return Array.isArray(examples) && examples.some(example => {
    const roles = record(example).roles;
    return Array.isArray(roles) && roles.some(role => {
      const binding = record(role).graphBinding;
      return binding !== null && typeof binding === "object" && !Array.isArray(binding);
    });
  });
}

/** Request interpretation retains typed activations and lexical metadata, never source realization programs. */
export function requestSeedLanguagePattern(pattern: LanguagePatternRecord): LanguagePatternRecord {
  const row = record(pattern.patternJson);
  if (row.schema === REQUEST_REQUIREMENT_PATTERN_SCHEMA) return pattern;
  const projected: Record<string, JsonValue> = {};
  for (const key of REQUEST_SEED_PATTERN_JSON_FIELDS) if (row[key] !== undefined) projected[key] = row[key]!;
  if (isLanguageConstructionPattern(pattern)) {
    const conversationalBindingId = conversationalConstructionBinding(pattern);
    if (conversationalBindingId) projected.conversationalBindingId = conversationalBindingId;
    projected.requestConstructionCandidate = requestConstructionCandidate(pattern);
    projected.sourceConstructionCandidate = sourceConstructionCandidate(pattern);
  } else if (row.schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA) {
    // Empty templates retain the existing typed shape without a generative payload.
    projected.templates = [];
  } else if (row.schema === "scce.induced_language_model.semantic_memory.v1") {
    const classIds = new Set<string>();
    projected.graphBoundConstructions = Array.isArray(row.graphBoundConstructions) ? row.graphBoundConstructions.flatMap(value => {
      const construction = record(value);
      const slots = Array.isArray(construction.slots) ? construction.slots.flatMap(value => {
        const slot = record(value);
        if (slot.semanticRole !== "entity") return [];
        if (typeof slot.lexicalClassId === "string") classIds.add(slot.lexicalClassId);
        return [{ semanticRole: "entity", observedFillers: slot.observedFillers ?? [], lexicalClassId: slot.lexicalClassId ?? null }];
      }) : [];
      return slots.length ? [{ evidenceIds: construction.evidenceIds ?? [], slots }] : [];
    }) : [];
    projected.lexicalClasses = Array.isArray(row.lexicalClasses) ? row.lexicalClasses.flatMap(value => {
      const lexicalClass = record(value);
      if (typeof lexicalClass.id !== "string" || !classIds.has(lexicalClass.id)) return [];
      return [{ id: lexicalClass.id, members: Array.isArray(lexicalClass.members) ? lexicalClass.members.map(value => {
        const member = record(value);
        return { symbol: member.symbol ?? null };
      }) : [] }];
    }) : [];
  }
  return { ...pattern, patternJson: projected };
}

/**
 * Projection for next-symbol prediction, score(), and the existing bounded
 * candidate-realization/generation probes. Request requirements are projected
 * too: their complete compiler/audit body belongs to request interpretation,
 * not this operation.
 */
export function predictionScoringLanguagePattern(pattern: LanguagePatternRecord): LanguagePatternRecord {
  const row = record(pattern.patternJson);
  const projected: Record<string, JsonValue> = {};
  for (const key of PREDICTION_SCORING_PATTERN_JSON_FIELDS) if (row[key] !== undefined) projected[key] = row[key]!;
  if (row.schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA) projected.templates = [];
  return { ...pattern, patternJson: projected };
}

/** Heavy compiled programs are inventory rows only in this view and never enter runtime hydration. */
export function predictionScoringPatternIsHydratable(pattern: LanguagePatternRecord): boolean {
  if (isLanguageConstructionPattern(pattern)) return false;
  const schema = record(pattern.patternJson).schema;
  return schema !== REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA
    && schema !== PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA
    && schema !== OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA
    && schema !== CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA;
}
