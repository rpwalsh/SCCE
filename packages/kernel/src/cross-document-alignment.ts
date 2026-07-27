import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidateSupport,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import type { SparseFusedTransportPlan } from "./sparse-fused-transport.js";
import type { Hasher, JsonValue } from "./types.js";

export const CROSS_DOCUMENT_ALIGNMENT_SCHEMA =
  "scce.cross_document_alignment_consistency.v1" as const;

export interface CanonicalGraphRegionProjection {
  supportId: string;
  transportPlanId: string;
  latticeId: string;
  sourceFamilyId: string;
  bindings: Array<{
    graphPortKey: string;
    graphTargetId: string;
    mass: number;
    surfaceFormClassIds: string[];
  }>;
}

export interface CrossDocumentGraphPortEstimate {
  graphPortKey: string;
  graphTargetId: string;
  meanMass: number;
  robustDispersion: number;
  observedFamilyCount: number;
  totalFamilyCount: number;
  incompatibilityCost: number;
  familyCorrections: Array<{
    sourceFamilyId: string;
    mass: number;
    signedCorrection: number;
  }>;
}

export interface CrossDocumentAlignmentModel {
  schema: typeof CROSS_DOCUMENT_ALIGNMENT_SCHEMA;
  id: string;
  targetIndexId: string;
  trainingSupportIds: string[];
  sourceFamilyIds: string[];
  projections: CanonicalGraphRegionProjection[];
  estimates: CrossDocumentGraphPortEstimate[];
  pairwiseDistances: Array<{
    leftSourceFamilyId: string;
    rightSourceFamilyId: string;
    distance: number;
  }>;
  audit: JsonValue;
}

