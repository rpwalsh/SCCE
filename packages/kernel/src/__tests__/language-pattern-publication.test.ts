// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { INDUCED_LANGUAGE_MEMORY_PUBLICATIONS, LANGUAGE_CONSTRUCTION_PUBLICATION, publishCompiledLanguagePatterns } from "../language-pattern-publication.js";
import type { LanguageMemoryStore, LanguagePatternRecord } from "../storage.js";
import type { InformationLabel } from "../types.js";

describe("compiled language-pattern publication ownership", () => {
  it("writes each induced component once while publishing every scope including empty families", async () => {
    const changes: Parameters<NonNullable<LanguageMemoryStore["replaceLanguagePatternProjection"]>>[0][] = [];
    const informationLabel: InformationLabel = { tenantId: "tenant.fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" };
    const patterns = INDUCED_LANGUAGE_MEMORY_PUBLICATIONS.slice(0, 2).map((scope, index): LanguagePatternRecord => ({
      id: `induced.${index}`, profileId: "profile.owned", patternKind: "syntax", support: 1, entropy: 0,
      patternJson: { schema: scope.patternSchema }, evidenceIds: [], updatedAt: 1, informationLabel
    }));
    await publishCompiledLanguagePatterns({ store: { replaceLanguagePatternProjection: async change => { changes.push(change); } } as LanguageMemoryStore,
      owner: { sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, contentHash: "sha256_owned" as never },
      profileId: "profile.owned", sourceSystem: "gutenberg", informationLabel, patterns, projections: INDUCED_LANGUAGE_MEMORY_PUBLICATIONS });
    expect(changes.map(change => change.projection.patternIds)).toEqual([["induced.0"], ["induced.1"], [], []]);
    expect(changes.flatMap(change => change.patterns.map(pattern => pattern.id))).toEqual(patterns.map(pattern => pattern.id));
  });
  it("requires atomic projection storage even when the replacement induced set is empty", async () => {
    const putLanguagePatterns = vi.fn(async () => undefined);
    await expect(publishCompiledLanguagePatterns({ store: { putLanguagePatterns } as unknown as LanguageMemoryStore,
      owner: { sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, contentHash: "sha256_owned" as never },
      profileId: "profile.owned", sourceSystem: "gutenberg", informationLabel: { tenantId: "tenant.fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" },
      patterns: [], projections: INDUCED_LANGUAGE_MEMORY_PUBLICATIONS })).rejects.toThrow("active projection publication");
    expect(putLanguagePatterns).not.toHaveBeenCalled();
  });
  it("retains an adapter-owned auxiliary profile while enforcing the active construction profile", async () => {
    const informationLabel: InformationLabel = { tenantId: "tenant.fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" };
    const replaceLanguagePatternProjection = vi.fn(async () => undefined);
    const store = { replaceLanguagePatternProjection } as unknown as LanguageMemoryStore;
    const pattern: LanguagePatternRecord = { id: "adapter.auxiliary", profileId: "adapter.profile", patternKind: "semantic_role", support: 1, entropy: 0,
      patternJson: { schema: "adapter.auxiliary.v1", payload: { original: true } }, evidenceIds: [], updatedAt: 1, informationLabel };
    const input = { store, owner: { sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, contentHash: "sha256_owned" as never },
      profileId: "profile.owned", sourceSystem: "gutenberg", informationLabel, patterns: [pattern], projections: [LANGUAGE_CONSTRUCTION_PUBLICATION] };
    await publishCompiledLanguagePatterns(input);
    expect(replaceLanguagePatternProjection).toHaveBeenCalledWith(expect.objectContaining({ patterns: [pattern],
      projection: expect.objectContaining({ profileId: input.profileId, patternIds: [] }) }));
    replaceLanguagePatternProjection.mockClear();
    await expect(publishCompiledLanguagePatterns({ ...input, patterns: [{ ...pattern,
      patternJson: { schema: LANGUAGE_CONSTRUCTION_PUBLICATION.patternSchema } }] })).rejects.toThrow("conflicting source scope");
    expect(replaceLanguagePatternProjection).not.toHaveBeenCalled();
  });
});
