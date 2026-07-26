import type { AlignmentAlternativeSet } from "./alignment-alternatives.js";
import type { AlignmentCalibrationModel } from "./alignment-calibration.js";
import type {
  AlignmentPromotionDecision,
  AlignmentPromotionModel
} from "./alignment-promotion.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidateSupport,
  SparseAlignmentTarget,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import type { SurfaceLattice, SurfaceLatticeUnit } from "./surface-lattice.js";
import type { LanguagePatternRecord } from "./storage.js";
import type {
  TransportCellEvidenceAllocation,
  TransportEvidenceAllocation
} from "./transport-evidence-allocation.js";
import type { Hasher, JsonValue } from "./types.js";

export const REVERSIBLE_CONSTRUCTION_SCHEMA =
  "scce.reversible_construction.v1" as const;
export const REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA =
  "scce.reversible_construction_interpretation.v1" as const;
export const REVERSIBLE_CONSTRUCTION_REALIZATION_SCHEMA =
  "scce.reversible_construction_realization.v1" as const;
export const REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA =
  "scce.reversible_construction_pattern.v1" as const;

export interface ReversibleConstructionGraphPort {
  id: string;
  graphTargetId: string;
  kind: SparseAlignmentTarget["kind"];
  relationNodeId: string;
  hyperedgeId: string;
  incidenceId?: string;
  participantNodeId?: string;
  portId?: string;
  roleId?: string;
  valueKind?: string;
  realization?: "observed" | "omitted";
  boundary: boolean;
  surfaceSlotIds: string[];
  evidenceIds: string[];
}

export interface ReversibleConstructionSurfaceEvidence {
  evidenceId: string;
  basis: "shared_exact_evidence" | "surface_evidence" | "graph_evidence";
  conditionalProbability: number;
  allocatedMass: number;
}

export interface ReversibleConstructionSurfaceSlot {
  id: string;
  surfaceUnitId: string;
  occurrenceId: string;
  surfaceFormClassId: string;
  graphPortIds: string[];
  relativeUtf16Start: number;
  relativeUtf16End: number;
  observedSurface: string;
  evidence: ReversibleConstructionSurfaceEvidence[];
}

export interface ReversibleConstruction {
  schema: typeof REVERSIBLE_CONSTRUCTION_SCHEMA;
  id: string;
  seriesId: string;
  planId: string;
  promotionModelId: string;
  profileId: string;
  graph: {
    hyperedgeIds: string[];
    relationNodeIds: string[];
    ports: ReversibleConstructionGraphPort[];
    boundaryPortIds: string[];
  };
  surface: {
    latticeId: string;
    sourceFamilyId: string;
    sourceVersionId: string | null;
    sourceUtf16Start: number;
    sourceUtf16End: number;
    sourceSurface: string;
    slots: ReversibleConstructionSurfaceSlot[];
    boundarySlotIds: string[];
  };
  discourseConditions: {
    status: "unconditioned";
    requiredStateIds: string[];
    excludedStateIds: string[];
  };
  populationPosterior: Array<{ populationId: string; probability: number }>;
  support: {
    inductionSourceFamilyIds: string[];
    independentHeldoutSourceFamilyIds: string[];
    heldoutCoverage: number;
    cycleRecall: number;
    exactAnchorsPreserved: true;
    unsupportedAdditionCount: 0;
    transportMass: number;
  };
  provenance: {
    supportId: string;
    targetIndexId: string;
    evidenceAllocationId: string;
    evidenceIds: string[];
  };
  calibration: {
    modelId: string;
    status: AlignmentCalibrationModel["status"];
    probability: number | null;
  };
  creationSnapshot: {
    id: string;
    createdAt: number;
  };
  executableDirections: ["interpretation", "realization"];
  audit: JsonValue;
}

export interface ReversibleConstructionRejection {
  seriesId: string;
  planId: string;
  reasons: string[];
}

export interface ReversibleConstructionCompilation {
  constructions: ReversibleConstruction[];
  rejections: ReversibleConstructionRejection[];
}

export type ReversibleConstructionInterpretation =
  | {
    schema: typeof REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA;
    status: "interpreted";
    constructionId: string;
    graphTargetIds: string[];
    portBindings: Array<{
      graphPortId: string;
      graphTargetId: string;
      surfaceSlotIds: string[];
      observedSurfaces: string[];
    }>;
    evidenceIds: string[];
  }
  | {
    schema: typeof REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA;
    status: "rejected";
    constructionId: string;
    reasons: string[];
  };

