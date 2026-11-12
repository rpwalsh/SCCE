// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { compactAcceptanceEvidence, evidenceMatchesSourceBinding } from "./multicorpus-live-acceptance-contract.mjs";

const binding = { sourceId: "source.one", sourceVersionId: "version.one", contentHash: "sha256_source" };

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
