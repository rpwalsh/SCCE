import type { BenchmarkInput, BuildTestResult, EmissionGraph, EvidenceSpan, JsonValue, SemanticEntailmentResult, TurnResult, ValidationGraph } from "./types.js";
import { clamp01, mean, toJsonValue, weightedJaccard, featureSet } from "./primitives.js";

type BenchmarkTaskInput = NonNullable<BenchmarkInput["tasks"]>[number];

export interface BenchmarkDimensionScore {
  id: string;
  label: string;
  score: number;
  weight: number;
  evidence: JsonValue;
}

export interface BenchmarkRubricResult {
  taskId: string;
  score: number;
  dimensions: BenchmarkDimensionScore[];
  residualRisk: number;
  notes: string[];
}

export interface FrontierComparisonRecord {
  provider: string;
  model: string;
  benchmark: string;
  taskId: string;
  score: number;
  observedAt: number;
  runUri?: string;
  metadata?: JsonValue;
}

export const DEFAULT_BENCHMARK_WEIGHTS = {
  correctness: 0.18,
  evidenceEntailment: 0.16,
  auditability: 0.14,
  buildAndTest: 0.14,
  toolUse: 0.1,
  multilingualTransfer: 0.08,
  safety: 0.08,
  efficiency: 0.06,
  noveltyBoundedness: 0.06
} as const;

export function createBenchmarkScorer(options: { frontierRecords?: FrontierComparisonRecord[] } = {}) {
  return {
    scoreTurn(task: BenchmarkTaskInput, turn: TurnResult): BenchmarkRubricResult {
      const dimensions: BenchmarkDimensionScore[] = [
        correctnessDimension(task, turn.entailment, turn.validationGraph, turn.emissionGraph),
        evidenceDimension(task, turn.evidence, turn.entailment),
        auditabilityDimension(turn),
        buildAndTestDimension(task, turn.buildTest),
        toolUseDimension(turn),
        multilingualDimension(turn.evidence),
        safetyDimension(turn),
        efficiencyDimension(turn),
        noveltyBoundednessDimension(turn)
      ];
      const totalWeight = dimensions.reduce((sum, item) => sum + item.weight, 0);
      const score = totalWeight > 0 ? dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight : 0;
      const residualRisk = clamp01(1 - score + contradictionRisk(turn.entailment) * 0.3 + validationRisk(turn.validationGraph) * 0.25);
      const frontier = options.frontierRecords?.filter(record => record.taskId === task.id) ?? [];
      const notes = [
        "local SCCE turn scored from persisted evidence, proof, validation, and event material",
        frontier.length ? `frontier comparison records supplied: ${frontier.length}` : "no frontier comparison supplied or claimed"
      ];
      return { taskId: task.id, score, dimensions, residualRisk, notes };
    },

    aggregate(results: readonly BenchmarkRubricResult[]): { score: number; dimensions: BenchmarkDimensionScore[]; residualRisk: number; report: JsonValue } {
      const dimensionIds = [...new Set(results.flatMap(result => result.dimensions.map(d => d.id)))].sort();
      const dimensions = dimensionIds.map(id => {
        const items = results.flatMap(result => result.dimensions.filter(d => d.id === id));
        return {
          id,
          label: items[0]?.label ?? id,
          score: mean(items.map(item => item.score)),
          weight: mean(items.map(item => item.weight)),
          evidence: toJsonValue({ tasks: items.length })
        };
      });
      const score = mean(results.map(result => result.score));
      const residualRisk = mean(results.map(result => result.residualRisk));
      return { score, dimensions, residualRisk, report: toJsonValue({ score, residualRisk, tasks: results.length, dimensions }) };
    },

    frontierDelta(local: BenchmarkRubricResult, records: readonly FrontierComparisonRecord[]): JsonValue {
      const peers = records.filter(record => record.taskId === local.taskId);
      const best = peers.length ? Math.max(...peers.map(record => record.score)) : null;
      return toJsonValue({
        taskId: local.taskId,
        local: local.score,
        bestFrontier: best,
        delta: best === null ? null : local.score - best,
        records: peers.map(record => ({ provider: record.provider, model: record.model, score: record.score, observedAt: record.observedAt, runUri: record.runUri ?? null }))
      });
    }
  };
}