export type ReversibleConstructionRealization =
  | {
    schema: typeof REVERSIBLE_CONSTRUCTION_REALIZATION_SCHEMA;
    status: "realized";
    constructionId: string;
    text: string;
    graphTargetIds: string[];
    surfaceSlotIds: string[];
    evidenceIds: string[];
  }
  | {
    schema: typeof REVERSIBLE_CONSTRUCTION_REALIZATION_SCHEMA;
    status: "rejected";
    constructionId: string;
    reasons: string[];
  };

/**
 * Compiles the first concrete reversible construction. This phase preserves
 * the exact promoted occurrence. Generalization and unseen substitutions are
 * deliberately deferred to paired anti-unification.
 */
export function compileReversibleConstructions(input: {
  alternativeSets: readonly AlignmentAlternativeSet[];
  promotionModel: AlignmentPromotionModel;
  calibrationModel: AlignmentCalibrationModel;
  supports: readonly SparseAlignmentCandidateSupport[];
  targetIndex: SparseAlignmentTargetIndex;
  lattices: readonly SurfaceLattice[];
  evidenceAllocations: readonly TransportEvidenceAllocation[];
  profileId: string;
  creationSnapshotId: string;
  createdAt: number;
  calibrationProbabilityByPlanId?: ReadonlyMap<string, number>;
  hasher?: Hasher;
}): ReversibleConstructionCompilation {
  const hasher = input.hasher ?? createHasher();
  const setBySeriesId = uniqueMap(input.alternativeSets, set => set.seriesId);
  const supportById = uniqueMap(input.supports, support => support.id);
  const latticeById = uniqueMap(input.lattices, lattice => lattice.id);
  const targetById = uniqueMap(input.targetIndex.targets, target => target.id);
  const allocationByPlanId = uniqueMap(
    input.evidenceAllocations,
    allocation => allocation.transportPlanId
  );
  const constructions: ReversibleConstruction[] = [];
  const rejections: ReversibleConstructionRejection[] = [];

  for (const decision of input.promotionModel.decisions.filter(row => row.promoted)) {
    const reasons: string[] = [];
    const set = setBySeriesId.get(decision.seriesId);
    const hypothesis = set?.hypotheses.find(row => row.plan.id === decision.planId);
    const plan = hypothesis?.plan;
    const support = plan ? supportById.get(plan.supportId) : undefined;
    const lattice = support ? latticeById.get(support.latticeId) : undefined;
    const allocation = plan ? allocationByPlanId.get(plan.id) : undefined;
    if (!set || !hypothesis || !plan) reasons.push("promoted_plan_missing");
    if (!support) reasons.push("alignment_support_missing");
    if (!lattice) reasons.push("surface_lattice_missing");
    if (!allocation) reasons.push("evidence_allocation_missing");
    if (allocation && allocation.status !== "conserved") {
      reasons.push("evidence_allocation_unresolved");
    }
    if (support && support.targetIndexId !== input.targetIndex.id) {
      reasons.push("target_index_mismatch");
    }
    if (reasons.length || !plan || !support || !lattice || !allocation) {
      rejections.push(rejection(decision, reasons));
      continue;
    }

    const positiveCells = plan.cells.filter(cell => cell.mass > 1e-12);
    if (!positiveCells.length) {
      rejections.push(rejection(decision, ["positive_transport_missing"]));
      continue;
    }
    const candidateById = uniqueMap(support.candidates, candidate => candidate.id);
    const unitById = uniqueMap(lattice.units, unit => unit.id);
    const allocationCellByCandidateId = uniqueMap(
      allocation.cells,
      cell => cell.candidateId
    );
    const missingTarget = positiveCells.some(cell => !targetById.has(cell.graphTargetId));
    const missingCandidate = positiveCells.some(cell => !candidateById.has(cell.candidateId));
    const missingUnit = positiveCells.some(cell => {
      const candidate = candidateById.get(cell.candidateId);
      return !candidate || !unitById.has(candidate.surfaceUnitId);
    });
    const missingCellAllocation = positiveCells.some(cell => {
      const allocated = allocationCellByCandidateId.get(cell.candidateId);
      return !allocated || allocated.status !== "conserved";
    });
    if (missingTarget) reasons.push("graph_target_missing");
    if (missingCandidate) reasons.push("alignment_candidate_missing");
    if (missingUnit) reasons.push("surface_unit_missing");
    if (missingCellAllocation) reasons.push("positive_cell_evidence_unresolved");
    if (reasons.length) {
      rejections.push(rejection(decision, reasons));
      continue;
    }

    const boundUnits = uniqueBy(
      positiveCells.map(cell => unitById.get(
        candidateById.get(cell.candidateId)!.surfaceUnitId
      )!),
      unit => unit.id
    ).sort(surfaceUnitOrder);
    const sourceText = reconstructLatticeText(lattice);
    const sourceUtf16Start = Math.min(...boundUnits.map(unit => unit.utf16Start));
    const sourceUtf16End = Math.max(...boundUnits.map(unit => unit.utf16End));
    const sourceSurface = sourceText.slice(sourceUtf16Start, sourceUtf16End);
    if (!sourceSurface || boundUnits.some(unit =>
      sourceText.slice(unit.utf16Start, unit.utf16End) !== unit.surface)) {
      rejections.push(rejection(decision, ["source_surface_reconstruction_failed"]));
      continue;
    }

    const portIdByTargetId = new Map<string, string>();
    for (const targetId of uniqueStrings(positiveCells.map(cell => cell.graphTargetId))) {
      portIdByTargetId.set(targetId, stableId(hasher, "reversible_graph_port", [
        decision.seriesId,
        decision.planId,
        targetId
      ]));
    }
    const slotIdByUnitId = new Map<string, string>();
    for (const unit of boundUnits) {
      slotIdByUnitId.set(unit.id, stableId(hasher, "reversible_surface_slot", [
        decision.seriesId,
        decision.planId,
        unit.occurrenceId
      ]));
    }

    const slots = boundUnits.map(unit => {
      const cells = positiveCells.filter(cell =>
        candidateById.get(cell.candidateId)!.surfaceUnitId === unit.id);
      return {
        id: slotIdByUnitId.get(unit.id)!,
        surfaceUnitId: unit.id,
        occurrenceId: unit.occurrenceId,
        surfaceFormClassId: unit.surfaceFormClassId,
        graphPortIds: uniqueStrings(cells.map(cell =>
          portIdByTargetId.get(cell.graphTargetId)!)),
        relativeUtf16Start: unit.utf16Start - sourceUtf16Start,
        relativeUtf16End: unit.utf16End - sourceUtf16Start,
        observedSurface: unit.surface,
        evidence: evidenceForCells(cells.map(cell =>
          allocationCellByCandidateId.get(cell.candidateId)!))
      };
    });
    const ports = uniqueStrings(positiveCells.map(cell => cell.graphTargetId))
      .map(targetId => {
        const target = targetById.get(targetId)!;
        const surfaceSlotIds = uniqueStrings(positiveCells
          .filter(cell => cell.graphTargetId === targetId)
          .map(cell => slotIdByUnitId.get(
            candidateById.get(cell.candidateId)!.surfaceUnitId
          )!));
        return graphPort(target, portIdByTargetId.get(targetId)!, surfaceSlotIds);
      });
    const evidenceIds = uniqueStrings([
      ...ports.flatMap(port => port.evidenceIds),
      ...slots.flatMap(slot => slot.evidence.map(row => row.evidenceId))
    ]);
    const calibrationProbability =
      input.calibrationProbabilityByPlanId?.get(plan.id) ?? null;
    if (calibrationProbability !== null
      && (!Number.isFinite(calibrationProbability)
        || calibrationProbability < 0
        || calibrationProbability > 1)) {
      throw new Error(`invalid calibrated probability for ${plan.id}`);
    }
    const canonical = {
      schema: REVERSIBLE_CONSTRUCTION_SCHEMA,
      seriesId: decision.seriesId,
      planId: decision.planId,
      promotionModelId: input.promotionModel.id,
      profileId: input.profileId,
      graph: {
        hyperedgeIds: uniqueStrings(ports.map(port => port.hyperedgeId)),
        relationNodeIds: uniqueStrings(ports.map(port => port.relationNodeId)),
        ports,
        boundaryPortIds: ports.filter(port => port.boundary).map(port => port.id)
      },
      surface: {
        latticeId: lattice.id,
        sourceFamilyId: lattice.sourceFamilyId,
        sourceVersionId: lattice.sourceVersionId ?? null,
        sourceUtf16Start,
        sourceUtf16End,
        sourceSurface,
        slots,
        boundarySlotIds: slots.map(slot => slot.id)
      },
      discourseConditions: {
        status: "unconditioned" as const,
        requiredStateIds: [] as string[],
        excludedStateIds: [] as string[]
      },
      populationPosterior: canonicalPosterior(support.populationPosterior),
      support: {
        inductionSourceFamilyIds: decision.inductionSourceFamilyIds,
        independentHeldoutSourceFamilyIds:
          decision.independentHeldoutSourceFamilyIds,
        heldoutCoverage: decision.heldoutCoverage,
        cycleRecall: decision.cycleRecall,
        exactAnchorsPreserved: true as const,
        unsupportedAdditionCount: 0 as const,
        transportMass: sum(positiveCells.map(cell => cell.mass))
      },
      provenance: {
        supportId: support.id,
        targetIndexId: input.targetIndex.id,
        evidenceAllocationId: allocation.id,
        evidenceIds
      },
      calibration: {
        modelId: input.calibrationModel.id,
        status: input.calibrationModel.status,
        probability: calibrationProbability
      },
      creationSnapshot: {
        id: input.creationSnapshotId,
        createdAt: input.createdAt
      },
      executableDirections: ["interpretation", "realization"] as
        ["interpretation", "realization"]
    };
    constructions.push({
      ...canonical,
      id: stableId(hasher, "reversible_construction", canonical),
      audit: toJsonValue({
        compiler: "kernel.reversible_construction.exact_promoted.v1",
        generalized: false,
        antiUnificationDeferred: true,
        exactSourceProgram: true,
        graphPortCount: ports.length,
        surfaceSlotCount: slots.length,
        interpretationExecutable: true,
        realizationExecutable: true
      })
    });
  }

  return {
    constructions: constructions.sort((left, right) => left.id.localeCompare(right.id)),
    rejections: rejections.sort((left, right) =>
      left.seriesId.localeCompare(right.seriesId)
      || left.planId.localeCompare(right.planId))
  };
}

