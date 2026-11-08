// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CodeEditResult } from "./protocol.js";

export interface CodeValidationPolicy { id: string; checks: string[] }
export interface CodeEditApproval { pendingApproval: { planId: string; capabilityId: "workspace.code"; fingerprint: string } }
export type CodeEditAttempt = CodeEditResult | CodeEditApproval;

export function parseCodeEditAttempt(value: unknown): CodeEditAttempt {
  if (!value || typeof value !== "object") throw Error("Invalid code edit response");
  const row = value as Record<string, unknown>;
  if ("pendingApproval" in row) {
    const pending = row.pendingApproval as Record<string, unknown> | undefined;
    if (!pending || pending.capabilityId !== "workspace.code" || typeof pending.planId !== "string" || !pending.planId || typeof pending.fingerprint !== "string" || !pending.fingerprint) throw Error("Invalid code edit approval");
    return value as CodeEditApproval;
  }
  if (!["resolved", "no_proposal", "awaiting_selection", "budget_exhausted", "stopped"].includes(String(row.outcome)) || !Number.isFinite(row.attempts)) throw Error("Invalid code edit result");
  return value as CodeEditResult;
}

export function parseCodeValidationPolicies(value: unknown): { policies: CodeValidationPolicy[]; provider: string } {
  const row = value as { policies?: unknown; provider?: unknown } | null;
  if (!row || !Array.isArray(row.policies) || typeof row.provider !== "string") throw Error("Invalid validation policy list");
  const policies = row.policies.map((entry: unknown) => {
    const policy = entry as CodeValidationPolicy | null;
    if (!policy || typeof policy.id !== "string" || !policy.id.trim() || !Array.isArray(policy.checks) || !policy.checks.every(check => typeof check === "string")) throw Error("Invalid validation policy descriptor");
    return { id: policy.id, checks: [...policy.checks] };
  });
  if (new Set(policies.map(policy => policy.id)).size !== policies.length) throw Error("Duplicate validation policy descriptor");
  return { policies, provider: row.provider };
}

export async function editCodeWithApproval(
  client: {
    editCode(path: string, request: string, attempts: number | undefined, validationPolicyId: string | undefined): Promise<CodeEditAttempt>;
    approveCodeEdit(planId: string): Promise<{ approved: { planId: string; capabilityId: string } }>;
  },
  path: string, request: string, validationPolicyId: string | undefined,
  authorize: (pending: CodeEditApproval["pendingApproval"]) => Promise<boolean>
): Promise<CodeEditAttempt> {
  const result = await client.editCode(path, request, undefined, validationPolicyId);
  if (!("pendingApproval" in result) || !await authorize(result.pendingApproval)) return result;
  const approval = await client.approveCodeEdit(result.pendingApproval.planId);
  if (approval.approved.planId !== result.pendingApproval.planId || approval.approved.capabilityId !== "workspace.code") throw Error("Code edit approval does not match the requested plan");
  const retried = await client.editCode(path, request, undefined, validationPolicyId);
  if ("pendingApproval" in retried) throw Error("Code edit requires renewed approval; retry the command");
  return retried;
}

export function parseCodeEditApproval(value: unknown): { approved: { planId: string; capabilityId: "workspace.code" } } {
  const approved = (value as { approved?: { planId?: unknown; capabilityId?: unknown } } | null)?.approved;
  if (!approved || typeof approved.planId !== "string" || !approved.planId || approved.capabilityId !== "workspace.code") throw Error("Invalid code edit authorization");
  return { approved: { planId: approved.planId, capabilityId: "workspace.code" } };
}

export async function editCodeWithSelection(
  client: Parameters<typeof editCodeWithApproval>[0], path: string, request: string, policyId: string | undefined,
  authorize: Parameters<typeof editCodeWithApproval>[4],
  select: (candidates: NonNullable<CodeEditResult["candidates"]>) => Promise<string | undefined>
): Promise<CodeEditAttempt> {
  const result = await editCodeWithApproval(client, path, request, policyId, authorize);
  if ("pendingApproval" in result || result.outcome !== "awaiting_selection" || !result.candidates?.length) return result;
  const identity = await select(result.candidates);
  if (identity === undefined) return result;
  if (!result.candidates.some(candidate => candidate.codeFixIdentity === identity)) throw Error("Unknown compiler fix selection");
  return editCodeWithApproval(client, path, request + " codeFixIdentity:" + identity, policyId, authorize);
}
