import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  deriveTurnRequirementField,
  detectCannedAnswerSpeech,
  featureSet,
  legacyDetailProfileIdFromSignal
} from "../index.js";
import type { ConstructGraph, EvidenceSpan, FieldState, JsonValue, LanguageProfile, SourceVersion } from "../types.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import {
  ANSWER_ROLE_IDS,
  ANSWER_ROLE_GROUPS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_EDGE_DECISION_IDS,
  QUESTION_SLOT_REASON_IDS,
  QUESTION_TYPE_IDS,
  RELATION_ROLE_IDS
} from "../question-routing-ids.js";
import type { CandidateSurface } from "../candidate.js";
import { genericChatMouthFixture as fixture } from "./fixtures/generic-chat-mouth-fixture.js";

describe("Mouth runtime surface planning", () => {
  const clock = createClock({ fixedTime: 5000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("realizes a typed structural action preview without inventing completion", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "restart pump alpha",
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const preview = `\`\`\`json\n${JSON.stringify({
      artifactKind: "action-preview",
      planId: "capability-plan.fixture",
      capabilityId: "process.local",
      phase: "prepare",
      objectiveSurface: "restart pump alpha",
      executionState: "not_executed"
    }, null, 2)}\n\`\`\``;
    const selectedCandidate: CandidateSurface = {
      id: "action-plan:capability-plan.fixture:0",
      kind: "action-preview",
      answer: preview,
      force: "conjectured",
      evidenceIds: [],
      scores: {
        support: 1,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.9,
        evidenceCoverage: 1,
        novelty: 0,
        realizability: 1,
        risk: 0
      },
      claimBases: ["conjectured"],
      boundaries: ["action-plan-not-executed"],
      audit: {
        source: "capability.plan",
        status: "planned",
        planId: "capability-plan.fixture",
        capabilityId: "process.local",
        phase: "prepare",
        permission: { allowed: true, dryRun: true, mode: "explicit" },
        executionState: "not_executed",
        actionReceiptId: null
      }
    };
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: languageRuntime.hydrateFromImportedBrain({
        importRunId: "action-preview",
        models: [],
        observations: [],
        units: [],
        patterns: [],
        semanticFrames: []
      }),
      requestedAuthority: "action",
      selectedCandidate,
      semanticInput: {
        schema: "scce.mouth.semantic_input.v1",
        authority: "action",
        slots: [{
          id: "mouth.slot.action.preview.fixture",
          roleId: "mouth.role.action.preview",
          value: preview,
          evidenceIds: []
        }]
      }
    });

    expect(spoken.text).toContain('"objectiveSurface": "restart pump alpha"');
    expect(spoken.text).toContain('"capabilityId": "process.local"');
    expect(spoken.text).toContain('"executionState": "not_executed"');
  });

  it("rejects a plain completion claim that is not structurally bound to the audited action plan", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "restart pump alpha",
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const falseCompletion = "Pump alpha restarted successfully.";
    const selectedCandidate: CandidateSurface = {
      id: "action-plan:capability-plan.false-completion:0",
      kind: "action-preview",
      answer: falseCompletion,
      force: "conjectured",
      evidenceIds: [],
      scores: {
        support: 1,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.9,
        evidenceCoverage: 1,
        novelty: 0,
        realizability: 1,
        risk: 0
      },
      claimBases: ["conjectured"],
      boundaries: ["action-plan-not-executed"],
      audit: {
        source: "capability.plan",
        status: "planned",
        planId: "capability-plan.false-completion",
        capabilityId: "process.local",
        phase: "prepare",
        permission: { allowed: true, dryRun: true, mode: "explicit" },
        executionState: "not_executed",
        actionReceiptId: null
      }
    };
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: languageRuntime.hydrateFromImportedBrain({
        importRunId: "action-preview-false-completion",
        models: [],
        observations: [],
        units: [],
        patterns: [],
        semanticFrames: []
      }),
      requestedAuthority: "action",
      selectedCandidate,
      semanticInput: {
        schema: "scce.mouth.semantic_input.v1",
        authority: "action",
        slots: [{
          id: "mouth.slot.action.preview.false-completion",
          roleId: "mouth.role.action.preview",
          value: falseCompletion,
          evidenceIds: []
        }]
      }
    });

    expect(spoken.text).not.toContain(falseCompletion);
    expect(spoken.realizationTrace.selected.id).not.toBe("candidate:generated:governed-action-preview");
  });

  it("keeps an audited terminal runtime-motion surface ahead of graph-derived prose", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate = terminalRuntimeMotionCandidate("fixture focus.");
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "terminal-runtime-motion"),
      requestedAuthority: "factual",
      selectedCandidate
    });

    expect(spoken.text).toBe(selectedCandidate.answer);
    expect(spoken.evidenceRefs).toEqual([]);
    expect(spoken.realizationTrace.selected.id).toBe(selectedCandidate.id);
    expect(spoken.realizationTrace.languageMemory).toMatchObject({ bypassed: true, reason: "deterministic-mouth" });
  });

  it("removes unmatched structural closers without changing the selected surface content", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate = terminalRuntimeMotionCandidate("Aster (Beta) ) ).");
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, directEvidence(source), "terminal-runtime-motion-delimiters"),
      requestedAuthority: "factual",
      selectedCandidate
    });

    expect(spoken.text).toBe("Aster (Beta).");
    expect([...spoken.text].filter(char => char === "(")).toHaveLength(1);
    expect([...spoken.text].filter(char => char === ")")).toHaveLength(1);
  });

  it("clips at completed Unicode sentence and token boundaries", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const completed = "Άλφα ολοκληρώθηκε.";
    const oversized = `Βήτα ${"παράδειγμα ".repeat(12).trimEnd()}.`;
    const unfinished = "Γάμμα αποσ";
    const selectedCandidate = terminalRuntimeMotionCandidate(`${completed} ${oversized} ${unfinished}`);
    const maxLength = 64;
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, directEvidence(source), "terminal-runtime-motion-extent"),
      requestedAuthority: "factual",
      selectedCandidate,
      maxLength
    });

    expect(spoken.text).toBe(completed);
    expect(spoken.text).not.toContain(unfinished);
    expect([...spoken.text].length).toBeLessThanOrEqual(maxLength);
    expect(spoken.text).not.toMatch(/\p{Letter}$/u);
  });

  it("rejects canonical graph control identifiers from a terminal user surface", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const nodeId = `node_${"a".repeat(48)}`;
    const relationId = `relation_${"b".repeat(48)}`;
    const selectedCandidate = terminalRuntimeMotionCandidate(`fixture focus ${nodeId} ${relationId}.`);
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: languageRuntime.hydrateFromImportedBrain({
        importRunId: "terminal-runtime-motion-control-ids",
        models: [],
        observations: [],
        units: [],
        patterns: [],
        semanticFrames: []
      }),
      requestedAuthority: "factual",
      selectedCandidate
    });

    expect(spoken.text).toBe("");
    expect(spoken.text).not.toContain(nodeId);
    expect(spoken.text).not.toContain(relationId);
  });

  it("preserves an exact source-bound reasoned surface instead of replacing it with a language prior", async () => {
    const source = sourceVersion();
    const evidenceProfileId = "profile:reasoned-source-bound";
    const evidenceSourceVersionId = "source-version:reasoned-source-bound" as SourceVersion["sourceVersionId"];
    const evidence = {
      ...directEvidence(source),
      sourceVersionId: evidenceSourceVersionId,
      languageHints: { profileId: evidenceProfileId }
    };
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate: CandidateSurface = {
      id: "proposal:reasoned-source-bound:0",
      kind: "reasoned-synthesis",
      answer: evidence.text,
      force: "inferred",
      evidenceIds: [evidence.id],
      scores: {
        support: 0.8,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.8,
        evidenceCoverage: 1,
        novelty: 0,
        realizability: 1,
        risk: 0
      },
      claimBases: ["reasoned_inference"],
      boundaries: [],
      audit: {
        source: "cognitive-proposal",
        semanticFrame: {
          surfaceOriginId: "surface.cognitive_proposal.bound_proof_evidence.v1",
          surfaceEvidenceIds: [evidence.id]
        }
      }
    };
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment: {
        ...entailment,
        evidenceIds: [],
        proof: { ...entailment.proof, evidenceIds: [] }
      },
      languageMemory: {
        ...importedMemory(source, evidence, "reasoned-source-bound"),
        scope: {
          mode: "cluster",
          clusterId: "language-cluster:reasoned-source-bound",
          profileIds: ["fixture-language", evidenceProfileId],
          sourceVersionIds: [String(source.sourceVersionId), String(evidenceSourceVersionId)],
          purityProven: true,
          degraded: false
        }
      },
      requirementField: {
        ...deriveTurnRequirementField({ requestText: fixture.claim }),
        semanticPreservation: 1
      },
      requestedAuthority: "reasoned",
      selectedCandidate
    });

    expect(spoken.text).toBe(evidence.text);
    expect(spoken.evidenceRefs).toEqual([evidence.id]);
    expect(spoken.realizationTrace.selected.id).toBe(selectedCandidate.id);
  });

  it("collapses overlapping factual spans before applying the default surface extent", async () => {
    const source = sourceVersion();
    const clauses = [
      "Aurelia Venn (1815-1852) was a mathematician and writer whose work connected symbolic notation with mechanical calculation",
      "in 1843 Aurelia Venn published notes on Engine-7 that described a symbolic procedure for calculating Bernoulli numbers",
      "the notes distinguished the machine's physical mechanism from the abstract operations and symbols it could represent",
      "her worked sequence linked numbered steps intermediate values and a final result while preserving the operation order"
    ];
    const factualSurface = clauses.join("; ");
    const overlap = clauses.slice(1).join("; ").slice(0, 272);
    const bloatedSurface = `${factualSurface}; ${overlap}; ${factualSurface}.`;
    const baseEvidence = directEvidence(source);
    const evidence = {
      ...baseEvidence,
      text: factualSurface,
      textPreview: factualSurface,
      charEnd: factualSurface.length,
      byteEnd: Buffer.byteLength(factualSurface),
      features: featureSet(factualSurface, 256)
    };
    const field = emptyField();
    const claim = "Who was Aurelia Venn in 1843 and what concerned Engine-7?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate: CandidateSurface = {
      id: "candidate:factual-overlap-regression",
      kind: "proof-answer",
      answer: bloatedSurface,
      force: "proved",
      evidenceIds: [evidence.id],
      scores: {
        support: 0.96,
        contradiction: 0,
        faithfulness: 0.98,
        alphaPressure: 0.8,
        actionability: 0.5,
        evidenceCoverage: 1,
        novelty: 0,
        realizability: 0.9,
        risk: 0
      },
      claimBases: ["direct_evidence"],
      boundaries: ["selected-evidence-bound"],
      audit: { source: "mouth-runtime.repetition-regression" }
    };
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "factual-overlap-regression"),
      requirementField: deriveTurnRequirementField({ requestText: claim }),
      requestedAuthority: "factual",
      selectedCandidate
    });

    expect(bloatedSurface).toHaveLength(1235);
    expect(spoken.realizationTrace.selected.id).toBe(selectedCandidate.id);
    expect(spoken.text.length).toBeLessThanOrEqual(560);
    expect(spoken.text).toContain("Aurelia Venn");
    expect(spoken.text).toContain("1815-1852");
    expect(spoken.text).toContain("1843");
    expect(spoken.text).toContain("Engine-7");
    expect(spoken.text.split("symbolic notation with mechanical calculation")).toHaveLength(2);
  });

  it("does not emit a bound-selected reasoned surface that did not participate in the proof", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate = sourceBoundReasonedCandidate(evidence, "surface.cognitive_proposal.bound_selected_evidence.v1");
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "reasoned-unrelated-source"),
      targetLanguage: "fixture-language",
      requestedAuthority: "reasoned",
      selectedCandidate
    });

    expect(spoken.realizationTrace.selected.id).not.toBe(selectedCandidate.id);
    expect(spoken.evidenceRefs).not.toContain(evidence.id);
  });

  it("does not emit participating reasoned evidence owned by a different language profile", async () => {
    const source = sourceVersion();
    const evidence = {
      ...directEvidence(source),
      id: "evidence:foreign-language" as EvidenceSpan["id"],
      sourceId: "source:foreign-language" as EvidenceSpan["sourceId"],
      sourceVersionId: "source-version:foreign-language" as EvidenceSpan["sourceVersionId"],
      chunkId: "chunk:foreign-language" as EvidenceSpan["chunkId"],
      languageHints: { profileId: "foreign-language" }
    };
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const selectedCandidate = sourceBoundReasonedCandidate(evidence, "surface.cognitive_proposal.bound_proof_evidence.v1");
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    }).speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "reasoned-foreign-language"),
      targetLanguage: "fixture-language",
      requestedAuthority: "reasoned",
      selectedCandidate
    });

    expect(spoken.realizationTrace.selected.id).not.toBe(selectedCandidate.id);
  });

  it("uses SurfacePlan, imported priors, correction memory, and preservation for normal speech", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const construct = constructGraph(false);
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });

    const beforeMemory = languageRuntime.hydrateFromImportedBrain({ importRunId: "before", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const before = await mouth.speak({
      construct,
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: beforeMemory,
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: null, activeImportRunIds: [] }
    });

    const afterMemory = importedMemory(source, evidence, "after");
    const correctionMemory = createCorrectionMemory({ idFactory: ids, hasher });
    const rule = correctionMemory.record({
      episodeId: ids.episodeId(),
      ownerFeedbackEventId: ids.eventId(),
      now: clock.now(),
      correction: {
        kind: "preferred_surface",
        observedSurface: fixture.correction.observedSurface,
        preferredSurface: fixture.correction.preferredSurface,
        languageId: "fixture-language",
        weight: 0.96
      }
    });
    const correctedMouth = createMouth({ languageMemory: languageRuntime, correctionMemory, hashText: text => hasher.digestHex(text) });
    const after = await correctedMouth.speak({
      construct,
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: afterMemory,
      targetLanguage: "fixture-language",
      correctionRules: [rule],
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["after"] }
    });

    expect(before.text).not.toContain(fixture.importedPhrase);
    expect(after.text).toContain(fixture.correction.preferredSurface);
    expect(after.text).not.toContain(fixture.correction.observedSurface);
    expect(after.text).toContain("70%");
    expect(after.realizationTrace.selected.path).toBe("generated");
    expect(JSON.stringify(after.surfacePlan.constructForces)).toContain("FactualConstruct");
    expect(after.surfacePlan.realizationFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(after.realizationTrace.realizationFrames)).toContain("atomCount");
    expect(after.realizationTrace.candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(after.realizationTrace.brainInfluence)).toContain("frame:greenhouse");
    expect(JSON.stringify(after.realizationTrace.brainInfluence)).toContain("generatedSurfacePieces");
    expect(JSON.stringify(after.realizationTrace.corrections)).toContain(String(rule.id));
    expect(Number((after.realizationTrace.preservation as Record<string, JsonValue>).score ?? 0)).toBeGreaterThan(0.55);
  });

  it("exposes selectedScoreTrace and per-candidate scoreTrace in walshSurfaceEnergy realization trace (PR-5)", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "scoreTrace-test"),
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["scoreTrace-test"] }
    });
    const walsh = spoken.realizationTrace.walshSurfaceEnergy as Record<string, unknown>;
    expect(walsh).toBeDefined();
    expect(Array.isArray(walsh["selectedScoreTrace"])).toBe(true);
    const selectedTrace = walsh["selectedScoreTrace"] as unknown[];
    expect(selectedTrace.length).toBeGreaterThan(0);
    const ranked = walsh["ranked"] as Array<Record<string, unknown>>;
    expect(ranked).toBeDefined();
    expect(ranked.length).toBeGreaterThan(0);
    expect(Array.isArray(ranked[0]?.["scoreTrace"])).toBe(true);
  });

  it("generates a primary answer from imported language memory instead of copying evidence", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "generated-proof"),
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["generated-proof"] }
    });

    expect(fixture.evidenceText).not.toContain(fixture.importedPhrase);
    expect(spoken.text).not.toBe(fixture.evidenceText);
    expect(spoken.text).toContain(fixture.importedPhrase);
    expect(spoken.text).toContain("70%");
    expect(maxInlineBoundaryRun(spoken.text, fixture.discourseBoundary)).toBeLessThanOrEqual(1);
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(spoken.realizationTrace.candidates.every(candidate => candidate.path === "generated")).toBe(true);
    expect(JSON.stringify(spoken.realizationTrace.discoursePlan)).toContain("unitCount");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("generatedSentences");
    expect(JSON.stringify(spoken.realizationTrace.surfaceRepair)).toContain("mouth.surface-repair");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("language-memory-runtime.generate");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("discourseScore");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("beamExpansions");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("latentCoherence");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("ngramMeanActivation");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("unit:greenhouse");
  });

  it("keeps caveat discourse after generated answer/support and preserves uncertainty", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const base = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const caveat = {
      ...base,
      verdict: "underdetermined" as const,
      force: "conjectured" as const,
      support: 0.46,
      missing: [{
        id: "missing:fixture",
        obligationId: "obligation:fixture",
        reason: fixture.caveatText,
        claimText: fixture.claim,
        required: true,
        kind: "temporal" as const,
        evidenceIds: [],
        sourceVersionIds: [],
        audit: { surfaceDispositionId: "surface.caveat.append" }
      }]
    };
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment: caveat,
      languageMemory: importedMemory(source, evidence, "caveat-discourse"),
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["caveat-discourse"] }
    });

    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(JSON.stringify(spoken.realizationTrace.discoursePlan)).toContain("caveat");
    expect(JSON.stringify(spoken.realizationTrace.surfaceRepair)).toContain("surface-repair");
    expect(spoken.uncertainty.length).toBeGreaterThan(0);
    expect(spoken.text).toContain(fixture.caveatText);
  });

  it("uses fewer discourse units for concise detail than expanded detail", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const shared = {
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory(source, evidence, "detail-discourse"),
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["detail-discourse"] }
    };
    const conciseProfileId = legacyDetailProfileIdFromSignal("brief");
    const detailedProfileId = legacyDetailProfileIdFromSignal("detailed");
    if (!conciseProfileId || !detailedProfileId) throw new Error("legacy detail boundary fixture failed");
    const concise = await mouth.speak({ ...shared, detailProfileId: conciseProfileId });
    const detailed = await mouth.speak({ ...shared, detailProfileId: detailedProfileId });

    expect(concise.surfacePlan.detailProfileId).toBe(conciseProfileId);
    expect(detailed.surfacePlan.detailProfileId).toBe(detailedProfileId);
    expect(unitCount(concise.realizationTrace.discoursePlan)).toBeLessThanOrEqual(unitCount(detailed.realizationTrace.discoursePlan));
    expect(JSON.stringify(concise.realizationTrace.discoursePlan)).not.toContain("prompt-router");
    expect(JSON.stringify(detailed.realizationTrace.discoursePlan)).not.toContain("prompt-router");
  });

  it("can surface a creative artifact force from the same Mouth runtime", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField(0.82);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const creative = { ...entailment, force: "invented" as const, support: 0.18, evidenceIds: [] };
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(true),
      field,
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment: creative,
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "creative", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language"
    });

    expect(spoken.force).toBe("creative");
    expect(JSON.stringify(spoken.surfacePlan.constructForces)).toContain("CreativeConstruct");
    expect(spoken.text).toContain(fixture.creativeArtifact.path);
  });

  it("keeps import accounting out of normal brain questions", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "What does this brain know?",
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "wiki-concept-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["scce2_import_run_wiki_fixture", "wiki-concept-language"],
        importedLanguagePriorCount: 5,
        importedGraphPriorCount: 6400,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 6405,
        importedProgramPriorCount: 0,
        unknownPriorCount: 1,
        runs: [{
          importRunId: "scce2_import_run_wiki_fixture",
          brainVersion: "scce2:wiki-fixture",
          rows: 2,
          forceClasses: { unknown_prior: 1, learned_concept_prior: 1 },
          rowCounts: { source_versions: 2, graph_nodes: 3937, graph_edges: 2461, graph_hyperedges: 2 },
          warnings: []
        }, {
          importRunId: "wiki-concept-language",
          brainVersion: "scce2:wiki-fixture",
          rows: 5,
          forceClasses: { learned_language_prior: 5 },
          rowCounts: { ngram_models: 1, ngram_observations: 1, language_units: 1, language_patterns: 1, semantic_frames: 1 },
          warnings: []
        }]
      }
    });

    expect(spoken.text).not.toContain("scce2_import_run_wiki_fixture");
    expect(spoken.text).not.toContain("3937");
    expect(spoken.text).not.toContain("2461");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("graph nodes");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("import run");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("shard sample");
    expect(spoken.force).toBe("underdetermined");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(detectCannedAnswerSpeech(spoken.text)).toEqual([]);
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(JSON.stringify(spoken.surfacePlan.constructForces)).not.toContain("ImportSummaryConstruct");
    for (const leak of [
      "i18n:",
      "surface.",
      "mouth.",
      "workspace.kernel.",
      "learned_prior_summary",
      "import_bound",
      "graph node count",
      "graph edge count",
      "language prior count",
      "direct evidence count",
      "imported graph prior count",
      "learned prior count",
      "learned graph priors",
      "direct source spans unavailable",
      "hydrated brain",
      "learned prior answer",
      "certified factual proof"
    ]) expect(spoken.text.toLocaleLowerCase()).not.toContain(leak);
    expect(spoken.text).not.toContain("certified by the available evidence");
  });

  it("keeps runtime status diagnostics structured and out of Mouth speech", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "Give one concise status sentence for this SCCE runtime.",
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: runtimeDiagnosticInsufficientSupportGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "runtime-status-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["runtime-status-language"],
        importedLanguagePriorCount: 5,
        importedGraphPriorCount: 6400,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 6405,
        importedProgramPriorCount: 0,
        unknownPriorCount: 1
      }
    });

    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(spoken.force).toBe("bounded");
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(spoken.realizationTrace.selected.textHash).toBe(hasher.digestHex(""));
    expect(spoken.inspectRefs.some(ref => ref.kind === "construct")).toBe(true);
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("runtime-status-language");
  });

  it("answers an ordinary hydrated question from a semantic answer construct without import telemetry", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const claim = "who was ada lovelace and what was her contribution to computer science?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: claim,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "ordinary-prior-answer"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["scce2_import_run_wiki_fixture", "ordinary-prior-answer"],
        importedLanguagePriorCount: 5,
        importedGraphPriorCount: 6400,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 6405,
        importedProgramPriorCount: 0,
        unknownPriorCount: 1,
        runs: [{
          importRunId: "scce2_import_run_wiki_fixture",
          brainVersion: "scce2:wiki-fixture",
          rows: 2,
          forceClasses: { unknown_prior: 1, learned_concept_prior: 1 },
          rowCounts: { source_versions: 2, graph_nodes: 3937, graph_edges: 2461, graph_hyperedges: 2 },
          warnings: []
        }]
      }
    });

    expect(spoken.text).toContain("Ada Lovelace");
    expect(spoken.text).toContain("Analytical Engine");
    expect(spoken.text.toLocaleLowerCase()).toContain("mathematician");
    expect(spoken.text.toLocaleLowerCase()).toContain("notes");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("object");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("person who studies");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("source-certified");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("learned graph priors");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("direct source spans unavailable");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("hydrated brain");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("learned prior answer");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("certified factual proof");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("prior-bound");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("import run");
    expect(spoken.text.toLocaleLowerCase()).not.toContain("graph nodes");
    expect(spoken.text).not.toContain("loaded through");
    expect(spoken.text).not.toContain("3937 graph nodes");
    expect(spoken.text).not.toContain("Ada Lovelace, a mathematician, wrote notes about the analytical engine. Charles Babbage invented analytical engine");
    expect(spoken.text).not.toContain("Charles Babbage invented");
    expect(spoken.text).not.toContain("surface.point=");
    expect(spoken.text).not.toContain("surface.limit=");
    expect(spoken.text).not.toContain("surface.grounding=");
    const graphBeadSentences = [
      "Ada Lovelace is mathematician",
      "Ada Lovelace wrote notes about Analytical Engine",
      "Analytical Engine is mechanical computer",
      "Charles Babbage invented Analytical Engine"
    ].map(normalizeSentence);
    const plannedPointSurfaces = spoken.surfacePlan.orderedPoints.map(point => normalizeSentence(point.proposition));
    const spokenSentences = sentenceSurfaces(spoken.text).map(normalizeSentence);
    for (const graphBead of graphBeadSentences) {
      expect(plannedPointSurfaces).not.toContain(graphBead);
    }
    expect(sentenceCount(spoken.text)).toBeGreaterThanOrEqual(1);
    expect(spoken.force).toBe("bounded");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(detectCannedAnswerSpeech(spoken.text)).toEqual([]);
    expectNoSystemMetaSpeech(spoken.text);
    expect(JSON.stringify(spoken.realizationTrace.selected)).toContain("candidate:generated:rhetorical-lattice");
    expect(JSON.stringify(spoken.surfacePlan.constructForces)).toContain("InferenceConstruct");
    expect(JSON.stringify(spoken.surfacePlan.constructForces)).not.toContain("ImportSummaryConstruct");
    expect(JSON.stringify(spoken.surfacePlan.audit)).toContain("semanticAnswer");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("rhetoricalSentenceLattice");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("proseCandidates");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("critic");
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("ordinary-prior-answer");
  });

  it("realizes graph answer slots through the rhetorical lattice instead of emitting an empty semantic answer", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const question = "Who was Ada Lovelace?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: semanticAnswerConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "empty-semantic-answer", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["empty-semantic-answer"],
        importedLanguagePriorCount: 0,
        importedGraphPriorCount: 4,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 4,
        importedProgramPriorCount: 0,
        unknownPriorCount: 0
      }
    });

    expect(spoken.text.trim().length).toBeGreaterThan(0);
    expect(spoken.text).not.toContain("[no_proof]");
    expect(spoken.text).toContain("Ada Lovelace");
    expect(spoken.text).toContain("Analytical Engine");
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:rhetorical-lattice");
    expect(spoken.realizationTrace.selected.textHash).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(spoken.evidenceRefs).toEqual([]);
  });

  it("does not echo unsupported hydrated questions or let language priors supply facts", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const question = "Who are the main characters in 'Star Trek'?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "unsupported-topic-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["unsupported-topic-language"],
        importedLanguagePriorCount: 100,
        importedGraphPriorCount: 0,
        importedDirectEvidenceCount: 0,
        importedLearnedPriorCount: 100,
        importedProgramPriorCount: 0,
        profileExcerptEvidenceCount: 0,
        unknownPriorCount: 0
      }
    });

    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(spoken.force).toBe("underdetermined");
    expect(spoken.realizationTrace.selected.textHash).toBe(hasher.digestHex(""));
    expect(spoken.inspectRefs.some(ref => ref.kind === "construct")).toBe(true);
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("unsupported-topic-language");
    expect(JSON.stringify(spoken.realizationTrace.candidates)).not.toContain("candidate:generated:support-boundary");
  });

  it("does not answer requested member slots from raw learned language priors", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const question = "Who are the main characters in Star Trek?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: starTrekMemory(source, "star-trek-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["star-trek-language"],
        importedLanguagePriorCount: 3,
        importedGraphPriorCount: 0,
        importedDirectEvidenceCount: 0,
        importedLearnedPriorCount: 3,
        importedProgramPriorCount: 0,
        profileExcerptEvidenceCount: 0,
        unknownPriorCount: 0
      }
    });

    expect(spoken.text).not.toContain("Spock");
    expect(spoken.text).not.toContain("Kirk");
    expect(spoken.text).not.toContain("are the main characters in Star Trek");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(spoken.force).toBe("underdetermined");
    expect(JSON.stringify(spoken.realizationTrace.candidates)).not.toContain("candidate:generated:learned-language-prior");
    expect(spoken.realizationTrace.selected.id).not.toBe("candidate:generated:learned-language-prior");
  });

  it("renders supported member slots without category label residue", async () => {
    const source = sourceVersion();
    const field = emptyField();
    const question = "Who are the main characters in Star Trek?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: semanticStarTrekConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: starTrekMemory(source, "star-trek-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["star-trek-language"],
        importedLanguagePriorCount: 3,
        importedGraphPriorCount: 3,
        importedDirectEvidenceCount: 0,
        importedLearnedPriorCount: 6,
        importedProgramPriorCount: 0,
        profileExcerptEvidenceCount: 0,
        unknownPriorCount: 0
      }
    });

    expect(spoken.text).toContain("Spock");
    expect(spoken.text).toContain("James T. Kirk");
    expect(spoken.text).not.toContain("Original Series characters");
    expect(spoken.text).not.toContain("in-category");
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:rhetorical-lattice");
  });

  it("keeps an unsupported semantic continuation internal when no source surface exists", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const question = "Who was Ada Lovelace and what was her contribution to computer science?";
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: insufficientSupportConstructGraph(),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "unsupported-ada-language"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["unsupported-ada-language"],
        importedLanguagePriorCount: 100,
        importedGraphPriorCount: 6400,
        importedDirectEvidenceCount: 0,
        importedLearnedPriorCount: 6500,
        importedProgramPriorCount: 0,
        profileExcerptEvidenceCount: 0,
        unknownPriorCount: 0
      }
    });

    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(spoken.force).toBe("underdetermined");
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(spoken.realizationTrace.selected.textHash).toBe(hasher.digestHex(""));
    expect(JSON.stringify(spoken.surfacePlan.audit)).toContain("force.policy.insufficient_relevance");
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("unsupported-ada-language");
  });

  it("keeps explicit import-summary telemetry in trace rather than generating diagnostic prose", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "SCCE2 import summary status",
      evidence: [],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(false),
      field,
      languageProfile: languageProfile(source),
      evidence: [],
      entailment,
      languageMemory: importedMemory(source, evidence, "import-summary"),
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: "scce2:wiki-fixture",
        activeImportRunIds: ["scce2_import_run_wiki_fixture", "import-summary"],
        importedLanguagePriorCount: 5,
        importedGraphPriorCount: 6400,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 6405,
        importedProgramPriorCount: 2,
        unknownPriorCount: 1,
        runs: [{
          importRunId: "scce2_import_run_wiki_fixture",
          brainVersion: "scce2:wiki-fixture",
          rows: 2,
          forceClasses: { unknown_prior: 1, learned_concept_prior: 1, learned_program_prior: 1 },
          rowCounts: { source_versions: 2, graph_nodes: 3937, graph_edges: 2461, graph_hyperedges: 2 },
          warnings: []
        }]
      }
    });

    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
    expect(detectCannedAnswerSpeech(spoken.text)).toEqual([]);
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(spoken.realizationTrace.selected.textHash).toBe(hasher.digestHex(""));
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("scce2_import_run_wiki_fixture");
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("import-summary");
  });

  function sourceVersion(): SourceVersion {
    const bytes = Buffer.from(fixture.evidenceText);
    const uri = "fixture://greenhouse/evidence";
    return {
      sourceId: ids.sourceId("fixture", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      trust: 0.94,
      metadata: {}
    };
  }

  function directEvidence(source: SourceVersion): EvidenceSpan {
    const bytes = Buffer.from(fixture.evidenceText);
    const contentHash = ids.contentHash(bytes);
    return {
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      contentHash,
      mediaType: source.mediaType,
      byteStart: 0,
      byteEnd: bytes.length,
      charStart: 0,
      charEnd: fixture.evidenceText.length,
      text: fixture.evidenceText,
      textPreview: fixture.evidenceText,
      languageHints: {},
      scriptHints: {},
      trustVector: { sourceTrust: source.trust, forceClass: "direct_evidence" },
      provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, fixture.evidenceText.length] },
      features: featureSet(fixture.evidenceText, 128),
      status: "promoted",
      alpha: 0.9,
      observedAt: clock.now()
    };
  }

  function sourceBoundReasonedCandidate(evidence: EvidenceSpan, surfaceOriginId: string): CandidateSurface {
    return {
      id: `proposal:reasoned-source-bound:${surfaceOriginId}`,
      kind: "reasoned-synthesis",
      answer: evidence.text,
      force: "inferred",
      evidenceIds: [evidence.id],
      scores: {
        support: 0.8,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.8,
        evidenceCoverage: 1,
        novelty: 0,
        realizability: 1,
        risk: 0
      },
      claimBases: ["reasoned_inference"],
      boundaries: [],
      audit: {
        source: "cognitive-proposal",
        semanticFrame: {
          surfaceOriginId,
          surfaceEvidenceIds: [evidence.id]
        }
      }
    };
  }

  function terminalRuntimeMotionCandidate(answer: string): CandidateSurface {
    return {
      id: `runtime-motion:${hasher.digestHex(answer).slice(0, 24)}`,
      kind: "dialogue-continuation",
      answer,
      force: "unknown",
      evidenceIds: [],
      scores: {
        support: 0,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0,
        actionability: 0.48,
        evidenceCoverage: 0,
        novelty: 0,
        realizability: 1,
        risk: 0
      },
      boundaries: [
        "runtime-motion-non-assertive",
        "runtime-motion-acquisition-exhausted",
        "runtime-motion-no-fabricated-evidence"
      ],
      audit: {
        schema: "scce.runtime_motion_candidate.v1",
        source: "kernel.runtime_decision_boundary",
        externalFactCertification: false,
        fakeEvidenceForbidden: true,
        semanticFrame: { frameId: "semantic.runtime.motion.clarification.v1" }
      }
    };
  }

  function constructGraph(withArtifact: boolean): ConstructGraph {
    const artifactContent = fixture.creativeArtifact.content;
    const artifact = {
      artifactId: ids.artifactId({ path: fixture.creativeArtifact.path, artifactContent }),
      path: fixture.creativeArtifact.path,
      mediaType: fixture.creativeArtifact.mediaType,
      content: artifactContent,
      contentHash: ids.contentHash(artifactContent),
      role: "doc" as const
    };
    return {
      id: ids.constructId({ fixture: "mouth", withArtifact }),
      episodeId: ids.episodeId(),
      forceVector: { fixture: true },
      nodes: [
        { id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} },
        ...(withArtifact ? [{ id: "family:creative", kind: "construct:creative", label: "fixture.creative", metadata: {} }] : [])
      ],
      edges: [],
      artifacts: withArtifact ? [artifact] : []
    };
  }

  function insufficientSupportConstructGraph(): ConstructGraph {
    const base = constructGraph(false);
    return {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "construct:insufficient-support:ada",
          kind: "construct:insufficient_support",
          label: "Ada Lovelace",
          metadata: {
            schema: "scce.insufficient_support_construct.v1",
            questionShapeId: "question.shape.test.expanded",
            selectedMainSubject: "Ada Lovelace",
            requestedFocuses: ["Ada Lovelace", "contribution", "computer science"],
            closestSubjectCandidates: [],
            relevanceGate: { decision: QUESTION_EDGE_DECISION_IDS.insufficientSupport },
            explanatoryAnswerContract: {},
            activeBrainVersion: "scce2:wiki-fixture",
            activeImportRunIds: ["unsupported-ada-language"],
            certificationBoundary: {
              directEvidenceCount: 0,
              externalFactCertification: false
            }
          }
        }
      ]
    };
  }

  function runtimeDiagnosticInsufficientSupportGraph(): ConstructGraph {
    const base = insufficientSupportConstructGraph();
    return {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "construct:runtime-diagnostic:status",
          kind: "construct:runtime_diagnostic",
          label: "construct.runtime_diagnostic",
          metadata: {
            schema: "scce.runtime_diagnostic_construct.v1",
            answerSurface: "The running machine should answer from learned graph priors when they carry relevant topology; those priors are import-bound, not certified proof. LanguageMemory should only realize the selected meaning slots. Broad text-retrieval fallback is outside the intended runtime route.",
            forceId: "output.force.import_bound",
            runtimeBoundary: "learned_priors_are_speakable_not_certifying"
          }
        }
      ]
    };
  }

  function semanticAnswerConstructGraph(): ConstructGraph {
    const base = constructGraph(false);
    return {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "construct:semantic-answer:ada",
          kind: "construct:semantic_answer",
          label: "Ada Lovelace",
          metadata: {
            schema: "scce.semantic_answer_construct.v1",
            selectedSubject: "Ada Lovelace",
            selectedFacts: [
              {
                subject: "Ada Lovelace",
                predicate: "is",
                object: "mathematician",
                sourceNodeId: "node:ada",
                targetNodeId: "node:mathematician",
                relationId: "edge:ada:mathematician",
                forceClass: "learned_concept_prior",
                score: 0.91,
                activation: 0.88,
                overlap: 0.73,
                support: 0.86,
                roleId: ANSWER_ROLE_IDS.identity,
                alphaRhetoricalCentrality: 0.82,
                pathScore: 0.79,
                roleScore: 0.88,
                bridgeValue: 0.84,
                backgroundPenalty: 0,
                forceMeaning: 0.92,
                certificationPower: 0
              },
              {
                subject: "Ada Lovelace",
                predicate: "wrote notes about",
                object: "Analytical Engine",
                sourceNodeId: "node:ada",
                targetNodeId: "node:analytical-engine",
                relationId: "edge:ada:analytical-engine-notes",
                forceClass: "learned_concept_prior",
                score: 0.94,
                activation: 0.9,
                overlap: 0.78,
                support: 0.89,
                roleId: ANSWER_ROLE_IDS.contribution,
                alphaRhetoricalCentrality: 0.91,
                pathScore: 0.86,
                roleScore: 0.93,
                bridgeValue: 0.9,
                backgroundPenalty: 0,
                forceMeaning: 0.92,
                certificationPower: 0
              },
              {
                subject: "Analytical Engine",
                predicate: "is",
                object: "mechanical computer",
                sourceNodeId: "node:analytical-engine",
                targetNodeId: "node:mechanical-computer",
                relationId: "edge:analytical-engine:mechanical-computer",
                forceClass: "learned_concept_prior",
                score: 0.87,
                activation: 0.84,
                overlap: 0.65,
                support: 0.82,
                roleId: ANSWER_ROLE_IDS.context,
                alphaRhetoricalCentrality: 0.69,
                pathScore: 0.7,
                roleScore: 0.72,
                bridgeValue: 0.78,
                backgroundPenalty: 0,
                forceMeaning: 0.92,
                certificationPower: 0
              },
              {
                subject: "Charles Babbage",
                predicate: "invented",
                object: "Analytical Engine",
                sourceNodeId: "node:babbage",
                targetNodeId: "node:analytical-engine",
                relationId: "edge:babbage:analytical-engine",
                forceClass: "learned_concept_prior",
                score: 0.83,
                activation: 0.81,
                overlap: 0.61,
                support: 0.79,
                roleId: ANSWER_ROLE_IDS.backgroundActor,
                alphaRhetoricalCentrality: 0.31,
                pathScore: 0.62,
                roleScore: 0.48,
                bridgeValue: 0.6,
                backgroundPenalty: 0.72,
                forceMeaning: 0.92,
                certificationPower: 0
              }
            ],
            alphaRhetoricalPlan: {
              schema: "scce.alpha_rhetorical_plan.v1",
              plannerId: "walsh.alpha_rhetorical_centrality",
              selectedSubject: "Ada Lovelace",
              requiredRoleIds: [...ANSWER_ROLE_GROUPS.required],
              selectedRoleIds: [ANSWER_ROLE_IDS.identity, ANSWER_ROLE_IDS.contribution, ANSWER_ROLE_IDS.context, ANSWER_ROLE_IDS.backgroundActor],
              backgroundRoleIds: [ANSWER_ROLE_IDS.backgroundActor],
              selectedFactKeys: [],
              backgroundFactKeys: [],
              planEnergy: 0.18,
              explanationCompleteness: 0.84,
              targetSentenceCount: 4
            },
            supportIds: ["node:ada", "node:mathematician", "node:analytical-engine", "node:mechanical-computer", "node:babbage", "edge:ada:mathematician", "edge:ada:analytical-engine-notes", "edge:analytical-engine:mechanical-computer", "edge:babbage:analytical-engine"],
            forceId: "output.force.learned_concept_prior_answer",
            boundaryId: "output.force.import_bound",
            activeBrainVersion: "scce2:wiki-fixture",
            activeImportRunIds: ["ordinary-prior-answer"],
            certificationBoundary: {
              directEvidenceCount: 0,
              evidenceSpanIds: [],
              sourceVersionIds: [],
              externalFactCertification: false
            }
          }
        }
      ]
    };
  }

  function semanticStarTrekConstructGraph(): ConstructGraph {
    const base = constructGraph(false);
    const spock = {
      subject: "Spock",
      predicate: "in-category",
      object: "Star Trek the Original Series characters",
      relationId: "edge:trek:spock:category"
    };
    const kirk = {
      subject: "James T. Kirk",
      predicate: "in-category",
      object: "Star Trek the Original Series characters",
      relationId: "edge:trek:kirk:category"
    };
    const residue = {
      subject: "Star Trek",
      predicate: "in-category",
      object: "Star Trek the Original Series characters",
      relationId: "edge:trek:category-label"
    };
    return {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "construct:semantic-answer:trek",
          kind: "construct:semantic_answer",
          label: "Star Trek",
          metadata: {
            schema: "scce.semantic_answer_construct.v1",
            selectedSubject: "Star Trek",
            selectedFacts: [
              semanticMemberFact(residue, 0.5, "rejected"),
              semanticMemberFact(spock, 0.88, "core"),
              semanticMemberFact(kirk, 0.84, "core")
            ],
            questionSlotPlan: {
              schema: "scce.question_slot_plan.v1",
              questionTypeId: QUESTION_TYPE_IDS.collectionMember,
              requiredSlots: [ANSWER_SLOT_IDS.memberRelation],
              filledCoreSlots: [ANSWER_SLOT_IDS.memberRelation],
              filledSecondarySlots: [],
              missingSlots: [],
              selectedAnswerCore: [
                { factKey: semanticTestFactKey(spock), slotId: ANSWER_SLOT_IDS.memberRelation, importance: "core", score: 0.88, reasonIds: [QUESTION_SLOT_REASON_IDS.memberRequested], topicSenseId: "topic_sense.trek" },
                { factKey: semanticTestFactKey(kirk), slotId: ANSWER_SLOT_IDS.memberRelation, importance: "core", score: 0.84, reasonIds: [QUESTION_SLOT_REASON_IDS.memberRequested], topicSenseId: "topic_sense.trek" }
              ],
              selectedContext: [],
              rejected: [
                { factKey: semanticTestFactKey(residue), slotId: ANSWER_SLOT_IDS.collectionLabelFragment, importance: "rejected", score: 0.1, reasonIds: [QUESTION_SLOT_REASON_IDS.collectionFragment], topicSenseId: "topic_sense.trek" }
              ],
              partialSupport: true,
              selectedTopicSenseId: "topic_sense.trek",
              supportMass: 0.86,
              reasonIds: [QUESTION_SLOT_REASON_IDS.typeCollectionMember]
            },
            answerSlots: [{
              id: "answer.slot:trek-members",
              relationIds: [spock.relationId, kirk.relationId],
              factKeys: [semanticTestFactKey(spock), semanticTestFactKey(kirk)],
              support: 0.86,
              activation: 0.82
            }],
            activatedNeighborhood: [],
            selectedRelations: [spock.relationId, kirk.relationId],
            rejectedCandidates: [],
            supportIds: ["node:spock", "node:kirk", "edge:trek:spock:category", "edge:trek:kirk:category"],
            forceId: "output.force.learned_concept_prior_answer",
            boundaryId: "output.force.import_bound",
            activeBrainVersion: "scce2:wiki-fixture",
            activeImportRunIds: ["star-trek-language"],
            certificationBoundary: {
              directEvidenceCount: 0,
              evidenceSpanIds: [],
              sourceVersionIds: [],
              externalFactCertification: false
            }
          }
        }
      ]
    };
  }

  function semanticMemberFact(input: { subject: string; predicate: string; object: string; relationId: string }, score: number, importance: string) {
    return {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      sourceNodeId: `node:${input.subject.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
      targetNodeId: "node:trek-category",
      relationId: input.relationId,
      forceClass: "learned_concept_prior",
      score,
      activation: score,
      overlap: 0.7,
      support: score,
      semanticQuality: 0.62,
      graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
      answerGrade: importance === "core",
      requestedSlotId: GRAPH_SLOT_IDS.requestAlignedRelation,
      relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
      topicSenseId: "topic_sense.trek",
      finalQuestionFit: score,
      questionSlotId: importance === "core" ? ANSWER_SLOT_IDS.memberRelation : ANSWER_SLOT_IDS.collectionLabelFragment,
      questionSlotImportance: importance,
      questionSlotScore: score,
      questionSlotReasonIds: importance === "core" ? [QUESTION_SLOT_REASON_IDS.memberRequested] : [QUESTION_SLOT_REASON_IDS.collectionFragment]
    };
  }

  function semanticTestFactKey(fact: { subject: string; predicate: string; object: string; relationId: string }): string {
    return [fact.subject, fact.predicate, fact.object, fact.relationId]
      .map(part => part.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim())
      .join("\u0001");
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "fixture-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "fixture-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.2,
      createdAt: clock.now()
    };
  }

  function ngramModel(): NgramModelRecord {
    return {
      id: "model:greenhouse",
      streamId: "stream:greenhouse",
      languageHint: "learned:fixture",
      maxOrder: 1,
      discount: 0.75,
      modelJson: {
        sourceSystem: "scce2",
        model: {
          order: 1,
          discount: 0.75,
          symbolCount: 8,
          vocabularySize: 3,
          counts: { "humid-morning": 4, vent: 2, rule: 2 },
          contextCounts: {},
          continuationCounts: {},
          contextContinuationTypes: {},
          totalContinuationTypes: 0,
          unigramCounts: { "humid-morning": 4, vent: 2, rule: 2 },
          totalUnigramCount: 8,
          vocabulary: ["humid-morning", "vent", "rule"]
        }
      },
      updatedAt: clock.now()
    };
  }

  function importedMemory(source: SourceVersion, evidence: EvidenceSpan, importRunId: string) {
    return languageRuntime.hydrateFromImportedBrain({
      importRunId,
      models: [ngramModel()],
      observations: [ngramObservation(source)],
      units: [languageUnit(source)],
      patterns: [languagePattern()],
      semanticFrames: [semanticFrame(evidence)]
    });
  }

  function starTrekMemory(source: SourceVersion, importRunId: string) {
    const text = "Star Trek main characters include James T. Kirk, Spock, Leonard McCoy, Nyota Uhura, Montgomery Scott, Hikaru Sulu, and Pavel Chekov.";
    return languageRuntime.hydrateFromImportedBrain({
      importRunId,
      models: [],
      observations: [],
      units: [{
        id: "unit:star-trek",
        profileId: "profile:star-trek",
        sourceVersionId: source.sourceVersionId,
        script: "fixture-script",
        unitKind: "phrase",
        text,
        features: featureSet(text, 64),
        competenceVector: [1],
        alpha: 0.97,
        evidenceIds: [],
        metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
      }],
      patterns: [{
        id: "pattern:star-trek",
        profileId: "profile:star-trek",
        patternKind: "syntax",
        support: 0.9,
        entropy: 0.1,
        patternJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", counts: { [text]: 3 } },
        evidenceIds: [],
        updatedAt: clock.now()
      }],
      semanticFrames: []
    });
  }

  function ngramObservation(source: SourceVersion): NgramObservation {
    return {
      id: "obs:greenhouse",
      streamId: "stream:greenhouse",
      languageHint: "learned:fixture",
      order: 1,
      history: [],
      symbol: "humid-morning",
      count: 4,
      fieldWeight: 1,
      sourceVersionId: source.sourceVersionId,
      observedAt: clock.now(),
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languageUnit(source: SourceVersion): LanguageUnitRecord {
    return {
      id: "unit:greenhouse",
      profileId: "profile:greenhouse",
      sourceVersionId: source.sourceVersionId,
      script: "fixture-script",
      unitKind: "phrase",
      text: fixture.importedPhrase,
      features: featureSet(fixture.importedPhrase, 64),
      competenceVector: [1],
      alpha: 0.94,
      evidenceIds: [],
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languagePattern(): LanguagePatternRecord {
    return {
      id: "pattern:greenhouse",
      profileId: "profile:greenhouse",
      patternKind: "syntax",
      support: 0.82,
      entropy: 0.1,
      patternJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", counts: { [fixture.importedPhrase]: 2 }, discourse: { boundary: fixture.discourseBoundary } },
      evidenceIds: [],
      updatedAt: clock.now()
    };
  }

  function semanticFrame(evidence: EvidenceSpan): SemanticFrameRecord {
    return {
      id: "frame:greenhouse",
      frameJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", surface: fixture.importedSemanticFrame },
      embedding: [],
      evidenceIds: [evidence.id],
      alpha: 0.96,
      createdAt: clock.now()
    };
  }

  function emptyField(drift = 0): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: featureSet(fixture.claim, 64),
      seeds: [],
      active: [],
      ppf: [],
      ppfDiagnostics: {},
      alphaTrace: {
        alpha: 0.7,
        thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.8366600265340756, structural: 0.51 },
        relations: [],
        adjacency: matrix,
        laplacian: matrix,
        normalizedLaplacian: matrix,
        surfaces: { pressure: 0.2, drift, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function maxInlineBoundaryRun(text: string, boundary: string): number {
    let current = 0;
    let max = 0;
    for (const char of text) {
      if (char === boundary) {
        current++;
        max = Math.max(max, current);
        continue;
      }
      if (char === "." || char === "!" || char === "?") current = 0;
    }
    return max;
  }

  function unitCount(value: JsonValue): number {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
    return typeof record.unitCount === "number" ? record.unitCount : 0;
  }

  function sentenceCount(text: string): number {
    let count = 0;
    for (const char of text) if (char === "." || char === "!" || char === "?") count++;
    return Math.max(1, count);
  }

  function sentenceSurfaces(text: string): string[] {
    const out: string[] = [];
    let current = "";
    for (const char of text) {
      current += char;
      if (char === "." || char === "!" || char === "?") {
        out.push(current);
        current = "";
      }
    }
    if (current.trim()) out.push(current);
    return out;
  }

  function normalizeSentence(text: string): string {
    return text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function expectNoSystemMetaSpeech(text: string): void {
    const lower = text.toLocaleLowerCase();
    for (const phrase of [
      testPhrase("answer", "path"),
      testPhrase("relation", "roles"),
      testPhrase("active", "memory", "labels"),
      testPhrase("graph", "proximity"),
      testPhrase("selected", "memory", "structure"),
      testPhrase("bounded", "wording")
    ]) {
      expect(lower).not.toContain(phrase);
    }
  }

  function testPhrase(...parts: readonly string[]): string {
    return parts.join(" ");
  }
});
