// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chat-view.js";
import { ScceClient } from "./client.js";
import { normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken } from "./config.js";
import { TaskTimeline, type ExtensionTaskRecord } from "./task-timeline.js";
import { EXTENSION_PROTOCOL_SCHEMA, parseExtensionMessage, type ExtensionMessage, type ExtensionTaskState, type ScceEndpoint } from "./protocol.js";
import {
  assertSameWorkspacePhysicalBinding,
  assertWorkspacePathAbsent,
  assertWorkspacePhysicalBinding,
  captureWorkspacePhysicalBinding,
  readVerifiedWorkspaceFile,
  reviewedPatchIntegritySummary,
  verifyAppliedPatchMatchesPlan,
  verifyAppliedWorkspaceState,
  verifyReviewedWorkspaceState,
  type WorkspacePhysicalBinding
} from "./patch-integrity.js";
import {
  DEFAULT_PATCH_VALIDATION_POLICY_ID,
  parseReviewedPatchPlan,
  type AppliedWorkspacePatch,
  type ReviewedPatchPlan,
  type WorkspaceCodingPatchPlanSelected
} from "./patch-protocol.js";
import {
  sameFileSystemPath,
  selectServerBoundWorkspaceFolder,
  type WorkspaceFolderIdentity
} from "./workspace-binding.js";

const TOKEN_SECRET_KEY = "scce.serverToken.v1";
const MAX_PATCH_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_PREVIEW_BYTES = 16 * 1024 * 1024;
const PATCH_PREVIEW_SCHEME = "scce-patch-preview";

class PatchPreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();

  set(uri: vscode.Uri, value: string): void {
    this.content.set(uri.toString(), value);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

class TaskTimelineProvider implements vscode.TreeDataProvider<ExtensionTaskRecord> {
  private readonly change = new vscode.EventEmitter<ExtensionTaskRecord | undefined | void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly timeline: TaskTimeline) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(task: ExtensionTaskRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(task.label, vscode.TreeItemCollapsibleState.None);
    item.description = task.state;
    item.tooltip = [
      task.endpoint,
      `State: ${task.state}`,
      `Started: ${new Date(task.startedAt).toLocaleString()}`,
      task.detail
    ].filter(Boolean).join("\n");
    item.iconPath = new vscode.ThemeIcon(iconFor(task.state));
    return item;
  }

  getChildren(): ExtensionTaskRecord[] {
    return [...this.timeline.list()];
  }
}

/** The status stream the extension publishes: every readiness change, task transition and result is validated against the
 *  declared protocol before it is written, so the log is the protocol rather than a parallel description of it. */
interface ExtensionSession {
  output: vscode.OutputChannel;
  publish: (message: ExtensionMessage) => void;
}

