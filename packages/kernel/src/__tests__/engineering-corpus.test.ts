import { describe, expect, it } from "vitest";
import {
  createClock,
  createCodeLearningEngine,
  createEngineeringCorpusProjection,
  createEngineeringCorpusRuntime,
  createHasher,
  createIdFactory,
  createProgramPlanner,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  createTypedIngestProjector,
  toJsonValue,
  type EvidenceSpan,
  type SemanticEntailmentResult,
  type SourceCodeFileFacts,
  type SourceRepositoryFacts
} from "../index.js";

describe("engineering corpus projection", () => {
  const clock = createClock({ fixedTime: 12000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("projects repository source facts into planner-ready commands, dependencies, symbols, routes, tests, and graph material", () => {
    const fixture = engineeringFixture();
    const projection = createEngineeringCorpusProjection({
      repositoryFacts: fixture.repositoryFacts,
      fileFacts: fixture.fileFacts,
      evidenceIds: [fixture.evidence.id],
      sourceVersionId: String(fixture.evidence.sourceVersionId),
      hasher
    });

    expect(projection.schema).toBe("scce.engineering-corpus.v1");
    expect(projection.summary.fileCount).toBeGreaterThanOrEqual(3);
    expect(projection.summary.commandCount).toBeGreaterThanOrEqual(3);
    expect(projection.summary.symbolCount).toBeGreaterThan(0);
    expect(projection.summary.routeCount).toBeGreaterThan(0);
    expect(projection.summary.testCount).toBeGreaterThan(0);
    expect(projection.summary.plannerReadiness).toBeGreaterThan(0.55);
    expect(projection.commands.map(command => command.kind)).toContain("eng.command.build");
    expect(projection.commands.map(command => command.kind)).toContain("eng.command.validation");
    expect(projection.dependencies.map(dep => dep.name)).toContain("vite");
    expect(projection.dependencies.map(dep => dep.name)).toContain("react");
    expect(projection.symbols.map(symbol => symbol.name)).toContain("createWorkbench");
    expect(projection.routes.map(route => route.path)).toContain("/api/plan");
    expect(projection.tests.map(test => test.runnerHint)).toContain("test");
    expect(projection.capabilities.map(capability => capability.kind)).toContain("eng.capability.module_authoring");
    expect(projection.capabilities.map(capability => capability.kind)).toContain("eng.capability.validation");
    expect(projection.plannerHints.primaryLanguages.length).toBeGreaterThan(0);
    expect(projection.plannerHints.buildCommands[0]?.scriptName).toBe("build");
    expect(projection.plannerHints.validationCommands[0]?.scriptName).toBe("test");
    expect(projection.graph.nodes.some(node => node.kind === "eng.command_candidate")).toBe(true);
    expect(projection.graph.edges.some(edge => edge.relation === "eng.repository_supports_capability")).toBe(true);

    const runtime = createEngineeringCorpusRuntime([projection]);
    expect(runtime.packageManagers()[0]).toBe("pnpm");
    expect(runtime.rankCommands({ preferredKinds: ["script.build"], limit: 1 })[0]?.command.scriptName).toBe("build");
    expect(runtime.rankEntrypoints({ capabilities: ["capability:browser-render"], limit: 1 })[0]?.path).toBe("src/App.tsx");
    expect(runtime.capabilitySupport({ capabilities: ["eng.capability.validation"] })[0]?.kind).toBe("eng.capability.validation");
  });

  it("carries engineering corpus projection through typed ingest into graph materialization", () => {
    const fixture = engineeringFixture();
    const projector = createTypedIngestProjector({ idFactory: ids, hasher });
    const projected = projector.project({
      sourceId: fixture.evidence.sourceId,
      sourceVersionId: fixture.evidence.sourceVersionId,
      uri: "repo://fixture",
      mediaType: "application/vnd.scce.source-repository",
      text: "",
      metadata: toJsonValue({
        repositoryFacts: fixture.repositoryFacts,
        sourceCode: fixture.fileFacts[0],
        sourceKind: "local_engineering_corpus"
      }),
      evidence: [fixture.evidence],
      observedAt: clock.now()
    });

    const codeObservation = projected.observations.find(observation => observation.kind === "code");
    expect(codeObservation?.kind).toBe("code");
    expect(JSON.stringify(codeObservation?.metadata)).toContain("engineeringCorpus");
    expect(JSON.stringify(codeObservation?.programGraph)).toContain("scce.engineering-corpus.v1");
    expect(projected.graphNodes.some(node => String(node.typeId).includes("eng.capability") || JSON.stringify(node.representation).includes("eng.capability"))).toBe(true);
    expect(projected.graphEdges.some(edge => JSON.stringify(edge.metadata).includes("eng.repository_supports_capability"))).toBe(true);
    expect(projected.diagnostics).toMatchObject({ lane: "developer_intelligence" });
  });

  it("feeds engineering corpus commands and entrypoints into code learning and program planning", () => {
    const fixture = engineeringFixture();
    const entailment = entailmentFor(fixture.evidence);
    const graph = createCodeLearningEngine({ hasher }).learn({
      requestText: "Build an interactive planning workbench from the learned repository evidence.",
      evidence: [fixture.evidence],
      entailment
    });

    expect(graph.engineeringCorpora).toHaveLength(1);
    expect(graph.engineeringCorpora[0]?.summary.commandCount).toBeGreaterThan(0);
    expect(graph.signals.some(signal => signal.kind === "script.build" && signal.text === "build")).toBe(true);
    expect(graph.signals.some(signal => signal.kind === "script.validation" && signal.text === "test")).toBe(true);
    expect(graph.dependencies.some(dep => dep.packageName === "react")).toBe(true);

    const planner = createProgramPlanner({ idFactory: ids, hasher });
    const plan = planner.plan({
      episodeId: ids.episodeId(),
      requestText: "Build an interactive planning workbench from the learned repository evidence.",
      evidence: [fixture.evidence],
      entailment
    });

    expect(plan.intent.shape.target.evidence).toBeTruthy();
    expect(JSON.stringify(plan.intent.shape.target.evidence)).toContain("commandHints");
    expect(plan.build.command).toBe("pnpm");
    expect(plan.build.args).toEqual(["run", "build"]);
    expect(plan.test.command).toBe("pnpm");
    expect(plan.test.args).toEqual(["run", "test"]);
    expect(plan.intent.shape.target.entrypoint).toBe("src/App.tsx");
  });

  function engineeringFixture(): { repositoryFacts: SourceRepositoryFacts; fileFacts: SourceCodeFileFacts[]; evidence: EvidenceSpan } {
    const packageFacts = createSourceCodeFileFacts({
      path: "package.json",
      mediaType: "application/json",
      text: JSON.stringify({
        name: "fixture-workbench",
        scripts: { build: "vite build", test: "vitest run", dev: "vite --host 127.0.0.1" },
        dependencies: { react: "^19.0.0", vite: "^6.0.0" }
      }),
      contentHash: "sha256_pkg",
      parser: { id: "json-manifest-fixture", ok: true, diagnostics: [] },
      packageFacts: {
        name: "fixture-workbench",
        version: "1.0.0",
        scripts: [
          { name: "build", command: "vite build", roleEvidence: [{ roleId: "source.role.build", source: "fixture", confidence: 0.92, evidence: ["build"] }] },
          { name: "test", command: "vitest run", roleEvidence: [{ roleId: "source.role.validation", source: "fixture", confidence: 0.94, evidence: ["test"] }] },
          { name: "dev", command: "vite --host 127.0.0.1", roleEvidence: [{ roleId: "source.role.runtime", source: "fixture", confidence: 0.82, evidence: ["dev"] }] }
        ],
        dependencies: [
          { name: "react", scope: "runtime", version: "^19.0.0" },
          { name: "vite", scope: "development", version: "^6.0.0" }
        ]
      },
      hasher
    });
    const appFacts = createSourceCodeFileFacts({
      path: "src/App.tsx",
      mediaType: "text/typescript-jsx",
      text: "import React from 'react';\nexport function createWorkbench() { return React.createElement('main'); }\napp.get('/api/plan', handler);\ntest('renders plan', () => true);\n",
      contentHash: "sha256_app",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [
        { roleId: "source.role.presentation", source: "fixture", confidence: 0.86, evidence: ["React"] },
        { roleId: "source.role.interface", source: "fixture", confidence: 0.78, evidence: ["/api/plan"] }
      ],
      declarations: [{ id: "decl:createWorkbench", name: "createWorkbench", kind: "function", exported: true, defaultExport: false, signature: "export function createWorkbench()", metadata: {} }],
      imports: [{ id: "import:react", moduleSpecifier: "react", importedNames: ["React"], typeOnly: false, metadata: {} }],
      calls: [{ id: "call:createElement", callee: "React.createElement", argumentKinds: ["string"], metadata: {} }],
      routes: [{ id: "route:plan", protocol: "http", method: "GET", path: "/api/plan", handlerHint: "handler", metadata: {} }],
      tests: [{ id: "test:render", name: "renders plan", runnerHint: "test", metadata: {} }],
      patterns: [{ id: "pattern:component", kind: "component", label: "react component", codeSymbols: ["React", "createElement"], support: 0.8, metadata: {} }],
      hasher
    });
    const testFacts = createSourceCodeFileFacts({
      path: "src/App.test.tsx",
      mediaType: "text/typescript-jsx",
      text: "import { test } from 'vitest';\ntest('planner opens', () => true);\n",
      contentHash: "sha256_test",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "fixture", confidence: 0.95 }],
      roleEvidence: [{ roleId: "source.role.test", source: "fixture", confidence: 0.9, evidence: ["App.test.tsx"] }],
      imports: [{ id: "import:vitest", moduleSpecifier: "vitest", importedNames: ["test"], typeOnly: false, metadata: {} }],
      tests: [{ id: "test:planner", name: "planner opens", runnerHint: "test", metadata: {} }],
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo://fixture",
      files: [
        { path: "package.json", mediaType: packageFacts.mediaType, byteLength: packageFacts.metrics.bytes, contentHash: packageFacts.contentHash, facts: packageFacts },
        { path: "src/App.tsx", mediaType: appFacts.mediaType, byteLength: appFacts.metrics.bytes, contentHash: appFacts.contentHash, facts: appFacts },
        { path: "src/App.test.tsx", mediaType: testFacts.mediaType, byteLength: testFacts.metrics.bytes, contentHash: testFacts.contentHash, facts: testFacts },
        { path: "pnpm-lock.yaml", mediaType: "text/yaml", byteLength: 20, contentHash: "sha256_lock" }
      ],
      hasher
    });
    const sourceVersionId = ids.sourceVersionId("repo://fixture");
    const sourceId = ids.sourceId("local", "repo://fixture");
    const evidenceId = ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: 10, spanHash: ids.contentHash("repo") });
    const evidence: EvidenceSpan = {
      id: evidenceId,
      sourceId,
      sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: 10, chunkHash: ids.contentHash("repo") }),
      contentHash: ids.contentHash("repo"),
      mediaType: "application/vnd.scce.source-repository",
      byteStart: 0,
      byteEnd: 10,
      charStart: 0,
      charEnd: 10,
      text: "fixture repository source facts",
      textPreview: "fixture repository source facts",
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({
        uri: "repo://fixture",
        metadata: {
          sourceKind: "local_engineering_corpus",
          repositoryFacts,
          sourceCode: appFacts
        }
      }),
      features: ["sym:interactive", "sym:workbench", "sym:repository"],
      status: "promoted",
      alpha: 1,
      observedAt: clock.now()
    };
    return { repositoryFacts, fileFacts: [packageFacts, appFacts, testFacts], evidence };
  }

  function entailmentFor(evidence: EvidenceSpan): SemanticEntailmentResult {
    return {
      claim: { id: ids.claimId("engineering fixture"), text: "engineering fixture", normalized: "engineering fixture", features: ["sym:engineering"], polarity: 1 },
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "inferred",
      support: 0.68,
      contradiction: 0,
      faithfulnessLcb: 0.42,
      confidence: { verdict: "underdetermined", support: 0.68, contradiction: 0, faithfulnessLcb: 0.42, supportingEvidence: 1, sourceVersions: [String(evidence.sourceVersionId)], structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.4, causalMass: 0.1, stability: 0.8, satisfiedObligations: 0, requiredObligations: 0 },
      scores: { structuralCoverage: 0.6, roleCoverage: 0.6, relationCompatibility: 0.6, transformationSupport: 0.4, causalMass: 0.1, faithfulnessLCB: 0.42, contradiction: 0, stability: 0.8 },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [evidence.id],
      boundaries: [],
      proof: {
        id: ids.proofId({ claimId: ids.claimId("engineering fixture"), evidenceIds: [evidence.id], transforms: ["engineering"], validatorVersion: "fixture" }),
        claimId: ids.claimId("engineering fixture"),
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
});
