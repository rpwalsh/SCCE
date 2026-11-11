// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher, createLanguageInductionEngine, semanticInductionProjection, requestSeedLanguagePattern, type LanguagePatternRecord } from "@scce/kernel";
import { encodeDurableArtifact, decodeDurableArtifact, decodedJsonByteLengths, DECODED_JSON_BYTE_LEDGER_KEY } from "../durable-artifact-storage.js";
import { SEMANTIC_PROJECTION_STORAGE_KEY, semanticEntityQueryProjection,
  semanticLexicalClassQueryProjection } from "../semantic-projection-storage.js";

const hasher = createHasher();
function fixture() {
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: [
    { id: "source.notes", text: "Alice follows Bob. Bob follows Alice. Mira directs Neralis. Neralis stands on Pelora island.", evidenceIds: ["evidence.notes" as never], trust: 0.8 },
    { id: "source.other", text: "Мира следует за Борисом. Борис следует за Мирой. 한국어 문장입니다.", evidenceIds: ["evidence.other" as never], trust: 0.9 }
  ] });
  const projection = semanticInductionProjection({ factors: model.semanticInductionFactors!, semanticFrames: model.semanticFrames,
    graphBoundConstructions: model.graphBoundConstructions, lexicalClasses: model.lexicalClasses,
    relationHypothesisModel: model.relationHypothesisModel, hasher });
  return { schema: "scce.induced_language_model.semantic_memory.v1", profileId: "profile.notes", sourceVersionId: "source.notes",
    semanticFrames: model.semanticFrames, graphBoundConstructions: model.graphBoundConstructions,
    lexicalClasses: model.lexicalClasses, relationHypothesisModel: model.relationHypothesisModel, semanticInductionProjection: projection, counts: {} };
}
describe("sufficient semantic projection persistence", () => {
  it("stores one sufficient tape and cold-restores every original field before runtime use", () => {
    const logical = fixture();
    const stored = encodeDurableArtifact(logical) as Record<string, unknown>;
    expect(stored[SEMANTIC_PROJECTION_STORAGE_KEY]).toBeDefined();
    expect(stored.semanticFrames).toBeUndefined(); expect(stored.relationHypothesisModel).toBeUndefined();
    expect(stored.graphBoundConstructions).toEqual(semanticEntityQueryProjection(logical.graphBoundConstructions));
    expect(stored.lexicalClasses).toEqual(semanticLexicalClassQueryProjection(logical.lexicalClasses));
    expect(stored[DECODED_JSON_BYTE_LEDGER_KEY]).toMatchObject(decodedJsonByteLengths(logical));
    const restored = decodeDurableArtifact(JSON.parse(JSON.stringify(stored)));
    expect(restored).toEqual(logical);
    expect(hasher.digestHex(canonicalStringify(restored))).toBe(hasher.digestHex(canonicalStringify(logical)));
  });
  it("keeps the exact SQL-readable entity seed projection and rejects changed learned facts", () => {
    const logical = fixture(), stored = encodeDurableArtifact(logical) as Record<string, unknown>;
    const pattern = (patternJson: unknown) => ({ id: "pattern.notes", profileId: "profile.notes", patternKind: "semantic_role", patternJson,
      support: 1, entropy: 0, evidenceIds: [], updatedAt: 1 } as unknown as LanguagePatternRecord);
    expect(requestSeedLanguagePattern(pattern(stored))).toEqual(requestSeedLanguagePattern(pattern(logical)));
    const badFacts = structuredClone(stored) as any;
    badFacts.semanticInductionProjection.text += " changed";
    expect(() => decodeDurableArtifact(badFacts)).toThrow("semantic projection");
    const badQuery = structuredClone(stored) as any;
    badQuery.graphBoundConstructions.push({ evidenceIds: ["unowned"], slots: [] });
    expect(() => decodeDurableArtifact(badQuery)).toThrow("semantic projection");
  });
  it("rejects a projection which omits one computed role or attempts to retain conflicting caches", () => {
    const logical = fixture(), changed = structuredClone(logical);
    changed.semanticFrames.pop();
    expect(() => encodeDurableArtifact(changed)).toThrow("semantic projection");
    const stored = encodeDurableArtifact(logical) as Record<string, unknown>;
    stored.semanticFrames = [];
    expect(() => decodeDurableArtifact(stored)).toThrow("semantic projection");
  });
});
