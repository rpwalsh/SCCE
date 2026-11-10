// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, validateSegmentationAdjacencyFactors, type SegmentationAdjacencyFactors } from "./segmentation-adjacency-factors.js";

const MAGIC = [0x53, 0x43, 0x44, 0x47, 1] as const;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (): never => { throw Error("invalid or over-budget segmentation graph encoding"); };
export interface SegmentationGraphDecodeLimits { maxBytes: number; maxNodes: number; maxArcs: number }
const natural = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const energyKey = (value: number): number | "negative-zero" => Object.is(value, -0) ? "negative-zero" : value;

/** SCDG/1: ordered delta/width/energy references and an exact little-endian Float64 codebook. */
export function encodeSegmentationAdjacencyFactors(value: SegmentationAdjacencyFactors, maxBytes: number): Uint8Array {
  validateSegmentationAdjacencyFactors(value);
  if (!natural(maxBytes) || maxBytes < MAGIC.length + 3 || value.arcs.length > Math.floor((maxBytes - MAGIC.length - 3) / 3)) return fail();
  const energies: number[] = [], indexes = new Map<number | "negative-zero", number>();
  for (const [, , energy] of value.arcs) {
    const key = energyKey(energy);
    if (!indexes.has(key)) {
      if ((energies.length + 1) * 8 + MAGIC.length > maxBytes) return fail();
      indexes.set(key, energies.length); energies.push(energy);
    }
  }
  // Typed growth keeps temporary storage proportional to the encoded page, rather than a boxed number per byte.
  let output = new Uint8Array(Math.min(maxBytes, MAGIC.length + 24 + energies.length * 8 + value.arcs.length * 3)), length = 0;
  const byte = (value: number) => {
    if (length >= maxBytes) return fail();
    if (length === output.length) {
      const expanded = new Uint8Array(Math.min(maxBytes, Math.max(length + 1, output.length * 2)));
      expanded.set(output); output = expanded;
    }
    output[length++] = value;
  };
  const unsigned = (value: bigint) => {
    do { const part = Number(value & 127n); value >>= 7n; byte(part | (value ? 128 : 0)); } while (value);
  };
  MAGIC.forEach(byte);
  unsigned(BigInt(value.nodeCount)); unsigned(BigInt(value.arcs.length)); unsigned(BigInt(energies.length));
  const scratch = new DataView(new ArrayBuffer(8));
  for (const energy of energies) {
    scratch.setFloat64(0, energy, true);
    for (let i = 0; i < 8; i++) byte(scratch.getUint8(i));
  }
  let previousStart = 0n;
  for (const [start, end, energy] of value.arcs) {
    const current = BigInt(start), delta = current - previousStart;
    unsigned(delta < 0n ? -delta * 2n - 1n : delta * 2n);
    unsigned(BigInt(end - start)); unsigned(BigInt(indexes.get(energyKey(energy))!));
    previousStart = current;
  }
  return output.slice(0, length);
}

/** Caller limits cover the encoded input and the full reconstructed graph independently. */
export function decodeSegmentationAdjacencyFactors(input: Uint8Array, limits: SegmentationGraphDecodeLimits): SegmentationAdjacencyFactors {
  if (!(input instanceof Uint8Array) || !natural(limits.maxBytes) || !natural(limits.maxArcs)
    || !natural(limits.maxNodes) || limits.maxNodes < 1 || input.length > limits.maxBytes || input.length < MAGIC.length
    || MAGIC.some((value, index) => input[index] !== value)) return fail();
  let cursor = MAGIC.length;
  const unsigned = (maximum: bigint): bigint => {
    let value = 0n, shift = 0n;
    for (let count = 0; count < 8; count++) {
      if (cursor >= input.length) return fail();
      const part = input[cursor++]!;
      value |= BigInt(part & 127) << shift;
      if (!(part & 128)) {
        if (count && !(part & 127) || value > maximum) return fail();
        return value;
      }
      shift += 7n;
    }
    return fail();
  };
  const nodeCount = Number(unsigned(BigInt(limits.maxNodes))), arcCount = Number(unsigned(BigInt(limits.maxArcs)));
  const energyCount = Number(unsigned(BigInt(arcCount)));
  if (nodeCount < 1 || energyCount > Math.floor((input.length - cursor) / 8)
    || arcCount > Math.floor((input.length - cursor - energyCount * 8) / 3)) return fail();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength), energies: number[] = [];
  const distinct = new Set<number | "negative-zero">();
  for (let i = 0; i < energyCount; i++) {
    const energy = view.getFloat64(cursor, true); cursor += 8;
    if (!Number.isFinite(energy) || distinct.has(energyKey(energy))) return fail();
    distinct.add(energyKey(energy)); energies.push(energy);
  }
  const arcs: Array<readonly [number, number, number]> = [];
  let previousStart = 0n, usedEnergies = 0;
  for (let i = 0; i < arcCount; i++) {
    const encodedDelta = unsigned(MAX_INTEGER * 2n);
    const delta = encodedDelta & 1n ? -(encodedDelta + 1n) / 2n : encodedDelta / 2n;
    const start = previousStart + delta, width = unsigned(MAX_INTEGER), energyIndex = Number(unsigned(BigInt(Math.max(0, energyCount - 1))));
    if (start < 0n || start > MAX_INTEGER || width < 1n || start + width >= BigInt(nodeCount)
      || energyIndex >= energyCount || energyIndex > usedEnergies) return fail();
    if (energyIndex === usedEnergies) usedEnergies++;
    arcs.push([Number(start), Number(start + width), energies[energyIndex]!]); previousStart = start;
  }
  if (cursor !== input.length || usedEnergies !== energyCount) return fail();
  return { schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount, arcs };
}
