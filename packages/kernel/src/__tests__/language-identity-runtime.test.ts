// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { corpusFamilyForSourceSystem, corpusFamilyForSourceUri, createLanguageIdentityRuntime, roleHydrationLanguageIdentityId } from "../language-identity-runtime.js";
import { CORPUS_ROLE_IDS } from "../corpus-registry.js";
import { createHasher } from "../primitives.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "../storage.js";
import type { LanguageIdentityRecord, SourceVersionId } from "../index.js";

const ENGLISH = ["the", "of", "and", "in", "to", "a", "was", "is", "as", "for", "on", "by"];
const CODE = ["const", "import", "type", "return", "export", "function", "string", "number"];

function row(id: string, uri: string, words: readonly string[], sourceSystem = ""): LanguageProfileSignatureRow {
  return {
    id,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    // No registered source system: this case is the URI fallback, which is what these rows exist to cover.
    sourceSystem,
    sourceUri: uri,
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: [["|", 500], ...words.map((word, index) => [word, 100 - index] as [string, number])]
  };
}

function memoryStore(rows: LanguageProfileSignatureRow[], initialIdentities: LanguageIdentityRecord[] = []): LanguageIdentityStore & { identities: LanguageIdentityRecord[]; assignments: Map<string, string> } {
  const state = { identities: initialIdentities, assignments: new Map<string, string>() };
  return {
    ...state,
    async putIdentities(records) { state.identities = [...records]; },
    async replaceIdentities(records) { state.identities = [...records]; },
    async listIdentities() { return state.identities; },
    async assignProfileLanguages(assignments) { for (const item of assignments) state.assignments.set(item.profileId, item.languageId); },
    async listProfileLanguages() { return [...state.assignments].map(([profileId, languageId]) => ({ profileId, languageId })); },
    async listProfileSignatures(query) { return rows.filter(item => item.id > (query.afterId ?? "")).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, query.limit); },
    get identities() { return state.identities; },
    get assignments() { return state.assignments; }
  };
}

