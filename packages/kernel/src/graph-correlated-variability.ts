import type {
  AntiUnifiedSurfacePart,
  PairedAntiUnifiedConstruction,
  PairedVariabilityAdmission
} from "./paired-anti-unification.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const GRAPH_CORRELATED_VARIABILITY_SCHEMA =
  "scce.graph_correlated_surface_variability.v1" as const;

interface DeltaObservation {
  leftSourceFamilyId: string;
  rightSourceFamilyId: string;
  surfaceChanged: 0 | 1;
  graphChanged: 0 | 1;
}

export interface GraphCorrelatedVariabilityControl {
  controlIndex: number;
  conditionalMutualInformation: number;
  crossValidatedPredictiveGain: number;
  wouldPassMetricFloors: boolean;
}

export interface GraphCorrelatedVariabilitySlotDecision {
  id: string;
  constructionId: string;
  surfaceSlotId: string;
  graphVariableIds: string[];
  independentSourceFamilies: number;
  deltaObservationCount: number;
  conditionalMutualInformation: number;
  crossValidatedPredictiveGain: number;
  permutationPValue: number;
  shuffledControlPromotionRate: number;
  controls: GraphCorrelatedVariabilityControl[];
  passed: boolean;
  reasons: string[];
}

export interface GraphCorrelatedVariabilityDecision {
  id: string;
  constructionId: string;
  slotDecisionIds: string[];
  passed: boolean;
  reasons: string[];
}

export interface GraphCorrelatedVariabilityModel {
  schema: typeof GRAPH_CORRELATED_VARIABILITY_SCHEMA;
  id: string;
  minimumIndependentSourceFamilies: number;
  minimumConditionalMutualInformation: number;
  minimumCrossValidatedPredictiveGain: number;
  maximumPermutationPValue: number;
  maximumShuffledControlPromotionRate: number;
  permutationControls: number;
  slotDecisions: GraphCorrelatedVariabilitySlotDecision[];
  decisions: GraphCorrelatedVariabilityDecision[];
  audit: JsonValue;
}

export function compileGraphCorrelatedVariabilityModel(input: {
  constructions: readonly PairedAntiUnifiedConstruction[];
  minimumIndependentSourceFamilies?: number;
  minimumConditionalMutualInformation?: number;
  minimumCrossValidatedPredictiveGain?: number;
  maximumPermutationPValue?: number;
  maximumShuffledControlPromotionRate?: number;
  permutationControls?: number;
  hasher?: Hasher;
}): GraphCorrelatedVariabilityModel {
  const hasher = input.hasher ?? createHasher();
  const minimumIndependentSourceFamilies = boundedInteger(
    input.minimumIndependentSourceFamilies,
    4,
    64,
    4
  );
  const minimumConditionalMutualInformation = floorAt(
    input.minimumConditionalMutualInformation,
    0.02
  );
  const minimumCrossValidatedPredictiveGain = floorAt(
    input.minimumCrossValidatedPredictiveGain,
    0.02
  );
  const maximumPermutationPValue = ceilingAt(
    input.maximumPermutationPValue,
    0.05
  );
  const maximumShuffledControlPromotionRate = ceilingAt(
    input.maximumShuffledControlPromotionRate,
    0.1
  );
  const permutationControls = boundedInteger(
    input.permutationControls,
    32,
    256,
    64
  );
  const slotDecisions = input.constructions.flatMap(construction =>
    construction.surfaceProgram.parts.flatMap(part =>
      part.kind === "slot" && part.mode === "variable"
        ? [evaluateVariableSlot({
          construction,
          slot: part,
          minimumIndependentSourceFamilies,
          minimumConditionalMutualInformation,
          minimumCrossValidatedPredictiveGain,
          maximumPermutationPValue,
          maximumShuffledControlPromotionRate,
          permutationControls,
          hasher
        })]
        : []))
    .sort((left, right) => left.id.localeCompare(right.id));
  const decisions = input.constructions.map(construction => {
    const slots = slotDecisions.filter(slot =>
      slot.constructionId === construction.id);
    const reasons = slots.length
      ? uniqueStrings(slots.flatMap(slot =>
        slot.passed ? [] : slot.reasons.map(reason =>
          `${slot.surfaceSlotId}:${reason}`)))
      : ["variable_surface_slot_missing"];
    const canonical = {
      constructionId: construction.id,
      slotDecisionIds: slots.map(slot => slot.id).sort(),
      passed: slots.length > 0 && slots.every(slot => slot.passed),
      reasons
    };
    return {
      ...canonical,
      id: stableId(hasher, "graph_correlated_variability_decision", canonical)
    };
  }).sort((left, right) =>
    left.constructionId.localeCompare(right.constructionId));
  const canonical = {
    schema: GRAPH_CORRELATED_VARIABILITY_SCHEMA,
    minimumIndependentSourceFamilies,
    minimumConditionalMutualInformation,
    minimumCrossValidatedPredictiveGain,
    maximumPermutationPValue,
    maximumShuffledControlPromotionRate,
    permutationControls,
    slotDecisions,
    decisions
  };
  return {
    ...canonical,
    id: stableId(hasher, "graph_correlated_variability_model", canonical),
    audit: toJsonValue({
      compiler: "kernel.graph_correlated_variability.crossfit_permutation.v1",
      sourceFamilyCrossValidated: true,
      pairwiseDeltaRepresentation: true,
      shuffledControls: permutationControls,
      rawConstructionCount: input.constructions.length,
      admittedConstructionCount: decisions.filter(row => row.passed).length,
      uniqueExamplesAloneCannotPass: true
    })
  };
}

