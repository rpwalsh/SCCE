// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

const configPath = process.argv[2] ?? "scce.config.json";
const config = await readScceRuntimeConfig(configPath);
const schema = `scce_unit_norm_${randomBytes(8).toString("hex")}`;
assert.match(schema, /^scce_unit_norm_[a-f0-9]{16}$/u);

const admin = createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
let storage;
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  storage = createPostgresStorageAdapter({ ...config.database, schema, informationAccess: config.security.informationAccess });
  await storage.migrate();
  const access = config.security.informationAccess;
  const label = {
    tenantId: access.tenantId,
    principals: [access.principalId],
    compartments: [...access.compartments],
    exportClass: access.maximumExportClass,
    mergePolicy: "same_owner"
  };
  const shared = {
    profileId: "profile.language-unit-normalization",
    sourceVersionId: "source-version.language-unit-normalization",
    script: "fixture-script",
    unitKind: "symbol",
    features: ["feature.one"],
    competenceVector: [0.75],
    alpha: 0.75,
    evidenceIds: ["evidence.2", "evidence.1", "evidence.2"],
    metadata: { sourceSystem: "language-unit-normalization", marker: "shared" },
    informationLabel: label
  };
  await storage.languageMemory.putLanguageUnits?.([
    { ...shared, id: "unit.one", text: "uno" },
    { ...shared, id: "unit.two", text: "dos" }
  ]);

  const first = await storage.languageMemory.listLanguageUnits({ sourceSystem: "language-unit-normalization", limit: 10 });
  assert.deepEqual(first.map(unit => unit.id), ["unit.one", "unit.two"]);
  assert.deepEqual(first[0].evidenceIds, shared.evidenceIds);
  assert.deepEqual(first[1].informationLabel, label);
  const [counts] = await storage.query(`SELECT
    (SELECT COUNT(*)::int FROM "${schema}".language_units) AS units,
    (SELECT COUNT(*)::int FROM "${schema}".language_unit_evidence_sets) AS evidence_sets,
    (SELECT COUNT(*)::int FROM "${schema}".language_unit_information_labels) AS labels`);
  assert.deepEqual(counts, { units: 2, evidence_sets: 1, labels: 1 });

  await storage.languageMemory.putLanguageUnits?.([{
    ...shared,
    id: "unit.one",
    text: "uno",
    evidenceIds: ["evidence.3"],
    alpha: 0.9
  }]);
  await storage.migrate();
  const verified = await storage.verify();
  assert.equal(verified.ok, true, verified.errors.join("; "));
  await storage.close();
  storage = createPostgresStorageAdapter({ ...config.database, schema, informationAccess: config.security.informationAccess });
  const reopened = await storage.languageMemory.listLanguageUnits({ sourceSystem: "language-unit-normalization", limit: 10 });
  assert.deepEqual(reopened.find(unit => unit.id === "unit.two")?.evidenceIds, shared.evidenceIds);
  assert.deepEqual(new Set(reopened.find(unit => unit.id === "unit.one")?.evidenceIds), new Set(["evidence.1", "evidence.2", "evidence.3"]));
  const physicalColumns = await storage.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='language_units' ORDER BY ordinal_position`,
    [schema]
  );
  const names = physicalColumns.map(row => row.column_name);
  assert.ok(names.includes("evidence_set_id") && names.includes("information_label_id"));
  assert.ok(!names.includes("evidence_ids") && !names.includes("information_label"));
  process.stdout.write(`${JSON.stringify({ schema: "scce.language_unit_normalization_verification.v1", ok: true, units: 2, evidenceSets: 2, labels: 1 })}\n`);
} finally {
  await storage?.close().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
  await admin.close().catch(() => undefined);
}
