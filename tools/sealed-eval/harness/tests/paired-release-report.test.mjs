import test from "node:test";import assert from "node:assert/strict";import { mkdtemp } from "node:fs/promises";import os from "node:os";import path from "node:path";
import { writeJsonl } from "../lib/util.mjs";import { pairedReleaseReport } from "../paired-release-report.mjs";

// Three answerable questions and one abstention probe. The subject declines
// two answerable ones, asserts one correctly, and correctly declines the probe.
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prr-"));
  const questions = [
    { questionId: "a1", category: "cloze", gold: { unanswerable: false } },
    { questionId: "a2", category: "cloze", gold: { unanswerable: false } },
    { questionId: "a3", category: "cloze", gold: { unanswerable: false } },
    { questionId: "u1", category: "unanswerable", gold: { unanswerable: true } }
  ];
  const objective = [
    { systemId: "scce", questionId: "a1", exactScore: 1, coherent: true },
    { systemId: "scce", questionId: "a2", exactScore: 0, coherent: false },
    { systemId: "scce", questionId: "a3", exactScore: 0, coherent: false },
    { systemId: "scce", questionId: "u1", exactScore: 1, coherent: true }
  ];
  const answers = [
    { systemId: "scce", questionId: "a1", status: "ok", answer: "right" },
    { systemId: "scce", questionId: "a2", status: "abstained", answer: "" },
    { systemId: "scce", questionId: "a3", status: "abstained", answer: "" },
    { systemId: "scce", questionId: "u1", status: "abstained", answer: "" }
  ];
  await writeJsonl(path.join(dir, "questions.jsonl"), questions);
  await writeJsonl(path.join(dir, "objective.jsonl"), objective);
  await writeJsonl(path.join(dir, "answers.jsonl"), answers);
  return dir;
}

// The 2026-08-18 rerun reported unsupportedRate 100% for a system that
// asserted nothing at all: 159 of its 160 zero-scored answerable items were
// abstentions, which the metric's own definition excludes. Counting a decline
// as an unsupported assertion inverts the property the gate exists to protect.
test("abstentions are excluded from unsupportedRate", async () => {
  const dir = await fixture();
  const report = pairedReleaseReport({
    objectivePath: path.join(dir, "objective.jsonl"),
    questionsPath: path.join(dir, "questions.jsonl"),
    answersPath: path.join(dir, "answers.jsonl"),
    systemId: "scce",
    referenceSystemId: "reference.bm25"
  });
  // One assertion (a1), and it was correct -- so nothing unsupported.
  assert.equal(report.assertedCount, 1);
  assert.equal(report.abstainedOnAnswerable, 2);
  assert.equal(report.metrics.unsupportedRate, 0);
  // Declining an answerable item still costs accuracy; it just is not a
  // fabrication. Both facts have to survive independently.
  assert.equal(report.metrics.exactAnchorAccuracy, 1 / 3);
  assert.equal(report.metrics.cycleAccuracy, 1);
});

test("a wrong assertion does count as unsupported", async () => {
  const dir = await fixture();
  const answers = [
    { systemId: "scce", questionId: "a1", status: "ok", answer: "right" },
    { systemId: "scce", questionId: "a2", status: "ok", answer: "wrong" },
    { systemId: "scce", questionId: "a3", status: "abstained", answer: "" },
    { systemId: "scce", questionId: "u1", status: "abstained", answer: "" }
  ];
  await writeJsonl(path.join(dir, "answers.jsonl"), answers);
  const report = pairedReleaseReport({
    objectivePath: path.join(dir, "objective.jsonl"),
    questionsPath: path.join(dir, "questions.jsonl"),
    answersPath: path.join(dir, "answers.jsonl"),
    systemId: "scce",
    referenceSystemId: "reference.bm25"
  });
  assert.equal(report.assertedCount, 2);
  assert.equal(report.metrics.unsupportedRate, 0.5);
});

// A metric that could not be computed must never be scored as a pass.
test("without statuses the metric is unavailable and the gate is not evaluated", async () => {
  const dir = await fixture();
  const report = pairedReleaseReport({
    objectivePath: path.join(dir, "objective.jsonl"),
    questionsPath: path.join(dir, "questions.jsonl"),
    systemId: "scce",
    referenceSystemId: "reference.bm25"
  });
  assert.equal(report.metrics.unsupportedRate, null);
  assert.equal(report.gate.passed, false);
  assert.equal(report.gate.notEvaluated, true);
});
