// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";
import {
  COHORTS, DISPOSABLE_SCHEMA_PATTERN, IDS_PER_CONTRIBUTOR, benchmarkSql, compareMembership,
  cumulativeWork, evidenceId, evidenceIds, localValidationPlan, parseBenchmarkArguments,
  assertDisposableSchemaName
} from "./evidence-association-benchmark.mjs";

test("fixed cohorts reproduce the cumulative-work oracle without ID collisions", () => {
  assert.deepEqual(COHORTS, [64, 128, 256]);
  assert.equal(IDS_PER_CONTRIBUTOR, 8);
  assert.deepEqual(cumulativeWork(64), {
    finalMemberships: 512, modeledArrayEntriesMaterialized: 16_640,
    associationEntriesInserted: 512, statementsPerVariant: 64
  });
  assert.deepEqual(cumulativeWork(128), {
    finalMemberships: 1_024, modeledArrayEntriesMaterialized: 66_048,
    associationEntriesInserted: 1_024, statementsPerVariant: 128
  });
  assert.deepEqual(cumulativeWork(256), {
    finalMemberships: 2_048, modeledArrayEntriesMaterialized: 263_168,
    associationEntriesInserted: 2_048, statementsPerVariant: 256
  });
  assert.match(evidenceId(0, 0), /^[0-9a-f]{64}$/u);
  assert.equal(new Set(evidenceIds(256)).size, 2_048);
  const validation = localValidationPlan();
  assert.equal(validation.passed, true);
  assert.ok(Object.values(validation.sqlContract).every(Boolean));
});

test("membership oracle detects omission and ignores input ordering", () => {
  const expected = evidenceIds(64), reordered = [...expected].reverse();
  assert.equal(compareMembership(expected, reordered).exact, true);
  const omitted = compareMembership(expected, reordered.slice(1));
  assert.equal(omitted.exact, false);
  assert.equal(omitted.expectedCount, omitted.actualCount + 1);
});

test("SQL contract indexes both lookup directions and uses independent memberships", () => {
  const sql = benchmarkSql("scce_evidence_assoc_bench_0123456789abcdef01234567");
  assert.match(sql.createArray.join("\n"), /PRIMARY KEY/u);
  assert.match(sql.createArray.join("\n"), /USING gin \(evidence_ids\)/u);
  assert.match(sql.createAssociation.join("\n"), /PRIMARY KEY \(node_id, evidence_id\)/u);
  assert.match(sql.createAssociation.join("\n"), /\(evidence_id, node_id\)/u);
  assert.match(sql.arrayUpsert, /current\.evidence_ids \|\| EXCLUDED\.evidence_ids/u);
  assert.match(sql.associationInsert, /unnest\(\$2::text\[\]\)/u);
  assert.match(sql.arrayByEvidence, /evidence_ids @>/u);
  assert.match(sql.associationByEvidence, /evidence_id=\$1/u);
  assert.match("scce_evidence_assoc_bench_0123456789abcdef01234567", DISPOSABLE_SCHEMA_PATTERN);
});

test("CLI requires explicit config, new output target, and destructive acknowledgement", () => {
  assert.throws(() => parseBenchmarkArguments(["--config", "brain.json", "--out", "receipt.json"]), /allow-disposable-schema/u);
  assert.throws(() => parseBenchmarkArguments(["--out", "receipt.json", "--allow-disposable-schema"]), /config and --out/u);
  const parsed = parseBenchmarkArguments(["--config", "brain.json", "--out", "receipt.json", "--allow-disposable-schema"]);
  assert.equal(parsed.help, false);
  assert.match(parsed.configPath, /brain\.json$/u);
  assert.match(parsed.outPath, /receipt\.json$/u);
});

test("schema deletion guard accepts only tool-generated random names", () => {
  assert.doesNotThrow(() => assertDisposableSchemaName("scce_evidence_assoc_bench_0123456789abcdef01234567"));
  for (const unsafe of ["public", "scce_runtime", "scce_evidence_assoc_bench_", "scce_evidence_assoc_bench_0123456789abcdef0123456g"]) {
    assert.throws(() => assertDisposableSchemaName(unsafe), /refusing to create or drop/u);
  }
});
