// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { readFileSync } from "node:fs";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createScceKernel } from "../kernel.js";
import { compileRealizationContract, resolveRequestValueBinding, semanticAnswerConstructFacts } from "../semantic-answer-construct.js";
import { currentSourceBoundRoleValueFact, requestValueBindingConstructFact } from "../source-bound-semantic-fact.js";
import { attachSourceBoundAnswerConstruct } from "../local-evidence-runtime.js";
import { semanticAnswerConstructState } from "../mouth-source-facts.js";
import type { ConstructGraph } from "../types.js";
import { SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA, sourceSpanCompletionProofProjection, sourceSpanCompletionRequestFromMetadata, sourceSpanCompletionValueResolver } from "../source-owned-span-completion.js";
import { typedRelationsToProofRecords } from "../semantic-proof-adapter.js";
import { proveClaim } from "../semantic-proof-engine.js";
import type { EvidenceSpan, JsonValue } from "../types.js";
import type { ScceStorage } from "../storage.js";
import * as contextualQaRuntime from "../contextual-qa-runtime.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import { sourceOwnedAnswerhoodLanguage } from "./fixtures/source-owned-answerhood-language.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 210_000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "explicit-source-span" });
afterEach(() => { vi.restoreAllMocks(); });

function evidence(text: string) {
  const sourceVersionId = ids.sourceVersionId(text);
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: clock.now() });
  const span = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("fixture", "fixture://span/" + hasher.digestHex(text)), sourceVersionId, namespace: "fixture",
    uri: "fixture://source-span", text, mediaType: "text/plain", languageProfile: profile, observedAt: clock.now(),
    maxChunkBytes: Buffer.byteLength(text) + 1, exactSourceText: true,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" }
  }).spans[0]!;
  return { profile, span: { ...span, status: "promoted" as const, alpha: 1 } };
}

function declaration(left: string, marker: string, right: string, instruction = "") {
  const requestText = left + marker + right + instruction;
  return { schema: SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA, requestText,
    templateRange: { startCodePoint: 0, endCodePoint: [...left + marker + right].length },
    gapRange: { startCodePoint: [...left].length, endCodePoint: [...left + marker].length } };
}

it.each([
  ["The copper station stores ", "<slot>", " in its vault.", "seven maps"],
  ["🛰️記録: 風見台の符号は", "⟪空欄⟫", "である。", "青凪"],
  ["Le repère porte ", "?", " sur son sceau.", "l’étoile"]
])("binds the declared missing source range without inspecting its marker: %s", (left, marker, right, value) => {
  const owner = evidence(left + value + right).span;
  const request = declaration(left, marker, right, "\nAn independently declared instruction outside the context.");
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  const binding = resolveRequestValueBinding({ requestText: request.requestText, evidence: [owner], resolvers: [sourceSpanCompletionValueResolver(parsed)] })!;
  expect(binding).toMatchObject({ value, subject: owner.text, evidenceIds: [String(owner.id)],
    relationId: "relation.source_span_completion", requestedRoleId: "role.source_span_completion.value" });
  expect(requestValueBindingConstructFact(binding, [owner])).toMatchObject({ object: value, predicate: "", evidenceIds: [String(owner.id)] });
  expect(sourceSpanCompletionValueResolver(parsed).resolve(request.requestText + " changed", [owner])).toBeUndefined();
});

