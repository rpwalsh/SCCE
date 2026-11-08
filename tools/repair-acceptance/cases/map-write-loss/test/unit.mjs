// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Test-authored assertions over an unchanged repository source snapshot.
import assert from "node:assert/strict";
import { estimateClassEffectLCB, holmBonferroniCorrection, isValidPairedResult } from "../src/paired-evaluation-statistics.ts";
const records = [
  { id: "a1", taskFamilyId: "family.a", value: 1 },
  { id: "b1", taskFamilyId: "family.b", value: -1 },
  { id: "a2", taskFamilyId: "family.a", value: -1 },
  { id: "b2", taskFamilyId: "family.b", value: -1 },
  { id: "a3", taskFamilyId: "family.a", value: 1 }
];
const before = JSON.stringify(records);
const result = estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 32, randomSource: () => 0 });
assert.deepEqual(result.map(row => row.taskFamilyId), ["family.a", "family.b"], "every observed family must remain represented");
assert.deepEqual(result.map(row => row.sampleCount), [3, 2], "repeated records must remain grouped in their own families");
assert.deepEqual(result.map(row => row.meanEffect), [1 / 3, -1]);
assert.equal(JSON.stringify(records), before, "estimation must preserve the caller's input records");
assert.deepEqual([-1, 0, 1, 2].map(isValidPairedResult), [true, true, true, false]);
assert.throws(() => estimateClassEffectLCB([{ id: "invalid", taskFamilyId: "family.a", value: 2 }], { confidenceLevel: 0.95, bootstrapSamples: 32 }), /invalid paired result/u);
assert.deepEqual(holmBonferroniCorrection([{ id: "x", pValue: 0.01 }, { id: "y", pValue: 0.2 }], 0.05).map(row => row.reject), [true, false]);
process.stdout.write("unit behavior preserved\n");
