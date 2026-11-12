// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageInductionEngine, type LanguageInductionDocument } from "../language-induction.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { languageMemoryPatternsFromInducedLanguageModel, INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA } from "../language-induction-memory.js";
import { replaySemanticInductionFactors } from "../semantic-induction-factors.js";
import * as relation from "../relation-hypothesis.js";
import { encodeSyntaxSourceReplay, decodeSyntaxSourceReplay, syntaxSourceReplayBindingSetReference, SYNTAX_SOURCE_REPLAY_KEY } from "../syntax-source-replay-storage.js";
import { encodeSemanticSourceReplay, decodeSemanticSourceReplay, semanticSourceReplayBindingSetReference } from "../semantic-source-replay-storage.js";
import { captureSourceTextReplayBindings, restoreSourceTextReplayDocuments, sourceTextReplayOwnerIds, sourceTextReplayJson as exact,
  sourceTextReplayDigest as digest, packSourceTextReplayRecipe, type SourceTextReplayContext, type SourceTextReplayEnvelope } from "../source-text-replay.js";
import { createSourceTextReplayBindingSet, sourceTextReplayBindingSetReference } from "../source-text-replay-binding-set.js";

const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), namespace: "source-replay", deterministicReplay: true });
function fixture() {
  const texts = ["甲 follows 乙。丙 follows 丁。 🧪e\u0301 follows 甲。 ".repeat(3),
    "戊 follows 己。 庚 follows 辛。 Мира видит Бориса. Борис видит Миру. العربية لغة. हिन्दी भाषा। ".repeat(3), "42\u0000 🧭 e\u0301"];
  const owners: SourceTextReplayContext["owners"] = new Map(texts.map((text, index) => {
    const ownerText = index === 0 ? `前置🧭|${text}|末尾` : text;
    return [`owner.${index}`, { text: ownerText, sourceVersionId: ids.sourceVersionId(ownerText) }];
  }));
  const documents: LanguageInductionDocument[] = texts.map((text, index) => {
    const owner = owners.get(`owner.${index}`)!, start = index === 0 ? owner.text.indexOf(text) : 0;
    return { id: index === 0 ? "doc\u0000甲" : `owner.${index}`, text, sourceVersionId: owner.sourceVersionId!, sourceFamilyId: `family.${index}`, trust: 0.23 + index / 10,
      evidenceIds: [ids.evidenceId({ sourceVersionId: owner.sourceVersionId!, byteStart: 0, byteEnd: Buffer.byteLength(owner.text), spanHash: ids.contentHash(owner.text) })],
      ...(index === 0 ? { sourceWindow: { ownerDocumentId: "owner.0", startUtf16: start, endUtf16: start + text.length } } : {}) };
  });
  // Unwindowed documents identify their complete owner directly.
  return { documents, context: { owners, hasher } };
}
function resolved() {
  const bindings = captureSourceTextReplayBindings(f.documents, f.context);
  const bindingSet = createSourceTextReplayBindingSet({ modelId: model.id, profileId: "profile.kernel-replay",
    manifestPatternId: "manifest.pattern", manifestDigest: "a".repeat(64), bindings }, hasher);
  return { hasher, documents: f.documents, bindingSet: sourceTextReplayBindingSetReference(bindingSet, hasher) };
}
let f: ReturnType<typeof fixture>, model: ReturnType<ReturnType<typeof createLanguageInductionEngine>["induce"]>, pattern: Record<string, unknown>;
beforeAll(() => {
  f = fixture(); model = createLanguageInductionEngine({ hasher }).induce({ documents: f.documents });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const profiles = f.documents.map(doc => language.acquire({ sourceVersionId: doc.sourceVersionId!, text: doc.text, createdAt: 1 }));
  const published = languageMemoryPatternsFromInducedLanguageModel({ model, profiles, idFactory: ids, updatedAt: 1 });
  pattern = published.patterns.map(row => row.patternJson as Record<string, unknown>).find(row => row.schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA)!;
  expect(pattern).toBeDefined();
});
const changeRecipe = (envelope: SourceTextReplayEnvelope, change: (recipe: any) => void, resign = false): SourceTextReplayEnvelope => {
  const recipe = JSON.parse(envelope.recipeJson); change(recipe);
  if (resign) { const { digest: _old, ...body } = recipe; recipe.digest = digest(body, hasher); }
  return packSourceTextReplayRecipe(recipe, hasher);
};

describe("owner-bound source text replay", () => {
  it("binds exact UTF-16 windows and ordered document metadata without source text copies", () => {
    const refs = captureSourceTextReplayBindings(f.documents, f.context);
    expect(sourceTextReplayOwnerIds(refs)).toEqual(["owner.0", "owner.1", "owner.2"]);
    expect(restoreSourceTextReplayDocuments(cold(refs), f.context)).toEqual(f.documents);
    expect(JSON.stringify(refs)).not.toContain(f.documents[0]!.text);
  });
  it.each(["missing", "version", "text", "window"])("fails closed on %s owner mismatch", mutation => {
    const refs = captureSourceTextReplayBindings(f.documents, f.context), owners = new Map(f.context.owners);
    if (mutation === "missing") owners.delete("owner.0");
    if (mutation === "version") owners.set("owner.0", { ...owners.get("owner.0")!, sourceVersionId: ids.sourceVersionId("foreign") });
    if (mutation === "text") owners.set("owner.0", { ...owners.get("owner.0")!, text: "changed" + owners.get("owner.0")!.text });
    if (mutation === "window") refs[0]!.startUtf16++;
    expect(() => restoreSourceTextReplayDocuments(refs, { owners, hasher })).toThrow();
  });
  it("rejects a producer window that splits a surrogate pair", () => {
    const owner = { text: "🧭x", sourceVersionId: ids.sourceVersionId("🧭x") };
    const doc = { id: "split", text: owner.text.slice(1), sourceVersionId: owner.sourceVersionId,
      sourceWindow: { ownerDocumentId: "owner", startUtf16: 1, endUtf16: owner.text.length } };
    expect(() => captureSourceTextReplayBindings([doc], { owners: new Map([["owner", owner]]), hasher })).toThrow();
  });
});

