// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluationReleaseGate } from "../evaluation-gate-runner.js";

async function sealedRun(rows: Record<string, unknown>[], questions: Record<string, unknown>[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "scce-gate-"));
  const objectivePath = path.join(directory, "objective.jsonl");
  await writeFile(objectivePath, rows.map(row => JSON.stringify(row)).join("\n"), "utf8");
  await writeFile(path.join(directory, "questions.jsonl"), questions.map(row => JSON.stringify(row)).join("\n"), "utf8");
  return objectivePath;
}

describe("evaluation release gate runner", () => {
  it("measures the system under test against its baseline and fails on real unsupported answers", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1, coherent: true },
        { questionId: "q2", systemId: "scce", exactScore: 0, forbiddenHits: 1, coherent: true },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 0, coherent: true },
        { questionId: "q2", systemId: "reference.bm25", exactScore: 0, coherent: true }
      ],
      [
        { questionId: "q1", category: "cloze" },
        { questionId: "q2", category: "cloze" }
      ]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.system).toBe("scce");
    expect(report.reference).toBe("reference.bm25");
    expect(report.metrics.unsupportedRate).toBe(0.5);
    expect(report.pairedResults).toBe(2);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures.map(failure => failure.id)).toContain("unsupported_rate");
  });

  it("passes a clean run and carries the paired class effect the preregistered classes declare", async () => {
    const objectivePath = await sealedRun(
      Array.from({ length: 20 }, (_, index) => index).flatMap(index => [
        { questionId: `q${index}`, systemId: "scce", exactScore: 1, coherent: true },
        { questionId: `q${index}`, systemId: "reference.bm25", exactScore: 0, coherent: true }
      ]),
      Array.from({ length: 20 }, (_, index) => ({ questionId: `q${index}`, category: "cloze" }))
    );

    const report = await runEvaluationReleaseGate({
      objectivePath,
      thresholds: { classEffect: { alpha: 0.05, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 200, randomSource: () => 0.5 } } }
    });

    expect(report.gate.passed).toBe(true);
    expect(report.gate.classEffects?.map(effect => effect.taskFamilyId)).toEqual(["factual_qa"]);
    expect(report.gate.classEffects?.[0]?.meanEffect).toBe(1);
  });

  it("refuses question categories that name no preregistered task class rather than inventing one", async () => {
    const objectivePath = await sealedRun(
      [
        { questionId: "q1", systemId: "scce", exactScore: 1, coherent: true },
        { questionId: "q1", systemId: "reference.bm25", exactScore: 0, coherent: true }
      ],
      [{ questionId: "q1", category: "improvised" }]
    );

    const report = await runEvaluationReleaseGate({ objectivePath });

    expect(report.pairedResults).toBe(0);
    expect(report.gate.classEffects).toBeUndefined();
  });
});
