// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSurfaceLattice, compileJoinProgram, joinProgramChoices } from "@scce/kernel";
import { decodeJoinFactorUnits, encodeJoinFactorUnits, JOIN_FACTOR_UNITS_STORAGE_SCHEMA,
  type JoinFactorUnit, type StoredJoinFactorUnits } from "../join-factor-unit-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function checksum(value: StoredJoinFactorUnits): StoredJoinFactorUnits {
  value.digest = createHash("sha256").update(JSON.stringify({ schema: value.schema, count: value.count, width: value.width, dictionary: value.dictionary }))
    .update(Buffer.from(value.refs, "base64")).digest("hex");
  return value;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

describe("exact typed JOIN factor unit storage", () => {
  it("retains nulls, tuple arity, unsorted evidence order and every safe integer offset", () => {
    const logical: JoinFactorUnit[] = [null, [0, 0, []], [2, 7, [3, 1]],
      [Number.MAX_SAFE_INTEGER, 7, [0, Number.MAX_SAFE_INTEGER], 17, Number.MAX_SAFE_INTEGER], null, [2, 7, [3, 1]]];
    const before = JSON.stringify(logical), stored = encodeJoinFactorUnits(freeze(logical));
    expect(stored.schema).toBe(JOIN_FACTOR_UNITS_STORAGE_SCHEMA);
    expect(stored.dictionary).toHaveLength(4);
    expect(stored.width).toBe(1);
    expect(Buffer.from(stored.refs, "base64").length).toBe(logical.length);
    expect(decodeJoinFactorUnits(cold(stored))).toEqual(logical);
    expect(JSON.stringify(logical)).toBe(before);
    expect(encodeJoinFactorUnits(decodeJoinFactorUnits(cold(stored)))).toEqual(stored);
  });

  it("isolates restored occurrences and snapshots the input definition", () => {
    const row: JoinFactorUnit = [2, 4, [7, 3], 2, 5], logical = [row, null, row, row];
    const stored = encodeJoinFactorUnits(logical);
    row[2][0] = 99;
    expect(stored.dictionary[0]![2]).toEqual([7, 3]);
    const restored = decodeJoinFactorUnits(cold(stored));
    restored[0]![2][0] = 88;
    expect(restored[2]![2]).toEqual([7, 3]);
    expect(restored[3]![2]).toEqual([7, 3]);
    expect(stored.dictionary[0]![2]).toEqual([7, 3]);
  });

  it.each([[256, 1], [257, 2], [65537, 4]] as const)("crosses the %i-entry reference width boundary without truncating IDs", (count, width) => {
    const logical: JoinFactorUnit[] = Array.from({ length: count }, (_, index) => [index, index % 8, [0]]);
    logical.push(logical[0]!, logical.at(-1)!);
    const stored = encodeJoinFactorUnits(logical);
    expect(stored.dictionary).toHaveLength(count);
    expect(stored.width).toBe(width);
    expect(Buffer.from(stored.refs, "base64").length).toBe(logical.length * width);
    expect(decodeJoinFactorUnits(cold(stored))).toEqual(logical);
  });

  it("has one canonical empty representation and checks unit limits before decoding", () => {
    const empty = encodeJoinFactorUnits([]);
    expect(empty).toMatchObject({ count: 0, width: 1, dictionary: [], refs: "" });
    expect(decodeJoinFactorUnits(cold(empty), 0)).toEqual([]);
    const stored = encodeJoinFactorUnits([null, [0, 0, [0]]]);
    for (const limit of [0, 1, -1, Infinity, 4 * 1024 * 1024 + 1]) expect(() => decodeJoinFactorUnits(stored, limit)).toThrow(/JOIN factor unit/u);
    expect(decodeJoinFactorUnits(stored, 2)).toEqual([null, [0, 0, [0]]]);
  });

  it("rejects corrupted, truncated, noncanonical, reordered or unused dictionaries even with valid checksums", () => {
    const source = encodeJoinFactorUnits([null, [0, 0, [0]], null]);
    const mutations: Array<(value: StoredJoinFactorUnits) => void> = [
      value => { value.refs = value.refs.slice(0, -4); },
      value => { value.refs += "AAAA"; },
      value => { value.refs += "\n"; },
      value => { value.count++; },
      value => { value.width = 2; },
      value => { value.dictionary[1]![1] = 8; },
      value => { value.refs = Buffer.from([0, 2, 0]).toString("base64"); checksum(value); },
      value => { value.dictionary.push([0, 1, []]); checksum(value); },
      value => { value.dictionary[1] = null; checksum(value); },
      value => { value.refs = Buffer.from([1, 0, 1]).toString("base64"); checksum(value); },
      value => { Object.assign(value, { unknown: true }); },
      value => { value.digest = "0".repeat(64); }
    ];
    for (const mutate of mutations) {
      const invalid = cold(source); mutate(invalid);
      expect(() => decodeJoinFactorUnits(invalid)).toThrow(/JOIN factor unit/u);
    }
    const invalidEmpty = checksum({ ...encodeJoinFactorUnits([]), dictionary: [null] });
    expect(() => decodeJoinFactorUnits(invalidEmpty)).toThrow(/JOIN factor unit/u);
  });

  it("rejects invalid tuples, accessors and expansion bombs without normalizing their contents", () => {
    for (const row of [[0, 8, []], [-1, 0, []], [0.5, 0, []], [-0, 0, []], [0, 0, [1, 1]],
      [0, 0, [1.5]], [0, 0, [], 5, 5], [0, 0, [], 2, 1], [0, 0, [], 0, Infinity], [0, 0]]) {
      expect(() => encodeJoinFactorUnits([row as JoinFactorUnit])).toThrow(/JOIN factor unit/u);
    }
    const sparse = new Array(3); sparse[0] = 0; sparse[1] = 0;
    expect(() => encodeJoinFactorUnits([sparse as JoinFactorUnit])).toThrow(/JOIN factor unit/u);
    const accessor = [0, 0, []];
    Object.defineProperty(accessor, 2, { get() { throw Error("getter evaluated"); }, enumerable: true });
    expect(() => encodeJoinFactorUnits([accessor as JoinFactorUnit])).toThrow("invalid JOIN factor unit storage");
    const bomb = checksum({ schema: JOIN_FACTOR_UNITS_STORAGE_SCHEMA, count: 5000, width: 1,
      dictionary: [[0, 0, Array.from({ length: 4096 }, (_, index) => index)]],
      refs: Buffer.alloc(5000).toString("base64"), digest: "" });
    expect(() => decodeJoinFactorUnits(bomb)).toThrow(/JOIN factor unit/u);
  });

  it("preserves real full-DAG Unicode source proofs and subgrapheme exceptions through a cold round trip", () => {
    const text = "মল্লি z 🧪é", documentId = "source.unicode", lattice = buildSurfaceLattice({ documentId,
      sourceVersionId: "version.unicode", text, evidenceIds: ["evidence.α", "evidence.雪"] });
    const program = compileJoinProgram({ populationId: "population.unicode", documents: [{ documentId, text, lattice }] });
    const source = program.localFactors!.documents[0]!, original = cold(source.units);
    expect(source.units.some(unit => unit?.length === 5)).toBe(true);
    const stored = encodeJoinFactorUnits(freeze(source.units));
    const restored = { ...program, localFactors: { ...program.localFactors!, documents: [{ ...source, units: decodeJoinFactorUnits(cold(stored)) }] } };
    expect(restored.localFactors.documents[0]!.units).toEqual(original);
    const left = lattice.units.find(unit => unit.kind === "code_symbol")!, right = lattice.units.find(unit => unit.surface === "z")!;
    const key = JSON.stringify([left.normalized, right.normalized]), expected = joinProgramChoices(program, "exact", key);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.flatMap(choice => choice.evidenceCoordinates).length).toBeGreaterThan(0);
    expect(joinProgramChoices(restored, "exact", key)).toEqual(expected);
    expect(source.units).toEqual(original);
  });
});
