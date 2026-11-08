// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireCoreferenceSources, validatePinnedArtifact } from "./acquire-sources.mjs";

test("pinned cache data cannot substitute changed bytes or changed Git ownership", () => {
  const bytes = Buffer.from("test-authored acquisition integrity control");
  const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlobSha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
  validatePinnedArtifact(bytes, pin);
  assert.throws(() => validatePinnedArtifact(Buffer.from(bytes.toString().replace("test", "fake")), pin), /Git blob/u);
  assert.throws(() => validatePinnedArtifact(bytes, { ...pin, sha256: "wrong" }), /SHA-256/u);
  assert.throws(() => validatePinnedArtifact(bytes.subarray(1), pin), /byte size/u);
});

test("source acquisition requires an external cache before any download", async () => {
  await assert.rejects(acquireCoreferenceSources(), /explicit cache/u);
  await assert.rejects(acquireCoreferenceSources(fileURLToPath(new URL("../../fixtures", import.meta.url))), /outside the repository/u);
});
