import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidate,
  SparseAlignmentCandidateSupport,
  SparseAlignmentTarget,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import {
  classifyGraphImplicitType,
  classifySurfaceNullType,
  compileTypedNullCostModel,
  graphImplicitEstimate,
  surfaceNullEstimate,
  type GraphImplicitType,
  type SurfaceNullType,
  type TypedNullCostModel
} from "./typed-null-alignment.js";
import {
  compilePopulationOrderingModel,
  populationOrderingExpectation,
  type PopulationOrderingModel
} from "./population-ordering.js";
import {
  crossDocumentCost,
  type CrossDocumentAlignmentModel
} from "./cross-document-alignment.js";
import type { Hasher, JsonValue } from "./types.js";

export const SPARSE_FUSED_TRANSPORT_SCHEMA =
  "scce.sparse_fused_unbalanced_transport.v1" as const;

export interface SparseTransportObjective {
  id: string;
  featureWeight: number;
  structuralWeight: number;
  orderingWeight: number;
  crossDocumentWeight: number;
  anchorWeight: number;
  surfaceMarginalWeight: number;
  graphMarginalWeight: number;
  entropyWeight: number;
  entropyEpsilon: number;
  surfaceUnbalancedTau: number;
  graphUnbalancedTau: number;
  exactAnchorRowMassFloor: number;
}

export const SPARSE_TRANSPORT_OBJECTIVE_V1: SparseTransportObjective = {
  id: "scce.transport.objective.bootstrap.v1",
  featureWeight: 1,
  structuralWeight: 0.35,
  orderingWeight: 0.25,
  crossDocumentWeight: 0.3,
  anchorWeight: 1.5,
  surfaceMarginalWeight: 0.8,
  graphMarginalWeight: 0.8,
  entropyWeight: 0.08,
  entropyEpsilon: 0.08,
  surfaceUnbalancedTau: 0.8,
  graphUnbalancedTau: 0.8,
  exactAnchorRowMassFloor: 0.9
};

export interface SparseTransportBudget {
  maxOuterIterations: number;
  maxSinkhornIterations: number;
  maxStructuralNeighbors: number;
  maxStructuralComparisons: number;
  maxConditionalGradientSteps: number;
  maxConditionalGradientComparisons: number;
  relativeObjectiveTolerance: number;
  marginalResidualTolerance: number;
}

export interface SparseTransportCell {
  candidateId: string;
  surfaceUnitId: string;
  graphTargetId: string;
  mass: number;
  featureCost: number;
  structuralCost: number;
  orderingCost: number;
  crossDocumentCost: number;
  anchorCost: number;
  effectiveCost: number;
  exactAnchor: boolean;
}

export interface SparseTransportIteration {
  outerIteration: number;
  sinkhornIterations: number;
  objective: number;
  feature: number;
  structural: number;
  ordering: number;
  crossDocument: number;
  anchor: number;
  surfaceMarginalKl: number;
  graphMarginalKl: number;
  entropy: number;
  surfaceMarginalResidual: number;
  graphMarginalResidual: number;
  sinkhornScalingResidual: number;
  relativeObjectiveImprovement: number | null;
  structuralComparisons: number;
  orderingComparisons: number;
  conditionalGradientComparisons: number;
  conditionalGradientMassShift: number;
}

export interface SparseFusedTransportPlan {
  schema: typeof SPARSE_FUSED_TRANSPORT_SCHEMA;
  id: string;
  supportId: string;
  targetIndexId: string;
  typedNullCostModelId: string;
  populationOrderingModelId: string;
  crossDocumentAlignmentModelId: string | null;
  excludedCandidateIds: string[];
  status: "converged" | "iteration_budget_exhausted" | "work_budget_exhausted";
  globalOptimalityClaimed: false;
  objective: SparseTransportObjective;
  budget: SparseTransportBudget;
  cells: SparseTransportCell[];
  rowMarginals: Array<{
    surfaceUnitId: string;
    nullType: SurfaceNullType;
    nullCost: number;
    targetMass: number;
    transportedMass: number;
    surfaceNullMass: number;
    overflowMass: number;
    residual: number;
  }>;
  columnMarginals: Array<{
    graphTargetId: string;
    implicitType: GraphImplicitType;
    implicitCost: number;
    targetMass: number;
    transportedMass: number;
    graphImplicitMass: number;
    overflowMass: number;
    residual: number;
  }>;
  iterations: SparseTransportIteration[];
  audit: JsonValue;
}

interface RuntimeCell {
  candidate: SparseAlignmentCandidate;
  row: number;
  column: number;
  featureCost: number;
  structuralCost: number;
  orderingCost: number;
  crossDocumentCost: number;
  anchorCost: number;
  effectiveCost: number;
  mass: number;
}