it("keeps exact source coordinates through both fact readers and rejects altered range semantics", () => {
  const owner = evidence("🛰️甲は青凪にある。").span, request = declaration("🛰️甲は", "?", "にある。");
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  const binding = resolveRequestValueBinding({ requestText: request.requestText, evidence: [owner], resolvers: [sourceSpanCompletionValueResolver(parsed)] })!;
  const fact = requestValueBindingConstructFact(binding, [owner])!;
  const base = { id: ids.constructId({}), episodeId: ids.episodeId(), forceVector: {}, nodes: [], edges: [], artifacts: [] } as ConstructGraph;
  const graph = attachSourceBoundAnswerConstruct({ construct: base, requestText: request.requestText, hasher, brainMarker: {}, facts: [fact], evidence: [owner] });
  const facts = semanticAnswerConstructFacts(graph)!.facts, mouthFacts = semanticAnswerConstructState(graph)!.selectedFacts;
  expect(facts[0]!.sourceSpan).toEqual(binding.sourceSpan);
  expect(mouthFacts[0]!.sourceSpan).toEqual(binding.sourceSpan);
  const contract = compileRealizationContract(request.requestText, fact);
  expect(currentSourceBoundRoleValueFact({ text: "青凪", contract, facts: mouthFacts, evidence: [owner] })).toBeDefined();
  for (const changed of [
    { ...fact, sourceSpan: { ...fact.sourceSpan!, valueEndCodePoint: fact.sourceSpan!.valueEndCodePoint + 1 } },
    { ...fact, sourceSpan: { ...fact.sourceSpan!, contextStartCodePoint: 1 } },
    { ...fact, relationId: "relation.foreign" },
    { ...fact, sourceVersionId: "source.foreign" }
  ]) expect(currentSourceBoundRoleValueFact({ text: "青凪", contract: { ...contract, sourceFact: changed }, facts: [changed], evidence: [owner] })).toBeUndefined();
  expect(requestValueBindingConstructFact({ ...binding, sourceSpan: undefined }, [owner])).toBeUndefined();
});

it("derives only the replayed current text-span relation through native typed proof records", () => {
  const owner = evidence("2a3").span, raw = declaration("2", "+", "3");
  const request = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: raw }, raw.requestText)!;
  const binding = resolveRequestValueBinding({ requestText: raw.requestText, evidence: [owner], resolvers: [sourceSpanCompletionValueResolver(request)] })!;
  const project = (changedBinding = binding, owners: EvidenceSpan[] = [owner]) => sourceSpanCompletionProofProjection({
    request, binding: changedBinding, evidence: owners, hasher, createdAt: 210_000 });
  const projected = project()!, claim = projected.scope.proofClaims[0]!;
  const records = typedRelationsToProofRecords({ hyperedges: projected.scope.typedRelations, nodes: projected.nodes, evidence: [owner], claim });
  expect(proveClaim({ claim, candidateEvidence: records }).verdict).toBe("certified");
  expect(records).toMatchObject([{ evidenceSpanId: String(owner.id), sourceVersionId: String(owner.sourceVersionId),
    relationId: "relation.source_span_completion", subject: { surface: "2a3" }, object: { surface: "a" } }]);
  expect(proveClaim({ claim: { ...claim, relationId: "relation.unrelated_world_claim" }, candidateEvidence: records }).verdict).not.toBe("certified");
  expect(project({ ...binding, value: "5" })).toBeUndefined();
  expect(project({ ...binding, sourceSpan: { ...binding.sourceSpan!, valueStartCodePoint: 0 } })).toBeUndefined();
  expect(project({ ...binding, relationId: "relation.unrelated_world_claim" })).toBeUndefined();
  expect(project(binding, [{ ...owner, status: "quarantined" }])).toBeUndefined();
  expect(project(binding, [{ ...owner, trustVector: { ...owner.trustVector as object, forceClass: "direct_evidence" },
    provenance: { ...owner.provenance as object, epistemicState: "asserted" } }])).toBeUndefined();
  expect(project(binding, [owner, evidence("2b3").span])).toBeUndefined();
});

