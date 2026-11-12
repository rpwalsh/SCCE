// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { beforeAll, expect, it, vi } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createLanguageInductionEngine,
  languageMemoryPatternsFromInducedLanguageModel, INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA, SYNTAX_SOURCE_REPLAY_KEY,
  createSourceTextReplayBindingSet, sourceTextReplayBindingSetReference, sourceTextReplayJson as exact,
  type LanguageInductionDocument, type LanguageSegmentationWitness, type SourceTextReplayBindingSet } from "@scce/kernel";
import { createSourceTextReplayStore, type SourceTextReplayStorageHost } from "../source-text-replay-store.js";
import { encodeSegmentationWitnessArchives, decodeSegmentationWitnessArchives } from "../segmentation-witness-archive-storage.js";
import { createCanonicalCreativeEventCodec, type CreativeEventStorageHost } from "../canonical-creative-event-store.js";
import { decodedJsonByteLedger, DECODED_JSON_BYTE_LEDGER_KEY } from "../decoded-json-byte-ledger.js";

const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown) => value as Record<string, unknown>;
const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), namespace: "async-source-replay", deterministicReplay: true });
let model: ReturnType<ReturnType<typeof createLanguageInductionEngine>["induce"]>, syntax: Record<string, unknown>, semantic: Record<string, unknown>;
let ownerRows: Map<string, { text: string; sourceVersionId: string }>, sourceRows: Array<{ value: unknown; profileId: string }>;
const profileId = "profile.source-replay";
beforeAll(async () => {
  const texts = ["甲 follows 乙。 丙 follows 丁。 ".repeat(5), "戊 follows 己。 Мира видит Бориса. العربية لغة. हिन्दी भाषा। ".repeat(4)];
  const documents: LanguageInductionDocument[] = texts.map((text, index) => ({ id: `owner.${1 - index}`, text,
    sourceVersionId: ids.sourceVersionId(text), sourceFamilyId: "family.source", trust: 0.43 + index / 10,
    evidenceIds: [ids.evidenceId({ sourceVersionId: ids.sourceVersionId(text), byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: ids.contentHash(text) })],
    sourceWindow: { ownerDocumentId: `owner.${1 - index}`, startUtf16: 0, endUtf16: text.length } }));
  ownerRows = new Map(documents.map(document => [document.id, { text: document.text, sourceVersionId: document.sourceVersionId! }]));
  model = createLanguageInductionEngine({ hasher }).induce({ documents, captureScoreFactors: true });
  const profiles = documents.map(document => createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: document.sourceVersionId!, text: document.text, createdAt: 1 }));
  const published = languageMemoryPatternsFromInducedLanguageModel({ model, profiles, idFactory: ids, updatedAt: 1 });
  const selected = published.patterns.filter(row => row.profileId === profiles[0]!.id);
  syntax = object(selected.find(row => object(row.patternJson).schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA)!.patternJson);
  semantic = object(selected.find(row => object(row.patternJson).schema === "scce.induced_language_model.semantic_memory.v1")!.patternJson);
  // Use the actual canonical source witnesses, with text/DAG stripped by the existing archive codec.
  const sourceWitnesses = model.segmentationWitness.populations.flatMap(population => population.documents);
  sourceRows = (await encodeSegmentationWitnessArchives(sourceWitnesses.map(value => ({ value, profileId })), {
    getOwnerDocuments: async requested => new Map(requested.map(id => [id, ownerRows.get(id)!]))
  })).map(row => ({ value: cold(row.value), profileId }));
  expect(sourceRows.every(row => object(row.value).schema === SOURCE_SEGMENTATION_WITNESS_SCHEMA)).toBe(true);
  expect(sourceRows.every(row => !Object.hasOwn(object(row.value), "text"))).toBe(true);
});

