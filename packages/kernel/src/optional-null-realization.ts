import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { ReversibleConstruction } from "./reversible-construction.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { Hasher, JsonValue } from "./types.js";

export const OPTIONAL_NULL_REALIZATION_MODEL_SCHEMA =
  "scce.optional_null_realization_model.v1" as const;
export const OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA =
  "scce.optional_null_realization_pattern.v1" as const;

export type OptionalMeaningStatus = "absent" | "present";
export type OptionalSurfaceStatus =
  | "not_applicable"
  | "realized"
  | "unrealized";

export interface OptionalNullDiscourseCondition {
  requiredStateIds: string[];
  excludedStateIds: string[];
}

export interface OptionalNullRealizationObservation {
  id: string;
  constructionId: string;
  constructionContextId: string;
  populationContextId: string;
  sourceFamilyId: string;
  profileId: string;
  relationId: string;
  componentKey: string;
  meaningStatus: OptionalMeaningStatus;
  surfaceStatus: OptionalSurfaceStatus;
  discourseCondition: OptionalNullDiscourseCondition;
  evidenceIds: string[];
}

export interface OptionalNullRealizationEstimate {
  id: string;
  constructionContextId: string;
  populationContextId: string;
  profileIds: string[];
  relationId: string;
  componentKey: string;
  discourseCondition: OptionalNullDiscourseCondition;
  independentSourceFamilies: number;
  absentMeaningFamilies: number;
  presentMeaningFamilies: number;
  realizedFamilies: number;
  unrealizedFamilies: number;
  graphPresentProbability: number;
  realizationProbabilityGivenGraph: number;
  omissionProbabilityGivenGraph: number;
  crossValidatedBrier: number | null;
  crossValidatedLogLoss: number | null;
  heldoutFamilyCount: number;
}

export interface OptionalNullRealizationModel {
  schema: typeof OPTIONAL_NULL_REALIZATION_MODEL_SCHEMA;
  id: string;
  observations: OptionalNullRealizationObservation[];
  estimates: OptionalNullRealizationEstimate[];
  omittedAmbiguousFamilyCells: Array<{
    sourceFamilyId: string;
    constructionContextId: string;
    componentKey: string;
  }>;
  threshold: {
    selected: number;
    objective: number | null;
    wrongOmissionCost: 20;
    wrongRealizationCost: 2;
    abstentionCost: 1;
  };
  omissionGate: {
    minimumIndependentFamilies: 2;
    minimumPosterior: 0.75;
    discourseMatchRequired: true;
    graphPresenceRequired: true;
  };
  status: "ready" | "insufficient_observations";
  audit: JsonValue;
}

export type OptionalNullRealizationDecision =
  | {
    status: "absent_meaning";
    componentKey: string;
    reason: "graph_component_absent";
  }
  | {
    status: "realized";
    componentKey: string;
    estimateId: string;
    probability: number;
  }
  | {
    status: "unrealized_meaning";
    componentKey: string;
    estimateId: string;
    probability: number;
  }
  | {
    status: "unresolved";
    componentKey: string;
    reasons: string[];
  };

interface CanonicalFamilyObservation {
  sourceFamilyId: string;
  constructionContextId: string;
  populationContextId: string;
  profileIds: string[];
  relationId: string;
  componentKey: string;
  meaningStatus: OptionalMeaningStatus;
  surfaceStatus: OptionalSurfaceStatus;
  discourseCondition: OptionalNullDiscourseCondition;
  observationIds: string[];
}

/**
 * Derives three distinct states from exact, promoted construction evidence:
 * absent meaning, present-and-realized meaning, and present-but-unrealized
 * meaning. Copy-related observations are collapsed to one family cell before
 * fitting; conflicting cells are excluded rather than averaged into labels.
 */
