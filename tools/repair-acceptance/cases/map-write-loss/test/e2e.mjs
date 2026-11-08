// Test-authored native process check; no proposer or generated-code success is simulated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const records = [
  { id: "e1", taskFamilyId: "family.heldout.a", value: -1 },
  { id: "e2", taskFamilyId: "family.heldout.b", value: 1 },
  { id: "e3", taskFamilyId: "family.heldout.a", value: 0 },
  { id: "e4", taskFamilyId: "family.heldout.a", value: -1 },
  { id: "e5", taskFamilyId: "family.heldout.b", value: 1 },
  { id: "e6", taskFamilyId: "family.heldout.b", value: 0 }
];
const execution = spawnSync(process.execPath, ["src/cli.mjs", JSON.stringify(records)], { encoding: "utf8", timeout: 10000 });
assert.equal(execution.status, 0, execution.stderr);
const result = JSON.parse(execution.stdout);
assert.deepEqual(result.map(row => row.taskFamilyId), ["family.heldout.a", "family.heldout.b"], "the CLI must emit every observed family");
assert.deepEqual(result.map(row => row.sampleCount), [3, 3]);
assert.deepEqual(result.map(row => row.meanEffect), [-2 / 3, 2 / 3]);
process.stdout.write("end-to-end behavior preserved\n");
