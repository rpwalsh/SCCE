// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  compileLanguageTrainingBatch,
  createClock,
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  hydrateLanguageConstructionPatterns,
  preparePooledLanguageProfileBinding,
  symbolizeData
} from "@scce/kernel";
import { normalizeWikiText, wikipediaLanguageSurface } from "../wikipedia.js";
import {
  boundedLanguageShard,
  createWikipediaV3Ingestor,
  wikipediaLanguageInductionDocuments,
  wikipediaLanguageTextProjection
} from "../wikipedia-v3-ingestor.js";

// Measured over 150 wiki pages: flushing a shard only at block boundaries offered 4,023,980 characters across
// 2 shards and lost 1,623,980 of them -- 40.4% of the corpus -- because boundedLanguageShard is a bounded
// prefix and cannot carry overflow into the next shard. Flushing as the budget was passed cut that to 1.3%,
// which is better but still silent loss. The invariant held here is the real one: a shard is never offered
// more than it can hold, so nothing is dropped at all, and a shard that IS overfed says so.

function sample(index: number, size: number) {
  return {
    sourceVersionId: `sv-${index}` as never,
    title: `Title ${index}`,
    text: "x".repeat(size),
    evidence: [],
    languageAliases: [],
    semanticCandidates: [],
    createdAt: 1_700_000_000_000
  };
}

const charsOf = (item: ReturnType<typeof sample>) => item.title.length + 1 + item.text.length;

/** The ingestor's rule: flush before adding a sample that would overflow, never after. */
function shardsByFlushingFirst(samples: ReturnType<typeof sample>[], budget: number) {
  const shards: Array<ReturnType<typeof sample>[]> = [];
  let pending: ReturnType<typeof sample>[] = [];
  let pendingChars = 0;
  for (const item of samples) {
    if (pending.length && pendingChars + charsOf(item) + 2 > budget) {
      shards.push(pending);
      pending = [];
      pendingChars = 0;
    }
    pending.push(item);
    pendingChars += charsOf(item);
  }
  if (pending.length) shards.push(pending);
  return shards;
}