it("requires an explicit valid declaration rather than recognizing a blank or instruction", () => {
  const request = declaration("甲", "____", "乙");
  expect(sourceSpanCompletionRequestFromMetadata(undefined, request.requestText)).toBeUndefined();
  const { requestText: _text, ...withoutDuplicatedText } = request;
  expect(sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: withoutDuplicatedText }, request.requestText)).toEqual(request);
  expect(sourceSpanCompletionRequestFromMetadata({ text: "Fill in the blank" }, request.requestText)).toBeUndefined();
  for (const changed of [
    { ...request, requestText: request.requestText + " changed" },
    { ...request, gapRange: { startCodePoint: 1.5, endCodePoint: 3 } },
    { ...request, gapRange: { startCodePoint: 0, endCodePoint: 2 } },
    { ...request, gapRange: { startCodePoint: 1, endCodePoint: 99 } },
    { ...request, sourceVersionIds: ["source.same", "source.same"] },
    { ...request, evidenceIds: [false] }
  ]) expect(() => sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: changed }, request.requestText)).toThrow("Invalid source-span-completion");
});

it("requires ordered context, one unambiguous fill, and current owner constraints", () => {
  const request = declaration("甲は", "missing", "にある。");
  const first = evidence("甲は東京にある。").span, second = evidence("甲は大阪にある。").span;
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  const resolve = (owners: EvidenceSpan[]) => sourceSpanCompletionValueResolver(parsed).resolve(request.requestText, owners);
  expect(resolve([first, second])).toBeUndefined();
  expect(resolve([evidence("にある。東京甲は").span])).toBeUndefined();
  expect(resolve([{ ...first, status: "quarantined" }])).toBeUndefined();
  const constrained = sourceSpanCompletionValueResolver({ ...parsed, sourceVersionIds: [String(first.sourceVersionId)], evidenceIds: [String(first.id)] });
  expect(constrained.resolve(request.requestText, [first, second])).toMatchObject({ value: "東京", evidenceIds: [String(first.id)] });
  expect(constrained.resolve(request.requestText, [{ ...first, sourceVersionId: second.sourceVersionId }])).toBeUndefined();
  expect(constrained.resolve(request.requestText, [{ ...first, id: second.id }])).toBeUndefined();
});

it("does not hide competing gaps behind overlapping context anchors", () => {
  const request = declaration("aba", "◊", "fin");
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  expect(sourceSpanCompletionValueResolver(parsed).resolve(request.requestText, [evidence("ababaXfin").span])).toBeUndefined();
  const other = declaration("start", "◊", "aba");
  expect(sourceSpanCompletionValueResolver(sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: other }, other.requestText)!)
    .resolve(other.requestText, [evidence("startXababa").span])).toBeUndefined();
});

it("keeps independent corroboration as one complete current owner", () => {
  const request = declaration("Archiv Z trägt ", "◊", " als Kennzeichen.");
  const first = evidence("Archiv Z trägt blaue Feder als Kennzeichen.").span;
  const other = evidence("Notiz. Archiv Z trägt blaue Feder als Kennzeichen.").span;
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  const resolver = sourceSpanCompletionValueResolver(parsed);
  const binding = resolver.resolve(request.requestText, [first, other]);
  expect(binding).toMatchObject({ value: "blaue Feder", evidenceIds: expect.any(Array) });
  if (!binding || typeof binding === "string") throw Error("formal completion needs a typed binding");
  expect(binding.evidenceIds).toHaveLength(1);
  expect(resolver.resolve(request.requestText, [other, first])).toEqual(binding);
});

