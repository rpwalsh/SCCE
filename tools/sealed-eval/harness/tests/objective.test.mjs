import test from "node:test";
import assert from "node:assert/strict";
import { objectiveScores } from "../lib/objective.mjs";

const score = (gold, answer, status = "ok") => objectiveScores(
  [{ questionId: "q", status, answer }], [{ questionId: "q", gold }]
)[0];

test("accepted-answer-only questions cannot pass through an empty required-string list", () => {
  const gold = { acceptedAnswers: ["Aster"], requiredStrings: [] };
  assert.equal(score(gold, "Birch").exactScore, 0);
  assert.equal(score(gold, "").exactScore, 0);
  assert.equal(score(gold, "Aster").exactScore, 1);
});

test("timeouts, crashes and abstentions cannot earn work for answerable tasks", () => {
  for (const status of ["timeout", "crash", "error", "malformed", "abstained"])
    assert.equal(score({ requiredStrings: ["Aster"] }, "Aster", status).exactScore, 0);
  assert.equal(score({ unanswerable: true }, "Insufficient evidence", "error").exactScore, 0);
  assert.equal(score({ unanswerable: true }, "", "abstained").exactScore, 1);
});

test("an abstention status cannot turn arbitrary output into useful work", () => {
  assert.equal(score({ unanswerable: true }, "fabricated answer", "abstained").exactScore, 0);
  assert.equal(score({ unanswerable: true }, "Insufficient evidence.", "abstained").exactScore, 1);
});

test("blank gold strings do not automatically score an answer correct", () => {
  assert.equal(score({ acceptedAnswers: ["", "Aster"] }, "Birch").exactScore, 0);
  assert.equal(score({ requiredStrings: [" ", "Aster"] }, "Aster").exactScore, 1);
});

test("required and forbidden strings retain their existing objective meaning", () => {
  const gold = { requiredStrings: ["Aster", "Birch"], forbiddenStrings: ["Cedar"] };
  assert.equal(score(gold, "Aster Birch").exactScore, 1);
  assert.equal(score(gold, "Aster").exactScore, 0);
  assert.equal(score(gold, "Aster Birch Cedar").exactScore, 0);
  assert.equal(score({ acceptedAnswers: ["not supported"] }, "not supported").exactScore, 1);
});
