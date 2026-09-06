// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluationReleaseGate } from "../evaluation-gate-runner.js";

async function sealedRun(
  rows: Record<string, unknown>[],
  questions: Record<string, unknown>[],
  answers: Record<string, unknown>[] = []
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "scce-gate-"));
  const objectivePath = path.join(directory, "objective.jsonl");
  await writeFile(objectivePath, rows.map(row => JSON.stringify(row)).join("\n"), "utf8");
  await writeFile(path.join(directory, "questions.jsonl"), questions.map(row => JSON.stringify(row)).join("\n"), "utf8");
  if (answers.length) {
    await writeFile(path.join(directory, "raw-answers.jsonl"), answers.map(row => JSON.stringify(row)).join("\n"), "utf8");
  }
  return objectivePath;
}

const cloze = (id: string) => ({ questionId: id, category: "cloze", gold: { unanswerable: false } });
const probe = (id: string) => ({ questionId: id, category: "unanswerable", gold: { unanswerable: true } });

describe("evaluation release gate runner", () => {
  it("measures the system under test against its baseline and fails on a real unsupported answer", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1 },
        { questionId: "q2", systemId: "scce", exactScore: 0 },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 0 },
        { questionId: "q2", systemId: "reference.bm25", exactScore: 0 }
      ],
      [cloze("q1"), cloze("q2")],
      [
        { questionId: "q1", systemId: "scce", status: "ok" },
        { questionId: "q2", systemId: "scce", status: "ok" }
      ]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.system).toBe("scce");
    expect(report.reference).toBe("reference.bm25");
    expect(report.assertedAnswers).toBe(2);
    // One of the two asserted answers was wrong: that is what the unsupported rate measures.
    expect(report.metrics.unsupportedRate).toBe(0.5);
    expect(report.pairedResults).toBe(2);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures.map(failure => failure.id)).toContain("unsupported_rate");
  });

  it("does not charge an abstention as an unsupported answer, and scores abstention correctness separately", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1 },
        { questionId: "q2", systemId: "scce", exactScore: 0 },
        { questionId: "p1", systemId: "scce", exactScore: 1 },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 1 },
        { questionId: "q2", systemId: "reference.bm25", exactScore: 1 },
        { questionId: "p1", systemId: "reference.bm25", exactScore: 0 }
      ],
      [cloze("q1"), cloze("q2"), probe("p1")],
      [
        { questionId: "q1", systemId: "scce", status: "ok" },
        { questionId: "q2", systemId: "scce", status: "abstained" },
        { questionId: "p1", systemId: "scce", status: "abstained" }
      ]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.answerable).toBe(2);
    expect(report.abstentionProbes).toBe(1);
    expect(report.assertedAnswers).toBe(1);
    expect(report.metrics.unsupportedRate).toBe(0);
    expect(report.metrics.exactAnchorAccuracy).toBe(0.5);
    expect(report.metrics.cycleAccuracy).toBe(1);
  });

  it("fails closed when no per-question status can tell an abstention from a wrong answer", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1 },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 0 }
      ],
      [cloze("q1")]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.assertedAnswers).toBeNull();
    expect(report.metrics.unsupportedRate).toBe(1);
    expect(report.gate.passed).toBe(false);
  });

  it("passes a clean run and carries the paired class effect the preregistered classes declare", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `q${index}`);
    const objectivePath = await sealedRun(
      ids.flatMap(id => [
        { questionId: id, systemId: "scce", exactScore: 1 },
        { questionId: id, systemId: "reference.bm25", exactScore: 0 }
      ]),
      ids.map(cloze),
      ids.map(id => ({ questionId: id, systemId: "scce", status: "ok" }))
    );

    const report = await runEvaluationReleaseGate({
      objectivePath,
      thresholds: {
        classEffect: { alpha: 0.05, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 200, randomSource: () => 0.5 } }
      }
    });

    expect(report.metrics.unsupportedRate).toBe(0);
    expect(report.gate.passed).toBe(true);
    expect(report.gate.classEffects?.map(effect => effect.taskFamilyId)).toEqual(["factual_qa"]);
    expect(report.gate.classEffects?.[0]?.meanEffect).toBe(1);
  });

  it("refuses question categories that name no preregistered task class rather than inventing one", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1 },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 0 }
      ],
      [{ questionId: "q1", category: "improvised", gold: { unanswerable: false } }],
      [{ questionId: "q1", systemId: "scce", status: "ok" }]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.pairedResults).toBe(0);
    expect(report.gate.classEffects).toBeUndefined();
  });
});