async function turnWithDeclaration(sourceTexts: string[], request: ReturnType<typeof declaration>, constraints: { sourceVersionIds?: string[]; evidenceIds?: string[] } = {}, retainedEvidence?: EvidenceSpan[],
  options: { configureStorage?: (storage: ScceStorage) => void; metadata?: Record<string, JsonValue>; omitEvidenceScope?: boolean } = {}) {
  const sources = sourceTexts.map((text, index) => {
    const span = retainedEvidence?.[index];
    return span ? { span, profile: createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: span.sourceVersionId, text, createdAt: clock.now() }) } : evidence(text);
  }), resident = sourceOwnedAnswerhoodLanguage();
  const fixture = storageFixtureForEvaluation({ evidence: [...sources.map(source => source.span), ...resident.evidence], clockNow: () => 210_000 });
  fixture.storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
  fixture.storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
  fixture.storage.model.listLanguageProfiles = async query => {
    const profiles = [...sources.map(source => source.profile), ...resident.profiles];
    return typeof query === "number" ? profiles.slice(0, query)
      : profiles.filter(row => !query?.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).slice(0, query?.limit);
  };
  fixture.storage.languageMemory.listNgramModels = async query => resident.models.filter(model =>
    !query?.profileIds || query.profileIds.includes(String((model.modelJson as { profileId: string }).profileId)));
  fixture.storage.languageMemory.listLanguagePatterns = async query => resident.patterns.filter(pattern =>
    (!query?.profileIds || query.profileIds.includes(pattern.profileId)) && (!query?.patternKind || query.patternKind === pattern.patternKind));
  options.configureStorage?.(fixture.storage);
  const turnClock = createClock({ fixedTime: 211_000, stepMs: 1 });
  const kernel = createScceKernel({ storage: fixture.storage, files: { streamPath: async function* () {} },
    buildTest: { executeProgram: async () => { throw Error("Factual completion must not execute code"); } },
    idFactory: createIdFactory({ clock: turnClock, hasher, deterministicReplay: true, namespace: "declared-gap-turn" }),
    clock: turnClock, deterministicReplay: true });
  const { requestText, ...operator } = request;
  return kernel.turn({ text: requestText, requestedAuthority: "factual",
    metadata: { ...options.metadata, sourceSpanCompletion: { ...operator,
      ...(!options.omitEvidenceScope ? { evidenceIds: sources.map(source => String(source.span.id)) } : {}), ...constraints } } as JsonValue });
}

it("uses only current canonical declared owners despite unrelated graph, metadata and session candidates", async () => {
  const left = "The copper station stores ", right = " in its vault.", request = declaration(left, "?", right);
  const owner = evidence(left + "seven maps" + right).span, other = evidence(left + "eight keys" + right).span;
  const search = vi.fn(async () => { throw Error("Exact scope must never invoke global evidence search"); });
  const qaRead = vi.spyOn(contextualQaRuntime, "contextualQaConstructionsForRequest");
  const result = await turnWithDeclaration([owner.text, other.text], request, { evidenceIds: [String(owner.id)] }, [owner, other], {
    configureStorage: storage => { storage.evidence.searchEvidence = search; },
    metadata: { evidenceIds: [String(other.id)], fastLocalEvidenceAnswer: true,
      session: { sessionId: "unrelated-prior-turn", recentTurns: [{ role: "owner", text: other.text }] } }
  });
  expect(search).not.toHaveBeenCalled();
  expect(qaRead).not.toHaveBeenCalled();
  expect(result.answer).toBe("seven maps");
  expect(result.withheld).toBeUndefined();
  expect(result.evidence.map(span => String(span.id))).toEqual([String(owner.id)]);
});

it.each(["empty", "missing", "stale", "ambiguous"] as const)("withholds %s exact scopes without escalating into global retrieval", async kind => {
  const left = "The copper station stores ", right = " in its vault.", request = declaration(left, "?", right);
  const search = vi.fn(async () => { throw Error("Unbound exact scope must not broaden"); });
  const qaRead = vi.spyOn(contextualQaRuntime, "contextualQaConstructionsForRequest");
  const constraints = kind === "empty" ? { evidenceIds: [] } : kind === "missing" ? { evidenceIds: ["evidence.missing"] }
    : kind === "stale" ? { sourceVersionIds: ["source.no_longer_current"] } : {};
  const result = await turnWithDeclaration([left + "seven maps" + right, ...(kind === "ambiguous" ? [left + "eight keys" + right] : [])],
    request, constraints, undefined, { configureStorage: storage => { storage.evidence.searchEvidence = search; }, metadata: { fastLocalEvidenceAnswer: true } });
  expect(search).not.toHaveBeenCalled();
  expect(qaRead).not.toHaveBeenCalled();
  expect(result.answer).toBe("");
  expect(result.withheld).toBeDefined();
});

