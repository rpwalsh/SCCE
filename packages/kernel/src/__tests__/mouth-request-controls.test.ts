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
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { FieldState } from "../types.js";
import type { LanguagePatternRecord } from "../storage.js";

const location = "Neralis observatory is located on Pelora island.";
const director = "Mira Venn directs Neralis observatory.";
const patterns: LanguagePatternRecord[] = [{ id: "control.where", profileId: "profile.request", patternKind: "semantic_role", support: 1, entropy: 0,
  evidenceIds: ["request.evidence" as never], updatedAt: 1, patternJson: { schema: "scce.request_requirement_pattern.v1", surface: "where is", anchor: "start",
    selectedAuthority: "factual", requestSpanRole: "control", requestUnitResponseCopyRecipe: "scce.request_unit_response_copy.v1", requestUnitResponseCopyAuthority: "factual",
    requestUnitResponseCopy: [{ unit: "where", supportedPairs: 6, copiedPairs: 0 }, { unit: "is", supportedPairs: 6, copiedPairs: 6 }] } },
  { id: "control.located", profileId: "profile.request", patternKind: "semantic_role", support: 1, entropy: 0, evidenceIds: ["request.evidence" as never], updatedAt: 1,
    patternJson: { schema: "scce.request_requirement_pattern.v1", surface: "located", anchor: "any", selectedAuthority: "factual", requestSpanRole: "control",
      requestUnitResponseCopyRecipe: "scce.request_unit_response_copy.v1", requestUnitResponseCopyAuthority: "factual",
      requestUnitResponseCopy: [{ unit: "located", supportedPairs: 6, copiedPairs: 6 }] } }];
afterEach(() => clearCorpusIdentitySignals());

it("carries request controls separately into Mouth and refuses a truthful same-span answer to the wrong relation", async () => {
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const text = `${director} ${location}`;
  const sourceVersionId = ids.sourceVersionId(text);
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const source = createEvidenceExtractor({ idFactory: ids, hasher }).extract({ sourceId: ids.sourceId("fixture", "fixture://field-notes"), sourceVersionId,
    namespace: "fixture", uri: "fixture://field-notes", text, mediaType: "text/plain", languageProfile: profile, observedAt: 1,
    maxChunkBytes: 4096, sourceTrust: {} as never }).spans[0]!;
  const evidence = [{ ...source, status: "promoted" as const, alpha: 1, provenance: { ...source.provenance as object, title: "Neralis observatory" } }];
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const memory = runtime.hydrate({ models: [], patterns: [] });
  memory.closedClass = ["is", "on"];
  const mouth = createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text), hasher });
  primeCorpusIdentitySignals({ closedClass: new Set(["is", "on"]), identities: new Set(["neralis observatory"]), spread: new Map(), concentration: 0 });
  const matrix = { nodes: [], values: [] };
  const field: FieldState = { requestFeatures: [], seeds: [], active: [], ppf: [], ppfDiagnostics: {}, causalMass: [], alphaTrace: {
    alpha: 1, thresholds: { virtual: 1, visible: 1, bonded: 1, structural: 1 }, relations: [], adjacency: matrix, laplacian: matrix, normalizedLaplacian: matrix,
    surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 }, contradictionMass: 0, bondedLeakage: 0 } };
  const speak = async (question: string, answer: string, controls = patterns) => {
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: answer, evidence, nodes: [], field, createdAt: 1 });
    return mouth.speak({ requestText: question, requestControlPatterns: controls, construct: { id: ids.constructId({}), episodeId: ids.episodeId(), forceVector: {}, nodes: [], edges: [], artifacts: [] },
      field, languageProfile: profile, languageMemory: memory, evidence, entailment, requestedAuthority: "factual", claimBases: [{ id: "source.claim", text: answer,
        basis: "direct_evidence", evidenceIds: [source.id], priorIds: [], graphNodeIds: [], graphEdgeIds: [], externallyFactual: true, hypothetical: false, trace: {} }],
      selectedCandidate: { id: "selected.source.claim", kind: "proof-answer", answer, force: "inferred", evidenceIds: [source.id], boundaries: ["source-bound"], audit: {},
        scores: { support: 1, contradiction: 0, faithfulness: 1, alphaPressure: 1, actionability: 0, evidenceCoverage: 1, novelty: 0, realizability: 1 } } });
  };
  const correct = await speak("Where is Neralis observatory located?", location);
  expect(correct.text).toBe(location);
  expect(correct.evidenceRefs).toEqual([source.id]);
  expect(correct.surfaceValid).toBe(true);
  expect(memory.importedPatterns).toEqual([]);
  for (const [question, answer] of [["Where is Neralis observatory located?", director], ["Where is Neralis observatory blood type?", location],
    ["Where is Neralis observatory date?", location], ["Where is Neralis observatory year?", location]]) {
    const rejected = await speak(question!, answer!);
    expect(rejected.text).toBe("");
  }
});
