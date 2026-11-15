// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { fetchQuery } from "relay-runtime";
import runtimeQuery from "./__generated__/WorkbenchRuntimeQuery.graphql";
import { createLocalEnvironment } from "./network.js";
import { createRelayTurnController } from "./relay-turn-controller.js";
import { WorkbenchTurnController, pendingCapabilityApproval, type TurnControllerPorts } from "./turn-controller.js";

const context = { schema: "scce.workspace.action-context.v1", workspaceId: "workspace.exact", expectedWorkspaceUpdatedAt: 10, policyId: "policy.exact" };
function store() {
  const rows = new Map<string, string>();
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, rows };
}
function proposal(index: number, capabilityId = "filesystem.write") {
  return pendingCapabilityApproval({ pendingApproval: { planId: `plan.${index}`, capabilityId, fingerprint: String(index).repeat(64),
    input: { workspaceContext: context, path: "output.json", content: "exact source bytes" },
    approvalScope: { episodeId: "episode.exact", goalId: "goal.exact", taskId: `step.${index}`, inputRef: `input.${index}` }, reason: "approval-required" } })!;
}
function ports(): TurnControllerPorts {
  return { reserve: vi.fn(async () => "task.exact"), start: vi.fn(async () => {}),
    approve: vi.fn(async input => ({ planId: input.planId, capabilityId: "filesystem.write" })),
    reject: vi.fn(async input => ({ planId: input.planId, capabilityId: "filesystem.write" })), cancel: vi.fn(async () => {}) };
}

