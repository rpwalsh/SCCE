// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomBytes } from "node:crypto";
import {
  blobContentHash,
  buildBoundedAlignmentEvents,
  createPostgresStorageAdapter,
  readAlignmentAlternativeSetsFromBoundedPayloads,
  readBoundedAlignmentPayload,
  readScceRuntimeConfig
} from "../packages/adapters-node/dist/index.js";
import { canonicalStringify, createClock, createEventFactory, createHasher, createIdFactory } from "../packages/kernel/dist/index.js";

const args = new Map(process.argv.slice(2).map(value => {
  const match = /^--([^=]+)=(.*)$/u.exec(value);
  return match ? [match[1], match[2]] : [value.replace(/^--/u, ""), "true"];
}));
if (args.get("run") !== "true") {
  process.stdout.write("Usage: node tools/rehearse-alignment-artifacts.mjs --run=true [--config=scce.config.json]\n");
  process.exit(0);
}
const configPath = args.get("config") ?? "scce.config.json";
const config = await readScceRuntimeConfig(configPath);

const schema = `scce_alignment_artifact_${randomBytes(16).toString("hex")}`;
if (!/^scce_alignment_artifact_[a-f0-9]{32}$/u.test(schema)) throw new Error("unsafe rehearsal schema");
const report = { schema, checks: [] };
const check = (id, passed, detail) => report.checks.push({ id, passed, detail });
const sanitize = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 4000);
let storage;
let owned = false;
let failure = null;
const ids = createIdFactory({ clock: createClock({ fixedTime: 1, stepMs: 1 }), hasher: createHasher(), deterministicReplay: true });
const events = createEventFactory({ idFactory: ids, clock: createClock({ fixedTime: 100, stepMs: 1 }), hasher: createHasher() });

const alternative = id => ({
  schema: "scce.alignment_alternative_set.v1",
  id,
  seriesId: "series.shared.fixture",
  supportId: "support.fixture",
  targetIndexId: "target.fixture",
  revision: 1,
  hypotheses: [{ id: `hypothesis.${id}`, plan: { id: `plan.${id}`, anchors: [], iterations: [{ iteration: 0, objective: 0.1, residualMass: 0 }] }, evidenceAllocationIds: [`allocation.${id}`], predecessorPlanIds: [], evidenceIds: ["evidence.fixture"] }],
  retainedHypothesisCount: 1,
  omittedSearchBranchCount: 0,
  attemptedBranchCount: 1,
  totalBranchCount: 1,
  branchSearchBudget: 1,
  posteriorScope: "retained_candidate_set_only",
  exactGlobalPosteriorClaimed: false
});
const allocation = id => ({ id, predecessorPlanIds: [`plan.previous.${id}`], evidenceIds: ["evidence.fixture"], values: [1, 2, 3] });
const payloadFor = id => ({ schema: "scce.sparse_alignment_candidate_batch.v1", shardUri: "fixture://alignment", alignmentAlternativeSets: [alternative(id)], transportEvidenceAllocations: [allocation(`allocation.${id}`)], diagnostics: [{ id, predecessorPlanIds: [`plan.previous.${id}`], evidenceIds: ["evidence.fixture"] }] });
const appendGroup = async (episodeId, payload) => {
  const bounded = await buildBoundedAlignmentEvents({ episodeId, payload, blobs: storage.blobs, idFactory: ids, maxPartBytes: 32, maxPartsPerEvent: 1 });
  await storage.events.appendBatch(bounded.map(event => events.create({ episodeId, typeId: "SparseAlignmentCandidatesCompiled", payload: event })));
  return bounded;
};
const count = async table => Number((await storage.query(`SELECT COUNT(*)::text AS count FROM ${storage.table(table)}`))[0].count);

try {
  storage = createPostgresStorageAdapter({
    url: config.database.url,
    schema,
    ssl: config.database.ssl,
    informationAccess: { tenantId: "scce.local", principalId: "scce.local.owner", compartments: [], maximumExportClass: "restricted" }
  });
  if ((await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).length) throw new Error("schema unexpectedly exists");
  await storage.migrate();
  owned = true;
  const first = await appendGroup(ids.episodeId(), payloadFor("set.one"));
  const second = await appendGroup(ids.episodeId(), payloadFor("set.two"));
  const rows = await storage.events.readRange({ typeId: "SparseAlignmentCandidatesCompiled", limit: 2000 });
  const payloads = rows.map(row => row.payload);
  const sets = await readAlignmentAlternativeSetsFromBoundedPayloads(payloads, "series.shared.fixture", storage.blobs, { maxAssembledItemBytes: 100_000 });
  const decoded = await readBoundedAlignmentPayload(payloads, storage.blobs, { maxAssembledItemBytes: 100_000, maxTotalDecodedBytes: 500_000 });
  check("committed.multiple-groups", first.length > 1 && second.length > 1 && sets.map(set => set.id).sort().join(",") === "set.one,set.two", JSON.stringify({ firstEvents: first.length, secondEvents: second.length, sets: sets.map(set => set.id) }));
  const expectedAllocations = [allocation("allocation.set.one"), allocation("allocation.set.two")]
    .sort((left, right) => left.id.localeCompare(right.id));
  const decodedAllocations = [...(decoded.transportEvidenceAllocations ?? [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  check("committed.allocation-bodies", canonicalStringify(decodedAllocations) === canonicalStringify(expectedAllocations), JSON.stringify({ allocations: decodedAllocations }));
  const blobRows = await storage.query(`SELECT content_hash, content FROM ${storage.table("blobs")}`);
  const hashesValid = blobRows.length > 0 && blobRows.every(row => String(blobContentHash(row.content)) === row.content_hash && `sha256_${createHash("sha256").update(row.content).digest("hex")}` === row.content_hash);
  check("committed.blob-hashes", hashesValid, JSON.stringify({ blobs: blobRows.length }));
  const eventsBefore = await count("events");
  const blobsBefore = await count("blobs");
  let rolledBack = false;
  try {
    await storage.transaction(async () => {
      await appendGroup(ids.episodeId(), payloadFor("set.rollback"));
      throw new Error("intentional outer transaction rollback");
    });
  } catch (error) {
    rolledBack = error instanceof Error && error.message.includes("outer transaction rollback");
  }
  check("rollback.blobs-and-events", rolledBack && await count("events") === eventsBefore && await count("blobs") === blobsBefore, JSON.stringify({ rolledBack, eventsBefore, eventsAfter: await count("events"), blobsBefore, blobsAfter: await count("blobs") }));
} catch (error) {
  failure = sanitize(error instanceof Error ? error.message : String(error));
} finally {
  if (storage) {
    if (owned) {
      const exists = await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
      if (exists.length !== 1) throw new Error(`owned rehearsal schema disappeared: ${schema}`);
      await storage.query(`DROP SCHEMA "${schema}" CASCADE`);
      const remains = await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
      if (remains.length) throw new Error(`owned rehearsal schema remains: ${schema}`);
    }
    await storage.close();
  }
}
report.status = report.checks.every(item => item.passed) ? "passed" : "failed";
if (failure) {
  report.status = "failed";
  report.error = failure;
}
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;
