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

export interface EvaluationGateReport {
  system: string;
  reference?: string;
  questions: number;
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

  const unsupported = measured.filter(row => (row.forbiddenHits ?? 0) > 0 || row.abstentionCorrect === false).length;
  const exactAnchor = measured.filter(row => Number(row.exactScore ?? 0) >= 1).length;
  const coherent = measured.filter(row => row.coherent !== false).length;
  const metrics = {
    unsupportedRate: unsupported / measured.length,
    exactAnchorAccuracy: exactAnchor / measured.length,
    cycleAccuracy: coherent / measured.length
  };
  const thresholds: ReleaseGateThresholds = {
    maxUnsupportedRate: input.thresholds?.maxUnsupportedRate ?? 0.02,
    minExactAnchorAccuracy: input.thresholds?.minExactAnchorAccuracy ?? 0.9,
    minCycleAccuracy: input.thresholds?.minCycleAccuracy ?? 0.98,
    ...(input.thresholds?.classEffect ? { classEffect: input.thresholds.classEffect } : {})
  };

  // One paired record per question the reference also answered: +1 where this system won, -1 where it lost, 0 for a tie.
  const categories = await readQuestionCategories(input.objectivePath, input.questionsPath);
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
    metrics,
    thresholds,
    pairedResults: pairedResults.length,
    gate: evaluateReleaseGate(metrics, thresholds, pairedResults.length ? pairedResults : undefined)
  };
}