export function interpretReversibleConstruction(input: {
  construction: ReversibleConstruction;
  surface: string;
  profileId: string;
  discourseStateIds?: readonly string[];
}): ReversibleConstructionInterpretation {
  const reasons = applicabilityReasons(input.construction, {
    profileId: input.profileId,
    discourseStateIds: input.discourseStateIds
  });
  if (input.surface !== input.construction.surface.sourceSurface) {
    reasons.push("surface_program_mismatch");
  }
  if (reasons.length) {
    return {
      schema: REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA,
      status: "rejected",
      constructionId: input.construction.id,
      reasons: uniqueStrings(reasons)
    };
  }
  const slotById = uniqueMap(
    input.construction.surface.slots,
    slot => slot.id
  );
  return {
    schema: REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA,
    status: "interpreted",
    constructionId: input.construction.id,
    graphTargetIds: input.construction.graph.ports.map(port =>
      port.graphTargetId).sort(),
    portBindings: input.construction.graph.ports.map(port => ({
      graphPortId: port.id,
      graphTargetId: port.graphTargetId,
      surfaceSlotIds: port.surfaceSlotIds,
      observedSurfaces: port.surfaceSlotIds.map(slotId =>
        slotById.get(slotId)!.observedSurface)
    })),
    evidenceIds: input.construction.provenance.evidenceIds
  };
}

