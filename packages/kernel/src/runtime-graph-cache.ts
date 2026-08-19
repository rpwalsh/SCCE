import { uniqueKernelStrings } from "./kernel-answer-primitives.js";
import type {
  EvidenceSpan,
  GraphSlice,
  JsonValue
} from "./types.js";




export type RuntimeGraphSliceValue = {
  graph: GraphSlice;
  evidence: EvidenceSpan[];
  semanticFrameBoundEvidenceIds?: string[];
};


export function positiveRuntimeInt(name: string, fallback: number): number {
  const raw = runtimeEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


export function runtimeFlag(name: string, fallback: boolean): boolean {
  const raw = runtimeEnv(name);
  if (!raw) return fallback;
  const clean = raw.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(clean)) return false;
  if (["1", "true", "on", "yes"].includes(clean)) return true;
  return fallback;
}


 function runtimeEnv(name: string): string | undefined {
  const globalWithProcess = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return globalWithProcess.process?.env?.[name];
}


export function estimateRuntimeGraphSliceBytes(value: RuntimeGraphSliceValue): number {
  let bytes = 2048;
  for (const node of value.graph.nodes) {
    bytes += 280;
    bytes += String(node.id).length * 2 + String(node.typeId).length * 2;
    bytes += node.features.reduce((sum, feature) => sum + feature.length * 2 + 24, 0);
    bytes += node.evidenceIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(node.representation, 4096) + estimateJsonBytes(node.metadata, 4096);
  }
  for (const edge of value.graph.edges) {
    bytes += 260;
    bytes += String(edge.id).length * 2 + String(edge.source).length * 2 + String(edge.target).length * 2 + String(edge.relationId).length * 2;
    bytes += edge.evidenceIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(edge.metadata, 2048);
  }
  for (const hyperedge of value.graph.hyperedges) {
    bytes += 220;
    bytes += String(hyperedge.id).length * 2 + String(hyperedge.relationId).length * 2;
    bytes += hyperedge.memberNodeIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += hyperedge.provenanceRefs.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(hyperedge.weightVector, 2048) + estimateJsonBytes(hyperedge.temporalScope, 2048);
  }
  for (const span of value.evidence) {
    bytes += 360;
    bytes += String(span.id).length * 2 + String(span.sourceId).length * 2 + String(span.sourceVersionId).length * 2;
    bytes += (span.text?.length ?? 0) * 2 + (span.textPreview?.length ?? 0) * 2;
    bytes += span.features.reduce((sum, feature) => sum + feature.length * 2 + 24, 0);
    bytes += estimateJsonBytes(span.languageHints, 2048) + estimateJsonBytes(span.scriptHints, 2048) + estimateJsonBytes(span.trustVector, 2048) + estimateJsonBytes(span.provenance, 4096);
  }
  bytes += (value.semanticFrameBoundEvidenceIds ?? []).reduce((sum, id) => sum + id.length * 2 + 16, 0);
  return bytes;
}


/**
 * The result is capped, so fully serializing the value to then clamp it is
 * work thrown away: a node carrying a megabyte of metadata was serialized in
 * full to return 4096. Profiled at 5-6% of a turn's wall clock -- more than
 * the cache it accounts for saves on some turns.
 *
 * This walks the value and stops as soon as the cap is reached, which
 * returns the identical clamped answer for anything at or above the cap and
 * a close structural approximation below it. Both bounds matter: `cap`
 * bounds the arithmetic, and the visit budget bounds traversal of a wide or
 * cyclic object (JSON.stringify threw on cycles and was caught; a walker
 * would otherwise spin).
 */
function estimateJsonBytes(value: JsonValue | undefined, cap: number): number {
  if (value === undefined || value === null) return 0;
  let bytes = 0;
  let visits = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && bytes < cap && visits < 4096) {
    visits++;
    const current = pending.pop();
    if (current === undefined || current === null) {
      bytes += 4;
      continue;
    }
    if (typeof current === "string") {
      bytes += current.length * 2 + 2;
      continue;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      bytes += 12;
      continue;
    }
    if (Array.isArray(current)) {
      bytes += 16;
      for (const item of current) {
        pending.push(item);
        if (pending.length >= 4096) break;
      }
      continue;
    }
    if (typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        bytes += key.length * 2 + 8;
        pending.push(item);
        if (pending.length >= 4096) break;
      }
    }
  }
  return Math.min(cap, bytes);
}


export function fitRuntimeGraphSliceToBudget(value: RuntimeGraphSliceValue, budgetBytes: number): RuntimeGraphSliceValue {
  let current = value;
  let bytes = estimateRuntimeGraphSliceBytes(current);
  let nodeLimit = current.graph.nodes.length;
  let edgeLimit = current.graph.edges.length;
  let evidenceLimit = current.evidence.length;
  while (bytes > budgetBytes && nodeLimit > 256) {
    nodeLimit = Math.max(256, Math.floor(nodeLimit * 0.74));
    edgeLimit = Math.max(512, Math.floor(edgeLimit * 0.74));
    evidenceLimit = Math.max(128, Math.floor(evidenceLimit * 0.74));
    current = limitRuntimeGraphSlice(value, nodeLimit, edgeLimit, evidenceLimit);
    bytes = estimateRuntimeGraphSliceBytes(current);
  }
  return current;
}


 function limitRuntimeGraphSlice(value: RuntimeGraphSliceValue, nodeLimit: number, edgeLimit: number, evidenceLimit: number): RuntimeGraphSliceValue {
  const nodes = value.graph.nodes.slice(0, nodeLimit);
  const nodeIds = new Set(nodes.map(node => String(node.id)));
  const edges = value.graph.edges
    .filter(edge => nodeIds.has(String(edge.source)) || nodeIds.has(String(edge.target)))
    .slice(0, edgeLimit);
  const hyperedges = value.graph.hyperedges
    .filter(edge => edge.memberNodeIds.some(nodeId => nodeIds.has(String(nodeId))))
    .slice(0, Math.max(64, Math.floor(edgeLimit / 4)));
  const evidenceIds = new Set(uniqueKernelStrings([
    ...nodes.flatMap(node => node.evidenceIds.map(String)),
    ...edges.flatMap(edge => edge.evidenceIds.map(String)),
    ...hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
  ]));
  const evidence = value.evidence.filter(span => evidenceIds.has(String(span.id))).slice(0, evidenceLimit);
  const retainedEvidenceIds = new Set(evidence.map(span => String(span.id)));
  return {
    graph: {
      ...value.graph,
      nodes,
      edges,
      hyperedges,
      query: { ...value.graph.query, limitNodes: nodeLimit, limitEdges: edgeLimit }
    },
    evidence,
    semanticFrameBoundEvidenceIds: value.semanticFrameBoundEvidenceIds?.filter(id => retainedEvidenceIds.has(id))
  };
}


export function uniqueById<T extends { id: unknown }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const id = String(value.id);
    if (!byId.has(id)) byId.set(id, value);
  }
  return [...byId.values()];
}
