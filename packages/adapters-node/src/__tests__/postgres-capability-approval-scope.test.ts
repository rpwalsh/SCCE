// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityPlan } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { ApprovalSession } from "../approval-session.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "offline_capability_scope" });
  adapters.push(adapter);
  const rows = new Map<string, Record<string, unknown>>();
  const writes: unknown[][] = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (sql.includes("INSERT INTO") && sql.includes("capability_calls")) {
      writes.push(params);
      rows.set(String(params[0]), { id: params[0], episode_id: params[1], capability_id: params[2], phase: params[3], status: params[4],
        input_json: JSON.parse(String(params[5])), result_json: JSON.parse(String(params[6])), risk_vector: JSON.parse(String(params[7])),
        permission_json: JSON.parse(String(params[8])), created_at: new Date(Number(params[9])), completed_at: params[10] });
      return [];
    }
    if (sql.includes("SELECT *") && sql.includes("capability_calls")) return [...rows.values()].filter(row => row.episode_id === params[0]) as T[];
    throw new Error("unexpected offline query");
  };
  return { adapter, rows, writes };
}

const plan = (): CapabilityPlan => ({ id: "plan.scoped" as CapabilityPlan["id"], episodeId: "episode.audit.turn" as CapabilityPlan["episodeId"], capabilityId: "outlook.send_mail", phase: "commit", status: "planned",
  input: { messageId: "observed.provider.draft" }, riskVector: { risk: 1 }, permission: { allowed: false, dryRun: true, reason: "approval-required" }, createdAt: 1,
  approvalScope: { episodeId: "episode.scoped", goalId: "goal.scoped", taskId: "send.scoped", inputRef: "input.concrete" } });

describe("canonical capability approval scope persistence", () => {
  it("round-trips the exact task scope through existing permission JSON and authorizes only that action", async () => {
    const f = fixture();
    const original = plan();
    await f.adapter.capabilities.putPlan(original);
    const restored = (await f.adapter.capabilities.listByEpisode(original.episodeId))[0]!;
    expect(restored.approvalScope).toEqual(original.approvalScope);
    expect(restored.permission).toEqual(original.permission);
    expect(restored.input).toEqual(original.input);
    expect(JSON.parse(String(f.writes[0]![8]))).toEqual({ ...(original.permission as object), approvalScope: original.approvalScope });
    const approvals = new ApprovalSession();
    approvals.observePending(restored);
    approvals.approve(String(restored.id));
    expect(approvals.isApproved({ capabilityId: restored.capabilityId, input: restored.input, approvalScope: restored.approvalScope })).toBe(true);
    expect(approvals.isApproved({ capabilityId: restored.capabilityId, input: restored.input, approvalScope: { ...restored.approvalScope!, taskId: "other.task" } })).toBe(false);
    const unscoped = { ...original, id: "plan.unscoped", approvalScope: undefined } as CapabilityPlan;
    await f.adapter.capabilities.putPlan(unscoped);
    expect((await f.adapter.capabilities.listByEpisode(original.episodeId)).find(row => row.id === unscoped.id)?.approvalScope).toBeUndefined();
  });

  it("rejects incomplete or corrupt stored approval scope before approval can be borrowed", async () => {
    const f = fixture();
    const original = plan();
    await expect(f.adapter.capabilities.putPlan({ ...original, approvalScope: { ...original.approvalScope!, episodeId: "" } })).rejects.toThrow(/exact execution identities/);
    expect(f.writes).toEqual([]);
    await f.adapter.capabilities.putPlan(original);
    (f.rows.get(String(original.id))!.permission_json as Record<string, unknown>).approvalScope = { ...original.approvalScope, taskId: "" };
    await expect(f.adapter.capabilities.listByEpisode(original.episodeId)).rejects.toThrow(/exact execution identities/);
  });
});