function fixture(bindingSets = new Map<string, SourceTextReplayBindingSet>()) {
  const state = { missing: false, tampered: false, wrongVersion: false, wrongWitness: false, missingOrder: false };
  const getOwnerDocuments = vi.fn(async (requested: readonly string[]) => new Map(requested.flatMap(id => {
    const row = ownerRows.get(id); if (!row || state.missing) return [];
    return [[id, { text: state.tampered ? "changed " + row.text : row.text,
      sourceVersionId: state.wrongVersion ? "foreign.version" : row.sourceVersionId }] as const];
  })));
  const loadWitness = vi.fn(async () => {
    const decoded = await decodeSegmentationWitnessArchives(sourceRows, { getOwnerDocuments });
    const byId = new Map(decoded.map(row => [object(row.value).id, row.value]));
    const witness: LanguageSegmentationWitness = { ...model.segmentationWitness,
      populations: model.segmentationWitness.populations.map(population => ({ ...population,
        documents: population.documents.map(document => byId.get(document.id) as typeof document) })) };
    if (state.wrongWitness) witness.populations[0]!.documents = [];
    return witness;
  });
  const loadSemanticFactors = vi.fn(async (): Promise<unknown> => state.missingOrder ? undefined : cold(model.semanticInductionFactors));
  const publishBindingSet: SourceTextReplayStorageHost["publishBindingSet"] = vi.fn(async input => {
    const reference = input.witnessReference ? object(input.witnessReference) : undefined;
    const bindingSet = createSourceTextReplayBindingSet({ modelId: input.scope.modelId,
      profileId: input.scope.profileId ?? profileId,
      manifestPatternId: typeof reference?.manifestPatternId === "string" ? reference.manifestPatternId
        : String(object(syntax.segmentationWitness).manifestPatternId),
      manifestDigest: "a".repeat(64), bindings: input.bindings }, hasher);
    const bindingReference = sourceTextReplayBindingSetReference(bindingSet, hasher), prior = bindingSets.get(bindingReference.id);
    if (prior && exact(prior) !== exact(bindingSet)) throw Error("binding set changed");
    bindingSets.set(bindingReference.id, bindingSet); return bindingReference;
  });
  const loadBindingSet: SourceTextReplayStorageHost["loadBindingSet"] = vi.fn(async (_scope, reference) => {
    const value = bindingSets.get(reference.id); if (!value) throw Error("binding set unavailable"); return cold(value);
  });
  const host: SourceTextReplayStorageHost = { getOwnerDocuments, loadWitness, loadSemanticFactors, publishBindingSet, loadBindingSet };
  const store = createSourceTextReplayStore(host);
  const noQueries = vi.fn(async () => { throw Error("unexpected SQL in durable-only fixture"); });
  const base = createCanonicalCreativeEventCodec({ table: name => `"fixture"."${name}"`, query: noQueries,
    transaction: async work => work(), requireWritableInformationLabel: () => { throw Error("unexpected creative label"); },
    informationAccessPredicate: () => ({ sql: "TRUE", params: [] }) } as CreativeEventStorageHost);
  return { store, state, base, loadWitness, loadSemanticFactors, getOwnerDocuments, publishBindingSet, loadBindingSet, bindingSets, noQueries };
}

it("cold-restores actual pattern syntax/counts and semantic factors through archive-owned source text", async () => {
  const f = fixture(), originals = [syntax, semantic], durable = await f.base.encodeMany(originals.map(value => ({ value })));
  const stored = await f.store.encodeMany(durable.map((value, index) => ({ value, logicalValue: originals[index] })));
  expect(object(stored[0]).templates).toBeUndefined(); expect(object(stored[0]).counts).toBeUndefined();
  expect(object(stored[0])[SYNTAX_SOURCE_REPLAY_KEY]).toBeDefined();
  expect(f.bindingSets.size).toBe(1); expect(f.publishBindingSet).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(stored)).not.toContain(String(model.semanticInductionFactors!.documents[0]!.evidenceIds[0]));
  expect(f.loadSemanticFactors).not.toHaveBeenCalled(); expect(f.loadWitness).toHaveBeenCalledTimes(1);
  // Fresh codec invocation owns no in-memory caches from encoding.
  const coldReader = fixture(f.bindingSets);
  const replayed = await coldReader.store.decodeMany(cold(stored));
  expect(exact(await coldReader.base.decodeMany(replayed))).toBe(exact(originals));
  expect(coldReader.loadSemanticFactors).not.toHaveBeenCalled();
  expect(object(stored[1])[DECODED_JSON_BYTE_LEDGER_KEY]).toEqual(object(durable[1])[DECODED_JSON_BYTE_LEDGER_KEY]);
});

