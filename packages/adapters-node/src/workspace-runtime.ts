import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  answerFromWorkspaceCoreContext,
  CALIBRATION_TASK_CLASS_IDS,
  latestDialogueStyleProfile,
  loadCalibrationModelSet,
  normalizePath,
  persistDialogueOutcomeAndLearn,
  persistDialogueTurn,
  planStreamRhythm,
  promoteWorkspaceAnalysisToCoreRecords,
  toJsonValue,
  createWorkspaceRevisionSnapshot,
  generateWorkspacePatchPlan,
  generateWorkspacePatchPlanFromProgramGraph,
  type DialoguePragmaticsResult,
  type FileArtifact,
  type IngestResult,
  type JsonValue,
  type ProgramConstructIntent,
  type RepoSnapshot,
  type WorkspaceCorePromotionResult,
  type WorkspaceKernelAnswerResult,
  type WorkspacePatchPlanGenerationResult,
  type WorkspaceProgramPatchPlanGenerationResult,
  type WorkspacePatchProposalAssessment,
  type WorkspacePatchValidationPlan,
  type WorkspaceRecord,
  type WorkspaceReportRecord,
  type WorkspaceRevisionSnapshot,
  type WorkspaceSourceFileRecord
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import type { NodeScceRuntime } from "./runtime.js";
import { analyzeDeveloperRepo, type RepoIntelligenceAnalysis, type RepoIntelligenceFolderOptions } from "./repo-intelligence-folder.js";
import { inspectEngineeringCorpusFolder, type EngineeringCorpusFileInspection, type EngineeringCorpusFolderInspection } from "./engineering-corpus-folder.js";

export interface WorkspaceRuntimeOptions extends RepoIntelligenceFolderOptions {
  maxDocumentBytes?: number;
  conversationId?: string;
  targetLanguage?: string;
  useKernelAnswer?: boolean;
}

export interface WorkspaceSourceRef {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  evidenceSpanId?: string;
  contentHash?: string;
}

export interface WorkspaceFinding {
  id: string;
  kind: string;
  severity: "info" | "warning" | "high";
  statement: string;
  sourceRefs: WorkspaceSourceRef[];
  affectedFiles: string[];
  suggestedFix: string;
  confidence: number;
  metadata: JsonValue;
}

export interface WorkspaceSymbolSummary {
  id: string;
  name: string;
  kind: string;
  path: string;
  exported: boolean;
  defaultExport: boolean;
  sourceRef?: WorkspaceSourceRef;
  importedBy: string[];
  mentionedByDocs: string[];
  calledBy: string[];
}

export interface WorkspaceCommandSummary {
  id: string;
  name: string;
  command: string;
  sourcePath: string;
  kind: string;
  sourceRef?: WorkspaceSourceRef;
}

export interface WorkspaceRouteSummary {
  id: string;
  method: string;
  path: string;
  filePath: string;
  handlerHint?: string;
  sourceRef?: WorkspaceSourceRef;
}

export type WorkspaceQueryAdapterPath = "workspace_query_adapter";
export type WorkspaceKernelAdapterPath = "workspace_kernel_context";

export type WorkspaceIntentId =
  | "workspace.intent.symbol_definition"
  | "workspace.intent.route_inventory"
  | "workspace.intent.command_inventory"
  | "workspace.intent.import_relationship"
  | "workspace.intent.call_relationship"
  | "workspace.intent.test_surface"
  | "workspace.intent.unused_export"
  | "workspace.intent.risk_inventory"
  | "workspace.intent.task_inventory"
  | "workspace.intent.contradiction_inventory"
  | "workspace.intent.general_summary"
  | "workspace.intent.unsupported";

export interface WorkspaceIntentEvidence {
  signals: string[];
  observedTerms: string[];
  candidateCounts: Record<string, number>;
  sourceRefs: WorkspaceSourceRef[];
}

export interface WorkspaceQuestionAnswer {
  schema: "scce.workspace.answer.v1";
  path: WorkspaceQueryAdapterPath | WorkspaceKernelAdapterPath;
  generatedBy: "workspace_query_adapter" | "workspace-kernel-context";
  selectedIntentId: WorkspaceIntentId;
  intentEvidence: WorkspaceIntentEvidence;
  fallbackReason?: string;
  question: string;
  answer: string;
  confidence: number;
  sourceRefs: WorkspaceSourceRef[];
  data: JsonValue;
  kernel?: WorkspaceKernelAnswerResult;
  streamPlan?: ReturnType<typeof planStreamRhythm>;
  report?: WorkspaceReportRecord;
}

export interface WorkspaceProjectReport {
  schema: "scce.workspace.project.v1";
  rootPath: string;
  workspace: WorkspaceRecord;
  inspection: EngineeringCorpusFolderInspection;
  repo: {
    summary: RepoSnapshot["summary"];
    hydrationValid: boolean;
    warnings: string[];
  };
  sources: WorkspaceSourceFileRecord[];
  summary: {
    body: string;
    sourceRefs: WorkspaceSourceRef[];
    counts: Record<string, number>;
  };
  map: {
    components: Array<{ path: string; kind: string; files: number; symbols: number; routes: number; tests: number; sourceRefs: WorkspaceSourceRef[] }>;
    modules: Array<{ path: string; languageId: string; declarations: number; imports: number; exports: number; roles: string[]; sourceRefs: WorkspaceSourceRef[] }>;
  };
  symbols: WorkspaceSymbolSummary[];
  commands: WorkspaceCommandSummary[];
  routes: WorkspaceRouteSummary[];
  gaps: WorkspaceFinding[];
  contradictions: WorkspaceFinding[];
  tasks: WorkspaceFinding[];
  coreFusion: WorkspaceCorePromotionResult;
  reports: {
    brief: string;
    patchPlan: string;
    handoff: string;
    review: string;
  };
}

export interface WorkspaceIngestReport {
  schema: "scce.workspace.ingest.v1";
  workspace: WorkspaceRecord;
  importBatchId: string;
  ingested: number;
  unchanged: number;
  changed: number;
  missing: number;
  failed: number;
  unsupported: number;
  kernelResults: IngestResult[];
  sources: WorkspaceSourceFileRecord[];
  project: WorkspaceProjectReport;
}

