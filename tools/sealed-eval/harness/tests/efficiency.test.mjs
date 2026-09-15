import test from "node:test";
import assert from "node:assert/strict";
import { efficiencyReport } from "../lib/efficiency.mjs";

function fixture() {
  const questions = [
    { questionId: "q1", category: "answer", gold: { acceptedAnswers: ["Aster"] } },
    { questionId: "q2", category: "answer", gold: { acceptedAnswers: ["Birch"] } },
    { questionId: "q3", category: "abstention", gold: { unanswerable: true } }
  ];
  const identity = { runId: "r", systemId: "s", conditionId: "cpu" };
  const answers = [
    { ...identity, questionId: "q1", attempt: 1, status: "ok", answer: "Aster", observedElapsedMs: 1000 },
    { ...identity, questionId: "q2", attempt: 1, status: "timeout", answer: "Birch", observedElapsedMs: 5000 },
    { ...identity, questionId: "q3", attempt: 1, status: "abstained", answer: "", observedElapsedMs: 2000 }
  ];
  const measurements = [{ ...identity, expectedQuestionCount: 3, wallElapsedMs: 10000, inputHashes: { questions: "hash" }, energy: { status: "measured", joules: 100, averageWatts: 10 } }];
  return { answers, questions, measurements, questionsSha256: "hash" };
}

test("useful work excludes failures while their time and energy stay in denominators", () => {
  const result = efficiencyReport(fixture()).systems[0];
  assert.equal(result.correctTaskCount, 2);
  assert.equal(result.accuracy, 2 / 3);
  assert.equal(result.correctTasksPerSecond, 0.2);
  assert.equal(result.correctTasksPerKilojoule, 20);
  assert.equal(result.joulesPerCorrectTask, 50);
  assert.equal(result.correctTasksPerSecondPerWatt, 0.02);
});

test("absent energy is unavailable, never zero or infinite efficiency", () => {
  const input = fixture();
  input.measurements[0].energy = { status: "unavailable", reason: "sensor-missing", joules: null };
  const result = efficiencyReport(input).systems[0];
  assert.equal(result.joules, null);
  assert.equal(result.correctTasksPerKilojoule, null);
  assert.equal(result.correctTasksPerSecond, 0.2);
});

test("dropping or duplicating failed tasks invalidates the report", () => {
  for (const mutate of [rows => rows.splice(1, 1), rows => rows.push({ ...rows[0] })]) {
    const input = fixture();
    mutate(input.answers);
    const result = efficiencyReport(input).systems[0];
    assert.equal(result.status, "invalid");
    assert.equal(result.correctTasksPerKilojoule, null);
  }
});

test("scoring different questions cannot inherit a measured energy budget", () => {
  const input = fixture();
  input.questionsSha256 = "different";
  assert.throws(() => efficiencyReport(input), /input hash/);
});
