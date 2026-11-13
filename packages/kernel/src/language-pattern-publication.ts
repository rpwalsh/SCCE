// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { corpusSourceAlias } from "./corpus-registry.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA } from "./language-construction-memory.js";
import { INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID, INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS } from "./language-induction-memory.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import { isCanonicalSegmentationArchiveSchema, type SourceCompilationOwner } from "./source-language-compilation.js";
import type { LanguageMemoryStore, LanguagePatternRecord, LanguagePatternProjection } from "./storage.js";
import type { InformationLabel } from "./types.js";

export const LANGUAGE_CONSTRUCTION_PUBLICATION = {
  patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  componentRecipe: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID
} as const;
export const INDUCED_LANGUAGE_MEMORY_PUBLICATIONS = Object.freeze(INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.map(patternSchema => Object.freeze({
  patternSchema, componentRecipe: INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID
})));
export const INDUCED_LANGUAGE_MEMORY_PUBLICATION_RECIPE_ID = "kernel.induced_language_memory_active_projection.v1" as const;

/** Publishes the current compiled source projection, including a valid empty replacement. */
export async function publishCompiledLanguagePatterns(input: {
  store: LanguageMemoryStore;
  owner: SourceCompilationOwner;
  profileId: string;
  sourceSystem: string;
  informationLabel: InformationLabel;
  patterns: readonly LanguagePatternRecord[];
  projections: readonly { patternSchema: string; componentRecipe: string; sourceDependencies?: LanguagePatternProjection["sourceDependencies"] }[];
}): Promise<void> {
  const sourceSystem = corpusSourceAlias(input.sourceSystem);
  const schemas = new Set(input.projections.map(scope => scope.patternSchema));
  if (schemas.size !== input.projections.length) throw new Error("duplicate compiled language-pattern projection schema");
  if ([...schemas].some(isCanonicalSegmentationArchiveSchema)) {
    throw new Error("canonical segmentation archives cannot be published as active language-memory projections");
  }
  if (input.projections.length && !input.store.replaceLanguagePatternProjection) {
    throw new Error("compiled language patterns require active projection publication");
  }
  const patterns = input.patterns.map(pattern => {
    const metadata = jsonRecord(pattern.patternJson);
    if ((schemas.has(String(metadata.schema)) && pattern.profileId !== input.profileId)
      || (pattern.informationLabel && canonicalStringify(pattern.informationLabel) !== canonicalStringify(input.informationLabel))
      || (schemas.has(String(metadata.schema)) && typeof metadata.sourceSystem === "string" && corpusSourceAlias(metadata.sourceSystem) !== sourceSystem)) {
      throw new Error("compiled language-pattern publication has conflicting source scope");
    }
    if (metadata.schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA && !schemas.has(LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA)) {
      throw new Error("compiled language construction requires its active projection");
    }
    const compilation = jsonRecord(metadata.compilation);
    if (metadata.schema === "scce.source_language_compilation_receipt.v1"
      && (compilation.sourceId !== input.owner.sourceId || compilation.sourceVersionId !== input.owner.sourceVersionId
        || compilation.contentHash !== input.owner.contentHash || compilation.profileId !== input.profileId
        || compilation.sourceSystem !== sourceSystem)) {
      throw new Error("compiled language-pattern receipt differs from its canonical source");
    }
    return { ...pattern, informationLabel: input.informationLabel,
      patternJson: schemas.has(String(metadata.schema)) ? toJsonValue({ ...metadata, sourceSystem }) : pattern.patternJson };
  });
  if (!input.projections.length) {
    if (input.store.putLanguagePatterns) await input.store.putLanguagePatterns(patterns);
    else for (const pattern of patterns) await input.store.putLanguagePattern(pattern);
    return;
  }
  const firstInducedProjection = input.projections.findIndex(scope =>
    scope.componentRecipe === INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID
      && INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.includes(scope.patternSchema));
  const inducedSchemas = new Set<string>(INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS);
  for (const [index, scope] of input.projections.entries()) {
    // Syntax replay owns the segmentation-manifest reference while semantic
    // replay owns the original document order.  A fresh store has neither
    // sibling yet, so the first induced publication must present the complete
    // coupled component set to the physical encoder in one batch.  Projection
    // membership remains schema-specific below; this only establishes the
    // immutable component rows before later projection ledgers are published.
    const publishInducedComponentSet = index === firstInducedProjection;
    const inducedProjection = scope.componentRecipe === INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID
      && inducedSchemas.has(scope.patternSchema);
    await input.store.replaceLanguagePatternProjection!({
      patterns: patterns.filter(pattern => jsonRecord(pattern.patternJson).schema === scope.patternSchema
        || publishInducedComponentSet && inducedSchemas.has(String(jsonRecord(pattern.patternJson).schema))
        || index === 0 && !schemas.has(String(jsonRecord(pattern.patternJson).schema))),
      ...(inducedProjection ? { reusePatternRowsFromCurrentTransaction: true } : {}),
      projection: { ...scope, profileId: input.profileId, sourceId: input.owner.sourceId, sourceVersionId: input.owner.sourceVersionId,
        sourceSystem, informationLabel: input.informationLabel,
        patternIds: patterns.filter(pattern => jsonRecord(pattern.patternJson).schema === scope.patternSchema).map(pattern => pattern.id).sort() }
    });
  }
}
