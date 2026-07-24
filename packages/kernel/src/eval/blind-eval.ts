import { canonicalStringify, clamp01, createClock, toJsonValue } from "../primitives.js";
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  calibrationObservationRecord,
  type CalibrationObservationRecord
} from "../calibration-spine.js";
import type { Clock, JsonValue } from "../types.js";

export const EVAL_CATEGORY_IDS = {
  coding: "evalcat.1f2a70c9",
  factual: "evalcat.84d9b315",
  math: "evalcat.620e7a18",
  contradiction: "evalcat.6a977f32",
  insufficientEvidence: "evalcat.9e4c1a04",
  sourceBound: "evalcat.0f21d45c",
  multilingual: "evalcat.17c2d81f",
  translation: "evalcat.b7a21389",
  longContextDialogue: "evalcat.91fa4b23",
  conversationRepair: "evalcat.13cebf05",
  styleFollowing: "evalcat.4d2876bd",
  proofPreservation: "evalcat.f090c2a8"
} as const;

export interface EvalPrompt {
  id: string;
  categoryId: string;
  prompt: string;
  rubric: EvalRubric;
  metadata?: JsonValue;
}

export interface EvalRubric {
  id: string;
  criteria: readonly string[];
  protectedSpans?: readonly string[];
  expectedTerms?: readonly string[];
  forbiddenTerms?: readonly string[];
  brevityTargetWords?: number;
}

export interface EvalAnswer {
  id: string;
  promptId: string;
  providerId: string;
  text: string;
  metadata?: JsonValue;
}

export interface EvalProvider {
  id: string;
  produce(prompt: EvalPrompt): Promise<EvalAnswer>;
}

export interface RubricScore {
  criterionId: string;
  answerA: number;
  answerB: number;
  weight: number;
}

export interface BlindEvalJudgment {
  promptId: string;
  answerAId: string;
  answerBId: string;
  preferredAnswerId?: string;
  tie?: boolean;
  rubricScores: readonly RubricScore[];
  judgeId?: string;
  hiddenProviderIds: boolean;
}

export interface BlindEvalCategoryReport {
  categoryId: string;
  promptCount: number;
  baselinePreferredRate: number;
  tieRate: number;
  alternativePreferredRate: number;
  protectedSpanFailureRate: number;
  unsupportedContentRate: number;
  correctionImprovementRate: number;
  calibrationStatus: "sample_too_small" | "provisional_heuristic" | "calibrated";
  knownLimits: string[];
}

export interface BlindEvalReport {
  schema: "scce.blind_eval.report.v2";
  id: string;
  promptCount: number;
  judgmentCount: number;
  categories: BlindEvalCategoryReport[];
  hiddenProviderIds: boolean;
  rawAnswerRefs: string[];
  trace: JsonValue;
}

export function createJsonlEvalProvider(input: { providerId: string; answers: readonly EvalAnswer[] }): EvalProvider {
  return {
    id: input.providerId,
    async produce(prompt) {
      const answer = input.answers.find(item => item.promptId === prompt.id);
      if (!answer) throw new Error(`missing imported answer for prompt ${prompt.id}`);
      return { ...answer, providerId: input.providerId };
    }
  };
}

export async function runBlindPairwiseEval(input: {
  prompts: readonly EvalPrompt[];
  providers: readonly EvalProvider[];
  judgeId?: string;
  baselineProviderId?: string;
  createdAt?: number;
  clock?: Clock;
}): Promise<{ answers: EvalAnswer[]; judgments: BlindEvalJudgment[]; report: BlindEvalReport; calibrationObservations: CalibrationObservationRecord[] }> {
  const answers: EvalAnswer[] = [];
  for (const prompt of input.prompts) {
    for (const provider of input.providers) answers.push(await provider.produce(prompt));
  }
  const judgments: BlindEvalJudgment[] = [];
  for (const prompt of input.prompts) {
    const promptAnswers = answers.filter(answer => answer.promptId === prompt.id);
    for (let i = 0; i < promptAnswers.length; i++) {
      for (let j = i + 1; j < promptAnswers.length; j++) {
        const [answerA, answerB] = blindOrder(promptAnswers[i]!, promptAnswers[j]!, prompt.id);
        judgments.push(judgePair({ prompt, answerA, answerB, judgeId: input.judgeId }));
      }
    }
  }
  const report = summarizeBlindEval({ prompts: input.prompts, answers, judgments, baselineProviderId: input.baselineProviderId });
  const calibrationObservations = calibrationObservationsFromBlindEval({
    prompts: input.prompts,
    answers,
    judgments,
    report,
    createdAt: input.createdAt,
    clock: input.clock
  });
  return { answers, judgments, report, calibrationObservations };
}