export function solveSparseFusedUnbalancedTransport(input: {
  support: SparseAlignmentCandidateSupport;
  targetIndex: SparseAlignmentTargetIndex;
  objective?: SparseTransportObjective;
  typedNullCostModel?: TypedNullCostModel;
  populationOrderingModel?: PopulationOrderingModel;
  crossDocumentAlignmentModel?: CrossDocumentAlignmentModel;
  excludedCandidateIds?: readonly string[];
  budget?: Partial<SparseTransportBudget>;
  hasher?: Hasher;
}): SparseFusedTransportPlan {
  if (input.support.targetIndexId !== input.targetIndex.id) {
    throw new Error("transport support and target index do not match");
  }
  const hasher = input.hasher ?? createHasher();
  const objective = validatedObjective(input.objective ?? SPARSE_TRANSPORT_OBJECTIVE_V1);
  const budget = transportBudget(input.budget);
  const targetById = new Map(input.targetIndex.targets.map(target => [target.id, target]));
  const typedNullCostModel = input.typedNullCostModel ?? compileTypedNullCostModel({
    supports: [input.support],
    targetIndex: input.targetIndex,
    hasher
  });
  if (typedNullCostModel.targetIndexId !== input.targetIndex.id) {
    throw new Error("typed null cost model and target index do not match");
  }
  const populationOrderingModel = input.populationOrderingModel
    ?? compilePopulationOrderingModel({
      supports: [input.support],
      hasher
    });
  const rowIds = input.support.rows.map(row => row.surfaceUnitId);
  const columnIds = input.targetIndex.targets.map(target => target.id);
  const rowIndex = new Map(rowIds.map((id, index) => [id, index]));
  const columnIndex = new Map(columnIds.map((id, index) => [id, index]));
  const candidateById = new Map(input.support.candidates.map(candidate => [
    candidate.id,
    candidate
  ]));
  const excludedCandidateIds = [...new Set(input.excludedCandidateIds ?? [])].sort();
  for (const candidateId of excludedCandidateIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      throw new Error(`excluded transport candidate ${candidateId} is outside support`);
    }
    if (candidate.supportKinds.includes("exact_observable_anchor")) {
      throw new Error(`exact observable anchor ${candidateId} cannot be excluded`);
    }
  }
  const excludedCandidateIdSet = new Set(excludedCandidateIds);
  const rowCandidateIds = new Map(input.support.rows.map(row => [
    row.surfaceUnitId,
    new Set(row.candidateIds)
  ]));
  const candidates = input.support.candidates.filter(candidate =>
    rowCandidateIds.get(candidate.surfaceUnitId)?.has(candidate.id)
    && !excludedCandidateIdSet.has(candidate.id));
  const rowHasExactAnchor = new Set(candidates
    .filter(candidate => candidate.supportKinds.includes("exact_observable_anchor"))
    .map(candidate => candidate.surfaceUnitId));
  const cells: RuntimeCell[] = candidates.map(candidate => ({
    candidate,
    row: rowIndex.get(candidate.surfaceUnitId)!,
    column: columnIndex.get(candidate.graphTargetId)!,
    featureCost: quantize(1 - candidate.score),
    structuralCost: 0,
    orderingCost: 0,
    crossDocumentCost: input.crossDocumentAlignmentModel
      ? crossDocumentCost(
        input.crossDocumentAlignmentModel,
        candidate.graphTargetId,
        input.support.sourceFamilyId
      )
      : 0,
    anchorCost: rowHasExactAnchor.has(candidate.surfaceUnitId)
      && !candidate.supportKinds.includes("exact_observable_anchor")
      ? 1
      : 0,
    effectiveCost: 0,
    mass: 0
  }));
  const rowCells = groupedCellIndexes(cells, cell => cell.row, rowIds.length);
  const columnCells = groupedCellIndexes(cells, cell => cell.column, columnIds.length);
  const surfaceTargetMass = rowCells.map(() => rowCells.length ? 1 / rowCells.length : 0);
  const graphTargetMass = columnCells.map(() =>
    columnCells.length ? 1 / columnCells.length : 0);
  const surfaceNullTypes = input.support.rows.map(row =>
    classifySurfaceNullType(row.candidateIds.flatMap(candidateId => {
      const candidate = candidateById.get(candidateId);
      return candidate ? [candidate] : [];
    })));
  const graphImplicitTypes = columnIds.map(columnId =>
    classifyGraphImplicitType(targetById.get(columnId)!));
  const surfaceNullCosts = surfaceNullTypes.map(type =>
    surfaceNullEstimate(typedNullCostModel, type).unmatchedCost);
  const graphImplicitCosts = graphImplicitTypes.map(type =>
    graphImplicitEstimate(typedNullCostModel, type).unmatchedCost);
  const iterations: SparseTransportIteration[] = [];
  let previousObjective: number | undefined;
  let status: SparseFusedTransportPlan["status"] = "iteration_budget_exhausted";
  let structuralComparisonsTotal = 0;
  let orderingComparisonsTotal = 0;
  let conditionalGradientComparisonsTotal = 0;
  let conditionalGradientMassShiftTotal = 0;

  for (let outer = 0; outer < budget.maxOuterIterations; outer++) {
    for (const cell of cells) {
      cell.effectiveCost = quantize(
        objective.featureWeight * cell.featureCost
        + objective.structuralWeight * cell.structuralCost
        + objective.orderingWeight * cell.orderingCost
        + objective.crossDocumentWeight * cell.crossDocumentCost
        + objective.anchorWeight * cell.anchorCost
      );
    }
    const sinkhorn = sparseSinkhorn({
      cells,
      rowCells,
      columnCells,
      surfaceTargetMass,
      graphTargetMass,
      surfaceNullCosts,
      graphImplicitCosts,
      objective,
      maxIterations: budget.maxSinkhornIterations,
      residualTolerance: budget.marginalResidualTolerance
    });
    enforceExactAnchorRows({
      cells,
      rowCells,
      surfaceTargetMass,
      floor: objective.exactAnchorRowMassFloor
    });
    const structural = localStructuralCosts({
      cells,
      rowCells,
      targetById,
      maxNeighbors: budget.maxStructuralNeighbors,
      remainingComparisons: budget.maxStructuralComparisons
        - structuralComparisonsTotal
        - orderingComparisonsTotal
    });
    structuralComparisonsTotal += structural.comparisons;
    for (let index = 0; index < cells.length; index++) {
      cells[index]!.structuralCost = structural.costs[index] ?? 0;
    }
    const ordering = localOrderingCosts({
      cells,
      rowCells,
      populationOrderingModel,
      populationPosterior: input.support.populationPosterior,
      maxNeighbors: budget.maxStructuralNeighbors,
      remainingComparisons: budget.maxStructuralComparisons
        - structuralComparisonsTotal
        - orderingComparisonsTotal
    });
    orderingComparisonsTotal += ordering.comparisons;
    for (let index = 0; index < cells.length; index++) {
      cells[index]!.orderingCost = ordering.costs[index] ?? 0;
    }
    for (const cell of cells) {
      cell.effectiveCost = quantize(
        objective.featureWeight * cell.featureCost
        + objective.structuralWeight * cell.structuralCost
        + objective.orderingWeight * cell.orderingCost
        + objective.crossDocumentWeight * cell.crossDocumentCost
        + objective.anchorWeight * cell.anchorCost
      );
    }
    const correction = localConditionalGradientCorrection({
      cells,
      rowCells,
      maxSteps: budget.maxConditionalGradientSteps,
      remainingComparisons: budget.maxConditionalGradientComparisons
        - conditionalGradientComparisonsTotal
    });
    conditionalGradientComparisonsTotal += correction.comparisons;
    conditionalGradientMassShiftTotal += correction.massShift;
    enforceExactAnchorRows({
      cells,
      rowCells,
      surfaceTargetMass,
      floor: objective.exactAnchorRowMassFloor
    });
    const components = objectiveComponents({
      cells,
      rowCells,
      columnCells,
      surfaceTargetMass,
      graphTargetMass,
      surfaceNullCosts,
      graphImplicitCosts,
      objective
    });
    const relativeImprovement = previousObjective === undefined
      ? null
      : quantize((previousObjective - components.objective)
        / Math.max(1e-12, Math.abs(previousObjective)));
    iterations.push({
      outerIteration: outer + 1,
      sinkhornIterations: sinkhorn.iterations,
      ...components,
      sinkhornScalingResidual: sinkhorn.scalingResidual,
      relativeObjectiveImprovement: relativeImprovement,
      structuralComparisons: structural.comparisons,
      orderingComparisons: ordering.comparisons,
      conditionalGradientComparisons: correction.comparisons,
      conditionalGradientMassShift: quantize(correction.massShift)
    });
    if (structuralComparisonsTotal + orderingComparisonsTotal
      >= budget.maxStructuralComparisons) {
      status = "work_budget_exhausted";
      break;
    }
    if (conditionalGradientComparisonsTotal
      >= budget.maxConditionalGradientComparisons) {
      status = "work_budget_exhausted";
      break;
    }
    if (relativeImprovement !== null
      && Math.abs(relativeImprovement) <= budget.relativeObjectiveTolerance
      && sinkhorn.scalingResidual <= budget.marginalResidualTolerance) {
      status = "converged";
      break;
    }
    previousObjective = components.objective;
  }

  const rowMarginals = rowIds.map((surfaceUnitId, index) => {
    const transportedMass = sumIndexes(rowCells[index] ?? [], cells);
    const targetMass = surfaceTargetMass[index] ?? 0;
    return {
      surfaceUnitId,
      nullType: surfaceNullTypes[index]!,
      nullCost: quantize(surfaceNullCosts[index]!),
      targetMass: quantize(targetMass),
      transportedMass: quantize(transportedMass),
      surfaceNullMass: quantize(Math.max(0, targetMass - transportedMass)),
      overflowMass: quantize(Math.max(0, transportedMass - targetMass)),
      residual: quantize(Math.abs(transportedMass - targetMass))
    };
  });
  const columnMarginals = columnIds.map((graphTargetId, index) => {
    const transportedMass = sumIndexes(columnCells[index] ?? [], cells);
    const targetMass = graphTargetMass[index] ?? 0;
    return {
      graphTargetId,
      implicitType: graphImplicitTypes[index]!,
      implicitCost: quantize(graphImplicitCosts[index]!),
      targetMass: quantize(targetMass),
      transportedMass: quantize(transportedMass),
      graphImplicitMass: quantize(Math.max(0, targetMass - transportedMass)),
      overflowMass: quantize(Math.max(0, transportedMass - targetMass)),
      residual: quantize(Math.abs(transportedMass - targetMass))
    };
  });
  const planCells: SparseTransportCell[] = cells.map(cell => ({
    candidateId: cell.candidate.id,
    surfaceUnitId: cell.candidate.surfaceUnitId,
    graphTargetId: cell.candidate.graphTargetId,
    mass: quantize(cell.mass),
    featureCost: cell.featureCost,
    structuralCost: quantize(cell.structuralCost),
    orderingCost: quantize(cell.orderingCost),
    crossDocumentCost: quantize(cell.crossDocumentCost),
    anchorCost: cell.anchorCost,
    effectiveCost: cell.effectiveCost,
    exactAnchor: cell.candidate.supportKinds.includes("exact_observable_anchor")
  })).sort((left, right) =>
    left.surfaceUnitId.localeCompare(right.surfaceUnitId)
    || right.mass - left.mass
    || left.graphTargetId.localeCompare(right.graphTargetId));
  const canonical = {
    schema: SPARSE_FUSED_TRANSPORT_SCHEMA,
    supportId: input.support.id,
    targetIndexId: input.targetIndex.id,
    typedNullCostModelId: typedNullCostModel.id,
    populationOrderingModelId: populationOrderingModel.id,
    crossDocumentAlignmentModelId: input.crossDocumentAlignmentModel?.id ?? null,
    excludedCandidateIds,
    status,
    globalOptimalityClaimed: false as const,
    objective,
    budget,
    cells: planCells,
    rowMarginals,
    columnMarginals,
    iterations
  };
  return {
    ...canonical,
    id: `sparse_transport.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      solver: "kernel.sparse_fused_unbalanced_transport.v1",
      supportCellCount: input.support.candidates.length,
      transportedCellCount: planCells.length,
      cellsOutsideCandidateSupport: 0,
      denseMatrixMaterialized: false,
      localStructuralApproximation: true,
      exactAnchorRows: rowHasExactAnchor.size,
      typedNullCostModelId: typedNullCostModel.id,
      typedNullCostModelCalibrated: typedNullCostModel.calibrated,
      populationOrderingModelId: populationOrderingModel.id,
      crossDocumentAlignmentModelId: input.crossDocumentAlignmentModel?.id ?? null,
      excludedCandidateIds,
      retainedCandidateCount: candidates.length,
      populationOrderingPosterior: input.support.populationPosterior,
      surfaceNullMass: quantize(rowMarginals.reduce(
        (sum, row) => sum + row.surfaceNullMass,
        0
      )),
      graphImplicitMass: quantize(columnMarginals.reduce(
        (sum, column) => sum + column.graphImplicitMass,
        0
      )),
      surfaceOverflowMass: quantize(rowMarginals.reduce(
        (sum, row) => sum + row.overflowMass,
        0
      )),
      graphOverflowMass: quantize(columnMarginals.reduce(
        (sum, column) => sum + column.overflowMass,
        0
      )),
      structuralComparisons: structuralComparisonsTotal,
      orderingComparisons: orderingComparisonsTotal,
      conditionalGradientComparisons: conditionalGradientComparisonsTotal,
      conditionalGradientMassShift: quantize(conditionalGradientMassShiftTotal),
      estimatedWorkingBytes: estimatedWorkingBytes(cells.length, rowIds.length, columnIds.length),
      objectiveCalibrated: false,
      globalOptimalityClaimed: false
    })
  };
}

function sparseSinkhorn(input: {
  cells: RuntimeCell[];
  rowCells: readonly number[][];
  columnCells: readonly number[][];
  surfaceTargetMass: readonly number[];
  graphTargetMass: readonly number[];
  surfaceNullCosts: readonly number[];
  graphImplicitCosts: readonly number[];
  objective: SparseTransportObjective;
  maxIterations: number;
  residualTolerance: number;
}): { iterations: number; scalingResidual: number } {
  if (!input.cells.length) return { iterations: 0, scalingResidual: 0 };
  const epsilon = input.objective.entropyEpsilon;
  const surfacePowers = input.surfaceNullCosts.map(cost => {
    const tau = input.objective.surfaceUnbalancedTau * Math.max(0.05, cost);
    return tau / (tau + epsilon);
  });
  const graphPowers = input.graphImplicitCosts.map(cost => {
    const tau = input.objective.graphUnbalancedTau * Math.max(0.05, cost);
    return tau / (tau + epsilon);
  });
  const kernel = input.cells.map(cell => Math.exp(
    -Math.max(-20, Math.min(80, cell.effectiveCost / epsilon))
  ));
  const u = input.rowCells.map(() => 1);
  const v = input.columnCells.map(() => 1);
  let iterations = 0;
  let scalingResidual = Number.POSITIVE_INFINITY;
  for (; iterations < input.maxIterations; iterations++) {
    let maxChange = 0;
    for (let row = 0; row < input.rowCells.length; row++) {
      const indexes = input.rowCells[row]!;
      if (!indexes.length) continue;
      const denominator = indexes.reduce((sum, index) =>
        sum + kernel[index]! * v[input.cells[index]!.column]!, 0);
      const next = Math.pow(
        (input.surfaceTargetMass[row] ?? 0) / Math.max(1e-300, denominator),
        surfacePowers[row] ?? 1
      );
      maxChange = Math.max(maxChange, relativeChange(u[row]!, next));
      u[row] = finiteScale(next);
    }
    for (let column = 0; column < input.columnCells.length; column++) {
      const indexes = input.columnCells[column]!;
      if (!indexes.length) continue;
      const denominator = indexes.reduce((sum, index) =>
        sum + kernel[index]! * u[input.cells[index]!.row]!, 0);
      const next = Math.pow(
        (input.graphTargetMass[column] ?? 0) / Math.max(1e-300, denominator),
        graphPowers[column] ?? 1
      );
      maxChange = Math.max(maxChange, relativeChange(v[column]!, next));
      v[column] = finiteScale(next);
    }
    scalingResidual = maxChange;
    if (maxChange <= input.residualTolerance) {
      iterations++;
      break;
    }
  }
  for (let index = 0; index < input.cells.length; index++) {
    const cell = input.cells[index]!;
    cell.mass = finiteMass(u[cell.row]! * kernel[index]! * v[cell.column]!);
  }
  return { iterations, scalingResidual: quantize(scalingResidual) };
}

function enforceExactAnchorRows(input: {
  cells: RuntimeCell[];
  rowCells: readonly number[][];
  surfaceTargetMass: readonly number[];
  floor: number;
}): void {
  for (let row = 0; row < input.rowCells.length; row++) {
    const indexes = input.rowCells[row] ?? [];
    const anchors = indexes.filter(index =>
      input.cells[index]!.candidate.supportKinds.includes("exact_observable_anchor"));
    if (!anchors.length) continue;
    const nonAnchors = indexes.filter(index => !anchors.includes(index));
    const required = (input.surfaceTargetMass[row] ?? 0) * input.floor;
    const anchorMass = sumIndexes(anchors, input.cells);
    if (anchorMass >= required) continue;
    const deficit = required - anchorMass;
    const removable = sumIndexes(nonAnchors, input.cells);
    const transfer = Math.min(deficit, removable);
    if (removable > 0) {
      const keep = Math.max(0, (removable - transfer) / removable);
      for (const index of nonAnchors) input.cells[index]!.mass *= keep;
    }
    const addition = deficit;
    const anchorWeight = anchorMass > 0 ? anchorMass : anchors.length;
    for (const index of anchors) {
      const share = anchorMass > 0
        ? input.cells[index]!.mass / anchorWeight
        : 1 / anchors.length;
      input.cells[index]!.mass += addition * share;
    }
  }
}

function localStructuralCosts(input: {
  cells: RuntimeCell[];
  rowCells: readonly number[][];
  targetById: ReadonlyMap<string, SparseAlignmentTarget>;
  maxNeighbors: number;
  remainingComparisons: number;
}): { costs: number[]; comparisons: number } {
  const costs = input.cells.map(() => 0);
  const weights = input.cells.map(() => 0);
  let comparisons = 0;
  for (let row = 0; row < input.rowCells.length; row++) {
    const current = input.rowCells[row] ?? [];
    if (!current.length) continue;
    const firstNeighborRow = Math.max(0, row - input.maxNeighbors);
    const lastNeighborRow = Math.min(
      input.rowCells.length - 1,
      row + input.maxNeighbors
    );
    for (let neighborRow = firstNeighborRow;
      neighborRow <= lastNeighborRow;
      neighborRow++) {
      if (neighborRow === row) continue;
      const neighbors = [...(input.rowCells[neighborRow] ?? [])]
        .sort((left, right) => input.cells[right]!.mass - input.cells[left]!.mass)
        .slice(0, input.maxNeighbors);
      for (const index of current) {
        const source = input.cells[index]!;
        const sourceTarget = input.targetById.get(source.candidate.graphTargetId);
        if (!sourceTarget) continue;
        for (const neighborIndex of neighbors) {
          if (comparisons >= input.remainingComparisons) {
            return { costs: normalizeStructuralCosts(costs, weights), comparisons };
          }
          const neighbor = input.cells[neighborIndex]!;
          if (!surfaceCandidatesCompatible(source.candidate, neighbor.candidate)) {
            continue;
          }
          const neighborTarget = input.targetById.get(neighbor.candidate.graphTargetId);
          if (!neighborTarget) continue;
          const surfaceDistance = normalizedSurfaceDistance(
            source.candidate,
            neighbor.candidate
          );
          const graphDistance = typedGraphDistance(sourceTarget, neighborTarget);
          const loss = huber(surfaceDistance - graphDistance, 0.25);
          const weight = neighbor.mass;
          costs[index] = (costs[index] ?? 0) + weight * loss;
          weights[index] = (weights[index] ?? 0) + weight;
          comparisons++;
        }
      }
    }
  }
  return { costs: normalizeStructuralCosts(costs, weights), comparisons };
}

function localOrderingCosts(input: {
  cells: RuntimeCell[];
  rowCells: readonly number[][];
  populationOrderingModel: PopulationOrderingModel;
  populationPosterior: readonly { populationId: string; probability: number }[];
  maxNeighbors: number;
  remainingComparisons: number;
}): { costs: number[]; comparisons: number } {
  const costs = input.cells.map(() => 0);
  const weights = input.cells.map(() => 0);
  const extent = Math.max(
    1,
    ...input.cells.map(cell => cell.candidate.sourceCoordinates.codePointEnd)
  );
  let comparisons = 0;
  for (let row = 0; row < input.rowCells.length; row++) {
    const current = input.rowCells[row] ?? [];
    if (!current.length) continue;
    const firstNeighborRow = Math.max(0, row - input.maxNeighbors);
    const lastNeighborRow = Math.min(
      input.rowCells.length - 1,
      row + input.maxNeighbors
    );
    for (let neighborRow = firstNeighborRow;
      neighborRow <= lastNeighborRow;
      neighborRow++) {
      if (neighborRow === row) continue;
      const neighbors = [...(input.rowCells[neighborRow] ?? [])]
        .sort((left, right) => input.cells[right]!.mass - input.cells[left]!.mass)
        .slice(0, input.maxNeighbors);
      for (const index of current) {
        const source = input.cells[index]!;
        for (const neighborIndex of neighbors) {
          if (comparisons >= Math.max(0, input.remainingComparisons)) {
            return { costs: normalizeStructuralCosts(costs, weights), comparisons };
          }
          const neighbor = input.cells[neighborIndex]!;
          if (source.candidate.graphTargetId === neighbor.candidate.graphTargetId) {
            continue;
          }
          if (!surfaceCandidatesCompatible(source.candidate, neighbor.candidate)) {
            continue;
          }
          const expectation = populationOrderingExpectation({
            model: input.populationOrderingModel,
            populationPosterior: input.populationPosterior,
            leftGraphTargetId: source.candidate.graphTargetId,
            rightGraphTargetId: neighbor.candidate.graphTargetId
          });
          if (expectation.source === "unresolved") continue;
          const surfaceDelta = (candidateCenter(neighbor.candidate)
            - candidateCenter(source.candidate)) / extent;
          const loss = huber(
            surfaceDelta - expectation.location,
            Math.max(0.05, 1.345 * expectation.robustScale)
          );
          const weight = neighbor.mass;
          costs[index] = (costs[index] ?? 0) + weight * loss;
          weights[index] = (weights[index] ?? 0) + weight;
          comparisons++;
        }
      }
    }
  }
  return { costs: normalizeStructuralCosts(costs, weights), comparisons };
}

function localConditionalGradientCorrection(input: {
  cells: RuntimeCell[];
  rowCells: readonly number[][];
  maxSteps: number;
  remainingComparisons: number;
}): { comparisons: number; massShift: number } {
  let comparisons = 0;
  let massShift = 0;
  for (let step = 0; step < input.maxSteps; step++) {
    const gamma = 2 / (step + 3);
    let changed = false;
    for (const indexes of input.rowCells) {
      if (indexes.length < 2) continue;
      const incumbentIndex = [...indexes].sort((left, right) =>
        input.cells[right]!.mass - input.cells[left]!.mass
        || input.cells[left]!.effectiveCost - input.cells[right]!.effectiveCost)[0]!;
      let oracleIndex = incumbentIndex;
      for (const index of indexes) {
        if (comparisons >= Math.max(0, input.remainingComparisons)) {
          return { comparisons, massShift };
        }
        comparisons++;
        if (input.cells[index]!.effectiveCost
          < input.cells[oracleIndex]!.effectiveCost - 1e-12) {
          oracleIndex = index;
        }
      }
      if (oracleIndex === incumbentIndex) continue;
      const incumbent = input.cells[incumbentIndex]!;
      const oracle = input.cells[oracleIndex]!;
      if (incumbent.candidate.supportKinds.includes("exact_observable_anchor")
        && !oracle.candidate.supportKinds.includes("exact_observable_anchor")) {
        continue;
      }
      const shift = gamma * incumbent.mass;
      if (!(shift > 0)) continue;
      incumbent.mass -= shift;
      oracle.mass += shift;
      massShift += shift;
      changed = true;
    }
    if (!changed) break;
  }
  return { comparisons, massShift };
}

function objectiveComponents(input: {
  cells: readonly RuntimeCell[];
  rowCells: readonly number[][];
  columnCells: readonly number[][];
  surfaceTargetMass: readonly number[];
  graphTargetMass: readonly number[];
  surfaceNullCosts: readonly number[];
  graphImplicitCosts: readonly number[];
  objective: SparseTransportObjective;
}): Omit<SparseTransportIteration,
  "outerIteration" | "sinkhornIterations" | "sinkhornScalingResidual"
  | "relativeObjectiveImprovement" | "structuralComparisons"
  | "orderingComparisons" | "conditionalGradientComparisons"
  | "conditionalGradientMassShift"> {
  const feature = quantize(input.cells.reduce(
    (sum, cell) => sum + cell.mass * cell.featureCost,
    0
  ));
  const structural = quantize(input.cells.reduce(
    (sum, cell) => sum + cell.mass * cell.structuralCost,
    0
  ));
  const ordering = quantize(input.cells.reduce(
    (sum, cell) => sum + cell.mass * cell.orderingCost,
    0
  ));
  const crossDocument = quantize(input.cells.reduce(
    (sum, cell) => sum + cell.mass * cell.crossDocumentCost,
    0
  ));
  const anchor = quantize(input.cells.reduce(
    (sum, cell) => sum + cell.mass * cell.anchorCost,
    0
  ));
  const rowMass = input.rowCells.map(indexes => sumIndexes(indexes, input.cells));
  const columnMass = input.columnCells.map(indexes => sumIndexes(indexes, input.cells));
  const surfaceMarginalKl = quantize(weightedGeneralizedKl(
    rowMass,
    input.surfaceTargetMass,
    input.surfaceNullCosts
  ));
  const graphMarginalKl = quantize(weightedGeneralizedKl(
    columnMass,
    input.graphTargetMass,
    input.graphImplicitCosts
  ));
  const entropy = quantize(-input.cells.reduce((sum, cell) =>
    cell.mass > 0 ? sum + cell.mass * (Math.log(cell.mass) - 1) : sum, 0));
  const objective = quantize(
    input.objective.featureWeight * feature
    + input.objective.structuralWeight * structural
    + input.objective.orderingWeight * ordering
    + input.objective.crossDocumentWeight * crossDocument
    + input.objective.anchorWeight * anchor
    + input.objective.surfaceMarginalWeight * surfaceMarginalKl
    + input.objective.graphMarginalWeight * graphMarginalKl
    - input.objective.entropyWeight * entropy
  );
  return {
    objective,
    feature,
    structural,
    ordering,
    crossDocument,
    anchor,
    surfaceMarginalKl,
    graphMarginalKl,
    entropy,
    surfaceMarginalResidual: quantize(l1Residual(rowMass, input.surfaceTargetMass)),
    graphMarginalResidual: quantize(l1Residual(columnMass, input.graphTargetMass))
  };
}

function groupedCellIndexes(
  cells: readonly RuntimeCell[],
  select: (cell: RuntimeCell) => number,
  size: number
): number[][] {
  const groups = Array.from({ length: size }, () => [] as number[]);
  for (let index = 0; index < cells.length; index++) groups[select(cells[index]!) ]!.push(index);
  return groups;
}

function normalizedSurfaceDistance(
  left: SparseAlignmentCandidate,
  right: SparseAlignmentCandidate
): number {
  const leftCenter = candidateCenter(left);
  const rightCenter = candidateCenter(right);
  const width = Math.max(
    1,
    left.sourceCoordinates.codePointEnd - left.sourceCoordinates.codePointStart,
    right.sourceCoordinates.codePointEnd - right.sourceCoordinates.codePointStart
  );
  return Math.min(1, Math.abs(leftCenter - rightCenter) / (4 * width));
}

function candidateCenter(candidate: SparseAlignmentCandidate): number {
  return (candidate.sourceCoordinates.codePointStart
    + candidate.sourceCoordinates.codePointEnd) / 2;
}

function surfaceCandidatesCompatible(
  left: SparseAlignmentCandidate,
  right: SparseAlignmentCandidate
): boolean {
  return left.sourceCoordinates.codePointEnd <= right.sourceCoordinates.codePointStart
    || right.sourceCoordinates.codePointEnd <= left.sourceCoordinates.codePointStart;
}

function typedGraphDistance(left: SparseAlignmentTarget, right: SparseAlignmentTarget): number {
  if (left.id === right.id) return 0;
  if (left.relationNodeId === right.relationNodeId) {
    if (left.kind !== right.kind) return 0.1;
    return 0.2;
  }
  if (left.hyperedgeId === right.hyperedgeId) return 0.25;
  return 1;
}

function huber(value: number, delta: number): number {
  const absolute = Math.abs(value);
  return absolute <= delta
    ? 0.5 * absolute * absolute / delta
    : absolute - 0.5 * delta;
}

function normalizeStructuralCosts(costs: number[], weights: number[]): number[] {
  return costs.map((cost, index) =>
    quantize(weights[index]! > 0 ? cost / weights[index]! : 0));
}

function weightedGeneralizedKl(
  values: readonly number[],
  reference: readonly number[],
  costs: readonly number[]
): number {
  let sum = 0;
  for (let index = 0; index < Math.max(values.length, reference.length); index++) {
    const value = Math.max(0, values[index] ?? 0);
    const expected = Math.max(1e-300, reference[index] ?? 0);
    const divergence = value > 0
      ? value * Math.log(value / expected) - value + expected
      : expected;
    sum += divergence * Math.max(0.05, costs[index] ?? 1);
  }
  return sum;
}

function l1Residual(values: readonly number[], reference: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < Math.max(values.length, reference.length); index++) {
    sum += Math.abs((values[index] ?? 0) - (reference[index] ?? 0));
  }
  return sum;
}

function sumIndexes(indexes: readonly number[], cells: readonly RuntimeCell[]): number {
  return indexes.reduce((sum, index) => sum + cells[index]!.mass, 0);
}

function relativeChange(previous: number, next: number): number {
  return Math.abs(next - previous) / Math.max(1e-12, Math.abs(previous));
}

function finiteScale(value: number): number {
  return Number.isFinite(value) ? Math.max(1e-150, Math.min(1e150, value)) : 1;
}

function finiteMass(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1e150, value)) : 0;
}

function validatedObjective(value: SparseTransportObjective): SparseTransportObjective {
  for (const [key, entry] of Object.entries(value)) {
    if (key === "id") continue;
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`invalid sparse transport objective ${key}`);
    }
  }
  if (value.entropyEpsilon <= 0
    || value.surfaceUnbalancedTau <= 0
    || value.graphUnbalancedTau <= 0
    || value.exactAnchorRowMassFloor > 1) {
    throw new Error("invalid sparse transport regularization");
  }
  return { ...value };
}

function transportBudget(value: Partial<SparseTransportBudget> = {}): SparseTransportBudget {
  return {
    maxOuterIterations: bounded(value.maxOuterIterations, 1, 16, 6),
    maxSinkhornIterations: bounded(value.maxSinkhornIterations, 1, 256, 96),
    maxStructuralNeighbors: bounded(value.maxStructuralNeighbors, 1, 32, 8),
    maxStructuralComparisons: bounded(
      value.maxStructuralComparisons,
      1_000,
      20_000_000,
      2_000_000
    ),
    maxConditionalGradientSteps: bounded(
      value.maxConditionalGradientSteps,
      1,
      32,
      4
    ),
    maxConditionalGradientComparisons: bounded(
      value.maxConditionalGradientComparisons,
      100,
      20_000_000,
      1_000_000
    ),
    relativeObjectiveTolerance: boundedReal(
      value.relativeObjectiveTolerance,
      1e-9,
      0.1,
      1e-5
    ),
    marginalResidualTolerance: boundedReal(
      value.marginalResidualTolerance,
      1e-9,
      0.5,
      1e-4
    )
  };
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}

function boundedReal(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  return Math.max(min, Math.min(max, value ?? fallback));
}

function estimatedWorkingBytes(cells: number, rows: number, columns: number): number {
  return cells * 96 + (rows + columns) * 64;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
