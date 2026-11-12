// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { createClock, createHasher, createIdFactory } from "../packages/kernel/dist/index.js";

const configPath = process.argv[2] ?? "scce.config.json";
const config = await readScceRuntimeConfig(configPath);
const hostname = new URL(config.database.url).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
  throw new Error("Evidence normalization verification requires local PostgreSQL");
}

const schema = `scce_evidence_norm_${randomBytes(8).toString("hex")}`;
assert.match(schema, /^scce_evidence_norm_[a-f0-9]{16}$/u);
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
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: schema });
  const prefix = "前置|", text = "雪🧭\u0000e\u0301\r\n", suffix = "|後置";
  const sourceText = `${prefix}${text}${suffix}`;
  const sourceBytes = Buffer.from(sourceText, "utf8"), textBytes = Buffer.from(text, "utf8");
  const byteStart = Buffer.byteLength(prefix, "utf8"), byteEnd = byteStart + textBytes.byteLength;
  const charStart = [...prefix].length, charEnd = charStart + [...text].length;
  const namespace = "evidence-normalization", uri = `fixture://${schema}/unicode`;
  const sourceId = ids.sourceId(namespace, uri), sourceVersionId = ids.sourceVersionId(`${sourceId}:${sourceText}`);
  const sourceHash = await storage.blobs.put(sourceBytes, "text/plain; charset=utf-8");
  const textHash = `sha256_${createHash("sha256").update(textBytes).digest("hex")}`;
  assert.equal(typeof storage.blobs.putRanges, "function", "PostgreSQL blob store must support canonical ranges");
  await storage.blobs.putRanges([{
    contentHash: textHash,
    parentHash: sourceHash,
    byteStart,
    byteEnd,
    mediaType: "text/plain; charset=utf-8"
  }], { contentHash: sourceHash, bytes: sourceBytes });

  const sourceTrust = {
    identity: 1,
    integrity: 1,
    parserReliability: 1,
    directness: 1,
    authority: 1,
    freshness: 1,
    independenceGroup: String(sourceId),
    accessScope: "local-verification",
    licenseStatus: "test_authored"
  };
  await storage.evidence.putSourceVersion({
    sourceId,
    sourceVersionId,
    namespace,
    canonicalUri: uri,
    contentHash: sourceHash,
    mediaType: "text/plain; charset=utf-8",
    observedAt: 1,
    byteLength: sourceBytes.byteLength,
    sourceTrust,
    metadata: { sourceSystem: "evidence-normalization-verifier" },
    informationLabel: label
  });
  const chunkId = ids.chunkId({ sourceVersionId, byteStart, byteEnd, chunkHash: textHash });
  const evidenceId = ids.evidenceId({ sourceVersionId, byteStart, byteEnd, spanHash: textHash });
  await storage.evidence.putEvidenceSpan({
    id: evidenceId,
    sourceId,
    sourceVersionId,
    chunkId,
    contentHash: textHash,
    mediaType: "text/plain; charset=utf-8",
    byteStart,
    byteEnd,
    charStart,
    charEnd,
    text,
    textPreview: "distinct preview 雪🧭",
    languageHints: {},
    scriptHints: {},
    trustVector: sourceTrust,
    provenance: { sourceSystem: "evidence-normalization-verifier" },
    features: ["verification:canonical-evidence-text"],
    status: "promoted",
    alpha: 1,
    observedAt: 1,
    informationLabel: label
  });

  const physicalColumns = await storage.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='evidence_spans' ORDER BY ordinal_position`,
    [schema]
  );
  const names = physicalColumns.map(row => row.column_name);
  assert.ok(!names.includes("text_sha256"));
  assert.ok(!names.includes("text_content"));
  const physicalRows = await storage.query(
    `SELECT content_hash,text_preview FROM "${schema}".evidence_spans WHERE id=$1`,
    [evidenceId]
  );
  assert.equal(physicalRows.length, 1);
  assert.equal(physicalRows[0].content_hash, textHash);
  assert.equal(physicalRows[0].text_preview, "distinct preview 雪🧭");

  await storage.close();
  storage = createPostgresStorageAdapter({ ...config.database, schema, informationAccess: config.security.informationAccess });
  const verified = await storage.verify();
  assert.equal(verified.ok, true, verified.errors.join("; "));
  const reopened = await storage.evidence.getEvidence(evidenceId);
  assert.ok(reopened);
  assert.equal(reopened.text, text);
  assert.equal(reopened.textPreview, "distinct preview 雪🧭");
  assert.equal(reopened.contentHash, textHash);

  const tampered = Buffer.from(sourceBytes);
  tampered[0] = tampered[0] ^ 0x01;
  await assert.rejects(storage.transaction(async () => {
    await storage.query(`UPDATE "${schema}".blobs SET content=$2 WHERE content_hash=$1`, [sourceHash, tampered]);
    await storage.evidence.getEvidence(evidenceId);
  }), /canonical blob integrity mismatch/u);
  assert.equal((await storage.evidence.getEvidence(evidenceId))?.text, text);

  process.stdout.write(`${JSON.stringify({
    schema: "scce.evidence_text_normalization_verification.v1",
    ok: true,
    physicalBodyCopies: 0,
    coldRestartExact: true,
    tamperRejected: true
  })}\n`);
} finally {
  await storage?.close().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
  await admin.close().catch(() => undefined);
}
