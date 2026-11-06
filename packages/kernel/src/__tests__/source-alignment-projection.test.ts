// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as lattice from "../surface-lattice.js";
import * as forest from "../segmentation-forest.js";
import { induceSourceBoundConstructionTrainingSets, prepareConstructionInduction } from "../graph-surface-alignment.js";
import { compileLanguageConstructionPatterns, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import { createHasher, createClock } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createLanguageAcquisitionEngine } from "../language.js";

const hasher = createHasher();
const animalia = readFileSync(new URL("./fixtures/animalia-source.md", import.meta.url), "utf8");

describe("source alignment lexical projection", () => {
  it("retains exactly the canonical lexical units, including source coordinates and cap ordering, without compiling an unused forest", () => {
    const texts = [animalia, "猫は動物です。犬も動物です。\nالعربية لغة طبيعية. 한국어는 자연 언어입니다.\r\n👩‍💻e\u0301\u0000"];
    for (const text of texts) for (const maxUnits of [64, 4096]) {
      const options = { documentId: "source.multilingual", sourceVersionId: "source.version", evidenceIds: ["evidence.exact"], text, maxUnits, hasher };
      const full = lattice.buildSurfaceLattice(options);
      const buildForest = vi.spyOn(forest, "buildSegmentationForest");
      try {
        const projected = lattice.buildSourceAlignmentSurfaceLattice(options);
        expect(projected.units).toEqual(full.units.filter(unit => unit.proposalSources.includes("lexical")));
        expect(projected.id).toBe(full.id);
        expect(projected.textHash).toBe(full.textHash);
        expect(projected.sourceUnitCount).toBe(full.units.length);
        expect(projected).not.toHaveProperty("edges");
        expect(projected).not.toHaveProperty("segmentationForest");
        expect(buildForest).not.toHaveBeenCalled();
      } finally { buildForest.mockRestore(); }
    }
  });

  it("produces exactly the same real-source observations, transport values, durable programs and IDs as the full lattice producer", () => {
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 140_000, stepMs: 1 }), deterministicReplay: true, namespace: "projection" });
    const sourceVersionId = ids.sourceVersionId(animalia);
    const languageProfile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: animalia, createdAt: 140_000 });
    const evidence = createEvidenceExtractor({ hasher, idFactory: ids }).extract({ sourceId: ids.sourceId("fixture", "source://Animalia"),
      sourceVersionId, namespace: "fixture", uri: "source://Animalia", mediaType: "text/plain", text: animalia, languageProfile, observedAt: 140_000,
      maxChunkBytes: 65_536, exactSourceText: true,
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" }
    }).spans.map(span => ({ ...span, status: "promoted" as const }));
    const profileId = languageProfile.id;
    const preparedInduction = prepareConstructionInduction({ documents: evidence.map(span => ({ id: String(span.id), text: span.text, evidenceIds: [span.id], sourceVersionId: span.sourceVersionId })), hasher });
    const input = { evidence, profileId, hasher, preparedInduction };
    const projection = vi.spyOn(lattice, "buildSourceAlignmentSurfaceLattice").mockImplementation(options => {
      const full = lattice.buildSurfaceLattice(options);
      return { schema: "scce.surface_lattice.source_alignment_projection.v1", id: full.id, documentId: full.documentId, textHash: full.textHash,
        units: full.units.filter(unit => unit.proposalSources.includes("lexical")), sourceUnitCount: full.units.length };
    });
    let expected: ReturnType<typeof induceSourceBoundConstructionTrainingSets>;
    try { expected = induceSourceBoundConstructionTrainingSets(input); }
    finally { projection.mockRestore(); }
    const actual = induceSourceBoundConstructionTrainingSets(input);
    expect(actual.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected!);
    const compile = (sets: typeof actual) => [...compileLanguageConstructionPatterns({ sets, profileId, evidence, hasher, updatedAt: 140_000, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE })];
    expect(compile(actual)).toEqual(compile(expected!));
  });
});
