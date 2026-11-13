// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { SOURCE_REFERENCE_BINDING_SCHEMA, sourceReferenceBindingsFromPatterns, sourceReferencePropertiesForSpan,
  type SourceReferenceBindingDeclaration } from "../source-reference-bindings.js";
import type { ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, IngestInput, SourceVersion } from "../types.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

const text = "👩🏽‍💻 민수는 라나에게 말했다. 라나는 민수를 보았다. ليلى قالت إن ليلى حضرت.";
const hasher = createHasher();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function annotatedSource(): SourceReferenceBindingDeclaration {
  const surfaces = [{ surface: "👩🏽‍💻", referents: ["r.symbol"] }, { surface: "민수", referents: ["r.minsu", "r.minsu"] },
    { surface: "라나", referents: ["r.rana", "r.rana"] }, { surface: "ليلى", referents: ["r.layla.first", "r.layla.second"] }];
  const occurrences = surfaces.flatMap(({ surface, referents }) => [...text.matchAll(new RegExp(surface, "gu"))].map((match, index) => {
    const startCodePoint = [...text.slice(0, match.index)].length;
    return { id: `mention:${surface}:${index}`, referentId: referents[index]!, propertyId: "p.name",
      startCodePoint, endCodePoint: startCodePoint + [...surface].length };
  }));
  const referents = [...new Set(occurrences.map(row => row.referentId))];
  return { schema: SOURCE_REFERENCE_BINDING_SCHEMA, coordinateSpace: "unicode_code_point", sourceTextHash: hasher.digestHex(text),
    basis: { kind: "source_annotated", annotationSchema: "fixture.explicit.references.v1", annotationId: "fixture.multilingual.references" },
    completeReferentIds: referents, completeProperties: referents.map(referentId => ({ referentId, propertyId: "p.name" })), occurrences };
}

function ingestionFixture() {
  const clock = createClock({ fixedTime: 1700000000000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "source-reference-ingestion" });
  const evidence: EvidenceSpan[] = [], sources: SourceVersion[] = [];
  const blobs = new Map<string, Uint8Array>();
  const fixture = storageFixtureForEvaluation({ evidence, clockNow: clock.now });
  fixture.storage.evidence.putSourceVersion = async source => { sources.push(source); };
  fixture.storage.evidence.putEvidenceSpan = async span => { evidence.push(span); };
  fixture.storage.blobs.put = async bytes => {
    const hash = ids.contentHash(bytes);
    blobs.set(String(hash), new Uint8Array(bytes));
    return hash;
  };
  fixture.storage.blobs.putRanges = async (ranges, parent) => {
    expect(ids.contentHash(parent.bytes)).toBe(parent.contentHash);
    for (const range of ranges) {
      const bytes = parent.bytes.subarray(range.byteStart, range.byteEnd);
      expect(ids.contentHash(bytes)).toBe(range.contentHash);
      expect(range.parentHash).toBe(parent.contentHash);
      blobs.set(String(range.contentHash), new Uint8Array(bytes));
    }
  };
  const informationLabel = { tenantId: "fixture.tenant", principals: ["fixture.owner"], compartments: ["fixture.ingestion"],
    exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const deps = { storage: fixture.storage, maxChunkBytes: 4096, sourceInformationLabel: informationLabel,
    informationAccess: { tenantId: "fixture.tenant", principalId: "fixture.owner", compartments: ["fixture.ingestion"], maximumExportClass: "restricted" } } as ScceKernelDeps;
  const runtime = createIngestionRuntime({ deps, clock, hasher, idFactory: ids,
    eventFactory: createEventFactory({ idFactory: ids, clock, hasher }), language: createLanguageAcquisitionEngine({ idFactory: ids }),
    languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory: ids, hasher }),
    append: async event => { fixture.events.push(event); return event; }, onKernelStateMutation: () => undefined });
  const sourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
    independenceGroup: "fixture:source-reference", accessScope: "owner_private" as const, licenseStatus: "owner_authorized" as const };
  const input = (metadata: unknown = annotatedSource()): IngestInput => ({ uri: "inline://source-reference", namespace: "fixture",
    content: text, mediaType: "text/plain", metadata: toJsonValue({ sourceReferenceBindings: metadata }),
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "learned_prior", promotionAuthority: "owner" }, sourceTrust });
  return { ...fixture, runtime, evidence, sources, blobs, input, informationLabel };
}