it("retains text retrieval when the declared completion has no exact evidence scope", async () => {
  const request = declaration("The copper station stores ", "?", " in its vault.");
  let search: MockInstance<ScceStorage["evidence"]["searchEvidence"]>;
  await turnWithDeclaration(["The copper station stores seven maps in its vault."], request, {}, undefined, {
    omitEvidenceScope: true, configureStorage: storage => { search = vi.spyOn(storage.evidence, "searchEvidence"); }
  });
  expect(search!).toHaveBeenCalled();
});

it.each([
  ["The copper station stores ", "<slot>", " in its vault.", "seven maps"],
  ["🛰️記録: 風見台の符号は", "⟪空欄⟫", "である。", "青凪"]
])("answers a fresh explicitly declared source gap through the ordinary factual turn: %s", async (left, marker, right, value) => {
  const result = await turnWithDeclaration([left + value + right], declaration(left, marker, right));
  expect(result.answer).toBe(value);
  expect(result.withheld).toBeUndefined();
  expect(result.evidence.length).toBeGreaterThan(0);
});

it("answers a declared gap inside partial-word context from exact retained Wikipedia evidence", async () => {
  const retained = JSON.parse(readFileSync(new URL("./fixtures/wikipedia-politics-angola-span.json", import.meta.url), "utf8")) as { evidence: EvidenceSpan };
  const owner = retained.evidence;
  expect("sha256_" + hasher.digestHex(Buffer.from(owner.text))).toBe(owner.contentHash);
  const points = [...owner.text], valueStart = owner.text.indexOf("in 2002. From 2002") + 3;
  expect(valueStart).toBeGreaterThan(3);
  const valueCodePoint = [...owner.text.slice(0, valueStart)].length;
  const left = points.slice(valueCodePoint - 80, valueCodePoint).join("");
  const right = points.slice(valueCodePoint + 4, valueCodePoint + 84).join("");
  expect(left.startsWith("ht each")).toBe(true);
  expect(right.endsWith("functione")).toBe(true);
  const request = declaration(left, "?value?", right);
  const parsed = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: request }, request.requestText)!;
  const binding = resolveRequestValueBinding({ requestText: request.requestText, evidence: [owner], resolvers: [sourceSpanCompletionValueResolver(parsed)] })!;
  expect(requestValueBindingConstructFact(binding, [owner])).toMatchObject({ object: "2002", sourceSpan: binding.sourceSpan });
  const result = await turnWithDeclaration([owner.text], request, { sourceVersionIds: [String(owner.sourceVersionId)] }, [owner]);
  expect(result.answer).toBe("2002\n\nSource: Politics of Angola (https://en.wikipedia.org/wiki/Politics_of_Angola)");
  expect(result.withheld).toBeUndefined();
});

it("preserves the declared gap meaning when its text is also a valid arithmetic expression", async () => {
  const request = declaration("2", "+", "3");
  expect(request.requestText).toBe("2+3");
  const supported = await turnWithDeclaration(["2a3"], request);
  expect(supported.answer).toBe("a");
  expect(supported.withheld).toBeUndefined();
  expect(supported.evidence.length).toBeGreaterThan(0);
  const unbound = await turnWithDeclaration(["3a2"], request);
  expect(unbound.answer).toBe("");
  expect(unbound.withheld).toBeDefined();
});

it.each(["ambiguous", "reversed", "stale"] as const)("withholds a declared source gap with %s source support", async kind => {
  const left = "The copper station stores ", right = " in its vault.";
  const request = declaration(left, "◊", right);
  const sources = kind === "ambiguous" ? [left + "seven maps" + right, left + "eight keys" + right]
    : kind === "reversed" ? [right + "seven maps" + left] : [left + "seven maps" + right];
  const result = await turnWithDeclaration(sources, request, kind === "stale" ? { sourceVersionIds: ["source.no_longer_current"] } : {});
  expect(result.answer).toBe("");
  expect(result.withheld).toBeDefined();
});
