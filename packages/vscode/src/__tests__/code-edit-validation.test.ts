// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { ScceClient } from "../client.js";
import { editCodeWithSelection } from "../code-edit-flow.js";

const pending = (planId: string, capabilityId = "workspace.code") => ({ ok: false, pendingApproval: { planId, capabilityId, fingerprint: "bound-" + planId } });
const selected = { outcome: "awaiting_selection", attempts: 0, finalDiagnostics: [], candidates: [{ diagnosticCode: 2551, fixName: "spelling", codeFixIdentity: "owned-fix" }] };
const resolved = { outcome: "resolved", attempts: 1, finalDiagnostics: [] };

it("uses server policies through candidate and approval retries", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const replies: unknown[] = [{ policies: [{ id: "repository-behavior.v3", checks: ["compiler", "tests"] }], provider: "trusted-host" },
    pending("initial"), { approved: { planId: "initial", capabilityId: "workspace.code" }, session: {} }, selected,
    pending("candidate"), { approved: { planId: "candidate", capabilityId: "workspace.code" }, session: {} }, resolved];
  const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", token: "", timeoutMs: 10000 }, async (path, init) => {
    requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const value = replies.shift();
    return new Response(JSON.stringify(value), { status: value && typeof value === "object" && "pendingApproval" in value ? 202 : 200 });
  });
  const available = await client.codeValidationPolicies();
  const approvals: string[] = [];
  expect(await editCodeWithSelection(client, "src/file.ts", "repair", available.policies[0]!.id, async approval => {
    approvals.push(approval.planId); return true;
  }, async candidates => candidates[0]!.codeFixIdentity)).toEqual(resolved);
  expect(approvals).toEqual(["initial", "candidate"]);
  expect(requests.filter(row => row.path.endsWith("/api/workspace/code")).map(row => row.body)).toEqual([
    { path: "src/file.ts", request: "repair", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair codeFixIdentity:owned-fix", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair codeFixIdentity:owned-fix", validationPolicyId: "repository-behavior.v3" }
  ]);
});

it.each(["decline", "foreign", "renewed"])("does not continue on %s authorization", async mode => {
  let edits = 0;
  let authorizations = 0;
  const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", token: "", timeoutMs: 10000 }, async path => {
    if (path.endsWith("/approve")) {
      authorizations++;
      return new Response(JSON.stringify({ approved: { planId: "first", capabilityId: mode === "foreign" ? "workspace.patch.apply" : "workspace.code" }, session: {} }));
    }
    edits++;
    return new Response(JSON.stringify(pending(edits === 1 ? "first" : "changed")), { status: 202 });
  });
  const run = editCodeWithSelection(client, "file.ts", "repair", "selected-policy", async () => mode !== "decline", async () => { throw Error("must not select a candidate"); });
  if (mode === "decline") expect(await run).toMatchObject(pending("first"));
  else await expect(run).rejects.toThrow(mode === "foreign" ? "authorization" : "renewed approval");
  expect(edits).toBe(mode === "renewed" ? 2 : 1);
  expect(authorizations).toBe(mode === "decline" ? 0 : 1);
});

it("retains an explicit workspace build selection without inventing a policy ID", async () => {
  const requests: unknown[] = [];
  const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", token: "", timeoutMs: 10000 }, async (_path, init) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ...resolved, verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } }));
  });
  const result = await editCodeWithSelection(client, "file.ts", "repair", undefined, async () => false, async () => undefined);
  expect(requests).toEqual([{ path: "file.ts", request: "repair" }]);
  expect(result).toMatchObject({ verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } });
});