describe("ordinary ingestion source reference annotations", () => {
  it.each(["text/plain", "image/png", "application/pdf"])("persists source-owned Unicode reference observations through %s ingestion", async mediaType => {
    const fixture = ingestionFixture();
    const originalBytes = mediaType === "text/plain" ? Buffer.from(text, "utf8")
      : mediaType === "image/png" ? Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128])
      : Buffer.from("%PDF-1.7\n% original opaque source bytes\n%%EOF", "utf8");
    const input = { ...fixture.input(), mediaType, content: originalBytes,
      ...(mediaType === "text/plain" ? {} : { evidenceDerivative: { text, bytes: Buffer.from(text, "utf8"), kind: "extracted-text" as const,
        transformId: "fixture.exact-extracted-text.v1", originalCoordinateSpace: "source-bytes" as const, redactionMap: [] } }) };
    await fixture.runtime.ingest(input);
    const patterns = copy(await fixture.storage.languageMemory.listLanguagePatterns({ patternSchemas: [SOURCE_REFERENCE_BINDING_SCHEMA] }));
    expect(patterns, JSON.stringify(fixture.events.filter(event => event.typeId === "SymbolPatternLearned").map(event => event.payload))).toHaveLength(1);
    const restored = sourceReferenceBindingsFromPatterns({ patterns, evidence: fixture.evidence, hasher });
    expect(restored.issues).toEqual([]);
    expect(restored.bindings).toHaveLength(1);
    const document = restored.bindings[0]!;
    const original = fixture.sources.find(source => source.role === "original")!;
    expect(original).toBeDefined();
    expect(Buffer.from(fixture.blobs.get(String(original.contentHash))!)).toEqual(Buffer.from(originalBytes));
    expect(original.mediaType).toBe(mediaType);
    const evidenceSource = mediaType === "text/plain" ? original : fixture.sources.find(source => source.role === "evidence-derivative")!;
    expect(document.sourceId).toBe(String(evidenceSource.sourceId));
    expect(document.sourceVersionId).toBe(String(evidenceSource.sourceVersionId));
    expect(document.profileId).toBe(patterns[0]!.profileId);
    expect(patterns[0]!.informationLabel).toEqual(fixture.informationLabel);
    expect(Buffer.from(fixture.blobs.get(String(evidenceSource.contentHash))!).toString("utf8")).toBe(text);
    if (mediaType !== "text/plain") {
      expect(fixture.sources).toHaveLength(2);
      expect(evidenceSource.sourceVersionId).not.toBe(original.sourceVersionId);
      expect(evidenceSource.derivation).toMatchObject({ kind: "extracted-text", derivedFromSourceVersionId: original.sourceVersionId,
        originalCoordinateSpace: "source-bytes", transformId: "fixture.exact-extracted-text.v1" });
    }
    for (const span of fixture.evidence) {
      expect(span.status).toBe("promoted");
      expect(span.sourceVersionId).toBe(evidenceSource.sourceVersionId);
      expect(Buffer.from(fixture.blobs.get(String(evidenceSource.contentHash))!).subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
    }
    const declaration = annotatedSource();
    expect(document.occurrences).toHaveLength(declaration.occurrences.length);
    expect(document.occurrences.map(row => row.mention.span)).toEqual(declaration.occurrences.map(row => ({ start: row.startCodePoint, end: row.endCodePoint })));
    const propertyFor = (occurrence: SourceReferenceBindingDeclaration["occurrences"][number]) => sourceReferencePropertiesForSpan({
      documents: restored.bindings, sourceVersionId: document.sourceVersionId, startCodePoint: occurrence.startCodePoint, endCodePoint: occurrence.endCodePoint })[0]!;
    const korean = declaration.occurrences.filter(row => row.referentId === "r.minsu");
    const firstKorean = propertyFor(korean[0]!);
    expect(firstKorean.complete).toBe(true);
    expect(firstKorean.occurrences).toHaveLength(2);
    expect(propertyFor(korean[1]!).referentId).toBe(firstKorean.referentId);
    const arabic = declaration.occurrences.filter(row => row.id.includes("ليلى"));
    expect(propertyFor(arabic[0]!).referentId).not.toBe(propertyFor(arabic[1]!).referentId);
    expect(korean[0]!.startCodePoint).not.toBe(text.indexOf("민수"));
    for (const occurrence of document.occurrences) {
      expect(occurrence.binding.sourceVersionIds).toEqual([document.sourceVersionId]);
      expect(occurrence.binding.evidenceIds).toEqual([occurrence.evidenceId]);
      expect(fixture.evidence.some(span => String(span.id) === occurrence.evidenceId && String(span.contentHash) === occurrence.contentHash)).toBe(true);
    }
    for (const changedEvidence of [
      fixture.evidence.map(span => ({ ...span, contentHash: "changed-hash" as never })),
      fixture.evidence.map(span => ({ ...span, sourceId: "source.foreign" as never })),
      fixture.evidence.map(span => ({ ...span, sourceVersionId: "version.foreign" as never })),
      fixture.evidence.map(span => ({ ...span, charStart: span.charStart + 1 })),
      fixture.evidence.map(span => ({ ...span, status: "quarantined" as const }))
    ]) expect(sourceReferenceBindingsFromPatterns({ patterns, evidence: changedEvidence, hasher }).bindings).toEqual([]);
    const changedPatterns = copy(patterns);
    const changedJson = changedPatterns[0]!.patternJson as unknown as { declaration: SourceReferenceBindingDeclaration };
    changedJson.declaration = { ...changedJson.declaration, occurrences: changedJson.declaration.occurrences.map((row, index) => index ? row : { ...row, endCodePoint: 1 }) };
    expect(sourceReferenceBindingsFromPatterns({ patterns: changedPatterns, evidence: fixture.evidence, hasher }).bindings).toEqual([]);
  });

  it.each(["source.reference.text_changed", "source.reference.coordinates_changed"])("records %s without publishing a reference binding", async code => {
    const fixture = ingestionFixture(), declaration = annotatedSource();
    const invalid = code === "source.reference.text_changed" ? { ...declaration, sourceTextHash: hasher.digestHex("different source") }
      : { ...declaration, occurrences: declaration.occurrences.map((row, index) => index ? row : { ...row, endCodePoint: 1 }) };
    await fixture.runtime.ingest(fixture.input(invalid));
    expect(await fixture.storage.languageMemory.listLanguagePatterns({ patternSchemas: [SOURCE_REFERENCE_BINDING_SCHEMA] })).toEqual([]);
    const learned = fixture.events.filter(event => event.typeId === "SymbolPatternLearned");
    expect(learned.some(event => JSON.stringify(event.payload).includes(code))).toBe(true);
    expect(fixture.evidence.every(span => span.status === "promoted")).toBe(true);
  });

  it("does not infer reference identity from unannotated multilingual source text", async () => {
    const fixture = ingestionFixture();
    await fixture.runtime.ingest({ ...fixture.input(), metadata: {} });
    expect(fixture.evidence.length).toBeGreaterThan(0);
    expect(await fixture.storage.languageMemory.listLanguagePatterns({ patternSchemas: [SOURCE_REFERENCE_BINDING_SCHEMA] })).toEqual([]);
  });

  it("retains quarantined source bytes without publishing annotated language", async () => {
    const fixture = ingestionFixture();
    const input = fixture.input();
    await fixture.runtime.ingest({ ...input, sourceAdmission: { ...input.sourceAdmission, intendedUse: "quarantine_only" } });
    expect(fixture.sources.length).toBeGreaterThan(0);
    expect(fixture.evidence.length).toBeGreaterThan(0);
    expect(fixture.evidence.every(span => span.status === "quarantined")).toBe(true);
    expect(await fixture.storage.languageMemory.listLanguagePatterns()).toEqual([]);
    expect(await fixture.storage.model.listLanguageProfiles()).toEqual([]);
    expect(fixture.events.some(event => event.typeId === "SymbolPatternLearned")).toBe(false);
  });
});