export function admittedPairedAntiUnifiedConstructions(input: {
  constructions: readonly PairedAntiUnifiedConstruction[];
  model: GraphCorrelatedVariabilityModel;
}): Array<{
  construction: PairedAntiUnifiedConstruction;
  admission: PairedVariabilityAdmission;
}> {
  const decisionByConstructionId = new Map(input.model.decisions.map(row => [
    row.constructionId,
    row
  ]));
  return input.constructions.flatMap(construction => {
    const decision = decisionByConstructionId.get(construction.id);
    return decision?.passed
      ? [{
        construction,
        admission: withAdmissionId({
          schema: "scce.graph_correlated_variability_admission.v1",
          modelId: input.model.id,
          decisionId: decision.id,
          constructionId: construction.id,
          passed: true
        })
      }]
      : [];
  });
}

function withAdmissionId(
  value: Omit<PairedVariabilityAdmission, "id">
): PairedVariabilityAdmission {
  return {
    ...value,
    id: stableId(createHasher(), "graph_correlated_variability_admission", value)
  };
}

function evaluateVariableSlot(input: {
  construction: PairedAntiUnifiedConstruction;
  slot: Extract<AntiUnifiedSurfacePart, { kind: "slot" }>;
  minimumIndependentSourceFamilies: number;
  minimumConditionalMutualInformation: number;
  minimumCrossValidatedPredictiveGain: number;
  maximumPermutationPValue: number;
  maximumShuffledControlPromotionRate: number;
  permutationControls: number;
  hasher: Hasher;
}): GraphCorrelatedVariabilitySlotDecision {
  const examples = oneExamplePerFamily(input.slot.examples);
  const observations = deltaObservations(examples);
  const conditionalMutualInformation = conditionalMutualInformationOf(
    observations
  );
  const crossValidatedPredictiveGain = crossValidatedPredictiveGainOf(
    observations
  );
  const controls = Array.from(
    { length: input.permutationControls },
    (_, controlIndex) => {
      const shuffled = shuffledExamples(
        examples,
        controlIndex,
        input.hasher
      );
      const rows = deltaObservations(shuffled);
      const cmi = conditionalMutualInformationOf(rows);
      const gain = crossValidatedPredictiveGainOf(rows);
      return {
        controlIndex,
        conditionalMutualInformation: quantize(cmi),
        crossValidatedPredictiveGain: quantize(gain),
        wouldPassMetricFloors:
          cmi >= input.minimumConditionalMutualInformation
          && gain >= input.minimumCrossValidatedPredictiveGain
      };
    }
  );
  const actualStatistic = jointStatistic(
    conditionalMutualInformation,
    crossValidatedPredictiveGain,
    input.minimumConditionalMutualInformation,
    input.minimumCrossValidatedPredictiveGain
  );
  const controlExceedances = controls.filter(control =>
    jointStatistic(
      control.conditionalMutualInformation,
      control.crossValidatedPredictiveGain,
      input.minimumConditionalMutualInformation,
      input.minimumCrossValidatedPredictiveGain
    ) >= actualStatistic - 1e-12).length;
  const permutationPValue =
    (1 + controlExceedances) / (1 + controls.length);
  const shuffledControlPromotionRate = controls.filter(control =>
    control.wouldPassMetricFloors).length / Math.max(1, controls.length);
  const surfaceClasses = new Set(observations.map(row => row.surfaceChanged));
  const graphClasses = new Set(observations.map(row => row.graphChanged));
  const reasons: string[] = [];
  if (examples.length < input.minimumIndependentSourceFamilies) {
    reasons.push("independent_source_families_low");
  }
  if (surfaceClasses.size < 2) reasons.push("surface_delta_classes_missing");
  if (graphClasses.size < 2) reasons.push("graph_delta_classes_missing");
  if (conditionalMutualInformation
    < input.minimumConditionalMutualInformation) {
    reasons.push("conditional_mutual_information_low");
  }
  if (crossValidatedPredictiveGain
    < input.minimumCrossValidatedPredictiveGain) {
    reasons.push("cross_validated_predictive_gain_low");
  }
  if (permutationPValue > input.maximumPermutationPValue) {
    reasons.push("permutation_null_not_rejected");
  }
  if (shuffledControlPromotionRate
    > input.maximumShuffledControlPromotionRate) {
    reasons.push("shuffled_controls_promote_too_often");
  }
  const canonical = {
    constructionId: input.construction.id,
    surfaceSlotId: input.slot.id,
    graphVariableIds: [...input.slot.graphVariableIds].sort(),
    independentSourceFamilies: examples.length,
    deltaObservationCount: observations.length,
    conditionalMutualInformation: quantize(conditionalMutualInformation),
    crossValidatedPredictiveGain: quantize(crossValidatedPredictiveGain),
    permutationPValue: quantize(permutationPValue),
    shuffledControlPromotionRate: quantize(shuffledControlPromotionRate),
    controls,
    passed: reasons.length === 0,
    reasons
  };
  return {
    ...canonical,
    id: stableId(input.hasher, "graph_correlated_variability_slot", canonical)
  };
}

