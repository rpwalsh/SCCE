// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import * as editPrograms from "../source-request-edit-program.js";
import { acquireSourceRequestEditPrograms, learnedSourceRequestEditForText, inspectSourceRequestEditAlignment, SOURCE_REQUEST_EDIT_SCHEMA,
  bindSourceRequestEditResponse, sourceRequestEditResponseForContract } from "../source-request-edit-program.js";
import { createHasher } from "../primitives.js";
import type { ConversationalConstructionDocument } from "../conversational-construction-induction.js";
import type { EvidenceSpan } from "../types.js";
import type { ScceStorage } from "../storage.js";
import { createClock } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createScceKernel } from "../kernel.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import { sourceOwnedAnswerhoodLanguage } from "./fixtures/source-owned-answerhood-language.js";
import { compileRealizationContract, candidateIsVerifiedBoundValue, candidateSurvivesRealizationContract, resolveRequestValueBinding } from "../semantic-answer-construct.js";
import { sourceSpanCompletionValueResolver } from "../source-owned-span-completion.js";
import { requestValueBindingConstructFact } from "../source-bound-semantic-fact.js";
const hasher = createHasher();
function document(left: string, value: string, right: string, index: number, requestPrefix = "操作「", replyPrefix = "") {
  const request = `${requestPrefix}${left}◇${right}」`, reply = `${replyPrefix}${left}${value}${right}`, text = request + "\n" + reply;
  const sourceVersionId = `version.${index}`, digest = hasher.digestHex(text), replyStart = [...request].length + 1;
  return { sourceVersionId, profileId: `profile.${index}`, languageIdentityId: "identity.shared", languageIdentityDigest: `assignment.${index}`,
    spans: [{ id: `evidence.${index}`, sourceId: `source.${index}`, sourceVersionId, text, contentHash: `sha256_${digest}`,
      charStart: 0, charEnd: [...text].length, status: "promoted", informationLabel: { sensitivity: "public", compartments: [] } } as unknown as EvidenceSpan],
    transcriptTurns: [{ index: 0, speakerId: "user", sourceRecordId: `record.${index}`, surface: request, startCodePoint: 0, endCodePoint: [...request].length },
      { index: 1, speakerId: "assistant", sourceRecordId: `record.${index}`, replyToTurnIndex: 0, surface: reply, startCodePoint: replyStart,
        endCodePoint: [...text].length, commitmentScope: "external" as const }] } satisfies ConversationalConstructionDocument;
}
const sources = () => [document("甲", "赤", "乙", 0), document("丙", "青", "丁", 1), document("戊", "緑", "己", 2)];
function acquire(documents: readonly ConversationalConstructionDocument[] = sources()) { return acquireSourceRequestEditPrograms({ documents, authorship: "human_authored", hasher, updatedAt: 1 }); }
function storage(documents: ConversationalConstructionDocument[], patterns = acquire(documents).families.map(family => family.pattern)) {
  return { languageMemory: { listLanguagePatterns: async (query: { patternSchemas: string[] }) => {
    expect(query.patternSchemas).toEqual([SOURCE_REQUEST_EDIT_SCHEMA]); return structuredClone(patterns);
  } }, evidence: { getEvidenceBatch: async (ids: readonly string[]) => documents.flatMap(doc => doc.spans).filter(span => ids.includes(String(span.id))) } } as unknown as ScceStorage;
}
it("learns a full-reply edit program from independent observed pairs and replays it cold on unseen scripts", async () => {
  const documents = sources(), acquired = acquire(documents);
  expect(acquired.families).toHaveLength(1);
  expect(acquired.rejected).toEqual([]);
  const fresh = document("🪐한국", "عقيق", "終端", 99), text = fresh.transcriptTurns[0]!.surface;
  const learned = await learnedSourceRequestEditForText({ storage: storage(documents), requestText: text });
  expect(learned).toBeDefined();
  expect(learned!.request.gapRange).toEqual({ startCodePoint: [..."操作「🪐한국"].length, endCodePoint: [..."操作「🪐한국◇"].length });
  const owner = { ...fresh.spans[0]!, text: "🪐한국عقيق終端", charEnd: [..."🪐한국عقيق終端"].length };
  expect(learned!.realize([owner])).toBe("🪐한국عقيق終端");
  expect(learned!.responseExtent).toBe("observed_full_reply");
  expect(learned!.realize([{ ...owner, status: "quarantined" }])).toBeUndefined();
  expect(learned!.realize([{ ...owner, text: "🪐한국عقيق終端 🪐한국別終端" }])).toBeUndefined();
  expect(await learnedSourceRequestEditForText({ storage: storage(documents), requestText: "別操作「🪐한국◇終端」" })).toBeUndefined();
});
it("cannot infer a varying operation from one observation or a duplicate source record", () => {
  expect(acquire(sources().slice(0, 1)).families).toEqual([]);
  const documents = sources();
  for (const document of documents) for (const turn of document.transcriptTurns) turn.sourceRecordId = "one.record";
  expect(acquire(documents).families).toEqual([]);
});
it("does not count independently named records from one source as held-out source evidence", () => {
  const documents = sources();
  for (const document of documents) document.spans[0]!.sourceId = "one.owner" as EvidenceSpan["sourceId"];
  expect(acquire(documents).families).toHaveLength(0);
});
it("replays valid pair chunks of multi-span sources without using a chunk hash as the whole-source hash", async () => {
  const documents = sources();
  for (const document of documents) {
    const pair = document.spans[0]!, prefix = "前段落\n", offset = [...prefix].length;
    const fullHash = `sha256_${hasher.digestHex(prefix + pair.text)}`;
    document.spans = [{ ...pair, id: `${pair.id}.opening` as EvidenceSpan["id"], text: prefix, charEnd: offset,
      contentHash: `sha256_${hasher.digestHex(prefix)}` as EvidenceSpan["contentHash"] },
      { ...pair, charStart: offset, charEnd: pair.charEnd + offset, provenance: { sourceContentHash: fullHash } }];
    for (const turn of document.transcriptTurns) { turn.startCodePoint += offset; turn.endCodePoint += offset; }
    expect(pair.contentHash).not.toBe(fullHash);
  }
  const acquired = acquire(documents);
  expect(acquired.families).toHaveLength(1);
  expect(acquired.families[0]!.sourceDependencies.every(dependency => dependency.contentHash === undefined)).toBe(true);
  expect(await learnedSourceRequestEditForText({ storage: storage(documents), requestText: "操作「壬◇癸」" })).toBeDefined();
});
it("reports legitimate paired annotations split across canonical evidence spans as unqualified", () => {
  const document = sources()[0]!, pair = document.spans[0]!, split = document.transcriptTurns[1]!.startCodePoint;
  document.spans = [{ ...pair, text: [...pair.text].slice(0, split).join(""), charEnd: split,
    contentHash: `sha256_${hasher.digestHex([...pair.text].slice(0, split).join(""))}` as EvidenceSpan["contentHash"] },
  { ...pair, id: `${pair.id}.reply` as EvidenceSpan["id"], text: [...pair.text].slice(split).join(""), charStart: split,
    contentHash: `sha256_${hasher.digestHex([...pair.text].slice(split).join(""))}` as EvidenceSpan["contentHash"] }];
  expect(acquire([document])).toMatchObject({ pairs: 1, families: [], rejected: [{ recordId: "record.0", reason: "complete_pair_owner_evidence_required" }] });
});
it("does not turn wrapped completions into a gap-only response or accept an unobserved instruction", async () => {
  const documents = sources(), learned = await learnedSourceRequestEditForText({ storage: storage(documents), requestText: "操作「壬◇癸」" });
  expect(learned!.realize([{ ...documents[0]!.spans[0]!, text: "壬紫癸", charEnd: 3 }])).toBe("壬紫癸");
  const bare = sources();
  for (const document of bare) {
    const reply = document.transcriptTurns[1]!, value = [...reply.surface][1]!;
    reply.surface = value; reply.endCodePoint = reply.startCodePoint + [...value].length;
    document.spans[0] = { ...document.spans[0]!, text: document.transcriptTurns[0]!.surface + "\n" + value,
      charEnd: reply.endCodePoint };
  }
  expect(acquire(bare).families).toEqual([]);
});
it("rejects stale, altered, or unavailable teaching evidence and forged response programs", async () => {
  const documents = sources(), patterns = acquire(documents).families.map(family => family.pattern), query = { requestText: "操作「壬◇癸」" };
  const altered = structuredClone(documents); altered[0]!.spans[0]!.text += " altered";
  altered[0]!.spans[0]!.status = "superseded" as EvidenceSpan["status"];
  expect(await learnedSourceRequestEditForText({ ...query, storage: storage(altered, patterns) })).toBeUndefined();
  const forged = structuredClone(patterns); (forged[0]!.patternJson as Record<string, unknown>).responseExtent = "gap_only";
  expect(await learnedSourceRequestEditForText({ ...query, storage: storage(documents, forged) })).toBeUndefined();
  expect(await learnedSourceRequestEditForText({ ...query, storage: storage(documents.slice(1), patterns) })).toBeUndefined();
  for (const malformed of [null, "not a witness", {}, { evidenceId: "evidence.0" }]) {
    const damaged = structuredClone(patterns); (damaged[0]!.patternJson as Record<string, unknown>).witnesses = [malformed];
    await expect(learnedSourceRequestEditForText({ ...query, storage: storage(documents, damaged) })).resolves.toBeUndefined();
  }
});
it("keeps conflicting observed response extents ambiguous", async () => {
  const first = sources(), second = sources().map((_, index) => document(["庚", "辛", "壬"][index]!, ["白", "黒", "紫"][index]!, ["子", "丑", "寅"][index]!, index + 4, "操作「", "·"));
  const documents = [...first, ...second], acquired = acquire(documents);
  expect(acquired.families).toHaveLength(0);
  expect(acquired.rejected).toHaveLength(documents.length);
  expect(await learnedSourceRequestEditForText({ storage: storage(documents), requestText: "操作「🪐◇ث」" })).toBeUndefined();
});
it.each(["I am Qrzt. ", "I am ΩЖ. ", "Aster owns seven moons. "])("does not promote unsupported source-persona or extra-claim literals: %s", prefix => {
  const documents = sources().map((_, index) => document(["甲", "丙", "戊"][index]!, ["赤", "青", "緑"][index]!, ["乙", "丁", "己"][index]!, index, "操作「", prefix));
  expect(acquire(documents).families).toHaveLength(0);
});

