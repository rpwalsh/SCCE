// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildSurfaceLattice, compileJoinProgram, compileJoinProgramMixture, createHasher, hashEvent,
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, deriveCreativeSourceCorrespondence,
  joinProgramChoices, joinProgramMixtureStorageForm, renderJoinedSurface, SEGMENTATION_ADJACENCY_FACTORS_SCHEMA,
  type ScceEvent } from "@scce/kernel";
import { decodeDurableJoinPrograms, durableJoinProgramJsonByteLengths, encodeDurableJoinPrograms,
  DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY } from "../durable-join-program-storage.js";
import { SEMANTIC_MEMORY_SCHEMA } from "../semantic-frame-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const graph = () => ({ schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount: 2001,
  arcs: Array.from({ length: 2000 }, (_, index) => [index, index + 1, index % 3 / 4] as const) });
function mixture() {
  const documentId = "document.unicode", text = "猫 chased 🧪. 猫 chased 🧪.";
  const lattice = buildSurfaceLattice({ documentId, sourceVersionId: "version.owned", text, evidenceIds: ["evidence.owned"] });
  const program = compileJoinProgram({ populationId: "population.owned", documents: [{ documentId, text, lattice,
    constructionId: "construction.owned", discourseStateId: "discourse.owned" }] });
  return compileJoinProgramMixture({ populationModelId: "population.owned", components: [{ populationId: program.populationId, weight: 1, program }] });
}

