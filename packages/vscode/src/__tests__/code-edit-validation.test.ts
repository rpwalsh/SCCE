// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { ScceClient } from "../client.js";
import { editCodeWithSelection } from "../code-edit-flow.js";

const pending = (planId: string, capabilityId = "workspace.code") => ({ ok: false, pendingApproval: { planId, capabilityId, fingerprint: "bound-" + planId } });
const selected = { outcome: "awaiting_selection", attempts: 0, finalDiagnostics: [], candidates: [{ diagnosticCode: 2551, fixName: "spelling", codeFixIdentity: "owned-fix" }] };
const resolved = { outcome: "resolved", attempts: 1, finalDiagnostics: [] };

it("uses server policies through candidate and approval retries", async () => {
  const requests: Array<{ operationName: string; input: Record<string, unknown> }> = [];
  const replies: unknown[] = [{ policies: [{ id: "repository-behavior.v3", checks: ["compiler", "tests"] }], provider: "trusted-host" },
    pending("initial"), { approved: { planId: "initial", capabilityId: "workspace.code" }, session: {} }, selected,
    pending("candidate"), { approved: { planId: "candidate", capabilityId: "workspace.code" }, session: {} }, resolved];
  const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", token: "", timeoutMs: 10000 }, async (_path, init) => {
    const request = graphqlRequest(init);
    const input = (request.variables.input ?? {}) as Record<string, unknown>;
    requests.push({ operationName: request.operationName, input });
    const value = replies.shift();
    const field = request.operationName === "VscodeCodeValidationPoliciesQuery" ? "vscodeCodeValidationPolicies"
      : request.operationName === "VscodeApprovePlanMutation" ? "vscodeApprovePlan" : "vscodeEditCode";
    return graphqlResponse(field, value, input.clientMutationId);
  });
  const available = await client.codeValidationPolicies();
  const approvals: string[] = [];
  expect(await editCodeWithSelection(client, "src/file.ts", "repair", available.policies[0]!.id, async approval => {
    approvals.push(approval.planId); return true;
  }, async candidates => candidates[0]!.codeFixIdentity)).toEqual(resolved);
  expect(approvals).toEqual(["initial", "candidate"]);
  expect(requests.filter(row => row.operationName === "VscodeEditCodeMutation").map(row => commandInput(row.input))).toEqual([
    { path: "src/file.ts", request: "repair", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair codeFixIdentity:owned-fix", validationPolicyId: "repository-behavior.v3" },
    { path: "src/file.ts", request: "repair codeFixIdentity:owned-fix", validationPolicyId: "repository-behavior.v3" }
  ]);
});

it.each(["decline", "foreign", "renewed"])("does not continue on %s authorization", async mode => {
  let edits = 0;
  let authorizations = 0;
  const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", token: "", timeoutMs: 10000 }, async (_path, init) => {
    const request = graphqlRequest(init);
    if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
    const input = request.variables.input as Record<string, unknown>;
    if (request.operationName === "VscodeApprovePlanMutation") {
      authorizations++;
      return graphqlResponse("vscodeApprovePlan", { approved: { planId: "first", capabilityId: mode === "foreign" ? "workspace.patch.apply" : "workspace.code" }, session: {} }, input.clientMutationId);
    }
    edits++;
    return graphqlResponse("vscodeEditCode", pending(edits === 1 ? "first" : "changed"), input.clientMutationId);
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
    const request = graphqlRequest(init);
    if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
    const input = request.variables.input as Record<string, unknown>;
    requests.push(commandInput(input));
    return graphqlResponse("vscodeEditCode", { ...resolved, verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } }, input.clientMutationId);
  });
  const result = await editCodeWithSelection(client, "file.ts", "repair", undefined, async () => false, async () => undefined);
  expect(requests).toEqual([{ path: "file.ts", request: "repair" }]);
  expect(result).toMatchObject({ verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } });
});

interface GraphqlRequest { operationName: string; variables: Record<string, unknown> }
function graphqlRequest(init: RequestInit): GraphqlRequest {
  return JSON.parse(String(init.body)) as GraphqlRequest;
}
function graphqlResponse(field: string, value: unknown, clientMutationId?: unknown): Response {
  const payload = field.endsWith("Policies") ? value
    : field === "vscodeEditCode" ? { value, clientMutationId }
      : { ...(value as Record<string, unknown>), clientMutationId };
  return new Response(JSON.stringify({ data: { [field]: payload },
    extensions: { protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test" } }));
}
function runtimeResponse(): Response {
  return new Response(JSON.stringify({ data: { runtime: { protocolVersion: "scce.graphql.v1", generation: "host-generation", phase: "ready", ready: true } },
    extensions: { protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test" } }));
}
function commandInput(input: Record<string, unknown>): Record<string, unknown> {
  const { operationId: _operationId, clientMutationId: _clientMutationId, ...value } = input;
  return value;
}
