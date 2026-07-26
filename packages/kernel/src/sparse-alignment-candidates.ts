import { createCanonicalIdentity } from "./canonical-identity.js";
import {
  canonicalNormalizationContract,
  normalizeCanonicalSurface,
  type NormalizationContract
} from "./normalization-contract.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { SurfaceLattice, SurfaceLatticeUnit } from "./surface-lattice.js";
import {
  liftHyperedgesToTypedIncidenceGraph,
  type TypedIncidenceGraph
} from "./typed-incidence-graph.js";
import type {
  GraphNode,
  Hasher,
  Hyperedge,
  JsonValue,
  NodeId
} from "./types.js";

export const SPARSE_ALIGNMENT_TARGET_INDEX_SCHEMA =
  "scce.sparse_alignment_target_index.v1" as const;
export const SPARSE_ALIGNMENT_CANDIDATE_SUPPORT_SCHEMA =
  "scce.sparse_alignment_candidate_support.v1" as const;

export type SparseAlignmentTargetKind = "relation" | "incidence";
export type SparseAlignmentSupportKind =
  | "exact_observable_anchor"
  | "shared_exact_evidence"
  | "typed_incidence_structure"
  | "surface_context";

export interface SparseAlignmentTarget {
  id: string;
  kind: SparseAlignmentTargetKind;
  relationNodeId: NodeId;
  hyperedgeId: string;
  incidenceId?: string;
  participantNodeId?: NodeId;
  portId?: string;
  roleId?: string;
  valueKind?: string;
  realization?: "observed" | "omitted";
  evidenceIds: string[];
  observableSurfaceKeys: string[];
}

export interface SparseAlignmentPosting {
  key: string;
  targetIds: string[];
  omittedTargetCount: number;
}

export interface SparseAlignmentTargetIndex {
  schema: typeof SPARSE_ALIGNMENT_TARGET_INDEX_SCHEMA;
  id: string;
  normalizationContractId: string;
  incidenceGraphId: string;
  targets: SparseAlignmentTarget[];
  evidencePostings: SparseAlignmentPosting[];
  surfacePostings: SparseAlignmentPosting[];
  relationMemberPostings: SparseAlignmentPosting[];
  maxTargetsPerPosting: number;
  audit: JsonValue;
}

export interface SparseAlignmentCandidate {
  id: string;
  surfaceUnitId: string;
  graphTargetId: string;
  graphTargetKind: SparseAlignmentTargetKind;
  supportKinds: SparseAlignmentSupportKind[];
  score: number;
  surfaceEvidenceIds: string[];
  graphEvidenceIds: string[];
  sharedEvidenceIds: string[];
  sourceCoordinates: {
    byteStart: number;
    byteEnd: number;
    utf16Start: number;
    utf16End: number;
    codePointStart: number;
    codePointEnd: number;
    graphemeStart: number;
    graphemeEnd: number;
  };
}

export interface SparseAlignmentCandidateRow {
  surfaceUnitId: string;
  candidateIds: string[];
  omittedCandidateCount: number;
}

export interface SparseAlignmentCandidateSupport {
  schema: typeof SPARSE_ALIGNMENT_CANDIDATE_SUPPORT_SCHEMA;
  id: string;
  latticeId: string;
  targetIndexId: string;
  incidenceGraphId: string;
  maxCandidateDegree: number;
  candidates: SparseAlignmentCandidate[];
  rows: SparseAlignmentCandidateRow[];
  audit: JsonValue;
}