export function observeOptionalNullRealization(input: {
  constructions: readonly ReversibleConstruction[];
  hasher?: Hasher;
}): OptionalNullRealizationObservation[] {
  const hasher = input.hasher ?? createHasher();
  const contexts = new Map<string, ReversibleConstruction[]>();
  for (const construction of input.constructions) {
    for (const relationId of uniqueStrings(
      construction.graph.ports.map(port => port.relationId)
    )) {
      const contextId = optionalConstructionContextId({
        populationContextId: optionalPopulationContextId(
          construction.populationPosterior,
          hasher
        ),
        relationId,
        hasher
      });
      const rows = contexts.get(contextId) ?? [];
      rows.push(construction);
      contexts.set(contextId, rows);
    }
  }

  const observations: OptionalNullRealizationObservation[] = [];
  for (const [constructionContextId, constructions] of [...contexts].sort()) {
    const first = constructions[0]!;
    const relationId = relationForContext(first, constructionContextId, hasher);
    if (!relationId) continue;
    const componentKeys = uniqueStrings(constructions.flatMap(construction =>
      construction.graph.ports
        .filter(port => port.relationId === relationId)
        .map(optionalComponentKey)
    ));
    for (const construction of constructions) {
      for (const componentKey of componentKeys) {
        const matching = construction.graph.ports.filter(port =>
          port.relationId === relationId
          && optionalComponentKey(port) === componentKey);
        const meaningStatus: OptionalMeaningStatus =
          matching.length ? "present" : "absent";
        const surfaceStatus: OptionalSurfaceStatus = !matching.length
          ? "not_applicable"
          : matching.some(port =>
            port.realization !== "omitted" && port.surfaceSlotIds.length > 0)
            ? "realized"
            : "unrealized";
        const discourseCondition = canonicalDiscourseCondition(
          construction.discourseConditions
        );
        const canonical = {
          constructionId: construction.id,
          constructionContextId,
          populationContextId: optionalPopulationContextId(
            construction.populationPosterior,
            hasher
          ),
          sourceFamilyId: construction.surface.sourceFamilyId,
          profileId: construction.profileId,
          relationId,
          componentKey,
          meaningStatus,
          surfaceStatus,
          discourseCondition,
          evidenceIds: uniqueStrings(construction.provenance.evidenceIds)
        };
        observations.push({
          ...canonical,
          id: stableId(hasher, "optional_null_observation", canonical)
        });
      }
    }
  }
  return uniqueBy(observations, row => row.id).sort((left, right) =>
    left.id.localeCompare(right.id));
}

