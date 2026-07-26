import { createHasher, toJsonValue } from "./primitives.js";
import type { EvidenceId, Hasher, JsonValue } from "./types.js";

export const RELATION_HYPOTHESIS_MODEL_SCHEMA = "scce.relation_hypothesis_model.v1" as const;

export interface RelationHypothesisStatistics {
  surface: string;
  occurrenceCount: number;
  sourceCount: number;
  leftContextCount: number;
  rightContextCount: number;
  contextPairCount: number;
  leftShapeCount: number;
  rightShapeCount: number;
  leftShapes: string[];
  rightShapes: string[];
  evidenceIds: EvidenceId[];
}

export interface RelationHypothesisModel {
  schema: typeof RELATION_HYPOTHESIS_MODEL_SCHEMA;
  id: string;
  observationCount: number;
  sourceCount: number;
  statistics: Record<string, RelationHypothesisStatistics>;
  audit: JsonValue;
}

export interface RelationHypothesis {
  surface: string;
  index: number;
  posterior: number;
  energy: number;
  factors: {
    corpusPrior: number;
    recurrence: number;
    sourceIndependence: number;
    leftSubstitution: number;
    rightSubstitution: number;
    contextPairDiversity: number;
    localShapeSupport: number;
  };
  evidenceIds: EvidenceId[];
}

interface MutableStatistics {
  occurrenceCount: number;
  sourceIds: Set<string>;
  leftContexts: Set<string>;
  rightContexts: Set<string>;
  contextPairs: Set<string>;
  leftShapes: Set<string>;
  rightShapes: Set<string>;
  evidenceIds: Set<EvidenceId>;
}

/**
 * Compiles exact sufficient statistics for relation hypotheses. It does not
 * assign grammatical labels: every observed surface competes under the same
 * source-neutral context and source-independence factors.
 */
