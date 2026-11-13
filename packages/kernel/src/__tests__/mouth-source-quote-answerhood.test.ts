// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createCorrectionMemory } from "../correction-memory.js";
import { createMouth } from "../mouth.js";
import { trainKneserNey } from "../kneser-ney.js";
import { clearCorpusIdentitySignals } from "../corpus-identity.js";
import { resetCorpusIdentityMeasurements } from "../corpus-identity-runtime.js";
import { attachLocalEvidenceAnswerConstruct, localEvidenceAnswerClaimSurface, localEvidenceAnswerSurface } from "../local-evidence-runtime.js";
import type { FieldState } from "../types.js";

afterEach(() => { clearCorpusIdentitySignals(); resetCorpusIdentityMeasurements(); });

it.each([false, true])("does not turn a topical quote into an answered relation/value (model statistics: %s)", async withModel => {
  clearCorpusIdentitySignals();
  resetCorpusIdentityMeasurements();
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const text = "Honey bees collect pollen in baskets and carry it back to the hive.";
  const sourceVersionId = ids.sourceVersionId(text);
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const source = createEvidenceExtractor({ idFactory: ids, hasher }).extract({ sourceId: ids.sourceId("fixture", "fixture://honey-bee"), sourceVersionId,
    namespace: "fixture", uri: "fixture://honey-bee", text, mediaType: "text/plain", languageProfile: profile, observedAt: 1,
    maxChunkBytes: 4096, sourceTrust: {} as never }).spans[0]!;
  const evidence = [{ ...source, status: "promoted" as const, alpha: 1, provenance: { ...source.provenance as object, title: "Honey bee" } }];
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const memory = runtime.hydrate({ models: [], patterns: [] });
  if (withModel) memory.models = [trainKneserNey(`${text} Workers visit flowers for nectar. Bees carry nectar home.`, { order: 4 })];
  const mouth = createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text), hasher });
  const matrix = { nodes: [], values: [] };
  const field: FieldState = { requestFeatures: [], seeds: [], active: [], ppf: [], ppfDiagnostics: {}, causalMass: [], alphaTrace: {
    alpha: 1, thresholds: { virtual: 1, visible: 1, bonded: 1, structural: 1 }, relations: [], adjacency: matrix, laplacian: matrix, normalizedLaplacian: matrix,
    surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 }, contradictionMass: 0, bondedLeakage: 0 } };
  const candidate = localEvidenceAnswerSurface({ requestText: "Do honey bees collect pollen?", selectedEvidence: evidence });
  expect(candidate).toBeDefined();
  const speak = async (requestText: string, requestClosedClassWords = new Set<string>()) => {
    // Use the production proposal and construct compiler: a broad passage may be useful
    // evidence, but its source-quote fact has not resolved every part of the question.
    const claimText = localEvidenceAnswerClaimSurface(candidate!);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: claimText, evidence, nodes: [], field, createdAt: 1 });
    const construct = attachLocalEvidenceAnswerConstruct({
      construct: { id: ids.constructId({}), episodeId: ids.episodeId(), forceVector: {}, nodes: [], edges: [], artifacts: [] },
      plan: candidate!.plan, requestText, brainMarker: {}, hasher,
      selectedAnswer: { text, claimText: text, evidenceIds: [source.id] }
    });
    return mouth.speak({ requestText, requestClosedClassWords, construct, field, languageProfile: profile, languageMemory: memory, evidence, entailment, requestedAuthority: "factual" });
  };
  const supported = await speak("Do honey bees collect pollen?");
  expect(supported.text).toBe(text);
  expect(supported.evidenceRefs).toEqual([source.id]);
  expect((await speak("What do honey bees collect?", new Set(["what"]))).text).toBe(text);
  for (const request of ["Do honey bees collect nectar?", "Do honey bees manufacture copper?", "Do honey bees collect wax?"]) {
    const unsupported = await speak(request);
    expect(unsupported.text).toBe("");
    expect(unsupported.realizationAvailability?.status).toBe("insufficient_support");
  }
});
