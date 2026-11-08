import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const questionBytes = read("./questions.jsonl");
const lines = questionBytes.toString("utf8").trimEnd().split(/\r?\n/u);
const questions = lines.map(line => JSON.parse(line));
const prereg = JSON.parse(read("./preregistration.json"));
const matrix = prereg.caseMatrix;

test("frozen capability matrix uses the existing sealed-eval question contract and exact case index", () => {
  assert.equal(prereg.schemaVersion, "1.0");
  assert.equal(matrix.status, "frozen_not_executed");
  assert.equal(matrix.caseCount, 14);
  assert.equal(matrix.questionCount, 12);
  assert.equal(matrix.repairCount, 2);
  assert.equal(questions.length, 12);
  assert.equal(matrix.questionFileSha256, digest(questionBytes));
  assert.equal(new Set(questions.map(row => row.questionId)).size, 12);
  for (const question of questions) {
    assert.equal(question.schemaVersion, "1.0");
    assert.ok(question.questionId && question.category && question.prompt);
    assert.ok(["chat", "creative", "factual"].includes(question.category));
    assert.equal(typeof question.protectedMetadata?.split, "string");
  }
  assert.equal(matrix.repairs.length + questions.length, matrix.caseCount);
});

test("question metadata pins its exact line hash and source prerequisites without exposing them to runtime", () => {
  assert.equal(matrix.questions.length, questions.length);
  for (let i = 0; i < questions.length; i++) {
    assert.equal(matrix.questions[i].id, questions[i].questionId);
    assert.equal(matrix.questions[i].sha256, digest(Buffer.from(`${lines[i]}\n`, "utf8")));
    assert.ok(questions[i].protectedMetadata);
  }
});

test("only corpus-verified factual controls can earn abstention credit", () => {
  const factual = questions.filter(row => row.category === "factual");
  assert.equal(factual.length, 6);
  assert.equal(factual.filter(row => row.gold?.unanswerable === false).length, 4);
  assert.equal(factual.filter(row => row.gold?.unanswerable === true).length, 2);
  for (const row of factual.filter(row => row.gold.unanswerable)) {
    assert.match(row.protectedMetadata.sourcePrerequisite, /absent/iu);
  }
  for (const row of questions.filter(row => ["chat", "creative"].includes(row.category))) {
    assert.notEqual(row.gold?.unanswerable, true);
  }
});

test("known creative declines remain required-completion failures, never abstention wins", () => {
  const failures = questions.filter(row => row.protectedMetadata?.declineIsFailure === true);
  assert.equal(failures.length, 2);
  for (const row of failures) {
    assert.equal(row.protectedMetadata.baselineHttpStatus, 422);
    assert.equal(row.protectedMetadata.taskCompletionRequired, true);
    assert.equal(row.gold?.unanswerable, undefined);
  }
});

test("chat follow-ups are test-authored development prompts over source-seen material, not independent holdouts", () => {
  const chat = questions.filter(row => row.category === "chat");
  assert.equal(chat.length, 2);
  for (const row of chat) {
    assert.equal(row.protectedMetadata.split, "development_test_authored_prompt_source_seen");
    assert.match(row.protectedMetadata.promptAuthorship, /test-authored development follow-up prompt/u);
    assert.match(row.protectedMetadata.promptAuthorship, /not an independent holdout/u);
    assert.match(row.protectedMetadata.grading, /test-authored development prompt/u);
    assert.doesNotMatch(row.protectedMetadata.split, /heldout/iu);
  }
  assert.match(prereg.categories.find(row => row.id === "chat").grading, /not independent holdout cases/u);
});

test("Go repair case follows the existing repair-integrity case shape and pins real source bytes", () => {
  const c = JSON.parse(readFileSync(new URL("../repair-acceptance/cases/human-go-fma/case.json", import.meta.url), "utf8"));
  assert.equal(c.schema, "scce.repair_integrity_case.v1");
  assert.equal(c.source.languageProfileId, "language_profile_55234169888c05b93727fa655a0656d2133c769fd0fabccb");
  assert.equal(c.source.capturedBytes, 602);
  assert.equal(c.source.path, "cmd/compile/internal/ssa/testdata/fma.go");
  assert.equal(c.source.stagedTargetPath, "fma.go");
  assert.match(c.source.pathBasis, /Installed source path verified/u);
  assert.match(c.source.capturedSha256, /^[0-9a-f]{64}$/u);
  assert.equal(c.mutation.from, "inlineFma");
  assert.equal(c.mutation.to, "inlineFmaa");
  assert.ok(c.intendedBehavior.length >= 2);
  assert.ok(c.preservedBehavior.length >= 2);
  const bytes = readFileSync(new URL("../repair-acceptance/cases/human-go-fma/case.json", import.meta.url));
  assert.equal(matrix.repairs[0].artifactSha256, digest(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8")));
});

test("TypeScript repair references the existing source-hashed integrity case rather than test-authored apps", () => {
  const c = JSON.parse(readFileSync(new URL("../repair-acceptance/cases/map-write-loss/case.json", import.meta.url), "utf8"));
  assert.equal(c.schema, "scce.repair_integrity_case.v1");
  assert.equal(c.source.capturedSha256, "53fc4b0f46e31a55e0d1ed45f5bde54b4b5ef9b0fcae514043fa2d4205562f52");
  assert.equal(c.mutation.from, "byFamily.set(record.taskFamilyId, bucket)");
  assert.equal(c.mutation.harmfulTo, "byFamily.get(record.taskFamilyId)");
  assert.ok(c.intendedBehavior.length > 0);
  assert.ok(c.preservedBehavior.length > 0);
  const bytes = readFileSync(new URL("../repair-acceptance/cases/map-write-loss/case.json", import.meta.url));
  assert.equal(matrix.repairs[1].artifactSha256, digest(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8")));
});
