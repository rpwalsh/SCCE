// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import type {
  SparseAlignmentCandidate,
  SparseAlignmentCandidateSupport
} from "./sparse-alignment-candidates.js";
import type { SparseFusedTransportPlan } from "./sparse-fused-transport.js";
import type { Hasher, JsonValue } from "./types.js";

export const TRANSPORT_EVIDENCE_ALLOCATION_SCHEMA =
  "scce.transport_evidence_allocation.v1" as const;
export const TRANSPORT_EVIDENCE_ALLOCATION_POLICY =
  "scce.transport_evidence.shared_exact_bootstrap.v1" as const;

export interface TransportEvidenceShare {
  evidenceId: string;
  basis: "shared_exact_evidence" | "surface_evidence" | "graph_evidence";
  conditionalProbability: number;
  allocatedMass: number;
}

export interface TransportCellEvidenceAllocation {
  candidateId: string;
  surfaceUnitId: string;
  graphTargetId: string;
  transportMass: number;
  status: "conserved" | "zero_mass" | "unresolved_evidence";
  sourceCoordinates: SparseAlignmentCandidate["sourceCoordinates"];
  shares: TransportEvidenceShare[];
  conditionalProbabilitySum: number;
  allocatedMass: number;
  conservationResidual: number;
}

export interface TransportEvidenceAllocation {
  schema: typeof TRANSPORT_EVIDENCE_ALLOCATION_SCHEMA;
  id: string;
  allocationPolicyId: typeof TRANSPORT_EVIDENCE_ALLOCATION_POLICY;
  transportPlanId: string;
  supportId: string;
  status: "conserved" | "unresolved_evidence";
  cells: TransportCellEvidenceAllocation[];
  totalTransportMass: number;
  totalAllocatedMass: number;
  conservationResidual: number;
  unresolvedCandidateIds: string[];
  audit: JsonValue;
}

export interface TransportEvidenceAllocationRetentionStats {
  seenCells: number;
  reusedCells: number;
  uniqueCells: number;
  indexedCandidates: number;
}

export interface TransportEvidenceAllocationRetentionPolicy {
  compact(allocation: TransportEvidenceAllocation): TransportEvidenceAllocation;
  stats(): TransportEvidenceAllocationRetentionStats;
}

/**
 * Shares immutable cell records across alternative allocations for one
 * support. The allocator itself remains mutable; callers opt into this
 * retention policy only after an allocation is complete.
 */
export function createTransportEvidenceAllocationRetentionInterner(): TransportEvidenceAllocationRetentionPolicy {
  let supportId: string | undefined;
  const cellsByCandidate = new Map<string, TransportCellEvidenceAllocation>();
  const stats: TransportEvidenceAllocationRetentionStats = {
    seenCells: 0,
    reusedCells: 0,
    uniqueCells: 0,
    indexedCandidates: 0
  };
  const compactCell = (cell: TransportCellEvidenceAllocation): TransportCellEvidenceAllocation => {
    stats.seenCells += 1;
    const cached = cellsByCandidate.get(cell.candidateId);
    if (cached && sameTransportCell(cached, cell)) {
      stats.reusedCells += 1;
      return cached;
    }
    const retainedShares = cell.shares.map(share => ({ ...share }));
    for (const share of retainedShares) Object.freeze(share);
    Object.freeze(retainedShares);
    const retained = {
      ...cell,
      sourceCoordinates: freezeSourceCoordinates(cell.sourceCoordinates),
      shares: retainedShares
    };
    Object.freeze(retained);
    cellsByCandidate.set(cell.candidateId, retained);
    stats.uniqueCells += 1;
    stats.indexedCandidates = cellsByCandidate.size;
    return retained;
  };
  return {
    compact(allocation) {
      if (supportId !== allocation.supportId) {
        supportId = allocation.supportId;
        cellsByCandidate.clear();
        stats.indexedCandidates = 0;
      }
      return {
        ...allocation,
        cells: allocation.cells.map(compactCell)
      };
    },
    stats() {
      return { ...stats };
    }
  };
}

function sameTransportCell(
  left: TransportCellEvidenceAllocation,
  right: TransportCellEvidenceAllocation
): boolean {
  if (left.candidateId !== right.candidateId
    || left.surfaceUnitId !== right.surfaceUnitId
    || left.graphTargetId !== right.graphTargetId
    || !Object.is(left.transportMass, right.transportMass)
    || left.status !== right.status
    || !sameSourceCoordinates(left.sourceCoordinates, right.sourceCoordinates)
    || !Object.is(left.conditionalProbabilitySum, right.conditionalProbabilitySum)
    || !Object.is(left.allocatedMass, right.allocatedMass)
    || !Object.is(left.conservationResidual, right.conservationResidual)
    || left.shares.length !== right.shares.length) return false;
  return left.shares.every((share, index) => {
    const other = right.shares[index]!;
    return share.evidenceId === other.evidenceId
      && share.basis === other.basis
      && Object.is(share.conditionalProbability, other.conditionalProbability)
      && Object.is(share.allocatedMass, other.allocatedMass);
  });
}