export function compileSparseAlignmentTargetIndex(input: {
  incidenceGraph: TypedIncidenceGraph;
  nodes: readonly GraphNode[];
  normalizationContract?: NormalizationContract;
  maxTargetsPerPosting?: number;
  hasher?: Hasher;
}): SparseAlignmentTargetIndex {
  const hasher = input.hasher ?? createHasher();
  const normalizationContract = input.normalizationContract
    ?? canonicalNormalizationContract(hasher);
  const maxTargetsPerPosting = boundedPostingLimit(input.maxTargetsPerPosting);
  const nodeById = new Map(input.nodes.map(node => [String(node.id), node]));
  const targets: SparseAlignmentTarget[] = [];

  for (const relation of input.incidenceGraph.relationNodes) {
    targets.push({
      id: `alignment_target.relation.${hasher.digestHex(canonicalStringify([
        input.incidenceGraph.id,
        relation.id,
        relation.hyperedgeId
      ])).slice(0, 40)}`,
      kind: "relation",
      relationNodeId: relation.id,
      hyperedgeId: String(relation.hyperedgeId),
      evidenceIds: canonicalStrings(relation.evidenceIds),
      observableSurfaceKeys: []
    });
  }
  const relationTargetByNode = new Map(
    targets.map(target => [String(target.relationNodeId), target])
  );
  for (const incidence of input.incidenceGraph.incidences) {
    const participant = incidence.participantNodeId
      ? nodeById.get(String(incidence.participantNodeId))
      : undefined;
    targets.push({
      id: `alignment_target.incidence.${hasher.digestHex(canonicalStringify([
        input.incidenceGraph.id,
        incidence.id
      ])).slice(0, 40)}`,
      kind: "incidence",
      relationNodeId: incidence.relationNodeId,
      hyperedgeId: String(incidence.hyperedgeId),
      incidenceId: incidence.id,
      ...(incidence.participantNodeId
        ? { participantNodeId: incidence.participantNodeId }
        : {}),
      portId: incidence.portId,
      roleId: incidence.roleId,
      valueKind: incidence.valueKind,
      realization: incidence.realization,
      evidenceIds: canonicalStrings(incidence.evidenceIds),
      observableSurfaceKeys: participant
        ? observableSurfaceKeys(participant.representation, normalizationContract)
        : []
    });
  }
  targets.sort((left, right) => left.id.localeCompare(right.id));

  const evidence = new Map<string, string[]>();
  const surfaces = new Map<string, string[]>();
  const relationMembers = new Map<string, string[]>();
  for (const target of targets) {
    for (const evidenceId of target.evidenceIds) appendPosting(evidence, evidenceId, target.id);
    for (const key of target.observableSurfaceKeys) appendPosting(surfaces, key, target.id);
    if (target.kind === "incidence") {
      appendPosting(relationMembers, String(target.relationNodeId), target.id);
      const relationTarget = relationTargetByNode.get(String(target.relationNodeId));
      if (relationTarget) {
        for (const key of target.observableSurfaceKeys) {
          appendPosting(surfaces, key, relationTarget.id);
        }
      }
    }
  }
  const evidencePostings = compilePostings(evidence, maxTargetsPerPosting);
  const surfacePostings = compilePostings(surfaces, maxTargetsPerPosting);
  const relationMemberPostings = compilePostings(relationMembers, maxTargetsPerPosting);
  const canonical = {
    schema: SPARSE_ALIGNMENT_TARGET_INDEX_SCHEMA,
    normalizationContractId: normalizationContract.id,
    incidenceGraphId: input.incidenceGraph.id,
    targets,
    evidencePostings,
    surfacePostings,
    relationMemberPostings,
    maxTargetsPerPosting
  };
  return {
    ...canonical,
    id: createCanonicalIdentity({
      kind: "alignment_target_index",
      fields: {
        typedIncidenceGraphId: input.incidenceGraph.id,
        normalizationContractId: normalizationContract.id,
        maxTargetsPerPosting,
        targetIds: targets.map(target => target.id)
      },
      normalizationContract,
      hasher
    }).id,
    audit: toJsonValue({
      compiler: "kernel.sparse_alignment.target_index.v1",
      targetCount: targets.length,
      relationTargetCount: targets.filter(target => target.kind === "relation").length,
      incidenceTargetCount: targets.filter(target => target.kind === "incidence").length,
      evidencePostingCount: evidencePostings.length,
      surfacePostingCount: surfacePostings.length,
      relationMemberPostingCount: relationMemberPostings.length,
      omittedPostingTargets: [
        ...evidencePostings,
        ...surfacePostings,
        ...relationMemberPostings
      ].reduce((sum, posting) => sum + posting.omittedTargetCount, 0),
      denseMatrixMaterialized: false
    })
  };
}