export function calibrationObservationsFromBlindEval(input: {
  prompts: readonly EvalPrompt[];
  answers: readonly EvalAnswer[];
  judgments: readonly BlindEvalJudgment[];
  report?: BlindEvalReport;
  createdAt?: number;
  clock?: Clock;
}): CalibrationObservationRecord[] {
  const promptById = new Map(input.prompts.map(prompt => [prompt.id, prompt]));
  const answerById = new Map(input.answers.map(answer => [answer.id, answer]));
  const createdAt = input.createdAt ?? (input.clock ?? createClock()).now();
  const observations: CalibrationObservationRecord[] = [];
  for (const judgment of input.judgments) {
    const prompt = promptById.get(judgment.promptId);
    const answerA = answerById.get(judgment.answerAId);
    const answerB = answerById.get(judgment.answerBId);
    for (const score of judgment.rubricScores) {
      const target = calibrationTargetForCriterion(score.criterionId);
      if (answerA) observations.push(calibrationObservationRecord({
        calibrationId: target.calibrationId,
        subsystemId: target.subsystemId,
        taskClass: taskClassFromEvalPrompt(prompt),
        rawScore: score.answerA,
        outcome: judgment.tie ? score.answerA >= score.answerB : judgment.preferredAnswerId === answerA.id,
        selectedOutputHash: hashText(answerA.text),
        unsupportedFactHit: score.criterionId === "rubric.unsupported_content" ? score.answerA < 1 : undefined,
        citationFailure: score.criterionId === "rubric.protected_span" ? score.answerA < 1 : undefined,
        finalOutcome: judgment.tie ? "outcome.tie" : judgment.preferredAnswerId === answerA.id ? "outcome.preferred" : "outcome.not_preferred",
        sourceTraceId: input.report?.id,
        sourceRecordId: `${judgment.promptId}:${answerA.id}:${score.criterionId}`,
        metadata: toJsonValue({ promptId: judgment.promptId, answerId: answerA.id, criterionId: score.criterionId, weight: score.weight, judgeId: judgment.judgeId, categoryId: prompt?.categoryId }),
        createdAt,
        idSeed: `blind_eval:${judgment.promptId}:${answerA.id}:${score.criterionId}:${score.answerA}`
      }));
      if (answerB) observations.push(calibrationObservationRecord({
        calibrationId: target.calibrationId,
        subsystemId: target.subsystemId,
        taskClass: taskClassFromEvalPrompt(prompt),
        rawScore: score.answerB,
        outcome: judgment.tie ? score.answerB >= score.answerA : judgment.preferredAnswerId === answerB.id,
        selectedOutputHash: hashText(answerB.text),
        unsupportedFactHit: score.criterionId === "rubric.unsupported_content" ? score.answerB < 1 : undefined,
        citationFailure: score.criterionId === "rubric.protected_span" ? score.answerB < 1 : undefined,
        finalOutcome: judgment.tie ? "outcome.tie" : judgment.preferredAnswerId === answerB.id ? "outcome.preferred" : "outcome.not_preferred",
        sourceTraceId: input.report?.id,
        sourceRecordId: `${judgment.promptId}:${answerB.id}:${score.criterionId}`,
        metadata: toJsonValue({ promptId: judgment.promptId, answerId: answerB.id, criterionId: score.criterionId, weight: score.weight, judgeId: judgment.judgeId, categoryId: prompt?.categoryId }),
        createdAt,
        idSeed: `blind_eval:${judgment.promptId}:${answerB.id}:${score.criterionId}:${score.answerB}`
      }));
    }
  }
  return observations;
}

