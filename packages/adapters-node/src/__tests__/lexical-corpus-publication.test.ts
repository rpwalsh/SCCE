// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createHasher, LEXICAL_GRAMMAR_SCHEMA, LEXICAL_SENSE_SCHEMA, SOURCE_QUESTION_FRAME_SCHEMA, verifySourceOwnedLexicalPattern,
  type EvidenceSpan, type InformationLabel, type IngestionCheckpoint, type LanguageIdentityRecord,
  type LanguagePatternRecord, type LanguageProfile, type SourceVersion } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { captureFixtureLanguagePatternProjections, removeFixtureLanguagePatternProjections } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { readBoundedLexicalCorpusSource, LexicalCorpusCapacityError } from "../lexical-corpus-store.js";
import { ingestUdLexicalCorpus, readUdLexicalGrammar } from "../ud-lexical-corpus.js";
import { ingestWordnetCorpus } from "../wordnet-corpus.js";

const label: InformationLabel = { tenantId: "lexical.tests", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const hasher = createHasher(), hash = (bytes: Uint8Array | string) => `sha256_${hasher.digestHex(bytes)}`;
const token = (form: string, feats = "Number=Sing", dependency = "root") => `1\t${form}\té\tNOUN\t_\t${feats}\t0\t${dependency}\t_\t_`;
const conllu = ["# source = 𐐀", "# text = é", token("é"), "", "# text = é", token("é"), "", "# text = é", token("é", "Number=Plur"), "", "# text = é", token("é", "Number=Sing", "obj"), ""].join("\r\n");
const wordnet = `<LexicalResource><Lexicon id="wn" version="1" language="fixture" license="test"><LexicalEntry id="one"><Lemma writtenForm="é"/><Form writtenForm="茶"/></LexicalEntry><LexicalEntry id="two"><Lemma writtenForm="𐐀"/></LexicalEntry><Synset id="sense" members="one two" partOfSpeech="n"><Definition>é 茶 𐐀</Definition><Example>é 茶</Example></Synset></Lexicon></LexicalResource>`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function fixture() {
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 });
  const storage = base.storage;
  let state = { sources: new Map<string, SourceVersion>(), spans: new Map<string, EvidenceSpan>(), blobs: new Map<string, Uint8Array>(),
    patterns: new Map<string, LanguagePatternRecord>(), profiles: new Map<string, LanguageProfile>(), checkpoints: new Map<string, IngestionCheckpoint>(),
    assignments: [] as Array<{ profileId: string; languageId: string }> };
  const identity: LanguageIdentityRecord = { schema: "scce.language_identity.v2", id: "identity.measured", script: "", directions: [],
    closedClass: [{ word: "é", documentShare: 1 }], families: [], corpusRoles: [], profileCount: 1, membershipCut: 0, createdAt: 1, informationLabel: label };
  storage.languageIdentities = { putIdentities: async () => {}, listIdentities: async () => [identity],
    assignProfileLanguages: async rows => { state.assignments.push(...rows); }, listProfileLanguages: async () => state.assignments, listProfileSignatures: async () => [] };
  storage.evidence.putSourceVersion = async row => { state.sources.set(row.sourceVersionId, row); };
  storage.evidence.putEvidenceSpan = async row => { state.spans.set(row.id, row); };
  storage.evidence.putEvidenceSpans = async rows => { for (const row of rows) state.spans.set(row.id, row); };
  storage.evidence.getEvidenceBatch = async ids => ids.flatMap(id => state.spans.get(id) ?? []);
  storage.evidence.sourceVersionById = async id => state.sources.get(id) ?? null;
  storage.evidence.sourceVersionsForEvidence = async ids => [...new Set(ids.flatMap(id => state.spans.get(id)?.sourceVersionId ?? []))].flatMap(id => state.sources.get(id) ?? []);
  storage.blobs.put = async bytes => { const id = hash(bytes); state.blobs.set(id, new Uint8Array(bytes)); return id as SourceVersion["contentHash"]; };
  storage.blobs.get = async id => { const bytes = state.blobs.get(id); if (!bytes) throw new Error("missing canonical blob"); return bytes; };
  storage.blobs.putRanges = async (rows, parent) => {
    expect(hash(parent.bytes)).toBe(parent.contentHash);
    expect(state.blobs.has(parent.contentHash)).toBe(true);
    for (const row of rows) { const bytes = parent.bytes.slice(row.byteStart, row.byteEnd); expect(hash(bytes)).toBe(row.contentHash); state.blobs.set(row.contentHash, bytes); }
  };
  storage.model.putLanguageProfile = async row => { state.profiles.set(row.id, row); };
  storage.model.listLanguageProfiles = async () => [...state.profiles.values()];
  storage.languageMemory.putLanguagePattern = async row => { state.patterns.set(row.id, row); };
  storage.languageMemory.listLanguagePatterns = async query => [...state.patterns.values()].filter(row => (!query?.patternIds || query.patternIds.includes(row.id))
    && (!query?.patternSchemas || query.patternSchemas.includes(String((row.patternJson as { schema?: string }).schema)))).slice(0, query?.limit);
  storage.ingestion = { get: async id => state.checkpoints.get(id) ?? null,
    put: async row => { state.checkpoints.set(row.id, row); }, list: async () => [...state.checkpoints.values()] };
  storage.transaction = async operation => {
    const before = structuredClone(state), events = base.events.slice(), restore = captureFixtureLanguagePatternProjections(storage.languageMemory);
    try { return await operation(); } catch (error) { state = before; base.events.splice(0, base.events.length, ...events); restore(); throw error; }
  };
  return { storage, state: () => state, events: base.events };
}
function udInput(storage: ReturnType<typeof fixture>["storage"]) { return { storage, text: conllu, sourceUri: "fixture://annotations/ud", lexiconId: "ud.fixture", language: "fixture", license: "test", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 }; }

