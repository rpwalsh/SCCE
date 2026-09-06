// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";

/** Built without a literal escape so a shell-mangled patch cannot silently break every reader here. */
const NEWLINE = new RegExp(String.fromCharCode(92) + "r?" + String.fromCharCode(92) + "n");
import path from "node:path";
import {
  computeUsefulnessPerJoule,
  evaluateReleaseGate,
  isPreregisteredTaskClassId,
  isValidPairedResult,
  type PairedResultRecord,
  wallEnergyJoules,
  type MeasuredResourceUsage,
  type PowerModel,
  type ReleaseGateResult,
  type ReleaseGateThresholds,
  type UsefulnessPerJouleResult,
  type UsefulnessRubricWeights
} from "@scce/kernel";

interface ObjectiveRow {
  questionId: string;
  systemId: string;
  conditionId?: string;
  exactScore?: number;
  requiredHits?: number;
  requiredCount?: number;
  forbiddenHits?: number;
  abstentionCorrect?: boolean;
  coherent?: boolean;
}

/** The question categories a sealed run declares, mapped onto the preregistered classes the gate will accept. A run
 *  whose categories are not covered here contributes no paired records rather than inventing a class for them. */
export const SEALED_CATEGORY_TASK_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  cloze: "factual_qa",
  unanswerable: "closed_graph_knowledge"
});

interface QuestionRow {
  questionId: string;
  category?: string;
  gold?: { unanswerable?: boolean };
}

interface AnswerRow {
  questionId: string;
  systemId: string;
  status?: string;
  metrics?: { timing?: { resourceUsage?: MeasuredResourceUsage } };
}

/**
 * A recall benchmark measures five of the six usefulness dimensions and cannot measure actionability at all, so that
 * weight is zero here rather than filled with a number nothing observed. The remaining five share the weight evenly.
 */
export const SEALED_RUN_USEFULNESS_WEIGHTS: UsefulnessRubricWeights = Object.freeze({
  quality: 0.2,
  correctness: 0.2,
  actionability: 0,
  relevance: 0.2,
  faithfulness: 0.2,
  harmlessness: 0.2
});

/** Per-question measured resource usage the run recorded for itself. */
async function readAnswerResourceUsage(
  objectivePath: string,
  system: string,
  answersPath?: string
): Promise<Map<string, MeasuredResourceUsage>> {
  const directory = path.dirname(objectivePath);
  const candidates = answersPath ? [answersPath] : [path.join(directory, "raw-answers.jsonl")];
  for (const candidate of candidates) {
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const rows = text
      .split(NEWLINE)
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as AnswerRow)
      .filter(row => row.systemId === system && row.metrics?.timing?.resourceUsage);
    return new Map(rows.map(row => [row.questionId, row.metrics!.timing!.resourceUsage!]));
  }
  return new Map();
}

/** Energy per answer for a run, computed only from the operator's own calibrated coefficients. */
function runEnergyReport(
  measured: readonly ObjectiveRow[],
  usageByQuestion: ReadonlyMap<string, MeasuredResourceUsage>,
  powerModel: PowerModel
): { answersMeasured: number; totalJoules: number; perAnswer: UsefulnessPerJouleResult[] } | undefined {
  const perAnswer: UsefulnessPerJouleResult[] = [];
  let totalJoules = 0;
  for (const row of measured) {
    const usage = usageByQuestion.get(row.questionId);
    if (!usage) continue;
    const joules = wallEnergyJoules(usage, powerModel);
    if (!(joules > 0)) continue;
    totalJoules += joules;
    const requiredCount = Math.max(1, Number(row.requiredCount ?? 1));
    perAnswer.push(computeUsefulnessPerJoule(
      {
        quality: row.coherent === false ? 0 : 1,
        correctness: Number(row.exactScore ?? 0) >= 1 ? 1 : 0,
        actionability: 0,
        relevance: Math.max(0, Math.min(1, Number(row.requiredHits ?? 0) / requiredCount)),
        faithfulness: (row.forbiddenHits ?? 0) > 0 ? 0 : 1,
        harmlessness: (row.forbiddenHits ?? 0) > 0 ? 0 : 1
      },
      SEALED_RUN_USEFULNESS_WEIGHTS,
      0,
      joules
    ));
  }
  return perAnswer.length ? { answersMeasured: perAnswer.length, totalJoules, perAnswer } : undefined;
}

