import { describe, expect, it } from "vitest";
import { proveClaim } from "../semantic-proof-engine.js";
import { createClock } from "../primitives.js";
import {
  promoteWorkspaceAnalysisToCoreRecords,
  workspaceCommandToActionRecord,
  workspaceDocClaimToProofClaim,
  workspaceRouteToCapabilityRecord,
  workspaceSymbolToGraphNode,
  type WorkspaceCoreAnalysisInput,
  type WorkspaceCoreWorkspaceRef
} from "../workspace-core-fusion.js";

const workspace: WorkspaceCoreWorkspaceRef = {
  id: "workspace_fixture",
  corpusId: "corpus_fixture",
  rootPath: "/fixture",
  rootUri: "file:///fixture"
};

describe("workspace core fusion", () => {
  it("promotes workspace analysis into source-backed evidence, graph, proof, learning, and program records", () => {
    const analysis = fixtureAnalysis();
    const promoted = promoteWorkspaceAnalysisToCoreRecords(analysis);

    expect(promoted.schema).toBe("scce.workspace_core.promotion.v1");
    expect(promoted.safeToHydrate).toBe(true);
    expect(promoted.contract.safeToHydrate).toBe(true);
    expect(promoted.contract.rejectedRecords).toEqual([]);
    expect(promoted.records.symbols.length).toBe(1);
    expect(promoted.records.relations.some(record => record.relationshipKind === "workspace.relation.exports_symbol")).toBe(true);
    expect(promoted.records.capabilities.length).toBe(1);
    expect(promoted.records.commands.length).toBe(1);
    expect(promoted.records.contradictions.length).toBe(1);
    expect(promoted.records.gaps.length).toBe(1);
    expect(promoted.records.tasks.length).toBeGreaterThan(0);
    expect(promoted.graph.nodes.length).toBeGreaterThan(0);
    expect(promoted.graph.edges.length).toBeGreaterThan(0);
    expect(promoted.learning.needs[0]?.id).toBe(promoted.records.gaps[0]?.learningNeed.id);
    expect(promoted.program.plannerInputs[0]?.workspaceTaskId).toBe("task_gap_widget_docs");
    expect(promoted.mouthContext.proofClaims.length).toBeGreaterThan(0);
    expect(promoted.mouthContext.evidence.length).toBeGreaterThan(0);
    expect(promoted.mouthContext.taskRecordIds.length).toBeGreaterThan(0);

    const claim = workspaceDocClaimToProofClaim({
      workspaceFindingId: "contradiction_missing_route",
      kind: "doc_claim_missing_route",
      statement: "docs route claim has no source route",
      sourceRef: { path: "README.md", lineStart: 4, lineEnd: 4, evidenceSpanId: "ev_readme_4", contentHash: "hash_readme" }
    }, contextForTest());
    const proof = proveClaim({ claim, candidateEvidence: promoted.proof.evidence });
    expect(["certified", "insufficient_evidence"]).toContain(proof.verdict);
    expect(promoted.proof.evidence.every(record => record.forceClass !== "learned_program_prior")).toBe(true);
  });

  it("rejects unsupported source-free promotions instead of certifying workspace facts", () => {
    const ctx = contextForTest();
    const symbol = workspaceSymbolToGraphNode({
      id: "symbol_missing_ref",
      name: "MissingRef",
      kind: "function",
      path: "src/missing.ts",
      exported: true
    }, ctx);
    const route = workspaceRouteToCapabilityRecord({
      id: "route_missing_ref",
      method: "GET",
      path: "/ghost",
      filePath: "src/missing.ts"
    }, ctx);
    const command = workspaceCommandToActionRecord({
      id: "command_missing_ref",
      name: "ghost",
      command: "node missing.js",
      sourcePath: "package.json",
      kind: "package_script"
    }, ctx);

    expect(symbol.rejected?.reasonId).toBe("workspace.reject.symbol_source_ref_required");
    expect(route.rejected?.reasonId).toBe("workspace.reject.route_source_ref_required");
    expect(command.rejected?.reasonId).toBe("workspace.reject.command_source_ref_required");
    expect(symbol.record).toBeUndefined();
    expect(route.record).toBeUndefined();
    expect(command.record).toBeUndefined();
  });

  it("keeps idempotency deterministic across repeated promotion", () => {
    const first = promoteWorkspaceAnalysisToCoreRecords(fixtureAnalysis(), {
      clock: createClock({ fixedTime: 1_750_000_000_000 })
    });
    const second = promoteWorkspaceAnalysisToCoreRecords(fixtureAnalysis(), {
      clock: createClock({ fixedTime: 1_750_000_000_000 })
    });

    expect(second).toEqual(first);
    expect(second.contract.idempotencyKeys).toEqual(first.contract.idempotencyKeys);
    expect(second.graph.nodes.map(node => node.id)).toEqual(first.graph.nodes.map(node => node.id));
    expect(second.graph.edges.map(edge => edge.id)).toEqual(first.graph.edges.map(edge => edge.id));
  });
});

