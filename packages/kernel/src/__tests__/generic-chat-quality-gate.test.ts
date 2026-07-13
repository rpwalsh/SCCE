import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createEngineeringCorpusProjection,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createProgramGraphBuilder,
  createRepoSnapshot,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  createSemanticEntailmentEngine,
  featureSet,
  legacyDetailProfileIdFromSignal,
  repoSnapshotToEngineeringContext,
  toJsonValue,
  type ConstructGraph,
  type ContinueDecision,
  type EvidenceSpan,
  type FieldState,
  type LanguageProfile,
  type ProgramConstructIntent,
  type RepoSnapshot,
  type SemanticEntailmentResult,
  type SourceCodeFileFacts,
  type SourceRepositoryFacts,
  type SourceVersion,
  type SpokenOutput
} from "../index.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import { genericChatQualityFixture as fixture } from "./fixtures/generic-chat-quality-fixture.js";

describe("Phase 10 generic chat quality gate", () => {
  const clock = createClock({ fixedTime: 41000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "phase10-quality-gate" });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const mouth = createMouth({
    languageMemory: languageRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
    hashText: text => hasher.digestHex(text)
  });
  const qualityCases: Array<{
    id: string;
    run: () => Promise<{ spoken: SpokenOutput; directEvidenceIds?: string[]; learnedPriorEvidenceIds?: string[]; require?: string[]; forbidden?: string[]; verdict?: string; minSentences?: number }>;
  }> = [
    { id: "casual answer", run: () => speakBasic({ claim: "Give a calm ordinary answer about the reading room lighting.", require: ["lighting"] }) },
    { id: "technical explanation", run: () => speakBasic({ claim: "Explain why the lights dim to 40% after 9:00 p.m. for glare reduction.", require: ["40%", "9:00"], minSentences: 1 }) },
    { id: "factual answer with direct evidence", run: () => speakBasic({ claim: fixture.claim, verdict: "certified", force: "proved", require: ["40%", "9:00"] }) },
    { id: "factual answer with insufficient evidence", run: () => speakBasic({ claim: "State whether holiday exceptions keep lights at 40% after 9:00 p.m.", verdict: "insufficient_evidence", force: "conjectured" }) },
    { id: "source-bound answer", run: () => speakSourceBound() },
    { id: "contradiction answer", run: () => speakContradiction() },
    { id: "creative artifact", run: () => speakCreativeArtifact() },
    { id: "code artifact request using ProgramGraph", run: () => speakProgramArtifact() },
    { id: "repo codebase question using Developer Intelligence", run: () => speakDeveloperIntelligence() },
    { id: "correction-influenced answer", run: () => speakCorrected() },
    { id: "learning-loop caveated answer", run: () => speakLearningCaveat() },
    { id: "typed table log doc question", run: () => speakTypedEvidence() },
    { id: "do not ask a follow-up direct answer", run: () => speakNoFollowUp() }
  ];

  it.each(qualityCases)("$id", async qualityCase => {
    const result = await qualityCase.run();
    assertHumanAnswer(result.spoken, { require: result.require, forbidden: result.forbidden, minSentences: result.minSentences });
    assertWalshSelectedValid(result.spoken);
    assertLearnedPriorsNotCited(result.spoken, result.learnedPriorEvidenceIds ?? []);
    if (result.directEvidenceIds?.length) {
      for (const id of result.directEvidenceIds) expect(result.spoken.evidenceRefs.map(String)).toContain(id);
    }
    if (result.verdict) assertProofVerdictObeyed(result.spoken, result.verdict);
  });

  it("concise and detailed profiles change surface shape through detail profile ids", async () => {
    const conciseProfileId = legacyDetailProfileIdFromSignal("brief");
    const detailedProfileId = legacyDetailProfileIdFromSignal("detailed");
    if (!conciseProfileId || !detailedProfileId) throw new Error("detail profile fixture unavailable");
    const concise = await speakBasic({ claim: "Rewrite concisely: the lights dim to 40% after 9:00 p.m.", detailProfileId: conciseProfileId, density: 0.22, require: ["40%", "9:00"] });
    const detailed = await speakBasic({ claim: "Explain in more detail why the lights dim to 40% after 9:00 p.m.", detailProfileId: detailedProfileId, density: 0.9, require: ["40%", "9:00"] });

    assertHumanAnswer(concise.spoken, { require: concise.require });
    assertHumanAnswer(detailed.spoken, { require: detailed.require });
    assertWalshSelectedValid(concise.spoken);
    assertWalshSelectedValid(detailed.spoken);
    expect(detailProfileIdFromTrace(concise.spoken)).toBe(conciseProfileId);
    expect(detailProfileIdFromTrace(detailed.spoken)).toBe(detailedProfileId);
    expect(surfaceUnitCount(detailed.spoken.text)).toBeGreaterThanOrEqual(surfaceUnitCount(concise.spoken.text));
    expect(JSON.stringify(concise.spoken.realizationTrace.discoursePlan)).not.toEqual(JSON.stringify(detailed.spoken.realizationTrace.discoursePlan));
  });

  async function speakBasic(input: {
    claim: string;
    verdict?: "certified" | "insufficient_evidence" | "contradicted" | "unsupported_prior_only" | "source_bound_only" | "ambiguous";
    force?: SemanticEntailmentResult["force"];
    detailProfileId?: string;
    density?: number;
    require?: string[];
    forbidden?: string[];
    minSentences?: number;
  }): Promise<{ spoken: SpokenOutput; directEvidenceIds: string[]; learnedPriorEvidenceIds: string[]; require?: string[]; forbidden?: string[]; verdict?: string; minSentences?: number }> {
    const source = sourceVersion("fixture://phase10/lighting", fixture.evidenceText);
    const direct = evidenceSpan(source, fixture.evidenceText, "direct_evidence");
    const learned = evidenceSpan(source, fixture.importedSemanticFrame, "learned_language_prior", "learned:language:phase10");
    const field = emptyField(input.claim);
    const entailment = withProofVerdict(semanticEntailment(input.claim, [direct], field), input.verdict ?? "certified", input.force ?? "proved");
    const spoken = await mouth.speak({
      ...baseSpeakInput({ claim: input.claim, source, evidence: [direct, learned], field, entailment, construct: answerConstruct("answer") }),
      detailProfileId: input.detailProfileId,
      style: input.density === undefined ? undefined : { density: input.density },
      maxLength: 1200
    });
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [String(learned.id)], require: input.require, forbidden: input.forbidden, verdict: input.verdict ?? "certified", minSentences: input.minSentences };
  }

  async function speakSourceBound() {
    const source = sourceVersion("fixture://phase10/profile", "SCCE2 profile excerpt records a lighting preference line.");
    const profileExcerpt = evidenceSpan(source, "The SCCE2 profile excerpt says the reading room preference line mentions 40% after 9:00 p.m.", "profile_excerpt_evidence", "profile:excerpt:phase10");
    const field = emptyField("What does the imported profile excerpt say about lighting?");
    const entailment = withProofVerdict(semanticEntailment("What does the imported profile excerpt say about lighting?", [profileExcerpt], field), "source_bound_only", "inferred");
    const spoken = await mouth.speak(baseSpeakInput({ claim: "What does the imported profile excerpt say about lighting?", source, evidence: [profileExcerpt], field, entailment, construct: answerConstruct("source-bound") }));
    return { spoken, directEvidenceIds: [], learnedPriorEvidenceIds: [], require: ["SCCE2 profile excerpt", "40%"], verdict: "source_bound_only" };
  }

  async function speakContradiction() {
    const source = sourceVersion("fixture://phase10/contradiction", fixture.evidenceText);
    const direct = evidenceSpan(source, fixture.evidenceText, "direct_evidence");
    const field = emptyField("The library keeps reading-room lights at 100% after 9:00 p.m.");
    const entailment = withProofVerdict({
      ...semanticEntailment("The library keeps reading-room lights at 100% after 9:00 p.m.", [direct], field),
      verdict: "contradicted",
      semanticVerdict: "contradicted",
      contradiction: 0.92,
      counterexamples: [{
        id: "counter:phase10",
        kind: "quantity",
        claimText: "The library keeps reading-room lights at 100% after 9:00 p.m.",
        evidenceIds: [direct.id],
        sourceVersionIds: [direct.sourceVersionId],
        contradiction: 0.92,
        reason: "direct evidence says 40%, not 100%",
        audit: {}
      }]
    }, "contradicted", "proved");
    const spoken = await mouth.speak(baseSpeakInput({ claim: entailment.claim.text, source, evidence: [direct], field, entailment, construct: answerConstruct("contradiction") }));
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [], require: ["40%", "100%"], verdict: "contradicted" };
  }

  async function speakCreativeArtifact() {
    const source = sourceVersion("fixture://phase10/creative", fixture.creativeArtifact.content);
    const evidence = evidenceSpan(source, fixture.creativeArtifact.content, "direct_evidence");
    const field = emptyField("Draft a tiny reading-room note.");
    const entailment = withProofVerdict(semanticEntailment("Draft a tiny reading-room note.", [evidence], field), "ambiguous", "invented");
    const spoken = await mouth.speak(baseSpeakInput({ claim: "Draft a tiny reading-room note.", source, evidence: [evidence], field, entailment, construct: creativeConstruct() }));
    return { spoken, directEvidenceIds: [], learnedPriorEvidenceIds: [], require: [fixture.creativeArtifact.path] };
  }

  async function speakProgramArtifact() {
    const fixtureContext = engineeringFixture();
    const construct = buildProgram("create a command artifact that reads stdin and writes normalized json", [fixtureContext.evidence], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      provenanceEvidenceIds: [String(fixtureContext.evidence.id)]
    });
    const source = sourceVersion("repo://phase10-program", "phase10 program fixture");
    const field = emptyField("create a command artifact");
    const entailment = programEntailment([fixtureContext.evidence]);
    const spoken = await mouth.speak(baseSpeakInput({ claim: "create a command artifact", source, evidence: [fixtureContext.evidence], field, entailment, construct }));
    return { spoken, directEvidenceIds: [String(fixtureContext.evidence.id)], learnedPriorEvidenceIds: [], require: ["src/cli.ts", "pnpm run build"] };
  }

  async function speakDeveloperIntelligence() {
    const snapshot = developerSnapshotFixture();
    const evidence = evidenceForSnapshot(snapshot);
    const context = repoSnapshotToEngineeringContext(snapshot);
    expect(context.summary.symbolCount).toBeGreaterThanOrEqual(2);
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text: "answer from the observed repo structure",
      createdAt: clock.now(),
      evidence,
      entailment: programEntailment(evidence),
      programIntent: {
        artifactKindIds: ["artifact.cli"],
        capabilityIds: ["capability:command-runtime"],
        provenanceEvidenceIds: evidence.map(item => String(item.id))
      }
    });
    const source = sourceVersion("repo://phase10-dev-intel", "phase10 developer snapshot");
    const field = emptyField("What does this codebase support?");
    const spoken = await mouth.speak(baseSpeakInput({ claim: "What does this codebase support?", source, evidence, field, entailment: programEntailment(evidence), construct }));
    return { spoken, directEvidenceIds: evidence.map(item => String(item.id)), learnedPriorEvidenceIds: [], require: ["src/cli.ts", "pnpm run build"] };
  }

  async function speakCorrected() {
    const source = sourceVersion("fixture://phase10/correction", fixture.evidenceText);
    const direct = evidenceSpan(source, fixture.evidenceText, "direct_evidence");
    const field = emptyField(fixture.claim);
    const claim = `${fixture.correction.observedSurface} lights dim to 40% after 9:00 p.m.`;
    const entailment = withProofVerdict(semanticEntailment(claim, [direct], field), "certified", "proved");
    const correctionMemory = createCorrectionMemory({ idFactory: ids, hasher });
    const correction = correctionMemory.record({
      episodeId: ids.episodeId(),
      ownerFeedbackEventId: ids.eventId(),
      now: clock.now(),
      correction: {
        kind: "preferred_surface",
        observedSurface: fixture.correction.observedSurface,
        preferredSurface: fixture.correction.preferredSurface,
        languageId: "phase10-language",
        weight: 0.97
      }
    });
    const correctedMouth = createMouth({ languageMemory: languageRuntime, correctionMemory, hashText: text => hasher.digestHex(text) });
    const spoken = await correctedMouth.speak({
      ...baseSpeakInput({ claim, source, evidence: [direct], field, entailment, construct: answerConstruct("corrected") }),
      correctionRules: [correction]
    });
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [], require: [fixture.correction.preferredSurface], forbidden: [fixture.correction.observedSurface], verdict: "certified" };
  }

  async function speakLearningCaveat() {
    const source = sourceVersion("fixture://phase10/learning", fixture.evidenceText);
    const direct = evidenceSpan(source, fixture.evidenceText, "direct_evidence");
    const field = emptyField("Answer with the learned update caveat preserved.");
    const entailment = withProofVerdict(semanticEntailment("Answer with the learned update caveat preserved.", [direct], field), "insufficient_evidence", "conjectured");
    const decision: ContinueDecision = {
      id: "continue:phase10:caveat",
      decisionKindId: "continue.answer_with_caveat",
      continueAnswering: false,
      askClarification: false,
      answerWithCaveat: true,
      deferDueToInsufficientEvidence: false,
      reportContradiction: false,
      reportUnsupported: false,
      safeToAssert: false,
      reasonCodes: ["phase10.learning.caveat"],
      trace: toJsonValue({ source: "phase10.fixture" })
    };
    const spoken = await mouth.speak({
      ...baseSpeakInput({ claim: "Answer with the learned update caveat preserved.", source, evidence: [direct], field, entailment, construct: answerConstruct("learning") }),
      learningDecision: decision
    });
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [], verdict: "insufficient_evidence" };
  }

  async function speakTypedEvidence() {
    const text = "table row B has value 17 ms; log Worker status Retry at 2026-06-27T10:00:01Z; doc section OPS-7 records the same Retry.";
    const source = sourceVersion("fixture://phase10/table-log-doc", text);
    const direct = evidenceSpan(source, text, "direct_evidence");
    const field = emptyField("What do the table, log, and doc say for row B?");
    const entailment = withProofVerdict(semanticEntailment("Row B records 17 ms and Worker Retry at 2026-06-27T10:00:01Z in OPS-7.", [direct], field), "certified", "proved");
    const spoken = await mouth.speak(baseSpeakInput({ claim: entailment.claim.text, source, evidence: [direct], field, entailment, construct: answerConstruct("typed") }));
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [], require: ["17", "Worker", "Retry", "2026-06-27T10:00:01Z", "OPS-7"], verdict: "certified" };
  }

  async function speakNoFollowUp() {
    const source = sourceVersion("fixture://phase10/no-follow-up", fixture.evidenceText);
    const direct = evidenceSpan(source, fixture.evidenceText, "direct_evidence");
    const claim = "Answer directly without a follow-up question: the reading-room lights dim to 40% after 9:00 p.m.";
    const field = emptyField(claim);
    const entailment = withProofVerdict(semanticEntailment(claim, [direct], field), "certified", "proved");
    const spoken = await mouth.speak(baseSpeakInput({ claim, source, evidence: [direct], field, entailment, construct: answerConstruct("no-follow-up") }));
    return { spoken, directEvidenceIds: [String(direct.id)], learnedPriorEvidenceIds: [], require: ["40%", "9:00"], forbidden: ["?","follow-up"], verdict: "certified" };
  }

  function baseSpeakInput(input: { claim: string; source: SourceVersion; evidence: EvidenceSpan[]; field: FieldState; entailment: SemanticEntailmentResult; construct: ConstructGraph }) {
    return {
      construct: input.construct,
      field: input.field,
      languageProfile: languageProfile(input.source),
      evidence: input.evidence,
      entailment: input.entailment,
      languageMemory: importedMemory(input.source, input.evidence[0], `phase10-import:${hash32(input.claim).toString(16)}`),
      targetLanguage: "phase10-language",
      brainMarker: {
        activeBrainVersion: "phase10-brain",
        activeImportRunIds: ["phase10-import"],
        importedLanguagePriorCount: 4,
        importedGraphPriorCount: 1,
        importedDirectEvidenceCount: input.evidence.filter(span => forceClass(span) === "direct_evidence").length,
        importedLearnedPriorCount: input.evidence.filter(span => forceClass(span).startsWith("learned_")).length
      }
    };
  }

  function assertHumanAnswer(spoken: SpokenOutput, options: { require?: string[]; forbidden?: string[]; minSentences?: number }) {
    expect(spoken.text.trim().length).toBeGreaterThan(12);
    expect(outputLooksLikeTelemetry(spoken.text)).toBe(false);
    expect(outputContainsCannedFiller(spoken.text)).toBe(false);
    expect(outputContainsForbiddenRuntimeTerms(spoken.text)).toBe(false);
    expect(hasPhraseSalad(spoken.text)).toBe(false);
    expect(hasRepeatedBoundaryStitching(spoken.text)).toBe(false);
    for (const required of options.require ?? []) expect(spoken.text).toContain(required);
    for (const forbidden of options.forbidden ?? []) expect(spoken.text).not.toContain(forbidden);
    expect(sentenceCount(spoken.text)).toBeGreaterThanOrEqual(options.minSentences ?? 1);
  }

  function assertWalshSelectedValid(spoken: SpokenOutput) {
    const trace = objectRecord(spoken.realizationTrace.walshSurfaceEnergy);
    const selected = objectRecord(trace.selected);
    const ranked = Array.isArray(trace.ranked) ? trace.ranked.map(objectRecord) : [];
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(selected.valid).toBe(true);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.some(row => objectRecord(row.result).valid === true || row.valid === true)).toBe(true);
  }

  function assertLearnedPriorsNotCited(spoken: SpokenOutput, learnedPriorEvidenceIds: string[]) {
    const refs = spoken.evidenceRefs.map(String);
    for (const id of learnedPriorEvidenceIds) expect(refs).not.toContain(id);
  }

  function assertProofVerdictObeyed(spoken: SpokenOutput, verdict: string) {
    const trace = JSON.stringify(spoken.realizationTrace.walshSurfaceEnergy);
    expect(trace).toContain(verdict);
    if (verdict === "certified") expect(["entailed", "observed"]).toContain(spoken.force);
    if (verdict === "insufficient_evidence" || verdict === "unsupported_prior_only" || verdict === "ambiguous") {
      expect(spoken.force).toBe("underdetermined");
      expect(spoken.uncertainty.length).toBeGreaterThan(0);
    }
    if (verdict === "source_bound_only") expect(spoken.force).toBe("bounded");
    if (verdict === "contradicted") expect(spoken.force).toBe("contradicted");
  }

  function sourceVersion(uri: string, text: string, mediaType = "text/plain"): SourceVersion {
    const bytes = Buffer.from(text);
    return {
      sourceId: ids.sourceId("phase10", uri),
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

  function evidenceSpan(source: SourceVersion, text: string, evidenceForceClass: string, idPrefix = "evidence"): EvidenceSpan {
    const bytes = Buffer.from(text);
    const contentHash = ids.contentHash(bytes);
    return {
      id: idPrefix === "evidence"
        ? ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash })
        : `${idPrefix}:${hash32(`${source.canonicalUri}:${text}`).toString(16)}` as EvidenceSpan["id"],
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
      trustVector: { sourceTrust: source.trust, forceClass: evidenceForceClass },
      provenance: { sourceSystem: "fixture", provenanceClass: evidenceForceClass, uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, text.length] },
      features: featureSet(text, 128),
      status: "promoted",
      alpha: evidenceForceClass === "direct_evidence" ? 0.93 : 0.62,
      observedAt: clock.now()
    };
  }

  function semanticEntailment(claim: string, evidence: EvidenceSpan[], field: FieldState): SemanticEntailmentResult {
    return createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: claim,
      evidence,
      nodes: [],
      field,
      createdAt: clock.now()
    });
  }

  function withProofVerdict(base: SemanticEntailmentResult, verdict: "certified" | "insufficient_evidence" | "contradicted" | "unsupported_prior_only" | "source_bound_only" | "ambiguous", force: SemanticEntailmentResult["force"]): SemanticEntailmentResult {
    const support = verdict === "certified" ? 0.88 : verdict === "contradicted" ? 0.2 : 0.42;
    const contradiction = verdict === "contradicted" ? 0.88 : 0;
    return {
      ...base,
      verdict: verdict === "contradicted" ? "contradicted" : verdict === "certified" ? "entailed" : "underdetermined",
      semanticVerdict: verdict === "contradicted" ? "contradicted" : verdict === "certified" ? "entailed" : "underdetermined",
      force,
      support,
      contradiction,
      missing: verdict === "insufficient_evidence" || verdict === "unsupported_prior_only" || verdict === "ambiguous"
        ? [{
          id: `missing:${verdict}`,
          obligationId: `obligation:${verdict}`,
          reason: verdict,
          claimText: base.claim.text,
          required: true,
          kind: "source_version",
          evidenceIds: [],
          sourceVersionIds: [],
          audit: {}
        }]
        : base.missing,
      proof: {
        ...base.proof,
        scores: toJsonValue({
          ...objectRecord(base.proof.scores),
          semanticProofEngine: {
            verdict,
            support,
            contradiction,
            directEvidenceIds: base.evidenceIds.map(String),
            certifiedEvidenceIds: verdict === "certified" ? base.evidenceIds.map(String) : []
          }
        })
      }
    };
  }

  function answerConstruct(label: string): ConstructGraph {
    return {
      id: ids.constructId({ fixture: "phase10", label }),
      episodeId: ids.episodeId(),
      forceVector: { fixture: true },
      nodes: [{ id: `construct:${label}`, kind: "construct:answer", label: `phase10.${label}`, metadata: {} }],
      edges: [],
      artifacts: []
    };
  }

  function creativeConstruct(): ConstructGraph {
    const content = fixture.creativeArtifact.content;
    return {
      ...answerConstruct("creative"),
      nodes: [
        { id: "construct:creative", kind: "construct:creative", label: "phase10.creative", metadata: {} },
        { id: "construct:answer", kind: "construct:answer", label: "phase10.answer", metadata: {} }
      ],
      artifacts: [{
        artifactId: ids.artifactId({ path: fixture.creativeArtifact.path, artifactContent: content }),
        path: fixture.creativeArtifact.path,
        mediaType: fixture.creativeArtifact.mediaType,
        content,
        contentHash: ids.contentHash(content),
        role: "doc"
      }]
    };
  }

  function buildProgram(text: string, evidence: EvidenceSpan[], programIntent?: ProgramConstructIntent): ConstructGraph {
    return createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text,
      createdAt: clock.now(),
      evidence,
      entailment: programEntailment(evidence),
      programIntent
    });
  }

  function programEntailment(evidence: EvidenceSpan[]): SemanticEntailmentResult {
    const field = emptyField("phase10 program request");
    const result = semanticEntailment("phase10 program request", evidence, field);
    const evidenceIds = evidence.map(item => item.id);
    return {
      ...result,
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "inferred",
      support: 0.62,
      contradiction: 0,
      evidenceIds,
      proof: {
        ...result.proof,
        evidenceIds,
        scores: {}
      }
    };
  }

  function engineeringFixture(): { repositoryFacts: SourceRepositoryFacts; fileFacts: SourceCodeFileFacts[]; evidence: EvidenceSpan } {
    const packageFacts = createSourceCodeFileFacts({
      path: "package.json",
      mediaType: "application/json",
      text: JSON.stringify({ name: "phase10-fixture", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" }, dependencies: { typescript: "^5.8.0" }, devDependencies: { vitest: "^3.0.0" } }),
      contentHash: "sha256_phase10_pkg",
      parser: { id: "json-manifest-fixture", ok: true, diagnostics: [] },
      packageFacts: {
        name: "phase10-fixture",
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
    const moduleFacts = createSourceCodeFileFacts({
      path: "src/domain.ts",
      mediaType: "text/typescript",
      text: "export function normalizeRecord(value: unknown) { return { value }; }\nexport class PhaseTenPlan {}\n",
      contentHash: "sha256_phase10_domain",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.module", source: "fixture", confidence: 0.86, evidence: ["normalizeRecord"] }],
      declarations: [
        { id: "decl:normalizeRecord", name: "normalizeRecord", kind: "syntax.function", exported: true, defaultExport: false, signature: "export function normalizeRecord(value: unknown)", metadata: {} },
        { id: "decl:PhaseTenPlan", name: "PhaseTenPlan", kind: "syntax.class", exported: true, defaultExport: false, signature: "export class PhaseTenPlan", metadata: {} }
      ],
      exports: [{ id: "export:phase10", exportedNames: ["normalizeRecord", "PhaseTenPlan"], defaultExport: false, metadata: {} }],
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo://phase10-fixture",
      files: [
        { path: "package.json", mediaType: packageFacts.mediaType, byteLength: packageFacts.metrics.bytes, contentHash: packageFacts.contentHash, facts: packageFacts },
        { path: "src/domain.ts", mediaType: moduleFacts.mediaType, byteLength: moduleFacts.metrics.bytes, contentHash: moduleFacts.contentHash, facts: moduleFacts },
        { path: "pnpm-lock.yaml", mediaType: "application/vnd.scce.package-lock", byteLength: 24, contentHash: "sha256_phase10_lock" }
      ],
      hasher
    });
    const source = sourceVersion("repo://phase10-fixture", "phase10 repository", "application/vnd.scce.source-repository");
    const evidence = evidenceSpan(source, "phase10 repository", "direct_evidence");
    const projection = createEngineeringCorpusProjection({
      repositoryFacts,
      fileFacts: [packageFacts, moduleFacts],
      evidenceIds: [evidence.id],
      sourceVersionId: String(source.sourceVersionId),
      hasher
    });
    const projectedEvidence: EvidenceSpan = {
      ...evidence,
      provenance: toJsonValue({ uri: "repo://phase10-fixture", metadata: { engineeringCorpus: projection } }),
      features: ["sym:repository", "sym:program", "sym:artifact"]
    };
    return { repositoryFacts, fileFacts: [packageFacts, moduleFacts], evidence: projectedEvidence };
  }

  function developerSnapshotFixture(): RepoSnapshot {
    const fixtureContext = engineeringFixture();
    return createRepoSnapshot({
      rootUri: "repo://phase10-dev-intel",
      repositoryFacts: fixtureContext.repositoryFacts,
      fileFacts: fixtureContext.fileFacts,
      hasher
    });
  }

  function evidenceForSnapshot(snapshot: RepoSnapshot): EvidenceSpan[] {
    const source = sourceVersion(snapshot.rootUri, "phase10 developer snapshot", "application/vnd.scce.developer-intelligence.snapshot");
    const evidence = evidenceSpan(source, "phase10 developer snapshot", "direct_evidence");
    return [{
      ...evidence,
      provenance: toJsonValue({ uri: snapshot.rootUri, metadata: { developerIntelligence: snapshot } }),
      features: ["sym:repo", "sym:program", "sym:build"]
    }];
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "phase10-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "phase10-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.2,
      createdAt: clock.now()
    };
  }

  function importedMemory(source: SourceVersion, evidence: EvidenceSpan | undefined, importRunId: string) {
    return languageRuntime.hydrateFromImportedBrain({
      importRunId,
      models: [ngramModel()],
      observations: [ngramObservation(source)],
      units: [languageUnit(source)],
      patterns: [languagePattern()],
      semanticFrames: evidence ? [semanticFrame(evidence)] : []
    });
  }

  function ngramModel(): NgramModelRecord {
    return {
      id: "ngram:phase10",
      streamId: "stream:phase10",
      languageHint: "learned:phase10",
      maxOrder: 1,
      discount: 0.75,
      modelJson: {
        sourceSystem: "scce2",
        model: {
          order: 1,
          discount: 0.75,
          symbolCount: 12,
          vocabularySize: 5,
          counts: { "quiet-hours": 4, lighting: 3, cue: 2, glare: 2, "40%": 1 },
          contextCounts: {},
          continuationCounts: {},
          contextContinuationTypes: {},
          totalContinuationTypes: 0,
          unigramCounts: { "quiet-hours": 4, lighting: 3, cue: 2, glare: 2, "40%": 1 },
          totalUnigramCount: 12,
          vocabulary: ["quiet-hours", "lighting", "cue", "glare", "40%"]
        }
      },
      updatedAt: clock.now()
    };
  }

  function ngramObservation(source: SourceVersion): NgramObservation {
    return {
      id: "obs:phase10",
      streamId: "stream:phase10",
      languageHint: "learned:phase10",
      order: 1,
      history: [],
      symbol: "quiet-hours",
      count: 4,
      fieldWeight: 1,
      sourceVersionId: source.sourceVersionId,
      observedAt: clock.now(),
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languageUnit(source: SourceVersion): LanguageUnitRecord {
    return {
      id: "unit:phase10",
      profileId: "profile:phase10",
      sourceVersionId: source.sourceVersionId,
      script: "phase10-script",
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
      id: "pattern:phase10",
      profileId: "profile:phase10",
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
      id: "frame:phase10",
      frameJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", surface: fixture.importedSemanticFrame },
      embedding: [],
      evidenceIds: [evidence.id],
      alpha: 0.96,
      createdAt: clock.now()
    };
  }

  function emptyField(claim: string): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: featureSet(claim, 64),
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
        surfaces: { pressure: 0.2, drift: 0.08, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function forceClass(span: EvidenceSpan): string {
    const trust = objectRecord(span.trustVector);
    return typeof trust.forceClass === "string" ? trust.forceClass : "";
  }

  function outputLooksLikeTelemetry(text: string): boolean {
    const surfaces = ["proofGraph", "validatorVersion", "evidenceIds", "semantic-proof", "walsh.surface_energy", "language-memory-runtime"];
    return surfaces.some(surface => text.includes(surface)) || text.trim().startsWith("{");
  }

  function outputContainsCannedFiller(text: string): boolean {
    const lower = text.toLocaleLowerCase();
    return ["as an ai", "i cannot browse", "i am unable", "i do not have access", "hope this helps", "let me know", "sure,"].some(surface => lower.includes(surface));
  }

  function outputContainsForbiddenRuntimeTerms(text: string): boolean {
    const lower = text.toLocaleLowerCase();
    const terms = [
      `${fromCodes([110, 101, 117, 114, 97, 108])} ${fromCodes([119, 101, 105, 103, 104, 116, 115])}`,
      `${fromCodes([116, 114, 97, 110, 115, 102, 111, 114, 109, 101, 114])} ${fromCodes([119, 101, 105, 103, 104, 116, 115])}`,
      `${fromCodes([109, 111, 100, 101, 108])} ${fromCodes([119, 101, 105, 103, 104, 116, 115])}`,
      `${fromCodes([116, 111, 107, 101, 110])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
      `${fromCodes([99, 111, 110, 116, 101, 120, 116])} window`,
      `${fromCodes([114, 97, 103])} ${fromCodes([98, 117, 100, 103, 101, 116])}`
    ];
    return terms.some(term => lower.includes(term));
  }

  function hasPhraseSalad(text: string): boolean {
    const units = text.split(" ").map(unit => unit.trim()).filter(Boolean);
    if (units.length < 3) return true;
    let repeatedRun = 1;
    for (let index = 1; index < units.length; index++) {
      repeatedRun = units[index]?.toLocaleLowerCase() === units[index - 1]?.toLocaleLowerCase() ? repeatedRun + 1 : 1;
      if (repeatedRun > 2) return true;
    }
    return uniqueStrings(units.map(unit => unit.toLocaleLowerCase())).length / units.length < 0.22;
  }

  function hasRepeatedBoundaryStitching(text: string): boolean {
    return text.includes("::") || text.includes("..") || text.includes("??") || text.includes("!!");
  }

  function sentenceCount(text: string): number {
    let count = 0;
    for (const char of text) if (char === "." || char === "!" || char === "?") count++;
    return Math.max(1, count);
  }

  function surfaceUnitCount(text: string): number {
    return text.split(" ").filter(Boolean).length;
  }

  function detailProfileIdFromTrace(spoken: SpokenOutput): string | undefined {
    const plan = objectRecord(spoken.realizationTrace.surfacePlan);
    return typeof plan.detailProfileId === "string" ? plan.detailProfileId : undefined;
  }

  function objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }

  function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }

  function fromCodes(codes: readonly number[]): string {
    return String.fromCharCode(...codes);
  }

  function hash32(text: string): number {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
});
