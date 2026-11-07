// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { artifactChecks, executeHeldOut } from "./coding-spine-acceptance.mjs";

const artifact = (path, content, role = "source") => ({
  path, role, content, contentHash: `sha256_${createHash("sha256").update(content).digest("hex")}`
});
const program = content => ({ programArtifacts: [artifact("src/program.mjs", content), artifact("test/program.test.mjs", "export {};", "test")] });
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

test("independently executes correct behavior and rejects semantically wrong code", async () => {
  assert.equal((await executeHeldOut(program(correct))).passed, true);
  const wrong = `export function uniqueStrings(values) { return values; }`;
  assert.equal((await executeHeldOut(program(wrong))).passed, false);
});