export function compileOptionalNullRealizationModel(input: {
  constructions?: readonly ReversibleConstruction[];
  observations?: readonly OptionalNullRealizationObservation[];
  hasher?: Hasher;
}): OptionalNullRealizationModel {
  const hasher = input.hasher ?? createHasher();
  const observed = [
    ...(input.observations ?? []),
    ...observeOptionalNullRealization({
      constructions: input.constructions ?? [],
      hasher
    })
  ];
  const validated = uniqueBy(
    observed.filter(validOptionalObservation),
    row => row.id
  );
  const collapsed = collapseSourceFamilies(validated);
  const groups = new Map<string, CanonicalFamilyObservation[]>();
  for (const row of collapsed.rows) {
    const key = estimateKey(row);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  const estimates = [...groups.values()].map(rows =>
    compileEstimate(rows, hasher)).sort((left, right) =>
      left.id.localeCompare(right.id));
  const calibrationRows = estimates.flatMap(estimate =>
    calibrationPredictions(
      collapsed.rows.filter(row => estimateKey(row) === estimateKey(estimate))
    ));
  const selectedThreshold = selectThreshold(calibrationRows);
  const canonical = {
    schema: OPTIONAL_NULL_REALIZATION_MODEL_SCHEMA,
    observations: validated.sort((left, right) =>
      left.id.localeCompare(right.id)),
    estimates,
    omittedAmbiguousFamilyCells: collapsed.ambiguous.sort((left, right) =>
      canonicalStringify(left).localeCompare(canonicalStringify(right))),
    threshold: {
      selected: selectedThreshold.threshold,
      objective: selectedThreshold.objective,
      wrongOmissionCost: 20 as const,
      wrongRealizationCost: 2 as const,
      abstentionCost: 1 as const
    },
    omissionGate: {
      minimumIndependentFamilies: 2 as const,
      minimumPosterior: 0.75 as const,
      discourseMatchRequired: true as const,
      graphPresenceRequired: true as const
    },
    status: estimates.some(estimate =>
      estimate.presentMeaningFamilies >= 2
      && estimate.heldoutFamilyCount >= 2)
      ? "ready" as const
      : "insufficient_observations" as const
  };
  return {
    ...canonical,
    id: stableId(hasher, "optional_null_realization_model", canonical),
    audit: toJsonValue({
      compiler: "kernel.optional_null_realization.source_family_crossfit.v1",
      absentMeaningDistinctFromUnrealizedMeaning: true,
      sourceFamiliesCollapsed: true,
      conflictingFamilyCellsExcluded: true,
      calibratedByHeldoutSourceFamily: true,
      languageLabelsUsed: false,
      grammarLabelsUsed: false,
      observationCount: canonical.observations.length,
      estimateCount: estimates.length,
      calibrationPredictionCount: calibrationRows.length
    })
  };
}

export function decideOptionalNullRealization(input: {
  model: OptionalNullRealizationModel;
  profileId: string;
  relationId: string;
  componentKey: string;
  meaningStatus: OptionalMeaningStatus;
  discourseStateIds?: readonly string[];
  constructionContextId?: string;
  populationContextId?: string;
}): OptionalNullRealizationDecision {
  if (input.meaningStatus === "absent") {
    return {
      status: "absent_meaning",
      componentKey: input.componentKey,
      reason: "graph_component_absent"
    };
  }
  const discourseStateIds = new Set(input.discourseStateIds ?? []);
  const matches = input.model.estimates.filter(estimate =>
    estimate.profileIds.includes(input.profileId)
    && estimate.relationId === input.relationId
    && estimate.componentKey === input.componentKey
    && (!input.populationContextId
      || estimate.populationContextId === input.populationContextId)
    && (!input.constructionContextId
      || estimate.constructionContextId === input.constructionContextId)
    && discourseConditionMatches(
      estimate.discourseCondition,
      discourseStateIds
    )).sort((left, right) =>
      conditionSpecificity(right.discourseCondition)
        - conditionSpecificity(left.discourseCondition)
      || right.presentMeaningFamilies - left.presentMeaningFamilies
      || left.id.localeCompare(right.id));
  const estimate = matches[0];
  if (!estimate) {
    return unresolved(input.componentKey, ["supported_context_missing"]);
  }
  const omissionThreshold = Math.max(
    input.model.threshold.selected,
    input.model.omissionGate.minimumPosterior
  );
  if (estimate.unrealizedFamilies
      >= input.model.omissionGate.minimumIndependentFamilies
    && estimate.omissionProbabilityGivenGraph >= omissionThreshold) {
    return {
      status: "unrealized_meaning",
      componentKey: input.componentKey,
      estimateId: estimate.id,
      probability: estimate.omissionProbabilityGivenGraph
    };
  }
  if (estimate.realizedFamilies >= 1
    && estimate.realizationProbabilityGivenGraph
      >= input.model.threshold.selected) {
    return {
      status: "realized",
      componentKey: input.componentKey,
      estimateId: estimate.id,
      probability: estimate.realizationProbabilityGivenGraph
    };
  }
  return unresolved(input.componentKey, [
    estimate.unrealizedFamilies
      < input.model.omissionGate.minimumIndependentFamilies
      ? "independent_omission_support_low"
      : "posterior_below_decision_threshold"
  ]);
}

export function optionalComponentKey(input: {
  kind: string;
  relationId: string;
  portId?: string;
  roleId?: string;
  valueKind?: string;
}): string {
  return canonicalStringify({
    kind: input.kind,
    relationId: input.relationId,
    portId: input.portId ?? null,
    roleId: input.roleId ?? null,
    valueKind: input.valueKind ?? null
  });
}

export function optionalConstructionContextId(input: {
  populationContextId: string;
  relationId: string;
  hasher?: Hasher;
}): string {
  return stableId(
    input.hasher ?? createHasher(),
    "optional_construction_context",
    {
      populationContextId: input.populationContextId,
      relationId: input.relationId
    }
  );
}

export function optionalPopulationContextId(
  posterior: readonly { populationId: string; probability: number }[],
  hasher: Hasher = createHasher()
): string {
  const ranked = [...posterior].sort((left, right) =>
    right.probability - left.probability
    || left.populationId.localeCompare(right.populationId));
  return stableId(hasher, "optional_population_context", {
    dominantPopulationId: ranked[0]?.populationId ?? null
  });
}

export function compileOptionalNullRealizationPatterns(
  model: OptionalNullRealizationModel,
  updatedAt: number
): LanguagePatternRecord[] {
  const profiles = uniqueStrings(model.observations.map(row => row.profileId));
  return profiles.map(profileId => {
    const evidenceIds = uniqueStrings(model.observations
      .filter(row => row.profileId === profileId)
      .flatMap(row => row.evidenceIds));
    return {
      id: stableId(createHasher(), "optional_null_realization_pattern", {
        modelId: model.id,
        profileId
      }),
      profileId,
      patternKind: "semantic_role",
      support: uniqueStrings(model.observations
        .filter(row => row.profileId === profileId)
        .map(row => row.sourceFamilyId)).length,
      entropy: 0,
      patternJson: toJsonValue({
        schema: OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA,
        model
      }),
      evidenceIds: evidenceIds as LanguagePatternRecord["evidenceIds"],
      updatedAt
    };
  });
}

export function isOptionalNullRealizationPattern(
  pattern: LanguagePatternRecord
): boolean {
  return recordOf(pattern.patternJson).schema ===
    OPTIONAL_NULL_REALIZATION_PATTERN_SCHEMA;
}

export function optionalNullRealizationModelsFromPatterns(
  patterns: readonly LanguagePatternRecord[]
): OptionalNullRealizationModel[] {
  const observations: OptionalNullRealizationObservation[] = [];
  for (const pattern of patterns) {
    if (!isOptionalNullRealizationPattern(pattern)) continue;
    const model = recordOf(pattern.patternJson).model as
      OptionalNullRealizationModel | undefined;
    if (!model || !validOptionalModel(model, pattern)) continue;
    observations.push(...model.observations.filter(row =>
      row.profileId === pattern.profileId));
  }
  if (!observations.length) return [];
  return [compileOptionalNullRealizationModel({ observations })];
}

function compileEstimate(
  rows: readonly CanonicalFamilyObservation[],
  hasher: Hasher
): OptionalNullRealizationEstimate {
  const first = rows[0]!;
  const profileIds = uniqueStrings(rows.flatMap(row => row.profileIds));
  const absent = rows.filter(row => row.meaningStatus === "absent").length;
  const presentRows = rows.filter(row => row.meaningStatus === "present");
  const realized = presentRows.filter(row =>
    row.surfaceStatus === "realized").length;
  const unrealized = presentRows.filter(row =>
    row.surfaceStatus === "unrealized").length;
  const heldout = calibrationPredictions(rows);
  const graphPresentProbability = (presentRows.length + 1) / (rows.length + 2);
  const realizationProbability = (realized + 1) / (presentRows.length + 2);
  const omissionProbability = (unrealized + 1) / (presentRows.length + 2);
  const canonical = {
    constructionContextId: first.constructionContextId,
    populationContextId: first.populationContextId,
    profileIds,
    relationId: first.relationId,
    componentKey: first.componentKey,
    discourseCondition: first.discourseCondition,
    independentSourceFamilies: rows.length,
    absentMeaningFamilies: absent,
    presentMeaningFamilies: presentRows.length,
    realizedFamilies: realized,
    unrealizedFamilies: unrealized,
    graphPresentProbability: quantize(graphPresentProbability),
    realizationProbabilityGivenGraph: quantize(realizationProbability),
    omissionProbabilityGivenGraph: quantize(omissionProbability),
    crossValidatedBrier: heldout.length
      ? quantize(mean(heldout.map(row =>
        (row.omissionProbability - row.omitted) ** 2)))
      : null,
    crossValidatedLogLoss: heldout.length
      ? quantize(mean(heldout.map(row => -Math.log(Math.max(
        1e-12,
        row.omitted
          ? row.omissionProbability
          : 1 - row.omissionProbability
      )))))
      : null,
    heldoutFamilyCount: heldout.length
  };
  return {
    ...canonical,
    id: stableId(hasher, "optional_null_estimate", canonical)
  };
}

function collapseSourceFamilies(
  observations: readonly OptionalNullRealizationObservation[]
): {
  rows: CanonicalFamilyObservation[];
  ambiguous: OptionalNullRealizationModel["omittedAmbiguousFamilyCells"];
} {
  const cells = new Map<string, OptionalNullRealizationObservation[]>();
  for (const row of observations) {
    const key = canonicalStringify({
      sourceFamilyId: row.sourceFamilyId,
      constructionContextId: row.constructionContextId,
      populationContextId: row.populationContextId,
      componentKey: row.componentKey,
      discourseCondition: row.discourseCondition
    });
    const values = cells.get(key) ?? [];
    values.push(row);
    cells.set(key, values);
  }
  const rows: CanonicalFamilyObservation[] = [];
  const ambiguous: OptionalNullRealizationModel["omittedAmbiguousFamilyCells"] =
    [];
  for (const values of cells.values()) {
    const states = uniqueStrings(values.map(row =>
      `${row.meaningStatus}\u001f${row.surfaceStatus}`));
    const first = values[0]!;
    if (states.length !== 1) {
      ambiguous.push({
        sourceFamilyId: first.sourceFamilyId,
        constructionContextId: first.constructionContextId,
        componentKey: first.componentKey
      });
      continue;
    }
    rows.push({
      sourceFamilyId: first.sourceFamilyId,
      constructionContextId: first.constructionContextId,
      populationContextId: first.populationContextId,
      profileIds: uniqueStrings(values.map(row => row.profileId)),
      relationId: first.relationId,
      componentKey: first.componentKey,
      meaningStatus: first.meaningStatus,
      surfaceStatus: first.surfaceStatus,
      discourseCondition: first.discourseCondition,
      observationIds: values.map(row => row.id).sort()
    });
  }
  return { rows, ambiguous };
}

function calibrationPredictions(
  rows: readonly CanonicalFamilyObservation[]
): Array<{ omissionProbability: number; omitted: 0 | 1 }> {
  const present = rows.filter(row => row.meaningStatus === "present");
  return present.flatMap(heldout => {
    const fit = present.filter(row =>
      row.sourceFamilyId !== heldout.sourceFamilyId);
    if (!fit.length) return [];
    const omitted = fit.filter(row =>
      row.surfaceStatus === "unrealized").length;
    return [{
      omissionProbability: (omitted + 1) / (fit.length + 2),
      omitted: heldout.surfaceStatus === "unrealized" ? 1 as const : 0 as const
    }];
  });
}

function selectThreshold(
  rows: readonly { omissionProbability: number; omitted: 0 | 1 }[]
): { threshold: number; objective: number | null } {
  if (!rows.length) return { threshold: 0.75, objective: null };
  const candidates = Array.from({ length: 10 }, (_, index) =>
    0.5 + index * 0.05);
  return candidates.map(threshold => ({
    threshold: quantize(threshold),
    objective: quantize(mean(rows.map(row => {
      const realizes = 1 - row.omissionProbability >= threshold;
      const omits = row.omissionProbability >= threshold;
      if (!realizes && !omits) return 1;
      if (omits && row.omitted === 0) return 20;
      if (realizes && row.omitted === 1) return 2;
      return 0;
    })))
  })).sort((left, right) =>
    left.objective - right.objective
    || right.threshold - left.threshold)[0]!;
}

function validOptionalObservation(
  row: OptionalNullRealizationObservation
): boolean {
  if (!row.id || !row.constructionId || !row.constructionContextId
    || !row.sourceFamilyId || !row.profileId || !row.relationId
    || !row.populationContextId || !row.componentKey) return false;
  if (row.meaningStatus === "absent") {
    return row.surfaceStatus === "not_applicable";
  }
  return row.surfaceStatus === "realized"
    || row.surfaceStatus === "unrealized";
}

function validOptionalModel(
  model: OptionalNullRealizationModel,
  pattern: LanguagePatternRecord
): boolean {
  if (model.schema !== OPTIONAL_NULL_REALIZATION_MODEL_SCHEMA) return false;
  const { id, audit: _audit, ...canonical } = model;
  if (id !== stableId(
    createHasher(),
    "optional_null_realization_model",
    canonical
  )) return false;
  if (pattern.id !== stableId(
    createHasher(),
    "optional_null_realization_pattern",
    { modelId: model.id, profileId: pattern.profileId }
  )) return false;
  return model.observations.every(row =>
    !row.id || row.id === stableId(createHasher(), "optional_null_observation", {
      constructionId: row.constructionId,
      constructionContextId: row.constructionContextId,
      populationContextId: row.populationContextId,
      sourceFamilyId: row.sourceFamilyId,
      profileId: row.profileId,
      relationId: row.relationId,
      componentKey: row.componentKey,
      meaningStatus: row.meaningStatus,
      surfaceStatus: row.surfaceStatus,
      discourseCondition: row.discourseCondition,
      evidenceIds: uniqueStrings(row.evidenceIds)
    }));
}

function relationForContext(
  construction: ReversibleConstruction,
  contextId: string,
  hasher: Hasher
): string | undefined {
  return uniqueStrings(construction.graph.ports.map(port => port.relationId))
    .find(relationId => optionalConstructionContextId({
      populationContextId: optionalPopulationContextId(
        construction.populationPosterior,
        hasher
      ),
      relationId,
      hasher
    }) === contextId);
}

function canonicalDiscourseCondition(input: {
  requiredStateIds: readonly string[];
  excludedStateIds: readonly string[];
}): OptionalNullDiscourseCondition {
  return {
    requiredStateIds: uniqueStrings(input.requiredStateIds),
    excludedStateIds: uniqueStrings(input.excludedStateIds)
  };
}

function discourseConditionMatches(
  condition: OptionalNullDiscourseCondition,
  states: ReadonlySet<string>
): boolean {
  return condition.requiredStateIds.every(id => states.has(id))
    && condition.excludedStateIds.every(id => !states.has(id));
}

function conditionSpecificity(
  condition: OptionalNullDiscourseCondition
): number {
  return condition.requiredStateIds.length + condition.excludedStateIds.length;
}

function estimateKey(input: {
  constructionContextId: string;
  populationContextId: string;
  profileIds: readonly string[];
  relationId: string;
  componentKey: string;
  discourseCondition: OptionalNullDiscourseCondition;
}): string {
  return canonicalStringify({
    constructionContextId: input.constructionContextId,
    populationContextId: input.populationContextId,
    relationId: input.relationId,
    componentKey: input.componentKey,
    discourseCondition: input.discourseCondition
  });
}

function unresolved(
  componentKey: string,
  reasons: string[]
): OptionalNullRealizationDecision {
  return {
    status: "unresolved",
    componentKey,
    reasons: uniqueStrings(reasons)
  };
}

function recordOf(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function stableId(
  hasher: Hasher,
  namespace: string,
  value: unknown
): string {
  return `${namespace}.${hasher.digestHex(canonicalStringify(value)).slice(0, 40)}`;
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string
): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) if (!byKey.has(key(value))) {
    byKey.set(key(value), value);
  }
  return [...byKey.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function mean(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