export function summarizeBlindEval(input: {
  prompts: readonly EvalPrompt[];
  answers: readonly EvalAnswer[];
  judgments: readonly BlindEvalJudgment[];
  baselineProviderId?: string;
}): BlindEvalReport {
  const categories = uniqueStrings(input.prompts.map(prompt => prompt.categoryId)).map(categoryId => {
    const prompts = input.prompts.filter(prompt => prompt.categoryId === categoryId);
    const promptIds = new Set(prompts.map(prompt => prompt.id));
    const judgments = input.judgments.filter(judgment => promptIds.has(judgment.promptId));
    const baselineAnswerIds = new Set(input.answers.filter(answer => !input.baselineProviderId || answer.providerId === input.baselineProviderId).map(answer => answer.id));
    let baselinePreferences = 0;
    let alternativePreferences = 0;
    let ties = 0;
    for (const judgment of judgments) {
      if (judgment.tie) ties++;
      else if (judgment.preferredAnswerId && baselineAnswerIds.has(judgment.preferredAnswerId)) baselinePreferences++;
      else alternativePreferences++;
    }
    const protectedFailures = judgments.flatMap(judgment => judgment.rubricScores).filter(score => score.criterionId === "rubric.protected_span" && Math.min(score.answerA, score.answerB) < 1).length;
    const unsupportedFailures = judgments.flatMap(judgment => judgment.rubricScores).filter(score => score.criterionId === "rubric.unsupported_content" && Math.min(score.answerA, score.answerB) < 1).length;
    const denominator = Math.max(1, judgments.length);
    return {
      categoryId,
      promptCount: prompts.length,
      baselinePreferredRate: baselinePreferences / denominator,
      tieRate: ties / denominator,
      alternativePreferredRate: alternativePreferences / denominator,
      protectedSpanFailureRate: protectedFailures / denominator,
      unsupportedContentRate: unsupportedFailures / denominator,
      correctionImprovementRate: 0,
      calibrationStatus: judgments.length < 20 ? "sample_too_small" as const : "provisional_heuristic" as const,
      knownLimits: judgments.length < 20 ? ["small_sample_descriptive_only"] : ["heuristic_judge_not_human_calibrated"]
    };
  });
  return {
    schema: "scce.blind_eval.report.v2",
    id: `blind_eval.${hashText(canonicalStringify({ prompts: input.prompts.map(prompt => prompt.id), judgments: input.judgments }))}`,
    promptCount: input.prompts.length,
    judgmentCount: input.judgments.length,
    categories,
    hiddenProviderIds: input.judgments.every(judgment => judgment.hiddenProviderIds),
    rawAnswerRefs: input.answers.map(answer => answer.id),
    trace: toJsonValue({ source: "eval.blind_pairwise", providerNamesUsedForTraining: false })
  };
}

export function blindEvalReportMarkdown(report: BlindEvalReport): string {
  const lines = [
    "# Yopp Blind Eval Report",
    "",
    `Prompts: ${report.promptCount}`,
    `Judgments: ${report.judgmentCount}`,
    `Provider IDs hidden during judgment: ${report.hiddenProviderIds ? "yes" : "no"}`,
    "",
    "| category | prompts | baseline preferred | tie | alternative preferred | protected span failures | unsupported content | calibration |",
    "|---|---:|---:|---:|---:|---:|---:|---|"
  ];
  for (const category of report.categories) {
    lines.push(`| ${category.categoryId} | ${category.promptCount} | ${pct(category.baselinePreferredRate)} | ${pct(category.tieRate)} | ${pct(category.alternativePreferredRate)} | ${pct(category.protectedSpanFailureRate)} | ${pct(category.unsupportedContentRate)} | ${category.calibrationStatus} |`);
  }
  lines.push("", "Metrics are descriptive and retain their calibration status and known limits.");
  return `${lines.join("\n")}\n`;
}

function judgePair(input: { prompt: EvalPrompt; answerA: EvalAnswer; answerB: EvalAnswer; judgeId?: string }): BlindEvalJudgment {
  const rubricScores = [
    scoreCriterion("rubric.correctness", input.answerA, input.answerB, input.prompt.rubric.expectedTerms ?? [], input.prompt.rubric.forbiddenTerms ?? []),
    scoreCriterion("rubric.usefulness", input.answerA, input.answerB, input.prompt.rubric.criteria, []),
    scoreCriterion("rubric.naturalness", input.answerA, input.answerB, [], ["selected candidate", "answer graph", "as an ai"]),
    protectedSpanScore(input.answerA, input.answerB, input.prompt.rubric.protectedSpans ?? []),
    brevityScore(input.answerA, input.answerB, input.prompt.rubric.brevityTargetWords ?? 90),
    scoreCriterion("rubric.actionability", input.answerA, input.answerB, ["next", "patch", "answer", "because"], []),
    unsupportedContentScore(input.answerA, input.answerB, input.prompt.rubric.forbiddenTerms ?? [])
  ];
  const scoreA = rubricScores.reduce((sum, score) => sum + score.answerA * score.weight, 0);
  const scoreB = rubricScores.reduce((sum, score) => sum + score.answerB * score.weight, 0);
  const tie = Math.abs(scoreA - scoreB) < 0.03;
  return {
    promptId: input.prompt.id,
    answerAId: input.answerA.id,
    answerBId: input.answerB.id,
    preferredAnswerId: tie ? undefined : scoreA > scoreB ? input.answerA.id : input.answerB.id,
    tie,
    rubricScores,
    judgeId: input.judgeId,
    hiddenProviderIds: true
  };
}