export function generateSparseAlignmentCandidates(input: {
  lattice: SurfaceLattice;
  targetIndex: SparseAlignmentTargetIndex;
  maxCandidateDegree?: number;
  hasher?: Hasher;
}): SparseAlignmentCandidateSupport {
  const hasher = input.hasher ?? createHasher();
  if (input.targetIndex.normalizationContractId !== input.lattice.normalizationContract.id) {
    throw new Error("sparse alignment normalization contract mismatch");
  }
  const maxCandidateDegree = boundedCandidateDegree(input.maxCandidateDegree);
  const targetById = new Map(input.targetIndex.targets.map(target => [target.id, target]));
  const evidencePostings = postingMap(input.targetIndex.evidencePostings);
  const surfacePostings = postingMap(input.targetIndex.surfacePostings);
  const relationMembers = postingMap(input.targetIndex.relationMemberPostings);
  const relationTargetByNodeId = new Map(input.targetIndex.targets
    .filter(target => target.kind === "relation")
    .map(target => [String(target.relationNodeId), target]));
  const candidates: SparseAlignmentCandidate[] = [];
  const rows: SparseAlignmentCandidateRow[] = [];

  for (const unit of [...input.lattice.units].sort(surfaceUnitOrder)) {
    const supportByTarget = new Map<string, Set<SparseAlignmentSupportKind>>();
    const exactTargetIds = surfacePostings.get(surfaceKey(
      unit.normalized,
      input.lattice.normalizationContract
    )) ?? [];
    for (const targetId of exactTargetIds) {
      addSupport(supportByTarget, targetId, "exact_observable_anchor");
      const target = targetById.get(targetId);
      if (target?.kind === "incidence") {
        const relation = relationTargetByNodeId.get(String(target.relationNodeId));
        if (relation) addSupport(supportByTarget, relation.id, "typed_incidence_structure");
        for (const memberId of relationMembers.get(String(target.relationNodeId)) ?? []) {
          if (memberId !== target.id) {
            addSupport(supportByTarget, memberId, "typed_incidence_structure");
          }
        }
      }
    }
    for (const evidenceId of unit.evidenceIds) {
      for (const targetId of evidencePostings.get(String(evidenceId)) ?? []) {
        addSupport(supportByTarget, targetId, "shared_exact_evidence");
      }
    }
    for (const context of [...unit.leftContextSketch, ...unit.rightContextSketch]) {
      const key = surfaceKey(context, input.lattice.normalizationContract);
      for (const targetId of surfacePostings.get(key) ?? []) {
        addSupport(supportByTarget, targetId, "surface_context");
      }
    }

    const scored = [...supportByTarget].flatMap(([targetId, kinds]) => {
      const target = targetById.get(targetId);
      if (!target) return [];
      return [{
        target,
        supportKinds: [...kinds].sort(),
        score: candidateSupportScore(kinds)
      }];
    }).sort((left, right) =>
      right.score - left.score
      || targetKindOrder(left.target.kind) - targetKindOrder(right.target.kind)
      || left.target.id.localeCompare(right.target.id));
    const retained = scored.slice(0, maxCandidateDegree);
    const rowCandidateIds: string[] = [];
    for (const item of retained) {
      const sharedEvidenceIds = intersection(unit.evidenceIds, item.target.evidenceIds);
      const candidate: SparseAlignmentCandidate = {
        id: `alignment_candidate.${hasher.digestHex(canonicalStringify([
          input.lattice.id,
          unit.id,
          item.target.id,
          item.supportKinds
        ])).slice(0, 40)}`,
        surfaceUnitId: unit.id,
        graphTargetId: item.target.id,
        graphTargetKind: item.target.kind,
        supportKinds: item.supportKinds,
        score: item.score,
        surfaceEvidenceIds: canonicalStrings(unit.evidenceIds),
        graphEvidenceIds: item.target.evidenceIds,
        sharedEvidenceIds,
        sourceCoordinates: coordinates(unit)
      };
      candidates.push(candidate);
      rowCandidateIds.push(candidate.id);
    }
    rows.push({
      surfaceUnitId: unit.id,
      candidateIds: rowCandidateIds,
      omittedCandidateCount: Math.max(0, scored.length - retained.length)
    });
  }
  if (candidates.length > input.lattice.units.length * maxCandidateDegree) {
    throw new Error("sparse alignment candidate degree invariant violated");
  }
  const canonical = {
    schema: SPARSE_ALIGNMENT_CANDIDATE_SUPPORT_SCHEMA,
    latticeId: input.lattice.id,
    targetIndexId: input.targetIndex.id,
    incidenceGraphId: input.targetIndex.incidenceGraphId,
    maxCandidateDegree,
    candidates,
    rows
  };
  return {
    ...canonical,
    id: `alignment_support.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.sparse_alignment.candidate_support.v1",
      surfaceUnitCount: input.lattice.units.length,
      graphTargetCount: input.targetIndex.targets.length,
      candidateCount: candidates.length,
      maximumObservedDegree: Math.max(0, ...rows.map(row => row.candidateIds.length)),
      omittedCandidateCount: rows.reduce(
        (sum, row) => sum + row.omittedCandidateCount,
        0
      ),
      densePairCount: input.lattice.units.length * input.targetIndex.targets.length,
      materializedPairFraction: input.lattice.units.length && input.targetIndex.targets.length
        ? candidates.length / (input.lattice.units.length * input.targetIndex.targets.length)
        : 0,
      memoryBound: `O(|S|*${maxCandidateDegree})`,
      candidatesOutsideSupportHaveZeroMass: true,
      denseMatrixMaterialized: false
    })
  };
}

export function compileSparseAlignmentCandidateSupports(input: {
  lattices: readonly SurfaceLattice[];
  nodes: readonly GraphNode[];
  hyperedges: readonly Hyperedge[];
  maxCandidateDegree?: number;
  maxTargetsPerPosting?: number;
  hasher?: Hasher;
}): {
  incidenceGraph: TypedIncidenceGraph;
  targetIndex: SparseAlignmentTargetIndex;
  supports: SparseAlignmentCandidateSupport[];
} {
  const hasher = input.hasher ?? createHasher();
  const incidenceGraph = liftHyperedgesToTypedIncidenceGraph({
    hyperedges: input.hyperedges,
    hasher
  });
  const normalizationContract = input.lattices[0]?.normalizationContract
    ?? canonicalNormalizationContract(hasher);
  for (const lattice of input.lattices) {
    if (lattice.normalizationContract.id !== normalizationContract.id) {
      throw new Error("sparse alignment batch contains mixed normalization contracts");
    }
  }
  const targetIndex = compileSparseAlignmentTargetIndex({
    incidenceGraph,
    nodes: input.nodes,
    normalizationContract,
    maxTargetsPerPosting: input.maxTargetsPerPosting,
    hasher
  });
  return {
    incidenceGraph,
    targetIndex,
    supports: input.lattices.map(lattice => generateSparseAlignmentCandidates({
      lattice,
      targetIndex,
      maxCandidateDegree: input.maxCandidateDegree,
      hasher
    }))
  };
}

export function sparseAlignmentCandidatesForUnit(
  support: SparseAlignmentCandidateSupport,
  surfaceUnitId: string
): SparseAlignmentCandidate[] {
  const ids = new Set(
    support.rows.find(row => row.surfaceUnitId === surfaceUnitId)?.candidateIds ?? []
  );
  return support.candidates.filter(candidate => ids.has(candidate.id));
}

function observableSurfaceKeys(
  value: JsonValue,
  contract: NormalizationContract
): string[] {
  const values: string[] = [];
  const visit = (current: JsonValue, depth: number) => {
    if (depth > 6 || values.length >= 64) return;
    if (typeof current === "string") {
      if (current.trim()) values.push(surfaceKey(current, contract));
      return;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      values.push(surfaceKey(String(current), contract));
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (current && typeof current === "object") {
      for (const key of Object.keys(current).sort()) visit(current[key]!, depth + 1);
    }
  };
  visit(value, 0);
  return [...new Set(values)].sort();
}

function surfaceKey(value: string, contract: NormalizationContract): string {
  return normalizeCanonicalSurface(value, contract);
}

function appendPosting(map: Map<string, string[]>, key: string, targetId: string): void {
  const values = map.get(key) ?? [];
  values.push(targetId);
  map.set(key, values);
}

function compilePostings(
  values: ReadonlyMap<string, readonly string[]>,
  limit: number
): SparseAlignmentPosting[] {
  return [...values].map(([key, targetIds]) => {
    const unique = [...new Set(targetIds)].sort();
    return {
      key,
      targetIds: unique.slice(0, limit),
      omittedTargetCount: Math.max(0, unique.length - limit)
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function postingMap(postings: readonly SparseAlignmentPosting[]): Map<string, string[]> {
  return new Map(postings.map(posting => [posting.key, posting.targetIds]));
}

function addSupport(
  support: Map<string, Set<SparseAlignmentSupportKind>>,
  targetId: string,
  kind: SparseAlignmentSupportKind
): void {
  const kinds = support.get(targetId) ?? new Set<SparseAlignmentSupportKind>();
  kinds.add(kind);
  support.set(targetId, kinds);
}

function candidateSupportScore(kinds: ReadonlySet<SparseAlignmentSupportKind>): number {
  const complement = [...kinds].reduce((remaining, kind) => {
    const support = kind === "exact_observable_anchor"
      ? 0.98
      : kind === "shared_exact_evidence"
        ? 0.64
        : kind === "typed_incidence_structure"
          ? 0.46
          : 0.28;
    return remaining * (1 - support);
  }, 1);
  return quantize(1 - complement);
}

function intersection(left: readonly unknown[], right: readonly unknown[]): string[] {
  const rightSet = new Set(right.map(String));
  return canonicalStrings(left).filter(value => rightSet.has(value));
}

function canonicalStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.map(String))].sort();
}

function coordinates(unit: SurfaceLatticeUnit): SparseAlignmentCandidate["sourceCoordinates"] {
  return {
    byteStart: unit.byteStart,
    byteEnd: unit.byteEnd,
    utf16Start: unit.utf16Start,
    utf16End: unit.utf16End,
    codePointStart: unit.codePointStart,
    codePointEnd: unit.codePointEnd,
    graphemeStart: unit.graphemeStart,
    graphemeEnd: unit.graphemeEnd
  };
}

function surfaceUnitOrder(left: SurfaceLatticeUnit, right: SurfaceLatticeUnit): number {
  return left.byteStart - right.byteStart
    || left.byteEnd - right.byteEnd
    || left.id.localeCompare(right.id);
}

function targetKindOrder(kind: SparseAlignmentTargetKind): number {
  return kind === "incidence" ? 0 : 1;
}

function boundedPostingLimit(value?: number): number {
  return Math.max(8, Math.min(512, Math.floor(value ?? 128)));
}

function boundedCandidateDegree(value?: number): number {
  return Math.max(1, Math.min(64, Math.floor(value ?? 16)));
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