describe("shard building loses no corpus text", () => {
  it("rejects a title that overflows an otherwise valid page budget before writing learned artifacts", async () => {
    const ingestor = createWikipediaV3Ingestor({ storage: {} as any, config: { runtime: { corpora: { wikipedia: { ngramShardChars: 100000 } } } } as any });
    await expect((ingestor as any).ingestLanguageShard([sample(0, 100000)], "wikipedia://fixture/shard", "episode"))
      .rejects.toThrow(/refusing incomplete training/);
  });

  it("keeps Unicode clipping and evidence coverage in their declared coordinates", () => {
    const item = { ...sample(0, 0), title: "", text: "😀abc", evidence: [
      { id: "inside", charEnd: 1 }, { id: "outside", charEnd: 3 }
    ] };
    const clipped = boundedLanguageShard([item] as any, 3, 2048);
    expect(clipped.text).toBe("😀a");
    expect(clipped.evidence.map(span => span.id)).toEqual(["inside"]);
    expect(boundedLanguageShard([item] as any, 1, 2048).text).toBe("");
  });

  it("drops nothing across a long run of pages, because no shard is ever overfed", () => {
    const samples = Array.from({ length: 60 }, (_, index) => sample(index, 100_000));
    const offered = samples.reduce((sum, item) => sum + charsOf(item), 0);
    let dropped = 0;
    let trained = 0;
    for (const group of shardsByFlushingFirst(samples, 1_200_000)) {
      dropped += boundedLanguageShard(group as never, 1_200_000, 2048).droppedChars;
      trained += group.reduce((sum, item) => sum + charsOf(item), 0);
    }
    expect(dropped).toBe(0);
    expect(trained).toBe(offered);
  });

  it("holds the invariant for pages of uneven size, which is what a real dump gives", () => {
    const sizes = [160_000, 1_200, 90_000, 3, 160_000, 45_000, 160_000, 7_000, 120_000, 160_000];
    const samples = sizes.map((size, index) => sample(index, size));
    const offered = samples.reduce((sum, item) => sum + charsOf(item), 0);
    let dropped = 0;
    let trained = 0;
    for (const group of shardsByFlushingFirst(samples, 1_200_000)) {
      dropped += boundedLanguageShard(group as never, 1_200_000, 2048).droppedChars;
      trained += group.reduce((sum, item) => sum + charsOf(item), 0);
    }
    expect(dropped).toBe(0);
    expect(trained).toBe(offered);
  });

  it("reports what it could not hold instead of discarding it quietly", () => {
    // Only reachable by misconfiguration -- a page larger than a whole shard -- which config validation now
    // refuses. If it ever happens the ingest must say so rather than lose corpus in silence.
    const overfed = boundedLanguageShard([sample(0, 1000), sample(1, 1000)] as never, 1200, 2048);
    expect(overfed.droppedChars).toBeGreaterThan(0);
    expect(overfed.droppedSamples).toBeGreaterThan(0);
    expect(overfed.text.length).toBeLessThanOrEqual(1200);
  });

  it("keeps every offered character when the budget covers the group", () => {
    const samples = [sample(0, 500), sample(1, 500)];
    const offered = samples.reduce((sum, item) => sum + charsOf(item), 0);
    const bounded = boundedLanguageShard(samples as never, 1_200_000, 2048);
    expect(bounded.droppedChars).toBe(0);
    expect(bounded.text.length).toBe(offered + 2 * (samples.length - 1));
  });

  it("keeps projected source coordinates owned through a pooled shard and creative compilation", () => {
    const filename = "Bee 🐝 on rock rose.jpg";
    const raw = [
      "Ada visits Paris. Bea visits Rome. Ada visits Berlin. Bea visits Madrid.",
      "<gallery widths=\"240\">",
      `${filename} | visits flowers.`,
      "</gallery>",
      "Cora visits Lima. Dana visits Oslo. Cora visits Quito. Dana visits Tokyo."
    ].join("\n");
    const canonicalEvidence = normalizeWikiText(raw);
    const languageSurface = wikipediaLanguageSurface(raw, undefined, canonicalEvidence);
    const afterGallery = "Cora visits Lima.";
    const afterUtf16 = canonicalEvidence.indexOf(afterGallery);
    const afterCodePoint = [...canonicalEvidence.slice(0, afterUtf16)].length;

    expect(canonicalEvidence).toContain(filename);
    expect(languageSurface.text).not.toContain(filename);
    expect(languageSurface.text.slice(afterUtf16, afterUtf16 + afterGallery.length)).toBe(afterGallery);
    expect([...languageSurface.text].slice(afterCodePoint, afterCodePoint + [...afterGallery].length).join(""))
      .toBe(afterGallery);
    expect(languageSurface.text).toHaveLength(canonicalEvidence.length);
    expect([...languageSurface.text]).toHaveLength([...canonicalEvidence].length);
    expect(symbolizeData(languageSurface.text)).not.toContain("\u{E0000}");

    const hasher = createHasher();
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "wiki-role-projection" });
    const language = createLanguageAcquisitionEngine({ idFactory: ids });
    const sourceId = ids.sourceId("wikipedia", "fixture://wiki-role-projection");
    const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(canonicalEvidence) }));
    const pageProfile = language.acquire({ sourceVersionId, text: languageSurface.text, createdAt: 1 });
    const evidence = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId,
      sourceVersionId,
      namespace: "wikipedia-fixture",
      uri: "fixture://wiki-role-projection",
      mediaType: "text/plain",
      text: canonicalEvidence,
      languageProfile: pageProfile,
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
        independenceGroup: "wikimedia:wikipedia", accessScope: "fixture", licenseStatus: "fixture" },
      observedAt: 1,
      metadata: {},
      exactSourceText: true,
      maxChunkBytes: 65_536
    }).spans.map(span => ({ ...span, status: "promoted" as const,
      provenance: { ...(span.provenance as object), sourceFamilyId: "wikimedia:wikipedia" } }));
    const sampleWithProjection = {
      ...sample(0, 0),
      uri: "fixture://wiki-role-projection",
      title: "Bee ecology",
      sourceVersionId,
      text: languageSurface.text,
      languageProjection: languageSurface.mappings,
      evidence
    };
    const bounded = boundedLanguageShard([sampleWithProjection] as never, 65_536, 2_048);
    const projection = wikipediaLanguageTextProjection([sampleWithProjection]);
    expect(bounded.droppedChars).toBe(0);
    expect(bounded.evidence.map(span => span.text).join(" ")).toContain(filename);
    expect(projection).toBeDefined();

    const pooledSourceVersionId = ids.sourceVersionId(`fixture://wiki-role-shard\u001f${bounded.text}`);
    const pooledProfile = language.acquire({ sourceVersionId: pooledSourceVersionId, text: bounded.text, createdAt: 1 });
    expect(canonicalStringify(pooledProfile)).not.toContain(filename);
    expect(canonicalStringify(pooledProfile)).not.toContain("\u{E0000}");
    const binding = preparePooledLanguageProfileBinding({
      profile: pooledProfile,
      text: bounded.text,
      sourceVersionId: pooledSourceVersionId,
      parentSourceVersionIds: [String(sourceVersionId)],
      evidence: bounded.evidence,
      sourceFamilyRanges: bounded.sourceFamilyRanges,
      hasher,
      textProjection: projection
    });
    const inductionDocuments = wikipediaLanguageInductionDocuments(bounded.evidence, projection);
    expect(inductionDocuments.map(document => document.text).join(" ")).not.toContain(filename);
    expect(inductionDocuments.map(document => document.text).join(" ")).toContain(afterGallery);

    const compiled = compileLanguageTrainingBatch({
      runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }),
      hasher,
      batch: {
        streamId: "fixture://wiki-role-shard",
        sourceSystem: "wikipedia",
        sourceVersionId: pooledSourceVersionId,
        profile: pooledProfile,
        text: bounded.text,
        evidence: bounded.evidence,
        inductionDocuments,
        textProjection: projection,
        profileBinding: binding,
        retainNgramObservations: false,
        createdAt: 1
      }
    });
    const sourceWitnesses = compiled.patterns.filter(pattern =>
      (pattern.patternJson as { schema?: string }).schema === "scce.source_segmentation_witness.v2");
    const learnedPatterns = compiled.patterns.filter(pattern => !sourceWitnesses.includes(pattern));
    const learned = canonicalStringify({ patterns: learnedPatterns, units: compiled.units, models: compiled.models,
      semanticFrames: compiled.semanticFrames });
    expect(learned).not.toContain(filename);
    const markerAt = learned.indexOf("\u{E0000}");
    const markerOwners = [
      ...learnedPatterns.map((value, index) => ({ kind: "pattern", index, value })),
      ...compiled.units.map((value, index) => ({ kind: "unit", index, value })),
      ...compiled.models.map((value, index) => ({ kind: "model", index, value }))
    ].filter(row => canonicalStringify(row.value).includes("\u{E0000}"))
      .map(row => `${row.kind}:${row.index}:${(row.value as any).patternKind ?? ""}:${(row.value as any).patternJson?.schema ?? ""}`);
    expect(markerAt, markerOwners.join(",")).toBe(-1);
    expect(sourceWitnesses.length).toBeGreaterThan(0);
    expect(sourceWitnesses.every(pattern =>
      !symbolizeData(String((pattern.patternJson as { text?: string }).text ?? "")).includes("\u{E0000}"))).toBe(true);
    expect(compiled.semanticFrames.every(frame => {
      const preview = (frame.frameJson as { preview?: string }).preview ?? "";
      return !/[\uD800-\uDBFF]$/u.test(preview) && !/^[\uDC00-\uDFFF]/u.test(preview);
    })).toBe(true);
    const creativePatterns = compiled.constructionPatterns.filter(pattern =>
      (pattern.patternJson as { schema?: string }).schema === "scce.creative_event_construction_pattern.v3");
    expect(creativePatterns.length, canonicalStringify(compiled.audit)).toBeGreaterThan(0);
    const coldHydrated = hydrateLanguageConstructionPatterns({ patterns: creativePatterns, evidence: bounded.evidence, hasher });
    expect(coldHydrated.rejected).toEqual([]);
    expect(coldHydrated.bundles).toHaveLength(creativePatterns.length);
    expect(canonicalStringify(coldHydrated.bundles)).not.toContain(filename);
    const coldConstructions = hydrateLanguageConstructionPatterns({ patterns: compiled.constructionPatterns,
      evidence: bounded.evidence, hasher });
    const speechBundles = coldConstructions.bundles.filter(bundle =>
      bundle.bindingId.startsWith("surface.creative_event.speech."));
    expect(coldConstructions.rejected).toEqual([]);
    expect(speechBundles.length).toBeGreaterThan(0);
    expect(canonicalStringify(speechBundles)).not.toContain(filename);
  });
});
