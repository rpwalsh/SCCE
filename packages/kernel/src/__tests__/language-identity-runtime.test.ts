// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { corpusFamilyForSourceSystem, corpusFamilyForSourceUri, createLanguageIdentityRuntime } from "../language-identity-runtime.js";
import { createHasher } from "../primitives.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "../storage.js";
import type { LanguageIdentityRecord, SourceVersionId } from "../index.js";

const ENGLISH = ["the", "of", "and", "in", "to", "a", "was", "is", "as", "for", "on", "by"];
const CODE = ["const", "import", "type", "return", "export", "function", "string", "number"];

function row(id: string, uri: string, words: readonly string[]): LanguageProfileSignatureRow {
  return {
    id,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    sourceUri: uri,
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: [["|", 500], ...words.map((word, index) => [word, 100 - index] as [string, number])]
  };
}

function memoryStore(rows: LanguageProfileSignatureRow[]): LanguageIdentityStore & { identities: LanguageIdentityRecord[]; assignments: Map<string, string> } {
  const state = { identities: [] as LanguageIdentityRecord[], assignments: new Map<string, string>() };
  return {
    ...state,
    async putIdentities(records) { state.identities = [...records]; },
    async listIdentities() { return state.identities; },
    async assignProfileLanguages(assignments) { for (const item of assignments) state.assignments.set(item.profileId, item.languageId); },
    async listProfileLanguages() { return [...state.assignments].map(([profileId, languageId]) => ({ profileId, languageId })); },
    async listProfileSignatures(query) { return rows.filter(item => item.id > (query.afterId ?? "")).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, query.limit); },
    get identities() { return state.identities; },
    get assignments() { return state.assignments; }
  };
}

describe("language identity runtime", () => {
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
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => row(`wiki:${index}`, "wikipedia://enwiki/block/" + index, [...ENGLISH, "river", "county"])),
      ...Array.from({ length: 6 }, (_, index) => row(`batch:${index}`, "scce://construction-training/source.x/batch-000" + index, [...ENGLISH, "align", "style"])),
      ...Array.from({ length: 8 }, (_, index) => row(`code:${index}`, "file:///repo/src/file" + index + ".ts", [...CODE, "kernel", "graph"]))
    ];
    const store = memoryStore(rows);
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 1 });
    const first = await runtime.ensure();
    expect(first.discovered).toBe(true);
    expect(first.identities.length).toBe(2);
    expect(first.assigned).toBe(rows.length);
    const resolver = runtime.resolver()!;
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
});