function oneExamplePerFamily(
  examples: Extract<
    AntiUnifiedSurfacePart,
    { kind: "slot" }
  >["examples"]
): typeof examples {
  const byFamily = new Map<string, typeof examples[number]>();
  for (const example of [...examples].sort((left, right) =>
    left.constructionId.localeCompare(right.constructionId))) {
    if (!byFamily.has(example.sourceFamilyId)) {
      byFamily.set(example.sourceFamilyId, example);
    }
  }
  return [...byFamily.values()].sort((left, right) =>
    left.sourceFamilyId.localeCompare(right.sourceFamilyId));
}

function deltaObservations(
  examples: ReturnType<typeof oneExamplePerFamily>
): DeltaObservation[] {
  const rows: DeltaObservation[] = [];
  for (let left = 0; left < examples.length; left++) {
    for (let right = left + 1; right < examples.length; right++) {
      const a = examples[left]!;
      const b = examples[right]!;
      rows.push({
        leftSourceFamilyId: a.sourceFamilyId,
        rightSourceFamilyId: b.sourceFamilyId,
        surfaceChanged: a.observedSurface === b.observedSurface ? 0 : 1,
        graphChanged: canonicalStringify(a.graphTargetIds)
          === canonicalStringify(b.graphTargetIds) ? 0 : 1
      });
    }
  }
  return rows;
}