let session: ExtensionSession | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("SCCE");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "scce.checkReadiness";
  status.text = "$(pulse) scce.checking";
  status.show();

  const publish = (message: ExtensionMessage): void => {
    const validated = parseExtensionMessage(message);
    output.appendLine(`[protocol] ${JSON.stringify(validated)}`);
  };
  session = { output, publish };

  const timeline = new TaskTimeline(context.globalState);
  const provider = new TaskTimelineProvider(timeline);
  const patchPreview = new PatchPreviewContentProvider();
  const recovered = await timeline.recoverInterrupted();
  if (recovered) output.appendLine(`[extension] task.timeline.recovered interrupted=${recovered}`);
  context.subscriptions.push(
    output,
    status,
    vscode.window.registerTreeDataProvider("scce.taskTimeline", provider),
    vscode.workspace.registerTextDocumentContentProvider(PATCH_PREVIEW_SCHEME, patchPreview)
  );

  const client = async () => new ScceClient({
    serverUrl: configuredServerUrl(),
    token: normalizeToken(await context.secrets.get(TOKEN_SECRET_KEY)),
    timeoutMs: configuredTimeout()
  });

  const chatViewProvider = new ChatViewProvider(context.extensionUri, context.workspaceState, client, output);
  void autoIngestOpenWorkspace(client, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatViewProvider)
  );

  const run = async <T>(
    endpoint: ScceEndpoint,
    label: string,
    mutates: boolean,
    action: (activeClient: ScceClient) => Promise<T>,
    approvalNotice?: { message: string; detail: string }
  ): Promise<T | undefined> => {
    const task = await timeline.start(endpoint, label, mutates);
    const announce = (state: ExtensionTaskState): void =>
      publish({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "task", taskId: task.id, state, observedAt: Date.now() });
    announce(task.state);
    provider.refresh();
    if (mutates) {
      const approved = await vscode.window.showWarningMessage(
        approvalNotice?.message ?? `scce.request.mutates_durable_store ${label}`,
        { modal: true, detail: approvalNotice?.detail ?? "scce.approval.single_request" },
        "approve.once"
      );
      if (approved !== "approve.once") {
        await timeline.transition(task.id, "cancelled", "scce.approval.declined");
        announce("cancelled");
        provider.refresh();
        return undefined;
      }
      await timeline.transition(task.id, "running");
      announce("running");
      provider.refresh();
    }
    try {
      const result = await action(await client());
      await timeline.transition(task.id, "succeeded");
      announce("succeeded");
      publish({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "result", taskId: task.id, endpoint, payload: result, observedAt: Date.now() });
      output.appendLine(`[${new Date().toISOString()}] ${label}`);
      output.appendLine(formatOutput(result));
      output.show(true);
      provider.refresh();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await timeline.transition(task.id, "failed", message);
      announce("failed");
      provider.refresh();
      output.appendLine(`[${new Date().toISOString()}] ${label} failed ${message}`);
      void vscode.window.showErrorMessage(`${message}`);
      return undefined;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("scce.checkReadiness", async () => {
      status.text = "$(pulse) scce.checking";
      const result = await run("ready", "runtime.ready", false, activeClient => activeClient.ready());
      const ready = Boolean(result && typeof result === "object" && "ok" in result && result.ok === true);
      if (ready) {
        status.text = "$(check) scce.ready";
        status.tooltip = `scce.ready ${configuredServerUrl()}`;
      } else {
        status.text = "$(error) scce.unavailable";
      }
      publish({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "readiness", ready, serverUrl: configuredServerUrl(), observedAt: Date.now() });
    }),
    vscode.commands.registerCommand("scce.setServerToken", async () => {
      const token = await vscode.window.showInputBox({ title: "scce.server.token", password: true, prompt: "scce.server.token.empty_removes", ignoreFocusOut: true });
      if (token === undefined) return;
      const normalized = normalizeToken(token);
      if (normalized) await context.secrets.store(TOKEN_SECRET_KEY, normalized);
      else await context.secrets.delete(TOKEN_SECRET_KEY);
      void vscode.window.showInformationMessage(normalized ? "scce.server.token.stored" : "scce.server.token.removed");
    }),
    vscode.commands.registerCommand("scce.workspace.initialize", async () => {
      const workspacePath = await chooseLocalWorkspacePathForInitialization();
      if (!workspacePath) return;
      return run("workspace.initialize", "workspace.initialize", true, activeClient => activeClient.workspaceInitialize(workspacePath));
    }),
    vscode.commands.registerCommand("scce.workspace.ingest", () => run("workspace.ingest", "workspace.ingest", true, async activeClient => {
      const { binding } = await serverBoundWorkspace(activeClient);
      return activeClient.workspaceIngest(binding.resolvedRoot);
    })),
    vscode.commands.registerCommand("scce.project.summary", () => run("project.summary", "project.summary", true, async activeClient => {
      const { binding } = await serverBoundWorkspace(activeClient);
      return activeClient.projectSummary(binding.resolvedRoot);
    })),
    vscode.commands.registerCommand("scce.workspace.code", async () => {
      const editor = vscode.window.activeTextEditor;
      const relative = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : "";
      const targetPath = await vscode.window.showInputBox({ prompt: "workspace.code.path", value: relative });
      if (!targetPath) return;
      const request = await vscode.window.showInputBox({ prompt: "workspace.code.request" });
      if (!request) return;
      await run("workspace.code", "Edit " + targetPath, true, async activeClient => {
        let result = await activeClient.editCode(targetPath, request);
        // The compiler owns several fixes here; choosing one for the owner would be a guess, so it picks.
        if (result.outcome === "awaiting_selection" && result.candidates?.length) {
          const picked = await vscode.window.showQuickPick(
            result.candidates.map(candidate => ({
              label: candidate.fixName,
              description: "TS" + candidate.diagnosticCode,
              detail: candidate.codeFixIdentity,
              identity: candidate.codeFixIdentity
            })),
            { title: "workspace.code.fix_candidates " + targetPath, placeHolder: "workspace.code.fix_choice" }
          );
          if (!picked) return result as unknown as Record<string, unknown>;
          result = await activeClient.editCode(targetPath, request + " codeFixIdentity:" + picked.identity);
        }
        const summary = result.outcome === "resolved"
          ? "SCCE edited " + targetPath + " workspace.code.resolved attempts=" + result.attempts + " attempt(s)."
          : "workspace.code.unchanged " + targetPath + ": " + result.outcome + " rolled_back";
        if (result.outcome === "resolved") void vscode.window.showInformationMessage(summary);
        else void vscode.window.showWarningMessage(summary);
        return result as unknown as Record<string, unknown>;
      });
    }),
    vscode.commands.registerCommand("scce.workspace.ask", async () => {
      const question = await vscode.window.showInputBox({ title: "workspace.ask", prompt: "workspace.ask.persisted", ignoreFocusOut: true });
      if (!question?.trim()) return;
      const answer = await run("workspace.ask", "workspace.ask", true, async activeClient => {
        const { binding } = await serverBoundWorkspace(activeClient);
        return activeClient.workspaceAsk(binding.resolvedRoot, question);
      });
      if (answer && typeof answer === "object" && "answer" in answer && typeof answer.answer === "string") {
        void vscode.window.showInformationMessage(answer.answer.slice(0, 500));
      }
    }),
    vscode.commands.registerCommand("scce.learning.review", async () => {
      const listed = await run("learning.review", "learning.held.list", false, async activeClient => activeClient.listHeldSources());
      const held = listed && typeof listed === "object" && "held" in listed ? (listed as { held: Array<{ id: string; uri: string; title: string; preview: string }> }).held : [];
      if (!held.length) { void vscode.window.showInformationMessage("learning.held.none"); return; }
      const picked = await vscode.window.showQuickPick(held.map(item => ({ label: item.title || item.uri, description: item.uri, detail: item.preview.slice(0, 200), item })), { title: "learning.review.held", ignoreFocusOut: true });
      if (!picked) return;
      const decision = await vscode.window.showQuickPick([{ label: "learning.review.promoted", value: "promoted" as const }, { label: "learning.review.rejected", value: "rejected" as const }], { title: picked.description, ignoreFocusOut: true });
      if (!decision) return;
      await run("learning.review.decide", decision.value === "promoted" ? "learning.review.promoted" : "learning.review.rejected", true, async activeClient => activeClient.reviewHeldSource(picked.item.id, decision.value));
    }),
    vscode.commands.registerCommand("scce.learning.curriculum", async () => {
      const listed = await run("learning.curriculum", "learning.curriculum.list", false, async activeClient => activeClient.listCurriculum());
      const items = listed && typeof listed === "object" && "items" in listed ? (listed as { items: Array<{ planId: string; query: string; rationale: string }> }).items : [];
      if (!items.length) { void vscode.window.showInformationMessage("learning.curriculum.none"); return; }
      const picked = await vscode.window.showQuickPick(items.map(item => ({ label: item.query, detail: item.rationale, item })), { title: "learning.curriculum.consent", ignoreFocusOut: true });
      if (!picked) return;
      const result = await run("learning.pursue", "learning.curriculum.pursue", true, async activeClient => activeClient.pursueCurriculum(picked.item.planId));
      const heldCount = result && typeof result === "object" && "held" in result ? (result as { held: unknown[] }).held.length : 0;
      if (heldCount) void vscode.window.showInformationMessage(`learning.held.fetched sources=${heldCount}`);
    }),
    vscode.commands.registerCommand("scce.workspace.status", () => run("workspace.status", "workspace.status", false, async activeClient => {
      const { status: workspaceStatus } = await serverBoundWorkspace(activeClient);
      return workspaceStatus;
    })),
    vscode.commands.registerCommand("scce.workspace.codingRequest", async (prefill?: string) => {
      const requestText = await vscode.window.showInputBox({
        title: "workspace.coding_request",
        prompt: "workspace.coding_request.text",
        placeHolder: "",
        value: typeof prefill === "string" ? prefill : undefined,
        ignoreFocusOut: true,
        validateInput: value => {
          const normalized = value.trim();
          if (!normalized) return "Enter a coding request.";
          if (normalized.includes("\0")) return "workspace.coding_request.nul_byte";
          if (Buffer.byteLength(normalized, "utf8") > 20_000) return "workspace.coding_request.too_large";
          return undefined;
        }
      });
      if (!requestText?.trim()) return;
      let scopedStatus = await run("workspace.status", "Load coding-request scope", false, activeClient => serverBoundWorkspace(activeClient));
      if (!scopedStatus) return;
      let statusResult = scopedStatus.status;
      let codingWorkspace = scopedStatus.binding;
      const refreshChoice = await vscode.window.showQuickPick([
        {
          label: "$(refresh) workspace.preflight.refresh",
          description: "workspace.ingest",
          refresh: true
        },
        {
          label: "$(database) workspace.preflight.current",
          description: "workspace.status",
          refresh: false
        }
      ], {
        title: "workspace.preflight",
        placeHolder: "workspace.preflight.refresh",
        ignoreFocusOut: true
      });
      if (!refreshChoice) return;
      if (refreshChoice.refresh) {
        const refreshed = await run("workspace.ingest", "workspace.ingest", true, activeClient => activeClient.workspaceIngest(codingWorkspace.resolvedRoot));
        if (!refreshed) return;
        scopedStatus = await run("workspace.status", "Reload coding-request scope", false, activeClient => serverBoundWorkspace(activeClient));
        if (!scopedStatus) return;
        statusResult = scopedStatus.status;
        codingWorkspace = scopedStatus.binding;
      }
      if (statusResult.sources.length === 0) {
        void vscode.window.showInformationMessage("workspace.sources.none");
        return;
      }
      const selected = await vscode.window.showQuickPick(
        statusResult.sources.map(source => ({ label: source.path, path: source.path })),
        {
          title: "workspace.coding_request.sources",
          placeHolder: "workspace.coding_request.sources.1_to_256",
          canPickMany: true,
          ignoreFocusOut: true,
          matchOnDescription: false,
          matchOnDetail: false
        }
      );
      if (!selected) return;
      if (selected.length < 1) {
        void vscode.window.showInformationMessage("workspace.coding_request.sources.empty");
        return;
      }
      if (selected.length > 256) {
        void vscode.window.showErrorMessage("workspace.coding_request.sources.over_256");
        return;
      }
      const diagnosticCodes = await chooseTypeScriptDiagnosticCodes(codingWorkspace, selected.map(item => item.path));
      if (!diagnosticCodes) return;
      const generation = await run(
        "workspace.patch.plan.request",
        "workspace.coding_request.plan",
        false,
        activeClient => activeClient.workspaceCodingPatchPlan({
          workspaceId: statusResult.workspace.id,
          expectedWorkspaceUpdatedAt: statusResult.workspace.updatedAt,
          requestId: `vscode-${randomUUID()}`,
          requestText,
          requestedPaths: selected.map(item => item.path),
          diagnosticCodes
        })
      );
      if (!generation) return;
      if (generation.kind === "unresolved") {
        const reasons = generation.reasonIds.join(", ");
        output.appendLine(`[${new Date().toISOString()}] workspace.coding_request.unresolved ${reasons}`);
        void vscode.window.showInformationMessage(`workspace.coding_request.unresolved ${reasons}`);
        return;
      }
      let reviewedWorkspace: BoundOpenWorkspace;
      try {
        reviewedWorkspace = await openPatchPlanPreview(patchPreview, statusResult.workspace.rootPath, generation.plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[${new Date().toISOString()}] workspace.coding_request.preview_failed ${message}`);
        void vscode.window.showErrorMessage(`${message}`);
        return;
      }
      const reviewed = await vscode.window.showWarningMessage(
        "patch.preview.review",
        { detail: `patch.preview.no_files_changed ${generation.plan.planHash}` },
        "continue.to_approval",
        "Cancel"
      );
      if (reviewed !== "continue.to_approval") return;
      const applied = await run(
        "workspace.patch",
        "workspace.coding_request.apply",
        true,
        async activeClient => {
          const currentStatus = await activeClient.workspaceStatus();
          if (currentStatus.workspace.id !== generation.workspaceId) throw new Error("workspace.changed_after_review");
          const currentWorkspace = await assertServerWorkspaceMatchesOpenFolder(currentStatus.workspace.rootPath);
          assertSameWorkspacePhysicalBinding(reviewedWorkspace, currentWorkspace);
          return applyReviewedWorkspacePatch(activeClient, generation.workspaceId, currentStatus.workspace.rootPath, reviewedWorkspace, generation.plan);
        },
        {
          message: `workspace.coding_request.apply operations=${generation.plan.operations.length}`,
          detail: `${codingPlanReviewSummary(generation)}\n\nvalidation=${DEFAULT_PATCH_VALIDATION_POLICY_ID}\ncapability_authorization=required\ncommit=after_validation\nhost=trusted_not_sandboxed`
        }
      );
      if (applied) showAppliedReceipt(applied);
    }),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new ScceQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand("scce.quickFix", async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      const code = diagnosticNumericCode(diagnostic);
      if (code === undefined) return;
      const scopedStatus = await run("workspace.status", "Load quick-fix scope", false, activeClient => serverBoundWorkspace(activeClient));
      if (!scopedStatus) return;
      const statusResult = scopedStatus.status;
      const relativePath = workspaceRelativePath(scopedStatus.binding.folder, uri);
      if (!relativePath) {
        void vscode.window.showErrorMessage("workspace.file.out_of_bounds");
        return;
      }
      const generation = await run(
        "workspace.patch.plan.request",
        "workspace.quick_fix.plan",
        false,
        activeClient => activeClient.workspaceCodingPatchPlan({
          workspaceId: statusResult.workspace.id,
          expectedWorkspaceUpdatedAt: statusResult.workspace.updatedAt,
          requestId: `vscode-quickfix-${randomUUID()}`,
          requestText: diagnostic.message,
          requestedPaths: [relativePath],
          diagnosticCodes: [code]
        })
      );
      if (!generation) return;
      if (generation.kind === "unresolved") {
        const reasons = generation.reasonIds.join(", ");
        output.appendLine(`[${new Date().toISOString()}] workspace.quick_fix.unresolved ${reasons}`);
        void vscode.window.showInformationMessage(`workspace.quick_fix.unresolved ${reasons}`);
        return;
      }
      let reviewedWorkspace: BoundOpenWorkspace;
      try {
        reviewedWorkspace = await openPatchPlanPreview(patchPreview, statusResult.workspace.rootPath, generation.plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[${new Date().toISOString()}] workspace.quick_fix.preview_failed ${message}`);
        void vscode.window.showErrorMessage(`${message}`);
        return;
      }
      const reviewed = await vscode.window.showWarningMessage(
        "patch.preview.review",
        { detail: `patch.preview.no_files_changed ${generation.plan.planHash}` },
        "continue.to_approval",
        "Cancel"
      );
      if (reviewed !== "continue.to_approval") return;
      const applied = await run(
        "workspace.patch",
        "workspace.quick_fix.apply",
        true,
        async activeClient => {
          const currentStatus = await activeClient.workspaceStatus();
          if (currentStatus.workspace.id !== generation.workspaceId) throw new Error("workspace.changed_after_review");
          const currentWorkspace = await assertServerWorkspaceMatchesOpenFolder(currentStatus.workspace.rootPath);
          assertSameWorkspacePhysicalBinding(reviewedWorkspace, currentWorkspace);
          return applyReviewedWorkspacePatch(activeClient, generation.workspaceId, currentStatus.workspace.rootPath, reviewedWorkspace, generation.plan);
        },
        {
          message: `workspace.quick_fix.apply operations=${generation.plan.operations.length}`,
          detail: `${codingPlanReviewSummary(generation)}\n\nvalidation=${DEFAULT_PATCH_VALIDATION_POLICY_ID}\ncapability_authorization=required\ncommit=after_validation`
        }
      );
      if (applied) showAppliedReceipt(applied);
    }),
    vscode.commands.registerCommand("scce.workspace.applyPatchPlan", async () => {
      const boundStatus = await run("workspace.status", "patch.transaction.bind", false, async activeClient => {
        const workspaceStatus = await activeClient.workspaceStatus();
        await assertServerWorkspaceMatchesOpenFolder(workspaceStatus.workspace.rootPath);
        return workspaceStatus;
      });
      if (!boundStatus) return;
      const plan = await chooseReviewedPatchPlan();
      if (!plan) return;
      let reviewedWorkspace: BoundOpenWorkspace;
      try {
        reviewedWorkspace = await openPatchPlanPreview(patchPreview, boundStatus.workspace.rootPath, plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[${new Date().toISOString()}] patch.transaction.preview_failed ${message}`);
        void vscode.window.showErrorMessage(`${message}`);
        return;
      }
      const reviewed = await vscode.window.showWarningMessage(
        "patch.preview.review",
        { detail: `patch.preview.no_files_changed ${plan.planHash}` },
        "continue.to_approval",
        "Cancel"
      );
      if (reviewed !== "continue.to_approval") return;
      const applied = await run("workspace.patch", "patch.transaction.apply", true, async activeClient => {
        const currentStatus = await activeClient.workspaceStatus();
        if (currentStatus.workspace.id !== boundStatus.workspace.id) throw new Error("workspace.changed_after_review");
        const currentWorkspace = await assertServerWorkspaceMatchesOpenFolder(currentStatus.workspace.rootPath);
        assertSameWorkspacePhysicalBinding(reviewedWorkspace, currentWorkspace);
        return applyReviewedWorkspacePatch(activeClient, boundStatus.workspace.id, currentStatus.workspace.rootPath, reviewedWorkspace, plan);
      }, {
        message: `patch.transaction.apply operations=${plan.operations.length}`,
        detail: `${patchPlanSummary(plan)}\n\nvalidation=${DEFAULT_PATCH_VALIDATION_POLICY_ID}\ncapability_authorization=required\ncommit=after_validation\nhost=trusted_not_sandboxed`
      });
      if (applied && typeof applied === "object" && "receipt" in applied) {
        showAppliedReceipt(applied);
      }
    }),
    // Phase 6/8: settings and local models. VS Code settings are the editor-side view;
    // "push" writes them to the server's scce.config.json through the shared schema.
    vscode.commands.registerCommand("scce.settings.open", () => vscode.commands.executeCommand("workbench.action.openSettings", "scce")),
    vscode.commands.registerCommand("scce.settings.push", async () => {
      const surface = readSurfaceSettings();
      if (surface.problems.length) { void vscode.window.showErrorMessage(`scce.settings.rejected ${surface.problems.join("; ")}`); return; }
      try {
        const activeClient = await client();
        for (const [key, value] of Object.entries(surface.values)) await activeClient.putSetting(key, value);
        output.appendLine(`[settings] scce.settings.pushed count=${Object.keys(surface.values).length}`);
        void vscode.window.showInformationMessage("scce.settings.pushed");
      } catch (error) {
        void vscode.window.showErrorMessage(`scce.settings.push_failed ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("scce.models.manage", async () => {
      try {
        const activeClient = await client();
        const view = await activeClient.listModels();
        const items: vscode.QuickPickItem[] = [
          ...view.models.map(model => ({ label: `${model.active ? "$(check) " : ""}${model.id}`, description: `${model.size}, ${model.files} files`, detail: model.path })),
          { label: "$(cloud-download) Download a model…", description: "scce.models.download" }
        ];
        const picked = await vscode.window.showQuickPick(items, { title: `scce.models ${view.modelDir}` });
        if (!picked) return;
        if (picked.label.startsWith("$(cloud-download)")) {
          const modelId = await vscode.window.showInputBox({ prompt: "scce.models.id" });
          if (!modelId) return;
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SCCE: downloading ${modelId}` }, () => activeClient.downloadModel(modelId));
          void vscode.window.showInformationMessage(`SCCE: downloaded ${modelId}`);
          return;
        }
        const modelId = picked.label.replace(/^\$\(check\) /u, "");
        const action = await vscode.window.showQuickPick(["scce.models.use_visual", "Remove"], { title: modelId });
        if (action === "Remove") { await activeClient.removeModel(modelId); void vscode.window.showInformationMessage(`SCCE: removed ${modelId}`); }
        else if (action === "scce.models.use_visual") { await activeClient.putSetting("ingestion.visual.embeddings.modelId", modelId); await activeClient.putSetting("ingestion.visual.embeddings.modelDir", view.modelDir); }
      } catch (error) {
        void vscode.window.showErrorMessage(`scce.models.failed ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("scce.tasks.clear", async () => {
      await timeline.clear();
      provider.refresh();
    })
  );

  void vscode.commands.executeCommand("scce.checkReadiness");
}

function readSurfaceSettings(): { values: Record<string, string | boolean>; problems: string[] } {
  const settings = vscode.workspace.getConfiguration("scce");
  const problems: string[] = [];
  return {
    problems,
    values: {
      "ingestion.visual.embeddings.enabled": settings.get<boolean>("ingestion.imageEmbeddings", false),
      "ingestion.observation.workspaceAutoIngest": settings.get<boolean>("workspace.autoIngest", true),
      "ingestion.observation.screen": settings.get<boolean>("observation.screen", false),
      "ingestion.observation.otherApplications": settings.get<boolean>("observation.otherApplications", false)
    }
  };
}

/** Phase 7: the open workspace is already consented-to; anything beyond it is opt-in per source and logged while active. */
async function autoIngestOpenWorkspace(client: () => Promise<ScceClient>, output: vscode.OutputChannel): Promise<void> {
  const settings = vscode.workspace.getConfiguration("scce");
  for (const key of ["observation.screen", "observation.otherApplications"]) {
    if (settings.get<boolean>(key, false)) output.appendLine(`[observation] scce.observation.consent_recorded scce.${key}`);
  }
  if (!settings.get<boolean>("workspace.autoIngest", true)) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  try {
    const result = await (await client()).workspaceIngest(folder.uri.fsPath);
    output.appendLine(`[workspace] auto-ingested ${folder.uri.fsPath}: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    output.appendLine(`[workspace] workspace.auto_ingest.skipped ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function deactivate(): void {
  // The host is going away: publish the closing readiness record so the status stream ends where the extension does.
  session?.publish({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "readiness", ready: false, serverUrl: configuredServerUrl(), observedAt: Date.now() });
  session = undefined;
}

function configuredServerUrl(): string {
  return normalizeLocalServerUrl(vscode.workspace.getConfiguration("scce").get<string>("serverUrl"));
}

function configuredTimeout(): number {
  return normalizeRequestTimeout(vscode.workspace.getConfiguration("scce").get<number>("requestTimeoutMs"));
}

async function chooseLocalWorkspacePathForInitialization(): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("workspace.initialize.needs_local_folder");
    return undefined;
  }
  if (folders.length === 1) return folders[0]!.uri.fsPath;
  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    {
      title: "workspace.initialize.folder",
      placeHolder: "workspace.initialize.folder",
      ignoreFocusOut: true
    }
  );
  return selected?.folder.uri.fsPath;
}

/**
 * Native VS Code quick fixes for any diagnostic carrying a numeric code (the compiler-owned lane's own
 * admission requirement -- see workspaceCodingPatchPlan). One action per diagnostic in range; the label
 * names the diagnostic itself, not a generic "fix with SCCE" that would tell a user nothing about what
 * they are about to run.
 */
class ScceQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const code = diagnosticNumericCode(diagnostic);
      if (code === undefined) continue;
      const action = new vscode.CodeAction(`SCCE: Fix "${diagnostic.message}"`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = { command: "scce.quickFix", title: "workspace.quick_fix", arguments: [document.uri, diagnostic] };
      actions.push(action);
    }
    return actions;
  }
}

function diagnosticNumericCode(diagnostic: vscode.Diagnostic): number | undefined {
  const code = diagnostic.code;
  if (typeof code === "number") return code;
  if (typeof code === "object" && code !== null && typeof code.value === "number") return code.value;
  return undefined;
}

/** Workspace-relative, forward-slash path matching the server's own `source.path` shape, or undefined outside the bound folder. */
function workspaceRelativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  const resolvedFolder = resolve(folder.uri.fsPath);
  const resolvedFile = resolve(uri.fsPath);
  if (!sameFileSystemPath(resolvedFile.slice(0, resolvedFolder.length), resolvedFolder)) return undefined;
  return relativePath.split("\\").join("/");
}

async function serverBoundWorkspace(activeClient: ScceClient): Promise<{
  status: Awaited<ReturnType<ScceClient["workspaceStatus"]>>;
  binding: BoundOpenWorkspace;
}> {
  const status = await activeClient.workspaceStatus();
  const binding = await assertServerWorkspaceMatchesOpenFolder(status.workspace.rootPath);
  return { status, binding };
}

function iconFor(state: ExtensionTaskRecord["state"]): string {
  if (state === "succeeded") return "pass";
  if (state === "failed") return "error";
  if (state === "running") return "sync~spin";
  if (state === "pending_approval") return "lock";
  if (state === "interrupted") return "debug-pause";
  return "circle-slash";
}

function formatOutput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function chooseReviewedPatchPlan(): Promise<ReviewedPatchPlan | undefined> {
  const selected = await vscode.window.showOpenDialog({
    title: "patch.transaction.select",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "patch.transaction.plan": ["json"] },
    openLabel: "Review plan"
  });
  const uri = selected?.[0];
  if (!uri) return undefined;
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_PATCH_PLAN_BYTES) throw new Error("patch.transaction.plan.over_8mib");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`patch.transaction.plan.not_utf8_json ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseReviewedPatchPlan(value);
}

function patchPlanSummary(plan: ReviewedPatchPlan): string {
  const rows = plan.operations.slice(0, 20).map(operation => {
    const before = operation.beforeContentHash?.slice(7, 19) ?? "new";
    const after = operation.afterContentHash?.slice(7, 19) ?? "deleted";
    return `${operation.kind} ${operation.path} ${before} -> ${after}`;
  });
  if (plan.operations.length > rows.length) rows.push(`more_operations=${plan.operations.length - rows.length}`);
  return [`plan=${plan.planHash}`, reviewedPatchIntegritySummary(plan), ...rows].join("\n");
}

interface BoundOpenWorkspace extends WorkspacePhysicalBinding {
  folder: vscode.WorkspaceFolder;
}

interface PatchPreviewEntry {
  operation: ReviewedPatchPlan["operations"][number];
  beforeContent: string | null;
  afterContent: string | null;
}

async function assertServerWorkspaceMatchesOpenFolder(serverRootPath: string): Promise<BoundOpenWorkspace> {
  const resolvedServerRoot = resolve(serverRootPath);
  const serverPhysical = await captureWorkspacePhysicalBinding(resolvedServerRoot);
  const candidates: Array<WorkspaceFolderIdentity<vscode.WorkspaceFolder>> = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const resolvedRoot = resolve(folder.uri.fsPath);
    const realRoot = folder.uri.scheme === "file" && sameFileSystemPath(resolvedRoot, resolvedServerRoot)
      ? (await captureWorkspacePhysicalBinding(resolvedRoot)).realRoot
      : null;
    candidates.push({ folder, scheme: folder.uri.scheme, resolvedRoot, realRoot });
  }
  const selected = selectServerBoundWorkspaceFolder(resolvedServerRoot, serverPhysical.realRoot, candidates);
  const physical = await captureWorkspacePhysicalBinding(selected.resolvedRoot);
  if (!sameFileSystemPath(physical.realRoot, selected.realRoot)) {
    throw new Error("workspace.folder.changed_during_capture");
  }
  await assertWorkspacePhysicalBinding(serverPhysical);
  assertSameWorkspacePhysicalBinding(serverPhysical, physical);
  return { folder: selected.folder, ...physical };
}

async function openPatchPlanPreview(
  provider: PatchPreviewContentProvider,
  serverRootPath: string,
  plan: ReviewedPatchPlan
): Promise<BoundOpenWorkspace> {
  const workspace = await assertServerWorkspaceMatchesOpenFolder(serverRootPath);
  const entries: PatchPreviewEntry[] = [];
  let contentBytes = 0;
  for (const operation of plan.operations) {
    let beforeContent: string | null = null;
    if (operation.kind === "create") {
      await assertWorkspacePathAbsent(workspace, operation.path, "preview");
    } else {
      const bytes = await readVerifiedWorkspaceFile(workspace, operation.path, operation.beforeContentHash, "preview");
      if (bytes.includes(0)) throw new Error(`patch.preview.not_utf8 ${operation.path}`);
      try {
        beforeContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error(`patch.preview.not_exact_utf8 ${operation.path}`);
      }
      contentBytes += bytes.byteLength;
    }
    const afterContent = operation.kind === "delete" ? null : operation.content;
    if (afterContent !== null) contentBytes += Buffer.byteLength(afterContent, "utf8");
    if (contentBytes > MAX_PATCH_PREVIEW_BYTES) throw new Error("patch.preview.over_16mib");
    entries.push({ operation, beforeContent, afterContent });
  }
  const before = combinedPatchPreview(entries, "before");
  const after = combinedPatchPreview(entries, "after");
  if (Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8") > MAX_PATCH_PREVIEW_BYTES) {
    throw new Error("patch.preview.over_16mib_with_metadata");
  }
  const planId = plan.planHash.slice(7, 23);
  const beforeUri = vscode.Uri.from({ scheme: PATCH_PREVIEW_SCHEME, authority: "review", path: `/${planId}/before.txt` });
  const afterUri = vscode.Uri.from({ scheme: PATCH_PREVIEW_SCHEME, authority: "review", path: `/${planId}/after.txt` });
  provider.set(beforeUri, before);
  provider.set(afterUri, after);
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `patch.preview operations=${plan.operations.length}`,
    { preview: false }
  );
  await assertWorkspacePhysicalBinding(workspace);
  return workspace;
}

function combinedPatchPreview(entries: readonly PatchPreviewEntry[], side: "before" | "after"): string {
  return entries.map((entry, index) => {
    const content = side === "before" ? entry.beforeContent : entry.afterContent;
    const hash = side === "before" ? entry.operation.beforeContentHash : entry.operation.afterContentHash;
    const absentState = side === "before" ? "[patch.file.absent_before_create]" : "[patch.file.deleted_by_plan]";
    return [
      `===== operation ${index + 1}/${entries.length}: ${entry.operation.kind} ${entry.operation.path} =====`,
      `${side} content hash: ${hash ?? "null"}`,
      "----- content -----",
      content ?? absentState,
      `===== end ${entry.operation.path} =====`
    ].join("\n");
  }).join("\n\n");
}

async function applyReviewedWorkspacePatch(
  activeClient: ScceClient,
  workspaceId: string,
  workspaceRootPath: string,
  reviewedWorkspace: BoundOpenWorkspace,
  plan: ReviewedPatchPlan
): Promise<AppliedWorkspacePatch> {
  await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
  await verifyReviewedWorkspaceState(reviewedWorkspace, plan);
  let attempt = await activeClient.workspacePatch(workspaceId, plan);
  if ("pendingApproval" in attempt) {
    const pending = attempt.pendingApproval;
    const confirmed = await vscode.window.showWarningMessage(
      `capability.authorize ${pending.planId}`,
      {
        modal: true,
        detail: `capability=${pending.capabilityId}\npatch=${plan.planHash}\nvalidation=${DEFAULT_PATCH_VALIDATION_POLICY_ID}\nretry=once_after_authorization`
      },
      "authorize.and_apply"
    );
    if (confirmed !== "authorize.and_apply") throw new Error("capability.authorize.cancelled");
    await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
    await verifyReviewedWorkspaceState(reviewedWorkspace, plan);
    const approval = await activeClient.approveWorkspacePatch(pending.planId);
    if (approval.approved.planId !== pending.planId) throw new Error("capability.authorize.plan_mismatch");
    await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
    await verifyReviewedWorkspaceState(reviewedWorkspace, plan);
    attempt = await activeClient.workspacePatch(workspaceId, plan);
  }
  if ("pendingApproval" in attempt) throw new Error("capability.authorize.still_required");
  if (
    attempt.workspaceId !== workspaceId
    || attempt.validationPolicyId !== DEFAULT_PATCH_VALIDATION_POLICY_ID
    || attempt.receipt.validation.validatorId !== DEFAULT_PATCH_VALIDATION_POLICY_ID
    || attempt.receipt.planHash !== plan.planHash
  ) {
    throw new Error("patch.receipt.mismatch");
  }
  const applied = verifyAppliedPatchMatchesPlan(attempt, plan);
  await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
  await verifyAppliedWorkspaceState(reviewedWorkspace, plan);
  return applied;
}

async function assertReviewedWorkspaceStillBound(serverRootPath: string, reviewed: BoundOpenWorkspace): Promise<void> {
  const current = await assertServerWorkspaceMatchesOpenFolder(serverRootPath);
  assertSameWorkspacePhysicalBinding(reviewed, current);
  await assertWorkspacePhysicalBinding(reviewed);
}

function codingPlanReviewSummary(generation: WorkspaceCodingPatchPlanSelected): string {
  return [
    patchPlanSummary(generation.plan),
    `request=${generation.requestId}`,
    `requested_paths=${generation.requestedPaths.join(",")}`,
    `workspace.diagnostic TS${generation.diagnosticCode}`,
    `compiler_candidate=${generation.selection.candidateId}`,
    "execution_state=not_executed"
  ].join("\n");
}

interface TypeScriptDiagnosticPick extends vscode.QuickPickItem {
  code: number;
}

async function chooseTypeScriptDiagnosticCodes(
  workspace: BoundOpenWorkspace,
  requestedPaths: readonly string[]
): Promise<number[] | undefined> {
  const observed = new Map<number, Array<{ path: string; diagnostic: vscode.Diagnostic }>>();
  for (const workspacePath of requestedPaths) {
    const uri = vscode.Uri.joinPath(workspace.folder.uri, ...workspacePath.split("/"));
    for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
      const code = numericTypeScriptDiagnosticCode(diagnostic);
      if (code === undefined) continue;
      const entries = observed.get(code) ?? [];
      entries.push({ path: workspacePath, diagnostic });
      observed.set(code, entries);
    }
  }
  if (observed.size === 0) {
    void vscode.window.showInformationMessage("workspace.diagnostics.none");
    return undefined;
  }
  const items: TypeScriptDiagnosticPick[] = [...observed].sort((left, right) => left[0] - right[0]).map(([code, entries]) => ({
    code,
    label: `TS${code}`,
    description: `${entries.length} occurrence${entries.length === 1 ? "" : "s"}`,
    detail: entries.slice(0, 3).map(({ path, diagnostic }) => {
      const start = diagnostic.range.start;
      const message = diagnostic.message.replace(/\s+/gu, " ").trim();
      return `${path}:${start.line + 1}:${start.character + 1} ${message}`;
    }).join(" | ")
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: "workspace.diagnostics.select",
    placeHolder: "workspace.diagnostics.select",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) return undefined;
  const codes = selected.map(item => item.code).sort((left, right) => left - right);
  if (codes.length === 0) {
    void vscode.window.showInformationMessage("workspace.diagnostics.empty");
    return undefined;
  }
  if (codes.length > 128) {
    void vscode.window.showErrorMessage("workspace.diagnostics.over_128");
    return undefined;
  }
  return codes;
}

function numericTypeScriptDiagnosticCode(diagnostic: vscode.Diagnostic): number | undefined {
  const source = diagnostic.source?.trim().toLocaleLowerCase();
  if (source !== "ts" && source !== "typescript") return undefined;
  const raw = diagnostic.code && typeof diagnostic.code === "object" && "value" in diagnostic.code
    ? diagnostic.code.value
    : diagnostic.code;
  const code = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]*$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(code) && code > 0 ? code : undefined;
}

function showAppliedReceipt(applied: AppliedWorkspacePatch): void {
  void vscode.window.showInformationMessage(`patch.transaction.applied operations=${applied.receipt.mutations.length} receipt=${applied.receipt.receiptHash.slice(0, 23)}`);
}
