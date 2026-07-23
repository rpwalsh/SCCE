import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { YoppClient } from "./client.js";
import { normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken } from "./config.js";
import { TaskTimeline, type ExtensionTaskRecord } from "./task-timeline.js";
import type { YoppEndpoint } from "./protocol.js";
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

const TOKEN_SECRET_KEY = "yopp.serverToken.v1";
const MAX_PATCH_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_PREVIEW_BYTES = 16 * 1024 * 1024;
const PATCH_PREVIEW_SCHEME = "yopp-patch-preview";

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Yopp");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "yopp.checkReadiness";
  status.text = "$(pulse) Yopp: checking";
  status.show();

  const timeline = new TaskTimeline(context.globalState);
  const provider = new TaskTimelineProvider(timeline);
  const patchPreview = new PatchPreviewContentProvider();
  const recovered = await timeline.recoverInterrupted();
  if (recovered) output.appendLine(`[extension] restored ${recovered} interrupted task record(s); requests were not replayed.`);
  context.subscriptions.push(
    output,
    status,
    vscode.window.registerTreeDataProvider("yopp.taskTimeline", provider),
    vscode.workspace.registerTextDocumentContentProvider(PATCH_PREVIEW_SCHEME, patchPreview)
  );

  const client = async () => new YoppClient({
    serverUrl: configuredServerUrl(),
    token: normalizeToken(await context.secrets.get(TOKEN_SECRET_KEY)),
    timeoutMs: configuredTimeout()
  });

  const run = async <T>(
    endpoint: YoppEndpoint,
    label: string,
    mutates: boolean,
    action: (activeClient: YoppClient) => Promise<T>,
    approvalNotice?: { message: string; detail: string }
  ): Promise<T | undefined> => {
    const task = await timeline.start(endpoint, label, mutates);
    provider.refresh();
    if (mutates) {
      const approved = await vscode.window.showWarningMessage(
        approvalNotice?.message ?? `${label} writes to Yopp's durable local store. No workspace files will be changed by this extension command.`,
        { modal: true, detail: approvalNotice?.detail ?? "Approve this single request? The approval is not retained for later commands." },
        "Approve once"
      );
      if (approved !== "Approve once") {
        await timeline.transition(task.id, "cancelled", "User did not approve the mutation.");
        provider.refresh();
        return undefined;
      }
      await timeline.transition(task.id, "running");
      provider.refresh();
    }
    try {
      const result = await action(await client());
      await timeline.transition(task.id, "succeeded");
      output.appendLine(`[${new Date().toISOString()}] ${label}`);
      output.appendLine(formatOutput(result));
      output.show(true);
      provider.refresh();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await timeline.transition(task.id, "failed", message);
      provider.refresh();
      output.appendLine(`[${new Date().toISOString()}] ${label} failed: ${message}`);
      void vscode.window.showErrorMessage(`Yopp: ${message}`);
      return undefined;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("yopp.checkReadiness", async () => {
      status.text = "$(pulse) Yopp: checking";
      const result = await run("ready", "Check readiness", false, activeClient => activeClient.ready());
      if (result && typeof result === "object" && "ok" in result && result.ok === true) {
        status.text = "$(check) Yopp: ready";
        status.tooltip = `Ready at ${configuredServerUrl()}`;
      } else {
        status.text = "$(error) Yopp: unavailable";
      }
    }),
    vscode.commands.registerCommand("yopp.setServerToken", async () => {
      const token = await vscode.window.showInputBox({ title: "Yopp local server token", password: true, prompt: "Leave empty to remove the stored token", ignoreFocusOut: true });
      if (token === undefined) return;
      const normalized = normalizeToken(token);
      if (normalized) await context.secrets.store(TOKEN_SECRET_KEY, normalized);
      else await context.secrets.delete(TOKEN_SECRET_KEY);
      void vscode.window.showInformationMessage(normalized ? "Yopp token stored in VS Code SecretStorage." : "Yopp token removed.");
    }),
    vscode.commands.registerCommand("yopp.workspace.initialize", async () => {
      const workspacePath = await chooseLocalWorkspacePathForInitialization();
      if (!workspacePath) return;
      return run("workspace.initialize", "Initialize workspace", true, activeClient => activeClient.workspaceInitialize(workspacePath));
    }),
    vscode.commands.registerCommand("yopp.workspace.ingest", () => run("workspace.ingest", "Ingest workspace", true, async activeClient => {
      const { binding } = await serverBoundWorkspace(activeClient);
      return activeClient.workspaceIngest(binding.resolvedRoot);
    })),
    vscode.commands.registerCommand("yopp.project.summary", () => run("project.summary", "Generate project summary", true, async activeClient => {
      const { binding } = await serverBoundWorkspace(activeClient);
      return activeClient.projectSummary(binding.resolvedRoot);
    })),
    vscode.commands.registerCommand("yopp.workspace.ask", async () => {
      const question = await vscode.window.showInputBox({ title: "Ask Yopp about this workspace", prompt: "The question and answer will be persisted by the local Yopp runtime.", ignoreFocusOut: true });
      if (!question?.trim()) return;
      const answer = await run("workspace.ask", "Ask workspace question", true, async activeClient => {
        const { binding } = await serverBoundWorkspace(activeClient);
        return activeClient.workspaceAsk(binding.resolvedRoot, question);
      });
      if (answer && typeof answer === "object" && "answer" in answer && typeof answer.answer === "string") {
        void vscode.window.showInformationMessage(answer.answer.slice(0, 500));
      }
    }),
    vscode.commands.registerCommand("yopp.workspace.status", () => run("workspace.status", "Load read-only workspace status", false, async activeClient => {
      const { status: workspaceStatus } = await serverBoundWorkspace(activeClient);
      return workspaceStatus;
    })),
    vscode.commands.registerCommand("yopp.workspace.codingRequest", async () => {
      const requestText = await vscode.window.showInputBox({
        title: "Plan a bounded coding request with Yopp",
        prompt: "Describe the requested change. You will select the durable source files that bound its scope next.",
        placeHolder: "Example: Remove unused type import ExampleType from src/example.ts.",
        ignoreFocusOut: true,
        validateInput: value => {
          const normalized = value.trim();
          if (!normalized) return "Enter a coding request.";
          if (normalized.includes("\0")) return "The request cannot contain NUL bytes.";
          if (Buffer.byteLength(normalized, "utf8") > 20_000) return "The request cannot exceed 20000 UTF-8 bytes.";
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
          label: "$(refresh) Refresh durable workspace first",
          description: "Runs the existing ingest command after its separate mutation approval.",
          refresh: true
        },
        {
          label: "$(database) Use current durable revision",
          description: "Plans against the server's current ingested bytes without changing them.",
          refresh: false
        }
      ], {
        title: "Choose the durable-state preflight",
        placeHolder: "Local edits require refresh before exact-byte planning",
        ignoreFocusOut: true
      });
      if (!refreshChoice) return;
      if (refreshChoice.refresh) {
        const refreshed = await run("workspace.ingest", "Refresh durable workspace for coding request", true, activeClient => activeClient.workspaceIngest(codingWorkspace.resolvedRoot));
        if (!refreshed) return;
        scopedStatus = await run("workspace.status", "Reload coding-request scope", false, activeClient => serverBoundWorkspace(activeClient));
        if (!scopedStatus) return;
        statusResult = scopedStatus.status;
        codingWorkspace = scopedStatus.binding;
      }
      if (statusResult.sources.length === 0) {
        void vscode.window.showInformationMessage("Yopp has no durable source files to scope. Initialize and ingest the workspace first.");
        return;
      }
      const selected = await vscode.window.showQuickPick(
        statusResult.sources.map(source => ({ label: source.path, path: source.path })),
        {
          title: "Select the durable files this request may target",
          placeHolder: "Choose 1 through 256 workspace-relative source paths",
          canPickMany: true,
          ignoreFocusOut: true,
          matchOnDescription: false,
          matchOnDetail: false
        }
      );
      if (!selected) return;
      if (selected.length < 1) {
        void vscode.window.showInformationMessage("Select at least one durable source file for the coding request.");
        return;
      }
      if (selected.length > 256) {
        void vscode.window.showErrorMessage("Yopp coding requests are limited to 256 selected source paths.");
        return;
      }
      const diagnosticCodes = await chooseTypeScriptDiagnosticCodes(codingWorkspace, selected.map(item => item.path));
      if (!diagnosticCodes) return;
      const generation = await run(
        "workspace.patch.plan.request",
        "Plan coding request",
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
        output.appendLine(`[${new Date().toISOString()}] Coding request was not resolved: ${reasons}`);
        void vscode.window.showInformationMessage(`Yopp found no unique admissible compiler action. Reason IDs: ${reasons}`);
        return;
      }
      let reviewedWorkspace: BoundOpenWorkspace;
      try {
        reviewedWorkspace = await openPatchPlanPreview(patchPreview, statusResult.workspace.rootPath, generation.plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[${new Date().toISOString()}] Coding-request preview failed: ${message}`);
        void vscode.window.showErrorMessage(`Yopp: ${message}`);
        return;
      }
      const reviewed = await vscode.window.showWarningMessage(
        "Review the opened before/after diff, then confirm whether to continue.",
        { detail: `No files were changed during preview. Plan ${generation.plan.planHash}` },
        "Continue to approval",
        "Cancel"
      );
      if (reviewed !== "Continue to approval") return;
      const applied = await run(
        "workspace.patch",
        "Apply coding-request patch transaction",
        true,
        async activeClient => {
          const currentStatus = await activeClient.workspaceStatus();
          if (currentStatus.workspace.id !== generation.workspaceId) throw new Error("the server's active workspace changed after coding-plan review");
          const currentWorkspace = await assertServerWorkspaceMatchesOpenFolder(currentStatus.workspace.rootPath);
          assertSameWorkspacePhysicalBinding(reviewedWorkspace, currentWorkspace);
          return applyReviewedWorkspacePatch(activeClient, generation.workspaceId, currentStatus.workspace.rootPath, reviewedWorkspace, generation.plan);
        },
        {
          message: `Apply ${generation.plan.operations.length} verified coding-request file operation(s) to this workspace?`,
          detail: `${codingPlanReviewSummary(generation)}\n\nThe server will verify all content hashes, stage the workspace, run ${DEFAULT_PATCH_VALIDATION_POLICY_ID}, require a separate capability authorization, and commit only after validation passes. This trusted-host policy is not an OS sandbox; use it only for repository code you trust to run with the server process's authority.`
        }
      );
      if (applied) showAppliedReceipt(applied);
    }),
    vscode.commands.registerCommand("yopp.workspace.applyPatchPlan", async () => {
      const boundStatus = await run("workspace.status", "Bind reviewed patch workspace", false, async activeClient => {
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
        output.appendLine(`[${new Date().toISOString()}] Reviewed patch preview failed: ${message}`);
        void vscode.window.showErrorMessage(`Yopp: ${message}`);
        return;
      }
      const reviewed = await vscode.window.showWarningMessage(
        "Review the opened before/after diff, then confirm whether to continue.",
        { detail: `No files were changed during preview. Plan ${plan.planHash}` },
        "Continue to approval",
        "Cancel"
      );
      if (reviewed !== "Continue to approval") return;
      const applied = await run("workspace.patch", "Apply reviewed patch transaction", true, async activeClient => {
        const currentStatus = await activeClient.workspaceStatus();
        if (currentStatus.workspace.id !== boundStatus.workspace.id) throw new Error("the server's active workspace changed after patch-plan review");
        const currentWorkspace = await assertServerWorkspaceMatchesOpenFolder(currentStatus.workspace.rootPath);
        assertSameWorkspacePhysicalBinding(reviewedWorkspace, currentWorkspace);
        return applyReviewedWorkspacePatch(activeClient, boundStatus.workspace.id, currentStatus.workspace.rootPath, reviewedWorkspace, plan);
      }, {
        message: `Apply ${plan.operations.length} reviewed file operation(s) to this workspace?`,
        detail: `${patchPlanSummary(plan)}\n\nThe server will verify all content hashes, stage the workspace, run ${DEFAULT_PATCH_VALIDATION_POLICY_ID}, require a second capability authorization, and commit only after validation passes. This trusted-host policy is not an OS sandbox; use it only for repository code you trust to run with the server process's authority.`
      });
      if (applied && typeof applied === "object" && "receipt" in applied) {
        showAppliedReceipt(applied);
      }
    }),
    vscode.commands.registerCommand("yopp.tasks.clear", async () => {
      await timeline.clear();
      provider.refresh();
    })
  );

  void vscode.commands.executeCommand("yopp.checkReadiness");
}

export function deactivate(): void {}

function configuredServerUrl(): string {
  return normalizeLocalServerUrl(vscode.workspace.getConfiguration("yopp").get<string>("serverUrl"));
}

function configuredTimeout(): number {
  return normalizeRequestTimeout(vscode.workspace.getConfiguration("yopp").get<number>("requestTimeoutMs"));
}

async function chooseLocalWorkspacePathForInitialization(): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("Yopp initialization requires an open local file-system workspace folder.");
    return undefined;
  }
  if (folders.length === 1) return folders[0]!.uri.fsPath;
  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    {
      title: "Select the local workspace folder to initialize",
      placeHolder: "Yopp will initialize only the explicitly selected folder",
      ignoreFocusOut: true
    }
  );
  return selected?.folder.uri.fsPath;
}

