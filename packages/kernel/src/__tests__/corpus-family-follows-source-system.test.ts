// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CORPUS_ROLE_IDS, CORPUS_SOURCE_SYSTEM_IDS, createCorpusRegistry } from "../corpus-registry.js";
import { closedClassForFamilies } from "../language-identity.js";
import { corpusFamiliesForRole, corpusFamilyForSource, createLanguageIdentityRuntime } from "../language-identity-runtime.js";
import { createHasher } from "../primitives.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "../storage.js";
import type { LanguageIdentityRecord, SourceVersionId } from "../index.js";

/**
 * The live shape: 65 dialogue documents ingested from local files, and the encyclopedic corpus that seeds the
 * identity. The dialogue words below are the ones measured on the live brain's dialogue profiles (i 59/65, you 58/65).
 */
const ENCYCLOPEDIC = ["the", "in", "a", "of", "and", "to", "was", "is", "as", "on", "for", "by", "at", "with", "from"];
const DIALOGUE = [...ENCYCLOPEDIC, "i", "you", "me", "my", "we", "what", "who", "how"];
const REGISTRY = createCorpusRegistry();

function row(id: string, sourceSystem: string, uri: string, words: readonly string[]): LanguageProfileSignatureRow {
  return {
    id,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    sourceSystem,
    sourceUri: uri,
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: [...words.map((word, index) => [word, 100 - index] as [string, number]), [`own${id}`, 1]]
  };
}

function memoryStore(rows: LanguageProfileSignatureRow[]): LanguageIdentityStore {
  const state = { identities: [] as LanguageIdentityRecord[], assignments: new Map<string, string>() };
  return {
    async putIdentities(records) { state.identities = [...records]; },
    async listIdentities() { return state.identities; },
    async assignProfileLanguages(assignments) { for (const item of assignments) state.assignments.set(item.profileId, item.languageId); },
    async listProfileLanguages() { return [...state.assignments].map(([profileId, languageId]) => ({ profileId, languageId })); },
    async listProfileSignatures(query) { return rows.filter(item => item.id > (query.afterId ?? "")).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, query.limit); }
  };
}

describe("a document's corpus family follows its source system, not its URI scheme", () => {
  it("puts a file-ingested dialogue document in the dialogue family instead of the source-code family", () => {
    const dialogue = { sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue, sourceUri: "file:///C:/scce/corpus/dialogue/pg1005.txt" };
    // Measured live: 65 profiles with exactly this shape were bucketed "files", the owner's own TypeScript bucket.
    expect(corpusFamilyForSource(dialogue, REGISTRY)).toBe("dialogue");
    expect(corpusFamiliesForRole(REGISTRY, CORPUS_ROLE_IDS.dialogue)).toContain(corpusFamilyForSource(dialogue, REGISTRY));
    // Source code keeps the family it had: this moves the corpora the scheme was hiding, nothing else.
    expect(corpusFamilyForSource({ sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.ossCode, sourceUri: "file:///C:/scce/src/kernel.ts" }, REGISTRY)).toBe("files");
    expect(corpusFamilyForSource({ sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.gutenberg, sourceUri: "file:///C:/scce/corpus/gutenberg/alice.txt" }, REGISTRY)).toBe("gutenberg");
    // An unregistered source system is no signal at all, so the URI has the last word rather than no word.
    expect(corpusFamilyForSource({ sourceSystem: "", sourceUri: "wikipedia://enwiki/pages/1000/Hercule_Poirot" }, REGISTRY)).toBe("wikipedia");
    expect(corpusFamilyForSource({ sourceSystem: "source_9e62380a572d", sourceUri: "file:///C:/scce/corpus/gutenberg/a-tale-of-two-cities.txt" }, REGISTRY)).toBe("gutenberg");
  });

  it("lets the dialogue role read the closed class its own corpus taught", async () => {
    const rows = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        row(`wiki:${String(index).padStart(3, "0")}`, CORPUS_SOURCE_SYSTEM_IDS.wikipedia, `wikipedia://enwiki/block/${index}`, ENCYCLOPEDIC)),
      ...Array.from({ length: 8 }, (_unused, index) =>
        row(`talk:${String(index).padStart(3, "0")}`, CORPUS_SOURCE_SYSTEM_IDS.dialogue, `file:///C:/scce/corpus/dialogue/pg100${index}.txt`, DIALOGUE))
    ];
    const runtime = createLanguageIdentityRuntime({ store: memoryStore(rows), hasher: createHasher(), now: () => 1, corpusRegistry: REGISTRY });
    const { identities } = await runtime.ensure();
    const identity = identities.find(record => record.profileCount === rows.length)!;
    expect(identity).toBeDefined();
    expect(identity.families.map(family => family.family)).toContain("dialogue");
    // The whole point: the role's own families answer, so "i" and "you" are form for a conversational turn.
    const spoken = closedClassForFamilies(identity, corpusFamiliesForRole(REGISTRY, CORPUS_ROLE_IDS.dialogue));
    expect(spoken).toContain("i");
    expect(spoken).toContain("you");
    // Before the fix the dialogue documents were in "files", no family answered the dialogue role, and the role fell
    // back to the identity's encyclopedic class -- which names neither.
    expect(identity.closedClass.map(word => word.word)).not.toContain("i");
    expect(identity.closedClass.map(word => word.word)).not.toContain("you");
    expect(closedClassForFamilies(identity, corpusFamiliesForRole(REGISTRY, CORPUS_ROLE_IDS.encyclopedic))).not.toContain("you");
  });
});
