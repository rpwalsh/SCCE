import type { EvidenceId, EvidenceSpan, JsonValue } from "./types.js";
import { clamp01, mean } from "./primitives.js";

export interface EvidenceMassWitness {
  span: EvidenceSpan;
  contradiction: number;
  coverage: number;
  vector: number;
  field: number;
  faithfulness: number;
  transformations: ReadonlyArray<{ confidence: number }>;
}

export interface SourceEvidenceMassContribution {
  evidenceId: EvidenceId;
  sourceVersionId: EvidenceSpan["sourceVersionId"];
  independenceGroup: string | null;
  sourceVectorAvailable: boolean;
  sourceReliability: number;
  directness: number;
  freshness: number;
  extractionReliability: number;
  sourceWeight: number;
  supportSignal: number;
  contradictionSignal: number;
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
}

export interface SourceDependenceGroupMass {
  groupId: string;
  resolved: boolean;
  evidenceIds: EvidenceId[];
  sourceVersionIds: EvidenceSpan["sourceVersionId"][];
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
}

export interface SourceDependentEvidenceMass {
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
  belief: number;
  plausibility: number;
  contradictionRatio: number;
  independentGroupCount: number;
  unresolvedEvidenceCount: number;
  sourceVectorCoverage: number;
  groups: SourceDependenceGroupMass[];
  contributions: SourceEvidenceMassContribution[];
}

export interface EvidenceSourceVectorAssessment {
  available: boolean;
  independenceGroup: string | null;
  sourceReliability: number;
  directness: number;
  freshness: number;
  extractionReliability: number;
  sourceWeight: number;
}

/**
 * Aggregates evidence as a truth-maintenance mass ledger.
 *
 * A dependence group contributes at most its strongest support and contradiction
 * mass. Repeated spans from the same upstream source therefore cannot masquerade
 * as independent corroboration. Missing or malformed source vectors contribute
 * only uncertainty; scalar trust and span alpha are intentionally ignored.
 */
export function aggregateSourceDependentEvidence(input: {
  supporting: readonly EvidenceMassWitness[];
  contradictions?: readonly EvidenceMassWitness[];
}): SourceDependentEvidenceMass {
  const records = new Map<string, {
    witness: EvidenceMassWitness;
    supports: boolean;
    contradicts: boolean;
  }>();
  for (const item of input.supporting) {
    records.set(String(item.span.id), { witness: item, supports: true, contradicts: false });
  }
  for (const item of input.contradictions ?? []) {
    const current = records.get(String(item.span.id));
    records.set(String(item.span.id), current
      ? { ...current, contradicts: true }
      : { witness: item, supports: false, contradicts: true });
  }

  const contributions = [...records.values()].map(record => evidenceMassContribution(record));
  const grouped = new Map<string, SourceEvidenceMassContribution[]>();
  for (const contribution of contributions) {
    const key = contribution.independenceGroup ?? "dep.unresolved";
    const group = grouped.get(key) ?? [];
    group.push(contribution);
    grouped.set(key, group);
  }
  const groups: SourceDependenceGroupMass[] = [...grouped.entries()]
    .map(([groupId, items]) => {
      const supportMass = maximum(items.map(item => item.supportMass));
      const contradictionMass = maximum(items.map(item => item.contradictionMass));
      return {
        groupId,
        resolved: groupId !== "dep.unresolved",
        evidenceIds: items.map(item => item.evidenceId),
        sourceVersionIds: [...new Map(items.map(item => [String(item.sourceVersionId), item.sourceVersionId])).values()],
        supportMass,
        contradictionMass,
        uncertaintyMass: clamp01(1 - Math.min(1, supportMass + contradictionMass))
      };
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));

  const supportMass = groups.reduce((sum, group) => sum + group.supportMass, 0);
  const contradictionMass = groups.reduce((sum, group) => sum + group.contradictionMass, 0);
  const uncertaintyMass = groups.length
    ? groups.reduce((sum, group) => sum + group.uncertaintyMass, 0) + Number.EPSILON
    : 1;
  const normalizer = supportMass + contradictionMass + uncertaintyMass;
  return {
    supportMass,
    contradictionMass,
    uncertaintyMass,
    belief: normalizer > 0 ? supportMass / normalizer : 0,
    plausibility: normalizer > 0 ? (supportMass + uncertaintyMass) / normalizer : 1,
    contradictionRatio: normalizer > 0 ? contradictionMass / normalizer : 0,
    independentGroupCount: groups.filter(group => group.resolved && group.supportMass > 0).length,
    unresolvedEvidenceCount: contributions.filter(item => !item.sourceVectorAvailable).length,
    sourceVectorCoverage: contributions.length
      ? contributions.filter(item => item.sourceVectorAvailable).length / contributions.length
      : 0,
    groups,
    contributions
  };
}