it("does not assign repeated or incidental wrapper matches to an invented anchor", () => {
  expect(inspectSourceRequestEditAlignment("操作「甲◇乙」", "結果：甲赤乙甲").status).toBe("single_exchange_not_identified");
  expect(inspectSourceRequestEditAlignment("操作「甲甲◇乙」", "結果：甲赤乙").status).toBe("non_unique_copy_alignment");
  expect(inspectSourceRequestEditAlignment("操作「甲◇乙」", "操結果：甲赤乙").status).toBe("single_exchange_not_identified");
});
it("keeps full completion required when current ownership or the executable program cannot bind", async () => {
  const documents = sources(), learned = (await learnedSourceRequestEditForText({ storage: storage(documents), requestText: "操作「壬◇癸」" }))!;
  const text = "壬紫癸", owner = { ...documents[0]!.spans[0]!, text, charEnd: [...text].length, contentHash: `sha256_${hasher.digestHex(text)}` as EvidenceSpan["contentHash"] };
  const binding = resolveRequestValueBinding({ requestText: learned.request.requestText, evidence: [owner], resolvers: [sourceSpanCompletionValueResolver(learned.request)] })!;
  const fact = requestValueBindingConstructFact(binding, [owner])!, contract = compileRealizationContract(learned.request.requestText, fact);
  contract.responseProgram = bindSourceRequestEditResponse(learned, fact, []);
  expect(contract.responseProgram).toBeDefined();
  expect(sourceRequestEditResponseForContract(contract)).toBeUndefined();
  expect(candidateIsVerifiedBoundValue("紫", contract)).toBe(false);
  expect(candidateSurvivesRealizationContract("紫", contract).survives).toBe(false);
  contract.responseProgram = bindSourceRequestEditResponse({ ...learned, realize: () => "I am ΩЖ." }, fact, [owner]);
  expect(sourceRequestEditResponseForContract(contract)).toBeUndefined();
  contract.responseProgram = bindSourceRequestEditResponse(learned, fact, [owner]);
  expect(sourceRequestEditResponseForContract(contract)).toBe(text);
  expect(candidateSurvivesRealizationContract(text, contract).survives).toBe(true);
  expect(candidateIsVerifiedBoundValue("紫", contract)).toBe(false);
  expect(candidateSurvivesRealizationContract("紫", contract).survives).toBe(false);
});
it("bounds adversarial repeated-copy work by source size without truncating observations", () => {
  const request = "甲".repeat(40_000) + "◇乙", reply = "甲".repeat(40_000) + "赤乙";
  const aligned = inspectSourceRequestEditAlignment(request, reply);
  expect(aligned.work.automatonStates).toBeLessThanOrEqual(2 * [...request].length);
  expect(aligned.work.replyTransitions).toBeLessThanOrEqual(2 * [...reply].length);
  expect(aligned.runs[0]?.length).toBe(40_000);
  const repeated = inspectSourceRequestEditAlignment("甲".repeat(40_000), "甲".repeat(80_000));
  expect(repeated.status).not.toBe("single_exchange");
  expect(repeated.work.replyTransitions).toBeLessThanOrEqual(2 * 80_000);
});