function correctnessDimension(task: BenchmarkTaskInput, entailment: SemanticEntailmentResult, validation: ValidationGraph, emission: EmissionGraph): BenchmarkDimensionScore {
  const expected = task.expectedEvidence ?? [];
  const expectedFeatures = featureSet(expected.join("\n"), 256);
  const answerFeatures = featureSet(emission.answer, 512);
  const lexical = expectedFeatures.length ? weightedJaccard(expectedFeatures, answerFeatures) : forceScore(entailment.force);
  const proof = forceScore(entailment.force) * (1 - contradictionRisk(entailment));
  const validationScore = validation.passed ? 1 : mean(validation.checks.map(check => check.score)) * 0.5;
  return {
    id: "correctness",
    label: "Correctness",
    weight: DEFAULT_BENCHMARK_WEIGHTS.correctness,
    score: clamp01(0.4 * lexical + 0.4 * proof + 0.2 * validationScore),
    evidence: toJsonValue({ force: entailment.force, lexical, proof, validationScore, expectedEvidence: expected.length })
  };
}

function evidenceDimension(task: BenchmarkTaskInput, evidence: readonly EvidenceSpan[], entailment: SemanticEntailmentResult): BenchmarkDimensionScore {
  const expected = task.expectedEvidence ?? [];
  const matches = expected.map(item => evidence.some(span => span.text.toLowerCase().includes(item.toLowerCase())) ? 1 : 0);
  const matchScore = expected.length ? mean(matches) : evidence.length > 0 ? 0.75 : 0;
  const promoted = evidence.length ? evidence.filter(span => span.status === "promoted").length / evidence.length : 0;
  return {
    id: "evidenceEntailment",
    label: "Evidence Entailment",
    weight: DEFAULT_BENCHMARK_WEIGHTS.evidenceEntailment,
    score: clamp01(0.35 * matchScore + 0.25 * promoted + 0.25 * entailment.support + 0.15 * entailment.faithfulnessLcb),
    evidence: toJsonValue({ expected, matches, promoted, support: entailment.support, faithfulnessLcb: entailment.faithfulnessLcb })
  };
}

function auditabilityDimension(turn: TurnResult): BenchmarkDimensionScore {
  const eventScore = clamp01(turn.events.length / 16);
  const proofScore = clamp01(turn.entailment.proof.proofGraph.edges.length / 8);
  const graphScore = clamp01((turn.field.alphaTrace.relations.length + turn.field.ppf.length) / 24);
  return {
    id: "auditability",
    label: "Auditability",
    weight: DEFAULT_BENCHMARK_WEIGHTS.auditability,
    score: clamp01(0.35 * eventScore + 0.35 * proofScore + 0.3 * graphScore),
    evidence: toJsonValue({ events: turn.events.length, proofEdges: turn.entailment.proof.proofGraph.edges.length, alphaRelations: turn.field.alphaTrace.relations.length, ppf: turn.field.ppf.length })
  };
}

function buildAndTestDimension(task: BenchmarkTaskInput, buildTest: BuildTestResult | undefined): BenchmarkDimensionScore {
  const expected = task.expectedArtifacts ?? [];
  if (!expected.length && !buildTest) return { id: "buildAndTest", label: "Build And Test", weight: DEFAULT_BENCHMARK_WEIGHTS.buildAndTest, score: 0.6, evidence: { reason: "not requested" } };
  if (!buildTest) return { id: "buildAndTest", label: "Build And Test", weight: DEFAULT_BENCHMARK_WEIGHTS.buildAndTest, score: 0, evidence: { reason: "artifact expected but no build test result" } };
  const artifactScore = expected.length ? mean(expected.map(path => buildTest.artifacts.some(artifact => artifact.path === path) ? 1 : 0)) : 1;
  const passScore = buildTest.passed ? 1 : 0.2;
  const repairPenalty = buildTest.repairAttempted && !buildTest.repairApplied ? 0.08 : 0;
  return {
    id: "buildAndTest",
    label: "Build And Test",
    weight: DEFAULT_BENCHMARK_WEIGHTS.buildAndTest,
    score: clamp01(0.5 * passScore + 0.5 * artifactScore - repairPenalty),
    evidence: toJsonValue({ passed: buildTest.passed, artifacts: buildTest.artifacts.map(artifact => artifact.path), repairAttempted: buildTest.repairAttempted, repairApplied: buildTest.repairApplied })
  };
}