export function realizeReversibleConstruction(input: {
  construction: ReversibleConstruction;
  graphTargetIds: readonly string[];
  profileId: string;
  discourseStateIds?: readonly string[];
}): ReversibleConstructionRealization {
  const reasons = applicabilityReasons(input.construction, {
    profileId: input.profileId,
    discourseStateIds: input.discourseStateIds
  });
  const expected = input.construction.graph.ports.map(port =>
    port.graphTargetId).sort();
  if (canonicalStringify(uniqueStrings(input.graphTargetIds)) !==
    canonicalStringify(expected)) {
    reasons.push("graph_fragment_mismatch");
  }
  if (reasons.length) {
    return {
      schema: REVERSIBLE_CONSTRUCTION_REALIZATION_SCHEMA,
      status: "rejected",
      constructionId: input.construction.id,
      reasons: uniqueStrings(reasons)
    };
  }
  return {
    schema: REVERSIBLE_CONSTRUCTION_REALIZATION_SCHEMA,
    status: "realized",
    constructionId: input.construction.id,
    text: input.construction.surface.sourceSurface,
    graphTargetIds: expected,
    surfaceSlotIds: input.construction.surface.slots.map(slot => slot.id),
    evidenceIds: input.construction.provenance.evidenceIds
  };
}

export function reversibleConstructionCycle(input: {
  construction: ReversibleConstruction;
  profileId: string;
  discourseStateIds?: readonly string[];
}): {
  exactSurfaceRecovered: boolean;
  exactGraphFragmentRecovered: boolean;
  interpretation: ReversibleConstructionInterpretation;
  realization: ReversibleConstructionRealization;
} {
  const targets = input.construction.graph.ports.map(port => port.graphTargetId);
  const realization = realizeReversibleConstruction({
    construction: input.construction,
    graphTargetIds: targets,
    profileId: input.profileId,
    discourseStateIds: input.discourseStateIds
  });
  const interpretation = realization.status === "realized"
    ? interpretReversibleConstruction({
      construction: input.construction,
      surface: realization.text,
      profileId: input.profileId,
      discourseStateIds: input.discourseStateIds
    })
    : {
      schema: REVERSIBLE_CONSTRUCTION_INTERPRETATION_SCHEMA,
      status: "rejected" as const,
      constructionId: input.construction.id,
      reasons: ["realization_rejected"]
    };
  return {
    exactSurfaceRecovered: realization.status === "realized"
      && realization.text === input.construction.surface.sourceSurface,
    exactGraphFragmentRecovered: interpretation.status === "interpreted"
      && canonicalStringify(interpretation.graphTargetIds)
        === canonicalStringify(uniqueStrings(targets)),
    interpretation,
    realization
  };
}