export function compileCrossDocumentAlignmentModel(input: {
  supports: readonly SparseAlignmentCandidateSupport[];
  plans: readonly SparseFusedTransportPlan[];
  targetIndex: SparseAlignmentTargetIndex;
  hasher?: Hasher;
}): CrossDocumentAlignmentModel {
  if (input.supports.length !== input.plans.length) {
    throw new Error("cross-document alignment requires one plan per support");
  }
  const hasher = input.hasher ?? createHasher();
  const targetById = new Map(input.targetIndex.targets.map(target => [
    target.id,
    target
  ]));
  const projections = input.supports.map((support, index) =>
    projectAlignment({
      support,
      plan: input.plans[index]!,
      targetIndexId: input.targetIndex.id,
      targetById
    }));
  const familyProjections = aggregateFamilyProjections(projections);
  const sourceFamilyIds = [...familyProjections.keys()].sort();
  const graphPortKeys = [...new Set(projections.flatMap(projection =>
    projection.bindings.map(binding => binding.graphPortKey)))].sort();
  const estimates = graphPortKeys.map(graphPortKey => {
    const masses = sourceFamilyIds.map(familyId =>
      familyProjections.get(familyId)?.get(graphPortKey) ?? 0);
    const meanMass = mean(masses);
    const robustDispersion = mean(masses.map(mass => Math.abs(mass - meanMass)));
    const observedFamilyCount = masses.filter(mass => mass > 1e-15).length;
    const target = input.targetIndex.targets.find(item =>
      canonicalGraphPortKey(item.id, item.kind, item.roleId, item.realization)
      === graphPortKey);
    const missingRate = sourceFamilyIds.length
      ? 1 - observedFamilyCount / sourceFamilyIds.length
      : 1;
    const familyCorrections = sourceFamilyIds.map((sourceFamilyId, index) => {
      const mass = masses[index] ?? 0;
      const comparisons = masses.filter((_, other) => other !== index);
      const signedCorrection = comparisons.length
        ? comparisons.reduce((sum, otherMass) =>
          sum + Math.sign(mass - otherMass), 0) / comparisons.length
        : 0;
      return {
        sourceFamilyId,
        mass: quantize(mass),
        signedCorrection: quantize(signedCorrection)
      };
    });
    return {
      graphPortKey,
      graphTargetId: target?.id ?? graphPortKey,
      meanMass: quantize(meanMass),
      robustDispersion: quantize(robustDispersion),
      observedFamilyCount,
      totalFamilyCount: sourceFamilyIds.length,
      incompatibilityCost: quantize(Math.min(
        4,
        missingRate + robustDispersion / Math.max(1e-9, meanMass)
      )),
      familyCorrections
    };
  });
  const pairwiseDistances = familyPairs(sourceFamilyIds).map(([left, right]) => ({
    leftSourceFamilyId: left,
    rightSourceFamilyId: right,
    distance: quantize(l1ProjectionDistance(
      familyProjections.get(left) ?? new Map(),
      familyProjections.get(right) ?? new Map(),
      graphPortKeys
    ))
  }));
  const trainingSupportIds = input.supports.map(support => support.id).sort();
  const canonical = {
    schema: CROSS_DOCUMENT_ALIGNMENT_SCHEMA,
    targetIndexId: input.targetIndex.id,
    trainingSupportIds,
    sourceFamilyIds,
    projections,
    estimates,
    pairwiseDistances
  };
  return {
    ...canonical,
    id: `crossdoc_alignment.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.cross_document_alignment.canonical_port_projection.v1",
      projectionCount: projections.length,
      independentSourceFamilyCount: sourceFamilyIds.length,
      graphPortEstimateCount: estimates.length,
      pairwiseComparisonCount: pairwiseDistances.length,
      copiedSourcesCollapsedByFamily: true,
      commonGraphRepresentation: input.targetIndex.id,
      calibratedConfidenceClaimed: false
    })
  };
}

export function crossDocumentCost(
  model: CrossDocumentAlignmentModel,
  graphTargetId: string,
  sourceFamilyId: string
): number {
  return model.estimates.find(estimate =>
    estimate.graphTargetId === graphTargetId)?.familyCorrections.find(row =>
    row.sourceFamilyId === sourceFamilyId)?.signedCorrection ?? 0;
}

function projectAlignment(input: {
  support: SparseAlignmentCandidateSupport;
  plan: SparseFusedTransportPlan;
  targetIndexId: string;
  targetById: ReadonlyMap<string, {
    id: string;
    kind: "relation" | "incidence";
    roleId?: string;
    realization?: "observed" | "omitted";
  }>;
}): CanonicalGraphRegionProjection {
  if (input.support.targetIndexId !== input.targetIndexId
    || input.plan.targetIndexId !== input.targetIndexId
    || input.plan.supportId !== input.support.id) {
    throw new Error("cross-document projection contracts do not match");
  }
  const candidateById = new Map(input.support.candidates.map(candidate => [
    candidate.id,
    candidate
  ]));
  const bindings = new Map<string, {
    graphPortKey: string;
    graphTargetId: string;
    mass: number;
    surfaceFormClassIds: Set<string>;
  }>();
  for (const cell of input.plan.cells) {
    if (cell.mass <= 0) continue;
    const candidate = candidateById.get(cell.candidateId);
    const target = input.targetById.get(cell.graphTargetId);
    if (!candidate || !target) continue;
    const graphPortKey = canonicalGraphPortKey(
      target.id,
      target.kind,
      target.roleId,
      target.realization
    );
    const existing = bindings.get(graphPortKey) ?? {
      graphPortKey,
      graphTargetId: target.id,
      mass: 0,
      surfaceFormClassIds: new Set<string>()
    };
    existing.mass += cell.mass;
    existing.surfaceFormClassIds.add(candidate.surfaceFormClassId);
    bindings.set(graphPortKey, existing);
  }
  return {
    supportId: input.support.id,
    transportPlanId: input.plan.id,
    latticeId: input.support.latticeId,
    sourceFamilyId: input.support.sourceFamilyId,
    bindings: [...bindings.values()].map(binding => ({
      graphPortKey: binding.graphPortKey,
      graphTargetId: binding.graphTargetId,
      mass: quantize(binding.mass),
      surfaceFormClassIds: [...binding.surfaceFormClassIds].sort()
    })).sort((left, right) => left.graphPortKey.localeCompare(right.graphPortKey))
  };
}

function canonicalGraphPortKey(
  targetId: string,
  kind: "relation" | "incidence",
  roleId: string | undefined,
  realization: "observed" | "omitted" | undefined
): string {
  return kind === "relation"
    ? `relation\u001f${targetId}`
    : `port\u001f${targetId}\u001f${roleId ?? ""}\u001f${realization ?? ""}`;
}

function aggregateFamilyProjections(
  projections: readonly CanonicalGraphRegionProjection[]
): Map<string, Map<string, number>> {
  const familyDocuments = new Map<string, Map<string, number>[]>();
  for (const projection of projections) {
    const values = new Map(projection.bindings.map(binding => [
      binding.graphPortKey,
      binding.mass
    ]));
    const documents = familyDocuments.get(projection.sourceFamilyId) ?? [];
    documents.push(values);
    familyDocuments.set(projection.sourceFamilyId, documents);
  }
  const result = new Map<string, Map<string, number>>();
  for (const [familyId, documents] of familyDocuments) {
    const keys = [...new Set(documents.flatMap(document => [...document.keys()]))];
    result.set(familyId, new Map(keys.map(key => [
      key,
      mean(documents.map(document => document.get(key) ?? 0))
    ])));
  }
  return result;
}

function l1ProjectionDistance(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
  keys: readonly string[]
): number {
  return keys.reduce((sum, key) =>
    sum + Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0)), 0);
}

function familyPairs(values: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let left = 0; left < values.length; left++) {
    for (let right = left + 1; right < values.length; right++) {
      pairs.push([values[left]!, values[right]!]);
    }
  }
  return pairs;
}

function mean(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