function freezeSourceCoordinates(
  coordinates: SparseAlignmentCandidate["sourceCoordinates"]
): SparseAlignmentCandidate["sourceCoordinates"] {
  return Object.freeze({ ...coordinates }) as SparseAlignmentCandidate["sourceCoordinates"];
}

function sameSourceCoordinates(
  left: SparseAlignmentCandidate["sourceCoordinates"],
  right: SparseAlignmentCandidate["sourceCoordinates"]
): boolean {
  return left.byteStart === right.byteStart
    && left.byteEnd === right.byteEnd
    && left.utf16Start === right.utf16Start
    && left.utf16End === right.utf16End
    && left.codePointStart === right.codePointStart
    && left.codePointEnd === right.codePointEnd
    && left.graphemeStart === right.graphemeStart
    && left.graphemeEnd === right.graphemeEnd;
}

export function allocateTransportEvidence(input: {
  plan: SparseFusedTransportPlan;
  support: SparseAlignmentCandidateSupport;
  tolerance?: number;
  hasher?: Hasher;
}): TransportEvidenceAllocation {
  if (input.plan.supportId !== input.support.id) {
    throw new Error("transport plan and evidence support do not match");
  }
  const hasher = input.hasher ?? createHasher();
  const tolerance = Math.max(1e-15, Math.min(1e-6, input.tolerance ?? 1e-12));
  const candidateById = uniqueCandidates(input.support.candidates);
  const seenPlanCandidates = new Set<string>();
  const cells: TransportCellEvidenceAllocation[] = input.plan.cells.map(cell => {
    if (seenPlanCandidates.has(cell.candidateId)) {
      throw new Error(`transport plan repeats candidate ${cell.candidateId}`);
    }
    seenPlanCandidates.add(cell.candidateId);
    if (!Number.isFinite(cell.mass) || cell.mass < 0) {
      throw new Error(`transport cell ${cell.candidateId} has invalid mass`);
    }
    const candidate = candidateById.get(cell.candidateId);
    if (!candidate) {
      throw new Error(`transport cell ${cell.candidateId} is outside evidence support`);
    }
    if (candidate.surfaceUnitId !== cell.surfaceUnitId
      || candidate.graphTargetId !== cell.graphTargetId) {
      throw new Error(`transport cell ${cell.candidateId} changes candidate endpoints`);
    }
    if (cell.mass === 0) {
      return {
        candidateId: cell.candidateId,
        surfaceUnitId: cell.surfaceUnitId,
        graphTargetId: cell.graphTargetId,
        transportMass: cell.mass,
        status: "zero_mass",
        sourceCoordinates: candidate.sourceCoordinates,
        shares: [],
        conditionalProbabilitySum: 0,
        allocatedMass: 0,
        conservationResidual: cell.mass
      };
    }
    const evidence = evidenceWeights(candidate);
    if (!evidence.length) {
      return {
        candidateId: cell.candidateId,
        surfaceUnitId: cell.surfaceUnitId,
        graphTargetId: cell.graphTargetId,
        transportMass: cell.mass,
        status: "unresolved_evidence",
        sourceCoordinates: candidate.sourceCoordinates,
        shares: [],
        conditionalProbabilitySum: 0,
        allocatedMass: 0,
        conservationResidual: cell.mass
      };
    }
    const totalWeight = evidence.reduce((sum, item) => sum + item.weight, 0);
    const probabilities = exactPartition(
      evidence.map(item => item.weight / totalWeight),
      1
    );
    const masses = exactPartition(
      probabilities.map(probability => cell.mass * probability),
      cell.mass
    );
    const shares = evidence.map((item, index) => ({
      evidenceId: item.evidenceId,
      basis: item.basis,
      conditionalProbability: probabilities[index]!,
      allocatedMass: masses[index]!
    }));
    const conditionalProbabilitySum = sum(shares.map(share =>
      share.conditionalProbability));
    const allocatedMass = sum(shares.map(share => share.allocatedMass));
    const conservationResidual = Math.abs(cell.mass - allocatedMass);
    return {
      candidateId: cell.candidateId,
      surfaceUnitId: cell.surfaceUnitId,
      graphTargetId: cell.graphTargetId,
      transportMass: cell.mass,
      status: conservationResidual <= tolerance ? "conserved" : "unresolved_evidence",
      sourceCoordinates: candidate.sourceCoordinates,
      shares,
      conditionalProbabilitySum,
      allocatedMass,
      conservationResidual
    };
  });
  const totalTransportMass = sum(input.plan.cells.map(cell => cell.mass));
  const totalAllocatedMass = sum(cells.map(cell => cell.allocatedMass));
  const conservationResidual = Math.abs(totalTransportMass - totalAllocatedMass);
  const unresolvedCandidateIds = cells
    .filter(cell => cell.status === "unresolved_evidence")
    .map(cell => cell.candidateId)
    .sort();
  const canonical = {
    schema: TRANSPORT_EVIDENCE_ALLOCATION_SCHEMA,
    allocationPolicyId: TRANSPORT_EVIDENCE_ALLOCATION_POLICY,
    transportPlanId: input.plan.id,
    supportId: input.support.id,
    status: unresolvedCandidateIds.length || conservationResidual > tolerance
      ? "unresolved_evidence" as const
      : "conserved" as const,
    cells,
    totalTransportMass,
    totalAllocatedMass,
    conservationResidual,
    unresolvedCandidateIds
  };
  return {
    ...canonical,
    id: `transport_evidence.${canonicalDigestHex(canonical, hasher).slice(0, 40)}`,
    audit: toJsonValue({
      allocator: "kernel.transport_evidence.normalized_conditional.v1",
      allocationPolicyId: TRANSPORT_EVIDENCE_ALLOCATION_POLICY,
      calibratedPosteriorClaimed: false,
      equation: "R_uv_epsilon=Pi_uv*q(epsilon|u,v)",
      cellCount: cells.length,
      positiveMassCellCount: cells.filter(cell => cell.transportMass > tolerance).length,
      conservedCellCount: cells.filter(cell => cell.status === "conserved").length,
      zeroMassCellCount: cells.filter(cell => cell.status === "zero_mass").length,
      unresolvedCellCount: unresolvedCandidateIds.length,
      maximumCellResidual: cells.reduce((maximum, cell) => Math.max(maximum, cell.conservationResidual), 0),
      totalConservationResidual: conservationResidual,
      duplicatedTransportMass: false
    })
  };
}