export function reversibleConstructionCreationSnapshotId(input: {
  sourceVersionId: string;
  graphNodeIds: readonly string[];
  graphEdgeIds: readonly string[];
  hyperedgeIds: readonly string[];
  hasher?: Hasher;
}): string {
  return stableId(input.hasher ?? createHasher(), "reversible_snapshot", {
    sourceVersionId: input.sourceVersionId,
    graphNodeIds: uniqueStrings(input.graphNodeIds),
    graphEdgeIds: uniqueStrings(input.graphEdgeIds),
    hyperedgeIds: uniqueStrings(input.hyperedgeIds)
  });
}

export function reversibleConstructionProfileId(input: {
  sourceVersionIds: readonly string[];
  populationPosteriors: readonly (
    readonly { populationId: string; probability: number }[]
  )[];
  hasher?: Hasher;
}): string {
  return stableId(input.hasher ?? createHasher(), "reversible_profile", {
    sourceVersionIds: uniqueStrings(input.sourceVersionIds),
    populationPosteriors: input.populationPosteriors.map(canonicalPosterior)
      .sort((left, right) =>
        canonicalStringify(left).localeCompare(canonicalStringify(right)))
  });
}

export function compileReversibleConstructionPattern(
  construction: ReversibleConstruction
): LanguagePatternRecord {
  return {
    id: construction.id,
    profileId: construction.profileId,
    patternKind: "semantic_role",
    support: construction.support.independentHeldoutSourceFamilyIds.length,
    entropy: 0,
    patternJson: toJsonValue({
      schema: REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA,
      construction
    }),
    evidenceIds: construction.provenance.evidenceIds as
      LanguagePatternRecord["evidenceIds"],
    updatedAt: construction.creationSnapshot.createdAt
  };
}

export function isReversibleConstructionPattern(
  pattern: LanguagePatternRecord
): boolean {
  const value = recordOf(pattern.patternJson);
  return value.schema === REVERSIBLE_CONSTRUCTION_PATTERN_SCHEMA;
}

