// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { compileCreativeSourceUtterancePatterns, creativeSourceUtterances, realizeCreativeSourceUtterance } from "../creative-source-utterance.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../creative-event-compatibility.js";
import { createIdFactory } from "../ids.js";
import { canonicalStringify, createClock, createHasher, toJsonValue } from "../primitives.js";
import type { LanguagePatternRecord, ScceKernelDeps } from "../storage.js";
import { creativeSelectorLanguagePattern } from "../request-language-hydration.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";

function control(id: string): LanguagePatternRecord {
  return { id, profileId: "profile.control", patternKind: "semantic_role", support: 1, entropy: 0, evidenceIds: [], updatedAt: 1,
    patternJson: { schema: "scce.request_requirement_pattern.v1", surface: id } };
}

function fixture() {
  let revision = "9007199254740992", rows: LanguagePatternRecord[] = [control("old")];
  const readRevision = vi.fn(async () => revision);
  const list = vi.fn(async () => rows);
  const storage = { languageMemory: { readRevision, listLanguagePatterns: list } } as unknown as ScceKernelDeps["storage"];
  const runtime = createSurfaceLanguageRuntime({ deps: { storage }, languageMemoryRuntime: createLanguageMemoryRuntime(),
    clock: createClock({ fixedTime: 1 }), hasher: createHasher(), cacheMs: 100_000, profileLimit: 32 });
  return { runtime, storage, readRevision, list, publish: (next: string) => { revision = next; rows = [control(next)]; } };
}

it("invalidates warm request controls on an opaque committed revision change without TTL expiry", async () => {
  const f = fixture();
  const first = await f.runtime.requestControlPatternsCached();
  expect(first.map(row => row.id)).toEqual(["old"]);
  await f.runtime.synchronizeWithStorage();
  expect(await f.runtime.requestControlPatternsCached()).toBe(first);
  expect(f.list).toHaveBeenCalledTimes(4);
  f.publish("9007199254740993");
  await f.runtime.synchronizeWithStorage();
  expect((await f.runtime.requestControlPatternsCached()).map(row => row.id)).toEqual(["9007199254740993"]);
  expect(f.list).toHaveBeenCalledTimes(8);
});

it("does not repopulate a cache with an old in-flight read after an external publication", async () => {
  const f = fixture();
  await f.runtime.synchronizeWithStorage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let obsolete = true;
  f.list.mockImplementation(async () => {
    if (obsolete) { const old = [control("old")]; await held; return old; }
    return [control("new")];
  });
  const pending = f.runtime.requestControlPatternsCached();
  f.publish("9007199254740993");
  obsolete = false;
  await f.runtime.synchronizeWithStorage();
  const current = await f.runtime.requestControlPatternsCached();
  release();
  expect((await pending).map(row => row.id)).toEqual(["old"]);
  expect(current.map(row => row.id)).toEqual(["new"]);
  expect(await f.runtime.requestControlPatternsCached()).toBe(current);
});

it("coalesces concurrent revision reads and fails closed when the revision cannot be read", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.readRevision.mockImplementation(async () => { await held; return "revision.first"; });
  const left = f.runtime.synchronizeWithStorage(), right = f.runtime.synchronizeWithStorage();
  expect(f.readRevision).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([left, right]);
  f.readRevision.mockRejectedValueOnce(new Error("revision unavailable"));
  await expect(f.runtime.synchronizeWithStorage()).rejects.toThrow("revision unavailable");
  f.readRevision.mockResolvedValueOnce("");
  await expect(f.runtime.synchronizeWithStorage()).rejects.toThrow("nonempty opaque string");
});