async function serverBoundWorkspace(activeClient: YoppClient): Promise<{
  status: Awaited<ReturnType<YoppClient["workspaceStatus"]>>;
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
    title: "Select a reviewed Yopp patch transaction plan",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Yopp patch plan": ["json"] },
    openLabel: "Review plan"
  });
  const uri = selected?.[0];
  if (!uri) return undefined;
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_PATCH_PLAN_BYTES) throw new Error("patch plan exceeds the 8 MiB extension limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`patch plan is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseReviewedPatchPlan(value);
}

function patchPlanSummary(plan: ReviewedPatchPlan): string {
  const rows = plan.operations.slice(0, 20).map(operation => {
    const before = operation.beforeContentHash?.slice(7, 19) ?? "new";
    const after = operation.afterContentHash?.slice(7, 19) ?? "deleted";
    return `${operation.kind} ${operation.path} ${before} -> ${after}`;
  });
  if (plan.operations.length > rows.length) rows.push(`...and ${plan.operations.length - rows.length} more operation(s)`);
  return [`Plan ${plan.planHash}`, reviewedPatchIntegritySummary(plan), ...rows].join("\n");
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
    throw new Error("the selected workspace folder changed while its physical identity was captured");
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
      if (bytes.includes(0)) throw new Error(`patch preview supports UTF-8 text only: ${operation.path}`);
      try {
        beforeContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error(`patch preview could not decode ${operation.path} as exact UTF-8 text`);
      }
      contentBytes += bytes.byteLength;
    }
    const afterContent = operation.kind === "delete" ? null : operation.content;
    if (afterContent !== null) contentBytes += Buffer.byteLength(afterContent, "utf8");
    if (contentBytes > MAX_PATCH_PREVIEW_BYTES) throw new Error("combined patch preview exceeds the 16 MiB extension limit");
    entries.push({ operation, beforeContent, afterContent });
  }
  const before = combinedPatchPreview(entries, "before");
  const after = combinedPatchPreview(entries, "after");
  if (Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8") > MAX_PATCH_PREVIEW_BYTES) {
    throw new Error("combined patch preview exceeds the 16 MiB extension limit after review metadata");
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
    `Yopp patch preview (${plan.operations.length} operation${plan.operations.length === 1 ? "" : "s"})`,
    { preview: false }
  );
  await assertWorkspacePhysicalBinding(workspace);
  return workspace;
}

