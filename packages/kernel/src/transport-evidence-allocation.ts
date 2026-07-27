import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
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
    id: `transport_evidence.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
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
      maximumCellResidual: Math.max(0, ...cells.map(cell => cell.conservationResidual)),
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