export function compileRelationHypothesisModel(input: {
  observations: readonly {
    sourceId: string;
    symbols: readonly string[];
    evidenceIds?: readonly EvidenceId[];
  }[];
  hasher?: Hasher;
}): RelationHypothesisModel {
  const hasher = input.hasher ?? createHasher();
  const rows = new Map<string, MutableStatistics>();
  let observationCount = 0;
  const sourceIds = new Set<string>();
  for (const observation of [...input.observations].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
    || left.symbols.join("\u0001").localeCompare(right.symbols.join("\u0001")))) {
    sourceIds.add(observation.sourceId);
    for (let index = 0; index < observation.symbols.length; index += 1) {
      const surface = normalize(observation.symbols[index] ?? "");
      if (!surface) continue;
      const left = normalize(observation.symbols[index - 1] ?? "<boundary>");
      const right = normalize(observation.symbols[index + 1] ?? "<boundary>");
      const row = rows.get(surface) ?? {
        occurrenceCount: 0,
        sourceIds: new Set<string>(),
        leftContexts: new Set<string>(),
        rightContexts: new Set<string>(),
        contextPairs: new Set<string>(),
        leftShapes: new Set<string>(),
        rightShapes: new Set<string>(),
        evidenceIds: new Set<EvidenceId>()
      };
      row.occurrenceCount += 1;
      row.sourceIds.add(observation.sourceId);
      row.leftContexts.add(left);
      row.rightContexts.add(right);
      row.contextPairs.add(`${left}\u0001${right}`);
      row.leftShapes.add(surfaceShape(left));
      row.rightShapes.add(surfaceShape(right));
      for (const evidenceId of observation.evidenceIds ?? []) row.evidenceIds.add(evidenceId);
      rows.set(surface, row);
      observationCount += 1;
    }
  }
  const statistics = Object.fromEntries([...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([surface, row]) => [surface, {
      surface,
      occurrenceCount: row.occurrenceCount,
      sourceCount: row.sourceIds.size,
      leftContextCount: row.leftContexts.size,
      rightContextCount: row.rightContexts.size,
      contextPairCount: row.contextPairs.size,
      leftShapeCount: row.leftShapes.size,
      rightShapeCount: row.rightShapes.size,
      leftShapes: [...row.leftShapes].sort(),
      rightShapes: [...row.rightShapes].sort(),
      evidenceIds: [...row.evidenceIds].sort()
    }]));
  const canonical = {
    schema: RELATION_HYPOTHESIS_MODEL_SCHEMA,
    observationCount,
    sourceCount: sourceIds.size,
    statistics
  };
  return {
    ...canonical,
    id: `relation_hypothesis_model.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.relation_hypothesis.v1",
      candidateCount: Object.keys(statistics).length,
      finalHeuristicSelection: false
    })
  };
}

/**
 * Returns a normalized finite posterior. No factor can select a hypothesis by
 * itself: the score is the product of independently smoothed empirical
 * factors, and the complete candidate set is retained in deterministic order.
 */
export function inferRelationHypotheses(input: {
  symbols: readonly string[];
  model: RelationHypothesisModel;
  candidate?: (surface: string) => boolean;
}): RelationHypothesis[] {
  const vocabulary = Math.max(1, Object.keys(input.model.statistics).length);
  const sourceDenominator = Math.max(1, input.model.sourceCount);
  const raw = input.symbols
    .map((surface, index) => {
      const normalized = normalize(surface);
      if (!normalized || (input.candidate && !input.candidate(surface))) return undefined;
      const statistics = input.model.statistics[normalized];
      const occurrences = statistics?.occurrenceCount ?? 0;
      const corpusPrior = (occurrences + 1) / (input.model.observationCount + vocabulary);
      const recurrence = (occurrences + 1) / (occurrences + 2);
      const sourceIndependence = ((statistics?.sourceCount ?? 0) + 1)
        / (sourceDenominator + 1);
      const leftSubstitution = ((statistics?.leftContextCount ?? 0) + 1)
        / (occurrences + 2);
      const rightSubstitution = ((statistics?.rightContextCount ?? 0) + 1)
        / (occurrences + 2);
      const contextPairDiversity = ((statistics?.contextPairCount ?? 0) + 1)
        / (occurrences + 2);
      const leftShape = surfaceShape(normalize(input.symbols[index - 1] ?? "<boundary>"));
      const rightShape = surfaceShape(normalize(input.symbols[index + 1] ?? "<boundary>"));
      const localShapeSupport = (
        Number(statistics?.leftShapes.includes(leftShape))
        + Number(statistics?.rightShapes.includes(rightShape))
        + 1
      ) / 3;
      const factors = {
        corpusPrior,
        recurrence,
        sourceIndependence,
        leftSubstitution,
        rightSubstitution,
        contextPairDiversity,
        localShapeSupport: Math.max(Number.EPSILON, localShapeSupport)
      };
      const logScore = Object.values(factors)
        .reduce((sum, factor) => sum + Math.log(Math.max(Number.EPSILON, factor)), 0);
      return {
        surface,
        index,
        logScore,
        factors,
        evidenceIds: statistics?.evidenceIds ?? []
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (!raw.length) return [];
  const maximum = Math.max(...raw.map(row => row.logScore));
  const normalizer = raw.reduce((sum, row) => sum + Math.exp(row.logScore - maximum), 0);
  return raw
    .map(row => ({
      surface: row.surface,
      index: row.index,
      posterior: quantize(Math.exp(row.logScore - maximum) / normalizer),
      energy: quantize(-row.logScore),
      factors: mapFactors(row.factors),
      evidenceIds: row.evidenceIds
    }))
    .sort((left, right) =>
      right.posterior - left.posterior
      || left.energy - right.energy
      || left.index - right.index
      || left.surface.localeCompare(right.surface));
}

function mapFactors(
  factors: RelationHypothesis["factors"]
): RelationHypothesis["factors"] {
  return Object.fromEntries(
    Object.entries(factors).map(([key, value]) => [key, quantize(value)])
  ) as unknown as RelationHypothesis["factors"];
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function surfaceShape(value: string): string {
  if (!value) return "empty";
  return [...value].slice(0, 8).map(char => {
    if (/\p{Letter}/u.test(char)) return "L";
    if (/\p{Number}/u.test(char)) return "N";
    if (/\p{Mark}/u.test(char)) return "M";
    if (/\p{Punctuation}/u.test(char)) return "P";
    if (/\p{Symbol}/u.test(char)) return "S";
    if (/\p{Separator}/u.test(char)) return "Z";
    return "O";
  }).join("");
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