export function reversibleConstructionsFromPatterns(
  patterns: readonly LanguagePatternRecord[]
): ReversibleConstruction[] {
  const byId = new Map<string, ReversibleConstruction>();
  for (const pattern of patterns) {
    if (!isReversibleConstructionPattern(pattern)) continue;
    const value = recordOf(pattern.patternJson);
    const construction = value.construction;
    if (!construction || typeof construction !== "object"
      || Array.isArray(construction)) continue;
    const parsed = construction as unknown as ReversibleConstruction;
    if (parsed.schema !== REVERSIBLE_CONSTRUCTION_SCHEMA
      || !parsed.id
      || parsed.id !== pattern.id
      || parsed.profileId !== pattern.profileId
      || canonicalStringify(uniqueStrings(parsed.provenance?.evidenceIds ?? []))
        !== canonicalStringify(uniqueStrings(pattern.evidenceIds.map(String)))
      || parsed.executableDirections?.[0] !== "interpretation"
      || parsed.executableDirections?.[1] !== "realization") continue;
    byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function graphPort(
  target: SparseAlignmentTarget,
  id: string,
  surfaceSlotIds: string[]
): ReversibleConstructionGraphPort {
  return {
    id,
    graphTargetId: target.id,
    kind: target.kind,
    relationNodeId: String(target.relationNodeId),
    hyperedgeId: target.hyperedgeId,
    ...(target.incidenceId ? { incidenceId: target.incidenceId } : {}),
    ...(target.participantNodeId
      ? { participantNodeId: String(target.participantNodeId) }
      : {}),
    ...(target.portId ? { portId: target.portId } : {}),
    ...(target.roleId ? { roleId: target.roleId } : {}),
    ...(target.valueKind ? { valueKind: target.valueKind } : {}),
    ...(target.realization ? { realization: target.realization } : {}),
    boundary: target.kind === "incidence",
    surfaceSlotIds,
    evidenceIds: uniqueStrings(target.evidenceIds)
  };
}

function evidenceForCells(
  cells: readonly TransportCellEvidenceAllocation[]
): ReversibleConstructionSurfaceEvidence[] {
  const byKey = new Map<string, ReversibleConstructionSurfaceEvidence>();
  for (const cell of cells) {
    for (const share of cell.shares) {
      const key = `${share.evidenceId}\u001f${share.basis}`;
      const current = byKey.get(key);
      byKey.set(key, current
        ? {
          ...current,
          conditionalProbability: 0,
          allocatedMass: current.allocatedMass + share.allocatedMass
        }
        : { ...share, conditionalProbability: 0 });
    }
  }
  const rows = [...byKey.values()];
  const allocatedMass = sum(rows.map(row => row.allocatedMass));
  return rows.map(row => ({
    ...row,
    conditionalProbability: allocatedMass > 0
      ? row.allocatedMass / allocatedMass
      : 0
  })).sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId)
    || left.basis.localeCompare(right.basis));
}

function reconstructLatticeText(lattice: SurfaceLattice): string {
  return lattice.units
    .filter(unit => unit.overlapClass === "base_partition")
    .sort(surfaceUnitOrder)
    .map(unit => unit.surface)
    .join("");
}

function surfaceUnitOrder(
  left: SurfaceLatticeUnit,
  right: SurfaceLatticeUnit
): number {
  return left.utf16Start - right.utf16Start
    || left.utf16End - right.utf16End
    || left.id.localeCompare(right.id);
}

function applicabilityReasons(
  construction: ReversibleConstruction,
  input: {
    profileId: string;
    discourseStateIds?: readonly string[];
  }
): string[] {
  const reasons: string[] = [];
  if (construction.profileId !== input.profileId) reasons.push("profile_mismatch");
  const active = new Set(input.discourseStateIds ?? []);
  if (construction.discourseConditions.requiredStateIds.some(id => !active.has(id))) {
    reasons.push("required_discourse_state_missing");
  }
  if (construction.discourseConditions.excludedStateIds.some(id => active.has(id))) {
    reasons.push("excluded_discourse_state_present");
  }
  return reasons;
}

function rejection(
  decision: AlignmentPromotionDecision,
  reasons: readonly string[]
): ReversibleConstructionRejection {
  return {
    seriesId: decision.seriesId,
    planId: decision.planId,
    reasons: uniqueStrings(reasons.length ? reasons : ["construction_unresolved"])
  };
}

function canonicalPosterior(
  posterior: readonly { populationId: string; probability: number }[]
): Array<{ populationId: string; probability: number }> {
  const rows = posterior.map(row => {
    if (!row.populationId || !Number.isFinite(row.probability)
      || row.probability < 0 || row.probability > 1) {
      throw new Error("invalid construction population posterior");
    }
    return { ...row };
  }).sort((left, right) => left.populationId.localeCompare(right.populationId));
  const total = sum(rows.map(row => row.probability));
  if (rows.length && Math.abs(total - 1) > 1e-9) {
    throw new Error("construction population posterior must sum to one");
  }
  return rows;
}

function uniqueMap<T>(
  rows: readonly T[],
  key: (row: T) => string
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (out.has(id)) throw new Error(`duplicate reversible construction key ${id}`);
    out.set(id, row);
  }
  return out;
}

function uniqueBy<T>(
  rows: readonly T[],
  key: (row: T) => string
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(key(row), row);
  return [...out.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(String))].sort();
}

function stableId(
  hasher: Hasher,
  namespace: string,
  value: unknown
): string {
  return `${namespace}.${hasher.digestHex(
    canonicalStringify(value)
  ).slice(0, 40)}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function recordOf(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
