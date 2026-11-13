// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createScceKernel } from "../kernel.js";
import { createLanguageIdentityRuntime } from "../language-identity-runtime.js";
import { requestSeedLanguagePattern } from "../request-language-hydration.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import { CORPUS_ROLE_IDS } from "../corpus-registry.js";
import type { LanguageIdentityRecord } from "../language-identity.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { ScceStorage } from "../storage.js";

it("cold-binds a genuine source request before a stronger foreign function-word cohort and reads only its owned seed", async () => {
  const human = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-scene-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };
  const hasher = createHasher(), clock = createClock({ fixedTime: 1000, stepMs: 1 });
  const ids = createIdFactory({ hasher, clock, deterministicReplay: true, namespace: "source-program-language" });
  const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text), sourceId = ids.sourceId("dialogue", "fixture://retained-scene");
  const span = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }), sourceId, sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }),
    contentHash, charStart: 0, charEnd: [...human.text].length, byteStart: 0, byteEnd: Buffer.byteLength(human.text), mediaType: "text/plain",
    text: human.text, textPreview: human.text, status: "promoted", features: [], alpha: 1, observedAt: 1,
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {} } as EvidenceSpan;
  const language = createLanguageAcquisitionEngine({ idFactory: ids }), profile = language.acquire({ sourceVersionId, text: human.text, createdAt: 1 });
  const foreignText = "a qzv a trm. a vnk a hrl.", foreignProfile = language.acquire({ sourceVersionId: ids.sourceVersionId(foreignText), text: foreignText, createdAt: 1 });
  const compiled = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    batch: { streamId: "fixture://retained-scene", sourceSystem: "dialogue", canonicalSource: { sourceId, contentHash }, profile,
      sourceVersionId, text: human.text, evidence: [span], transcriptTurns: human.turns, createdAt: 1, retainNgramObservations: false } });
  const patterns = compiled.patterns.map(pattern => ({ ...pattern, patternJson: toJsonValue({ ...(pattern.patternJson as object), sourceSystem: "dialogue" }) }));
  const identities: LanguageIdentityRecord[] = [["identity.owner", 0.46], ["identity.foreign", 1]].map(([id, share]) => ({
    schema: "scce.language_identity.v2", id: String(id), script: "script:Latn", directions: [], closedClass: [{ word: "a", documentShare: Number(share) }],
    families: [{ family: "dialogue", count: 1 }], corpusRoles: [{ corpusRoleId: CORPUS_ROLE_IDS.dialogue, count: 1 }], profileCount: 1, membershipCut: 0, createdAt: 1 }));
  const base = storageFixtureForEvaluation({ evidence: [span], clockNow: clock.now }).storage;
  let sourceAssignment: string | undefined = "identity.owner";
  base.languageIdentities = { listIdentities: async () => identities, listProfileLanguages: async query => (query?.profileIds ?? []).flatMap(profileId =>
    profileId === profile.id ? sourceAssignment ? [{ profileId, languageId: sourceAssignment }] : [] : profileId === foreignProfile.id ? [{ profileId, languageId: "identity.foreign" }] : []),
    listProfileSignatures: async () => { throw Error("Serving cannot rediscover language identities"); }, putIdentities: async () => { throw Error("No language writes"); },
    assignProfileLanguages: async () => { throw Error("No assignment writes"); } };
  const requestText = human.turns[0]!.surface.replace("Inception", "🪐한국");
  const catalog = createLanguageIdentityRuntime({ store: base.languageIdentities, hasher, now: clock.now });
  await catalog.ensure(); expect(catalog.selectForSurface(requestText)?.identity.id).toBe("identity.foreign");
  const modelQueries: Array<Parameters<ScceStorage["languageMemory"]["listNgramModels"]>[0]> = [];
  const storage: ScceStorage = { ...base, userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    model: { ...base.model, listLanguageProfiles: async query => [foreignProfile, profile].filter(row => typeof query !== "object"
      || !query.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).slice(0, typeof query === "number" ? query : query?.limit),
      readModel: async () => ({ languageProfiles: [foreignProfile, profile], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) },
    evidence: { ...base.evidence, searchEvidence: async () => [] },
    languageMemory: { ...base.languageMemory, listNgramModels: async query => {
      modelQueries.push(query);
      return compiled.models.filter(model => !query?.profileIds || query.profileIds.includes(String((model.modelJson as { profileId: string }).profileId)));
    }, listLanguageUnits: async () => compiled.units, listSemanticFrames: async () => compiled.semanticFrames,
    listLanguagePatterns: async query => {
      if (query?.languageId === "identity.foreign") throw Error("Foreign patterns must not seed the source-owned program");
      const rows = patterns.filter(pattern => (!query?.patternIds || query.patternIds.includes(pattern.id))
        && (!query?.profileIds || query.profileIds.includes(pattern.profileId))
        && (!query?.patternSchemas || query.patternSchemas.includes(String((pattern.patternJson as { schema: string }).schema)))
        && (!query?.sourceSystem || query.sourceSystem === "dialogue") && (!query?.sourceSystems || query.sourceSystems.includes("dialogue")));
      return query?.view === "request_seed" ? rows.map(requestSeedLanguagePattern) : rows;
    } } };
  const kernel = () => createScceKernel({ storage, clock, idFactory: ids, deterministicReplay: true,
    files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw Error("A source scene cannot execute code"); } } });
  const input = { text: requestText };
  for (const assignment of [undefined, "stale.identity"]) {
    sourceAssignment = assignment;
    await expect(kernel().turn(input)).rejects.toThrow("Foreign patterns must not seed the source-owned program");
  }
  sourceAssignment = "identity.owner"; modelQueries.length = 0;
  const result = await kernel().turn(input);
  expect(result.answer.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replaceAll("Inception", "🪐한국").replace(/\s+/gu, " "));
  expect(result.withheld).toBeUndefined();
  expect(modelQueries.length).toBeGreaterThan(0);
  expect(modelQueries.every(query => query?.profileIds?.length === 1 && query.profileIds[0] === profile.id)).toBe(true);
});