function conditionalMutualInformationOf(
  rows: readonly DeltaObservation[]
): number {
  if (!rows.length) return 0;
  const smoothing = 0.5;
  const counts = [
    [smoothing, smoothing],
    [smoothing, smoothing]
  ];
  for (const row of rows) counts[row.surfaceChanged]![row.graphChanged]! += 1;
  const total = rows.length + 4 * smoothing;
  const surfaceTotals = counts.map(values => values[0]! + values[1]!);
  const graphTotals = [
    counts[0]![0]! + counts[1]![0]!,
    counts[0]![1]! + counts[1]![1]!
  ];
  let information = 0;
  for (const surface of [0, 1] as const) {
    for (const graph of [0, 1] as const) {
      const joint = counts[surface]![graph]! / total;
      information += joint * Math.log(
        joint / (
          (surfaceTotals[surface]! / total)
          * (graphTotals[graph]! / total)
        )
      );
    }
  }
  return Math.max(0, information);
}

function crossValidatedPredictiveGainOf(
  rows: readonly DeltaObservation[]
): number {
  if (!rows.length) return 0;
  let gain = 0;
  let evaluated = 0;
  for (const heldout of rows) {
    const training = rows.filter(row =>
      row.leftSourceFamilyId !== heldout.leftSourceFamilyId
      && row.rightSourceFamilyId !== heldout.leftSourceFamilyId
      && row.leftSourceFamilyId !== heldout.rightSourceFamilyId
      && row.rightSourceFamilyId !== heldout.rightSourceFamilyId);
    if (!training.length) continue;
    const conditional = [
      [0.5, 0.5],
      [0.5, 0.5]
    ];
    const baseline = [0.5, 0.5];
    for (const row of training) {
      conditional[row.surfaceChanged]![row.graphChanged]! += 1;
      baseline[row.graphChanged]! += 1;
    }
    const conditionalTotal =
      conditional[heldout.surfaceChanged]![0]!
      + conditional[heldout.surfaceChanged]![1]!;
    const baselineTotal = baseline[0]! + baseline[1]!;
    gain += Math.log(
      conditional[heldout.surfaceChanged]![heldout.graphChanged]!
      / conditionalTotal
    ) - Math.log(baseline[heldout.graphChanged]! / baselineTotal);
    evaluated += 1;
  }
  return evaluated ? gain / evaluated : 0;
}

function shuffledExamples(
  examples: ReturnType<typeof oneExamplePerFamily>,
  controlIndex: number,
  hasher: Hasher
): ReturnType<typeof oneExamplePerFamily> {
  const graphValues = examples.map(example => example.graphTargetIds);
  const permutation = examples.map((example, index) => ({
    index,
    key: hasher.digestHex(canonicalStringify([
      "graph_surface_shuffle",
      controlIndex,
      example.sourceFamilyId,
      index
    ]))
  })).sort((left, right) =>
    left.key.localeCompare(right.key) || left.index - right.index);
  return examples.map((example, index) => ({
    ...example,
    graphTargetIds: graphValues[permutation[index]!.index]!
  }));
}

function jointStatistic(
  cmi: number,
  gain: number,
  minimumCmi: number,
  minimumGain: number
): number {
  return Math.min(
    cmi / Math.max(1e-12, minimumCmi),
    gain / Math.max(1e-12, minimumGain)
  );
}

function floorAt(value: number | undefined, floor: number): number {
  const actual = value ?? floor;
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error("variability metric floor must be finite and nonnegative");
  }
  return Math.max(floor, actual);
}

function ceilingAt(value: number | undefined, ceiling: number): number {
  const actual = value ?? ceiling;
  if (!Number.isFinite(actual) || actual < 0 || actual > 1) {
    throw new Error("variability probability ceiling must be in [0,1]");
  }
  return Math.min(ceiling, actual);
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function quantize(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : 0;
}

function stableId(hasher: Hasher, namespace: string, value: unknown): string {
  return `${namespace}.${hasher.digestHex(canonicalStringify(value)).slice(0, 40)}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
