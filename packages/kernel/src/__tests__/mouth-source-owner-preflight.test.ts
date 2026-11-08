// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createLanguageMemoryRuntime,
  createCorrectionMemory, createMouth, createSemanticEntailmentEngine, toJsonValue, type ConstructGraph, type EvidenceSpan, type FieldState } from "../index.js";
import { semanticFactFromRealizationConstraints } from "../mouth-source-facts.js";
import * as closedClassWords from "../closed-class-words.js";

it.each(["missing", "quarantined", "wrong_version", "foreign_evidence", "current"] as const)("checks exact current source owners before rhetorical generation (%s)", async ownership => {
  const owned = ownership === "current";
  const hasher = createHasher(), clock = createClock({ fixedTime: 1 }), ids = createIdFactory({ hasher, clock, deterministicReplay: true });
  const text = "α connects β.", sourceVersionId = ids.sourceVersionId(text);
  const identity = { sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: ids.contentHash(text) };
  const owner = { id: ids.evidenceId(identity), sourceVersionId, status: "promoted", text, alpha: 1, features: [], provenance: {}, trustVector: {} } as EvidenceSpan;
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  let generations = 0;
  const languageMemory = { ...runtime, generate: (input: Parameters<typeof runtime.generate>[0]) => {
    if (input.frames?.some(frame => semanticFactFromRealizationConstraints(frame.realizationConstraints ?? null)?.relationId === fact.relationId)) generations++;
    return runtime.generate(input);
  } };
  const field = { requestFeatures: [], seeds: [], active: [], ppf: [], causalMass: [], alphaTrace: {
    alpha: 1, thresholds: {}, relations: [], adjacency: { nodeIds: [], values: [] }, laplacian: { nodeIds: [], values: [] },
    normalizedLaplacian: { nodeIds: [], values: [] }, surfaces: {}, contradictionMass: 0, bondedLeakage: 0 } } as unknown as FieldState;
  const fact = { subject: "α", predicate: "connects", object: "β", relationId: "relation.connects", sourceNodeId: "", targetNodeId: "",
    forceClass: "direct_evidence", evidenceIds: [String(owner.id)], sourceVersionId: String(sourceVersionId), score: 1, support: 1, activation: 1, overlap: 1 };
  const construct = { id: ids.constructId({}), episodeId: ids.episodeId(), forceVector: {}, nodes: [{ id: "semantic.plan", kind: "construct:semantic_answer", label: "α",
    metadata: toJsonValue({ schema: "scce.semantic_answer_construct.v1", selectedSubject: "α", selectedFacts: [fact], supportIds: [String(owner.id)],
      forceId: "output.force.learned_concept_prior_answer", boundaryId: "output.force.import_bound",
      certificationBoundary: { directEvidenceCount: 0, evidenceSpanIds: [String(owner.id)], sourceVersionIds: [String(sourceVersionId)], externalFactCertification: false } }) }],
    edges: [], artifacts: [] } as unknown as ConstructGraph;
  const evidence = ownership === "missing" ? [] : [{ ...owner,
    ...(ownership === "quarantined" ? { status: "quarantined" } : {}),
    ...(ownership === "wrong_version" ? { sourceVersionId: ids.sourceVersionId("foreign") } : {}),
    ...(ownership === "foreign_evidence" ? { id: ids.evidenceId({ ...identity, spanHash: ids.contentHash("foreign") }) } : {}) } as EvidenceSpan];
  const mouth = createMouth({ languageMemory, correctionMemory: createCorrectionMemory({ hasher, idFactory: ids }), hashText: text => hasher.digestHex(text), hasher });
  const memory = runtime.hydrate({ models: [] });
  memory.closedClass = ["άλφα"];
  const input = { construct, field, languageProfile: profile, languageMemory: memory, evidence, requestText: "άλφα βήτα",
    requestedAuthority: "factual" as const, entailment: createSemanticEntailmentEngine({ hasher, idFactory: ids }).check({ text: "α", evidence, nodes: [], field, createdAt: 1 }) };
  const derived = vi.spyOn(closedClassWords, "requestClosedClassWords");
  let spoken: Awaited<ReturnType<typeof mouth.speak>>;
  try {
    spoken = await mouth.speak(input);
    expect(derived).toHaveBeenCalledTimes(1);
    expect([...derived.mock.results[0]!.value]).toEqual(["άλφα"]);
    memory.closedClass = ["βήτα"];
    await mouth.speak(input);
    expect(derived).toHaveBeenCalledTimes(2);
    expect([...derived.mock.results[1]!.value]).toEqual(["βήτα"]);
  } finally { derived.mockRestore(); }
  if (owned) expect(generations).toBeGreaterThan(0);
  else { expect(generations).toBe(0); expect(spoken.text).toBe(""); }
});
