// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyVerificationReceipt } from "./verification-receipt.mjs";

test("evaluation distinguishes compiler checks, executed tests, failed and absent evidence", () => {
  const compiler = { schema: "scce.code_mouth_verification.v1", scope: "compiler_only", status: "passed",
    buildSucceeded: true, testsRun: false, testsSucceeded: null };
  const tested = { ...compiler, scope: "executed_tests", testsRun: true, testsSucceeded: true };
  assert.equal(classifyVerificationReceipt(compiler), "compiler_only");
  assert.equal(classifyVerificationReceipt(tested), "executed_tests");
  assert.equal(classifyVerificationReceipt(undefined), "unknown");
  assert.equal(classifyVerificationReceipt({ ...compiler, testsSucceeded: true }), "unknown");
  assert.equal(classifyVerificationReceipt({ ...tested, testsRun: undefined }), "unknown");
  assert.equal(classifyVerificationReceipt({ ...tested, status: "unknown" }), "unknown");
  assert.equal(classifyVerificationReceipt({ ...tested, testsSucceeded: false }), "failed");
  assert.equal(classifyVerificationReceipt({ ...tested, buildSucceeded: false }), "failed");
  assert.equal(classifyVerificationReceipt({ ...tested, status: "failed" }), "failed");
});
