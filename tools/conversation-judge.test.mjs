import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { declinePrefix, judgeTurns } from "./conversation-judge.mjs";

test("the recorded 2026-09-13 chat probe is not healthy on any turn", () => {
  const recorded = JSON.parse(readFileSync(new URL("../artifacts/conversation-probe.json", import.meta.url), "utf8"));
  const verdicts = judgeTurns(recorded.rows, { declinePrefix: declinePrefix() });
  assert.equal(verdicts.filter(v => v.healthy).length, 0);
  assert.equal(verdicts.filter(v => v.repeatsEarlierAnswer).length, recorded.rows.length - 1);
});

test("distinct plain answers are healthy and declines are counted", () => {
  const prefix = declinePrefix();
  assert.ok(prefix);
  const verdicts = judgeTurns([
    { text: "a", status: 200, answer: "first reply" },
    { text: "b", status: 200, answer: "second reply" },
    { text: "c", status: 200, answer: `${prefix} c.` },
    { text: "d", status: 200, answer: "second reply" }
  ], { declinePrefix: prefix });
  assert.deepEqual(verdicts.map(v => v.healthy), [true, true, false, false]);
  assert.equal(verdicts[2].declined, true);
  assert.equal(verdicts[3].repeatsEarlierAnswer, true);
});