describe("Workbench action continuation", () => {
  it("uses compiled Relay operations for explicit two-approval continuation on the same task across cold reconnect and edited new work", async () => {
    const submissions = store(), requests: any[] = [], approved = new Set<string>(); let nextTask = 0;
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body)); requests.push(structuredClone(request));
      const input = request.variables?.input; let data;
      switch (request.operationName) {
        case "WorkbenchRuntimeQuery": data = { runtime: { protocolVersion: "scce.graphql.v1", generation: "host", phase: "ready", ready: true } }; break;
        case "WorkbenchReserveMutation": data = { reserveTurn: { task: { id: `task.${++nextTask}`, status: "accepted" } } }; break;
        case "WorkbenchStartMutation": data = { startTurn: { task: { id: input.operationId, status: "running", latestSequence: requests.length } } }; break;
        case "WorkbenchApprovePlanMutation": approved.add(input.planId); data = { vscodeApprovePlan: { approved: { planId: input.planId, capabilityId: input.planId === "plan.2" ? "workspace.check" : "filesystem.write" }, clientMutationId: null } }; break;
        default: throw Error(`Unexpected operation ${request.operationName}`);
      }
      return new Response(JSON.stringify({ data, extensions: { protocolVersion: "scce.graphql.v1", generation: "host" } }));
    });
    const connect = async () => {
      const connection = createLocalEnvironment({ endpoint: "http://localhost:3873/api/graphql", token: "never-save-this", fetch: fetcher as typeof fetch });
      await fetchQuery(connection.environment, runtimeQuery, {}).toPromise();
      return { connection, controller: createRelayTurnController(connection.environment, submissions, "http://localhost:3873/api/graphql") };
    };
    const first = await connect();
    const original = "Copy the exact admitted source and run its check.";
    const task = await first.controller.submit(original, { sessionId: "workbench.default", workspaceActionContext: context });
    expect(approved.size).toBe(0);
    expect(requests.find(row => row.operationName === "WorkbenchStartMutation").variables.input.requestedAuthority).toBeUndefined();
    let editor = "New editor text must become separate work.";
    await Promise.all([first.controller.decideAndResume(task, proposal(1), "approve"), first.controller.decideAndResume(task, proposal(1), "approve")]);
    first.connection.close();
    const cold = await connect();
    expect(cold.controller.load(task)?.input.text).toBe(original);
    await cold.controller.decideAndResume(task, proposal(2, "workspace.check"), "approve");
    const starts = requests.filter(row => row.operationName === "WorkbenchStartMutation").map(row => row.variables.input);
    expect(starts).toHaveLength(3);
    expect(starts.every(input => input.operationId === task && input.text === original)).toBe(true);
    expect(starts.every(input => JSON.stringify(input.workspaceActionContext) === JSON.stringify(context))).toBe(true);
    expect([...approved]).toEqual(["plan.1", "plan.2"]);
    expect(requests.filter(row => row.operationName === "WorkbenchApprovePlanMutation")).toHaveLength(2);
    const next = await cold.controller.submit(editor);
    expect(next).not.toBe(task);
    expect(cold.controller.load(task)?.input.text).toBe(original);
    expect(cold.controller.load(next)?.input.text).toBe(editor);
    expect(JSON.stringify([...submissions.rows])).not.toContain("never-save-this");
    cold.connection.close();
  });

  it("reuses the same decision operation after a lost acknowledgement and never resumes before a matching approval receipt", async () => {
    const saved = store(), p = ports(), ids: string[] = []; let acknowledged = false;
    p.approve = vi.fn(async input => { ids.push(input.operationId); if (!acknowledged) { acknowledged = true; throw Error("response lost"); } return { planId: input.planId, capabilityId: "filesystem.write" }; });
    const first = new WorkbenchTurnController(p, saved, "host", () => "fixed-approval-operation");
    const task = await first.submit("Frozen request", { workspaceActionContext: context });
    await expect(first.decideAndResume(task, proposal(1), "approve")).rejects.toThrow("response lost");
    expect(p.start).toHaveBeenCalledTimes(1);
    const cold = new WorkbenchTurnController(p, saved, "host", () => "must-not-be-used");
    await cold.decideAndResume(task, proposal(1), "approve");
    expect(ids).toEqual(["fixed-approval-operation", "fixed-approval-operation"]);
    expect(p.start).toHaveBeenCalledTimes(2);
    await cold.refreshProposal(task);
    expect(ids).toHaveLength(2);
    expect(p.start).toHaveBeenCalledTimes(3);
    await new WorkbenchTurnController(p, saved, "host").decideAndResume(task, proposal(1), "approve");
    expect(ids).toEqual(["fixed-approval-operation", "fixed-approval-operation", "fixed-approval-operation"]);
  });

  it("refuses missing or different browser scope, altered proposals and mismatched receipts without executing or approving", async () => {
    const saved = store(), p = ports(), controller = new WorkbenchTurnController(p, saved, "host");
    const task = await controller.submit("Frozen request", { workspaceActionContext: context });
    await expect(new WorkbenchTurnController(p, saved, "other-host").decideAndResume(task, proposal(1), "approve")).rejects.toThrow("not saved");
    await expect(controller.decideAndResume("missing", proposal(1), "approve")).rejects.toThrow("not saved");
    const changed = proposal(1); (changed.input as any).workspaceContext.policyId = "forged";
    await expect(controller.decideAndResume(task, changed, "approve")).rejects.toThrow("saved workspace scope");
    expect(p.approve).not.toHaveBeenCalled();
    p.approve = vi.fn(async () => ({ planId: "different", capabilityId: "filesystem.write" }));
    await expect(controller.decideAndResume(task, proposal(1), "approve")).rejects.toThrow("does not match");
    expect(p.start).toHaveBeenCalledTimes(1);
  });

  it("rejects explicitly and cancels the same task without approving or reexecuting; captures context before an asynchronous reservation", async () => {
    const saved = store(), p = ports(); let reserve!: (id: string) => void;
    p.reserve = () => new Promise(resolve => { reserve = resolve; });
    const controller = new WorkbenchTurnController(p, saved, "host"), selected = { ...context };
    const submitting = controller.submit("Original", { workspaceActionContext: selected });
    selected.policyId = "changed-in-editor"; reserve("task.exact"); await submitting;
    expect(controller.load("task.exact")?.input.workspaceActionContext?.policyId).toBe(context.policyId);
    await controller.decideAndResume("task.exact", proposal(1), "reject");
    expect(p.reject).toHaveBeenCalledTimes(1); expect(p.approve).not.toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalledExactlyOnceWith("task.exact");
    expect(vi.mocked(p.start).mock.calls.map(call => call[0].operationId)).toEqual(["task.exact"]);
    expect(Object.isFrozen(vi.mocked(p.start).mock.calls[0]![0].workspaceActionContext)).toBe(true);
  });
});
