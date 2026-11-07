// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { artifactChecks, executeHeldOut, httpFailureDetail, isSafeHeldOutRoot } from "./coding-spine-acceptance.mjs";

const artifact = (path, content, role = "source") => ({
  path, role, content, contentHash: `sha256_${createHash("sha256").update(content).digest("hex")}`
});
const program = (content, sourcePath = "src/program.mjs") => ({
  programReadiness: { status: "ready" },
  programArtifacts: [artifact(sourcePath, content), artifact("test/program.test.mjs", "export {};", "test")]
});
const correct = `export function uniqueStrings(values) { return [...new Set(values)]; }`;

test("accepts an intact source and test artifact set", () => {
  assert.equal(artifactChecks(program(correct)).passed, true);
});

test("rejects a changed artifact whose content hash was not updated", () => {
  const input = program(correct);
  input.programArtifacts[0].content += "\n// tampered";
  assert.equal(artifactChecks(input).checks.contentHashes, false);
  assert.equal(artifactChecks(input).passed, false);
});

test("rejects duplicate artifact paths", () => {
  const input = program(correct);
  input.programArtifacts.push({ ...input.programArtifacts[0] });
  assert.equal(artifactChecks(input).checks.uniquePaths, false);
});

test("rejects normalized aliases, case-only collisions, ambiguous sources, and held-out filename collisions", () => {
  const aliases = program(correct);
  aliases.programArtifacts.push(artifact("src/./program.mjs", correct));
  assert.equal(artifactChecks(aliases).checks.uniquePaths, false);
  const caseCollision = program(correct);
  caseCollision.programArtifacts.push(artifact("SRC/PROGRAM.MJS", correct));
  assert.equal(artifactChecks(caseCollision).checks.uniquePaths, false);
  const ambiguous = program(correct);
  ambiguous.programArtifacts.push(artifact("src/other.mjs", correct));
  assert.equal(artifactChecks(ambiguous).checks.sourceUnambiguous, false);
  const collision = program(correct);
  collision.programArtifacts.push(artifact("__scce_acceptance_held_out__.mjs", "export {};", "test"));
  assert.equal(artifactChecks(collision).checks.uniquePaths, false);
});

test("rejects drive, UNC, and traversal paths independent of host platform", () => {
  for (const path of ["C:\\outside.mjs", "\\\\server\\share\\outside.mjs", "//server/share/outside.mjs", "../outside.mjs", "src/../../outside.mjs"]) {
    const input = { programArtifacts: [artifact(path, correct)] };
    assert.equal(artifactChecks(input).checks.uniquePaths, false, path);
  }
});

test("requires a source role rather than accepting a mislabeled target", () => {
  const input = { programArtifacts: [artifact("src/program.mjs", correct, "test"), artifact("test/program.test.mjs", "export {};", "test")] };
  assert.equal(artifactChecks(input).checks.sourcePresent, false);
  assert.equal(artifactChecks(input).passed, false);
});

test("fails closed when returned source language does not match the requested language", () => {
  assert.equal(artifactChecks(program(correct), "typescript").checks.languageMatches, false);
  const source = `export function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }`;
  assert.equal(artifactChecks(program(source, "src/program.ts"), "typescript").passed, true);
  assert.equal(artifactChecks(program(source, "src/program.ts"), "javascript").checks.languageMatches, false);
});

test("only allows cleanup of a direct child created under the OS temp directory", () => {
  assert.equal(isSafeHeldOutRoot("C:\\Temp\\scce-coding-heldout-a1", "C:\\Temp"), true);
  assert.equal(isSafeHeldOutRoot("C:\\scce-coding-heldout-a1", "C:\\Temp"), false);
  assert.equal(isSafeHeldOutRoot("C:\\Temp\\..\\outside", "C:\\Temp"), false);
});

test("retains bounded structured HTTP failure details without copying arbitrary response fields", () => {
  assert.deepEqual(httpFailureDetail({ status: 422, error: "runtime.declined.program_not_ready",
    detail: { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.behavior_contract_missing", token: "discard" },
    secret: "discard" }, "", 422), {
    status: 422, error: "runtime.declined.program_not_ready",
    detail: { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.behavior_contract_missing" }
  });
  assert.deepEqual(httpFailureDetail(undefined, "unprocessable request", 422), { status: 422, bodyText: "unprocessable request" });
  assert.deepEqual(httpFailureDetail({ message: "x".repeat(1200) }).message.length, 1000);
});

test("independently executes correct behavior and rejects semantically wrong code", async () => {
  assert.equal((await executeHeldOut(program(correct))).passed, true);
  const wrong = `export function uniqueStrings(values) { return values; }`;
  assert.equal((await executeHeldOut(program(wrong))).passed, false);
});

test("independently executes returned TypeScript on held-out inputs", async () => {
  const source = `export function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }`;
  assert.equal((await executeHeldOut(program(source, "src/program.ts"), "typescript")).passed, true);
});
