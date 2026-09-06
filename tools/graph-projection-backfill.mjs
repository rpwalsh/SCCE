#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Project promoted evidence into the graph for sources ingestion admitted but never projected.
//
// Graph projection runs inside ingest and is gated by the admission decision's `activeInfluence.graph`. On the live
// brain that gate left 21,254 of 38,659 promoted Wikipedia spans -- 55% of the corpus -- with evidence rows and no
// graph nodes. The consequence is not a missing feature but an absent one: `graphForText` resolves its slice from the
// admitted evidence ids, so an anchored request whose article was never projected receives a zero-node graph, and
// PowerWalk, relation potential, diffusion and every cognitive draft producer downstream run over nothing. Measured
// live: "Was Ada Lovelace alive at the same time as Charles Babbage?" admitted 10 spans and reached the cognitive
// planner with graphNodes:0, which is why the only lane that could answer was reading one span out verbatim.
//
// This re-runs the same projector ingest uses, over the same evidence rows, and upserts what it produces. It reads
// the source text from the stored blob so the projection sees exactly what ingest saw.
import { createIdFactory, createHasher, createTypedIngestProjector } from "../packages/kernel/dist/index.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const limit = Number(flag("limit", "50"));
const uriLike = flag("uri", undefined);
const apply = args.includes("--apply");
const configPath = flag("config", "scce.config.json");

const config = await readScceRuntimeConfig(configPath);
const runtime = createNodeRuntime(config);
const storage = runtime.storage;
const hasher = createHasher();
const idFactory = createIdFactory({ clock: { now: () => Date.now() }, hasher, namespace: "graph-projection-backfill" });
const projector = createTypedIngestProjector({ idFactory, hasher });

// Source versions holding promoted evidence that no graph node references.
const unprojected = await storage.query(`
  SELECT e.source_id, e.source_version_id, COUNT(*) AS spans, MIN(s.canonical_uri) AS uri
  FROM ${storage.table("evidence_spans")} e
  JOIN ${storage.table("sources")} s ON s.id = e.source_id
  WHERE e.status = 'promoted'
    ${uriLike ? "AND s.canonical_uri LIKE $2" : ""}
    AND NOT EXISTS (
      SELECT 1 FROM ${storage.table("graph_nodes")} g WHERE g.evidence_ids && ARRAY[e.id]
    )
  GROUP BY e.source_id, e.source_version_id
  ORDER BY COUNT(*) DESC
  LIMIT $1`, uriLike ? [limit, uriLike] : [limit]);

process.stdout.write(`${unprojected.length} source versions with unprojected promoted evidence${apply ? "" : " (dry run; pass --apply to write)"}\n`);

let projectedNodes = 0;
let projectedEdges = 0;
let projectedHyperedges = 0;
let done = 0;
for (const row of unprojected) {
  const spans = await storage.evidence.listBySourceVersion
    ? await storage.evidence.listBySourceVersion(row.source_version_id)
    : (await storage.evidence.searchEvidence({ sourceVersionId: row.source_version_id, status: "promoted", limit: 4096 })).map(item => item.span);
  const promoted = spans.filter(span => span.status === "promoted");
  if (!promoted.length) continue;

  // Ingest projected from the whole source text; the concatenated span text is what survives durably and is what the
  // graph must be consistent with, so it is what this projects from.
  const text = promoted
    .slice()
    .sort((left, right) => Number(left.charStart) - Number(right.charStart))
    .map(span => String(span.text ?? ""))
    .join("\n");
  if (!text.trim()) continue;

  const provenance = promoted[0]?.provenance ?? {};
  const metadata = (provenance && typeof provenance === "object" && !Array.isArray(provenance)
    ? provenance.metadata ?? {}
    : {});

  const projection = projector.project({
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    uri: String(row.uri),
    mediaType: String(promoted[0]?.mediaType ?? "text/plain"),
    text,
    metadata,
    evidence: promoted,
    observedAt: Date.now()
  });

  projectedNodes += projection.graphNodes.length;
  projectedEdges += projection.graphEdges.length;
  projectedHyperedges += projection.graphHyperedges.length;

  if (apply && projection.graphNodes.length) {
    const label = promoted[0]?.informationLabel;
    const labelled = records => label ? records.map(record => ({ ...record, informationLabel: label })) : records;
    if (storage.graph.upsertNodes) await storage.graph.upsertNodes(labelled(projection.graphNodes));
    else for (const node of labelled(projection.graphNodes)) await storage.graph.upsertNode(node);
    if (projection.graphEdges.length) {
      if (storage.graph.upsertEdges) await storage.graph.upsertEdges(labelled(projection.graphEdges));
      else for (const edge of labelled(projection.graphEdges)) await storage.graph.upsertEdge(edge);
    }
    if (projection.graphHyperedges.length && storage.graph.upsertHyperedges) {
      await storage.graph.upsertHyperedges(labelled(projection.graphHyperedges));
    }
  }
  done++;
  if (done % 10 === 0) process.stdout.write(`  ${done}/${unprojected.length} sources, ${projectedNodes} nodes\n`);
}

process.stdout.write(`${JSON.stringify({
  schema: "scce.graph_projection_backfill.v1",
  sourceVersions: unprojected.length,
  projectedNodes,
  projectedEdges,
  projectedHyperedges,
  applied: apply
})}\n`);
await runtime.close();