function evidenceWeights(candidate: SparseAlignmentCandidate): Array<{
  evidenceId: string;
  basis: TransportEvidenceShare["basis"];
  weight: number;
}> {
  const surface = new Set(candidate.surfaceEvidenceIds.map(String));
  const graph = new Set(candidate.graphEvidenceIds.map(String));
  const shared = new Set([...surface].filter(evidenceId => graph.has(evidenceId)));
  const declaredShared = [...new Set(candidate.sharedEvidenceIds.map(String))].sort();
  const derivedShared = [...shared].sort();
  if (canonicalStringify(declaredShared) !== canonicalStringify(derivedShared)) {
    throw new Error(`alignment candidate ${candidate.id} has inconsistent shared evidence`);
  }
  const ids = [...new Set([...surface, ...graph])].sort();
  return ids.map(evidenceId => {
    if (shared.has(evidenceId)) {
      return { evidenceId, basis: "shared_exact_evidence", weight: 2 };
    }
    if (surface.has(evidenceId)) {
      return { evidenceId, basis: "surface_evidence", weight: 1 };
    }
    return { evidenceId, basis: "graph_evidence", weight: 1 };
  });
}

function exactPartition(weights: readonly number[], total: number): number[] {
  if (!weights.length) return [];
  if (!Number.isFinite(total) || total < 0
    || weights.some(weight => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("evidence partition requires finite nonnegative mass");
  }
  const out: number[] = [];
  let assigned = 0;
  for (let index = 0; index < weights.length; index++) {
    const value = index === weights.length - 1
      ? total - assigned
      : quantize(weights[index]!);
    out.push(value);
    assigned += value;
  }
  return out;
}

function uniqueCandidates(
  candidates: readonly SparseAlignmentCandidate[]
): Map<string, SparseAlignmentCandidate> {
  const indexed = new Map<string, SparseAlignmentCandidate>();
  for (const candidate of candidates) {
    if (indexed.has(candidate.id)) {
      throw new Error(`alignment support repeats candidate ${candidate.id}`);
    }
    indexed.set(candidate.id, candidate);
  }
  return indexed;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000_000) / 1_000_000_000_000_000;
}
