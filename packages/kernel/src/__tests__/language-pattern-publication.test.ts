// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { LANGUAGE_CONSTRUCTION_PUBLICATION, publishCompiledLanguagePatterns } from "../language-pattern-publication.js";
import type { LanguageMemoryStore, LanguagePatternRecord } from "../storage.js";
import type { InformationLabel } from "../types.js";

describe("compiled language-pattern publication ownership", () => {
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