it("counts every UD occurrence while retaining a witness for each distinct surface, feature set and dependency", () => {
  const parsed = readUdLexicalGrammar(conllu), row = parsed.patterns[0]!;
  expect(row.support).toBe(4);
  expect(row.ranges).toHaveLength(3);
  expect((row.patternJson as { forms: unknown[] }).forms).toEqual([
    { surface: "é", features: { Number: "Sing" }, dependency: "root", count: 2 },
    { surface: "é", features: { Number: "Plur" }, dependency: "root", count: 1 },
    { surface: "é", features: { Number: "Sing" }, dependency: "obj", count: 1 }
  ]);
  expect(row.ranges[0]!.start).toBe(conllu.indexOf(token("é")));
});

it.each(["ud", "wordnet"])("publishes %s through ordinary canonical training with raw Unicode witnesses accepted by factual readers", async format => {
  const f = fixture(), raw = format === "ud" ? conllu : wordnet;
  const result = format === "ud" ? await ingestUdLexicalCorpus(udInput(f.storage)) : await ingestWordnetCorpus({ storage: f.storage, text: raw, sourceUri: "fixture://annotations/wn", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 });
  const state = f.state(), source = state.sources.get(result.sourceVersionId)!, original = state.sources.get(result.annotationSourceVersionId)!;
  expect(state.sources.size).toBe(2);
  expect(source.sourceId).not.toBe(original.sourceId);
  expect(source.canonicalUri).not.toBe(original.canonicalUri);
  expect(original.role).toBe("original");
  expect(original.contentHash).toBe(hash(raw));
  expect(Buffer.from(await f.storage.blobs.get(original.contentHash)).toString("utf8")).toBe(raw);
  expect(source.derivation?.derivedFromSourceVersionId).toBe(original.sourceVersionId);
  const schema = format === "ud" ? LEXICAL_GRAMMAR_SCHEMA : LEXICAL_SENSE_SCHEMA;
  const patterns = [...state.patterns.values()].filter(row => (row.patternJson as { schema?: string }).schema === schema);
  expect(patterns).toHaveLength(1);
  for (const pattern of patterns) {
    const spans = pattern.evidenceIds.map(id => state.spans.get(id)!);
    expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [original], evidence: spans }, {
      hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" }
    })).toBeDefined();
    for (const span of spans) {
      expect(Buffer.from(raw).subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
      expect([...raw].slice(span.charStart, span.charEnd).join("")).toBe(span.text);
      expect(Buffer.from(await f.storage.blobs.get(span.contentHash))).toEqual(Buffer.from(span.text));
    }
  }
  const projection = await f.storage.languageMemory.getLanguagePatternProjection!({ profileId: result.profileId, sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId, sourceSystem: "workspace", patternSchema: schema, componentRecipe: String((patterns[0]!.patternJson as { componentRecipe: string }).componentRecipe), informationLabel: label });
  expect(projection?.sourceDependencies?.map(row => row.contentHash).sort()).toEqual([source.contentHash, original.contentHash].sort());
  expect(state.assignments).toEqual([{ profileId: result.profileId, languageId: "identity.measured" }]);
  expect([...state.checkpoints.values()].map(row => row.status)).toEqual(["complete"]);
});

it("rolls back interrupted publication, resumes completely and verifies active publication before cached replay", async () => {
  const f = fixture(), input = udInput(f.storage), publish = f.storage.languageMemory.replaceLanguagePatternProjection!;
  let interrupt = true;
  f.storage.languageMemory.replaceLanguagePatternProjection = async value => { await publish.call(f.storage.languageMemory, value); if (interrupt) { interrupt = false; throw new Error("interrupted publication"); } };
  await expect(ingestUdLexicalCorpus(input)).rejects.toThrow("interrupted publication");
  expect(f.state().sources.size).toBe(0);
  expect(f.state().patterns.size).toBe(0);
  expect([...f.state().checkpoints.values()].every(row => row.status !== "complete")).toBe(true);
  const report = await ingestUdLexicalCorpus(input), eventCount = f.events.length;
  const checkpointReport = ([...f.state().checkpoints.values()][0]!.metadata as unknown as { report: { sourceOwnedPatternProjections: import("@scce/kernel").LanguagePatternProjection[] } }).report;
  for (const projection of checkpointReport.sourceOwnedPatternProjections) {
    expect(await f.storage.languageMemory.getLanguagePatternProjection!(projection)).toEqual(projection);
    expect((await f.storage.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: projection.patternIds, limit: projection.patternIds.length })).map(row => row.id).sort()).toEqual(projection.patternIds);
  }
  expect(await ingestUdLexicalCorpus(input)).toEqual(report);
  expect(f.events).toHaveLength(eventCount);
  removeFixtureLanguagePatternProjections(f.storage.languageMemory);
  const repaired = await ingestUdLexicalCorpus(input);
  expect(repaired.sourceVersionId).toBe(report.sourceVersionId);
  expect(f.events.length).toBeGreaterThan(eventCount);
  expect(await ingestUdLexicalCorpus(input)).toEqual(repaired);
});