function toolUseDimension(turn: TurnResult): BenchmarkDimensionScore {
  const plans = turn.events.filter(event => String(event.typeId).startsWith("Capability") || String(event.typeId).startsWith("Action"));
  const success = turn.events.filter(event => event.typeId === "CapabilitySucceeded" as never || event.typeId === "ActionCommitted" as never).length;
  const failure = turn.events.filter(event => event.typeId === "CapabilityFailed" as never || event.typeId === "ActionRolledBack" as never).length;
  const score = plans.length ? clamp01((success + 0.5) / (success + failure + 1)) : 0.75;
  return { id: "toolUse", label: "Tool Use", weight: DEFAULT_BENCHMARK_WEIGHTS.toolUse, score, evidence: toJsonValue({ plannedEvents: plans.length, success, failure }) };
}

function multilingualDimension(evidence: readonly EvidenceSpan[]): BenchmarkDimensionScore {
  const scripts = new Set<string>();
  const directions = new Set<string>();
  for (const span of evidence) {
    const hints = span.languageHints as { scripts?: Array<{ script: string }>; direction?: string };
    for (const script of hints.scripts ?? []) scripts.add(script.script);
    if (hints.direction) directions.add(hints.direction);
  }
  const score = scripts.size >= 3 ? 1 : scripts.size === 2 ? 0.8 : scripts.size === 1 ? 0.55 : 0.25;
  return { id: "multilingualTransfer", label: "Multilingual Transfer", weight: DEFAULT_BENCHMARK_WEIGHTS.multilingualTransfer, score, evidence: toJsonValue({ scripts: [...scripts], directions: [...directions] }) };
}

function safetyDimension(turn: TurnResult): BenchmarkDimensionScore {
  const contradiction = contradictionRisk(turn.entailment);
  const validation = validationRisk(turn.validationGraph);
  const bounded = turn.entailment.boundaries.length > 0 ? 0.9 : 0.7;
  const score = clamp01(0.4 * (1 - contradiction) + 0.35 * (1 - validation) + 0.25 * bounded);
  return { id: "safety", label: "Safety", weight: DEFAULT_BENCHMARK_WEIGHTS.safety, score, evidence: toJsonValue({ contradiction, validation, boundaries: turn.entailment.boundaries }) };
}

function efficiencyDimension(turn: TurnResult): BenchmarkDimensionScore {
  const eventScore = clamp01(1 - Math.max(0, turn.events.length - 40) / 80);
  const evidenceScore = clamp01(1 - Math.max(0, turn.evidence.length - 24) / 100);
  const artifactScore = clamp01(1 - Math.max(0, turn.emissionGraph.artifacts.length - 8) / 24);
  return { id: "efficiency", label: "Efficiency", weight: DEFAULT_BENCHMARK_WEIGHTS.efficiency, score: clamp01(0.4 * eventScore + 0.35 * evidenceScore + 0.25 * artifactScore), evidence: toJsonValue({ events: turn.events.length, evidence: turn.evidence.length, artifacts: turn.emissionGraph.artifacts.length }) };
}

function noveltyBoundednessDimension(turn: TurnResult): BenchmarkDimensionScore {
  const canInvent = turn.epistemicForce === "invented" || turn.epistemicForce === "conjectured";
  const boundary = turn.entailment.boundaries.length ? 1 : canInvent ? 0.35 : 0.7;
  const artifact = turn.constructGraph.artifacts.length ? 0.9 : 0.6;
  return { id: "noveltyBoundedness", label: "Novelty Boundedness", weight: DEFAULT_BENCHMARK_WEIGHTS.noveltyBoundedness, score: clamp01(0.6 * boundary + 0.4 * artifact), evidence: toJsonValue({ force: turn.epistemicForce, boundaries: turn.entailment.boundaries, artifacts: turn.constructGraph.artifacts.length }) };
}

function forceScore(force: string): number {
  if (force === "proved") return 1;
  if (force === "observed") return 0.86;
  if (force === "inferred") return 0.66;
  if (force === "conjectured") return 0.45;
  if (force === "invented") return 0.3;
  return 0.15;
}

function contradictionRisk(entailment: SemanticEntailmentResult): number {
  return clamp01(entailment.contradiction * 0.75 + Math.max(0, 0.3 - entailment.faithfulnessLcb));
}

function validationRisk(validation: ValidationGraph): number {
  if (validation.passed) return 0;
  return clamp01(1 - mean(validation.checks.map(check => check.score)));
}