/** Reads the sealed question set beside a run's objective records, so paired records can carry a real task class. */
async function readQuestionCategories(objectivePath: string, questionsPath?: string): Promise<Map<string, string>> {
  const directory = path.dirname(objectivePath);
  const candidates = questionsPath
    ? [questionsPath]
    : [path.join(directory, "questions.jsonl"), path.join(directory, "..", "questions.jsonl")];
  for (const candidate of candidates) {
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    return new Map(
      text
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as QuestionRow)
        .flatMap(row => (row.category ? [[row.questionId, row.category] as const] : []))
    );
  }
  if (questionsPath) throw new Error(`question set not readable: ${questionsPath}`);
  return new Map();
}

/** The questions a sealed run declares unanswerable: the abstention probes the cycle metric is measured on. */
async function readUnanswerableQuestions(objectivePath: string, questionsPath?: string): Promise<Set<string>> {
  const directory = path.dirname(objectivePath);
  const candidates = questionsPath
    ? [questionsPath]
    : [path.join(directory, "questions.jsonl"), path.join(directory, "..", "questions.jsonl")];
  for (const candidate of candidates) {
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    return new Set(
      text
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as QuestionRow)
        .filter(row => row.gold?.unanswerable === true)
        .map(row => row.questionId)
    );
  }
  return new Set();
}

/** Per-question answer status, needed to tell an abstention from a wrong assertion. Absent when no answers file is given. */
async function readAnswerStatuses(objectivePath: string, system: string, answersPath?: string): Promise<Map<string, string>> {
  const directory = path.dirname(objectivePath);
  const candidates = answersPath ? [answersPath] : [path.join(directory, "raw-answers.jsonl")];
  for (const candidate of candidates) {
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    return new Map(
      text
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as AnswerRow)
        .filter(row => row.systemId === system && typeof row.status === "string")
        .map(row => [row.questionId, String(row.status)])
    );
  }
  if (answersPath) throw new Error(`answers file not readable: ${answersPath}`);
  return new Map();
}

export interface EvaluationGateReport {
  system: string;
  reference?: string;
  questions: number;
  answerable: number;
  abstentionProbes: number;
  /** Null when no per-question status was available: the unsupported rate is then not computed and the gate fails closed. */
  assertedAnswers: number | null;
  metrics: { unsupportedRate: number; exactAnchorAccuracy: number; cycleAccuracy: number };
  thresholds: ReleaseGateThresholds;
  pairedResults: number;
  /** Present only when the caller supplied a calibrated power model and the run recorded its own resource usage. */
  energy?: {
    answersMeasured: number;
    totalJoules: number;
    meanJoulesPerAnswer: number;
    meanEtaSCCE: number;
    weights: UsefulnessRubricWeights;
  };
  gate: ReleaseGateResult;
}

/**
 * Runs the kernel's own release gate over a sealed run's objective records. The metrics are read from the run, never
 * supplied by hand: a forbidden hit or a missed abstention is an unsupported answer, an exact score is an anchor
 * recovery, and coherence is the cycle signal. When a reference system is present in the same file, its per-question
 * comparison becomes the paired record set the class-effect requirement is measured on.
 */
