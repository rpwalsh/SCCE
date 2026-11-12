// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { clamp01 } from "./primitives.js";

export const SEGMENTATION_ADJACENCY_FACTORS_SCHEMA = "scce.segmentation_adjacency_factors.v1" as const;
export interface SegmentationAdjacencyFactors {
  schema: typeof SEGMENTATION_ADJACENCY_FACTORS_SCHEMA;
  nodeCount: number;
  arcs: ReadonlyArray<readonly [startGrapheme: number, endGrapheme: number, energy: number]>;
}
export interface SegmentationFactorAdjacency { leftArcIndex: number; rightArcIndex: number; posterior: number }
export interface SegmentationAdjacencySelection { leftArcIndices?: ReadonlySet<number>; rightArcIndices?: ReadonlySet<number> }
const fail = (): never => { throw new Error("invalid segmentation adjacency factors"); };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Only original graph geometry and learned arc energies are durable state. */
export function validateSegmentationAdjacencyFactors(value: unknown): asserts value is SegmentationAdjacencyFactors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (row.schema !== SEGMENTATION_ADJACENCY_FACTORS_SCHEMA || Object.keys(row).some(key => !["schema", "nodeCount", "arcs"].includes(key))
    || !Number.isSafeInteger(row.nodeCount) || (row.nodeCount as number) < 1 || !Array.isArray(row.arcs)) return fail();
  for (const item of row.arcs) {
    if (!Array.isArray(item) || item.length !== 3 || !Number.isSafeInteger(item[0]) || !Number.isSafeInteger(item[1])
      || item[0] < 0 || item[1] <= item[0] || item[1] >= (row.nodeCount as number) || !finite(item[2])) return fail();
  }
}

/** A caller-owned index answers selected contexts without materializing all adjacent pairs. */
export function createSegmentationAdjacencyQuery(input: SegmentationAdjacencyFactors, surfaceBearingArcIndices: ReadonlySet<number>): {
  pairs(selection?: SegmentationAdjacencySelection): Iterable<SegmentationFactorAdjacency>;
} {
  validateSegmentationAdjacencyFactors(input);
  const nodeCount = input.nodeCount;
  const arcs = input.arcs.map(arc => [arc[0], arc[1], arc[2]] as const);
  const bearing = new Set(surfaceBearingArcIndices);
  for (const index of bearing) if (!Number.isSafeInteger(index) || !arcs[index]) return fail();
  const outgoing = new Map<number, number[]>();
  arcs.forEach(([start], index) => { const bucket = outgoing.get(start) ?? []; bucket.push(index); outgoing.set(start, bucket); });
  const forward = new Array<number>(nodeCount).fill(Number.NEGATIVE_INFINITY), backward = [...forward];
  forward[0] = 0; backward[nodeCount - 1] = 0;
  for (let position = 0; position < nodeCount; position++) {
    if (!Number.isFinite(forward[position]!)) continue;
    for (const index of outgoing.get(position) ?? []) {
      const [, end, energy] = arcs[index]!;
      forward[end] = logAddExp(forward[end]!, forward[position]! - energy);
    }
  }
  for (let position = nodeCount - 1; position >= 0; position--) for (const index of outgoing.get(position) ?? []) {
    const [, end, energy] = arcs[index]!;
    backward[position] = logAddExp(backward[position]!, -energy + backward[end]!);
  }
  const partitionLogZ = forward[nodeCount - 1]!;
  function* pairs(selection: SegmentationAdjacencySelection = {}): Iterable<SegmentationFactorAdjacency> {
    if (!Number.isFinite(partitionLogZ)) return;
    const leftIndices = selection.leftArcIndices ? new Set(selection.leftArcIndices) : bearing;
    const rightIndices = selection.rightArcIndices ? new Set(selection.rightArcIndices) : undefined;
    if (!leftIndices.size || rightIndices?.size === 0) return;
    for (const leftIndex of leftIndices) {
      if (!bearing.has(leftIndex)) continue;
      const left = arcs[leftIndex]!, prefix = forward[left[0]]!;
      if (!Number.isFinite(prefix)) continue;
      const bridges = new Map<number, number>([[left[1], 0]]), pending = [left[1]];
      while (pending.length) {
        const position = popCoordinate(pending), bridge = bridges.get(position)!;
        for (const rightIndex of outgoing.get(position) ?? []) {
          const right = arcs[rightIndex]!;
          if (bearing.has(rightIndex)) {
            if (rightIndices && !rightIndices.has(rightIndex)) continue;
            const suffix = backward[right[1]]!;
            if (!Number.isFinite(suffix)) continue;
            const posterior = clamp01(Math.exp(prefix - left[2] + bridge - right[2] + suffix - partitionLogZ));
            if (posterior > 0) yield { leftArcIndex: leftIndex, rightArcIndex: rightIndex, posterior };
          } else {
            const previous = bridges.get(right[1]);
            bridges.set(right[1], logAddExp(previous ?? Number.NEGATIVE_INFINITY, bridge - right[2]));
            if (previous === undefined) pushCoordinate(pending, right[1]);
          }
        }
      }
    }
  }
  return Object.freeze({ pairs });
}

function logAddExp(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}
function pushCoordinate(heap: number[], value: number): void {
  let index = heap.length;
  heap.push(value);
  while (index) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= value) break;
    heap[index] = heap[parent]!; index = parent;
  }
  heap[index] = value;
}
function popCoordinate(heap: number[]): number {
  const first = heap[0]!, last = heap.pop()!;
  if (heap.length) {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1]! < heap[child]!) child++;
      if (heap[child]! >= last) break;
      heap[index] = heap[child]!; index = child;
    }
    heap[index] = last;
  }
  return first;
}