it("realizes the learned full reply through an ordinary cold kernel turn without operator metadata", async () => {
  const documents = sources(), patterns = acquire(documents).families.map(family => family.pattern);
  const clock = createClock({ fixedTime: 215_000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "learned-edit-turn" });
  const text = "🪐한국عقيق終端", sourceVersionId = ids.sourceVersionId(text), language = createLanguageAcquisitionEngine({ idFactory: ids });
  const profile = language.acquire({ sourceVersionId, text, createdAt: clock.now() });
  const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({ sourceId: ids.sourceId("fixture", "fixture://learned-edit-current"),
    sourceVersionId, namespace: "fixture", uri: "fixture://learned-edit-current", text, mediaType: "text/plain", languageProfile: profile,
    observedAt: clock.now(), exactSourceText: true, maxChunkBytes: Buffer.byteLength(text) + 1,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" } }).spans[0]!;
  const owner = { ...extracted, status: "promoted" as const, alpha: 1 }, resident = sourceOwnedAnswerhoodLanguage();
  const fixture = storageFixtureForEvaluation({ evidence: [...documents.flatMap(doc => doc.spans), owner, ...resident.evidence], clockNow: clock.now });
  fixture.storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
  fixture.storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
  fixture.storage.model.listLanguageProfiles = async query => {
    const profiles = [profile, ...resident.profiles];
    return typeof query === "number" ? profiles.slice(0, query) : profiles.filter(row => !query?.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).slice(0, query?.limit);
  };
  fixture.storage.languageMemory.listNgramModels = async query => resident.models.filter(model =>
    !query?.profileIds || query.profileIds.includes(String((model.modelJson as { profileId: string }).profileId)));
  fixture.storage.languageMemory.listLanguagePatterns = async query => [...resident.patterns, ...patterns].filter(pattern =>
    (!query?.profileIds || query.profileIds.includes(pattern.profileId)) && (!query?.patternKind || query.patternKind === pattern.patternKind)
    && (!query?.patternSchemas || query.patternSchemas.includes(String((pattern.patternJson as { schema: string }).schema))));
  const kernel = () => createScceKernel({ storage: fixture.storage, files: { streamPath: async function* () {} },
    buildTest: { executeProgram: async () => { throw Error("Source edit must not execute code"); } }, idFactory: ids, clock, deterministicReplay: true });
  const input = { text: "操作「🪐한국◇終端」", requestedAuthority: "factual" as const, metadata: { evidenceIds: [String(owner.id)] } };
  const ablation = vi.spyOn(editPrograms, "learnedSourceRequestEditForText").mockResolvedValue(undefined);
  let withoutProgram: Awaited<ReturnType<ReturnType<typeof kernel>["turn"]>>;
  try { withoutProgram = await kernel().turn(input); } finally { ablation.mockRestore(); }
  expect(withoutProgram.answer).toBe("");
  expect(withoutProgram.withheld).toBeDefined();
  const result = await kernel().turn(input);
  expect(result.answer, JSON.stringify(result.withheld)).toBe("🪐한국عقيق終端");
  expect(result.withheld).toBeUndefined();
  expect(result.evidence.map(span => String(span.id))).toContain(String(owner.id));
});