export async function runEvaluationReleaseGate(input: {
  objectivePath: string;
  system?: string;
  reference?: string;
  questionsPath?: string;
  answersPath?: string;
  /** Calibrated joules-per-unit coefficients for the serving hardware. Without them no energy figure is produced. */
  powerModel?: PowerModel;
  taskClassByCategory?: Readonly<Record<string, string>>;
  thresholds?: Partial<ReleaseGateThresholds>;
}): Promise<EvaluationGateReport> {
  const rows = (await readFile(input.objectivePath, "utf8"))
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as ObjectiveRow);
  if (!rows.length) throw new Error(`no objective records in ${input.objectivePath}`);
  const systems = [...new Set(rows.map(row => row.systemId))].sort();
  // A run holds the system under test beside its baselines; the baseline ids are the ones marked as references.
  const isReference = (id: string): boolean => id.startsWith("reference.") || id.startsWith("baseline.");
  const system = input.system ?? systems.find(id => !isReference(id) && id !== input.reference) ?? systems[0]!;
  const reference = input.reference ?? systems.find(id => id !== system && isReference(id)) ?? systems.find(id => id !== system);
  const measured = rows.filter(row => row.systemId === system);
  if (!measured.length) throw new Error(`objective records contain no system ${system}`);

  // The sealed kit's own definitions (harness/paired-release-report.mjs), not a second set: unsupported rate is the
  // share of ASSERTED answerable items that were wrong, so declining is never charged as an unsupported answer;
  // exact-anchor accuracy is over answerable items; cycle accuracy is abstention correctness on the unanswerable ones.
  const categories = await readQuestionCategories(input.objectivePath, input.questionsPath);
  const unanswerable = await readUnanswerableQuestions(input.objectivePath, input.questionsPath);
  const statuses = await readAnswerStatuses(input.objectivePath, system, input.answersPath);
  const usage = input.powerModel
    ? await readAnswerResourceUsage(input.objectivePath, system, input.answersPath)
    : new Map<string, MeasuredResourceUsage>();
  const energy = input.powerModel ? runEnergyReport(measured, usage, input.powerModel) : undefined;
  const answerable = measured.filter(row => !unanswerable.has(row.questionId));
  const abstentionItems = measured.filter(row => unanswerable.has(row.questionId));
  const asserted = statuses.size ? answerable.filter(row => statuses.get(row.questionId) !== "abstained") : undefined;
  const metrics = {
    // Without per-question status an abstention is indistinguishable from a wrong assertion, so the rate is not
    // guessed; the gate below refuses to pass on a metric it could not compute.
    unsupportedRate: asserted
      ? (asserted.length ? asserted.filter(row => Number(row.exactScore ?? 0) < 1).length / asserted.length : 0)
      : 1,
    exactAnchorAccuracy: answerable.length ? answerable.filter(row => Number(row.exactScore ?? 0) >= 1).length / answerable.length : 0,
    cycleAccuracy: abstentionItems.length
      ? abstentionItems.filter(row => Number(row.exactScore ?? 0) >= 1).length / abstentionItems.length
      : 1
  };
  const thresholds: ReleaseGateThresholds = {
    maxUnsupportedRate: input.thresholds?.maxUnsupportedRate ?? 0.02,
    minExactAnchorAccuracy: input.thresholds?.minExactAnchorAccuracy ?? 0.9,
    minCycleAccuracy: input.thresholds?.minCycleAccuracy ?? 0.98,
    ...(input.thresholds?.classEffect ? { classEffect: input.thresholds.classEffect } : {})
  };

  // One paired record per question the reference also answered: +1 where this system won, -1 where it lost, 0 for a tie.
  const taskClasses = input.taskClassByCategory ?? SEALED_CATEGORY_TASK_CLASSES;
  const referenceByQuestion = new Map(rows.filter(row => row.systemId === reference).map(row => [row.questionId, row]));
  const pairedResults: PairedResultRecord[] = reference
    ? measured.flatMap(row => {
      const rival = referenceByQuestion.get(row.questionId);
      if (!rival) return [];
      const taskFamilyId = taskClasses[categories.get(row.questionId) ?? ""];
      if (!taskFamilyId || !isPreregisteredTaskClassId(taskFamilyId)) return [];
      const value = Math.sign(Number(row.exactScore ?? 0) - Number(rival.exactScore ?? 0));
      return isValidPairedResult(value) ? [{ id: row.questionId, taskFamilyId, value }] : [];
    })
    : [];

  return {
    system,
    ...(reference ? { reference } : {}),
    questions: measured.length,
    answerable: answerable.length,
    abstentionProbes: abstentionItems.length,
    assertedAnswers: asserted?.length ?? null,
    metrics,
    thresholds,
    pairedResults: pairedResults.length,
    ...(energy
      ? {
        energy: {
          answersMeasured: energy.answersMeasured,
          totalJoules: energy.totalJoules,
          meanJoulesPerAnswer: energy.totalJoules / energy.answersMeasured,
          meanEtaSCCE: energy.perAnswer.reduce((sum: number, row: UsefulnessPerJouleResult) => sum + row.etaSCCE, 0) / energy.perAnswer.length,
          weights: SEALED_RUN_USEFULNESS_WEIGHTS
        }
      }
      : {}),
    gate: evaluateReleaseGate(metrics, thresholds, pairedResults.length ? pairedResults : undefined)
  };
}
