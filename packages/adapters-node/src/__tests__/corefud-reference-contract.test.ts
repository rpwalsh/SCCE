// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSourceReferenceBindingPattern, createHasher, createIdFactory, sourceReferenceBindingsFromPatterns,
  sourceReferencePropertiesForSpan, type EvidenceSpan } from "@scce/kernel";
import { assertCorefUDSourceDisjoint, prepareCorefUDSourceTrainingMaterial, readCorefUDSource, type CorefUDSourceDocument } from "../corefud-source-reader.js";

const hasher = createHasher();
const ids = createIdFactory({ hasher, clock: { now: () => 0 }, namespace: "annotated-source-contract-audit", deterministicReplay: true });

function evidenceFor(document: CorefUDSourceDocument): EvidenceSpan {
  const bytes = Buffer.from(document.text), contentHash = ids.contentHash(bytes), sourceVersionId = ids.sourceVersionId(bytes);
  const range = { sourceVersionId, byteStart: 0, byteEnd: bytes.length };
  return { id: ids.evidenceId({ ...range, spanHash: contentHash }), sourceId: ids.sourceId(document.corpusId, document.sourceUri),
    sourceVersionId, chunkId: ids.chunkId({ ...range, chunkHash: contentHash }), contentHash, mediaType: "text/plain",
    byteStart: 0, byteEnd: bytes.length, charStart: 0, charEnd: [...document.text].length, text: document.text, textPreview: document.text,
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: { audit: "isolated promoted evidence wrapper; original text and annotations unchanged" },
    features: [], status: "promoted", alpha: 1, observedAt: 0 };
}

function compile(document: CorefUDSourceDocument, evidence = evidenceFor(document)) {
  return compileSourceReferenceBindingPattern({ text: document.text, declaration: document.declaration, evidence: [evidence],
    hasher, profileId: `profile.source.${document.corpusId}`, updatedAt: 0 });
}

it("prepares source-owned training metadata without inventing dialogue turns or replaceable properties", () => {
  const text = "# global.Entity = eid-etype-head\n# newdoc id = test-authored\n# text = luma qzeta\n"
    + "1\tluma\t_\t_\t_\t_\t_\t_\t_\tEntity=(a-opaque-1)\n2\tqzeta\t_\t_\t_\t_\t_\t_\t_\tEntity=(a-opaque-1)\n";
  const document = readCorefUDSource({ text, owner: { corpusId: "test-authored", sourceUri: "fixture://test-authored-contract",
    artifactSha256: hasher.digestHex(text), declaredLicense: "test-authored", attribution: "test-authored control", sourceOrigin: "test-authored-fixture" } }).documents[0]!;
  const material = prepareCorefUDSourceTrainingMaterial(document);
  expect(material).not.toHaveProperty("transcriptTurns");
  expect(material.corpusMetadata).toMatchObject({ sourceMetadata: { sourceReferenceBindings: document.declaration,
    coreferenceSource: { originalArtifact: document.owner, projectedTextHash: hasher.digestHex(document.text), rawTextInference: "unavailable" } } });
  const compiled = compile(document);
  expect(compiled.issues).toEqual([]);
  expect(compiled.bindings?.occurrences).toHaveLength(2);
  expect(compiled.bindings?.completeProperties).toEqual([]);
  expect(() => prepareCorefUDSourceTrainingMaterial({ ...document, text: "changed" })).toThrow(/text changed/u);
});

interface SourceCatalogEntry {
  language: string; repository: string; commit: string; declaredLicense: string; attribution: string;
  files: Array<{ file: string; bytes: number; sha256: string; role: string }>;
}

