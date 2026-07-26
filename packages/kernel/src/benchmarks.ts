import type { BenchmarkInput, BenchmarkTask, BuildTestResult, EmissionGraph, EvidenceSpan, JsonValue, SemanticEntailmentResult, TurnResult, ValidationGraph } from "./types.js";
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

export type BroadBenchmarkTaskClass =
  | "factual_qa"
  | "reasoning"
  | "long_form_narrative"
  | "code_artifact"
  | "translation"
  | "multi_turn_coherence"
  | "learning_acquisition";

export interface BroadBenchmarkReadinessReport {
  schema: "scce.broad_benchmark_readiness.v1";
  requiredTaskClasses: BroadBenchmarkTaskClass[];
  coveredTaskClasses: BroadBenchmarkTaskClass[];
  missingTaskClasses: BroadBenchmarkTaskClass[];
  classScores: Array<{ taskClass: BroadBenchmarkTaskClass; cases: number; score: number; targetScore: number; passed: boolean }>;
  frontierComparisons: Array<{ taskId: string; local: number; bestFrontier: number | null; delta: number | null; passed: boolean | null }>;
  releaseGate: "passed" | "blocked_missing_tasks" | "blocked_quality" | "blocked_frontier_missing" | "blocked_frontier_delta";
  notes: string[];
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

export const DEFAULT_BROAD_TASK_CLASSES: readonly BroadBenchmarkTaskClass[] = [
  "factual_qa",
  "reasoning",
  "long_form_narrative",
  "code_artifact",
  "translation",
  "multi_turn_coherence",
  "learning_acquisition"
] as const;

export const FRONTIER_BROAD_CAPABILITY_SUITE_ID = "scce.eval.frontier_broad_capability.v1";

export function createFrontierBroadCapabilityTasks(): BenchmarkTask[] {
  return [
    {
      id: "frontier.factual.evidence_qa",
      caseType: "FactualEvidenceCase",
      input: "Answer the question using only the supplied source evidence and name the supporting facts.",
      expectedEvidence: ["source", "evidence", "supporting facts"]
    },
    {
      id: "frontier.reasoning.multi_step",
      caseType: "ReasoningCase",
      input: "Resolve a multi-step reasoning problem with competing constraints and explain the admissible path.",
      expectedEvidence: ["constraint", "path", "reason"]
    },
    {
      id: "frontier.narrative.long_form",
      caseType: "LongFormNarrativeCase",
      input: "Write a coherent long-form narrative scene with dialogue, continuity, and a complete arc.",
      criteria: { minWords: 800, minParagraphs: 5, minSentences: 18, requiresDialogue: true }
    },
    {
      id: "frontier.code.artifact",
      caseType: "CodeEditingCase",
      input: "Implement a non-trivial code change, return the changed artifacts, and pass validation.",
      expectedArtifacts: ["src/solution.ts"],
      expectedEvidence: ["implementation", "validation"]
    },
    {
      id: "frontier.translation.preservation",
      caseType: "TranslationCase",
      input: "Translate source material while preserving named entities, numbers, and uncertainty.",
      expectedEvidence: ["Mira", "42", "2026"]
    },
    {
      id: "frontier.multiturn.coherence",
      caseType: "MultiTurnCoherenceCase",
      input: "Continue a prior multi-turn task without losing constraints, corrections, or named references.",
      criteria: { requiredReferences: ["prior constraint", "correction"], forbiddenRegressions: ["forgot", "start over"] }
    },
    {
      id: "frontier.learning.acquisition",
      caseType: "LearningAcquisitionCase",
      input: "Ingest a new source, identify what changed, and expose measurable learning needs.",
      expectedEvidence: ["new source", "changed", "learning"]
    }
  ];
}

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
        noveltyBoundednessDimension(turn),
        taskSpecificDimension(task, turn)
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
    },

    broadReadiness(
      tasks: readonly BenchmarkTaskInput[],
      results: readonly BenchmarkRubricResult[],
      input: {
        requiredTaskClasses?: readonly BroadBenchmarkTaskClass[];
        minClassScore?: number;
        minFrontierMargin?: number;
        frontierRecords?: readonly FrontierComparisonRecord[];
      } = {}
    ): BroadBenchmarkReadinessReport {
      return broadBenchmarkReadiness({
        tasks,
        results,
        frontierRecords: input.frontierRecords ?? options.frontierRecords ?? [],
        requiredTaskClasses: input.requiredTaskClasses ?? DEFAULT_BROAD_TASK_CLASSES,
        minClassScore: input.minClassScore ?? 0.82,
        minFrontierMargin: input.minFrontierMargin ?? 0.01
      });
    }
  };
}

