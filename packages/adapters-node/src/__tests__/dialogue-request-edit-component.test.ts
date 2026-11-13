// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, learnedSourceRequestEditForText,
  LANGUAGE_IDENTITY_SCHEMA, LANGUAGE_IDENTITY_DISCOVERY_RECIPE, SOURCE_REQUEST_EDIT_SCHEMA, SOURCE_REQUEST_EDIT_RECIPE, type EvidenceSpan, type TranscriptTurn,
  type LanguageIdentityRecord } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { persistDialogueRequestEditComponent } from "../dialogue-request-edit-component.js";
const label = { tenantId: "fixture", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
it("publishes a current cross-source common-compiler family with chunk witnesses and whole-owner dependencies", async () => {
  const hasher = createHasher(), clock = createClock({ fixedTime: 1_000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "edit-publication" });
  const language = createLanguageAcquisitionEngine({ idFactory: ids }), evidence: EvidenceSpan[] = [], fixture = storageFixtureForEvaluation({ evidence, clockNow: clock.now });
  const checkpoints = new Map<string, import("@scce/kernel").IngestionCheckpoint>();
  fixture.storage.ingestion = { ...fixture.storage.ingestion, get: async id => checkpoints.get(id) ?? null,
    put: async checkpoint => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); } };
  const sources = [["甲", "赤", "乙"], ["丙", "青", "丁"], ["戊", "緑", "己"]].map(([left, value, right], index) => {
    const prefix = "前段落\n", request = `操作「${left}◇${right}」`, reply = `${left}${value}${right}`, pair = request + "\n" + reply,
      text = prefix + pair, sourceVersionId = ids.sourceVersionId(text), sourceId = ids.sourceId("fixture", `fixture://edit/${index}`), offset = [...prefix].length,
      replyStart = offset + [...request].length + 1, profile = language.acquire({ sourceVersionId, text, createdAt: clock.now() });
    const span = { id: `edit.evidence.${index}`, sourceId, sourceVersionId, text: pair, contentHash: ids.contentHash(Buffer.from(pair)),
      charStart: offset, charEnd: [...text].length, byteStart: Buffer.byteLength(prefix), byteEnd: Buffer.byteLength(text), status: "promoted", informationLabel: label } as unknown as EvidenceSpan;
    evidence.push({ ...span, id: `edit.opening.${index}` as EvidenceSpan["id"], text: prefix, charStart: 0, charEnd: offset, byteStart: 0,
      byteEnd: Buffer.byteLength(prefix), contentHash: ids.contentHash(Buffer.from(prefix)) }, span);
    const turns: TranscriptTurn[] = [{ index: 0, speakerId: "request", sourceRecordId: `record.${index}`, surface: request,
      startCodePoint: offset, endCodePoint: offset + [...request].length }, { index: 1, speakerId: "reply", sourceRecordId: `record.${index}`,
      replyToTurnIndex: 0, commitmentScope: "external", surface: reply, startCodePoint: replyStart, endCodePoint: [...text].length }];
    return { sourceUri: `fixture://edit/${index}`, sourceVersionId: String(sourceVersionId), text, transcriptTurns: turns, profile,
      fullHash: ids.contentHash(Buffer.from(text)), chunkHash: span.contentHash };
  });
  for (const source of sources) await fixture.storage.model.putLanguageProfile(source.profile);
  const measured = { observedProfileCount: 3, sampleCount: 3, sourceFamilyCount: 3, independentSourceFamilyCount: 3,
    status: "family_measured" as const, uncertainty: [], observedSymbols: [] };
  const identity: LanguageIdentityRecord = { schema: LANGUAGE_IDENTITY_SCHEMA, id: "identity.fixture", script: "script.fixture",
    directions: [{ direction: "unknown", count: 3 }], closedClass: [], families: [{ family: "dialogue", count: 3, evidence: measured }],
    corpusRoles: [], profileCount: 3, evidence: measured, membershipCut: 0, createdAt: 1, informationLabel: label,
    discoveryRecipe: LANGUAGE_IDENTITY_DISCOVERY_RECIPE };
  fixture.storage.languageIdentities = { listProfileLanguages: async query => (query?.profileIds ?? []).map(profileId => ({ profileId, languageId: identity.id })),
    listIdentities: async () => [identity] } as typeof fixture.storage.languageIdentities;
  fixture.storage.evidence.searchEvidence = async query => evidence.filter(span => !query.sourceVersionId || String(span.sourceVersionId) === String(query.sourceVersionId))
    .map(span => ({ span, score: 1, reason: "fixture.exact.owner" }));
  const input = { storage: fixture.storage, rootUri: "fixture://independent-edit-corpus", informationLabel: label, authorship: "human_authored", sources };
  const result = await persistDialogueRequestEditComponent(input);
  expect(result.patternsPersisted).toBe(1);
  const patterns = await fixture.storage.languageMemory.listLanguagePatterns({ patternSchemas: [SOURCE_REQUEST_EDIT_SCHEMA] });
  expect(patterns).toHaveLength(1);
  const primary = sources.find(source => source.profile.id === patterns[0]!.profileId)!;
  const owner = evidence.find(span => String(span.sourceVersionId) === primary.sourceVersionId)!;
  const projection = await fixture.storage.languageMemory.getLanguagePatternProjection!({ profileId: primary.profile.id,
    sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId, sourceSystem: "dialogue", patternSchema: SOURCE_REQUEST_EDIT_SCHEMA,
    componentRecipe: SOURCE_REQUEST_EDIT_RECIPE, informationLabel: label });
  expect(projection?.sourceDependencies).toHaveLength(3);
  expect(projection?.sourceDependencies?.every(dependency => dependency.contentHash === undefined)).toBe(true);
  expect(sources.every(source => source.fullHash !== source.chunkHash)).toBe(true);
  expect(await learnedSourceRequestEditForText({ storage: fixture.storage, requestText: "操作「🪐한국◇終端」" })).toBeDefined();
  expect((await persistDialogueRequestEditComponent(input)).unchanged).toBe(true);
});