function combinedPatchPreview(entries: readonly PatchPreviewEntry[], side: "before" | "after"): string {
  return entries.map((entry, index) => {
    const content = side === "before" ? entry.beforeContent : entry.afterContent;
    const hash = side === "before" ? entry.operation.beforeContentHash : entry.operation.afterContentHash;
    const absentState = side === "before" ? "[file absent before create]" : "[file deleted by plan]";
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
  activeClient: YoppClient,
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
      `Authorize server plan ${pending.planId}?`,
      {
        modal: true,
        detail: `Capability: ${pending.capabilityId}\nPatch: ${plan.planHash}\nValidation: ${DEFAULT_PATCH_VALIDATION_POLICY_ID}\nThe exact request will be retried once after authorization.`
      },
      "Authorize and apply"
    );
    if (confirmed !== "Authorize and apply") throw new Error("server patch authorization was cancelled");
    await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
    await verifyReviewedWorkspaceState(reviewedWorkspace, plan);
    const approval = await activeClient.approveWorkspacePatch(pending.planId);
    if (approval.approved.planId !== pending.planId) throw new Error("server approved a different patch plan");
    await assertReviewedWorkspaceStillBound(workspaceRootPath, reviewedWorkspace);
    await verifyReviewedWorkspaceState(reviewedWorkspace, plan);
    attempt = await activeClient.workspacePatch(workspaceId, plan);
  }
  if ("pendingApproval" in attempt) throw new Error("server still requires approval after the exact approved request was retried");
  if (
    attempt.workspaceId !== workspaceId
    || attempt.validationPolicyId !== DEFAULT_PATCH_VALIDATION_POLICY_ID
    || attempt.receipt.validation.validatorId !== DEFAULT_PATCH_VALIDATION_POLICY_ID
    || attempt.receipt.planHash !== plan.planHash
  ) {
    throw new Error("patch receipt does not match the reviewed request");
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
    `Request: ${generation.requestId}`,
    `Requested paths: ${generation.requestedPaths.join(", ")}`,
    `Compiler diagnostic selector: TS${generation.diagnosticCode}`,
    `Compiler candidate: ${generation.selection.candidateId}`,
    "Execution state: not_executed"
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
    void vscode.window.showInformationMessage("No current positive-integer TypeScript diagnostics were found in the selected files.");
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
    title: "Select TypeScript compiler diagnostics",
    placeHolder: "Only the selected numeric codes may choose a server-observed compiler action",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) return undefined;
  const codes = selected.map(item => item.code).sort((left, right) => left - right);
  if (codes.length === 0) {
    void vscode.window.showInformationMessage("Select at least one TypeScript diagnostic code.");
    return undefined;
  }
  if (codes.length > 128) {
    void vscode.window.showErrorMessage("Yopp coding requests are limited to 128 diagnostic codes.");
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
  void vscode.window.showInformationMessage(`Yopp applied ${applied.receipt.mutations.length} operation(s). Receipt ${applied.receipt.receiptHash.slice(0, 23)}...`);
}