describe("composed durable JOIN and graph storage", () => {
  it("cold restores raw and intentional packed JOIN values with one original logical byte ledger", () => {
    const raw = mixture();
    for (const joinProgram of [raw, joinProgramMixtureStorageForm(raw)]) {
      const original = { schema: "scce.induced_language_model.syntax_memory.v1", joinProgram, extraGraph: graph(), retained: "é\u0000雪" };
      const stored = encodeDurableJoinPrograms(original) as Record<string, unknown>;
      expect(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
      const ledger = stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] as Record<string, number>;
      const { joinProgram: _join, ...seed } = original;
      expect(ledger.decodedJsonbBytes! - ledger.joinProgramMemberJsonbBytes!).toBe(durableJoinProgramJsonByteLengths(seed).decodedJsonbBytes);
      expect(JSON.stringify(stored)).toContain("scce.segmentation_graph.storage.v1");
      expect(JSON.stringify(stored)).not.toContain('"schema":"scce.segmentation_adjacency_factors.v1"');
      expect(bytes(stored)).toBeLessThan(bytes(original));
      expect(decodeDurableJoinPrograms(cold(stored))).toEqual(original);
      expect(encodeDurableJoinPrograms(stored)).toBe(stored);
    }
    // An intentionally packed mixture is restored as packed even at the root.
    const packed = joinProgramMixtureStorageForm(raw);
    expect(decodeDurableJoinPrograms(cold(encodeDurableJoinPrograms(packed)))).toEqual(packed);
    const restored = decodeDurableJoinPrograms<typeof raw>(cold(encodeDurableJoinPrograms(raw)));
    expect(restored).toEqual(raw);
    expect(renderJoinedSurface(["猫", "chased", "🧪"], restored)).toEqual(renderJoinedSurface(["猫", "chased", "🧪"], raw));
    for (const [source, index] of [["local_shape", "localShapeIndex"], ["construction", "constructionIndex"]] as const) {
      const key = Object.keys(raw.components[0]!.program[index])[0]!;
      expect(joinProgramChoices(restored.components[0]!.program, source, key)).toEqual(joinProgramChoices(raw.components[0]!.program, source, key));
    }
  });

  it("preserves replay hashes for nested aggregate JOIN and graph artifacts", () => {
    const event = { id: "event.owned", episodeId: "episode.owned", typeId: "InducedLanguageModelPersisted", t: 1000, parents: [],
      payload: { model: { joinProgram: mixture() }, memoryProjection: { patterns: [{ patternJson: { graph: graph() } }] } } } as unknown as Omit<ScceEvent, "hash">;
    const original = { ...event, hash: hashEvent(event, [], createHasher()) };
    const restored = { ...original, payload: decodeDurableJoinPrograms<typeof original.payload>(cold(encodeDurableJoinPrograms(original.payload))) };
    expect(restored).toEqual(original);
    expect(hashEvent(restored, [], createHasher())).toBe(original.hash);
  });

  it("factors repeated creative premises alongside JOIN without changing exact rows, IDs or source strings", () => {
    const sourceObservations = Array.from({ length: 64 }, (_, index) => deriveCreativeSourceCorrespondence({
      requestFrameId: "request.owned", sourceId: "source.owned", sourceVersionId: "version.owned",
      request: { turnIndex: 0, evidenceId: "evidence.request", contentHash: "hash.request", start: 0, end: 1000,
        surfaceHash: "hash.surface", surface: "🧪é\u0000雪\r\n".repeat(128), sourceAuthority: "creative" },
      reply: { turnIndex: 1, evidenceId: "evidence.reply", contentHash: "hash.reply", start: 1001, end: 2000,
        surfaceHash: "hash.reply.surface", replyToTurnIndex: 0, commitmentScope: "conversation" },
      eventId: `event.${index}`, eventRelationId: "relation.owned", eventConstructionId: "construction.owned", eventArgumentFrameId: "argument.owned",
      bindings: [{ requestRoleId: "role.request", eventRoleId: "scce.role.patient", requestStart: 0, requestEnd: 1,
        eventStart: 0, eventEnd: 1, sourceReference: { patternId: "pattern.owned", referentId: "entity\u0000雪", propertyId: "property.owned" } }]
    }, createHasher()));
    const original = { joinProgram: mixture(), compatibility: { schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, sourceObservations } };
    const stored = encodeDurableJoinPrograms(original) as Record<string, unknown>;
    expect(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
    expect(bytes(stored)).toBeLessThan(bytes(original) / 3);
    const restored = decodeDurableJoinPrograms<typeof original>(cold(stored));
    expect(restored).toEqual(original);
    expect(restored.compatibility.sourceObservations.map(row => row.request.surface)).toEqual(sourceObservations.map(row => row.request.surface));
    expect(restored.compatibility.sourceObservations.map(row => row.id)).toEqual(sourceObservations.map(row => row.id));
    restored.compatibility.sourceObservations[0]!.bindings[0]!.sourceReference!.referentId = "changed";
    expect(restored.compatibility.sourceObservations[1]!.bindings[0]!.sourceReference!.referentId).toBe("entity\u0000雪");
    const corrupt = cold(stored) as unknown as { compatibility: { sourceObservations: { groups: Array<{ request: { surface: string } }> } } };
    corrupt.compatibility.sourceObservations.groups[0]!.request.surface += "changed";
    expect(() => decodeDurableJoinPrograms(corrupt)).toThrow(/creative source observation factors/u);
  });

  it("supports bounded graph roots and rejects changed or noncanonical physical bytes", () => {
    const original = graph(); original.arcs[0] = [0, 1, -0]; original.arcs[1] = [1, 2, Number.MIN_VALUE];
    const stored = encodeDurableJoinPrograms(original) as Record<string, unknown>;
    expect(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
    const restored = decodeDurableJoinPrograms<typeof original>(cold(stored));
    expect(restored).toEqual(original);
    expect(Object.is(restored.arcs[0]![2], -0)).toBe(true);
    expect(restored.arcs[1]![2]).toBe(Number.MIN_VALUE);
    for (const change of [(value: Record<string, unknown>) => { value.data = String(value.data).slice(0, -4) + "AAAA"; },
      (value: Record<string, unknown>) => { value.data += "\n"; },
      (value: Record<string, unknown>) => { value[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] = { decodedJsonBytes: -1 }; }]) {
      const invalid = cold(stored); change(invalid);
      expect(() => decodeDurableJoinPrograms(invalid)).toThrow();
    }
  });

  it("shares semantic relation statistics while retaining request-seed fields and original logical bytes", () => {
    const witness = { evidenceId: "evidence.source.long.witness".repeat(10), surface: "🧪é\u0000雪\r\n", offsets: [0, 1], optional: null };
    const original = { schema: SEMANTIC_MEMORY_SCHEMA, joinProgram: mixture(), semanticFrames: [],
      relationHypothesisModel: { schema: "scce.relation_hypothesis_model.v1", statistics: Array.from({ length: 100 }, (_, index) => ({ witness, count: index, probability: index / 100 })) },
      graphBoundConstructions: [{ retained: witness }], lexicalClasses: [{ retained: "source.class" }] };
    const stored = encodeDurableJoinPrograms(original) as Record<string, unknown>;
    expect(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
    expect(stored.graphBoundConstructions).toEqual(original.graphBoundConstructions);
    expect(stored.lexicalClasses).toEqual(original.lexicalClasses);
    expect(JSON.stringify(stored)).toContain("scce.relation_statistics.storage.v1");
    expect(bytes(stored)).toBeLessThan(bytes(original) / 2);
    expect(decodeDurableJoinPrograms(cold(stored))).toEqual(original);
    expect(encodeDurableJoinPrograms(stored)).toBe(stored);
    const corrupt = cold(stored) as unknown as { relationHypothesisModel: { digest: string } };
    corrupt.relationHypothesisModel.digest = "0".repeat(64);
    expect(() => decodeDurableJoinPrograms(corrupt)).toThrow(/relation statistics storage/u);
  });

  it("rejects corrupt or mixed global witnesses at raw and intentionally packed boundaries", () => {
    const original = mixture();
    const corruptions = [(program: typeof original.components[number]["program"]) => { program.globalFactors!.documents[0]!.baseChoices = [999999]; },
      (program: typeof original.components[number]["program"]) => { program.conditionedIndex = { forged: [] }; },
      (program: typeof original.components[number]["program"]) => { delete program.localFactors; }];
    for (const corrupt of corruptions) {
      const invalid = structuredClone(original); corrupt(invalid.components[0]!.program);
      expect(() => encodeDurableJoinPrograms(invalid)).toThrow(/invalid JOIN global factors/u);
      expect(() => decodeDurableJoinPrograms(cold(invalid))).toThrow(/invalid JOIN global factors/u);
    }
    for (const field of ["conditionedIndex", "structuralIndex"] as const) {
      const invalid = structuredClone(joinProgramMixtureStorageForm(original));
      invalid.mixture.components[0]!.program.indexes[field].push(["forged", []]);
      expect(() => encodeDurableJoinPrograms(invalid)).toThrow(/invalid JOIN global factors/u);
      expect(() => decodeDurableJoinPrograms(cold(invalid))).toThrow(/invalid JOIN global factors/u);
    }
    const invalid = structuredClone(joinProgramMixtureStorageForm(original));
    invalid.mixture.components[0]!.program.header.globalFactors!.documents[0]!.baseChoices = [999999];
    expect(() => encodeDurableJoinPrograms(invalid)).toThrow(/invalid JOIN global factors/u);
    expect(() => decodeDurableJoinPrograms(cold(invalid))).toThrow(/invalid JOIN global factors/u);
    const durable = encodeDurableJoinPrograms(original) as { mixture: typeof invalid };
    expect(encodeDurableJoinPrograms(durable)).toBe(durable);
    durable.mixture.mixture.components[0]!.program.header.globalFactors!.documents[0]!.baseChoices = [999999];
    expect(() => encodeDurableJoinPrograms(durable)).toThrow(/invalid durable JOIN storage marker/u);
    expect(() => decodeDurableJoinPrograms(cold(durable))).toThrow(/invalid durable JOIN storage marker/u);
  });
});