describe("language identity runtime", () => {
  it("grounds a request in agreeing current program owners despite a stronger incidental surface cohort", async () => {
    const identity = (id: string, share: number): LanguageIdentityRecord => ({ schema: "scce.language_identity.v2", id, script: "script:Latn",
      directions: [], closedClass: [{ word: "a", documentShare: share }], families: [], corpusRoles: [], profileCount: 1, membershipCut: 0, createdAt: 1 });
    const owner = identity("identity.owner", 0.46), foreign = identity("identity.foreign", 1), store = memoryStore([], [owner, foreign]);
    store.assignments.set("profile.owner", owner.id); store.assignments.set("profile.same", owner.id); store.assignments.set("profile.foreign", foreign.id);
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 2 });
    await runtime.ensure();
    expect(runtime.selectForSurface("a qzv")?.identity.id).toBe(foreign.id);
    expect(await runtime.identityForProfileOwners(["profile.owner", "profile.same"])).toEqual(owner);
    expect(await runtime.identityForProfileOwners(["profile.owner", "profile.foreign"])).toBeUndefined();
    expect(await runtime.identityForProfileOwners(["profile.owner", "missing.profile"])).toBeUndefined();
    store.assignments.set("profile.owner", "stale.identity");
    expect(await runtime.identityForProfileOwners(["profile.owner"])).toBeUndefined();
    expect(await runtime.identityForProfileOwners([])).toBeUndefined();
  });
  it("reads corpus families from provenance without treating them as admission", () => {
    expect(corpusFamilyForSourceUri("wikipedia://enwiki/block/42")).toBe("wikipedia");
    expect(corpusFamilyForSourceUri("scce://construction-training/source.abc/batch-0006")).toBe("training-batch");
    expect(corpusFamilyForSourceUri("file:///C:/repo/src/kernel.ts")).toBe("files");
    expect(corpusFamilyForSourceUri("")).toBe("none");
    expect(corpusFamilyForSourceSystem("oss_code")).toBe("files");
    expect(corpusFamilyForSourceSystem("source_56633cc317ca")).toBe("files");
    expect(corpusFamilyForSourceSystem("corrections")).toBe("request-corpus");
  });

  it("discovers once, persists, and resolves artifacts by profile or by corpus family", async () => {
    const topics = [["river", "county"], ["school", "county"], ["senate", "state"], ["film", "album"]] as const;
    const batchTopics = [["align", "style"], ["template", "markup"], ["pattern", "construction"], ["evidence", "syntax"]] as const;
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => row(`wiki:${index}`, "wikipedia://enwiki/block/" + index, [...ENGLISH, ...topics[index % topics.length]!])),
      ...Array.from({ length: 6 }, (_, index) => row(`batch:${index}`, "scce://construction-training/source.x/batch-000" + index, [...ENGLISH, ...batchTopics[index % batchTopics.length]!])),
      ...Array.from({ length: 8 }, (_, index) => row(`code:${index}`, "file:///repo/src/file" + index + ".ts", [...CODE, ...topics[index % topics.length]!]))
    ];
    const store = memoryStore(rows);
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 1 });
    const first = await runtime.ensure({ initializeIfMissing: true });
    expect(first.discovered).toBe(true);
    expect(first.identities.length).toBe(2);
    expect(first.assigned).toBe(rows.length);
    const resolver = (await runtime.resolver(["wiki:0", "batch:3", "code:2"]))!;
    const english = resolver.profile("wiki:0")!;
    expect(resolver.profile("batch:3")).toBe(english);
    expect(resolver.profile("code:2")).not.toBe(english);
    // A record without a profile resolves through the family its corpus label belongs to.
    expect(resolver.corpus("wikipedia")).toBe(english);
    expect(resolver.corpus("oss_code")).toBe(resolver.profile("code:2"));
    expect(runtime.selectForSurface("When was Albert Einstein born?")?.identity.id).toBe(english);
    // A second ensure loads what was persisted and discovers nothing.
    const second = await createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 2 }).ensure();
    expect(second.discovered).toBe(false);
    expect(second.identities.map(identity => identity.id)).toEqual(first.identities.map(identity => identity.id));
  });

  it("assigns a singleton corpus profile to a source-owned identity that can route its learned model", async () => {
    const singleton = row("solo:wiki", "wikipedia://enwiki/pages/1", [...ENGLISH, "azurite", "crystal"]);
    const store = memoryStore([singleton]);
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 1 });
    const result = await runtime.ensure({ initializeIfMissing: true });
    const identity = result.identities[0]!;

    expect(result.assigned).toBe(1);
    const resolver = await runtime.resolver([singleton.id]);
    expect(resolver?.profile(singleton.id)).toBe(identity.id);
    expect(resolver?.corpus("wikipedia")).toBe(identity.id);
    expect(identity.families.map(item => item.family)).toContain("wikipedia");
    expect(identity.closedClass).toEqual([]);
    expect(identity.evidence?.sampleCount).toBe(1);
    expect(identity.evidence?.status).toBe("source_observed");
    expect(identity.evidence?.observedSymbols.map(item => item.symbol)).toContain("azurite");
    expect(runtime.selectForSurface("azurite crystal")?.identity.id).toBe(identity.id);
  });

  it("reindexes legacy identities with source-role metadata and leaves formal code models role-scoped", async () => {
    const observedProseClass = ENGLISH.filter(word => word !== "for");
    const observedCodeClass = ["const", "for", "string", "return", "from", "number", "type", "import", "export", "function"];
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => row(`wiki-role:${index}`, `wikipedia://enwiki/${index}`, [...observedProseClass, "rabbit", "carry"], "wikipedia")),
      ...Array.from({ length: 8 }, (_, index) => row(`code-role:${index}`, `file:///repo/${index}.ts`, [...observedCodeClass, "rabbit", "carry"], "oss_code")),
      ...Array.from({ length: 5 }, (_, index) => row(`docs-role:${index}`, `file:///repo/docs/${index}.md`, [...observedProseClass, "rabbit", "carry"], "oss_docs")),
      ...Array.from({ length: 4 }, (_, index) => row(`book-role:${index}`, `file:///corpus/gutenberg/${index}.txt`, [...observedProseClass, "rabbit", "carry"], "gutenberg")),
      ...Array.from({ length: 4 }, (_, index) => row(`dialogue-role:${index}`, `file:///corpus/dialogue/${index}.txt`, [...observedProseClass, "rabbit", "carry"], "dialogue"))
    ];
    const stale = [{
      schema: "scce.language_identity.v1", id: "old", script: "script:Latn", directions: [], closedClass: [],
      families: [{ family: "files", count: 13 }], profileCount: 13, membershipCut: 0, createdAt: 1
    }] as unknown as LanguageIdentityRecord[];
    const store = memoryStore(rows, stale);
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 2 });
    const refreshed = await runtime.ensure({ rebuild: true });
    const code = refreshed.identities.find(identity => identity.corpusRoles.some(role => role.corpusRoleId === CORPUS_ROLE_IDS.softwareSymbolic))!;
    const natural = refreshed.identities.find(identity => identity.corpusRoles.some(role => role.corpusRoleId === CORPUS_ROLE_IDS.softwareDocumentation))!;

    expect(refreshed.discovered).toBe(true);
    expect(code).toBeDefined();
    expect(natural).toBeDefined();
    // Family independence remains intact: code and natural documentation still share the existing files family.
    expect(code.families.map(family => family.family)).toContain("files");
    expect(natural.families.map(family => family.family)).toContain("files");
    expect(natural.corpusRoles.map(role => role.corpusRoleId)).toEqual(expect.arrayContaining([
      CORPUS_ROLE_IDS.encyclopedic,
      CORPUS_ROLE_IDS.publicDomainProse,
      CORPUS_ROLE_IDS.dialogue,
      CORPUS_ROLE_IDS.softwareDocumentation
    ]));
    expect(runtime.selectForSurface("What does White Rabbit carry for?")?.identity).toBe(natural);
    expect(roleHydrationLanguageIdentityId(CORPUS_ROLE_IDS.softwareSymbolic, natural.id)).toBeUndefined();
    expect(roleHydrationLanguageIdentityId(CORPUS_ROLE_IDS.encyclopedic, natural.id)).toBe(natural.id);
  });
});