describe.skipIf(!process.env.SCCE_COREF_SOURCE_CACHE)("pinned external human annotation contract audit", () => {
  it("preserves source-disjoint human chains and homonyms through owned compilation and persisted hydration", async () => {
    const catalog = JSON.parse(await readFile(new URL("../../../../tools/coreference/source-catalog.json", import.meta.url), "utf8")) as { sources: SourceCatalogEntry[] };
    const receipts = [];
    for (const source of catalog.sources) {
      const pin = source.files.find(file => file.role === "annotations")!;
      const bytes = await readFile(join(process.env.SCCE_COREF_SOURCE_CACHE!, source.repository.replaceAll("/", "__"), source.commit, pin.file));
      expect(bytes.length).toBe(pin.bytes);
      expect(hasher.digestHex(bytes)).toBe(pin.sha256);
      const started = performance.now();
      const projection = readCorefUDSource({ text: bytes.toString("utf8"), owner: { corpusId: source.repository,
        sourceUri: `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${pin.file}`, artifactSha256: pin.sha256,
        declaredLicense: source.declaredLicense, attribution: source.attribution, sourceOrigin: "human-corpus" } });
      const ordered = [...projection.documents].sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
      const development = ordered.filter((_, index) => index % 2 === 0), heldOut = ordered.filter((_, index) => index % 2 !== 0);
      assertCorefUDSourceDisjoint(development, heldOut);
      const heldOutIds = new Set(heldOut.map(document => document.documentId));
      const issues = new Map<string, number>();
      let mentions = 0, compiledDocuments = 0, noIdentityDocuments = 0, heldOutDiverseChains = 0, heldOutHomonymGroups = 0;
      for (const document of projection.documents) {
        for (const issue of document.issues) issues.set(issue.code, (issues.get(issue.code) ?? 0) + 1);
        expect(document.declaration.completeProperties).toBeUndefined();
        expect(document.declaration.occurrences.every(row => row.propertyId === undefined)).toBe(true);
        if (!document.declaration.occurrences.length) {
          expect(document.declaration.completeReferentIds).toEqual([]);
          expect(compile(document)).toEqual({ issues: [{ code: "source.reference.no_observations" }] });
          noIdentityDocuments++;
          continue;
        }
        const evidence = evidenceFor(document), compiled = compile(document, evidence);
        expect(compiled.issues, document.documentId).toEqual([]);
        const persisted = JSON.parse(JSON.stringify([compiled.pattern]));
        const restored = sourceReferenceBindingsFromPatterns({ patterns: persisted, evidence: [evidence], hasher });
        expect(restored.issues, document.documentId).toEqual([]);
        expect(restored.bindings).toHaveLength(1);
        const bindings = restored.bindings[0]!;
        expect(bindings.occurrences).toHaveLength(document.declaration.occurrences.length);
        expect(bindings.completeProperties).toEqual([]);
        expect(bindings.occurrences.every(row => row.binding.evidenceIds.includes(String(evidence.id))
          && row.binding.sourceVersionIds.includes(String(evidence.sourceVersionId)))).toBe(true);
        const first = document.declaration.occurrences[0]!;
        expect(sourceReferencePropertiesForSpan({ documents: restored.bindings, sourceVersionId: String(evidence.sourceVersionId),
          startCodePoint: first.startCodePoint, endCodePoint: first.endCodePoint })).toEqual([]);
        const identityMap = new Map<string, Set<string>>(), surfaceMap = new Map<string, Set<string>>();
        const points = [...document.text];
        document.declaration.occurrences.forEach((row, index) => {
          const identity = bindings.occurrences[index]!.binding.referentId;
          const observed = identityMap.get(row.referentId) ?? new Set<string>();
          observed.add(identity); identityMap.set(row.referentId, observed);
          const surface = points.slice(row.startCodePoint, row.endCodePoint).join("");
          const owners = surfaceMap.get(surface) ?? new Set<string>();
          owners.add(identity); surfaceMap.set(surface, owners);
        });
        expect([...identityMap.values()].every(values => values.size === 1)).toBe(true);
        expect(new Set([...identityMap.values()].flatMap(values => [...values])).size).toBe(identityMap.size);
        if (heldOutIds.has(document.documentId)) {
          const chainSurfaces = new Map<string, Set<string>>();
          for (const row of document.declaration.occurrences) {
            const surfaces = chainSurfaces.get(row.referentId) ?? new Set<string>();
            surfaces.add(points.slice(row.startCodePoint, row.endCodePoint).join("")); chainSurfaces.set(row.referentId, surfaces);
          }
          heldOutDiverseChains += [...chainSurfaces.values()].filter(surfaces => surfaces.size > 1).length;
          heldOutHomonymGroups += [...surfaceMap.values()].filter(owners => owners.size > 1).length;
        }
        if (!compiledDocuments) {
          expect(sourceReferenceBindingsFromPatterns({ patterns: persisted, evidence: [{ ...evidence, sourceId: ids.sourceId("foreign", document.sourceUri) }], hasher }).bindings).toEqual([]);
          expect(compileSourceReferenceBindingPattern({ text: document.text, declaration: { ...document.declaration,
            basis: { kind: "qualified_inference", modelId: "not-qualified", modelVersion: "0", qualificationId: "absent" } },
            evidence: [evidence], hasher, profileId: "unqualified", updatedAt: 0 }).issues[0]?.code).toBe("source.reference.inference_qualification_unavailable");
        }
        mentions += bindings.occurrences.length; compiledDocuments++;
      }
      expect(projection.documents).toHaveLength(155);
      expect(compiledDocuments + noIdentityDocuments).toBe(155);
      expect(heldOutDiverseChains).toBeGreaterThan(0);
      expect(heldOutHomonymGroups).toBeGreaterThan(0);
      expect(mentions).toBe(source.language === "es" ? 6128 : 6240);
      receipts.push({ language: source.language, repository: source.repository, commit: source.commit, artifactSha256: pin.sha256,
        sourceOrigin: "human-corpus", inputKind: projection.inputKind, documents: projection.documents.length, compiledDocuments, noIdentityDocuments, mentions,
        developmentDocuments: development.length, heldOutDocuments: heldOut.length, heldOutDiverseChains, heldOutHomonymGroups,
        unsupported: Object.fromEntries(issues), rawTextInference: "unavailable", namePropertyInference: "unavailable",
        qualificationScope: "source-disjoint annotated-source preservation; no inference model trained or qualified",
        elapsedMs: performance.now() - started, heapMiB: process.memoryUsage().heapUsed / 1048576 });
    }
    if (process.env.SCCE_COREF_AUDIT_RECEIPT) await writeFile(process.env.SCCE_COREF_AUDIT_RECEIPT,
      JSON.stringify({ schema: "scce.coreference-annotated-source-audit.v1", receipts }, null, 2));
    console.log(JSON.stringify({ schema: "scce.coreference-annotated-source-audit.v1", receipts }));
  });
});