it("refreshes the actual warm human creative prerequisite snapshot after same-source external recompilation", async () => {
  const human = JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };
  const hasher = createHasher(), clock = createClock({ fixedTime: 1 });
  const ids = createIdFactory({ hasher, clock, deterministicReplay: true, namespace: "warm-creative-revision" });
  const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
  const evidence = { id: "evidence.human", sourceId: "source.human", sourceVersionId, contentHash, charStart: 0,
    charEnd: [...human.text].length, text: human.text, status: "promoted" } as unknown as EvidenceSpan;
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
  const memory = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  const compiled = compileLanguageTrainingBatch({ runtime: memory, hasher, batch: { streamId: "fixture://human", sourceSystem: "dialogue",
    profile, sourceVersionId, text: human.text, evidence: [evidence], transcriptTurns: human.turns, createdAt: 1, retainNgramObservations: false } });
  const hydrated = memory.hydrate({ models: [], patterns: compiled.patterns, constructionEvidence: [evidence] });
  const eventBundles = hydrated.importedConstructionBundles.filter(bundle => bundle.creativeEvents?.length);
  const currentModel = compiled.patterns.find(pattern => (pattern.patternJson as Record<string, unknown>).reliability === "source_observed")!;
  const { surfaceBindingRecipe: _recipe, sourceUtterancePrerequisites: _speech, id: _id, ...legacyMaterial } = currentModel.patternJson as Record<string, unknown>;
  const legacyId = `creative.observed.compatibility.${hasher.digestHex(canonicalStringify(toJsonValue(legacyMaterial)))}`;
  const legacy = { ...currentModel, id: legacyId, patternJson: toJsonValue({ ...legacyMaterial, id: legacyId }) };
  const legacySpeech = compileCreativeSourceUtterancePatterns({ patterns: [legacy], events: eventBundles.flatMap(bundle => bundle.creativeEvents ?? []),
    eventBundles, profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1 });
  legacy.patternJson = toJsonValue({ ...(legacy.patternJson as object), sourceUtterancePrerequisites: legacySpeech.prerequisitesByModelId.get(legacyId) });
  let active = [...compiled.patterns.filter(pattern => pattern.id !== currentModel.id
    && !String(((pattern.patternJson as Record<string, unknown>).bundle as { bindingId?: string } | undefined)?.bindingId ?? "").startsWith("source.creative.utterance.")),
    legacy, ...legacySpeech.patterns];
  let revision = "old";
  const patternReads: Array<{ view?: string; patternIds?: readonly string[] }> = [];
  const storage = { languageMemory: { readRevision: async () => revision, listLanguagePatterns: async (query?: { view?: string; patternIds?: string[]; patternSchemas?: string[] }) => {
    patternReads.push({ view: query?.view, patternIds: query?.patternIds });
    const rows = active.filter(pattern => (!query?.patternIds || query.patternIds.includes(pattern.id))
      && (!query?.patternSchemas || query.patternSchemas.includes(String((pattern.patternJson as Record<string, unknown>).schema))));
    return query?.view === "creative_selector" ? rows.map(creativeSelectorLanguagePattern) : rows;
  } },
    evidence: { getEvidenceBatch: async () => [evidence] }, model: { listLanguageProfiles: async () => [profile] } } as unknown as ScceKernelDeps["storage"];
  const runtime = createSurfaceLanguageRuntime({ deps: { storage }, languageMemoryRuntime: memory, clock, hasher, cacheMs: 100_000, profileLimit: 32 });
  const request = human.turns[0]!.surface, fresh = request.replace("Спанч", "Квартун");
  const original = await runtime.creativeSourceMemoryForRequest(request);
  expect(original).toBeDefined();
  expect(patternReads.some(query => query.view === "creative_selector")).toBe(true);
  expect(patternReads.some(query => query.view === undefined && query.patternIds?.includes(legacy.id))).toBe(true);
  expect((await runtime.requestControlPatternsCached()).filter(pattern => (pattern.patternJson as Record<string, unknown>).schema === "scce.creative_event_compatibility_model.v1")
    .every(pattern => !Object.hasOwn(pattern.patternJson as object, "sourceObservations"))).toBe(true);
  active = compiled.patterns;
  revision = "new";
  await runtime.synchronizeWithStorage?.();
  const upgraded = await runtime.creativeSourceMemoryForRequest(fresh);
  expect(upgraded).toBeDefined();
  expect(upgraded!.state.creativeEventCompatibilityModels.map(model => model.id)).toEqual([currentModel.id]);
  const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: fresh, models: upgraded!.state.creativeEventCompatibilityModels, hasher })!;
  const utterance = creativeSourceUtterances(upgraded!.state.creativeEventCompatibilityModels[0]!, profile.id, hasher)[0]!;
  const realized = realizeCreativeSourceUtterance({ utterance, bundles: upgraded!.state.importedConstructionBundles, frame, requestText: fresh,
    ownerTurnId: "owner.current", turns: [{ turnId: "owner.current", turnIndex: 0, roleId: "session.role.owner", surface: fresh }], semanticPlanId: "plan.current", hasher });
  expect(realized?.realization.text.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replaceAll("Спанч", "Квартун").replace(/\s+/gu, " "));
  await runtime.synchronizeWithStorage();
  expect((await runtime.creativeSourceMemoryForRequest(fresh))!.state).toBe(upgraded!.state);
});
