// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateReleaseGate,
  isPreregisteredTaskClassId,
  isValidPairedResult,
  type PairedResultRecord,
  type ReleaseGateResult,
  type ReleaseGateThresholds
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
    gate: evaluateReleaseGate(metrics, thresholds, pairedResults.length ? pairedResults : undefined)
  };
}