export function assessEvidenceSourceVector(span: EvidenceSpan): EvidenceSourceVectorAssessment {
  const trust = jsonRecord(span.trustVector);
  const sourceTrust = jsonRecord(trust?.sourceTrust);
  if (!sourceTrust) return unavailableSourceVector();
  const identity = unitInterval(sourceTrust.identity);
  const integrity = unitInterval(sourceTrust.integrity);
  const parserReliability = unitInterval(sourceTrust.parserReliability);
  const directness = unitInterval(sourceTrust.directness);
  const authority = unitInterval(sourceTrust.authority);
  const freshness = unitInterval(sourceTrust.freshness);
  const independenceGroup = typeof sourceTrust.independenceGroup === "string"
    ? sourceTrust.independenceGroup.trim()
    : "";
  if (
    identity === undefined
    || integrity === undefined
    || parserReliability === undefined
    || directness === undefined
    || authority === undefined
    || freshness === undefined
    || !independenceGroup
  ) {
    return unavailableSourceVector();
  }
  const structuralConfidence = unitInterval(trust?.structuralConfidence) ?? parserReliability;
  const sourceReliability = geometricMean([identity, integrity, authority]);
  const extractionReliability = geometricMean([parserReliability, structuralConfidence]);
  return {
    available: true,
    independenceGroup,
    sourceReliability,
    directness,
    freshness,
    extractionReliability,
    sourceWeight: clamp01(sourceReliability * directness * freshness * extractionReliability)
  };
}

function evidenceMassContribution(input: {
  witness: EvidenceMassWitness;
  supports: boolean;
  contradicts: boolean;
}): SourceEvidenceMassContribution {
  const source = assessEvidenceSourceVector(input.witness.span);
  const supportSignal = input.supports ? semanticEvidenceSignal(input.witness) : 0;
  const contradictionSignal = input.contradicts ? clamp01(input.witness.contradiction) : 0;
  const supportMass = source.sourceWeight * supportSignal;
  const contradictionMass = source.sourceWeight * contradictionSignal;
  return {
    evidenceId: input.witness.span.id,
    sourceVersionId: input.witness.span.sourceVersionId,
    independenceGroup: source.independenceGroup,
    sourceVectorAvailable: source.available,
    sourceReliability: source.sourceReliability,
    directness: source.directness,
    freshness: source.freshness,
    extractionReliability: source.extractionReliability,
    sourceWeight: source.sourceWeight,
    supportSignal,
    contradictionSignal,
    supportMass,
    contradictionMass,
    uncertaintyMass: clamp01(1 - Math.min(1, supportMass + contradictionMass))
  };
}

function semanticEvidenceSignal(witness: EvidenceMassWitness): number {
  const transform = witness.transformations.length
    ? Math.max(...witness.transformations.map(item => clamp01(item.confidence)))
    : 1;
  const factors = [
    witness.coverage,
    witness.vector,
    witness.faithfulness,
    transform,
    ...(witness.field > 0 ? [witness.field] : [])
  ].map(clamp01);
  return geometricMean(factors);
}

function unavailableSourceVector(): EvidenceSourceVectorAssessment {
  return {
    available: false,
    independenceGroup: null,
    sourceReliability: 0,
    directness: 0,
    freshness: 0,
    extractionReliability: 0,
    sourceWeight: 0
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function unitInterval(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function geometricMean(values: readonly number[]): number {
  if (!values.length) return 0;
  const normalized = values.map(clamp01);
  if (normalized.some(value => value === 0)) return 0;
  return clamp01(Math.exp(mean(normalized.map(value => Math.log(value)))));
}

function maximum(values: readonly number[]): number {
  return values.length ? Math.max(...values) : 0;
}
