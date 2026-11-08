// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileCreativeRequestFrameFromCompatibilityModels, creativeEventCompatibilityModelsFromPatterns } from "../creative-event-compatibility.js";
import { creativeSourceUtterances, compileCreativeSourceUtterancePatterns, realizeCreativeSourceUtterance } from "../creative-source-utterance.js";
import { verifyCreativeSourceCorrespondence } from "../creative-source-correspondence.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "../language-training-recipe.js";
import { canonicalStringify, createClock, createHasher, toJsonValue } from "../primitives.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { LanguagePatternRecord } from "../storage.js";
import { creativeReferenceTestAnnotation } from "./fixtures/creative-reference-test-annotations.js";

const human = JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };
const hasher = createHasher(), ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "surface-acquisition" });
const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
const evidence = { id: "evidence.human", sourceId: "source.human", sourceVersionId, contentHash, charStart: 0,
  charEnd: [...human.text].length, text: human.text, status: "promoted" } as unknown as EvidenceSpan;
const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
const batch = { streamId: "fixture://human-russian", sourceSystem: "dialogue", profile, sourceVersionId, text: human.text,
  evidence: [evidence], transcriptTurns: human.turns, createdAt: 1, retainNgramObservations: false };
const trained = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher, batch });
const cold = (patterns = trained.patterns, spans = [evidence]) => createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({
  models: [], patterns: JSON.parse(JSON.stringify(patterns)), constructionEvidence: spans });

function realize(value: string, patterns = trained.patterns) {
  const state = cold(patterns);
  const text = human.turns[0]!.surface.replace("Спанч", value);
  const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: text, models: state.creativeEventCompatibilityModels, hasher });
  if (!frame) return undefined;
  const utterance = state.creativeEventCompatibilityModels.flatMap(model => creativeSourceUtterances(model, profile.id, hasher))[0];
  return utterance ? realizeCreativeSourceUtterance({ utterance, bundles: state.importedConstructionBundles, frame, requestText: text,
    ownerTurnId: "owner.current", turns: [{ turnId: "owner.current", turnIndex: 0, roleId: "session.role.owner", surface: text }],
    semanticPlanId: "plan.current", hasher }) : undefined;
}

it.each(["Квартун", "κάλυ月", "月", "nuvem"])("cold-restores the actual human reply and substitutes all six owned name occurrences with %s", value => {
  const result = realize(value);
  expect(result).toBeDefined();
  const expected = human.turns[1]!.surface.replaceAll("Спанч", value);
  expect(result!.realization.text.replace(/\s+/gu, " ")).toBe(expected.replace(/\s+/gu, " "));
  expect(result!.realization.text.split(value)).toHaveLength(7);
  expect(result!.realization.text).not.toContain("Спанч");
  expect(human.text).not.toContain(value);
});

it("stores one compact component receipt and a recipe marker without duplicating acquired occurrence ranges", () => {
  const receipts = trained.patterns.filter(pattern => (pattern.patternJson as Record<string, unknown>).schema === "scce.creative_source_surface_acquisition_receipt.v1");
  expect(receipts).toHaveLength(1);
  expect(JSON.stringify(receipts[0]!.patternJson).length).toBeLessThan(Buffer.byteLength(human.text));
  const patterns = trained.patterns.filter(pattern => (pattern.patternJson as Record<string, unknown>).surfaceBindingRecipe);
  expect(patterns.length).toBeGreaterThan(0);
  expect(patterns.every(pattern => (pattern.patternJson as Record<string, unknown>).surfaceBindingRecipe === CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID)).toBe(true);
  expect(patterns.every(pattern => !(pattern.patternJson as Record<string, unknown>).sourceSurfaceBindings)).toBe(true);
});

it("retains the changed-value refusal for legacy source records lacking an acquired occurrence contract", () => {
  const legacy = JSON.parse(JSON.stringify(trained.patterns)) as LanguagePatternRecord[];
  for (const pattern of legacy) {
    const value = pattern.patternJson as Record<string, unknown>;
    if (!value.surfaceBindingRecipe) continue;
    delete value.surfaceBindingRecipe;
    const { sourceUtterancePrerequisites: _prerequisites, ...identity } = value;
    value.id = `creative.observed.compatibility.${hasher.digestHex(canonicalStringify(toJsonValue(identityWithoutId(identity))))}`;
    pattern.id = String(value.id);
    delete value.sourceUtterancePrerequisites;
  }
  const state = cold();
  const eventBundles = state.importedConstructionBundles.filter(bundle => bundle.creativeEvents?.length);
  const events = eventBundles.flatMap(bundle => bundle.creativeEvents ?? []);
  const utterances = compileCreativeSourceUtterancePatterns({ patterns: legacy, events, eventBundles, profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1 });
  const rows = [...legacy.filter(pattern => {
    const bundle = (pattern.patternJson as Record<string, unknown>).bundle as { bindingId?: string } | undefined;
    return !bundle?.bindingId?.startsWith("source.creative.utterance.");
  }), ...utterances.patterns];
  expect(realize("Спанч", rows)).toBeDefined();
  expect(realize("Квартун", rows)).toBeUndefined();
});

function identityWithoutId(value: Record<string, unknown>) {
  const { id: _id, sourceCompilationId: _compilation, ...identity } = value;
  return identity;
}

it("yields to incomplete explicit properties instead of treating lexical identity as referent certification", () => {
  const declaration = creativeReferenceTestAnnotation("oasst-human-russian-creative-pair.json", human.text, hasher);
  const compiled = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    batch: { ...batch, sourceReferenceBindings: { ...declaration, completeProperties: [] } } });
  expect(realize("Спанч", compiled.patterns)).toBeDefined();
  expect(realize("Квартун", compiled.patterns)).toBeUndefined();
});

it("revokes surface acquisition with its source evidence and rejects wrong hashes or unowned role spans", () => {
  expect(cold(trained.patterns, []).creativeEventCompatibilityModels).toEqual([]);
  expect(cold(trained.patterns, [{ ...evidence, contentHash: "hash.foreign" as never }]).creativeEventCompatibilityModels).toEqual([]);
  const state = cold();
  const events = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
  const model = state.creativeEventCompatibilityModels.find(model => model.reliability === "source_observed")!;
  const row = model.sourceObservations!.find(row => row.bindings.length)!;
  expect(verifyCreativeSourceCorrespondence({ ...row, bindings: row.bindings.map(binding => ({ ...binding, eventStart: -1 })) },
    { evidence: [evidence], events, hasher }, [String(evidence.id)])).toBe(false);
  const malformed = trained.patterns.map(pattern => ({ ...pattern, patternJson: toJsonValue({ ...(pattern.patternJson as Record<string, unknown>),
    ...((pattern.patternJson as Record<string, unknown>).schema === "scce.creative_event_compatibility_model.v1" ? { surfaceBindingRecipe: "recipe.foreign" } : {}) }) }));
  expect(creativeEventCompatibilityModelsFromPatterns(malformed, { evidence: [evidence], events, hasher })).toHaveLength(0);
});
