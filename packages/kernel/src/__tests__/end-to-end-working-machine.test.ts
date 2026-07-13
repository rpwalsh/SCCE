import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createEngineeringCorpusProjection,
  createHasher,
  createIdFactory,
  createInventionConstruct,
  createLanguageMemoryRuntime,
  createMouth,
  createPredictionConstruct,
  createProgramGraphBuilder,
  createProgramRepairKernel,
  createSemanticEntailmentEngine,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  defaultSyntheticToolCapabilities,
  detectFieldGaps,
  featureSet,
  inventionConstructNode,
  planLearningSources,
  predictionConstructNode,
  proveClaim,
  runLearningLoop,
  runToolCapability,
  toJsonValue,
  validateProgramHydrationContract,
  type ConstructGraph,
  type EvidenceSpan,
  type FieldState,
  type LanguageProfile,
  type ProofClaim,
  type ProofEvidenceRecord,
  type ProgramConstructIntent,
  type SemanticEntailmentResult,
  type SourceVersion,
  type SyntheticSourceMaterial,
  type ToolCapability
} from "../index.js";

describe("end-to-end working machine source-only path", () => {
  const clock = createClock({ fixedTime: 91000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "working-machine" });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("connects chat, tool use, learning, ProgramGraph patch planning, and proposed prediction surfaces", async () => {
    const claim = measurementClaim();
    const prior = measurementEvidence("proof.prior.pressure", "learned_concept_prior", 42);
    const beforeProof = proveClaim({ claim, candidateEvidence: [prior] });
    expect(beforeProof.verdict).toBe("unsupported_prior_only");

    const source = sourceVersion("fixture://working-machine/question", "Pump alpha pressure is 42 psi.");
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const beforeSpoken = await mouth.speak({
      construct: answerConstruct("before-learning"),
      field: emptyField(claim.id),
      languageProfile: languageProfile(source),
      evidence: [],
      entailment: entailmentFromProof("Can I state pump alpha pressure is 42 psi?", beforeProof, []),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "empty", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "working-language"
    });
    expect(beforeSpoken.force).toBe("underdetermined");
    expect(beforeSpoken.evidenceRefs).toEqual([]);
    expect(JSON.stringify(beforeSpoken.realizationTrace.walshSurfaceEnergy)).toContain("unsupported_prior_only");
    assertHumanSurface(beforeSpoken.text);

    const gaps = detectFieldGaps({ proofResults: [beforeProof] });
    const unsafe: ToolCapability = {
      ...required(defaultSyntheticToolCapabilities().find(capability => capability.id === "tool.fixture.evidence_lookup")),
      permissionClass: "permission.external_account",
      risk: 0.96,
      maxCost: 0.96
    };
    expect(planLearningSources(gaps, [unsafe], learningPolicy())).toEqual([]);

    const sourcePlans = planLearningSources(gaps, defaultSyntheticToolCapabilities(), learningPolicy());
    const evidencePlan = required(sourcePlans.find(plan => plan.requiredToolCapabilityIds.includes("tool.fixture.evidence_lookup")));
    const wrongCapability = required(defaultSyntheticToolCapabilities().find(capability => capability.id === "tool.fixture.patch_preview"));
    const wrongToolResult = runToolCapability(evidencePlan, wrongCapability, { policy: learningPolicy(), now: clock.now() });
    expect(wrongToolResult.errors).toContain("tool.error.capability_not_required");

    const evidenceCapabilities = [required(defaultSyntheticToolCapabilities().find(capability => capability.id === "tool.fixture.evidence_lookup"))];
    const learning = runLearningLoop({
      proofResults: [beforeProof],
      proofClaims: [claim],
      proofEvidence: [prior],
      toolCapabilities: evidenceCapabilities,
      fixtures: {
        evidence: [measurementMaterial(42, "direct_evidence")],
        commandDryRuns: [commandDryRunMaterial()],
        patchPreviews: [patchPreviewMaterial()]
      },
      policy: learningPolicy({ proofClaims: [claim], proofEvidence: [prior] }),
      maxPlansToRun: 1,
      now: clock.now()
    });
    expect(learning.acquisitionResults[0]?.rawSourceRefs[0]).toContain("fixture://evidence/pressure-42");
    expect(learning.acquisitionResults[0]?.acquiredRecords[0]?.sourceVersionId).toBeTruthy();
    expect(learning.promotionDecisions.some(decision => decision.safeToPromote)).toBe(true);
    expect(learning.updatePlans.flatMap(plan => plan.evidenceRecordsToAdd)).toHaveLength(1);
    expect(learning.continueDecision.proofAfterUpdate?.verdict).toBe("certified");

    const promotedEvidence = required(learning.updatePlans.flatMap(plan => plan.evidenceRecordsToAdd)[0]);
    const afterSpoken = await mouth.speak({
      construct: answerConstruct("after-learning"),
      field: emptyField(claim.id),
      languageProfile: languageProfile(source),
      evidence: [promotedEvidence],
      entailment: entailmentFromProof("Pump alpha pressure is 42 psi.", required(learning.continueDecision.proofAfterUpdate), [promotedEvidence]),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "learned", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      learningDecision: learning.continueDecision,
      targetLanguage: "working-language"
    });
    expect(["entailed", "observed"]).toContain(afterSpoken.force);
    expect(afterSpoken.text).toContain("42");
    assertHumanSurface(afterSpoken.text);

    const engineering = engineeringFixture();
    const programConstruct = buildProgram("prepare a source-backed CLI patch helper", [engineering.evidence], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      provenanceEvidenceIds: [String(engineering.evidence.id)]
    });
    const program = required(programConstruct.program);
    expect(validateProgramHydrationContract(required(program.hydration))).toEqual({ valid: true, diagnostics: [] });

    const repairPlan = createProgramRepairKernel({ hasher }).plan({
      program,
      stderr: `${program.entrypoint}(2,1): type check requires an explicit input guard`,
      requestText: "propose a dry-run code patch only"
    });
    const patchSet = required(repairPlan.selectedPatchSet);
    expect(patchSet.affectedFiles).toContain(program.entrypoint);
    expect(patchSet.sourceEvidence.map(item => item.path)).toContain(program.entrypoint);
    expect(patchSet.rollbackPlan.map(item => item.path)).toContain(program.entrypoint);
    expect(repairPlan.validationPlan.every(item => item.commandSource === "program.validation.command.observed")).toBe(true);
    expect(JSON.stringify(repairPlan.dryRunPatchArtifact)).toContain("mutatesRealWorkspace");
    expect(JSON.stringify(repairPlan.dryRunPatchArtifact)).toContain("false");
    expect(repairPlan.dryRunPatchArtifact).not.toBeNull();

    const unobservedProgramConstruct = buildProgram("prepare a source-backed CLI patch helper", [], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      provenanceEvidenceIds: []
    });
    const patchToolPlan = required(planLearningSources(detectFieldGaps({ construct: unobservedProgramConstruct }), defaultSyntheticToolCapabilities(), learningPolicy()).find(plan => plan.requiredToolCapabilityIds.includes("tool.fixture.patch_preview")));
    const patchTool = required(defaultSyntheticToolCapabilities().find(capability => capability.id === "tool.fixture.patch_preview"));
    const patchToolResult = runToolCapability(patchToolPlan, patchTool, { fixtures: { patchPreviews: [patchPreviewMaterial()] }, policy: learningPolicy(), now: clock.now() });
    expect(patchToolResult.errors).toEqual([]);
    expect(JSON.stringify(patchToolResult.acquiredRecords[0]?.metadata)).toContain("patchPreview");

    const prediction = createPredictionConstruct({
      subjectId: "pump.alpha",
      relationId: "relation.pressure.future",
      predictedSurface: "pump alpha pressure may remain near 42 psi during the next stable interval",
      basisEvidenceIds: [String(promotedEvidence.id)],
      basisPriorIds: [prior.id],
      supportScore: 0.64,
      riskScore: 0.31
    });
    const predictionSpoken = await mouth.speak({
      construct: generatedConstruct("prediction", [predictionConstructNode(prediction)]),
      field: emptyField("prediction"),
      languageProfile: languageProfile(source),
      evidence: [promotedEvidence],
      entailment: conjectureEntailment("Predict the next pressure interval.", [promotedEvidence], "conjectured"),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "prediction", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "working-language"
    });
    expect(prediction.proofStatusId).toBe("proof.status.non_certifying_prediction");
    expect(predictionSpoken.force).toBe("underdetermined");
    expect(predictionSpoken.text).toContain("pump alpha pressure");
    expect(predictionSpoken.text).toContain("42 psi");
    expect(predictionSpoken.text).not.toContain("certified fact unavailable");
    assertHumanSurface(predictionSpoken.text);

    const invention = createInventionConstruct({
      title: "pressure drift CLI",
      proposalSurface: "a CLI that checks pressure drift and emits a bounded diagnostic",
      artifactKindIds: ["artifact.cli"],
      basisEvidenceIds: [String(engineering.evidence.id)],
      basisPriorIds: [prior.id],
      programGraph: program,
      supportScore: 0.58,
      riskScore: 0.34
    });
    expect(invention.proofStatusId).toBe("proof.status.generated_not_evidence");
    expect(invention.validationPlan).toHaveLength(2);
    expect(invention.validationPlan.every(item => item.commandSource === "program.validation.command.observed")).toBe(true);
    const inventionSpoken = await mouth.speak({
      construct: { ...programConstruct, nodes: [...programConstruct.nodes, inventionConstructNode(invention)] },
      field: emptyField("invention"),
      languageProfile: languageProfile(source),
      evidence: [engineering.evidence],
      entailment: conjectureEntailment("Invent a pressure drift CLI.", [engineering.evidence], "invented"),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "invention", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "working-language"
    });
    expect(inventionSpoken.text).toContain("pressure drift");
    expect(inventionSpoken.text).toContain("CLI");
    expect(inventionSpoken.text).not.toContain("evidence unavailable");
    expect(inventionSpoken.text).not.toContain("guaranteed");
    assertHumanSurface(inventionSpoken.text);
  });

  function measurementClaim(): ProofClaim {
    return {
      id: "claim.pressure.alpha",
      subject: { id: "pump.alpha", kindId: "kind.machine" },
      relationId: "relation.pressure.measurement",
      object: { id: "pressure", kindId: "kind.quantity" },
      quantity: { value: 42, unitId: "unit.psi", tolerance: 0 },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted",
      requiredSourceBinding: true
    };
  }

  function measurementEvidence(id: string, forceClass: ProofEvidenceRecord["forceClass"], value: number): ProofEvidenceRecord {
    return {
      id,
      forceClass,
      sourceVersionId: forceClass === "direct_evidence" ? `source_version_${id}` : undefined,
      evidenceSpanId: forceClass === "direct_evidence" ? `evidence_span_${id}` : undefined,
      subject: { id: "pump.alpha", kindId: "kind.machine" },
      relationId: "relation.pressure.measurement",
      object: { id: "pressure", kindId: "kind.quantity" },
      quantity: { value, unitId: "unit.psi", tolerance: 0 },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted"
    };
  }

  function measurementMaterial(value: number, forceClass: ProofEvidenceRecord["forceClass"]): SyntheticSourceMaterial {
    return {
      id: `material.pressure.${value}.${forceClass}`,
      sourceKindId: "source.synthetic.fixture_evidence",
      uri: `fixture://evidence/pressure-${value}`,
      mediaType: "text/plain",
      text: `pump alpha pressure ${value} psi`,
      forceClass,
      proofEvidence: measurementEvidence(`proof.direct.${value}`, forceClass, value)
    };
  }

  function commandDryRunMaterial(): SyntheticSourceMaterial {
    return {
      id: "material.command.dry_run",
      sourceKindId: "source.synthetic.command_dry_run",
      uri: "fixture://command/build",
      mediaType: "application/vnd.scce.command-dry-run",
      text: "pnpm run build dry-run completed with no filesystem mutation",
      forceClass: "learned_program_prior",
      metadata: { commandDryRun: { command: "pnpm", args: ["run", "build"], exitCode: 0, mutatesRealWorkspace: false } }
    };
  }

  function patchPreviewMaterial(): SyntheticSourceMaterial {
    return {
      id: "material.patch.preview",
      sourceKindId: "source.synthetic.patch_preview",
      uri: "fixture://patch/preview",
      mediaType: "application/vnd.scce.patch-preview",
      text: "dry-run patch preview for src/cli.ts with rollback to original content hash",
      forceClass: "learned_program_prior",
      metadata: { patchPreview: { affectedFiles: ["src/cli.ts"], mutatesRealWorkspace: false, rollbackPlan: ["restore original artifact hash"] } }
    };
  }

  function engineeringFixture(): { evidence: EvidenceSpan } {
    const packageFacts = createSourceCodeFileFacts({
      path: "package.json",
      mediaType: "application/json",
      text: JSON.stringify({ name: "working-machine-fixture", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" }, dependencies: { typescript: "^5.8.0" }, devDependencies: { vitest: "^3.0.0" } }),
      contentHash: "sha256_working_machine_pkg",
      parser: { id: "json-manifest-fixture", ok: true, diagnostics: [] },
      packageFacts: {
        name: "working-machine-fixture",
        scripts: [
          { name: "build", command: "tsc -p tsconfig.json", roleEvidence: [{ roleId: "source.role.build", source: "fixture", confidence: 0.95, evidence: ["build"] }] },
          { name: "test", command: "vitest run", roleEvidence: [{ roleId: "source.role.validation", source: "fixture", confidence: 0.95, evidence: ["test"] }] }
        ],
        dependencies: [
          { name: "typescript", scope: "dependencies", version: "^5.8.0" },
          { name: "vitest", scope: "devDependencies", version: "^3.0.0" }
        ]
      },
      hasher
    });
    const cliFacts = createSourceCodeFileFacts({
      path: "src/cli.ts",
      mediaType: "text/typescript",
      text: "export function runCommand(input: unknown) { return { ok: true, input }; }\n",
      contentHash: "sha256_working_machine_cli",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.cli", source: "fixture", confidence: 0.9, evidence: ["runCommand"] }],
      declarations: [{ id: "decl:runCommand", name: "runCommand", kind: "syntax.function", exported: true, defaultExport: false, signature: "export function runCommand(input: unknown)", metadata: {} }],
      exports: [{ id: "export:runCommand", exportedNames: ["runCommand"], defaultExport: false, metadata: {} }],
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo://working-machine-fixture",
      files: [
        { path: "package.json", mediaType: packageFacts.mediaType, byteLength: packageFacts.metrics.bytes, contentHash: packageFacts.contentHash, facts: packageFacts },
        { path: "src/cli.ts", mediaType: cliFacts.mediaType, byteLength: cliFacts.metrics.bytes, contentHash: cliFacts.contentHash, facts: cliFacts },
        { path: "pnpm-lock.yaml", mediaType: "text/yaml", byteLength: 24, contentHash: "sha256_working_machine_lock" }
      ],
      hasher
    });
    const source = sourceVersion("repo://working-machine-fixture", "working machine repository", "application/vnd.scce.source-repository");
    const evidence = evidenceSpan(source, "working machine repository", "direct_evidence");
    const projection = createEngineeringCorpusProjection({
      repositoryFacts,
      fileFacts: [packageFacts, cliFacts],
      evidenceIds: [evidence.id],
      sourceVersionId: String(source.sourceVersionId),
      hasher
    });
    return {
      evidence: {
        ...evidence,
        provenance: toJsonValue({ uri: source.canonicalUri, metadata: { engineeringCorpus: projection } }),
        features: ["sym:repository", "sym:program", "sym:cli", "sym:build"]
      }
    };
  }

  function buildProgram(text: string, evidence: EvidenceSpan[], programIntent?: ProgramConstructIntent): ConstructGraph {
    return createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text,
      createdAt: clock.now(),
      evidence,
      entailment: conjectureEntailment(text, evidence, "inferred"),
      programIntent
    });
  }

  function answerConstruct(label: string): ConstructGraph {
    return {
      id: ids.constructId({ fixture: "working-machine", label }),
      episodeId: ids.episodeId(),
      forceVector: {},
      nodes: [{ id: `construct:${label}`, kind: "construct:answer", label, metadata: {} }],
      edges: [],
      artifacts: []
    };
  }

  function generatedConstruct(label: string, nodes: ConstructGraph["nodes"]): ConstructGraph {
    return {
      id: ids.constructId({ fixture: "working-machine", label, nodes: nodes.map(node => node.id) }),
      episodeId: ids.episodeId(),
      forceVector: {},
      nodes: [{ id: `construct:${label}:answer`, kind: "construct:answer", label, metadata: {} }, ...nodes],
      edges: [],
      artifacts: []
    };
  }

  function entailmentFromProof(text: string, proof: ReturnType<typeof proveClaim>, evidence: EvidenceSpan[]): SemanticEntailmentResult {
    const verdict = proof.verdict === "certified" ? "entailed" : proof.verdict === "contradicted" ? "contradicted" : "underdetermined";
    const force = proof.verdict === "certified" ? "proved" : proof.verdict === "contradicted" ? "proved" : "conjectured";
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text,
      evidence,
      nodes: [],
      field: emptyField(text),
      createdAt: clock.now()
    });
    return {
      ...result,
      verdict,
      semanticVerdict: verdict,
      force,
      support: proof.verdict === "certified" ? 0.9 : 0.32,
      contradiction: proof.verdict === "contradicted" ? 0.9 : 0,
      evidenceIds: evidence.map(item => item.id),
      proof: {
        ...result.proof,
        verdict: force,
        evidenceIds: evidence.map(item => item.id),
        scores: toJsonValue({ semanticProofEngine: proof })
      }
    };
  }

  function conjectureEntailment(text: string, evidence: EvidenceSpan[], force: SemanticEntailmentResult["force"]): SemanticEntailmentResult {
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text,
      evidence,
      nodes: [],
      field: emptyField(text),
      createdAt: clock.now()
    });
    return {
      ...result,
      verdict: force === "proved" ? "entailed" : "underdetermined",
      semanticVerdict: force === "proved" ? "entailed" : "underdetermined",
      force,
      support: force === "invented" || force === "conjectured" ? 0.38 : 0.62,
      evidenceIds: evidence.map(item => item.id),
      proof: {
        ...result.proof,
        evidenceIds: evidence.map(item => item.id),
        scores: toJsonValue({ semanticProofEngine: { verdict: force === "proved" ? "certified" : "ambiguous" } })
      }
    };
  }

  function sourceVersion(uri: string, text: string, mediaType = "text/plain"): SourceVersion {
    const bytes = Buffer.from(text);
    return {
      sourceId: ids.sourceId("working-machine", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType,
      observedAt: clock.now(),
      byteLength: bytes.length,
      trust: 0.94,
      metadata: {}
    };
  }

  function evidenceSpan(source: SourceVersion, text: string, forceClass: string): EvidenceSpan {
    const bytes = Buffer.from(text);
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
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: source.trust, forceClass },
      provenance: { uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, forceClass },
      features: featureSet(text, 128),
      status: "promoted",
      alpha: forceClass === "direct_evidence" ? 0.94 : 0.58,
      observedAt: clock.now()
    };
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "working-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "working-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.1,
      createdAt: clock.now()
    };
  }

  function emptyField(seed: string): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: featureSet(seed, 64),
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
        surfaces: { pressure: 0.18, drift: 0.16, contradiction: 0, bond: 0.2, risk: 0.12, actionability: 0.4 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function learningPolicy(extra: Parameters<typeof runLearningLoop>[0]["policy"] = {}) {
    return {
      maxRisk: 0.45,
      maxCost: 0.45,
      maxToolRuns: 3,
      allowedPermissionClasses: ["permission.synthetic_local", "permission.temp_fixture"],
      allowedSideEffectClasses: ["side_effect.none", "side_effect.temp_read"],
      requireDeterministicTools: true,
      quarantinePolicyId: "learning.quarantine.synthetic_required",
      validationPolicyId: "learning.validation.source_span_force_class",
      promotionPolicyId: "learning.promotion.update_plan_only",
      ...extra
    };
  }

  function assertHumanSurface(text: string): void {
    expect(text.trim().length).toBeGreaterThan(12);
    if (text.trim().startsWith("{")) {
      // Structured surface is acceptable for insufficient-support answers from the source-only path
      expect(text).toContain('"candidateKind"');
      expect(text).toContain('"reason"');
      return;
    }
    for (const blocked of ["proofGraph", "validatorVersion", "walsh.surface_energy", "language-memory-runtime", "program.entrypoint=", "program.validation.", "workspace.kernel.answer.schema="]) {
      expect(text).not.toContain(blocked);
    }
    const lower = text.toLocaleLowerCase();
    for (const filler of ["as an ai", "hope this helps", "let me know", "sure,"]) expect(lower).not.toContain(filler);
    expect(text.includes("??")).toBe(false);
    expect(text.includes("!!")).toBe(false);
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }
});
