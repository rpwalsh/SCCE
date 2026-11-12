// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  brainBuildPublicationJournalPath,
  publishBrainBuildCheckpoint,
  recoverAtomicReplacement,
  recoverBrainBuildPublication
} from "./brain-build-publication.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-publication-"));
  const statePath = path.join(root, "brain.state.json"), receiptPath = path.join(root, "receipt.json");
  const building = { schema: "state.v1", status: "building", batches: 4 };
  const oldReceipt = { schema: "receipt.v1", status: "building", batches: 4 };
  const complete = { schema: "state.v1", status: "complete", batches: 5 };
  const finalReceipt = { schema: "receipt.v1", status: "complete", batches: 5 };
  await atomicWriteJson(statePath, building);
  await atomicWriteJson(receiptPath, oldReceipt, 2);
  return { root, statePath, receiptPath, building, oldReceipt, complete, finalReceipt };
}

for (const phase of ["afterJournal", "afterReceipt", "afterState"]) {
  test(`recovery completes an interruption ${phase}`, async t => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await assert.rejects(publishBrainBuildCheckpoint({
      statePath: f.statePath,
      receiptPath: f.receiptPath,
      state: f.complete,
      receipt: f.finalReceipt,
      hooks: { [phase]: () => { throw new Error(`simulated ${phase}`); } }
    }), new RegExp(`simulated ${phase}`, "u"));
    assert.equal(JSON.parse(await readFile(brainBuildPublicationJournalPath(f.statePath), "utf8")).schema,
      "scce.brain_build_publication.v1");
    const recovered = await recoverBrainBuildPublication({ statePath: f.statePath, receiptPath: f.receiptPath });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), f.complete);
    assert.deepEqual(JSON.parse(await readFile(f.receiptPath, "utf8")), f.finalReceipt);
    assert.equal((await recoverBrainBuildPublication({ statePath: f.statePath, receiptPath: f.receiptPath })).recovered, false);
  });
}

test("a corrupt or cross-target journal fails closed", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await atomicWriteJson(brainBuildPublicationJournalPath(f.statePath), {
    schema: "scce.brain_build_publication.v1",
    statePath: f.statePath,
    receiptPath: path.join(f.root, "other.json"),
    stateSha256: "bad",
    receiptSha256: "bad",
    stateText: "{}",
    receiptText: "{}"
  });
  await assert.rejects(recoverBrainBuildPublication({ statePath: f.statePath, receiptPath: f.receiptPath }), /Cannot recover/u);
});

test("Windows replacement recovery restores an old target moved aside before the new rename", async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await rename(f.statePath, `${f.statePath}.previous`);
  assert.equal(await recoverAtomicReplacement(f.statePath), true);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), f.building);
  assert.equal(await recoverAtomicReplacement(f.statePath), false);
});
