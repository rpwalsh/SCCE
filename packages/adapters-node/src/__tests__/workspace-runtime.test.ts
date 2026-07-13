import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInMemoryDialogueMemoryStore,
  INTERACTION_FEATURE_IDS,
  type DialogueMemoryStore,
  type JsonValue,
  type WorkspaceRecord,
  type WorkspaceReportRecord,
  type WorkspaceSourceFileRecord,
  type WorkspaceStore
} from "@scce/kernel";
import { analyzeWorkspaceProject, answerWorkspaceQuestion, createWorkspaceRuntime, workspaceFixtureFileList } from "../workspace-runtime.js";
import type { ScceRuntimeConfig } from "../config.js";
import type { NodeScceRuntime } from "../runtime.js";

const fixtureRoot = path.resolve("examples", "workspace-runtime-fixture");

describe("workspace runtime project intelligence", () => {
  it("indexes a real fixture workspace across docs, code, config, tables, and source files", async () => {
    const files = await workspaceFixtureFileList(fixtureRoot);
    expect(files).toEqual(expect.arrayContaining([
      "README.md",
      "docs/api.md",
      "package.json",
      "config/app.yaml",
      "config/local.json",
      "data/widgets.csv",
      "schema.sql",
      "public/index.html",
      "public/app.css",
      "scripts/inspect.py",
      "src/server.ts",
      "src/widget.ts",
      "tests/widget.test.ts"
    ]));

    const project = await analyzeWorkspaceProject(fixtureRoot);
    expect(project.schema).toBe("scce.workspace.project.v1");
    expect(project.sources.length).toBeGreaterThanOrEqual(13);
    expect(project.sources.map(source => source.mediaType)).toEqual(expect.arrayContaining([
      "text/markdown",
      "application/json",
      "application/yaml",
      "text/csv",
      "text/x-source.sql",
      "text/x-source.html",
      "text/x-source.css",
      "text/x-source.py"
    ]));
    expect(project.summary.counts.sourceFiles).toBeGreaterThanOrEqual(5);
    expect(project.summary.sourceRefs.length).toBeGreaterThan(0);
    expect(project.repo.hydrationValid).toBe(true);
    expect(project.coreFusion.schema).toBe("scce.workspace_core.promotion.v1");
    expect(project.coreFusion.records.symbols.length).toBeGreaterThan(0);
    expect(project.coreFusion.records.commands.length).toBeGreaterThan(0);
    expect(project.coreFusion.records.capabilities.length).toBeGreaterThan(0);
    expect(project.coreFusion.graph.nodes.length).toBeGreaterThan(0);
  });

  it("extracts project commands, routes, symbols, and cited answers", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);

    expect(project.commands.map(command => command.name)).toEqual(expect.arrayContaining(["build", "test", "start"]));
    expect(project.routes.map(route => route.path)).toContain("/api/widgets");
    expect(project.symbols.map(symbol => symbol.name)).toEqual(expect.arrayContaining(["WidgetService", "listWidgets", "runCli"]));

    const answer = answerWorkspaceQuestion(project, "Where is WidgetService defined?");
    expect(answer.confidence).toBeGreaterThan(0.7);
    expect(answer.path).toBe("workspace_query_adapter");
    expect(answer.generatedBy).toBe("workspace_query_adapter");
    expect(answer.selectedIntentId).toBe("workspace.intent.symbol_definition");
    expect(answer.intentEvidence.signals).toContain("symbol_definition.surface");
    expect(answer.answer).toContain("WidgetService");
    expect(answer.sourceRefs.some(ref => ref.path === "src/widget.ts" && typeof ref.lineStart === "number")).toBe(true);

    const routeAnswer = answerWorkspaceQuestion(project, "Show route inventory");
    expect(routeAnswer.selectedIntentId).toBe("workspace.intent.route_inventory");
    expect(routeAnswer.confidence).toBeGreaterThan(0.7);
    expect(routeAnswer.sourceRefs.some(ref => ref.path === "src/server.ts")).toBe(true);
  });

  it("reports doc/code contradictions and missing support without inventing evidence", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);
    const contradictionKinds = project.contradictions.map(item => item.kind);
    const gapKinds = project.gaps.map(item => item.kind);

    expect(contradictionKinds).toContain("doc_claim_missing_cli_command");
    expect(contradictionKinds).toContain("doc_claim_missing_route");
    expect(contradictionKinds).toContain("document_value_conflict");
    expect(gapKinds).toContain("public_api_undocumented");
    expect(gapKinds).toContain("exported_symbol_missing_test_support");

    const ghost = project.contradictions.find(item => item.kind === "doc_claim_missing_route" && item.statement.includes("/api/ghost"));
    expect(ghost?.sourceRefs.some(ref => ref.path === "README.md" || ref.path === "docs/api.md")).toBe(true);
    expect(project.tasks.length).toBeGreaterThan(0);
    expect(project.tasks.some(task => task.sourceRefs.length > 0 && task.affectedFiles.length > 0)).toBe(true);
    for (const task of project.tasks.filter(task => task.sourceRefs.length > 0)) {
      expect(task.metadata).toMatchObject({
        originatingEvidence: {
          sourceRefCount: expect.any(Number)
        },
        promotedCoreRecordIds: expect.any(Array)
      });
    }
    expect(project.reports.patchPlan).toContain("src/widget.ts");
    expect(project.reports.patchPlan).toContain("core wc_");
    expect(project.reports.patchPlan).not.toContain("## workspace");
    const sourceBackedTaskIds = new Set(project.tasks.filter(task => task.sourceRefs.length > 0).map(task => task.kind));
    for (const line of project.reports.patchPlan.split("\n").filter(line => line.startsWith("- "))) {
      expect([...sourceBackedTaskIds].some(kind => line.includes(kind))).toBe(true);
    }
  });

  it("keeps workspace query adapter honest for unsupported questions and report provenance", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);
    const unsupported = answerWorkspaceQuestion(project, "Can it design a waterproof bicycle drivetrain from scratch?");

    expect(unsupported.path).toBe("workspace_query_adapter");
    expect(unsupported.generatedBy).toBe("workspace_query_adapter");
    expect(unsupported.selectedIntentId).toBe("workspace.intent.unsupported");
    expect(unsupported.fallbackReason).toBe("workspace.query.unsupported_intent");
    expect(unsupported.confidence).toBeLessThan(0.3);
    expect(unsupported.sourceRefs).toEqual([]);
    expect(unsupported.answer).toContain("workspace.answer.intent=workspace.intent.unsupported");
    expect(unsupported.answer).toContain("workspace.status.unsupported_intent");

    const summary = answerWorkspaceQuestion(project, "Give workspace overview");
    expect(summary.selectedIntentId).toBe("workspace.intent.general_summary");
    expect(summary.sourceRefs.length).toBeGreaterThan(0);
    expect(summary.path).not.toBe("mouth");
  });

  it("keeps deterministic ordering across repeated analysis", async () => {
    const first = await analyzeWorkspaceProject(fixtureRoot);
    const second = await analyzeWorkspaceProject(fixtureRoot);

    expect(second.sources.map(source => [source.path, source.contentHash])).toEqual(first.sources.map(source => [source.path, source.contentHash]));
    expect(second.contradictions.map(item => item.id)).toEqual(first.contradictions.map(item => item.id));
    expect(second.gaps.map(item => item.id)).toEqual(first.gaps.map(item => item.id));
  });

  it("uses the live kernel workspace answer path and records dialogue outcome learning", async () => {
    const workspace = new MemoryWorkspaceStore();
    const dialogueMemory = createInMemoryDialogueMemoryStore();
    const runtime = createWorkspaceRuntime({
      runtime: fakeRuntime(workspace, dialogueMemory),
      config: fixtureConfig()
    });
    const conversationId = "conversation.live-workspace-test";
    const prompt = "what is implemented and what should we fix first?";

    const first = await runtime.answer(prompt, fixtureRoot, { conversationId, targetLanguage: "und" });

    expect(first.path).toBe("workspace_kernel_context");
    expect(first.generatedBy).toBe("workspace-kernel-context");
    expect(first.kernel?.pragmatics.schema).toBe("scce.dialogue.pragmatics_result.v1");
    expect(first.streamPlan?.schema).toBe("scce.dialogue.stream_rhythm_plan.v1");
    expect(first.streamPlan?.segments.length).toBeGreaterThan(0);
    expect(workspace.reports.length).toBe(1);
    expect(objectRecord(first.report?.data).generatedBy).toBe("workspace-kernel-context");
    const payload = objectRecord(objectRecord(first.report?.data).payload);
    expect(objectRecord(objectRecord(payload.kernel).pragmatics).schema).toBe("scce.dialogue.pragmatics_result.v1");
    expect((await dialogueMemory.listInteractionStates({ conversationId })).length).toBe(1);

    const outcome = await runtime.recordOutcome({
      status: "corrected",
      correctionText: "Lead with the fix first.",
      conversationId,
      promptText: prompt
    }, fixtureRoot);

    expect(outcome.schema).toBe("scce.workspace.answer_outcome.v1");
    expect(outcome.reportId).toBe(first.report?.id);
    expect(outcome.correctionId).toBeTruthy();
    const outcomes = await dialogueMemory.listConversationOutcomes({ conversationId });
    expect(outcomes[0]?.corrected).toBe(true);
    const snapshots = await dialogueMemory.listStyleSnapshots({ conversationId });
    expect(snapshots.length).toBe(1);

    const second = await runtime.answer("give current status", fixtureRoot, { conversationId, targetLanguage: "und" });
    const snapshotWeights = objectRecord(objectRecord(snapshots[0]?.profileJson).weights);
    expect(second.kernel?.dialogueState.userStyleProfile.weights[INTERACTION_FEATURE_IDS.hedgeAversion]).toBe(snapshotWeights[INTERACTION_FEATURE_IDS.hedgeAversion]);
    expect(second.kernel?.dialogueState.userStyleProfile.weights[INTERACTION_FEATURE_IDS.clarificationCost]).toBe(snapshotWeights[INTERACTION_FEATURE_IDS.clarificationCost]);
    expect(second.kernel?.dialogueState.userStyleProfile.weights[INTERACTION_FEATURE_IDS.hedgeAversion]).toBeGreaterThan(0.5);
  });
});

