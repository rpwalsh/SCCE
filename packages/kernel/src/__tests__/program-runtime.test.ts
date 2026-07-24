import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createEngineeringCorpusProjection,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createEmissionEngine,
  createProgramGraphBuilder,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  featureSet,
  toJsonValue,
  validateProgramHydrationContract,
  type EvidenceSpan,
  type CandidateSurface,
  type FieldState,
  type LanguageProfile,
  type ProgramConstructIntent,
  type ProgramHydrationContract,
  type SemanticEntailmentResult,
  type SourceCodeFileFacts,
  type SourceRepositoryFacts,
  type SourceVersion
} from "../index.js";

describe("ProgramGraph runtime and artifact emission", () => {
  const clock = createClock({ fixedTime: 24000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("uses synthetic package facts for build/test hints, emits CLI/API artifacts, and hydrates records", () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("read stdin accept --value and write stdout command result", [fixture.evidence]);
    const program = required(construct.program);

    expect(program.files.map(file => file.path)).toContain("src/cli.ts");
    expect(program.files.map(file => file.path)).toContain("src/command.ts");
    expect(program.files.map(file => file.path)).toContain("src/api-handler.ts");
    expect(program.files.map(file => file.path)).toContain("test/generated-artifact.test.ts");
    expect(program.build).toEqual({ command: "pnpm", args: ["run", "build"], cwd: "." });
    expect(program.test).toEqual({ command: "pnpm", args: ["run", "test"], cwd: "." });

    const hydration = required(program.hydration);
    expect(validateProgramHydrationContract(hydration)).toEqual({ valid: true, diagnostics: [] });
    expect(hydration.program.entrypointPath).toBe("src/cli.ts");
    expect(hydration.program.provenanceEvidenceIds).toContain(String(fixture.evidence.id));
    expect(hydration.files.find(file => file.path === "src/cli.ts")?.entrypoint).toBe(true);
    expect(hydration.files.find(file => file.path === "src/cli.ts")?.imports).toContain("./command.js");
    expect(hydration.files.find(file => file.path === "src/command.ts")?.exports).toContain("runCommand");
    expect(hydration.files.find(file => file.path === "src/api-handler.ts")?.exports).toContain("handleRequest");
    expect(hydration.emissions.map(record => record.filePath)).toContain("src/cli.ts");
    expect(hydration.validations[0]?.command.command).toBe("pnpm");
    expect(hydration.validations[0]?.commandSource).toBe("program.validation.command.observed");
    expect(hydration.validations[1]?.commandSource).toBe("program.validation.command.observed");
    expect(hydration.validations[1]?.expectedFiles).toContain("test/generated-artifact.test.ts");
  });

  it("prefers ProgramConstruct intent and engineering corpus facts over request text keywords", () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("please handle this artifact", [fixture.evidence], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      inputMediaTypes: ["text/plain"],
      outputMediaTypes: ["application/json"],
      provenanceEvidenceIds: [String(fixture.evidence.id)]
    });
    const program = required(construct.program);
    const shape = required(program.nodes.find(node => node.id === "program-shape"));
    const target = objectRecord(objectRecord(shape.metadata).target);
    const targetEvidence = JSON.stringify(target.evidence ?? {});

    expect(program.files.map(file => file.path)).toContain("src/cli.ts");
    expect(program.entrypoint).toBe("src/cli.ts");
    expect(program.build).toEqual({ command: "pnpm", args: ["run", "build"], cwd: "." });
    expect(targetEvidence).toContain("constructIntent");
    expect(targetEvidence).toContain(String(fixture.evidence.id));
  });

  it("emits a CSV transformer with source metadata and a validation contract", () => {
    const fixture = engineeringFixture();
    const csv = csvEvidence();
    const construct = buildProgram("build a csv transformer that reads tabular input and emits normalized json", [fixture.evidence, csv]);
    const program = required(construct.program);

    expect(program.files.map(file => file.path)).toContain("src/transform.ts");
    expect(program.files.map(file => file.path)).toContain("schema.mapping.json");
    expect(program.files.map(file => file.path)).toContain("test/generated-artifact.test.ts");
    expect(program.entrypoint).toBe("src/transform.ts");

    const transform = required(program.files.find(file => file.path === "src/transform.ts"));
    expect(transform.content).toContain("export function parseInput");
    expect(transform.content).toContain("export function transform");
    expect(program.hydration?.files.find(file => file.path === "src/transform.ts")?.exports).toEqual(expect.arrayContaining(["parseInput", "transform", "validate"]));
    expect(validateProgramHydrationContract(required(program.hydration)).valid).toBe(true);
  });

  it("does not invent package commands without package evidence", () => {
    const csv = csvEvidence();
    const construct = buildProgram("build a csv transformer that emits json", [csv]);
    const program = required(construct.program);

    expect(program.build.command).toBe("source-derived");
    expect(program.test.command).toBe("source-derived");
    expect(program.hydration?.validations.every(record => record.commandSource === "program.validation.command.source_derived")).toBe(true);
    expect(program.files.map(file => file.path)).not.toContain("package.json");
    expect(program.nodes.find(node => node.id === "program-hydration")).toBeTruthy();
  });

  it("emits a log parser when line-shaped diagnostic evidence is present", () => {
    const fixture = engineeringFixture();
    const log = logEvidence();
    const construct = buildProgram("parse the .log input and summarize component status diagnostics", [fixture.evidence, log]);
    const program = required(construct.program);

    expect(program.files.map(file => file.path)).toContain("src/log-parser.ts");
    expect(program.entrypoint).toBe("src/log-parser.ts");
    expect(program.hydration?.files.find(file => file.path === "src/log-parser.ts")?.exports).toEqual(expect.arrayContaining(["parseLogLine", "parseLogText"]));
  });

  it("Mouth exposes ProgramGraph artifact metadata through the surface plan", async () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("please handle this artifact", [fixture.evidence], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      inputMediaTypes: ["text/plain"],
      outputMediaTypes: ["application/json"],
      provenanceEvidenceIds: [String(fixture.evidence.id)]
    });
    const program = required(construct.program);
    const source = sourceVersion("repo://phase6-program");
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const selectedCandidate: CandidateSurface = {
      id: "workspace-plan:fixture",
      kind: "workspace-proposal",
      answer: "",
      force: "conjectured",
      evidenceIds: [],
      scores: {
        support: 1,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.8,
        evidenceCoverage: 1,
        novelty: 0.2,
        realizability: 0.9,
        risk: 0
      },
      claimBases: ["conjectured"],
      boundaries: ["workspace-plan-not-authorized", "workspace-plan-not-executed"],
      audit: {
        authorizationGranted: false,
        executionState: "not_executed"
      }
    };

    const spoken = await mouth.speak({
      construct,
      field: emptyField(),
      languageProfile: languageProfile(source),
      evidence: [fixture.evidence],
      entailment: entailmentFor(fixture.evidence),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "program-runtime", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language",
      requestedAuthority: "program",
      selectedCandidate
    });

    const planText = JSON.stringify(spoken.surfacePlan.orderedPoints.map(point => point.proposition));
    const planConstraints = JSON.stringify(spoken.surfacePlan.orderedPoints.map(point => point.realizationConstraints));
    expect(planConstraints).toContain(program.id);
    expect(planConstraints).toContain("scce.program.hydration.v1");
    expect(planText).toContain("src/cli.ts");
    expect(planText).toContain("pnpm run build");
    expect(planText).not.toContain("validated program graph");
    expect(planText).not.toContain("unvalidated program graph");
    expect(planText).not.toContain("scce.program.hydration.v1");
    expect(planText).not.toContain("program.entrypoint=");
    expect(planText).not.toContain("program.validation.observed=");
    expect(planText).not.toContain("entrypoint:");
    expect(planText).not.toContain("source files:");
    expect(planText).not.toContain("validation observed commands:");
    expect(planText).not.toContain("hydration contract:");
    expect(spoken.text).toContain("src/cli.ts");
    expect(spoken.text).toContain("pnpm run build");
    expect(spoken.text).not.toContain("please handle this artifact");
    expect(spoken.text).not.toMatch(/\b(?:applied|authorized|executed|completed)\b/iu);
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:construct-anchored");

    const programPoint = required(spoken.surfacePlan.orderedPoints.find(point => JSON.stringify(point.realizationConstraints).includes("programSurface")));
    const programSurface = objectRecord(objectRecord(programPoint.realizationConstraints).programSurface);
    expect(programSurface.entrypoint).toBe("src/cli.ts");
    expect(programSurface.hydrationSchema).toBe("scce.program.hydration.v1");
    expect(JSON.stringify(programSurface.observedValidation)).toContain("pnpm run build");
    expect(programSurface.fileCount).toBe(program.files.length);
  });

  it("Mouth preserves the selected non-executing workspace patch plan instead of narrating workspace evidence", async () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("please handle this artifact", [fixture.evidence], {
      artifactKindIds: ["artifact.cli"],
      capabilityIds: ["capability:command-runtime"],
      inputMediaTypes: ["text/plain"],
      outputMediaTypes: ["application/json"],
      provenanceEvidenceIds: [String(fixture.evidence.id)]
    });
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const exactPlanSurface = "```json\n{\n  \"planHash\": \"sha256:fixture\"\n}\n```\n\n`src/index.ts`\n\n```\nexport const value = count;\n```";
    const selectedCandidate: CandidateSurface = {
      id: "workspace-plan:sha256:fixture:0",
      kind: "workspace-proposal",
      answer: exactPlanSurface,
      force: "conjectured",
      evidenceIds: [],
      scores: {
        support: 1,
        contradiction: 0,
        faithfulness: 1,
        alphaPressure: 0.5,
        actionability: 0.8,
        evidenceCoverage: 1,
        novelty: 0.2,
        realizability: 0.9,
        risk: 0
      },
      claimBases: ["conjectured"],
      boundaries: ["workspace-plan-not-authorized", "workspace-plan-not-executed"],
      audit: {
        source: "workspace.patch_transaction_plan",
        planHash: "sha256:fixture",
        operations: [{ kind: "replace", path: "src/index.ts" }],
        authorizationGranted: false,
        executionState: "not_executed"
      }
    };

    const spoken = await mouth.speak({
      construct,
      field: emptyField(),
      languageProfile: languageProfile(sourceVersion("repo://workspace-plan-surface")),
      evidence: [fixture.evidence],
      entailment: entailmentFor(fixture.evidence),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "workspace-plan-surface", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language",
      requestedAuthority: "program",
      selectedCandidate
    });

    expect(spoken.text).toBe(exactPlanSurface);
    expect(spoken.text).toContain("export const value = count;");
    expect(spoken.text).not.toContain("pnpm run build");
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:construct-anchored");
  });

  it("rejects incomplete ProgramGraph hydration contracts", () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("read stdin accept --value and write stdout command result", [fixture.evidence]);
    const hydration = required(required(construct.program).hydration);
    const incomplete: ProgramHydrationContract = {
      ...hydration,
      program: { ...hydration.program, entrypointPath: "", provenanceEvidenceIds: [] },
      validations: [],
      emissions: [],
      valid: true,
      diagnostics: []
    };
    const validation = validateProgramHydrationContract(incomplete);

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toEqual(expect.arrayContaining([
      "program.hydration.entrypoint_path",
      "program.hydration.program_provenance",
      "program.hydration.validations",
      "program.hydration.emissions",
      "program.hydration.emission_file_count"
    ]));
  });

  it("keeps failed artifact validation internal to the emission contract", () => {
    const fixture = engineeringFixture();
    const construct = buildProgram("read stdin accept --value and write stdout command result", [fixture.evidence]);
    const entailment = entailmentFor(fixture.evidence);
    const answer = "fixture.release.surface";
    const emission = createEmissionEngine({ idFactory: ids }).emit({
      construct,
      validation: {
        id: ids.validationId({ constructId: construct.id, checks: [["fixture", "failed"]] }),
        constructId: construct.id,
        checks: [{ id: "fixture", status: "failed", score: 0, message: "fixture.validation", evidenceIds: [] }],
        passed: false
      },
      entailment,
      answer
    });

    expect(emission.answer).toBe(answer);
    expect(emission.artifacts).toEqual([]);
  });

  function buildProgram(text: string, evidence: EvidenceSpan[], programIntent?: ProgramConstructIntent) {
    return createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text,
      createdAt: clock.now(),
      evidence,
      entailment: entailmentFor(evidence[0] ?? csvEvidence()),
      programIntent
    });
  }

  function engineeringFixture(): { repositoryFacts: SourceRepositoryFacts; fileFacts: SourceCodeFileFacts[]; evidence: EvidenceSpan } {
    const packageFacts = createSourceCodeFileFacts({
      path: "package.json",
      mediaType: "application/json",
      text: JSON.stringify({
        name: "phase6-fixture",
        scripts: { build: "tsc -p tsconfig.json", test: "vitest run", dev: "node src/server.ts" },
        dependencies: { typescript: "^5.5.0" },
        devDependencies: { vitest: "^2.0.0" }
      }),
      contentHash: "sha256_phase6_pkg",
      parser: { id: "json-manifest-fixture", ok: true, diagnostics: [] },
      packageFacts: {
        name: "phase6-fixture",
        version: "1.0.0",
        scripts: [
          { name: "build", command: "tsc -p tsconfig.json", roleEvidence: [{ roleId: "source.role.build", source: "fixture", confidence: 0.95, evidence: ["build"] }] },
          { name: "test", command: "vitest run", roleEvidence: [{ roleId: "source.role.validation", source: "fixture", confidence: 0.95, evidence: ["test"] }] },
          { name: "dev", command: "node src/server.ts", roleEvidence: [{ roleId: "source.role.runtime", source: "fixture", confidence: 0.7, evidence: ["dev"] }] }
        ],
        dependencies: [
          { name: "typescript", scope: "development", version: "^5.5.0" },
          { name: "vitest", scope: "development", version: "^2.0.0" }
        ]
      },
      hasher
    });
    const moduleFacts = createSourceCodeFileFacts({
      path: "src/domain.ts",
      mediaType: "text/typescript",
      text: "export function normalizeRecord(value: unknown) { return { value }; }\nexport class DomainPlan {}\n",
      contentHash: "sha256_phase6_domain",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.module", source: "fixture", confidence: 0.86, evidence: ["normalizeRecord"] }],
      declarations: [
        { id: "decl:normalizeRecord", name: "normalizeRecord", kind: "function", exported: true, defaultExport: false, signature: "export function normalizeRecord(value: unknown)", metadata: {} },
        { id: "decl:DomainPlan", name: "DomainPlan", kind: "class", exported: true, defaultExport: false, signature: "export class DomainPlan", metadata: {} }
      ],
      exports: [{ id: "export:normalizeRecord", exportedNames: ["normalizeRecord", "DomainPlan"], defaultExport: false, metadata: {} }],
      hasher
    });
    const apiFacts = createSourceCodeFileFacts({
      path: "src/server.ts",
      mediaType: "text/typescript",
      text: "export function handler() { return { ok: true }; }\nrouter.get('/api/records', handler);\n",
      contentHash: "sha256_phase6_server",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.interface", source: "fixture", confidence: 0.9, evidence: ["/api/records"] }],
      declarations: [{ id: "decl:handler", name: "handler", kind: "function", exported: true, defaultExport: false, signature: "export function handler()", metadata: {} }],
      routes: [{ id: "route:records", protocol: "http", method: "GET", path: "/api/records", handlerHint: "handler", metadata: {} }],
      hasher
    });
    const testFacts = createSourceCodeFileFacts({
      path: "src/domain.test.ts",
      mediaType: "text/typescript",
      text: "import { test } from 'vitest';\ntest('normalizes record', () => true);\n",
      contentHash: "sha256_phase6_test",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.test", source: "fixture", confidence: 0.9, evidence: ["domain.test.ts"] }],
      imports: [{ id: "import:vitest", moduleSpecifier: "vitest", importedNames: ["test"], typeOnly: false, metadata: {} }],
      tests: [{ id: "test:normalize", name: "normalizes record", runnerHint: "test", metadata: {} }],
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo://phase6-fixture",
      files: [
        { path: "package.json", mediaType: packageFacts.mediaType, byteLength: packageFacts.metrics.bytes, contentHash: packageFacts.contentHash, facts: packageFacts },
        { path: "src/domain.ts", mediaType: moduleFacts.mediaType, byteLength: moduleFacts.metrics.bytes, contentHash: moduleFacts.contentHash, facts: moduleFacts },
        { path: "src/server.ts", mediaType: apiFacts.mediaType, byteLength: apiFacts.metrics.bytes, contentHash: apiFacts.contentHash, facts: apiFacts },
        { path: "src/domain.test.ts", mediaType: testFacts.mediaType, byteLength: testFacts.metrics.bytes, contentHash: testFacts.contentHash, facts: testFacts },
        { path: "pnpm-lock.yaml", mediaType: "text/yaml", byteLength: 24, contentHash: "sha256_phase6_lock" }
      ],
      hasher
    });
    const source = sourceVersion("repo://phase6-fixture");
    const evidenceId = ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: 16, spanHash: ids.contentHash("phase6-fixture") });
    const projection = createEngineeringCorpusProjection({
      repositoryFacts,
      fileFacts: [packageFacts, moduleFacts, apiFacts, testFacts],
      evidenceIds: [evidenceId],
      sourceVersionId: String(source.sourceVersionId),
      hasher
    });
    const evidence: EvidenceSpan = {
      id: evidenceId,
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: 16, chunkHash: ids.contentHash("phase6-fixture") }),
      contentHash: ids.contentHash("phase6-fixture"),
      mediaType: "application/vnd.scce.source-repository",
      byteStart: 0,
      byteEnd: 16,
      charStart: 0,
      charEnd: 16,
      text: "phase6 repository",
      textPreview: "phase6 repository",
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri: "repo://phase6-fixture", metadata: { engineeringCorpus: projection } }),
      features: ["sym:repository", "sym:program", "sym:artifact"],
      status: "promoted",
      alpha: 1,
      observedAt: clock.now()
    };
    return { repositoryFacts, fileFacts: [packageFacts, moduleFacts, apiFacts, testFacts], evidence };
  }

  function csvEvidence(): EvidenceSpan {
    return evidenceSpan("file://fixture/records.csv", "text/csv", "id,value,status\nA,42,ok\nB,17,hold\n");
  }

  function logEvidence(): EvidenceSpan {
    return evidenceSpan("file://fixture/worker.log", "text/plain+log", "2026-06-27T10:00:00Z level=info component=worker status=ok started\n2026-06-27T10:00:01Z level=error component=worker status=retry failed\n");
  }

  function evidenceSpan(uri: string, mediaType: string, text: string): EvidenceSpan {
    const source = sourceVersion(uri, mediaType);
    const bytes = Buffer.from(text);
    const contentHash = ids.contentHash(bytes);
    return {
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      contentHash,
      mediaType,
      byteStart: 0,
      byteEnd: bytes.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri }),
      features: featureSet(text, 128),
      status: "promoted",
      alpha: 0.9,
      observedAt: clock.now()
    };
  }

  function sourceVersion(uri: string, mediaType = "text/plain"): SourceVersion {
    const bytes = Buffer.from(uri);
    return {
      sourceId: ids.sourceId("program-runtime", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType,
      observedAt: clock.now(),
      byteLength: bytes.length,
      sourceTrust: { identity: 0.9, integrity: 0.9, parserReliability: 0.9, directness: 0.9, authority: 0.9, freshness: 0.9, independenceGroup: "fixture:program-runtime", accessScope: "fixture", licenseStatus: "fixture" },
      metadata: {}
    };
  }

  function entailmentFor(evidence: EvidenceSpan): SemanticEntailmentResult {
    return {
      claim: { id: ids.claimId("phase6 program request"), text: "phase6 program request", normalized: "phase6 program request", features: ["sym:program"], polarity: 1 },
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "inferred",
      support: 0.66,
      contradiction: 0,
      faithfulnessLcb: 0.44,
      confidence: { verdict: "underdetermined", support: 0.66, contradiction: 0, faithfulnessLcb: 0.44, supportingEvidence: 1, sourceVersions: [String(evidence.sourceVersionId)], structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.5, causalMass: 0.1, stability: 0.82, satisfiedObligations: 0, requiredObligations: 0 },
      scores: { structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.5, causalMass: 0.1, faithfulnessLCB: 0.44, contradiction: 0, stability: 0.82 },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [evidence.id],
      boundaries: [],
      proof: {
        id: ids.proofId({ claimId: ids.claimId("phase6 program request"), evidenceIds: [evidence.id], transforms: ["program-runtime"], validatorVersion: "fixture" }),
        claimId: ids.claimId("phase6 program request"),
        verdict: "inferred",
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds: [evidence.id],
        transformIds: [],
        scores: {},
        validatorVersion: "fixture",
        createdAt: clock.now()
      }
    };
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "fixture-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "fixture-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.1,
      createdAt: clock.now()
    };
  }

  function emptyField(): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: [],
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
        surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }

  function objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
});
