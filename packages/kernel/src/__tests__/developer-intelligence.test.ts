import { describe, expect, it } from "vitest";
import {
  codeClaimToProofClaim,
  codeFactToProofEvidence,
  createClock,
  createHasher,
  createIdFactory,
  createProgramGraphBuilder,
  createRepoSnapshot,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  diagnosticsToProgramValidationInput,
  proveClaim,
  repoSnapshotToEngineeringContext,
  toJsonValue,
  validateDeveloperIntelligenceHydrationContract,
  type EvidenceSpan,
  type RepoSnapshot,
  type SemanticEntailmentResult,
  type SourceCodeFileFacts,
  type SourceRepositoryFacts,
  type SourceVersion
} from "../index.js";

describe("Developer Intelligence kernel runtime", () => {
  const clock = createClock({ fixedTime: 31000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "developer-intelligence-test" });

  it("creates repo snapshot graphs, source spans, hydration records, and proof-ready code facts", () => {
    const fixture = repoFixture();
    const snapshot = createRepoSnapshot({
      rootUri: "repo://phase9-fixture",
      repositoryFacts: fixture.repositoryFacts,
      fileFacts: fixture.fileFacts,
      hasher
    });

    expect(snapshot.schema).toBe("scce.developer-intelligence.snapshot.v1");
    expect(snapshot.summary.fileCount).toBeGreaterThanOrEqual(5);
    expect(snapshot.summary.sourceFileCount).toBeGreaterThanOrEqual(4);
    expect(snapshot.summary.symbolCount).toBeGreaterThanOrEqual(4);
    expect(snapshot.summary.importCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.exportCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.dependencyCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.summary.packageScriptCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.summary.buildCommandCount).toBe(1);
    expect(snapshot.summary.testCommandCount).toBe(1);
    expect(snapshot.evidenceSpans.some(span => span.sourcePath === "README.md" && span.proofEligibility === "code.proof.direct_source_span")).toBe(true);
    expect(snapshot.codeFacts.some(fact => fact.relationId === "repo.fact.package_has_test_script" && fact.objectId === "test")).toBe(true);

    const hydration = validateDeveloperIntelligenceHydrationContract(snapshot.hydration);
    expect(hydration).toEqual({ valid: true, diagnostics: [] });
    expect(snapshot.hydration.files.length).toBe(snapshot.files.length);
    expect(snapshot.hydration.symbols.length).toBe(snapshot.symbolGraph.nodes.length);
    expect(snapshot.hydration.dependencies.length).toBe(snapshot.dependencyGraph.dependencies.length);
  });

  it("certifies direct source-span code facts and blocks learned program priors", () => {
    const snapshot = snapshotFixture();
    const exportedFact = required(snapshot.codeFacts.find(fact => fact.relationId === "repo.fact.file_exports_symbol" && fact.objectId.endsWith("#normalizeRecord") && fact.forceClass === "direct_evidence"));
    const claim = codeClaimToProofClaim({
      id: "claim.normalize-export",
      subjectId: exportedFact.subjectId,
      relationId: exportedFact.relationId,
      objectId: exportedFact.objectId,
      sourcePath: exportedFact.sourcePath,
      sourceHash: exportedFact.sourceHash,
      languageId: exportedFact.languageId,
      requiredSourceBinding: true
    });
    const certified = proveClaim({ claim, candidateEvidence: [codeFactToProofEvidence(exportedFact)] });
    expect(certified.verdict).toBe("certified");
    expect(certified.certifiedEvidenceIds).toContain(exportedFact.id);

    const learnedPrior = { ...exportedFact, id: "fact.learned-prior-only", forceClass: "learned_program_prior" as const, evidenceSpan: undefined };
    const unsupported = proveClaim({ claim, candidateEvidence: [codeFactToProofEvidence(learnedPrior)] });
    expect(unsupported.verdict).toBe("unsupported_prior_only");
    expect(unsupported.certifiedEvidenceIds).toEqual([]);
  });

  it("exposes diagnostics as validation input without turning observed severity into control values", () => {
    const snapshot = snapshotFixture();
    const diagnostics = diagnosticsToProgramValidationInput(snapshot.diagnosticsGraph.diagnostics);

    expect(diagnostics.diagnostics.length).toBe(1);
    expect(diagnostics.diagnostics[0]?.severityId).toBe("diagnostic.severity.observed.error");
    expect(diagnostics.diagnostics[0]?.message).toContain("Type mismatch");
    expect(diagnostics.riskIds).toContain("diagnostic.kind.compiler");
  });

  it("feeds ProgramGraph through Developer Intelligence metadata and uses observed build/test commands", () => {
    const snapshot = snapshotFixture();
    const evidence = evidenceForSnapshot(snapshot);
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text: "make a small command artifact from the observed repo context",
      createdAt: clock.now(),
      entailment: entailmentFor(evidence),
      evidence,
      programIntent: {
        artifactKindIds: ["artifact.cli"],
        capabilityIds: ["capability:command-runtime"],
        provenanceEvidenceIds: [String(evidence[0]?.id)]
      }
    });
    const program = required(construct.program);

    expect(program.build).toEqual({ command: "pnpm", args: ["run", "build"], cwd: "." });
    expect(program.test).toEqual({ command: "pnpm", args: ["run", "test"], cwd: "." });
    expect(program.packageManager).toBe("pnpm");
    expect(program.hydration?.validations.every(record => record.commandSource === "program.validation.command.observed")).toBe(true);

    const context = repoSnapshotToEngineeringContext(snapshot);
    expect(context.summary.symbolCount).toBeGreaterThanOrEqual(4);
    expect(context.plannerHints.buildCommands[0]?.scriptName).toBe("build");
    expect(context.plannerHints.validationCommands[0]?.scriptName).toBe("test");
  });

  it("emits scoreTrace on snapshot files and evidence spans (PR-8 code intelligence trace)", () => {
    const snapshot = snapshotFixture();
    const filesWithTrace = snapshot.files.filter(f => Array.isArray(f.scoreTrace) && f.scoreTrace.length > 0);
    expect(filesWithTrace.length).toBeGreaterThan(0);
    const spansWithTrace = snapshot.evidenceSpans.filter(s => Array.isArray(s.scoreTrace) && s.scoreTrace.length > 0);
    expect(spansWithTrace.length).toBeGreaterThan(0);
    for (const span of spansWithTrace) {
      expect(span.scoreTrace!.every(t => typeof t.kind === "string" && typeof t.value === "number")).toBe(true);
    }
  });

  function snapshotFixture(): RepoSnapshot {
    const fixture = repoFixture();
    const diagnostic = {
      id: "diagnostic.fixture",
      kind: "diagnostic" as const,
      diagnosticKindId: "diagnostic.kind.compiler",
      sourcePath: "src/domain.ts",
      sourceHash: "sha256_domain",
      languageId: "parser:typescript-compiler-api",
      provenance: { source: "fixture", rootUri: "repo://phase9-fixture", sourcePath: "src/domain.ts", sourceHash: "sha256_domain", observedFrom: ["diagnostic.fixture"] },
      confidence: 0.8,
      graphIntent: "graph.diagnostic" as const,
      proofEligibility: "code.proof.source_bound_only" as const,
      hydration: { recordType: "DiagnosticRecord", dryRunDestination: "postgres.diagnostics", inspectPath: "repo.diagnostics.src/domain.ts" },
      severityId: "diagnostic.severity.observed.error",
      observedSeverity: "error",
      diagnosticCode: "TS2322",
      message: "Type mismatch in fixture",
      line: 4,
      column: 11
    };
    return createRepoSnapshot({
      rootUri: "repo://phase9-fixture",
      repositoryFacts: fixture.repositoryFacts,
      fileFacts: fixture.fileFacts,
      diagnostics: [diagnostic],
      hasher
    });
  }

  function repoFixture(): { repositoryFacts: SourceRepositoryFacts; fileFacts: SourceCodeFileFacts[] } {
    const packageFacts = createSourceCodeFileFacts({
      path: "package.json",
      mediaType: "application/json",
      text: JSON.stringify({ name: "phase9-fixture", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" }, dependencies: { "@example/runtime": "^1.0.0" }, devDependencies: { vitest: "^3.0.0", typescript: "^5.8.0" } }),
      contentHash: "sha256_package",
      parser: { id: "json-manifest-fixture", ok: true, diagnostics: [] },
      packageFacts: {
        name: "phase9-fixture",
        scripts: [
          { name: "build", command: "tsc -p tsconfig.json", roleEvidence: [{ roleId: "source.role.build", source: "fixture", confidence: 0.95, evidence: ["build"] }] },
          { name: "test", command: "vitest run", roleEvidence: [{ roleId: "source.role.validation", source: "fixture", confidence: 0.95, evidence: ["test"] }] }
        ],
        dependencies: [
          { name: "@example/runtime", scope: "dependencies", version: "^1.0.0" },
          { name: "vitest", scope: "devDependencies", version: "^3.0.0" },
          { name: "typescript", scope: "devDependencies", version: "^5.8.0" }
        ]
      },
      hasher
    });
    const domainFacts = createSourceCodeFileFacts({
      path: "src/domain.ts",
      mediaType: "text/typescript",
      text: "export interface Row { value: string }\nexport type RowId = string;\nexport class DomainPlan {}\nexport function normalizeRecord(row: Row) { return row.value.trim(); }\n",
      contentHash: "sha256_domain",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.module", source: "fixture", confidence: 0.9, evidence: ["normalizeRecord"] }],
      declarations: [
        { id: "decl:Row", name: "Row", kind: "syntax.interface", exported: true, defaultExport: false, span: { charStart: 0, charEnd: 36, lineStart: 1, lineEnd: 1 }, signature: "export interface Row { value: string }", metadata: {} },
        { id: "decl:RowId", name: "RowId", kind: "syntax.type-alias", exported: true, defaultExport: false, span: { charStart: 37, charEnd: 64, lineStart: 2, lineEnd: 2 }, signature: "export type RowId = string", metadata: {} },
        { id: "decl:DomainPlan", name: "DomainPlan", kind: "syntax.class", exported: true, defaultExport: false, span: { charStart: 65, charEnd: 91, lineStart: 3, lineEnd: 3 }, signature: "export class DomainPlan {}", metadata: {} },
        { id: "decl:normalizeRecord", name: "normalizeRecord", kind: "syntax.function", exported: true, defaultExport: false, span: { charStart: 92, charEnd: 154, lineStart: 4, lineEnd: 4 }, signature: "export function normalizeRecord(row: Row)", metadata: {} }
      ],
      imports: [{ id: "import:runtime", moduleSpecifier: "@example/runtime", importedNames: ["createRuntime"], typeOnly: false, span: { charStart: 0, charEnd: 1, lineStart: 1, lineEnd: 1 }, metadata: {} }],
      exports: [{ id: "export:domain", exportedNames: ["Row", "RowId", "DomainPlan", "normalizeRecord"], defaultExport: false, span: { charStart: 0, charEnd: 154, lineStart: 1, lineEnd: 4 }, metadata: {} }],
      hasher
    });
    const testFacts = createSourceCodeFileFacts({
      path: "src/domain.test.ts",
      mediaType: "text/typescript",
      text: "import { test } from 'vitest';\ntest('normalizes record', () => true);\n",
      contentHash: "sha256_test",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.test", source: "fixture", confidence: 0.9, evidence: ["domain.test.ts"] }],
      imports: [{ id: "import:vitest", moduleSpecifier: "vitest", importedNames: ["test"], typeOnly: false, span: { charStart: 0, charEnd: 29, lineStart: 1, lineEnd: 1 }, metadata: {} }],
      tests: [{ id: "test:normalizes", name: "normalizes record", runnerHint: "test", span: { charStart: 30, charEnd: 68, lineStart: 2, lineEnd: 2 }, metadata: {} }],
      hasher
    });
    const readmeFacts = createSourceCodeFileFacts({
      path: "README.md",
      mediaType: "text/markdown",
      text: "# Phase 9 Fixture\n\nThis fixture documents the repository surface.\n",
      contentHash: "sha256_readme",
      parser: { id: "documentation-evidence", ok: true, diagnostics: [] },
      roleEvidence: [{ roleId: "source.role.documentation", source: "fixture", confidence: 0.95, evidence: ["README.md"] }],
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo://phase9-fixture",
      files: [
        { path: "package.json", mediaType: packageFacts.mediaType, byteLength: packageFacts.metrics.bytes, contentHash: packageFacts.contentHash, facts: packageFacts },
        { path: "src/domain.ts", mediaType: domainFacts.mediaType, byteLength: domainFacts.metrics.bytes, contentHash: domainFacts.contentHash, facts: domainFacts },
        { path: "src/domain.test.ts", mediaType: testFacts.mediaType, byteLength: testFacts.metrics.bytes, contentHash: testFacts.contentHash, facts: testFacts },
        { path: "README.md", mediaType: readmeFacts.mediaType, byteLength: readmeFacts.metrics.bytes, contentHash: readmeFacts.contentHash, facts: readmeFacts },
        { path: "pnpm-lock.yaml", mediaType: "application/vnd.scce.package-lock", byteLength: 24, contentHash: "sha256_lock" }
      ],
      hasher
    });
    return { repositoryFacts, fileFacts: [packageFacts, domainFacts, testFacts, readmeFacts] };
  }

  function evidenceForSnapshot(snapshot: RepoSnapshot): EvidenceSpan[] {
    const source = sourceVersion(snapshot.rootUri);
    return [{
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: 16, spanHash: ids.contentHash("phase9-snapshot") }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: 16, chunkHash: ids.contentHash("phase9-snapshot") }),
      contentHash: ids.contentHash("phase9-snapshot"),
      mediaType: "application/vnd.scce.developer-intelligence.snapshot",
      byteStart: 0,
      byteEnd: 16,
      charStart: 0,
      charEnd: 16,
      text: "phase9 snapshot",
      textPreview: "phase9 snapshot",
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri: snapshot.rootUri, metadata: { developerIntelligence: snapshot } }),
      features: ["sym:repo", "sym:program", "sym:build"],
      status: "promoted",
      alpha: 1,
      observedAt: clock.now()
    }];
  }

  function sourceVersion(uri: string): SourceVersion {
    const bytes = Buffer.from(uri);
    return {
      sourceId: ids.sourceId("developer-intelligence", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "application/vnd.scce.developer-intelligence.snapshot",
      observedAt: clock.now(),
      byteLength: bytes.length,
      trust: 0.9,
      metadata: {}
    };
  }

  function entailmentFor(evidence: EvidenceSpan[]): SemanticEntailmentResult {
    const first = required(evidence[0]);
    return {
      claim: { id: ids.claimId("phase9 program request"), text: "phase9 program request", normalized: "phase9 program request", features: ["sym:program"], polarity: 1 },
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "inferred",
      support: 0.68,
      contradiction: 0,
      faithfulnessLcb: 0.46,
      confidence: { verdict: "underdetermined", support: 0.68, contradiction: 0, faithfulnessLcb: 0.46, supportingEvidence: 1, sourceVersions: [String(first.sourceVersionId)], structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.5, causalMass: 0.1, stability: 0.82, satisfiedObligations: 0, requiredObligations: 0 },
      scores: { structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.5, causalMass: 0.1, faithfulnessLCB: 0.46, contradiction: 0, stability: 0.82 },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [first.id],
      boundaries: [],
      proof: {
        id: ids.proofId({ claimId: ids.claimId("phase9 program request"), evidenceIds: [first.id], transforms: ["developer-intelligence"], validatorVersion: "fixture" }),
        claimId: ids.claimId("phase9 program request"),
        verdict: "inferred",
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds: [first.id],
        transformIds: [],
        scores: {},
        validatorVersion: "fixture",
        createdAt: clock.now()
      }
    };
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }
});