class MemoryWorkspaceStore implements WorkspaceStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly files: WorkspaceSourceFileRecord[] = [];
  readonly reports: WorkspaceReportRecord[] = [];

  async putWorkspace(record: WorkspaceRecord): Promise<void> {
    this.workspaces.set(record.id, record);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(id) ?? null;
  }

  async latestWorkspace(): Promise<WorkspaceRecord | null> {
    return [...this.workspaces.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async putSourceFile(record: WorkspaceSourceFileRecord): Promise<void> {
    const index = this.files.findIndex(item => item.workspaceId === record.workspaceId && item.path === record.path);
    if (index >= 0) this.files[index] = record;
    else this.files.push(record);
  }

  async listSourceFiles(query: { workspaceId?: string; corpusId?: string; status?: WorkspaceSourceFileRecord["ingestionStatus"]; limit?: number } = {}): Promise<WorkspaceSourceFileRecord[]> {
    return this.files
      .filter(item => !query.workspaceId || item.workspaceId === query.workspaceId)
      .filter(item => !query.corpusId || item.corpusId === query.corpusId)
      .filter(item => !query.status || item.ingestionStatus === query.status)
      .slice(0, query.limit ?? 10000);
  }

  async putReport(record: WorkspaceReportRecord): Promise<void> {
    if (!this.workspaces.has(record.workspaceId)) throw new Error(`missing workspace for report ${record.workspaceId}`);
    const index = this.reports.findIndex(item => item.id === record.id);
    if (index >= 0) this.reports[index] = record;
    else this.reports.push(record);
  }

  async listReports(query: { workspaceId?: string; reportKind?: WorkspaceReportRecord["reportKind"]; limit?: number } = {}): Promise<WorkspaceReportRecord[]> {
    return this.reports
      .filter(item => !query.workspaceId || item.workspaceId === query.workspaceId)
      .filter(item => !query.reportKind || item.reportKind === query.reportKind)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, query.limit ?? 100);
  }
}

function fakeRuntime(workspace: WorkspaceStore, dialogueMemory: DialogueMemoryStore): NodeScceRuntime {
  return {
    storage: { workspace, dialogueMemory } as NodeScceRuntime["storage"],
    kernel: {} as NodeScceRuntime["kernel"],
    connectors: {} as NodeScceRuntime["connectors"],
    approvals: {} as NodeScceRuntime["approvals"],
    close: async () => {}
  };
}

function fixtureConfig(): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:0" },
    database: { url: "postgres://example/example", schema: "public" },
    runtime: {
      workspaceRoot: fixtureRoot,
      tempRoot: path.resolve(".tmp"),
      maxFileBytes: 1024 * 1024,
      maxChunkBytes: 64 * 1024,
      allowedRoots: [fixtureRoot],
      excludedPaths: [],
      tools: {}
    },
    connectors: {},
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: true
    }
  };
}

function objectRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
