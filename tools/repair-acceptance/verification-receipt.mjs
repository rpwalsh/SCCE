// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export function classifyVerificationReceipt(receipt) {
  if (!receipt || receipt.schema !== "scce.code_mouth_verification.v1") return "unknown";
  if (receipt.status === "failed" || receipt.buildSucceeded === false || (receipt.testsRun === true && receipt.testsSucceeded === false)) return "failed";
  if (receipt.status !== "passed" || receipt.buildSucceeded !== true) return "unknown";
  if (receipt.scope === "compiler_only" && receipt.testsRun === false && receipt.testsSucceeded === null) return "compiler_only";
  if (receipt.scope === "executed_tests" && receipt.testsRun === true && receipt.testsSucceeded === true) return "executed_tests";
  return "unknown";
}
