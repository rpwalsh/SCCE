// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { SEGMENTATION_ADJACENCY_FACTORS_SCHEMA } from "@scce/kernel";
import { decodeLanguageArtifacts, encodeLanguageArtifacts, languageArtifactJsonByteLengths,
  LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY, SEGMENTATION_GRAPH_STORAGE_SCHEMA } from "../durable-language-artifact-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const graph = () => ({ schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount: 2001,
  arcs: Array.from({ length: 2000 }, (_, start) => [start, start + 1, start % 3 / 4] as const) });

describe("durable complete language artifacts", () => {
  it("cold restores full source geometry and charges its logical bytes before compact storage", () => {
    const original = { schema: "scce.induced_language_model.syntax_memory.v1", sourceVersionId: "owner.1", sourceCompilationId: "compile.1",
      segmentationDocuments: [{ documentId: "evidence.1", sourceWindow: { ownerDocumentId: "source.1", startUtf16: 0, endUtf16: 2000 },
        evidenceIds: ["evidence.1"], graph: graph(), unitUtf16Bounds: [[4, 4, 6]], retained: "e\u0301\u0000雪" }] };
    const encoded = encodeLanguageArtifacts(original) as Record<string, unknown>;
    expect(encoded[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY]).toMatchObject(languageArtifactJsonByteLengths(original));
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)) / 2);
    expect(JSON.stringify(encoded)).toContain(SEGMENTATION_GRAPH_STORAGE_SCHEMA);
    expect(decodeLanguageArtifacts(cold(encoded))).toEqual(original);
    expect(original.segmentationDocuments[0]!.graph.arcs).toHaveLength(2000);
    expect(encodeLanguageArtifacts(encoded)).toBe(encoded);
  });

  it("supports a graph root and rejects edited physical bytes and byte-ledger markers", () => {
    const original = graph(), encoded = encodeLanguageArtifacts(original) as Record<string, unknown>;
    expect(decodeLanguageArtifacts(cold(encoded))).toEqual(original);
    const bad = cold(encoded); bad.data = String(bad.data).slice(0, -4) + "AAAA";
    expect(() => decodeLanguageArtifacts(bad)).toThrow();
    const noncanonical = cold(encoded); noncanonical.data += "\n";
    expect(() => decodeLanguageArtifacts(noncanonical)).toThrow();
    const ledger = cold(encoded); ledger[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY] = { decodedJsonBytes: -1 };
    expect(() => decodeLanguageArtifacts(ledger)).toThrow();
  });

  it("retains unrelated schemas and every extension field", () => {
    const original = { schema: "application.extension", extra: [false, null, "\u0000", 1e-7], child: { unknown: true } };
    expect(encodeLanguageArtifacts(original)).toBe(original);
    expect(decodeLanguageArtifacts(cold(original))).toEqual(original);
    expect(languageArtifactJsonByteLengths(1e-7)).toEqual({ decodedJsonBytes: 4, decodedJsonbBytes: 9 });
  });
});
