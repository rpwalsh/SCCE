// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { encodeSegmentationAdjacencyFactors, decodeSegmentationAdjacencyFactors, replaySegmentationScoreFactors,
  validateSegmentationScoreFactors, type SegmentationAdjacencyFactors, type SegmentationScoreFactors } from "@scce/kernel";

export const SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA = "scce.segmentation_score_graph.storage.v1";
const limits = { maxBytes: 64 * 1024 * 1024, maxNodes: 16 * 1024 * 1024, maxArcs: 4 * 1024 * 1024 };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw Error("invalid segmentation score graph storage"); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();

/** Original topology and frozen scorer decisions replace the calculated Float64 cache. */
export function encodeSegmentationScoreGraph(graph: SegmentationAdjacencyFactors, recipe: SegmentationScoreFactors): unknown {
  if (graph.nodeCount > limits.maxNodes || graph.arcs.length > limits.maxArcs) return fail();
  validateSegmentationScoreFactors(recipe, graph);
  const topology = encodeSegmentationAdjacencyFactors({ ...graph, arcs: graph.arcs.map(([start, end]) => [start, end, 0] as const) }, limits.maxBytes);
  const wire = JSON.stringify(recipe);
  if (Buffer.byteLength(wire) > limits.maxBytes) return fail();
  return { schema: SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA, topology: Buffer.from(topology).toString("base64"), topologyDigest: sha(topology), recipe: wire };
}

/** No fitting, candidate search or source acquisition occurs during reconstruction. */
export function decodeSegmentationScoreGraph(value: unknown): { graph: SegmentationAdjacencyFactors; recipe: SegmentationScoreFactors } {
  const row = record(value);
  if (Object.keys(row).sort().join(",") !== "recipe,schema,topology,topologyDigest" || row.schema !== SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA
    || typeof row.recipe !== "string" || Buffer.byteLength(row.recipe) > limits.maxBytes || typeof row.topology !== "string"
    || row.topology.length > Math.ceil(limits.maxBytes / 3) * 4 || row.topology.length % 4 || /[^A-Za-z0-9+/=]/u.test(row.topology)
    || typeof row.topologyDigest !== "string") return fail();
  const bytes = Buffer.from(row.topology, "base64");
  if (bytes.toString("base64") !== row.topology || sha(bytes) !== row.topologyDigest) return fail();
  const topology = decodeSegmentationAdjacencyFactors(bytes, limits);
  if (topology.arcs.some(([, , energy]) => !Object.is(energy, 0))) return fail();
  let recipe: SegmentationScoreFactors;
  try { recipe = JSON.parse(row.recipe) as SegmentationScoreFactors; } catch { return fail(); }
  const graph = replaySegmentationScoreFactors(recipe, topology.arcs.map(([start, end]) => [start, end]));
  if (graph.nodeCount !== topology.nodeCount) return fail();
  return { graph, recipe };
}