function fixtureAnalysis(): WorkspaceCoreAnalysisInput {
  return {
    rootPath: "/fixture",
    workspace,
    sources: [
      { path: "README.md", mediaType: "text/markdown", contentHash: "hash_readme", byteLength: 100, evidenceIds: ["ev_readme_4"] },
      { path: "package.json", mediaType: "application/json", contentHash: "hash_package", byteLength: 120, evidenceIds: ["ev_package_7"] },
      { path: "src/widget.ts", mediaType: "text/x-source.ts", contentHash: "hash_widget", byteLength: 300, evidenceIds: ["ev_widget_2"] },
      { path: "src/server.ts", mediaType: "text/x-source.ts", contentHash: "hash_server", byteLength: 220, evidenceIds: ["ev_server_3"] }
    ],
    summary: {
      sourceRefs: [{ path: "README.md", lineStart: 1, lineEnd: 1, evidenceSpanId: "ev_readme_1", contentHash: "hash_readme" }],
      counts: { files: 4, symbols: 1, commands: 1, routes: 1 }
    },
    map: {
      modules: [{ path: "src/widget.ts", languageId: "ts", declarations: 1, imports: 0, exports: 1, roles: ["source.role.library"], sourceRefs: [{ path: "src/widget.ts", evidenceSpanId: "ev_widget_2", contentHash: "hash_widget" }] }]
    },
    symbols: [
      { id: "sym_widget_service", name: "WidgetService", kind: "class", path: "src/widget.ts", exported: true, sourceRef: { path: "src/widget.ts", lineStart: 1, lineEnd: 10, evidenceSpanId: "ev_widget_2", contentHash: "hash_widget" }, importedBy: ["src/server.ts"], mentionedByDocs: ["README.md:3"], calledBy: ["src/server.ts:5"] }
    ],
    commands: [
      { id: "cmd_build", name: "build", command: "tsc -p tsconfig.json", sourcePath: "package.json", kind: "package_script", sourceRef: { path: "package.json", lineStart: 7, lineEnd: 7, evidenceSpanId: "ev_package_7", contentHash: "hash_package" } }
    ],
    routes: [
      { id: "route_widgets", method: "GET", path: "/api/widgets", filePath: "src/server.ts", sourceRef: { path: "src/server.ts", lineStart: 3, lineEnd: 3, evidenceSpanId: "ev_server_3", contentHash: "hash_server" } }
    ],
    contradictions: [
      { id: "contradiction_missing_route", kind: "doc_claim_missing_route", severity: "warning", statement: "docs route claim has no source route", sourceRefs: [{ path: "README.md", lineStart: 4, lineEnd: 4, evidenceSpanId: "ev_readme_4", contentHash: "hash_readme" }], affectedFiles: ["README.md"], suggestedFix: "align route docs with source", confidence: 0.78, metadata: {} }
    ],
    gaps: [
      { id: "gap_widget_docs", kind: "public_api_undocumented", severity: "warning", statement: "exported symbol lacks indexed docs", sourceRefs: [{ path: "src/widget.ts", lineStart: 1, lineEnd: 10, evidenceSpanId: "ev_widget_2", contentHash: "hash_widget" }], affectedFiles: ["src/widget.ts"], suggestedFix: "add source-bound docs", confidence: 0.66, metadata: {} }
    ],
    tasks: [
      { id: "task_gap_widget_docs", kind: "task.public_api_undocumented", severity: "warning", statement: "exported symbol lacks indexed docs", sourceRefs: [{ path: "src/widget.ts", lineStart: 1, lineEnd: 10, evidenceSpanId: "ev_widget_2", contentHash: "hash_widget" }], affectedFiles: ["src/widget.ts"], suggestedFix: "add source-bound docs", confidence: 0.66, metadata: { sourceFindingKind: "public_api_undocumented" } }
    ],
    reports: {
      patchPlan: "source-backed plan"
    }
  };
}

function contextForTest() {
  return {
    workspace,
    sourceByPath: new Map(),
    replayTraceId: "trace_test",
    createdAt: 1000
  };
}