it("supports a full induced-model checkpoint and nested event projections with only a parent byte charge", async () => {
  const f = fixture();
  const checkpoint = { ...model, segmentationWitness: { schema: LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
    manifestPatternId: "segmentation_archive.owned" }, memoryProjections: [{ patternJson: syntax }] };
  const event = { schema: "event.fixture", model: checkpoint, memoryProjections: [{ patternJson: syntax }, { patternJson: semantic }] };
  for (const original of [checkpoint, event]) {
    const [durable] = await f.base.encodeMany([{ value: original }]);
    const [stored] = await f.store.encodeMany([{ value: durable, logicalValue: original }]);
    const [restored] = await f.store.decodeMany(cold([stored]));
    expect(exact((await f.base.decodeMany([restored]))[0])).toBe(exact(original));
    expect(object(stored)[DECODED_JSON_BYTE_LEDGER_KEY]).toEqual(decodedJsonByteLedger(original));
    const physicalModel = original === event ? object(object(stored).model) : object(stored);
    const projections = physicalModel.memoryProjections as Array<{ patternJson: Record<string, unknown> }>;
    expect(projections[0]!.patternJson.templates).toBeUndefined();
    expect(projections[0]!.patternJson[DECODED_JSON_BYTE_LEDGER_KEY]).toBeUndefined();
    if (original === event) expect(object(object(stored).model)[DECODED_JSON_BYTE_LEDGER_KEY]).toBeUndefined();
  }
});

it("loads scoped semantic order for a standalone syntax write instead of sorting witness IDs", async () => {
  const f = fixture(), [stored] = await f.store.encodeMany([{ value: syntax }]);
  expect(f.loadSemanticFactors).toHaveBeenCalledWith({ modelId: syntax.modelId, profileId: syntax.profileId });
  const [restored] = await f.store.decodeMany(cold([stored]));
  expect((await f.base.decodeMany([restored]))[0]).toEqual(syntax);
});

it("can recover standalone syntax order from a cold already-factored semantic sibling", async () => {
  const f = fixture(), [durableSemantic] = await f.base.encodeMany([{ value: semantic }]);
  const [storedSemantic] = await f.store.encodeMany([{ value: durableSemantic, logicalValue: semantic }]);
  const tape = object(object(storedSemantic).semanticInductionProjection);
  const factors = object(JSON.parse(String(tape.text))).factors;
  const coldWriter = fixture(f.bindingSets); coldWriter.loadSemanticFactors.mockResolvedValue(cold(factors));
  const [storedSyntax] = await coldWriter.store.encodeMany([{ value: syntax }]);
  const [restored] = await coldWriter.store.decodeMany(cold([storedSyntax]));
  expect((await coldWriter.base.decodeMany([restored]))[0]).toEqual(syntax);
});

it.each(["missing", "tampered", "wrongVersion", "wrongWitness", "missingOrder"] as const)("fails closed when %s source state cannot prove the original logical value", async mutation => {
  const f = fixture(); f.state[mutation] = true;
  await expect(f.store.encodeMany([{ value: syntax }])).rejects.toThrow();
});

it("rejects a changed owner after persistence and a forged original logical byte charge", async () => {
  const f = fixture(), [stored] = await f.store.encodeMany([{ value: syntax }]);
  f.state.tampered = true;
  await expect(f.store.decodeMany(cold([stored]))).rejects.toThrow();
  const g = fixture(), wrong = { ...syntax, [DECODED_JSON_BYTE_LEDGER_KEY]: { ...decodedJsonByteLedger(syntax), decodedJsonBytes: 1 } };
  await expect(g.store.encodeMany([{ value: wrong, logicalValue: syntax }])).rejects.toThrow("byte ledger");
});

it("passes unrelated values, existing inline reads and raw arrays through without owner I/O", async () => {
  const f = fixture(), unrelated = { schema: "opaque", value: [1] };
  expect(await f.store.encodeMany([{ value: unrelated }, { value: [syntax] }])).toEqual([unrelated, [syntax]]);
  expect(await f.store.decodeMany([unrelated, syntax, semantic])).toEqual([unrelated, syntax, semantic]);
  expect(f.loadWitness).not.toHaveBeenCalled(); expect(f.getOwnerDocuments).not.toHaveBeenCalled();
});