export interface WorkspaceRuntime {
  init(rootPath: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceRecord>;
  ingest(rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceIngestReport>;
  project(rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceProjectReport>;
  answer(question: string, rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceQuestionAnswer>;
  recordOutcome(input: WorkspaceAnswerOutcomeInput, rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceAnswerOutcomeResult>;
  planPatch(input: WorkspacePatchPlanningInput, rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspacePatchPlanGenerationResult>;
  planCodingPatch(input: WorkspaceCodingPatchPlanningInput, rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceProgramPatchPlanGenerationResult>;
  report(kind: WorkspaceReportRecord["reportKind"], rootPath?: string, options?: WorkspaceRuntimeOptions): Promise<WorkspaceReportRecord>;
}

export interface WorkspacePatchPlanningInput {
  workspaceId: string;
  expectedWorkspaceUpdatedAt: number;
  proposedFiles: Array<{
    path: string;
    content: string;
    mediaType: string;
    role: FileArtifact["role"];
    expectedContentHash: string | null;
  }>;
  deletions?: Array<{ path: string; expectedContentHash: string }>;
  requestedPaths: string[];
  assessment: WorkspacePatchProposalAssessment;
  validationPlan: WorkspacePatchValidationPlan;
}

export interface WorkspaceCodingPatchPlanningInput {
  workspaceId: string;
  expectedWorkspaceUpdatedAt: number;
  requestId: string;
  requestText: string;
  requestedPaths: string[];
  validationPlan: WorkspacePatchValidationPlan;
}

export interface WorkspaceAnswerOutcomeInput {
  status: "accepted" | "rejected" | "corrected";
  correctionText?: string;
  reportId?: string;
  conversationId?: string;
  promptText?: string;
}

export interface WorkspaceAnswerOutcomeResult {
  schema: "scce.workspace.answer_outcome.v1";
  reportId: string;
  conversationId: string;
  outcomeId: string;
  styleSnapshotId: string;
  calibrationObservationIds: string[];
  correctionId?: string;
  reversible: true;
}

interface DocumentLine {
  path: string;
  line: number;
  text: string;
  contentHash?: string;
}

interface CallSite {
  symbol: string;
  path: string;
  line: number;
}

const DEFAULT_OPTIONS: Required<WorkspaceRuntimeOptions> = {
  maxFiles: 4000,
  maxFileBytes: 2 * 1024 * 1024,
  maxDepth: 14,
  includeUnsupported: true,
  maxDocumentBytes: 512 * 1024,
  conversationId: "",
  targetLanguage: "und",
  useKernelAnswer: true
};

const FINDING_RANK: Record<WorkspaceFinding["severity"], number> = { high: 3, warning: 2, info: 1 };
const WORKSPACE_QUERY_ADAPTER_PATH: WorkspaceQueryAdapterPath = "workspace_query_adapter";
const WORKSPACE_REPORT_TEMPLATE = "workspace_report_template";

export function createWorkspaceRuntime(input: { runtime: NodeScceRuntime; config: ScceRuntimeConfig }): WorkspaceRuntime {
  return {
    async init(rootPath, options = {}) {
      const root = resolveAllowedRoot(rootPath, input.config);
      const now = Date.now();
      const workspace = workspaceRecord(root, now, options);
      await input.runtime.storage.workspace.putWorkspace(workspace);
      return workspace;
    },
    async ingest(rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      const normalizedOptions = normalizeOptions(options);
      const now = Date.now();
      const workspace = workspaceRecord(root, now, normalizedOptions);
      await input.runtime.storage.workspace.putWorkspace(workspace);
      const importBatchId = `workspace_batch_${hashParts(workspace.id, String(now)).slice(0, 24)}`;
      const project = await analyzeWorkspaceProject(root, normalizedOptions);
      const previous = await input.runtime.storage.workspace.listSourceFiles({ workspaceId: workspace.id, limit: normalizedOptions.maxFiles * 2 });
      const previousByPath = new Map(previous.map(file => [file.path, file]));
      const currentPaths = new Set(project.sources.map(source => source.path));
      const kernelResults: IngestResult[] = [];
      let ingested = 0;
      let unchanged = 0;
      let changed = 0;
      let failed = 0;
      let unsupported = project.inspection.totals.filesUnsupported;

      for (const source of project.sources) {
        const before = previousByPath.get(source.path);
        if (!source.contentHash) {
          await input.runtime.storage.workspace.putSourceFile({ ...source, ingestionStatus: "skipped", importBatchId, updatedAt: Date.now() });
          continue;
        }
        if (before?.contentHash === source.contentHash && before.ingestionStatus === "ingested") {
          unchanged++;
          await input.runtime.storage.workspace.putSourceFile({ ...source, ingestionStatus: "skipped", importBatchId, updatedAt: Date.now(), metadata: mergeMetadata(source.metadata, { skipReason: "unchanged" }) });
          continue;
        }
        try {
          const result = await input.runtime.kernel.ingest({
            path: source.absolutePath,
            metadata: toJsonValue({
              workspace: workspaceMetadata(workspace),
              workspaceFile: {
                path: source.path,
                contentHash: source.contentHash,
                modifiedTime: source.modifiedTime,
                importBatchId
              },
              ingestionLane: "workspace",
              sourceKind: source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
                ? (source.metadata as Record<string, JsonValue>).sourceKind ?? "workspace"
                : "workspace"
            })
          });
          kernelResults.push(result);
          ingested++;
          if (before) changed++;
          await input.runtime.storage.workspace.putSourceFile({
            ...source,
            ingestionStatus: "ingested",
            importBatchId,
            evidenceIds: [...new Set(result.events.flatMap(event => evidenceIdsFromPayload(event.payload)))] as never[],
            updatedAt: Date.now()
          });
        } catch (error) {
          failed++;
          await input.runtime.storage.workspace.putSourceFile({ ...source, ingestionStatus: "failed", importBatchId, errors: [messageOf(error)], updatedAt: Date.now() });
        }
      }

      let missing = 0;
      for (const old of previous) {
        if (currentPaths.has(old.path)) continue;
        missing++;
        await input.runtime.storage.workspace.putSourceFile({ ...old, ingestionStatus: "missing", importBatchId, errors: [], warnings: [...old.warnings, "file missing during incremental ingest"], updatedAt: Date.now() });
      }

      const refreshed = await analyzeWorkspaceProject(root, normalizedOptions);
      await persistProjectReports(input.runtime, refreshed);
      return { schema: "scce.workspace.ingest.v1", workspace, importBatchId, ingested, unchanged, changed, missing, failed, unsupported, kernelResults, sources: refreshed.sources, project: refreshed };
    },
    async project(rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      const project = await analyzeWorkspaceProject(root, options);
      await input.runtime.storage.workspace.putWorkspace(project.workspace);
      await persistProjectReports(input.runtime, project);
      return project;
    },
    async answer(question, rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      const normalizedOptions = normalizeOptions(options);
      const project = await analyzeWorkspaceProject(root, normalizedOptions);
      await input.runtime.storage.workspace.putWorkspace(project.workspace);
      const legacy = answerWorkspaceQuestion(project, question);
      if (!normalizedOptions.useKernelAnswer) {
        const report = workspaceReportRecord(project.workspace, "answer", `Answer: ${question.slice(0, 80)}`, legacy.answer, toJsonValue(legacy), legacy.sourceRefs);
        await input.runtime.storage.workspace.putReport(report);
        return { ...legacy, report };
      }
      const conversationId = normalizedOptions.conversationId || project.workspace.id;
      const learnedProfile = await latestDialogueStyleProfile(input.runtime.storage.dialogueMemory, conversationId);
      const calibrationModels = await loadCalibrationModelSet({
        store: input.runtime.storage.dialogueMemory,
        minPoints: 2,
        createdAt: Date.now()
      });
      const kernel = await answerFromWorkspaceCoreContext({
        promotion: project.coreFusion,
        question,
        options: {
          conversationId,
          targetLanguage: normalizedOptions.targetLanguage,
          userStyleProfile: learnedProfile,
          calibrationModels
        }
      });
      const streamPlan = planStreamRhythm({ policyDecision: kernel.dialoguePolicyDecision, answerGraph: kernel.answerGraph, finalText: kernel.spoken.text });
      await persistDialogueTurn({
        store: input.runtime.storage.dialogueMemory,
        result: kernel.pragmatics,
        answerGraphHash: hashParts(kernel.answerGraph.id, kernel.answerGraph.statusId, kernel.answerGraph.claims.map(claim => claim.id)),
        now: Date.now()
      });
      const answer: WorkspaceQuestionAnswer = {
        ...legacy,
        path: "workspace_kernel_context",
        generatedBy: "workspace-kernel-context",
        answer: kernel.spoken.text,
        confidence: Math.max(legacy.confidence, kernel.pragmatics.selected.score),
        sourceRefs: legacy.sourceRefs.length ? legacy.sourceRefs : kernel.mouthInput.speakInput.evidence.map(span => ({
          path: String(span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? (span.provenance as Record<string, JsonValue>).uri ?? span.id : span.id),
          evidenceSpanId: String(span.id),
          contentHash: String(span.contentHash)
        })),
        data: toJsonValue({
          legacy,
          kernel: {
            answerGraphId: kernel.answerGraph.id,
            dialogueStateId: kernel.dialogueState.turnId,
            dialoguePolicyDecisionId: kernel.dialoguePolicyDecision.id,
            pragmaticsCriticId: kernel.pragmatics.selected.criticId,
            streamPlanId: streamPlan.id
          }
        }),
        kernel,
        streamPlan
      };
      const report = workspaceReportRecord(project.workspace, "answer", `Answer: ${question.slice(0, 80)}`, answer.answer, toJsonValue(answer), answer.sourceRefs);
      await input.runtime.storage.workspace.putReport(report);
      return { ...answer, report };
    },
    async recordOutcome(outcomeInput, rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      const workspace = workspaceRecord(root, Date.now(), normalizeOptions(options));
      const reports = await input.runtime.storage.workspace.listReports({ workspaceId: workspace.id, reportKind: "answer", limit: 50 });
      const report = outcomeInput.reportId
        ? reports.find(item => item.id === outcomeInput.reportId)
        : reports[0];
      if (!report) throw new Error("workspace.answer.outcome requires a persisted workspace answer report");
      const reportData = jsonRecord(report.data);
      const payload = jsonRecord(reportData.payload);
      const answerPayload = Object.keys(payload).length ? payload : reportData;
      const kernel = jsonRecord(answerPayload.kernel);
      const pragmatics = kernel.pragmatics as DialoguePragmaticsResult | undefined;
      if (!pragmatics || pragmatics.schema !== "scce.dialogue.pragmatics_result.v1") throw new Error("workspace.answer.outcome requires a kernel-backed workspace answer report");
      const conversationId = outcomeInput.conversationId ?? pragmatics.state.conversationId;
      const currentProfile = await latestDialogueStyleProfile(input.runtime.storage.dialogueMemory, conversationId);
      const learned = await persistDialogueOutcomeAndLearn({
        store: input.runtime.storage.dialogueMemory,
        result: pragmatics,
        promptText: outcomeInput.promptText ?? String(report.title),
        accepted: outcomeInput.status === "accepted",
        rejected: outcomeInput.status === "rejected",
        corrected: outcomeInput.status === "corrected",
        correctionText: outcomeInput.correctionText,
        currentProfile,
        taskClass: CALIBRATION_TASK_CLASS_IDS.workspaceAnswer,
        now: Date.now()
      });
      return {
        schema: "scce.workspace.answer_outcome.v1",
        reportId: report.id,
        conversationId,
        outcomeId: learned.outcome.id,
        styleSnapshotId: learned.learning.snapshot.id,
        calibrationObservationIds: learned.calibrationObservations.map(observation => observation.id),
        correctionId: learned.correction?.id,
        reversible: true
      };
    },
    async planPatch(planInput, rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      return planWorkspacePatchFromDurableRevision({
        runtime: input.runtime,
        root,
        input: planInput,
        options: normalizeOptions(options)
      });
    },
    async planCodingPatch(planInput, rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      return planWorkspaceCodingPatchFromDurableRevision({
        runtime: input.runtime,
        root,
        input: planInput,
        options: normalizeOptions(options)
      });
    },
    async report(kind, rootPath, options = {}) {
      const root = rootPath ? resolveAllowedRoot(rootPath, input.config) : await latestWorkspaceRoot(input.runtime, input.config);
      const project = await analyzeWorkspaceProject(root, options);
      await input.runtime.storage.workspace.putWorkspace(project.workspace);
      const body = reportBody(project, kind);
      const record = workspaceReportRecord(project.workspace, kind, reportTitle(kind), body, project as unknown as JsonValue, reportRefs(project, kind));
      await input.runtime.storage.workspace.putReport(record);
      return record;
    }
  };
}

export async function analyzeWorkspaceProject(rootPath: string, options: WorkspaceRuntimeOptions = {}): Promise<WorkspaceProjectReport> {
  const normalizedOptions = normalizeOptions(options);
  const root = path.resolve(rootPath);
  const now = Date.now();
  const workspace = workspaceRecord(root, now, normalizedOptions);
  const inspection = await inspectEngineeringCorpusFolder(root, normalizedOptions);
  const repo = await analyzeDeveloperRepo(root, normalizedOptions);
  const docs = await loadDocumentLines(root, inspection, normalizedOptions);
  const calls = await collectCallSites(root, repo, normalizedOptions);
  const sources = await workspaceSources(workspace, inspection, repo);
  const symbols = symbolSummaries(repo, docs, calls);
  const commands = commandSummaries(repo);
  const routes = await routeSummaries(root, repo, sources, normalizedOptions);
  const rawContradictions = detectContradictions(root, repo, docs, commands, routes);
  const rawGaps = detectGaps(repo, docs, symbols, commands, routes);
  const rawTasks = prioritizedTasks([...rawContradictions, ...rawGaps], repo);
  const summary = projectSummary(inspection, repo, commands, routes);
  const map = projectMap(repo);
  const coreFusion = promoteWorkspaceAnalysisToCoreRecords({
    schema: "scce.workspace.project.v1",
    rootPath: root,
    workspace,
    sources,
    summary,
    map,
    symbols,
    commands,
    routes,
    gaps: rawGaps,
    contradictions: rawContradictions,
    tasks: rawTasks,
    reports: {}
  });
  const contradictions = attachCoreRecords(rawContradictions, coreFusion.records.contradictions.map(record => ({ findingId: record.workspaceFindingId, recordId: record.id })));
  const gaps = attachCoreRecords(rawGaps, coreFusion.records.gaps.map(record => ({ findingId: record.workspaceFindingId, recordId: record.id, learningNeedId: record.learningNeed.id })));
  const tasks = attachCoreRecords(rawTasks, coreFusion.records.tasks.map(record => ({ findingId: record.workspaceFindingId, recordId: record.id, plannerInputId: record.programPlannerInput.id })));
  return {
    schema: "scce.workspace.project.v1",
    rootPath: root,
    workspace,
    inspection,
    repo: { summary: repo.snapshot.summary, hydrationValid: repo.snapshot.hydration.valid, warnings: repo.snapshot.warnings },
    sources,
    summary,
    map,
    symbols,
    commands,
    routes,
    gaps,
    contradictions,
    tasks,
    coreFusion,
    reports: {
      brief: citedBrief(summary, contradictions, gaps, tasks),
      patchPlan: patchPlan(tasks),
      handoff: handoffNote(summary, tasks, repo),
      review: hostileReview(contradictions, gaps)
    }
  };
}

export function answerWorkspaceQuestion(project: WorkspaceProjectReport, question: string): WorkspaceQuestionAnswer {
  const lower = question.toLocaleLowerCase();
  const terms = lexicalTerms(question).filter(term => term.length > 1);
  const sourceRefs: WorkspaceSourceRef[] = [];
  let surface = "";
  let data: JsonValue = {};
  let confidence = 0.42;
  let selectedIntentId: WorkspaceIntentId = "workspace.intent.unsupported";
  let signals: string[] = [];
  let fallbackReason: string | undefined;

  if (includesAll(lower, ["where", "defined"]) || includesAny(lower, ["definition", "defined"])) {
    selectedIntentId = "workspace.intent.symbol_definition";
    signals = ["symbol_definition.surface", "symbol_definition.term_match"];
    const symbols = matchingSymbols(project.symbols, terms).slice(0, 8);
    sourceRefs.push(...symbols.flatMap(symbol => symbol.sourceRef ? [symbol.sourceRef] : []));
    surface = symbols.length
      ? workspaceAnswerSurface("workspace.intent.symbol_definition", symbols.map(symbol => `symbol.name=${symbol.name} symbol.path=${formatRef(symbol.sourceRef ?? { path: symbol.path })} symbol.kind=${symbol.kind}`))
      : workspaceAnswerSurface("workspace.intent.symbol_definition", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ symbols });
    confidence = symbols.length ? 0.86 : 0.38;
  } else if (includesAny(lower, ["imports", "importing", "import"])) {
    selectedIntentId = "workspace.intent.import_relationship";
    signals = ["import_relationship.surface", "import_relationship.term_match"];
    const symbols = matchingSymbols(project.symbols, terms).filter(symbol => symbol.importedBy.length).slice(0, 12);
    sourceRefs.push(...symbols.flatMap(symbol => symbol.sourceRef ? [symbol.sourceRef] : []));
    surface = symbols.length
      ? workspaceAnswerSurface("workspace.intent.import_relationship", symbols.map(symbol => `symbol.name=${symbol.name} imported.by=${symbol.importedBy.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.import_relationship", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ symbols });
    confidence = symbols.length ? 0.78 : 0.36;
  } else if (includesAny(lower, ["calls", "called", "callers"])) {
    selectedIntentId = "workspace.intent.call_relationship";
    signals = ["call_relationship.surface", "call_relationship.term_match"];
    const symbols = matchingSymbols(project.symbols, terms).filter(symbol => symbol.calledBy.length).slice(0, 12);
    sourceRefs.push(...symbols.flatMap(symbol => symbol.sourceRef ? [symbol.sourceRef] : []));
    surface = symbols.length
      ? workspaceAnswerSurface("workspace.intent.call_relationship", symbols.map(symbol => `symbol.name=${symbol.name} called.by=${symbol.calledBy.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.call_relationship", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ symbols });
    confidence = symbols.length ? 0.74 : 0.34;
  } else if (includesAny(lower, ["route", "routes", "endpoint", "endpoints"])) {
    selectedIntentId = "workspace.intent.route_inventory";
    signals = ["route_inventory.surface", "route_inventory.source_extraction"];
    sourceRefs.push(...project.routes.flatMap(route => route.sourceRef ? [route.sourceRef] : []));
    surface = project.routes.length
      ? workspaceAnswerSurface("workspace.intent.route_inventory", project.routes.map(route => `route.method=${route.method} route.path=${route.path} route.source=${formatRef(route.sourceRef ?? { path: route.filePath })}`))
      : workspaceAnswerSurface("workspace.intent.route_inventory", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ routes: project.routes });
    confidence = project.routes.length ? 0.84 : 0.4;
  } else if (includesAny(lower, ["cli", "command", "commands", "script", "scripts"])) {
    selectedIntentId = "workspace.intent.command_inventory";
    signals = ["command_inventory.surface", "command_inventory.package_evidence"];
    sourceRefs.push(...project.commands.flatMap(command => command.sourceRef ? [command.sourceRef] : []));
    surface = project.commands.length
      ? workspaceAnswerSurface("workspace.intent.command_inventory", project.commands.map(command => `command.name=${command.name} command.value=${command.command} command.source=${formatRef(command.sourceRef ?? { path: command.sourcePath })}`))
      : workspaceAnswerSurface("workspace.intent.command_inventory", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ commands: project.commands });
    confidence = project.commands.length ? 0.84 : 0.4;
  } else if (includesAny(lower, ["test", "tests", "covered", "coverage"])) {
    selectedIntentId = "workspace.intent.test_surface";
    signals = ["test_surface.surface", "test_surface.source_roles"];
    const modules = project.map.modules.filter(module => module.roles.includes("source.role.test") || module.path.toLocaleLowerCase().includes("test"));
    sourceRefs.push(...modules.flatMap(module => module.sourceRefs));
    surface = modules.length
      ? workspaceAnswerSurface("workspace.intent.test_surface", modules.map(module => `module.path=${module.path} declaration.count=${module.declarations} import.count=${module.imports}`))
      : workspaceAnswerSurface("workspace.intent.test_surface", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ tests: modules });
    confidence = modules.length ? 0.78 : 0.36;
  } else if (includesAny(lower, ["unused", "dead"])) {
    selectedIntentId = "workspace.intent.unused_export";
    signals = ["unused_export.surface", "unused_export.symbol_graph"];
    const findings = project.gaps.filter(item => item.kind === "exported_symbol_unused").slice(0, 12);
    sourceRefs.push(...findings.flatMap(item => item.sourceRefs));
    surface = findings.length
      ? workspaceAnswerSurface("workspace.intent.unused_export", findings.map(item => `finding.id=${item.id} finding.kind=${item.kind} affected.files=${item.affectedFiles.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.unused_export", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ findings });
    confidence = findings.length ? 0.72 : 0.44;
  } else if (includesAny(lower, ["risky", "riskiest", "risk"])) {
    selectedIntentId = "workspace.intent.risk_inventory";
    signals = ["risk_inventory.surface", "risk_inventory.finding_rank"];
    const risky = riskiestModules(project).slice(0, 8);
    sourceRefs.push(...risky.flatMap(item => item.sourceRefs));
    surface = risky.length
      ? workspaceAnswerSurface("workspace.intent.risk_inventory", risky.map(item => `module.path=${item.path} risk.score=${item.score.toFixed(2)} reasons=${item.reasons.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.risk_inventory", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ risky });
    confidence = risky.length ? 0.76 : 0.44;
  } else if (includesAny(lower, ["gap", "gaps", "missing", "tasks"])) {
    selectedIntentId = "workspace.intent.task_inventory";
    signals = ["task_inventory.surface", "task_inventory.findings"];
    sourceRefs.push(...project.tasks.slice(0, 12).flatMap(item => item.sourceRefs));
    surface = project.tasks.length
      ? workspaceAnswerSurface("workspace.intent.task_inventory", project.tasks.slice(0, 12).map((item, index) => `task.rank=${index + 1} task.id=${item.id} task.kind=${item.kind} affected.files=${item.affectedFiles.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.task_inventory", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ tasks: project.tasks });
    confidence = project.tasks.length ? 0.78 : 0.42;
  } else if (includesAny(lower, ["contradiction", "conflict", "conflicts"])) {
    selectedIntentId = "workspace.intent.contradiction_inventory";
    signals = ["contradiction_inventory.surface", "contradiction_inventory.findings"];
    sourceRefs.push(...project.contradictions.flatMap(item => item.sourceRefs));
    surface = project.contradictions.length
      ? workspaceAnswerSurface("workspace.intent.contradiction_inventory", project.contradictions.map(item => `finding.id=${item.id} finding.kind=${item.kind} affected.files=${item.affectedFiles.join(",")}`))
      : workspaceAnswerSurface("workspace.intent.contradiction_inventory", ["workspace.status.no_matching_record"]);
    data = toJsonValue({ contradictions: project.contradictions });
    confidence = project.contradictions.length ? 0.8 : 0.46;
  } else if (includesAny(lower, ["summary", "overview", "inventory", "map"])) {
    selectedIntentId = "workspace.intent.general_summary";
    signals = ["general_summary.surface", "general_summary.project_counts"];
    sourceRefs.push(...project.summary.sourceRefs);
    surface = project.summary.body;
    data = toJsonValue({ summary: project.summary, counts: project.summary.counts });
    confidence = 0.68;
  } else {
    fallbackReason = "workspace.query.unsupported_intent";
    surface = workspaceAnswerSurface("workspace.intent.unsupported", ["workspace.status.unsupported_intent"]);
    data = toJsonValue({
      questionTerms: terms,
      supportedIntentIds: [
        "workspace.intent.symbol_definition",
        "workspace.intent.route_inventory",
        "workspace.intent.command_inventory",
        "workspace.intent.import_relationship",
        "workspace.intent.call_relationship",
        "workspace.intent.test_surface",
        "workspace.intent.unused_export",
        "workspace.intent.risk_inventory",
        "workspace.intent.task_inventory",
        "workspace.intent.contradiction_inventory",
        "workspace.intent.general_summary"
      ]
    });
    confidence = 0.18;
  }
  const refs = uniqueRefs(sourceRefs);
  return {
    schema: "scce.workspace.answer.v1",
    path: WORKSPACE_QUERY_ADAPTER_PATH,
    generatedBy: "workspace_query_adapter",
    selectedIntentId,
    intentEvidence: workspaceIntentEvidence(project, signals, terms, refs),
    fallbackReason,
    question,
    answer: surface,
    confidence,
    sourceRefs: refs,
    data
  };
}

function normalizeOptions(options: WorkspaceRuntimeOptions): Required<WorkspaceRuntimeOptions> {
  return {
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_OPTIONS.maxFiles),
    maxFileBytes: Math.max(1024, options.maxFileBytes ?? DEFAULT_OPTIONS.maxFileBytes),
    maxDepth: Math.max(0, options.maxDepth ?? DEFAULT_OPTIONS.maxDepth),
    includeUnsupported: options.includeUnsupported ?? DEFAULT_OPTIONS.includeUnsupported,
    maxDocumentBytes: Math.max(4096, options.maxDocumentBytes ?? DEFAULT_OPTIONS.maxDocumentBytes),
    conversationId: options.conversationId ?? DEFAULT_OPTIONS.conversationId,
    targetLanguage: options.targetLanguage ?? DEFAULT_OPTIONS.targetLanguage,
    useKernelAnswer: options.useKernelAnswer ?? DEFAULT_OPTIONS.useKernelAnswer
  };
}

function workspaceRecord(root: string, now: number, metadata: unknown): WorkspaceRecord {
  const rootPath = path.resolve(root);
  const rootUri = fileUri(rootPath);
  const id = `workspace_${hashParts(rootPath.toLocaleLowerCase()).slice(0, 32)}`;
  const corpusId = `corpus_${hashParts(rootUri).slice(0, 32)}`;
  return { id, rootPath, rootUri, corpusId, status: "active", createdAt: now, updatedAt: now, metadata: toJsonValue({ options: metadata }) };
}

async function workspaceSources(workspace: WorkspaceRecord, inspection: EngineeringCorpusFolderInspection, repo: RepoIntelligenceAnalysis): Promise<WorkspaceSourceFileRecord[]> {
  const symbolsByPath = new Map<string, string[]>();
  for (const symbol of repo.snapshot.symbolGraph.nodes) {
    const list = symbolsByPath.get(symbol.sourcePath) ?? [];
    list.push(symbol.id);
    symbolsByPath.set(symbol.sourcePath, list);
  }
  const importable = inspection.files.filter(file => file.importable);
  const records: WorkspaceSourceFileRecord[] = [];
  for (const file of importable) {
    const info = await stat(file.absolutePath);
    records.push({
      workspaceId: workspace.id,
      corpusId: workspace.corpusId,
      path: normalizePath(file.path),
      absolutePath: file.absolutePath,
      mediaType: file.mediaType,
      contentHash: file.contentHash as never,
      modifiedTime: info.mtimeMs,
      byteLength: file.byteLength,
      ingestionStatus: "pending",
      evidenceIds: repo.snapshot.evidenceSpans.filter(span => span.sourcePath === normalizePath(file.path)).map(span => span.id as never),
      symbolIds: symbolsByPath.get(normalizePath(file.path)) ?? [],
      conceptIds: [],
      warnings: file.warnings,
      errors: [],
      metadata: toJsonValue({
        extractor: file.extractor,
        supportedSections: file.supportedSections,
        unsupportedSections: file.unsupportedSections,
        sourceKind: file.sourceKind
      }),
      updatedAt: Date.now()
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadDocumentLines(root: string, inspection: EngineeringCorpusFolderInspection, options: Required<WorkspaceRuntimeOptions>): Promise<DocumentLine[]> {
  const docs: DocumentLine[] = [];
  for (const file of inspection.files.filter(isDocumentLike).slice(0, options.maxFiles)) {
    if (file.byteLength > options.maxDocumentBytes) continue;
    const text = await readTextBounded(file.absolutePath, options.maxDocumentBytes);
    const lines = splitLines(text);
    for (let index = 0; index < lines.length; index++) {
      const line = collapseSpace(lines[index] ?? "");
      if (!line) continue;
      docs.push({ path: normalizePath(path.relative(root, file.absolutePath)), line: index + 1, text: line, contentHash: file.contentHash });
      if (docs.length >= 20000) return docs;
    }
  }
  return docs;
}

function isDocumentLike(file: EngineeringCorpusFileInspection): boolean {
  return file.importable && (file.extractor === "document_text" || file.extractor === "structured_json" || file.extractor === "structured_json_lines" || file.extractor === "document_metadata_fixture");
}

async function collectCallSites(root: string, repo: RepoIntelligenceAnalysis, options: Required<WorkspaceRuntimeOptions>): Promise<CallSite[]> {
  const sourcePaths = repo.snapshot.files
    .filter(file => file.kind === "source_file" && file.byteLength <= options.maxFileBytes)
    .map(file => file.sourcePath)
    .slice(0, options.maxFiles);
  const calls: CallSite[] = [];
  for (const sourcePath of sourcePaths) {
    const absolute = path.join(root, sourcePath);
    const text = await readTextBounded(absolute, options.maxFileBytes).catch(() => "");
    const lines = splitLines(text);
    for (let i = 0; i < lines.length && i < 16000; i++) {
      for (const name of callNames(lines[i] ?? "")) calls.push({ symbol: name, path: sourcePath, line: i + 1 });
      if (calls.length >= 50000) return calls;
    }
  }
  return calls;
}

function symbolSummaries(repo: RepoIntelligenceAnalysis, docs: DocumentLine[], calls: CallSite[]): WorkspaceSymbolSummary[] {
  const imports = repo.snapshot.symbolGraph.imports;
  const docText = docs.map(line => ({ ...line, lower: line.text.toLocaleLowerCase() }));
  return repo.snapshot.symbolGraph.nodes.map(symbol => {
    const lower = symbol.name.toLocaleLowerCase();
    const importedBy = imports
      .filter(item => item.importedNames.some(name => name === symbol.name) || item.moduleSpecifier.includes(symbol.name))
      .map(item => item.sourcePath)
      .sort();
    const mentionedByDocs = docText.filter(line => line.lower.includes(lower)).slice(0, 16).map(line => `${line.path}:${line.line}`);
    const calledBy = calls.filter(call => call.symbol === symbol.name).slice(0, 32).map(call => `${call.path}:${call.line}`);
    return {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.symbolKind,
      path: symbol.sourcePath,
      exported: symbol.exported,
      defaultExport: symbol.defaultExport,
      sourceRef: refFromEvidence(symbol.sourcePath, symbol.evidenceSpan),
      importedBy,
      mentionedByDocs,
      calledBy
    };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

function commandSummaries(repo: RepoIntelligenceAnalysis): WorkspaceCommandSummary[] {
  return repo.snapshot.buildGraph.scripts.map(script => ({
    id: script.id,
    name: script.scriptName,
    command: script.command,
    sourcePath: script.sourcePath,
    kind: script.kind,
    sourceRef: refFromEvidence(script.sourcePath, script.evidenceSpan)
  })).sort((a, b) => a.name.localeCompare(b.name) || a.command.localeCompare(b.command));
}

async function routeSummaries(root: string, repo: RepoIntelligenceAnalysis, sources: readonly WorkspaceSourceFileRecord[], options: Required<WorkspaceRuntimeOptions>): Promise<WorkspaceRouteSummary[]> {
  const sourceByPath = new Map(sources.map(source => [normalizePath(source.path), source]));
  const out: WorkspaceRouteSummary[] = [];
  for (const route of repo.snapshot.engineeringContext.routes) {
    out.push({
      id: route.id,
      method: route.method,
      path: route.path,
      filePath: route.filePath,
      handlerHint: route.handlerHint,
      sourceRef: await routeSourceRef(root, route, sourceByPath.get(normalizePath(route.filePath)), options)
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

async function routeSourceRef(
  root: string,
  route: RepoSnapshot["engineeringContext"]["routes"][number],
  source: WorkspaceSourceFileRecord | undefined,
  options: Required<WorkspaceRuntimeOptions>
): Promise<WorkspaceSourceRef | undefined> {
  const normalizedPath = normalizePath(route.filePath);
  const observedEvidenceId = route.evidenceIds.length ? String(route.evidenceIds[0]) : undefined;
  const line = await sourceLineContaining(root, normalizedPath, route.path, options).catch(() => undefined);
  const evidenceSpanId = observedEvidenceId ?? (line && source?.contentHash ? routeEvidenceSpanId(route, source.contentHash, line.line) : undefined);
  return {
    path: normalizedPath,
    lineStart: line?.line,
    lineEnd: line?.line,
    evidenceSpanId,
    contentHash: source?.contentHash
  };
}

async function sourceLineContaining(root: string, sourcePath: string, needle: string, options: Required<WorkspaceRuntimeOptions>): Promise<{ line: number; text: string } | undefined> {
  if (!needle) return undefined;
  const absolute = path.join(root, sourcePath);
  const text = await readTextBounded(absolute, options.maxFileBytes);
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.includes(needle)) return { line: index + 1, text: line };
  }
  return undefined;
}

function routeEvidenceSpanId(route: RepoSnapshot["engineeringContext"]["routes"][number], contentHash: string, line: number): string {
  return `developer_route_${hashParts(route.id, route.filePath, route.method, route.path, contentHash, line).slice(0, 40)}`;
}

function detectContradictions(root: string, repo: RepoIntelligenceAnalysis, docs: DocumentLine[], commands: WorkspaceCommandSummary[], routes: WorkspaceRouteSummary[]): WorkspaceFinding[] {
  const findings: WorkspaceFinding[] = [];
  const commandNames = new Set(commands.map(command => command.name));
  const commandTexts = new Set(commands.map(command => command.command));
  const routePaths = new Set(routes.map(route => route.path));
  const knownFiles = new Set(repo.snapshot.files.map(file => file.sourcePath));

  for (const line of docs) {
    const lower = line.text.toLocaleLowerCase();
    if (includesAny(lower, ["command", "script", "run", "cli"])) {
      for (const quoted of quotedSegments(line.text)) {
        const command = quoted.trim();
        if (!command || command.length > 120 || !looksCommandLike(command)) continue;
        const scriptName = shellWords(command)[0] ?? command;
        if (!commandNames.has(scriptName) && !commandTexts.has(command)) {
          findings.push(finding("doc_claim_missing_cli_command", "warning", `Documentation claims command '${command}', but package scripts do not expose it.`, [lineRef(line)], [], "Add the script, correct the documentation, or cite the external command surface.", 0.76, { command }));
        }
      }
    }
    for (const route of routeSegments(line.text)) {
      if (!routePaths.has(route)) {
        findings.push(finding("doc_claim_missing_route", "warning", `Documentation claims route '${route}', but source route extraction did not find it.`, [lineRef(line)], [], "Add the route handler or update the documentation.", 0.78, { route }));
      }
    }
  }

  for (const script of commands) {
    for (const candidate of shellWords(script.command)) {
      const normalized = normalizePath(candidate);
      if (!looksPathLike(normalized) || normalized.startsWith("-")) continue;
      if (knownFiles.has(normalized)) continue;
      const exists = fileExistsSyncish(root, normalized);
      if (!exists) findings.push(finding("package_script_missing_path", "high", `Script '${script.name}' references missing path '${candidate}'.`, [script.sourceRef ?? { path: script.sourcePath }], [script.sourcePath], "Create the referenced file/path or correct the script.", 0.82, { script: script.name, command: script.command, path: candidate }));
    }
  }

  const valuesByKey = new Map<string, Array<{ value: string; ref: WorkspaceSourceRef }>>();
  for (const line of docs) {
    const kv = keyValueClaim(line.text);
    if (!kv || kv.value.length > 80) continue;
    const key = kv.key.toLocaleLowerCase();
    const current = valuesByKey.get(key) ?? [];
    current.push({ value: kv.value, ref: lineRef(line) });
    valuesByKey.set(key, current);
  }
  for (const [key, values] of valuesByKey) {
    const uniqueValues = [...new Set(values.map(value => value.value.toLocaleLowerCase()))];
    if (uniqueValues.length <= 1) continue;
    findings.push(finding("document_value_conflict", "warning", `Documents give conflicting values for '${key}'.`, values.map(value => value.ref).slice(0, 8), [], "Choose the authoritative value and update the conflicting document lines.", 0.68, { key, values: values.slice(0, 8) }));
  }

  return uniqueFindings(findings);
}

function detectGaps(repo: RepoIntelligenceAnalysis, docs: DocumentLine[], symbols: WorkspaceSymbolSummary[], commands: WorkspaceCommandSummary[], routes: WorkspaceRouteSummary[]): WorkspaceFinding[] {
  const findings: WorkspaceFinding[] = [];
  const docBlob = docs.map(line => line.text.toLocaleLowerCase()).join("\n");
  const testFiles = new Set(repo.snapshot.testGraph.testFiles.map(file => file.sourcePath));
  const importedNames = new Set(repo.snapshot.symbolGraph.imports.flatMap(item => item.importedNames));

  for (const symbol of symbols.filter(item => item.exported)) {
    if (!importedNames.has(symbol.name) && !symbol.calledBy.length) {
      findings.push(finding("exported_symbol_unused", "info", `Exported symbol '${symbol.name}' has no observed import or call site.`, symbol.sourceRef ? [symbol.sourceRef] : [{ path: symbol.path }], [symbol.path], "Confirm it is public API, add usage, or remove the export.", 0.64, { symbol: symbol.name }));
    }
    if (!docBlob.includes(symbol.name.toLocaleLowerCase())) {
      findings.push(finding("public_api_undocumented", "warning", `Exported symbol '${symbol.name}' is not mentioned in indexed documentation.`, symbol.sourceRef ? [symbol.sourceRef] : [{ path: symbol.path }], [symbol.path], "Add concise API documentation with source-bound examples.", 0.66, { symbol: symbol.name }));
    }
    if (!symbol.calledBy.some(site => testFiles.has(site.split(":")[0] ?? "")) && !symbol.importedBy.some(file => testFiles.has(file))) {
      findings.push(finding("exported_symbol_missing_test_support", "warning", `Exported symbol '${symbol.name}' has no observed test support.`, symbol.sourceRef ? [symbol.sourceRef] : [{ path: symbol.path }], [symbol.path], "Add a test or cite the existing integration coverage.", 0.62, { symbol: symbol.name }));
    }
  }
  for (const command of commands) {
    if (!docBlob.includes(command.name.toLocaleLowerCase()) && !docBlob.includes(command.command.toLocaleLowerCase())) {
      findings.push(finding("command_undocumented", "info", `Command '${command.name}' is exposed but not documented.`, command.sourceRef ? [command.sourceRef] : [{ path: command.sourcePath }], [command.sourcePath], "Document the command, expected use, and validation behavior.", 0.58, { command: command.name }));
    }
  }
  for (const route of routes) {
    if (!docBlob.includes(route.path.toLocaleLowerCase())) {
      findings.push(finding("route_undocumented", "warning", `Route '${route.method} ${route.path}' is exposed but not documented.`, route.sourceRef ? [route.sourceRef] : [{ path: route.filePath }], [route.filePath], "Document the route contract or mark it internal.", 0.64, { route: route.path }));
    }
  }
  if (!repo.snapshot.testGraph.testCommands.length && symbols.some(symbol => symbol.exported)) {
    findings.push(finding("missing_test_command", "high", "Repository exposes exported symbols but no test command was observed.", [], [], "Add an observed package test command or a validation command in project config.", 0.8, {}));
  }
  if (!repo.snapshot.buildGraph.buildCommands.length && repo.snapshot.summary.sourceFileCount > 0) {
    findings.push(finding("missing_build_command", "warning", "Source files are present but no build command was observed.", [], [], "Add an observed package build command or document the build procedure.", 0.72, {}));
  }
  return uniqueFindings(findings);
}

function prioritizedTasks(findings: WorkspaceFinding[], repo: RepoIntelligenceAnalysis): WorkspaceFinding[] {
  const tasks = findings
    .map(item => ({ ...item, kind: `task.${item.kind}`, metadata: mergeMetadata(item.metadata, { sourceFindingKind: item.kind }) }))
    .sort((a, b) => FINDING_RANK[b.severity] - FINDING_RANK[a.severity] || b.confidence - a.confidence || a.statement.localeCompare(b.statement));
  if (!tasks.length && repo.snapshot.summary.sourceFileCount > 0) {
    tasks.push(finding("task.workspace_hardening", "info", "No blocking gaps were detected; next useful work is hardening docs, tests, and route/command contracts.", [], [], "Run build/test and promote any diagnostics into workspace findings.", 0.5, {}));
  }
  return tasks.slice(0, 80);
}

function attachCoreRecords(findings: WorkspaceFinding[], links: Array<{ findingId: string; recordId: string; learningNeedId?: string; plannerInputId?: string }>): WorkspaceFinding[] {
  const byFinding = new Map<string, Array<{ recordId: string; learningNeedId?: string; plannerInputId?: string }>>();
  for (const link of links) byFinding.set(link.findingId, [...(byFinding.get(link.findingId) ?? []), link]);
  return findings.map(item => {
    const matched = byFinding.get(item.id) ?? [];
    if (!matched.length) return item;
    return {
      ...item,
      metadata: mergeMetadata(item.metadata, {
        promotedCoreRecordIds: matched.map(link => link.recordId).sort(),
        promotedLearningNeedIds: matched.flatMap(link => link.learningNeedId ? [link.learningNeedId] : []).sort(),
        promotedPlannerInputIds: matched.flatMap(link => link.plannerInputId ? [link.plannerInputId] : []).sort()
      })
    };
  });
}

function projectSummary(inspection: EngineeringCorpusFolderInspection, repo: RepoIntelligenceAnalysis, commands: WorkspaceCommandSummary[], routes: WorkspaceRouteSummary[]): WorkspaceProjectReport["summary"] {
  const refs = [
    ...commands.slice(0, 3).flatMap(command => command.sourceRef ? [command.sourceRef] : []),
    ...routes.slice(0, 3).flatMap(route => route.sourceRef ? [route.sourceRef] : []),
    ...repo.snapshot.evidenceSpans.slice(0, 3).map(span => refFromCodeSpan(span.sourcePath, span))
  ];
  const counts = {
    files: inspection.totals.filesFound,
    importableFiles: inspection.totals.filesImportable,
    sourceFiles: repo.snapshot.summary.sourceFileCount,
    symbols: repo.snapshot.summary.symbolCount,
    imports: repo.snapshot.summary.importCount,
    exports: repo.snapshot.summary.exportCount,
    dependencies: repo.snapshot.summary.dependencyCount,
    commands: commands.length,
    routes: routes.length,
    tests: repo.snapshot.summary.testCommandCount
  };
  const body = [
    `Workspace contains ${counts.files} files (${counts.importableFiles} importable), ${counts.sourceFiles} source files, ${counts.symbols} symbols, ${counts.dependencies} dependencies, ${counts.commands} commands, and ${counts.routes} routes.`,
    `Primary package managers: ${repo.snapshot.engineeringContext.plannerHints.packageManagers.join(", ") || "none observed"}.`,
    `Hydration contract valid: ${repo.snapshot.hydration.valid}.`
  ].join("\n");
  return { body, sourceRefs: uniqueRefs(refs), counts };
}

function projectMap(repo: RepoIntelligenceAnalysis): WorkspaceProjectReport["map"] {
  const groups = new Map<string, { files: number; symbols: number; routes: number; tests: number; refs: WorkspaceSourceRef[] }>();
  for (const file of repo.snapshot.files) {
    const root = firstPathPiece(file.sourcePath);
    const current = groups.get(root) ?? { files: 0, symbols: 0, routes: 0, tests: 0, refs: [] };
    current.files++;
    if (file.kind === "source_file") {
      current.symbols += file.declarationCount;
      current.tests += file.testCount;
    }
    current.refs.push({ path: file.sourcePath, contentHash: file.sourceHash });
    groups.set(root, current);
  }
  for (const route of repo.snapshot.engineeringContext.routes) {
    const root = firstPathPiece(route.filePath);
    const current = groups.get(root) ?? { files: 0, symbols: 0, routes: 0, tests: 0, refs: [] };
    current.routes++;
    groups.set(root, current);
  }
  return {
    components: [...groups.entries()].map(([path, value]) => ({
      path,
      kind: componentKind(path),
      files: value.files,
      symbols: value.symbols,
      routes: value.routes,
      tests: value.tests,
      sourceRefs: uniqueRefs(value.refs.slice(0, 8))
    })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)),
    modules: repo.snapshot.files.filter(file => file.kind === "source_file").map(file => ({
      path: file.sourcePath,
      languageId: file.languageId,
      declarations: file.kind === "source_file" ? file.declarationCount : 0,
      imports: file.kind === "source_file" ? file.importCount : 0,
      exports: file.kind === "source_file" ? file.exportCount : 0,
      roles: file.roles,
      sourceRefs: [{ path: file.sourcePath, contentHash: file.sourceHash }]
    })).sort((a, b) => b.declarations - a.declarations || a.path.localeCompare(b.path))
  };
}

function citedBrief(summary: WorkspaceProjectReport["summary"], contradictions: WorkspaceFinding[], gaps: WorkspaceFinding[], tasks: WorkspaceFinding[]): string {
  const sourceBacked = sourceBackedFindings([...contradictions, ...gaps]);
  const sourceBackedTasks = sourceBackedFindings(tasks);
  return [
    "# Workspace Brief",
    "",
    summary.body,
    "",
    "## Highest Risk Findings",
    ...(sourceBacked.length ? sourceBacked.sort((a, b) => FINDING_RANK[b.severity] - FINDING_RANK[a.severity]).slice(0, 8).map(item => `- ${item.severity}: ${item.statement} ${formatRefs(item.sourceRefs)}`) : ["[scce:workspace.findings.empty]"]),
    "",
    "## Next Tasks",
    ...(sourceBackedTasks.length ? sourceBackedTasks.slice(0, 8).map((item, index) => `${index + 1}. ${item.suggestedFix} ${formatRefs(item.sourceRefs)}`) : ["[scce:workspace.tasks.empty]"])
  ].join("\n");
}

function patchPlan(tasks: WorkspaceFinding[]): string {
  const sourceBackedTasks = sourceBackedFindings(tasks);
  if (!sourceBackedTasks.length) return ["# Patch Plan", "", "[scce:workspace.tasks.empty]"].join("\n");
  const byFile = new Map<string, WorkspaceFinding[]>();
  for (const task of sourceBackedTasks) {
    const files = task.affectedFiles.length ? task.affectedFiles : task.sourceRefs.map(ref => ref.path);
    for (const file of files) byFile.set(file, [...(byFile.get(file) ?? []), task]);
  }
  const lines = ["# Patch Plan", ""];
  for (const [file, fileTasks] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${file}`);
    for (const task of fileTasks.slice(0, 12)) lines.push(`- ${task.suggestedFix} (${task.kind}; core ${metadataCoreIds(task).join(",")}) ${formatRefs(task.sourceRefs)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function handoffNote(summary: WorkspaceProjectReport["summary"], tasks: WorkspaceFinding[], repo: RepoIntelligenceAnalysis): string {
  const sourceBackedTasks = sourceBackedFindings(tasks);
  return [
    "# Handoff",
    "",
    summary.body,
    "",
    `Hydration: ${repo.snapshot.hydration.valid ? "valid" : "invalid"}; warnings: ${repo.snapshot.warnings.length}.`,
    "",
    "## Start Here",
    ...(sourceBackedTasks.length ? sourceBackedTasks.slice(0, 10).map((task, index) => `${index + 1}. ${task.statement} -> ${task.suggestedFix} ${formatRefs(task.sourceRefs)}`) : ["[scce:workspace.handoff.empty]"])
  ].join("\n");
}

function hostileReview(contradictions: WorkspaceFinding[], gaps: WorkspaceFinding[]): string {
  const findings = sourceBackedFindings([...contradictions, ...gaps]).sort((a, b) => FINDING_RANK[b.severity] - FINDING_RANK[a.severity] || b.confidence - a.confidence);
  return [
    "# Review",
    "",
    ...(findings.length ? findings.map(item => `- [${item.severity}] ${item.statement} -> ${item.suggestedFix} ${formatRefs(item.sourceRefs)}`) : ["[scce:workspace.review.empty]"])
  ].join("\n");
}

function reportBody(project: WorkspaceProjectReport, kind: WorkspaceReportRecord["reportKind"]): string {
  const builders: Record<WorkspaceReportRecord["reportKind"], () => string> = {
    summary: () => project.summary.body,
    map: () => JSON.stringify(project.map, null, 2),
    symbols: () => project.symbols.map(symbol => `${symbol.name} ${symbol.kind} ${formatRef(symbol.sourceRef ?? { path: symbol.path })}`).join("\n"),
    gaps: () => project.gaps.map(item => `${item.severity}: ${item.statement}`).join("\n"),
    contradictions: () => project.contradictions.map(item => `${item.severity}: ${item.statement}`).join("\n"),
    tasks: () => project.tasks.map((item, index) => `${index + 1}. ${item.statement} -> ${item.suggestedFix}`).join("\n"),
    brief: () => project.reports.brief,
    patch_plan: () => project.reports.patchPlan,
    handoff: () => project.reports.handoff,
    review: () => project.reports.review,
    answer: () => project.summary.body
  };
  return builders[kind]();
}

function reportRefs(project: WorkspaceProjectReport, kind: WorkspaceReportRecord["reportKind"]): WorkspaceSourceRef[] {
  if (kind === "gaps") return uniqueRefs(project.gaps.flatMap(item => item.sourceRefs));
  if (kind === "contradictions") return uniqueRefs(project.contradictions.flatMap(item => item.sourceRefs));
  if (kind === "tasks" || kind === "patch_plan" || kind === "handoff" || kind === "review") return uniqueRefs(project.tasks.flatMap(item => item.sourceRefs));
  if (kind === "symbols") return uniqueRefs(project.symbols.flatMap(item => item.sourceRef ? [item.sourceRef] : []));
  return project.summary.sourceRefs;
}

function workspaceReportRecord(workspace: WorkspaceRecord, kind: WorkspaceReportRecord["reportKind"], title: string, body: string, data: JsonValue, refs: WorkspaceSourceRef[]): WorkspaceReportRecord {
  const createdAt = Date.now();
  const sourceRefs = uniqueRefs(refs);
  const payload = jsonRecord(data);
  const generatedBy = kind === "answer" && typeof payload.generatedBy === "string" ? payload.generatedBy : kind === "answer" ? "workspace_query_adapter" : WORKSPACE_REPORT_TEMPLATE;
  return {
    id: `workspace_report_${hashParts(workspace.id, kind, title, body.slice(0, 2048)).slice(0, 40)}`,
    workspaceId: workspace.id,
    corpusId: workspace.corpusId,
    reportKind: kind,
    title,
    body,
    data: toJsonValue({
      generatedBy,
      reportKind: kind,
      sourceRefCount: sourceRefs.length,
      sourceRefs,
      payload: data
    }),
    sourceRefs: toJsonValue(sourceRefs),
    createdAt
  };
}

async function persistProjectReports(runtime: NodeScceRuntime, project: WorkspaceProjectReport): Promise<void> {
  for (const kind of ["summary", "map", "symbols", "gaps", "contradictions", "tasks", "brief", "patch_plan", "handoff", "review"] as const) {
    const record = workspaceReportRecord(project.workspace, kind, reportTitle(kind), reportBody(project, kind), project as unknown as JsonValue, reportRefs(project, kind));
    await runtime.storage.workspace.putReport(record);
  }
}

function reportTitle(kind: WorkspaceReportRecord["reportKind"]): string {
  if (kind === "patch_plan") return "Patch plan";
  return kind.split("_").map(capitalize).join(" ");
}

function finding(kind: string, severity: WorkspaceFinding["severity"], statement: string, refs: WorkspaceSourceRef[], affectedFiles: string[], suggestedFix: string, confidence: number, metadata: unknown): WorkspaceFinding {
  const sourceRefs = uniqueRefs(refs);
  const files = [...new Set(affectedFiles)].sort();
  return {
    id: `finding_${hashParts(kind, statement, sourceRefs.map(formatRef)).slice(0, 40)}`,
    kind,
    severity,
    statement,
    sourceRefs,
    affectedFiles: files,
    suggestedFix,
    confidence,
    metadata: mergeMetadata(toJsonValue(metadata), {
      originatingEvidence: {
        sourceRefs,
        sourceRefCount: sourceRefs.length,
        affectedFiles: files
      }
    })
  };
}

function sourceBackedFindings(findings: WorkspaceFinding[]): WorkspaceFinding[] {
  return findings.filter(item => item.sourceRefs.length > 0);
}

function metadataCoreIds(finding: WorkspaceFinding): string[] {
  if (!finding.metadata || typeof finding.metadata !== "object" || Array.isArray(finding.metadata)) return [];
  const value = finding.metadata.promotedCoreRecordIds;
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function matchingSymbols(symbols: WorkspaceSymbolSummary[], terms: readonly string[]): WorkspaceSymbolSummary[] {
  const normalized = terms.map(term => term.toLocaleLowerCase());
  return symbols
    .map(symbol => {
      const hay = [symbol.name, symbol.path, symbol.kind].join(" ").toLocaleLowerCase();
      const score = normalized.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0);
      return { symbol, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.name.localeCompare(b.symbol.name))
    .map(item => item.symbol);
}

function workspaceIntentEvidence(project: WorkspaceProjectReport, signals: string[], terms: string[], refs: WorkspaceSourceRef[]): WorkspaceIntentEvidence {
  return {
    signals,
    observedTerms: [...new Set(terms)].sort().slice(0, 32),
    candidateCounts: {
      symbols: project.symbols.length,
      routes: project.routes.length,
      commands: project.commands.length,
      gaps: project.gaps.length,
      contradictions: project.contradictions.length,
      tasks: project.tasks.length,
      sourceRefs: refs.length
    },
    sourceRefs: refs
  };
}

function workspaceAnswerSurface(intentId: string, lines: readonly string[]): string {
  return [`workspace.answer.intent=${intentId}`, ...lines].join("\n");
}

function riskiestModules(project: WorkspaceProjectReport): Array<{ path: string; score: number; reasons: string[]; sourceRefs: WorkspaceSourceRef[] }> {
  const byPath = new Map<string, { score: number; reasons: string[]; refs: WorkspaceSourceRef[] }>();
  for (const item of [...project.contradictions, ...project.gaps]) {
    const paths = item.affectedFiles.length ? item.affectedFiles : item.sourceRefs.map(ref => ref.path);
    for (const path of paths) {
      const current = byPath.get(path) ?? { score: 0, reasons: [], refs: [] };
      current.score += FINDING_RANK[item.severity] * item.confidence;
      current.reasons.push(item.kind);
      current.refs.push(...item.sourceRefs);
      byPath.set(path, current);
    }
  }
  return [...byPath.entries()].map(([path, value]) => ({ path, score: value.score, reasons: [...new Set(value.reasons)], sourceRefs: uniqueRefs(value.refs) })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function refFromEvidence(path: string, span: { id: string; lineStart?: number; lineEnd?: number; sourceHash?: string } | undefined): WorkspaceSourceRef | undefined {
  if (!span) return { path };
  return { path, lineStart: span.lineStart, lineEnd: span.lineEnd, evidenceSpanId: span.id, contentHash: span.sourceHash };
}

function refFromCodeSpan(path: string, span: { id: string; lineStart?: number; lineEnd?: number; sourceHash?: string }): WorkspaceSourceRef {
  return { path, lineStart: span.lineStart, lineEnd: span.lineEnd, evidenceSpanId: span.id, contentHash: span.sourceHash };
}

function lineRef(line: DocumentLine): WorkspaceSourceRef {
  return { path: line.path, lineStart: line.line, lineEnd: line.line, contentHash: line.contentHash };
}

function uniqueFindings(findings: WorkspaceFinding[]): WorkspaceFinding[] {
  const seen = new Map<string, WorkspaceFinding>();
  for (const item of findings) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()].sort((a, b) => FINDING_RANK[b.severity] - FINDING_RANK[a.severity] || b.confidence - a.confidence || a.statement.localeCompare(b.statement));
}

function uniqueRefs(refs: WorkspaceSourceRef[]): WorkspaceSourceRef[] {
  const seen = new Map<string, WorkspaceSourceRef>();
  for (const ref of refs) {
    const key = `${ref.path}:${ref.lineStart ?? ""}:${ref.lineEnd ?? ""}:${ref.evidenceSpanId ?? ""}:${ref.contentHash ?? ""}`;
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()].slice(0, 256);
}

function formatRefs(refs: readonly WorkspaceSourceRef[]): string {
  return refs.length ? refs.slice(0, 4).map(formatRef).join(", ") : "";
}

function formatRef(ref: WorkspaceSourceRef): string {
  const line = ref.lineStart ? `:${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `-${ref.lineEnd}` : ""}` : "";
  return `${ref.path}${line}`;
}

function workspaceMetadata(workspace: WorkspaceRecord): JsonValue {
  return toJsonValue({ id: workspace.id, rootPath: workspace.rootPath, rootUri: workspace.rootUri, corpusId: workspace.corpusId });
}

function mergeMetadata(left: JsonValue, right: unknown): JsonValue {
  const a = left && typeof left === "object" && !Array.isArray(left) ? left as Record<string, JsonValue> : {};
  const b = toJsonValue(right);
  const bRecord = b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, JsonValue> : {};
  return { ...a, ...bRecord };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function evidenceIdsFromPayload(payload: JsonValue): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const out: string[] = [];
  const visit = (value: JsonValue, depth: number) => {
    if (depth > 4 || value === null) return;
    if (typeof value === "string" && value.startsWith("ev_")) out.push(value);
    else if (Array.isArray(value)) for (const child of value) visit(child, depth + 1);
    else if (typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (key.toLocaleLowerCase().includes("evidence") && typeof child === "string") out.push(child);
      else visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return out;
}

async function latestWorkspaceRoot(runtime: NodeScceRuntime, config: ScceRuntimeConfig): Promise<string> {
  const latest = await runtime.storage.workspace.latestWorkspace();
  return latest?.rootPath ?? config.runtime.workspaceRoot;
}

async function planWorkspacePatchFromDurableRevision(args: {
  runtime: NodeScceRuntime;
  root: string;
  input: WorkspacePatchPlanningInput;
  options: Required<WorkspaceRuntimeOptions>;
}): Promise<WorkspacePatchPlanGenerationResult> {
  const revision = await loadDurableWorkspaceRevision(args);
  const { workspace, snapshot, durableHashByPath } = revision;
  const snapshotByPath = new Map(snapshot.files.map(file => [file.path, file]));
  const proposedFiles = args.input.proposedFiles.map((proposal, index) => {
    const workspacePath = normalizePath(proposal.path);
    const current = snapshotByPath.get(workspacePath);
    const durableHash = durableHashByPath.get(workspacePath);
    if (proposal.expectedContentHash === null) {
      const absolute = path.resolve(args.root, workspacePath);
      if (!isWithin(absolute, args.root)) throw new Error(`workspace creation path escapes root: ${workspacePath}`);
      if (current || existsSync(absolute)) throw new Error(`workspace creation target is not absent: ${workspacePath}`);
    } else if (!current || durableHash !== proposal.expectedContentHash) {
      throw new Error(`stale proposed base for ${workspacePath}: expected ${proposal.expectedContentHash}, found ${durableHash ?? "absent"}`);
    }
    const artifact: FileArtifact = {
      artifactId: ("workspace_artifact_" + hashParts(workspace.id, snapshot.revisionId, workspacePath, index).slice(0, 32)) as FileArtifact["artifactId"],
      path: workspacePath,
      mediaType: proposal.mediaType,
      content: proposal.content,
      contentHash: sha256ArtifactHash(Buffer.from(proposal.content, "utf8")) as FileArtifact["contentHash"],
      role: proposal.role
    };
    return { artifact, expectedBaseContentHash: current?.contentHash ?? null };
  });
  const deletions = (args.input.deletions ?? []).map(deletion => {
    const workspacePath = normalizePath(deletion.path);
    const current = snapshotByPath.get(workspacePath);
    const durableHash = durableHashByPath.get(workspacePath);
    if (!current || durableHash !== deletion.expectedContentHash) {
      throw new Error(`stale deletion base for ${workspacePath}: expected ${deletion.expectedContentHash}, found ${durableHash ?? "absent"}`);
    }
    return { path: workspacePath, expectedBaseContentHash: current.contentHash };
  });
  return generateWorkspacePatchPlan({
    snapshot,
    expectedRevisionId: snapshot.revisionId,
    expectedRevisionHash: snapshot.revisionHash,
    proposedFiles,
    deletions,
    requestedPaths: args.input.requestedPaths,
    assessment: args.input.assessment,
    validationPlan: args.input.validationPlan
  });
}

async function planWorkspaceCodingPatchFromDurableRevision(args: {
  runtime: NodeScceRuntime;
  root: string;
  input: WorkspaceCodingPatchPlanningInput;
  options: Required<WorkspaceRuntimeOptions>;
}): Promise<WorkspaceProgramPatchPlanGenerationResult> {
  const revision = await loadDurableWorkspaceRevision(args);
  const project = await analyzeWorkspaceProject(args.root, args.options);
  const programIntent = codingRequestProgramIntent(project, args.input);
  const kernel = await answerFromWorkspaceCoreContext({
    promotion: project.coreFusion,
    question: args.input.requestText,
    options: {
      programIntentOverride: programIntent
    }
  });
  const requestEvidenceIds = programIntent.provenanceEvidenceIds ?? [];
  assertCodingKernelAdmission(kernel, requestEvidenceIds);
  const program = kernel.program.programGraph;
  if (!program) {
    throw new Error("coding request is unsupported: workspace evidence did not produce a source-bound ProgramGraph");
  }
  if (requestEvidenceIds.length === 0) {
    throw new Error("coding request is unsupported: request has no source-bound workspace evidence");
  }
  const confirmedRevision = await loadDurableWorkspaceRevision(args);
  if (confirmedRevision.snapshot.revisionId !== revision.snapshot.revisionId
    || confirmedRevision.snapshot.revisionHash !== revision.snapshot.revisionHash) {
    throw new Error("coding request is unsupported: workspace revision changed while source evidence was being analyzed");
  }
  try {
    return generateWorkspacePatchPlanFromProgramGraph({
      snapshot: confirmedRevision.snapshot,
      expectedRevisionId: confirmedRevision.snapshot.revisionId,
      expectedRevisionHash: confirmedRevision.snapshot.revisionHash,
      request: {
        requestId: args.input.requestId,
        text: args.input.requestText,
        requestedPaths: args.input.requestedPaths,
        evidenceIds: requestEvidenceIds
      },
      program,
      existingDirectoryPaths: await verifiedProgramArtifactDirectories(args.root, program.files.map(file => file.path)),
      verifiedAbsentPaths: await verifiedProgramArtifactAbsences(args.root, program.files.map(file => file.path), confirmedRevision.snapshot),
      validationPlan: args.input.validationPlan
    });
  } catch (error) {
    throw new Error(`coding request is unsupported: ${messageOf(error)}`);
  }
}

function assertCodingKernelAdmission(kernel: WorkspaceKernelAnswerResult, requestEvidenceIds: readonly string[]): void {
  const entailment = kernel.entailment;
  if (kernel.statusId !== "workspace.kernel.answer.ready"
    || kernel.answerTrace.statusId !== "workspace.kernel.answer.ready"
    || kernel.answerGraph.statusId !== "workspace.kernel.answer.ready"
    || kernel.answerGraph.uncertainty.unsupported) {
    throw new Error("coding request is unsupported: request did not couple to an admissible workspace kernel answer");
  }
  if (entailment.verdict !== "entailed"
    || entailment.semanticVerdict !== "entailed"
    || entailment.force === "unknown"
    || entailment.force === "conjectured"
    || entailment.force === "invented"
    || entailment.support <= entailment.contradiction
    || kernel.answerGraph.uncertainty.contradictionCount > 0
    || kernel.answerTrace.contradictionRecordIds.length > 0) {
    throw new Error("coding request is unsupported: kernel entailment did not admit a contradiction-free program proposal");
  }
  const activeNodeIds = new Set((kernel.graph.field?.active ?? []).map(item => String(item.nodeId)));
  const activeEvidenceIds = new Set(kernel.graph.nodes
    .filter(node => activeNodeIds.has(String(node.id)))
    .flatMap(node => node.evidenceIds.map(String)));
  if (!kernel.graph.field?.requestFeatures.length
    || !kernel.graph.field.seeds.length
    || !requestEvidenceIds.some(evidenceId => activeEvidenceIds.has(evidenceId))) {
    throw new Error("coding request is unsupported: request activation is not coupled to its source evidence");
  }
}

async function verifiedProgramArtifactDirectories(root: string, artifactPaths: readonly string[]): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const directories = new Set<string>();
  try {
    const rootInfo = await lstat(resolvedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  directories.add("");
  for (const artifactPath of artifactPaths) {
    const normalized = normalizePath(artifactPath);
    const split = normalized.lastIndexOf("/");
    const parent = split < 0 ? "" : normalized.slice(0, split);
    if (directories.has(parent)) continue;
    let current = resolvedRoot;
    let verified = true;
    for (const segment of parent.split("/").filter(Boolean)) {
      current = path.resolve(current, segment);
      if (!isWithin(current, resolvedRoot)) {
        verified = false;
        break;
      }
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          verified = false;
          break;
        }
      } catch {
        verified = false;
        break;
      }
    }
    if (verified) directories.add(parent);
  }
  return [...directories].sort();
}

export async function verifiedProgramArtifactAbsences(
  root: string,
  artifactPaths: readonly string[],
  snapshot: WorkspaceRevisionSnapshot
): Promise<string[]> {
  const snapshotPaths = new Set(snapshot.files.map(file => file.path));
  const absent: string[] = [];
  for (const artifactPath of artifactPaths) {
    const normalized = normalizePath(artifactPath);
    if (snapshotPaths.has(normalized)) continue;
    const absolute = path.resolve(root, normalized);
    if (!isWithin(absolute, root)) continue;
    try {
      await lstat(absolute);
    } catch (error) {
      if (isFileNotFound(error)) absent.push(normalized);
      else throw error;
    }
  }
  return [...new Set(absent)].sort();
}

function codingRequestProgramIntent(
  project: WorkspaceProjectReport,
  request: WorkspaceCodingPatchPlanningInput
): Partial<ProgramConstructIntent> {
  const requested = new Set(request.requestedPaths.map(normalizePath));
  const requestedModules = project.map.modules.filter(module => requested.has(module.path));
  const requestedSymbols = project.symbols.filter(symbol => requested.has(symbol.path));
  const languageId = requestedModules[0]?.languageId ?? project.map.modules[0]?.languageId;
  const manager = observedPackageManager(project.commands);
  const validationRunner = observedValidationRunner(project.commands);
  const nodeRuntime = languageId ? /(?:typescript|javascript|\.tsx?|\.jsx?)/u.test(languageId.toLocaleLowerCase()) : false;
  const sourceBackedModule = requestedModules.length > 0 && requestedSymbols.some(symbol => symbol.exported);
  const provenanceEvidenceIds = [...new Set([
    ...requestedModules.flatMap(module => module.sourceRefs.map(ref => ref.evidenceSpanId).filter((id): id is string => Boolean(id))),
    ...requestedSymbols.map(symbol => symbol.sourceRef?.evidenceSpanId).filter((id): id is string => Boolean(id)),
    ...(validationRunner ? [validationRunner.evidenceSpanId] : [])
  ])].sort();
  return {
    artifactKindIds: sourceBackedModule ? ["program.artifact.library"] : ["program.artifact.workspace_full_file"],
    capabilityIds: sourceBackedModule ? ["capability:pure-call"] : ["program.capability.source_edit_plan"],
    ...(languageId ? { languageId } : {}),
    ...(manager ? { packageManagerId: manager } : {}),
    ...(manager ? { runtimeTargetId: `runtime.package:${manager}` } : nodeRuntime ? { runtimeTargetId: "runtime.node" } : {}),
    entrypointPath: request.requestedPaths[0],
    constraints: ["program.constraint.source_backed", "program.constraint.full_file_materialization"],
    provenanceEvidenceIds,
    metadata: toJsonValue({
      requestId: request.requestId,
      requestedPaths: request.requestedPaths,
      sourceBackedModule,
      nodeRuntime,
      languageSource: requestedModules[0]?.path ?? null,
      packageManagerSource: manager ? project.commands.find(command => command.command.trim().startsWith(manager))?.sourceRef ?? null : null,
      validationRunner
    })
  };
}

function observedValidationRunner(commands: readonly WorkspaceCommandSummary[]): {
  runnerId: "runtime.validation.vitest" | "runtime.validation.node-test";
  commandId: string;
  sourcePath: string;
  evidenceSpanId: string;
} | undefined {
  for (const command of commands) {
    const evidenceSpanId = command.sourceRef?.evidenceSpanId;
    if (!evidenceSpanId) continue;
    const tokens = command.command
      .trim()
      .split(/\s+/u)
      .map(token => token.replace(/^["']|["']$/gu, "").toLocaleLowerCase());
    const executableTokens = tokens.map(token => path.basename(token).replace(/\.cmd$|\.exe$/u, ""));
    if (executableTokens[0] === "vitest") {
      return { runnerId: "runtime.validation.vitest", commandId: command.id, sourcePath: command.sourcePath, evidenceSpanId };
    }
    if (executableTokens[0] === "node" && executableTokens.slice(1).includes("--test")) {
      return { runnerId: "runtime.validation.node-test", commandId: command.id, sourcePath: command.sourcePath, evidenceSpanId };
    }
  }
  return undefined;
}

function observedPackageManager(commands: readonly WorkspaceCommandSummary[]): string | undefined {
  for (const command of commands) {
    const executable = command.command.trim().split(/\s+/u)[0]?.toLocaleLowerCase();
    if (executable === "pnpm" || executable === "npm" || executable === "yarn" || executable === "bun") return executable;
  }
  return undefined;
}

async function loadDurableWorkspaceRevision(args: {
  runtime: NodeScceRuntime;
  root: string;
  input: Pick<WorkspacePatchPlanningInput, "workspaceId" | "expectedWorkspaceUpdatedAt">;
  options: Required<WorkspaceRuntimeOptions>;
}): Promise<{
  workspace: WorkspaceRecord;
  snapshot: WorkspaceRevisionSnapshot;
  durableHashByPath: Map<string, string>;
}> {
  const workspace = await args.runtime.storage.workspace.latestWorkspace();
  if (!workspace || workspace.id !== args.input.workspaceId) throw new Error("workspace patch planning requires the latest durable workspace");
  if (path.resolve(workspace.rootPath) !== path.resolve(args.root)) throw new Error("workspace patch planning root does not match the durable workspace");
  if (workspace.updatedAt !== args.input.expectedWorkspaceUpdatedAt) {
    throw new Error(`stale workspace revision: expected updatedAt ${args.input.expectedWorkspaceUpdatedAt}, found ${workspace.updatedAt}`);
  }
  const records = await args.runtime.storage.workspace.listSourceFiles({
    workspaceId: workspace.id,
    limit: args.options.maxFiles + 1
  });
  if (records.length === 0) throw new Error("workspace patch planning requires an ingested durable revision");
  if (records.length > args.options.maxFiles) throw new Error("workspace patch planning exceeded the configured file bound");
  const unusable = records.filter(record => record.ingestionStatus === "pending" || record.ingestionStatus === "changed" || record.ingestionStatus === "missing" || record.ingestionStatus === "failed");
  if (unusable.length) throw new Error(`workspace revision is not fully committed: ${unusable.map(record => record.path).sort().join(", ")}`);

  const durableHashByPath = new Map<string, string>();
  const revisionFiles: Array<{
    path: string;
    bytes: Uint8Array;
    mediaType: string;
    role: FileArtifact["role"];
  }> = [];
  for (const record of records.sort((left, right) => left.path.localeCompare(right.path))) {
    const workspacePath = normalizePath(record.path);
    const absolute = path.resolve(args.root, workspacePath);
    if (!isWithin(absolute, args.root)) throw new Error(`workspace revision path escapes root: ${workspacePath}`);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`workspace revision requires a regular non-symlink file: ${workspacePath}`);
    if (info.size > args.options.maxFileBytes) throw new Error(`workspace revision file exceeds configured byte bound: ${workspacePath}`);
    const bytes = await readBytesBounded(absolute, args.options.maxFileBytes);
    const durableHash = sha256ArtifactHash(bytes);
    if (!record.contentHash || String(record.contentHash) !== durableHash) {
      throw new Error(`stale durable workspace bytes for ${workspacePath}: expected ${String(record.contentHash ?? "missing")}, found ${durableHash}`);
    }
    durableHashByPath.set(workspacePath, durableHash);
    revisionFiles.push({
      path: workspacePath,
      bytes,
      mediaType: record.mediaType,
      role: workspaceFileRole(workspacePath)
    });
  }

  const revisionId = workspace.id + ":" + workspace.updatedAt;
  const snapshot = createWorkspaceRevisionSnapshot({
    workspaceId: workspace.id,
    revisionId,
    files: revisionFiles
  });
  return { workspace, snapshot, durableHashByPath };
}

function workspaceFileRole(workspacePath: string): FileArtifact["role"] {
  const normalized = normalizePath(workspacePath).toLocaleLowerCase();
  if (/(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[^/]+$/u.test(normalized)) return "test";
  if (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|vitest[^/]*\.[^/]+|\.github\/workflows\/[^/]+)$/u.test(normalized)) return "config";
  if (/\.(?:md|mdx|rst|adoc|txt)$/u.test(normalized)) return "doc";
  return "source";
}

function sha256ArtifactHash(bytes: Uint8Array): string {
  return `sha256_${createHash("sha256").update(bytes).digest("hex")}`;
}

function resolveAllowedRoot(target: string, config: ScceRuntimeConfig): string {
  const root = path.resolve(config.runtime.workspaceRoot, target);
  if (!config.runtime.allowedRoots.some(allowed => isWithin(root, allowed))) throw new Error(`workspace path outside allowedRoots: ${root}`);
  return root;
}

function isWithin(candidate: string, root: string): boolean {
  const c = path.resolve(candidate).toLocaleLowerCase();
  const r = path.resolve(root).toLocaleLowerCase();
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function fileUri(filePath: string): string {
  return `file://${filePath.split(path.sep).join("/")}`;
}

function hashParts(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function readTextBounded(filePath: string, maxBytes: number): Promise<string> {
  const bytes = await readBytesBounded(filePath, maxBytes);
  return Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

async function readBytesBounded(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead <= 0) break;
      total += result.bytesRead;
      if (total > maxBytes) throw new Error(`workspace read exceeded max bytes: ${filePath}`);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total);
}

function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    out.push(text.slice(start, i));
    start = i + 1;
  }
  out.push(text.slice(start));
  return out;
}

function collapseSpace(text: string): string {
  let out = "";
  let spacing = false;
  for (const ch of text.trim()) {
    if (ch.trim() === "") {
      if (!spacing) out += " ";
      spacing = true;
    } else {
      out += ch;
      spacing = false;
    }
  }
  return out;
}

function quotedSegments(text: string): string[] {
  const out: string[] = [];
  let quote: string | undefined;
  let current = "";
  let escaped = false;
  for (const ch of text) {
    if (quote) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") escaped = true;
      else if (ch === quote) {
        if (current.trim()) out.push(current.trim());
        current = "";
        quote = undefined;
      } else current += ch;
    } else if (ch === "`" || ch === "\"" || ch === "'") quote = ch;
  }
  return out;
}

function routeSegments(text: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    if (i > 0 && routeChar(text[i - 1] ?? "")) continue;
    let end = i + 1;
    while (end < text.length && routeChar(text[end] ?? "")) end++;
    const value = text.slice(i, end);
    if (value.length > 1 && value !== "//" && !value.includes("*") && !value.includes(".")) out.add(value);
  }
  return [...out].sort();
}

function routeChar(ch: string): boolean {
  if (!ch || ch.trim() === "") return false;
  return !["`", "\"", "'", ")", "(", "]", "[", "{", "}", ",", ";"].includes(ch);
}

function looksCommandLike(value: string): boolean {
  const words = shellWords(value);
  if (!words.length || words.length > 12) return false;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return false;
  return words.some(word => word.length > 1 && !word.startsWith("-"));
}

function shellWords(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of value.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
    else if (ch.trim() === "") {
      if (current) {
        out.push(current);
        current = "";
      }
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function looksPathLike(value: string): boolean {
  if (!value || value.length > 240) return false;
  if (value.startsWith("http:") || value.startsWith("https:")) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  const ext = extensionOf(value);
  return Boolean(ext && ext.length <= 8);
}

function extensionOf(value: string): string {
  const file = value.split("/").pop()?.split("\\").pop() ?? value;
  const dot = file.lastIndexOf(".");
  return dot > 0 && dot < file.length - 1 ? file.slice(dot).toLocaleLowerCase() : "";
}

function fileExistsSyncish(root: string, relative: string): boolean {
  const target = path.resolve(root, relative);
  return existsSync(target);
}

function keyValueClaim(text: string): { key: string; value: string } | undefined {
  const colon = text.indexOf(":");
  const equals = text.indexOf("=");
  const splitAt = colon >= 0 && (equals < 0 || colon < equals) ? colon : equals;
  if (splitAt <= 0) return undefined;
  const key = collapseSpace(text.slice(0, splitAt));
  const value = collapseSpace(text.slice(splitAt + 1));
  if (!key || !value || key.length > 80) return undefined;
  return { key, value };
}

function lexicalTerms(text: string): string[] {
  const terms: string[] = [];
  let current = "";
  for (const ch of text.normalize("NFKC")) {
    if (identifierChar(ch)) current += ch;
    else if (current) {
      terms.push(current.toLocaleLowerCase());
      current = "";
    }
  }
  if (current) terms.push(current.toLocaleLowerCase());
  return [...new Set(terms)];
}

function callNames(line: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "(") continue;
    let end = i - 1;
    while (end >= 0 && (line[end] ?? "").trim() === "") end--;
    let start = end;
    while (start >= 0 && identifierChar(line[start] ?? "")) start--;
    const name = line.slice(start + 1, end + 1);
    if (name && !controlWord(name)) out.push(name);
  }
  return out;
}

function identifierChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && ch.trim() !== "";
}

function controlWord(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  return ["if", "for", "while", "switch", "catch", "return", "throw", "function"].includes(lower);
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function includesAll(value: string, needles: readonly string[]): boolean {
  return needles.every(needle => value.includes(needle));
}

function firstPathPiece(value: string): string {
  const pieces = normalizePath(value).split("/").filter(Boolean);
  return pieces[0] ?? ".";
}

function componentKind(piece: string): string {
  const lower = piece.toLocaleLowerCase();
  if (lower.includes("doc")) return "documentation";
  if (lower.includes("test") || lower.includes("spec")) return "validation";
  if (lower.includes("src") || lower.includes("lib") || lower.includes("app")) return "source";
  if (lower.includes("config")) return "configuration";
  return "component";
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toLocaleUpperCase() ?? ""}${value.slice(1)}` : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(next);
      else if (entry.isFile()) out.push(next);
    }
  }
  return out;
}

export async function workspaceFixtureFileList(rootPath: string): Promise<string[]> {
  const root = path.resolve(rootPath);
  return (await listFiles(root)).map(file => normalizePath(path.relative(root, file))).sort();
}