export function broadBenchmarkReadiness(input: {
  tasks: readonly BenchmarkTaskInput[];
  results: readonly BenchmarkRubricResult[];
  frontierRecords?: readonly FrontierComparisonRecord[];
  requiredTaskClasses?: readonly BroadBenchmarkTaskClass[];
  minClassScore?: number;
  minFrontierMargin?: number;
}): BroadBenchmarkReadinessReport {
  const required = [...(input.requiredTaskClasses ?? DEFAULT_BROAD_TASK_CLASSES)];
  const minClassScore = clamp01(input.minClassScore ?? 0.82);
  const minFrontierMargin = input.minFrontierMargin ?? 0.01;
  const taskById = new Map(input.tasks.map(task => [task.id, task]));
  const resultsByClass = new Map<BroadBenchmarkTaskClass, BenchmarkRubricResult[]>();
  for (const result of input.results) {
    const task = taskById.get(result.taskId);
    if (!task) continue;
    const taskClass = broadTaskClass(task);
    resultsByClass.set(taskClass, [...(resultsByClass.get(taskClass) ?? []), result]);
  }
  const covered = required.filter(taskClass => (resultsByClass.get(taskClass)?.length ?? 0) > 0);
  const missing = required.filter(taskClass => !covered.includes(taskClass));
  const classScores = required.map(taskClass => {
    const rows = resultsByClass.get(taskClass) ?? [];
    const score = rows.length ? mean(rows.map(row => row.score)) : 0;
    return { taskClass, cases: rows.length, score, targetScore: minClassScore, passed: rows.length > 0 && score >= minClassScore };
  });
  const frontierRecords = input.frontierRecords ?? [];
  const frontierComparisons = input.results.map(result => {
    const peers = frontierRecords.filter(record => record.taskId === result.taskId);
    const bestFrontier = peers.length ? Math.max(...peers.map(record => record.score)) : null;
    const delta = bestFrontier === null ? null : result.score - bestFrontier;
    const passed = delta === null ? null : delta >= minFrontierMargin;
    return { taskId: result.taskId, local: result.score, bestFrontier, delta, passed };
  });
  const qualityBlocked = classScores.some(row => row.cases > 0 && !row.passed);
  const frontierMissing = frontierRecords.length === 0 || frontierComparisons.some(row => row.bestFrontier === null);
  const frontierDeltaBlocked = frontierComparisons.some(row => row.passed === false);
  const releaseGate = missing.length
    ? "blocked_missing_tasks"
    : qualityBlocked
      ? "blocked_quality"
      : frontierMissing
        ? "blocked_frontier_missing"
        : frontierDeltaBlocked
          ? "blocked_frontier_delta"
          : "passed";
  return {
    schema: "scce.broad_benchmark_readiness.v1",
    requiredTaskClasses: required,
    coveredTaskClasses: covered,
    missingTaskClasses: missing,
    classScores,
    frontierComparisons,
    releaseGate,
    notes: [
      "releaseGate=passed requires every required task class, minimum local class score, and supplied frontier records for each task",
      frontierRecords.length ? `frontier records supplied: ${frontierRecords.length}` : "frontier records missing; no Claude/frontier-beater claim is admissible"
    ]
  };
}

