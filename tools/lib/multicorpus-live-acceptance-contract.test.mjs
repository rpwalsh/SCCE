// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceRequestedAuthority, acceptanceTurnInput, compactAcceptanceEvidence, evidenceMatchesSourceBinding } from "./multicorpus-live-acceptance-contract.mjs";

const binding = { sourceId: "source.one", sourceVersionId: "version.one", contentHash: "sha256_source" };

test("automatic corpus requests reach the ordinary transport without a forced authority or answer expectations", () => {
  const testCase = { id: "case.one", corpus: "wikipedia", question: "What is albedo?",
    requestedAuthority: "auto", sourceBindings: [binding], expectedAnswerTerms: ["reflected"] };
  const identity = { sessionId: "session.one", conversationId: "conversation.one" };
  const input = JSON.parse(JSON.stringify(acceptanceTurnInput(testCase, identity)));
  assert.equal(Object.hasOwn(input, "requestedAuthority"), false);
  assert.equal(input.text, testCase.question);
  assert.deepEqual(input.metadata.evaluation.sourceBindings, [binding]);
  assert.equal(JSON.stringify(input).includes("reflected"), false);
  assert.equal(acceptanceTurnInput({ ...testCase, requestedAuthority: "factual" }, identity).requestedAuthority, "factual");
  assert.throws(() => acceptanceRequestedAuthority("unknown"), /requestedAuthority/u);
});

test("a cited chunk binds to its exact source version without comparing unlike hashes", () => {
  const evidence = compactAcceptanceEvidence({
    id: "evidence.one",
    sourceId: binding.sourceId,
    sourceVersionId: binding.sourceVersionId,
    contentHash: "sha256_chunk",
    textPreview: "source evidence"
  });
  assert.equal(evidenceMatchesSourceBinding(evidence, binding), true);
  assert.equal(evidence.contentHash, "sha256_chunk");
  assert.equal(evidence.sourceContentHash, null);
});

test("an explicit source-version hash is enforced when the API supplies it", () => {
  assert.equal(evidenceMatchesSourceBinding({ ...binding, sourceContentHash: binding.contentHash }, binding), true);
  assert.equal(evidenceMatchesSourceBinding({ ...binding, sourceContentHash: "sha256_other" }, binding), false);
  assert.equal(evidenceMatchesSourceBinding({ ...binding, sourceVersionId: "version.other" }, binding), false);
  assert.equal(evidenceMatchesSourceBinding({ ...binding, sourceId: "source.other" }, binding), false);
});
