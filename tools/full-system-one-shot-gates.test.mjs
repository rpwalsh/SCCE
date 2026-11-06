// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import test from "node:test";
import assert from "node:assert/strict";
import { validAbstention } from "./full-system-one-shot-gates.mjs";

const unsupported = (overrides = {}) => ({
  answer: "",
  evidenceCount: 0,
  force: "unknown",
  assistantForce: "insufficient_support",
  realizationAvailability: { status: "insufficient_support" },
  ...overrides
});

test("accepts empty, zero-evidence, typed insufficient-support abstention", () => {
  assert.equal(validAbstention(unsupported()), true);
});

test("rejects echoed and assertive answer text even when metadata says insufficient", () => {
  assert.equal(validAbstention(unsupported({ answer: "been sold" })), false);
  assert.equal(validAbstention(unsupported({ answer: "author animalia" })), false);
});

test("rejects untyped, unavailable and fake clarification surfaces", () => {
  assert.equal(validAbstention(unsupported({ assistantForce: undefined })), false);
  assert.equal(validAbstention(unsupported({ realizationAvailability: { status: "realization_unavailable" } })), false);
  assert.equal(validAbstention(unsupported({ answer: "Could you clarify?", selectedSurfaceId: "candidate:generated:clarification:fake" })), false);
});

test("accepts an exact typed withheld envelope only with no answer and no evidence", () => {
  const input = unsupported({
    assistantForce: undefined,
    realizationAvailability: undefined,
    withheld: { schema: "scce.runtime.withheld_surface.v1", evidenceCount: 0, epistemicForce: "unknown", reasonId: "insufficient_evidence" }
  });
  assert.equal(validAbstention(input), true);
  assert.equal(validAbstention({ ...input, answer: "I do not know." }), false);
});
