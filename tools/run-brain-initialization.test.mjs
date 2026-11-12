// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { brainInitializationUsage, classifyInitializationAttempt, parseSupervisorArguments } from "./run-brain-initialization.mjs";

test("the supervisor publishes a blind-run usage contract", () => {
  const usage = brainInitializationUsage();
  assert.match(usage, /--fresh-config/u);
  assert.match(usage, /--output-config/u);
  assert.match(usage, /--checkpoint-smoke-out/u);
  assert.match(usage, /owns --resume/u);
});

test("the initialization supervisor owns resume and preserves builder arguments", () => {
  const parsed = parseSupervisorArguments([
    "--fresh-config", ".scce/brain.json", "--receipt", ".scce/receipt.json", "--target-bytes", "2000000000",
    "--node-heap-mb", "6144", "--max-restarts", "7", "--checkpoint-smoke-out", ".scce/smoke.json"
  ], "C:/workspace/scce");
  assert.equal(parsed.nodeHeapMb, 6144);
  assert.equal(parsed.maxRestarts, 7);
  assert.equal(parsed.checkpointSmokeOut, "C:\\workspace\\scce\\.scce\\smoke.json");
  assert.equal(parsed.statePath, "C:\\workspace\\scce\\.scce\\brain.json.build-state.json");
  assert.deepEqual(parsed.builderArgs.slice(-2), ["--heap-checkpoint-mb", "5222"]);
  assert.deepEqual(parsed.builderArgs.slice(4, 6), ["--target-bytes", "2000000000"]);
  assert.throws(() => parseSupervisorArguments([
    "--fresh-config", ".scce/brain.json", "--receipt", ".scce/receipt.json", "--resume"
  ]), /owns --resume/u);
});

test("the heap safety checkpoint must fit below the supervised Node heap", () => {
  const parsed = parseSupervisorArguments([
    "--fresh-config", ".scce/brain.json", "--receipt", ".scce/receipt.json",
    "--node-heap-mb", "6144", "--heap-checkpoint-mb", "5000"
  ], "C:/workspace/scce");
  assert.equal(parsed.builderArgs.at(-1), "5000");
  assert.throws(() => parseSupervisorArguments([
    "--fresh-config", ".scce/brain.json", "--receipt", ".scce/receipt.json",
    "--node-heap-mb", "6144", "--heap-checkpoint-mb", "7168"
  ]), /must be smaller/u);
});

test("the supervisor retries only unfinished states without durable SCCE failures", () => {
  assert.deepEqual(classifyInitializationAttempt({ state: { status: "complete" }, exitCode: 0 }),
    { action: "complete", reason: "brain_complete" });
  assert.deepEqual(classifyInitializationAttempt({ state: { status: "building" }, exitCode: 1 }),
    { action: "retry", reason: "external_exit:1" });
  assert.deepEqual(classifyInitializationAttempt({ state: { status: "building", lastFailure: { message: "bad source" } }, exitCode: 1 }),
    { action: "fail", reason: "durable_sccE_failure" });
  assert.deepEqual(classifyInitializationAttempt({ state: { status: "building" }, exitCode: 1, stoppedByUser: true }),
    { action: "stop", reason: "user_interrupt" });
});
