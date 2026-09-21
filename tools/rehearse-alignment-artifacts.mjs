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

const sharedColumn = {
  graphTargetId: "target.shared",
  implicitType: "unmatched",
  implicitCost: 0.2,
  targetMass: 1,
  transportedMass: 1,
  graphImplicitMass: 0,
  overflowMass: 0,
  residual: 0
};
const sharedRow = {
  surfaceUnitId: "surface.shared",
  nullType: "unmatched",
  nullCost: 0.2,
  targetMass: 1,
  transportedMass: 1,
  surfaceNullMass: 0,
  overflowMass: 0,
  residual: 0
};
const sharedCell = {
  candidateId: "candidate.shared",
  surfaceUnitId: "surface.shared",
  graphTargetId: "target.shared",
  mass: 1,
  featureCost: 0.1,
  structuralCost: 0.1,
  orderingCost: 0.1,
  crossDocumentCost: 0.1,
  anchorCost: 0,
  effectiveCost: 0.4,
  exactAnchor: false
};
const sharedEvidenceShare = {
  evidenceId: "evidence.fixture",
  basis: "shared_exact_evidence",
  conditionalProbability: 1,
  allocatedMass: 1
};
const alternative = (id, seriesId, supportId, allocationId) => ({
  schema: "scce.alignment_alternative_set.v1",
  id,
  seriesId,
  supportId,
  targetIndexId: "target.fixture",
  revision: 1,
  hypotheses: [{
    rank: 1,
    plan: {
      schema: "scce.sparse_fused_unbalanced_transport.v1",
      id: `plan.${id}`,
      supportId,
      targetIndexId: "target.fixture",
      cells: [sharedCell],
      rowMarginals: [sharedRow],
      columnMarginals: [sharedColumn],
      iterations: [{ outerIteration: 0, objective: 0.1 }]
    },
    objectiveValue: 0.1,
    restrictedGibbsWeight: 1,
    evidenceAllocationId: allocationId,
    predecessorPlanIds: []
  }],
  retainedHypothesisCount: 1,
  omittedSearchBranchCount: 0,
  attemptedBranchCount: 1,
  totalBranchCount: 1,
  branchSearchBudget: 1,
  posteriorScope: "retained_candidate_set_only",
  exactGlobalPosteriorClaimed: false
});
const allocation = (id, supportId) => ({
  schema: "scce.transport_evidence_allocation.v1",
  id,
  allocationPolicyId: "scce.transport_evidence.shared_exact_bootstrap.v1",
  transportPlanId: id.replace("allocation.", "plan.set."),
  supportId,
  status: "conserved",
  cells: [{
    ...sharedCell,
    transportMass: 1,
    status: "conserved",
    sourceCoordinates: { byteStart: 0, byteEnd: 4, utf16Start: 0, utf16End: 4, codePointStart: 0, codePointEnd: 4, graphemeStart: 0, graphemeEnd: 4 },
    shares: [sharedEvidenceShare],
    conditionalProbabilitySum: 1,
    allocatedMass: 1,
    conservationResidual: 0
  }],
  totalTransportMass: 1,
  totalAllocatedMass: 1,
  conservationResidual: 0,
  unresolvedCandidateIds: [],
  audit: { fixture: true }
});
const sharedPayloadFor = prefix => {
  const series = ["series.a", "series.b", "series.a", "series.b"];
  const sets = series.map((seriesId, index) => {
    const supportId = "support.interleaved";
    const allocationId = `allocation.${prefix}.${index}`;
    return alternative(`set.${prefix}.${index}`, seriesId, supportId, allocationId);
  });
  return {
    schema: "scce.sparse_alignment_candidate_batch.v1",
    shardUri: `fixture://alignment/${prefix}`,
    alignmentAlternativeSets: sets,
    transportEvidenceAllocations: sets.map((set, index) => allocation(`allocation.${prefix}.${index}`, set.supportId))
  };
};
const legacyPayload = {
  schema: "scce.sparse_alignment_candidate_batch.v1",
  shardUri: "fixture://alignment/legacy",
  diagnostics: [{ id: "legacy.fixture", values: [1, 2, 3] }]
};
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
  const firstPayload = sharedPayloadFor("one");
  const secondPayload = sharedPayloadFor("two");
  const first = await appendGroup(ids.episodeId(), firstPayload);
  const second = await appendGroup(ids.episodeId(), secondPayload);
  await appendGroup(ids.episodeId(), legacyPayload);
  const rows = await storage.events.readRange({ typeId: "SparseAlignmentCandidatesCompiled", limit: 2000 });
  const payloads = rows.map(row => row.payload);
  const expectedSets = [
    ...firstPayload.alignmentAlternativeSets,
    ...secondPayload.alignmentAlternativeSets
  ];
  const expectedAllocations = [
    ...firstPayload.transportEvidenceAllocations,
    ...secondPayload.transportEvidenceAllocations
  ];
  const sets = await readAlignmentAlternativeSetsFromBoundedPayloads(payloads, "series.b", storage.blobs, { maxAssembledItemBytes: 100_000 });
  const decoded = await readBoundedAlignmentPayload(payloads, storage.blobs, { maxAssembledItemBytes: 100_000, maxTotalDecodedBytes: 500_000 });
  const selectedAllocationPayload = await readBoundedAlignmentPayload(payloads, storage.blobs, { key: "transportEvidenceAllocations", seriesId: "series.b", maxAssembledItemBytes: 100_000, maxTotalDecodedBytes: 500_000 });
  const expectedSeriesBSetIds = expectedSets.filter(set => set.seriesId === "series.b").map(set => set.id).sort();
  check("committed.multiple-groups", first.length > 1 && second.length > 1 && sets.map(set => set.id).sort().join(",") === expectedSeriesBSetIds.join(","), JSON.stringify({ firstEvents: first.length, secondEvents: second.length, selectedSeriesSets: sets.map(set => set.id) }));
  const decodedSets = [...(decoded.alignmentAlternativeSets ?? [])];
  const expectedSetById = new Map(expectedSets.map(set => [set.id, set]));
  const decodedSetById = new Map(decodedSets.map(value => [String(value.id), value]));
  const setBodiesMatch = decodedSetById.size === expectedSetById.size
    && [...expectedSetById].every(([id, expected]) => canonicalStringify(decodedSetById.get(id)) === canonicalStringify(expected));
  check("committed.full-set-roundtrip", setBodiesMatch, JSON.stringify({ decodedSetIds: [...decodedSetById.keys()].sort(), expectedSetIds: [...expectedSetById.keys()].sort() }));
  for (const prefix of ["one", "two"]) {
    const expectedOrder = expectedSets.filter(set => set.id.startsWith(`set.${prefix}.`)).map(set => set.id);
    const decodedOrder = decodedSets.filter(set => String(set.id).startsWith(`set.${prefix}.`)).map(set => String(set.id));
    check(`committed.${prefix}-source-order`, decodedOrder.join(",") === expectedOrder.join(","), JSON.stringify({ decodedOrder, expectedOrder }));
  }
  const decodedAllocations = [...(decoded.transportEvidenceAllocations ?? [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  check("committed.allocation-bodies", canonicalStringify(decodedAllocations) === canonicalStringify(expectedAllocations.sort((left, right) => left.id.localeCompare(right.id))), JSON.stringify({ allocations: decodedAllocations }));
  const expectedSeriesBAllocationIds = expectedAllocations.filter(allocationRow => allocationRow.id.includes(".1") || allocationRow.id.includes(".3")).map(allocationRow => allocationRow.id).sort();
  const selectedAllocationIds = [...(selectedAllocationPayload.transportEvidenceAllocations ?? [])].map(value => String(value.id)).sort();
  check("committed.selected-series-allocations", selectedAllocationIds.join(",") === expectedSeriesBAllocationIds.join(","), JSON.stringify({ selectedAllocationIds, expectedSeriesBAllocationIds }));
  const firstSeriesAPlan = decodedSetById.get("set.one.0")?.hypotheses?.[0]?.plan;
  const secondSeriesAPlan = decodedSetById.get("set.one.2")?.hypotheses?.[0]?.plan;
  check("committed.shared-record-alias", Boolean(firstSeriesAPlan?.columnMarginals?.[0] === secondSeriesAPlan?.columnMarginals?.[0]
    && firstSeriesAPlan?.columnMarginals?.[0] && Object.isFrozen(firstSeriesAPlan.columnMarginals[0])), JSON.stringify({ sharedAlias: firstSeriesAPlan?.columnMarginals?.[0] === secondSeriesAPlan?.columnMarginals?.[0] }));
  const legacyDecoded = await readBoundedAlignmentPayload(payloads, storage.blobs, { key: "diagnostics", maxAssembledItemBytes: 100_000 });
  const legacyEventPayloads = payloads.filter(payload => payload && typeof payload === "object" && !Array.isArray(payload)
    && payload.shardUri === legacyPayload.shardUri);
  check("legacy.event-v1-envelope", legacyEventPayloads.length > 0
    && legacyEventPayloads.every(payload => payload.schema === "scce.sparse_alignment_candidate_blob_event.v1"), JSON.stringify({ schemas: legacyEventPayloads.map(payload => payload.schema) }));
  check("legacy.inline-format-read", canonicalStringify(legacyDecoded.diagnostics) === canonicalStringify(legacyPayload.diagnostics), JSON.stringify({ diagnostics: legacyDecoded.diagnostics }));
  const blobRows = await storage.query(`SELECT content_hash, content FROM ${storage.table("blobs")}`);
  const hashesValid = blobRows.length > 0 && blobRows.every(row => String(blobContentHash(row.content)) === row.content_hash && `sha256_${createHash("sha256").update(row.content).digest("hex")}` === row.content_hash);
  check("committed.blob-hashes", hashesValid, JSON.stringify({ blobs: blobRows.length }));
  const eventsBefore = await count("events");
  const blobsBefore = await count("blobs");
  let rolledBack = false;
  try {
    await storage.transaction(async () => {
      await appendGroup(ids.episodeId(), sharedPayloadFor("rollback"));
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
