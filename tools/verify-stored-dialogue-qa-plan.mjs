#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { canonicalStringify, createHasher, verifyContextualQaConstruction } from "../packages/kernel/dist/index.js";
const value = name => process.argv.find(argument => argument.startsWith("--" + name + "="))?.slice(name.length + 3);
const configPath = value("config"), planPath = value("plan"), qualificationPath = value("qualification");
if (!configPath || !planPath || !qualificationPath) throw Error("Required --config=path --plan=path --qualification=path");
const planReceipt = JSON.parse(await readFile(planPath, "utf8")), qualification = JSON.parse(await readFile(qualificationPath, "utf8"));
const plan = planReceipt.result;
assert.equal(planReceipt.status, "complete");
assert.equal(plan.activeKnowledgePreserved, true);
const config = await readScceRuntimeConfig(configPath);
const readOnlyUrl = new URL(config.database.url);
if (true) readOnlyUrl.searchParams.set("options",
  [readOnlyUrl.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
const storage = createPostgresStorageAdapter({ ...config.database, url: readOnlyUrl.toString(), informationAccess: config.security?.informationAccess });
try {
  const expectedIds = [...new Set(plan.plans.flatMap(item => item.projection.patternIds))].sort();
  const actual = await storage.languageMemory.listLanguagePatterns({ patternIds: expectedIds, limit: expectedIds.length,
    maxTotalJsonBytes: 64 * 1024 * 1024, requireComplete: true });
  assert.deepEqual(actual.map(pattern => pattern.id).sort(), expectedIds, "every planned old and new program must be active");
  const evidenceIds = [...new Set(actual.flatMap(pattern => pattern.evidenceIds))], evidence = await storage.evidence.getEvidenceBatch(evidenceIds);
  const hasher = createHasher(), statuses = {};
  for (const pattern of actual) {
    const bundle = verifyContextualQaConstruction({ pattern, evidence, hasher });
    assert.ok(bundle, "cold retained-source verification failed for " + pattern.id);
    statuses[bundle.acquisitionStatus] = (statuses[bundle.acquisitionStatus] ?? 0) + 1;
  }
  assert.ok(statuses.document_heldout_qualified > 0, "publication has no transfer-qualified active program");
  for (const item of plan.plans) {
    const projection = await storage.languageMemory.getLanguagePatternProjection(item.projection);
    assert.ok(projection, "planned projection ownership/dependencies changed");
    assert.equal(canonicalStringify(projection.patternIds), canonicalStringify(item.projection.patternIds));
    assert.equal(canonicalStringify(projection.sourceDependencies), canonicalStringify(item.projection.sourceDependencies));
  }
  for (const receipt of qualification.sourceReceipts) {
    const source = await storage.evidence.sourceVersionById(receipt.sourceVersionId);
    assert.ok(source);
    assert.equal(String(source.contentHash), receipt.contentHash);
    assert.equal(source.canonicalUri, receipt.canonicalUri);
  }
  const prefix = value("include-uri-prefix");
  if (prefix) {
    const sources = await storage.evidence.listEvidenceBackedSourceVersions({ includeUriPrefixes: [prefix],
      excludeTrainingDerived: true, orderBySourceVersionId: true, limit: qualification.sourceReceipts.length + 1 });
    assert.deepEqual(sources.map(source => String(source.sourceVersionId)).sort(),
      qualification.sourceReceipts.map(source => source.sourceVersionId).sort(), "retained source inventory changed");
  }
  process.stdout.write(JSON.stringify({ schema: "scce.stored_dialogue_qa_plan_readback.v1", mode: "read_only",
    activePrograms: actual.length, preservedPrograms: plan.retainedActivePatternIds.length, addedPrograms: plan.newPatternIds.length,
    projections: plan.plans.length, sourceVersionsUnchanged: qualification.sourceReceipts.length, acquisitionStatuses: statuses }) + "\n");
} finally { await storage.close(); }