function scoreCriterion(criterionId: string, answerA: EvalAnswer, answerB: EvalAnswer, expected: readonly string[], forbidden: readonly string[]): RubricScore {
  return {
    criterionId,
    answerA: lexicalScore(answerA.text, expected, forbidden),
    answerB: lexicalScore(answerB.text, expected, forbidden),
    weight: 1
  };
}

function protectedSpanScore(answerA: EvalAnswer, answerB: EvalAnswer, protectedSpans: readonly string[]): RubricScore {
  return {
    criterionId: "rubric.protected_span",
    answerA: protectedSpans.length ? protectedSpans.filter(span => answerA.text.includes(span)).length / protectedSpans.length : 1,
    answerB: protectedSpans.length ? protectedSpans.filter(span => answerB.text.includes(span)).length / protectedSpans.length : 1,
    weight: 1.4
  };
}

function brevityScore(answerA: EvalAnswer, answerB: EvalAnswer, targetWords: number): RubricScore {
  return {
    criterionId: "rubric.brevity_fit",
    answerA: clamp01(1 - Math.abs(wordCount(answerA.text) - targetWords) / Math.max(targetWords, 1)),
    answerB: clamp01(1 - Math.abs(wordCount(answerB.text) - targetWords) / Math.max(targetWords, 1)),
    weight: 0.6
  };
}

function unsupportedContentScore(answerA: EvalAnswer, answerB: EvalAnswer, forbidden: readonly string[]): RubricScore {
  return {
    criterionId: "rubric.unsupported_content",
    answerA: forbidden.some(term => answerA.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())) ? 0 : 1,
    answerB: forbidden.some(term => answerB.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())) ? 0 : 1,
    weight: 1.2
  };
}

function calibrationTargetForCriterion(criterionId: string): { calibrationId: string; subsystemId: string } {
  if (criterionId === "rubric.correctness") return { calibrationId: CALIBRATION_IDS.proofSupport, subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof };
  if (criterionId === "rubric.unsupported_content") return { calibrationId: CALIBRATION_IDS.proofContradiction, subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof };
  if (criterionId === "rubric.protected_span") return { calibrationId: CALIBRATION_IDS.mouthPreservation, subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth };
  if (criterionId === "rubric.naturalness" || criterionId === "rubric.brevity_fit") return { calibrationId: CALIBRATION_IDS.mouthSurfaceFit, subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth };
  if (criterionId === "rubric.actionability" || criterionId === "rubric.usefulness") return { calibrationId: CALIBRATION_IDS.candidateMass, subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate };
  return { calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore, subsystemId: CALIBRATION_SUBSYSTEM_IDS.dialogue };
}

function taskClassFromEvalPrompt(prompt: EvalPrompt | undefined): string {
  if (!prompt) return CALIBRATION_TASK_CLASS_IDS.blindEval;
  if (prompt.categoryId === EVAL_CATEGORY_IDS.coding) return CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  if (prompt.categoryId === EVAL_CATEGORY_IDS.factual || prompt.categoryId === EVAL_CATEGORY_IDS.proofPreservation || prompt.categoryId === EVAL_CATEGORY_IDS.sourceBound) return CALIBRATION_TASK_CLASS_IDS.sourceBoundQa;
  return CALIBRATION_TASK_CLASS_IDS.blindEval;
}

function lexicalScore(text: string, expected: readonly string[], forbidden: readonly string[]): number {
  const lower = text.toLocaleLowerCase();
  const expectedFit = expected.length ? expected.filter(term => lower.includes(term.toLocaleLowerCase())).length / expected.length : 0.75;
  const forbiddenPenalty = forbidden.some(term => lower.includes(term.toLocaleLowerCase())) ? 0.35 : 0;
  const roboticPenalty = /selected candidate|answer graph|as an ai/iu.test(text) ? 0.2 : 0;
  return clamp01(expectedFit - forbiddenPenalty - roboticPenalty);
}

function blindOrder(left: EvalAnswer, right: EvalAnswer, seed: string): [EvalAnswer, EvalAnswer] {
  return hashText(`${seed}:${left.id}:${right.id}`).charCodeAt(0) % 2 === 0 ? [left, right] : [right, left];
}

function wordCount(text: string): number {
  return (text.match(/[\p{Letter}\p{Number}_-]+/gu) ?? []).length;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
