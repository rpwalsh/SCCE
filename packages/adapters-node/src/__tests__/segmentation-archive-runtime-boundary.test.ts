// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import {
  createHasher,
  INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  sourceLanguageTrainingStreamId,
  stampSourceLanguageCompilation,
  type LanguagePatternRecord
} from "@scce/kernel";
import { stampPattern } from "../language-corpus-trainer.js";

const hasher = createHasher();
const profileId = "profile.archive";

function archivePattern(id: string, schema: string): LanguagePatternRecord {
  return { id, profileId, patternKind: "segmentation", support: 1, entropy: 0,
    patternJson: { schema, id: `canonical.${id}`, payload: { exact: true } }, evidenceIds: [], updatedAt: 1 };
}

it.each([SOURCE_SEGMENTATION_WITNESS_SCHEMA, LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA])(
  "does not provenance-stamp canonical segmentation archive body %s",
  schema => {
    const pattern = archivePattern(`archive.${schema}`, schema);
    const body = pattern.patternJson;
    const stamped = stampPattern(pattern, "gutenberg", "source-system.gutenberg", {
      sourceCompilationId: "compilation.forbidden", projectionMetadata: { active: true }
    });
    expect(stamped).toBe(pattern);
    expect(stamped.patternJson).toBe(body);
    expect(stamped.patternJson).not.toHaveProperty("sourceCompilationId");
    expect(stamped.patternJson).not.toHaveProperty("sourceSystem");
    expect(stamped.patternJson).not.toHaveProperty("projectionMetadata");
  }
);

it("keeps canonical archives outside the source-compilation artifact inventory while persisting their exact bodies", () => {
  const text = "alpha beta";
  const owner = { sourceId: "source.archive" as never, sourceVersionId: "version.archive" as never,
    contentHash: "sha256_archive" as never };
  const streamId = sourceLanguageTrainingStreamId({ ...owner, sourceSystem: "gutenberg", hasher });
  const archives = [archivePattern("archive.source", SOURCE_SEGMENTATION_WITNESS_SCHEMA),
    archivePattern("archive.manifest", LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA)];
  const ordinary: LanguagePatternRecord = { id: "ordinary.syntax", profileId, patternKind: "syntax", support: 1, entropy: 0,
    patternJson: { schema: INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA }, evidenceIds: [], updatedAt: 1 };
  const result = stampSourceLanguageCompilation({ owner, profileId, sourceSystem: "gutenberg", streamId, text, chunks: [text], hasher,
    models: [{ id: "model.archive", streamId, languageHint: "und", maxOrder: 1, discount: 0.5, updatedAt: 1,
      modelJson: { profileId, sourceVersionId: owner.sourceVersionId, sourceSystem: "gutenberg" } }],
    options: { maxOrder: 1, maxCountersPerOrder: 16, vocabularyLimit: 16, languageOnly: false,
      retainNgramObservations: false },
    artifacts: { units: [], patterns: [...archives, ordinary], semanticFrames: [] } });
  expect(result.patterns[0]).toBe(archives[0]);
  expect(result.patterns[1]).toBe(archives[1]);
  expect(result.patterns.slice(0, 2).map(pattern => pattern.patternJson)).toEqual(archives.map(pattern => pattern.patternJson));
  expect(result.patterns[2]!.patternJson).toHaveProperty("sourceCompilationId");
  const receipt = result.patterns.at(-1)!;
  const compilation = (receipt.patternJson as Record<string, unknown>).compilation as Record<string, unknown>;
  const inventory = compilation.artifacts as Record<string, { count: number }>;
  expect(inventory.patterns!.count).toBe(1);
});