describe("syntax templates and count replay", () => {
  it("cold restores actual memory-projector templates/counts, retaining every unrelated field", () => {
    const context = resolved(), stored = encodeSyntaxSourceReplay(pattern, context);
    expect(stored.templates).toBeUndefined(); expect(stored.counts).toEqual(pattern.counts);
    expect(exact(decodeSyntaxSourceReplay(cold(stored), context))).toBe(exact(pattern));
    expect(syntaxSourceReplayBindingSetReference(stored, hasher)).toEqual(context.bindingSet);
    expect(JSON.stringify(stored[SYNTAX_SOURCE_REPLAY_KEY])).not.toContain("\u0000");
  });
  it("restores full-model syntaxTemplates independently of an unrelated counts field", () => {
    const value = { syntaxTemplates: model.syntaxTemplates, counts: { unrelated: 7 }, opaque: "雪\u0000" };
    const context = resolved();
    expect(decodeSyntaxSourceReplay(cold(encodeSyntaxSourceReplay(value, context)), context)).toEqual(value);
  });
  it.each(["order", "digest", "schema", "field", "extra"])("rejects %s recipe mutation", mutation => {
    const context = resolved(), stored = cold(encodeSyntaxSourceReplay(pattern, context));
    stored[SYNTAX_SOURCE_REPLAY_KEY] = changeRecipe(stored[SYNTAX_SOURCE_REPLAY_KEY] as SourceTextReplayEnvelope, recipe => {
      if (mutation === "order") recipe.bindingSet.id = `${recipe.bindingSet.id.slice(0, -1)}0`;
      if (mutation === "digest") recipe.expectedLogicalDigest = "foreign";
      if (mutation === "schema") recipe.schema = "unsupported";
      if (mutation === "field") recipe.field = "syntaxTemplates";
      if (mutation === "extra") recipe.extra = true;
    }, true);
    expect(() => decodeSyntaxSourceReplay(stored, context)).toThrow();
  });
  it("rejects incorrect producer caches and conflicting retained copies", () => {
    const context = resolved();
    expect(() => encodeSyntaxSourceReplay({ ...pattern, counts: {} }, context)).toThrow();
    const stored = encodeSyntaxSourceReplay(pattern, context);
    expect(() => decodeSyntaxSourceReplay({ ...stored, templates: [] }, context)).toThrow();
    expect(() => decodeSyntaxSourceReplay({ ...stored, counts: {} }, context)).toThrow();
    expect(() => encodeSyntaxSourceReplay(stored, context)).toThrow();
  });
});

describe("semantic sentence/symbol replay", () => {
  it("stores no sentence/symbol arrays and preserves every posterior and logical factor byte", () => {
    const context = resolved(), factors = model.semanticInductionFactors!, stored = encodeSemanticSourceReplay(factors, context);
    const recipe = JSON.parse(stored.recipeJson);
    expect(recipe.header.sentences).toBeUndefined(); expect(recipe.header.documents).toBeUndefined(); expect(recipe.sentences).toBeUndefined();
    expect(recipe.hypotheses).toEqual(factors.sentences.map(row => row.hypotheses));
    expect(semanticSourceReplayBindingSetReference(stored, hasher)).toEqual(context.bindingSet);
    for (const evidenceId of factors.documents.flatMap(document => document.evidenceIds)) {
      expect(stored.recipeJson).not.toContain(evidenceId);
    }
    const infer = vi.spyOn(relation, "inferRelationHypotheses").mockImplementation(() => { throw Error("re-inference is forbidden"); });
    try {
      const restored = decodeSemanticSourceReplay(cold(stored), context);
      expect(exact(restored)).toBe(exact(factors)); expect(infer).not.toHaveBeenCalled();
      expect(replaySemanticInductionFactors({ factors: restored, hasher })).toEqual(replaySemanticInductionFactors({ factors, hasher }));
    } finally { infer.mockRestore(); }
  });
  it.each(["order", "posterior", "length", "binding", "digest", "unknown"])("fails closed on %s corruption even with a rehashed envelope", mutation => {
    const context = resolved(), stored = encodeSemanticSourceReplay(model.semanticInductionFactors!, context);
    const changed = changeRecipe(stored, recipe => {
      if (mutation === "order") recipe.bindingSet.id = `${recipe.bindingSet.id.slice(0, -1)}0`;
      if (mutation === "posterior") recipe.hypotheses.find((rows: unknown[]) => rows.length)[0][1] /= 2;
      if (mutation === "length") recipe.hypotheses.pop();
      if (mutation === "binding") recipe.bindingSet.id = "source_text_replay_bindings_" + "b".repeat(64);
      if (mutation === "digest") recipe.expectedLogicalDigest = "foreign";
      if (mutation === "unknown") recipe.extra = true;
    }, true);
    expect(() => decodeSemanticSourceReplay(changed, context)).toThrow();
  });
});