export function broadTaskClass(task: BenchmarkTaskInput): BroadBenchmarkTaskClass {
  switch (task.caseType) {
    case "FactualEvidenceCase":
    case "ContradictionCase":
      return "factual_qa";
    case "SemanticEntailmentCase":
    case "ReasoningCase":
      return "reasoning";
    case "LongFormNarrativeCase":
      return "long_form_narrative";
    case "ProgramArtifactCase":
    case "CodeEditingCase":
      return "code_artifact";
    case "TranslationCase":
      return "translation";
    case "MultiTurnCoherenceCase":
      return "multi_turn_coherence";
    case "LearningAcquisitionCase":
      return "learning_acquisition";
    default:
      return "factual_qa";
  }
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

function taskSpecificDimension(task: BenchmarkTaskInput, turn: TurnResult): BenchmarkDimensionScore {
  const taskClass = broadTaskClass(task);
  const criteria = criteriaRecord(task.criteria);
  const score = (() => {
    if (taskClass === "long_form_narrative") return longFormNarrativeScore(turn.answer, criteria);
    if (taskClass === "code_artifact") return codeArtifactScore(task, turn);
    if (taskClass === "translation") return translationPreservationScore(task, turn.answer, turn.evidence);
    if (taskClass === "reasoning") return reasoningScore(turn);
    if (taskClass === "multi_turn_coherence") return multiTurnCoherenceScore(turn.answer, criteria);
    if (taskClass === "learning_acquisition") return learningAcquisitionScore(turn);
    return factualQaScore(task, turn);
  })();
  return {
    id: `taskSpecific:${taskClass}`,
    label: `Task Specific: ${taskClass}`,
    weight: 0.12,
    score,
    evidence: toJsonValue({ taskClass, caseType: task.caseType ?? "SmokeCase", criteria })
  };
}

function longFormNarrativeScore(answer: string, criteria: Record<string, JsonValue>): number {
  const minWords = numberCriterion(criteria.minWords, 120);
  const maxWords = numberCriterion(criteria.maxWords, 5000);
  const words = answer.trim().split(/\s+/u).filter(Boolean);
  const paragraphs = answer.split(/(?:\r?\n){2,}/u).map(row => row.trim()).filter(Boolean);
  const dialogue = /["“”‘’「」『』—–]\s*\p{Letter}/u.test(answer);
  const sentenceCount = (answer.match(/[.!?\u3002\uff01\uff1f]/gu) ?? []).length;
  const lengthScore = words.length < minWords ? words.length / Math.max(1, minWords) : words.length > maxWords ? maxWords / words.length : 1;
  const paragraphScore = clamp01(paragraphs.length / Math.max(2, numberCriterion(criteria.minParagraphs, 2)));
  const sentenceScore = clamp01(sentenceCount / Math.max(4, numberCriterion(criteria.minSentences, 4)));
  const dialogueScore = criteria.requiresDialogue === true ? (dialogue ? 1 : 0.35) : 0.8;
  return clamp01(0.34 * lengthScore + 0.24 * paragraphScore + 0.22 * sentenceScore + 0.2 * dialogueScore);
}

function codeArtifactScore(task: BenchmarkTaskInput, turn: TurnResult): number {
  const expected = task.expectedArtifacts ?? [];
  const artifactScore = expected.length
    ? expected.filter(path => turn.emissionGraph.artifacts.some(artifact => artifact.path === path)).length / expected.length
    : clamp01(turn.emissionGraph.artifacts.length / 2);
  const validation = turn.validationGraph.passed ? 1 : mean(turn.validationGraph.checks.map(check => check.score)) * 0.45;
  const build = turn.buildTest ? (turn.buildTest.passed ? 1 : 0.2) : expected.length ? 0 : 0.65;
  return clamp01(0.42 * artifactScore + 0.36 * validation + 0.22 * build);
}

function translationPreservationScore(task: BenchmarkTaskInput, answer: string, evidence: readonly EvidenceSpan[]): number {
  const expected = task.expectedEvidence ?? [];
  const expectedNumbers = expected.flatMap(numberTokens);
  const answerNumbers = new Set(numberTokens(answer));
  const numberScore = expectedNumbers.length ? expectedNumbers.filter(token => answerNumbers.has(token)).length / expectedNumbers.length : 0.75;
  const expectedEntities = expected.flatMap(entityTokens);
  const answerLower = answer.toLocaleLowerCase();
  const entityScore = expectedEntities.length ? expectedEntities.filter(token => answerLower.includes(token.toLocaleLowerCase())).length / expectedEntities.length : 0.65;
  const evidenceScore = evidence.length ? 0.75 : 0.35;
  return clamp01(0.38 * numberScore + 0.38 * entityScore + 0.24 * evidenceScore);
}

function reasoningScore(turn: TurnResult): number {
  const proofEdges = clamp01(turn.entailment.proof.proofGraph.edges.length / 6);
  const support = clamp01(turn.entailment.support);
  const contradiction = 1 - contradictionRisk(turn.entailment);
  const field = clamp01((turn.field.alphaTrace.relations.length + turn.field.ppf.length) / 16);
  return clamp01(0.3 * proofEdges + 0.3 * support + 0.25 * contradiction + 0.15 * field);
}

function multiTurnCoherenceScore(answer: string, criteria: Record<string, JsonValue>): number {
  const required = stringArray(criteria.requiredReferences);
  const forbidden = stringArray(criteria.forbiddenRegressions);
  const lower = answer.toLocaleLowerCase();
  const requiredScore = required.length ? required.filter(item => lower.includes(item.toLocaleLowerCase())).length / required.length : 0.65;
  const forbiddenScore = forbidden.some(item => lower.includes(item.toLocaleLowerCase())) ? 0 : 1;
  const pronounContinuity = /\b(it|this|that|they|them|those|these|he|she|we)\b/iu.test(answer) ? 0.8 : 0.55;
  return clamp01(0.45 * requiredScore + 0.35 * forbiddenScore + 0.2 * pronounContinuity);
}

function learningAcquisitionScore(turn: TurnResult): number {
  const needs = clamp01(turn.learningNeeds.length / 3);
  const learningEvents = clamp01(turn.events.filter(event => String(event.typeId).includes("Learning")).length / 3);
  const audit = clamp01(turn.events.length / 12);
  return clamp01(0.42 * needs + 0.34 * learningEvents + 0.24 * audit);
}

function factualQaScore(task: BenchmarkTaskInput, turn: TurnResult): number {
  const expected = task.expectedEvidence ?? [];
  const answerLower = turn.answer.toLocaleLowerCase();
  const expectedScore = expected.length ? expected.filter(item => answerLower.includes(item.toLocaleLowerCase())).length / expected.length : forceScore(turn.entailment.force);
  return clamp01(0.42 * expectedScore + 0.34 * turn.entailment.support + 0.24 * (1 - contradictionRisk(turn.entailment)));
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

function criteriaRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function numberCriterion(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberTokens(text: string): string[] {
  return text.match(/\b\d+(?:[.,:/-]\d+)*%?\b/gu) ?? [];
}

function entityTokens(text: string): string[] {
  return [...new Set(text.match(/\b\p{Lu}[\p{Letter}\p{Number}-]{2,}\b/gu) ?? [])].slice(0, 64);
}