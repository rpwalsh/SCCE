import * as vscode from "vscode";
import { YoppClient } from "./client.js";
import { normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken } from "./config.js";
import { TaskTimeline, type ExtensionTaskRecord } from "./task-timeline.js";
import type { YoppEndpoint } from "./protocol.js";
import { DEFAULT_PATCH_VALIDATION_POLICY_ID, parseReviewedPatchPlan, type ReviewedPatchPlan } from "./patch-protocol.js";

const TOKEN_SECRET_KEY = "yopp.serverToken.v1";
const MAX_PATCH_PLAN_BYTES = 8 * 1024 * 1024;

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
  const recovered = await timeline.recoverInterrupted();
  if (recovered) output.appendLine(`[extension] restored ${recovered} interrupted task record(s); requests were not replayed.`);
  context.subscriptions.push(output, status, vscode.window.registerTreeDataProvider("yopp.taskTimeline", provider));

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
    vscode.commands.registerCommand("yopp.workspace.initialize", () => run("workspace.initialize", "Initialize workspace", true, activeClient => activeClient.workspaceInitialize(localWorkspacePath()))),
    vscode.commands.registerCommand("yopp.workspace.ingest", () => run("workspace.ingest", "Ingest workspace", true, activeClient => activeClient.workspaceIngest(localWorkspacePath()))),
    vscode.commands.registerCommand("yopp.project.summary", () => run("project.summary", "Generate project summary", true, activeClient => activeClient.projectSummary(localWorkspacePath()))),
    vscode.commands.registerCommand("yopp.workspace.ask", async () => {
      const question = await vscode.window.showInputBox({ title: "Ask Yopp about this workspace", prompt: "The question and answer will be persisted by the local Yopp runtime.", ignoreFocusOut: true });
      if (!question?.trim()) return;
      const answer = await run("workspace.ask", "Ask workspace question", true, activeClient => activeClient.workspaceAsk(localWorkspacePath(), question));
      if (answer && typeof answer === "object" && "answer" in answer && typeof answer.answer === "string") {
        void vscode.window.showInformationMessage(answer.answer.slice(0, 500));
      }
    }),
    vscode.commands.registerCommand("yopp.workspace.status", () => run("workspace.status", "Load read-only workspace status", false, activeClient => activeClient.workspaceStatus())),
    vscode.commands.registerCommand("yopp.workspace.applyPatchPlan", async () => {
      const plan = await chooseReviewedPatchPlan();
      if (!plan) return;
      const applied = await run("workspace.patch", "Apply reviewed patch transaction", true, async activeClient => {
        const statusResult = await activeClient.workspaceStatus();
        const workspaceId = statusResult.workspace.id;
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
          const approval = await activeClient.approveWorkspacePatch(pending.planId);
          if (approval.approved.planId !== pending.planId) throw new Error("server approved a different patch plan");
          attempt = await activeClient.workspacePatch(workspaceId, plan);
        }
        if ("pendingApproval" in attempt) throw new Error("server still requires approval after the exact approved request was retried");
        if (attempt.workspaceId !== workspaceId || attempt.validationPolicyId !== DEFAULT_PATCH_VALIDATION_POLICY_ID || attempt.receipt.planHash !== plan.planHash) {
          throw new Error("patch receipt does not match the reviewed request");
        }
        return attempt;
      }, {
        message: `Apply ${plan.operations.length} reviewed file operation(s) to this workspace?`,
        detail: `${patchPlanSummary(plan)}\n\nThe server will verify all content hashes, stage the workspace, run ${DEFAULT_PATCH_VALIDATION_POLICY_ID}, require a second capability authorization, and commit only after validation passes. This trusted-host policy is not an OS sandbox; use it only for repository code you trust to run with the server process's authority.`
      });
      if (applied && typeof applied === "object" && "receipt" in applied) {
        void vscode.window.showInformationMessage(`Yopp applied ${applied.receipt.mutations.length} operation(s). Receipt ${applied.receipt.receiptHash.slice(0, 23)}…`);
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

function localWorkspacePath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") throw new Error("Yopp requires an open local file-system workspace");
  return folder.uri.fsPath;
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
    return `${operation.kind} ${operation.path} ${before} → ${after}`;
  });
  if (plan.operations.length > rows.length) rows.push(`…and ${plan.operations.length - rows.length} more operation(s)`);
  return [`Plan ${plan.planHash}`, ...rows].join("\n");
}
