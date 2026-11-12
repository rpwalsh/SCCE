// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { selectCheckpointCases } from "./checkpoint-corpus-smoke.mjs";

const cases = ["wikipedia", "gutenberg", "dolly", "code", "openassistant"].map(corpus => ({
  id: `${corpus}.one`, corpus, question: "What does this source say?", sourceBindings: [{ sourceId: "s", sourceVersionId: "v", contentHash: "h" }]
}));

test("English checkpoint smoke selects one case only for admitted English-scope corpora", () => {
  const receipt = { status: "complete", selection: { englishOnly: true },
    lanes: { wikipedia: { included: true }, gutenberg: { included: true }, dolly: { included: true }, code: { included: true }, oasst: { included: true } },
    acceptanceCases: cases };
  assert.deepEqual(selectCheckpointCases(receipt).map(item => item.corpus), ["wikipedia", "gutenberg", "dolly", "code"]);
  assert.deepEqual(selectCheckpointCases(receipt, ["wikipedia", "openassistant"]).map(item => item.corpus), ["wikipedia", "openassistant"]);
});

test("checkpoint smoke cannot silently omit a requested admitted corpus case", () => {
  const receipt = { status: "complete", lanes: { wikipedia: { included: true } }, acceptanceCases: [] };
  assert.throws(() => selectCheckpointCases(receipt, ["wikipedia"]), /no source-bound acceptance case/u);
});