it("replays a complete durable checkpoint after a lost commit acknowledgement without duplicating publication", async () => {
  const f = fixture(), input = udInput(f.storage), transaction = f.storage.transaction;
  let interrupt = true;
  f.storage.transaction = async operation => { const result = await transaction(operation); if (interrupt) { interrupt = false; throw new Error("lost commit acknowledgement"); } return result; };
  await expect(ingestUdLexicalCorpus(input)).rejects.toThrow("lost commit acknowledgement");
  expect([...f.state().checkpoints.values()].map(row => row.status)).toEqual(["complete"]);
  const eventCount = f.events.length, assignments = f.state().assignments.slice();
  const result = await ingestUdLexicalCorpus(input);
  expect(f.state().sources.size).toBe(2);
  expect(f.events).toHaveLength(eventCount);
  expect(f.state().assignments).toEqual(assignments);
  expect(result.checkpointed).toBe(true);
});

it("compiles genuine UD HEAD-aligned question frames through the same verified raw annotation publication", async () => {
  const text = await readFile(new URL("./fixtures/ud-ewt-question-excerpt.conllu", import.meta.url), "utf8");
  const provenance = JSON.parse(await readFile(new URL("./fixtures/ud-ewt-question-excerpt.provenance.json", import.meta.url), "utf8"));
  expect(hasher.digestHex(text)).toBe(provenance.excerptSha256);
  const repeated = `${text}${text}`, parsed = readUdLexicalGrammar(repeated);
  const question = parsed.patterns.find(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)!;
  expect(question.support).toBe(2);
  expect(question.patternJson).toMatchObject({ prefix: "What is ", suffix: "?", lexicalUnits: ["what", "is"] });
  expect(question.ranges).toHaveLength(6);
  expect(question.ranges.every(range => range.end <= text.length)).toBe(true);
  const damaged = readUdLexicalGrammar(text.replace("\t1\tnsubj\t", "\t2\tnsubj\t"));
  expect(damaged.patterns.some(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)).toBe(false);
  const f = fixture();
  const identity = (await f.storage.languageIdentities!.listIdentities())[0]!;
  f.storage.languageIdentities!.listIdentities = async () => [{ ...identity, closedClass: [{ word: "what", documentShare: 1 }] }];
  const result = await ingestUdLexicalCorpus({ ...udInput(f.storage), text: repeated });
  const state = f.state(), source = state.sources.get(result.sourceVersionId)!, original = state.sources.get(result.annotationSourceVersionId)!;
  const pattern = [...state.patterns.values()].find(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)!;
  expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [original], evidence: pattern.evidenceIds.map(id => state.spans.get(id)!) }, {
    hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" }
  })).toBeDefined();
});

it("rejects missing caller labels and explicit source-capacity overruns before storage access", async () => {
  const storage = new Proxy({}, { get() { throw new Error("storage accessed"); } }) as ReturnType<typeof fixture>["storage"];
  await expect(ingestUdLexicalCorpus({ ...udInput(storage), maxSourceBytes: 1 })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(ingestUdLexicalCorpus({ ...udInput(storage), informationLabel: undefined! })).rejects.toThrow(/explicit source information label/);
});

it("bounds raw and decompressed bytes before accepting exact UTF-8 source input", async () => {
  const root = await mkdtemp(join(tmpdir(), "scce-lexical-")); roots.push(root);
  const plain = join(root, "source"), compressed = join(root, "gzip"), malformed = join(root, "malformed");
  await writeFile(plain, conllu); await writeFile(compressed, gzipSync(conllu)); await writeFile(malformed, Buffer.from([0xff]));
  expect(await readBoundedLexicalCorpusSource({ path: plain, maxSourceBytes: Buffer.byteLength(conllu) })).toBe(conllu);
  expect(await readBoundedLexicalCorpusSource({ path: compressed, maxSourceBytes: Buffer.byteLength(conllu) })).toBe(conllu);
  await expect(readBoundedLexicalCorpusSource({ path: plain, maxSourceBytes: 1 })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(readBoundedLexicalCorpusSource({ path: compressed, maxSourceBytes: gzipSync(conllu).length })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(readBoundedLexicalCorpusSource({ path: malformed, maxSourceBytes: 1 })).rejects.toThrow();
});
