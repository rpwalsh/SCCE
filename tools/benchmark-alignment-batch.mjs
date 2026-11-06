// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { benchmarkBuildIdentity } from "./lib/benchmark-build-identity.mjs";

const { values } = parseArgs({ options: {
  fixture: { type: "string" }, out: { type: "string" },
  kernel: { type: "string", default: "packages/kernel/dist/index.js" },
  "artifact-dir": { type: "string" },
  "source-schema": { type: "string" }, "export-fixture": { type: "string" }
} });
const kernelPath = resolve(values.kernel);
const kernel = await import(pathToFileURL(kernelPath).href);
const hasher = kernel.createHasher();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(value, null, 2) + "\n", "utf8");
}

if (values["export-fixture"]) {
  const schema = values["source-schema"];
  if (!schema || !/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("export requires a valid --source-schema");
  const { createPostgresStorageAdapter, readScceRuntimeConfig, readBoundedAlignmentPayload } = await import("../packages/adapters-node/dist/index.js");
  const config = await readScceRuntimeConfig("scce.config.json");
  const url = new URL(config.database.url);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const storage = createPostgresStorageAdapter({ url: url.href, schema, informationAccess: config.security.informationAccess });
  try {
    const learned = await storage.query(`SELECT payload_json FROM ${schema}.events WHERE type_id='SymbolPatternLearned' AND payload_json->>'sourceSystem'='wikipedia'`);
    if (learned.length !== 1) throw new Error("export requires exactly one recorded Wikipedia language batch");
    const sourceVersionIds = learned[0].payload_json.corpusMetadata.sourceVersionIds;
    const rows = await storage.query(`SELECT id FROM ${schema}.evidence_spans WHERE source_version_id=ANY($1::text[]) AND status='promoted'`, [sourceVersionIds]);
    const evidence = await storage.evidence.getEvidenceBatch(rows.map(row => row.id));
    const sourceOrder = new Map(sourceVersionIds.map((id, index) => [id, index]));
    evidence.sort((a, b) => sourceOrder.get(a.sourceVersionId) - sourceOrder.get(b.sourceVersionId) || a.charStart - b.charStart || String(a.id).localeCompare(String(b.id)));
    const graph = await storage.graph.getSlice({ evidenceIds: evidence.map(span => span.id), limitNodes: 100_000, limitEdges: 200_000 });
    const hyperedgeRows = await storage.query(`SELECT * FROM ${schema}.graph_hyperedges WHERE evidence_ids && $1::text[] AND modality_json ? 'extractionChannel'`, [evidence.map(span => span.id)]);
    // The trainer compiles promoted hyperedges before adding storage access labels.
    const hyperedges = hyperedgeRows.map(row => ({ schema: row.schema_id, id: row.id, relationId: row.relation_id, participantPorts: row.participant_ports, memberNodeIds: row.member_node_ids, qualifiers: row.qualifiers_json, modality: row.modality_json, evidenceIds: row.evidence_ids, weightVector: row.weight_vector, temporalScope: row.temporal_scope, provenanceRefs: row.provenance_refs, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime() }));
    const loadedNodes = new Set(graph.nodes.map(node => String(node.id)));
    const missingNodeIds = [...new Set(hyperedges.flatMap(edge => edge.memberNodeIds))].filter(id => !loadedNodes.has(String(id)));
    if (missingNodeIds.length) {
      const missing = await storage.graph.getSlice({ seedNodeIds: missingNodeIds, radius: 0, limitNodes: 100_000, limitEdges: 1 });
      graph.nodes.push(...missing.nodes.filter(node => !loadedNodes.has(String(node.id))));
    }
    const fullIndex = kernel.compileSparseAlignmentTargetIndex({ incidenceGraph: kernel.liftHyperedgesToTypedIncidenceGraph({ hyperedges, hasher }), nodes: graph.nodes, hasher });
    const selectedEvidence = kernel.rankEvidenceForAlignment({ evidence, targetIndex: fullIndex, limit: config.runtime.corpora?.wikipedia?.alignmentLatticesPerShard ?? 48 });
    const selectedIds = new Set(selectedEvidence.map(span => String(span.id)));
    const selectedHyperedges = hyperedges.filter(edge => edge.evidenceIds.some(id => selectedIds.has(String(id))));
    const nodeIds = new Set(selectedHyperedges.flatMap(edge => edge.memberNodeIds.map(String)));
    const targetIndex = kernel.compileSparseAlignmentTargetIndex({ incidenceGraph: kernel.liftHyperedgesToTypedIncidenceGraph({ hyperedges: selectedHyperedges, hasher }), nodes: graph.nodes.filter(node => nodeIds.has(String(node.id))), maxTargetsPerPosting: 512, hasher });
    const events = (await storage.events.readRange({ typeId: "SparseAlignmentCandidatesCompiled", limit: 1024 })).map(event => event.payload);
    const recorded = await readBoundedAlignmentPayload(events, storage.blobs, { key: "targetIndexId" });
    if (targetIndex.id !== recorded.targetIndexId) throw new Error("reconstructed target index does not match the recorded batch");
    await save(values["export-fixture"], { schema: "scce.saved_alignment_fixture.v1", sourceSchema: schema, sourceVersionIds, evidence: selectedEvidence, targetIndex, recordedTargetIndexId: recorded.targetIndexId });
    console.log(JSON.stringify({ exported: values["export-fixture"], sourceDocuments: sourceVersionIds.length, trainingEvidence: evidence.length, selectedEvidence: selectedEvidence.length, targets: targetIndex.targets.length, targetIndexId: targetIndex.id, recordedIdentityMatched: true }));
  } finally { await storage.close(); }
} else {
  if (!values.fixture || !values.out) throw new Error("Use --fixture=<json> --out=<report.json>, or --source-schema=<schema> --export-fixture=<json>");
  const bytes = await readFile(resolve(values.fixture));
  const fixture = JSON.parse(bytes);
  if (fixture.schema !== "scce.saved_alignment_fixture.v1" || fixture.targetIndex.id !== fixture.recordedTargetIndexId) throw new Error("fixture must match the recorded target index");
  const implementation = await benchmarkBuildIdentity(kernelPath);
  const measurements = [];
  function measured(stage, run) {
    const started = performance.now();
    const result = run();
    measurements.push({ stage, elapsedMs: performance.now() - started, ...process.memoryUsage(), maximumResidentKiB: process.resourceUsage().maxRSS });
    console.log(JSON.stringify(measurements.at(-1)));
    return result;
  }
  const started = performance.now();
  const solver = measured("target-preparation", () => kernel.prepareSparseTransportSolver?.({ targetIndex: fixture.targetIndex }));
  const targetIndex = solver?.targetIndex ?? fixture.targetIndex;
  const solve = options => solver ? solver.solve(options) : kernel.solveSparseFusedUnbalancedTransport({ ...options, targetIndex });
  const supports = measured("lattices-candidates-routing", () => fixture.evidence.map(span => {
    const lattice = kernel.buildSurfaceLattice({ documentId: String(span.id), sourceFamilyId: kernel.evidenceSourceFamilyId(span), text: span.text, sourceVersionId: span.sourceVersionId, evidenceIds: [span.id], hasher });
    const support = kernel.generateSparseAlignmentCandidates({ lattice, targetIndex, hasher });
    return kernel.compileAlignmentCommunityRouting({ support, targetIndex, hasher }).routedSupport;
  }));
  const typedNullCostModel = measured("typed-null-model", () => kernel.compileTypedNullCostModel({ supports, targetIndex, hasher }));
  const populationOrderingModel = measured("population-model", () => kernel.compilePopulationOrderingModel({ supports, hasher }));
  const retentionPolicy = kernel.createSparseTransportPlanRetentionInterner();
  const allocationRetention = kernel.createTransportEvidenceAllocationRetentionInterner();
  const initial = measured("initial-transport", () => supports.map(support => retentionPolicy.compact(solve({ support, typedNullCostModel, populationOrderingModel, hasher }))));
  const crossDocumentAlignmentModel = measured("cross-document-model", () => kernel.compileCrossDocumentAlignmentModel({ supports, plans: initial, targetIndex, hasher }));
  initial.length = 0;
  const final = measured("final-transport", () => supports.map(support => retentionPolicy.compact(solve({ support, typedNullCostModel, populationOrderingModel, crossDocumentAlignmentModel, hasher }))));
  const sets = [];
  const allocations = [];
  measured("alternatives-allocations", () => {
    supports.forEach((support, index) => {
      const extracted = kernel.extractAlignmentAlternatives({ basePlan: final[index], support, targetIndex, solver, typedNullCostModel, populationOrderingModel, crossDocumentAlignmentModel, retentionPolicy, hasher });
      const evidenceAllocations = extracted.plans.map(plan => allocationRetention.compact(kernel.allocateTransportEvidence({ plan, support, hasher })));
      allocations.push(...evidenceAllocations);
      const seriesId = kernel.alignmentAlternativeSeriesId({ support, targetIndex, hasher });
      sets.push(kernel.compileAlignmentAlternativeSet({ seriesId, plans: extracted.plans, evidenceAllocations, predecessorSets: [], omittedSearchBranchCount: extracted.omittedSearchBranchCount, attemptedBranchCount: extracted.attemptedBranchCount, totalBranchCount: extracted.totalBranchCount, branchSearchBudget: extracted.branchSearchBudget, hasher }));
      if ((index + 1) % 8 === 0) console.log(JSON.stringify({ completedSupports: index + 1, maximumResidentKiB: process.resourceUsage().maxRSS }));
    });
  });
  const alignmentElapsedMs = performance.now() - started;
  final.length = 0;
  const payload = { alignmentAlternativeSets: sets, transportEvidenceAllocations: allocations, targetIndexId: targetIndex.id };
  const artifactDigest = measured("full-retained-output-hash", () => kernel.canonicalDigestHex(payload, hasher));
  const report = {
    schema: "scce.alignment_batch_benchmark.v1", generatedAt: new Date().toISOString(),
    scope: "reconstructed_saved_alignment_without_source_language_or_database_persistence",
    implementation: { ...implementation, heapLimitBytes: getHeapStatistics().heap_size_limit },
    workload: { fixtureSha256: sha256(bytes), sourceDocuments: fixture.sourceVersionIds.length, supports: supports.length, targets: targetIndex.targets.length, targetIndexId: targetIndex.id },
    alignmentElapsedMs, measurements, artifactReport: null, artifactRecovery: values["artifact-dir"] ? "pending" : "not_requested", retainedArtifactDigest: artifactDigest,
    counts: { alternativeSets: sets.length, plans: sets.reduce((sum, set) => sum + set.hypotheses.length, 0), allocations: allocations.length, attemptedBranches: sets.reduce((sum, set) => sum + set.attemptedBranchCount, 0), omittedBranches: sets.reduce((sum, set) => sum + set.omittedSearchBranchCount, 0) },
    retention: { plans: retentionPolicy.stats(), allocations: allocationRetention.stats() },
    qualification: "This stage replay does not qualify a whole-machine 8 GB build or served answer quality."
  };
  await save(values.out, report);
  console.log(JSON.stringify({ retainedArtifactDigest: artifactDigest }));
  let artifactReport = null;
  if (values["artifact-dir"]) {
    const directory = resolve(values["artifact-dir"]);
    await mkdir(directory, { recursive: true });
    const ids = kernel.createIdFactory({ hasher, clock: kernel.createClock({ fixedTime: 1000 }), deterministicReplay: true });
    const blobs = {
      async put(content) { const hash = String(ids.contentHash(content)); await writeFile(resolve(directory, hash), content); return hash; },
      async get(hash) { if (!/^[a-zA-Z0-9_-]+$/.test(hash)) throw new Error("invalid blob hash"); return readFile(resolve(directory, hash)); },
      async exists(hash) { try { await this.get(hash); return true; } catch { return false; } }
    };
    const writeStarted = performance.now();
    const events = await kernel.buildBoundedAlignmentEvents({ episodeId: "episode.alignment-benchmark", payload, blobs, idFactory: ids, hashContent: content => String(ids.contentHash(content)) });
    await save(resolve(directory, "events.json"), events);
    const writeElapsedMs = performance.now() - writeStarted;
    // Recover each series independently under the normal production byte limits.
    const readStarted = performance.now();
    const seriesIds = [...new Set(sets.map(set => set.seriesId))];
    for (const seriesId of seriesIds) {
      const decoded = await kernel.readBoundedAlignmentPayload(events, blobs, content => String(ids.contentHash(content)), { seriesId });
      const expectedSets = sets.filter(set => set.seriesId === seriesId);
      const planIds = new Set(expectedSets.flatMap(set => set.hypotheses.map(hypothesis => hypothesis.plan.id)));
      const expected = { ...payload, alignmentAlternativeSets: expectedSets, transportEvidenceAllocations: allocations.filter(allocation => planIds.has(allocation.transportPlanId)) };
      if (kernel.canonicalDigestHex(decoded, hasher) !== kernel.canonicalDigestHex(expected, hasher)) throw new Error(`artifact recovery mismatch: ${seriesId}`);
      console.log(JSON.stringify({ recoveredSeries: seriesId }));
    }
    const parts = events.flatMap(event => event.artifactParts);
    artifactReport = { writeElapsedMs, readAndCompareElapsedMs: performance.now() - readStarted, events: events.length, parts: parts.length, emittedBytes: parts.reduce((sum, part) => sum + part.byteLength, 0), recoveredSeries: seriesIds.length, recoveredSets: sets.length, recoveredAllocations: allocations.length, maximumResidentKiB: process.resourceUsage().maxRSS };
  }
  await save(values.out, { ...report, artifactReport, artifactRecovery: artifactReport ? "passed" : "not_requested" });
}
