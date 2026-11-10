// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { beforeAll, describe, expect, it } from "vitest";
import { buildSurfaceLattice, compileJoinProgram, compileJoinProgramMixture, createHasher, createLanguageInductionEngine,
  semanticInductionProjection, type JsonValue } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { decodeDurableJoinPrograms, encodeDurableJoinPrograms, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY,
  DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const row = (value: unknown) => value as Record<string, unknown>;
const fixtures: Record<string, Record<string, unknown>> = {};
let mixture: unknown;
beforeAll(() => {
  const text = "Alice follows Bob. Bob follows Alice. Mira directs Neralis. 雪と海 🧭 e\u0301.";
  const documentId = "document.owned", lattice = buildSurfaceLattice({ documentId, text, evidenceIds: ["evidence.owned"] });
  const program = compileJoinProgram({ populationId: "population.owned", documents: [{ documentId, text, lattice }] });
  mixture = compileJoinProgramMixture({ populationModelId: "population.owned", components: [{ populationId: program.populationId, weight: 1, program }] });
  const hasher = createHasher(), model = createLanguageInductionEngine({ hasher }).induce({ documents: [
    { id: documentId, text, evidenceIds: ["evidence.owned" as never], trust: 0.8 }
  ] });
  const material = { semanticFrames: model.semanticFrames, graphBoundConstructions: model.graphBoundConstructions,
    lexicalClasses: model.lexicalClasses, relationHypothesisModel: model.relationHypothesisModel };
  const metadata = { unicode: "雪 🧭 e\u0301 \u0000 \ud800", tiny: 1e-200 };
  fixtures.graph = { ...metadata, graph: { schema: "scce.segmentation_adjacency_factors.v1", nodeCount: 2, arcs: [[0, 1, 0.5]] } };
  fixtures.JOIN = { ...metadata, joinProgram: mixture };
  fixtures.semantic = { ...metadata, schema: "scce.induced_language_model.semantic_memory.v1", ...material,
    semanticInductionProjection: semanticInductionProjection({ ...material, factors: model.semanticInductionFactors!, hasher }) };
});

async function readPayload(payload: unknown): Promise<JsonValue> {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "ledger_integrity" });
  adapter.query = async <T>(sql: string): Promise<T[]> => {
    expect(sql).toContain('"events"');
    return [{ id: "event", episode_id: "episode", type_id: "test", t: "1", payload_json: cold(payload), parents: [], hash: "hash" }] as unknown as T[];
  };
  try { return (await adapter.events.readEpisode("episode" as never))[0]!.payload; }
  finally { await adapter.close(); }
}

describe("canonical public read byte ledger integrity without creative or decision references", () => {
  for (const family of ["graph", "JOIN", "semantic"]) {
    it(`cold restores a valid ${family} payload with Unicode and exponent-form numeric metadata`, async () => {
      const logical = fixtures[family]!, stored = encodeDurableJoinPrograms(logical);
      expect(row(stored)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(logical));
      expect(await readPayload(stored)).toEqual(cold(logical));
    });
    it.each(["decodedJsonBytes", "decodedJsonbBytes"])(`rejects a forged %s on a ${family}-only payload`, async key => {
      const stored = cold(row(encodeDurableJoinPrograms(fixtures[family]!)));
      const ledger = row(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
      ledger[key] = Number(ledger[key]) - 1;
      // Keep both charges structurally valid: rejection must compare with the restored body.
      expect(Number(ledger.decodedJsonBytes)).toBeGreaterThan(0);
      expect(Number(ledger.decodedJsonbBytes)).toBeGreaterThanOrEqual(Number(ledger.decodedJsonBytes));
      await expect(readPayload(stored)).rejects.toThrow(/byte ledger/u);
    });
    it(`rejects a forged JOIN member charge on a ${family}-only payload`, async () => {
      const stored = cold(row(encodeDurableJoinPrograms(fixtures[family]!)));
      row(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).joinProgramMemberJsonbBytes = 1;
      await expect(readPayload(stored)).rejects.toThrow(/byte ledger/u);
    });
  }
  it.each(["decodedJsonBytes", "decodedJsonbBytes"])("rejects tampered %s on a top-level durable JOIN marker", key => {
    const stored = cold(row(encodeDurableJoinPrograms(mixture)));
    expect(stored.schema).toBe(DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA);
    expect(decodeDurableJoinPrograms(cold(stored))).toEqual(mixture);
    stored[key] = Number(stored[key]) + 1;
    expect(() => decodeDurableJoinPrograms(stored)).toThrow(/JOIN storage byte sizes/u);
  });
});
