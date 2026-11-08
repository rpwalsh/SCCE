// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { trustedHostPatchValidationProvider, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
import { handleRequest, parseTurnWorkspaceCodingRequest, parseWorkspaceCodingPatchPlanRequest, serverPatchValidationPolicy, serverPatchValidationRuntime, workspacePatchValidationApprovalBinding,
  DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID, DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA, WORKSPACE_CODING_TURN_REQUEST_SCHEMA, type ApiContext } from "../routes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
  expect(path.basename(root)).toMatch(/^scce-policy-api-/u);
  await rm(root, { recursive: true, force: true });
} });

function policy(): StructuredPatchValidationPolicy {
  return { schemaVersion: "scce.patch-validation-policy.v1", id: "local-project.v1", timeoutMs: 5_000, maxOutputBytes: 4096,
    maxWorkspaceFiles: 64, maxWorkspaceBytes: 1_000_000, commands: [
      { executable: process.execPath, argv: ["--check", "application.cjs"], checkIds: ["compiler"] },
      { executable: process.execPath, argv: ["contract.cjs"], checkIds: ["tests"] }
    ] };
}

function config(projectPolicy: StructuredPatchValidationPolicy, root = "."): ApiContext["config"] {
  return { server: { url: "http://127.0.0.1:0" }, runtime: { workspaceRoot: root, tools: {}, patchValidation: { provider: "trusted-host", policies: [projectPolicy] } },
    policy: { allowMutation: true }, security: {} } as unknown as ApiContext["config"];
}

it("registers the exact configured host-owned policy at normal server startup and refuses an unknown id", () => {
  const projectPolicy = policy();
  const configured = config(projectPolicy);
  expect(serverPatchValidationPolicy(configured, projectPolicy.id)).toEqual(projectPolicy);
  const runtime = serverPatchValidationRuntime(configured);
  expect(runtime?.provider).toBe(trustedHostPatchValidationProvider);
  expect(runtime?.resolvePolicy(projectPolicy.id)).toEqual(projectPolicy);
  expect(() => runtime?.resolvePolicy("unregistered.v1")).toThrow(/unknown workspace patch validation policy/u);
  expect(() => serverPatchValidationPolicy(configured, "unregistered.v1")).toThrow(/unknown workspace patch validation policy/u);
});

it("lets patch and turn selectors name a registered id through the server resolver while retaining strict standalone parsing", () => {
  const projectPolicy = policy();
  const runtime = serverPatchValidationRuntime(config(projectPolicy));
  if(!runtime) throw Error("missing registered policy runtime");
  const request = { schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA, workspaceId: "workspace.owned", expectedWorkspaceUpdatedAt: 1, requestId: "request.owned",
    requestText: "repair", requestedPaths: ["src/ledger.go"], diagnosticCodes: [], validationPlan: { validatorId: projectPolicy.id, checks: ["compiler", "tests"] } };
  expect(() => parseWorkspaceCodingPatchPlanRequest(request)).toThrow(/unknown workspace patch validation policy/u);
  expect(parseWorkspaceCodingPatchPlanRequest(request, { resolveValidationPolicy: runtime.resolvePolicy }).input.validationPlan.validatorId).toBe(projectPolicy.id);
  const { requestText: _requestText, ...selector } = request;
  expect(parseTurnWorkspaceCodingRequest({ ...selector, schemaVersion: WORKSPACE_CODING_TURN_REQUEST_SCHEMA }, "owned turn", { resolveValidationPolicy: runtime.resolvePolicy })?.validationPlan.validatorId).toBe(projectPolicy.id);
  expect(() => parseWorkspaceCodingPatchPlanRequest({ ...request, validationPlan: { ...request.validationPlan, validatorId: "unregistered.v1" } }, { resolveValidationPolicy: runtime.resolvePolicy })).toThrow(/unknown workspace patch validation policy/u);
});

it("keeps reserved planning IDs outside a custom resolver's declared policy ownership", () => {
  const calls: string[] = [];
  const projectPolicy = policy();
  const resolveValidationPolicy = (id: string) => { calls.push(id); if (id === projectPolicy.id) return projectPolicy; throw Error(`foreign policy: ${id}`); };
  const request = { schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA, workspaceId: "workspace.owned", expectedWorkspaceUpdatedAt: 1, requestId: "request.owned",
    requestText: "repair", requestedPaths: ["src/ledger.go"], diagnosticCodes: [], validationPlan: { validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID, checks: ["compiler", "tests"] } };
  for (const validatorId of [DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID, DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID]) {
    expect(parseWorkspaceCodingPatchPlanRequest({ ...request, validationPlan: { ...request.validationPlan, validatorId } }, { resolveValidationPolicy }).input.validationPlan.validatorId).toBe(validatorId);
    const { requestText: _requestText, ...selector } = request;
    expect(parseTurnWorkspaceCodingRequest({ ...selector, schemaVersion: WORKSPACE_CODING_TURN_REQUEST_SCHEMA, validationPlan: { ...request.validationPlan, validatorId } }, "owned turn", { resolveValidationPolicy })?.validationPlan.validatorId).toBe(validatorId);
  }
  expect(calls).toEqual([]);
  expect(parseWorkspaceCodingPatchPlanRequest({ ...request, validationPlan: { ...request.validationPlan, validatorId: projectPolicy.id } }, { resolveValidationPolicy }).input.validationPlan.validatorId).toBe(projectPolicy.id);
  expect(calls).toEqual([projectPolicy.id]);
});

it("resolves policy IDs through their exact built-in, configured or delegated owner without masking owner failures", async () => {
  const projectPolicy = policy();
  const base = config(projectPolicy);
  const seen: string[] = [];
  const context = { config: { ...base, runtime: { ...base.runtime, tools: { pnpm: process.execPath } } },
    patchValidation: { provider: trustedHostPatchValidationProvider, resolvePolicy: (id: string) => {
      seen.push(id);
      if (id === "owner-only.v1") return { ...projectPolicy, id };
      if (id === "wrong-id.v1") return projectPolicy;
      throw Error(`owner resolution failed: ${id}`);
    } }, runtime: { approvals: { isApproved: () => false, requestApproval: () => ({ id: "pending.policy-owner" }), snapshot: () => ({ operatorGrant: false, pending: [] }) } }
  } as unknown as ApiContext;
  const request = { path: "application.cjs", request: "repair" };
  for (const validationPolicyId of [DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID, projectPolicy.id]) {
    expect((await post(context, { ...request, validationPolicyId })).status).toBe(202);
  }
  expect(seen).toEqual([]);
  expect((await post(context, { ...request, validationPolicyId: "owner-only.v1" })).status).toBe(202);
  expect(seen).toEqual(["owner-only.v1"]);
  const broken = await post(context, { ...request, validationPolicyId: "broken-owner.v1" });
  expect(broken.status).toBe(500);
  expect(await broken.text()).toContain("owner resolution failed: broken-owner.v1");
  expect((await post(context, { ...request, validationPolicyId: "wrong-id.v1" })).status).toBe(400);
  expect((await post(context, { ...request, validationPolicyId: DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID })).status).toBe(400);
  expect(seen).toEqual(["owner-only.v1", "broken-owner.v1", "wrong-id.v1"]);
});

it("binds code approval to configured command contents and rejects request commands and unregistered ids before execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-policy-api-"));
  roots.push(root);
  await writeFile(path.join(root, "application.cjs"), "exports.value = 1;\n");
  const original = policy();
  const oldBinding = workspacePatchValidationApprovalBinding(original, trustedHostPatchValidationProvider);
  const changed = { ...original, commands: [{ ...original.commands[0]!, argv: ["-e", "require('node:fs').writeFileSync('executed.txt','unapproved')"] }, original.commands[1]!] };
  const seen: Array<Record<string, unknown>> = [];
  const context = { config: config(changed, root), runtime: { approvals: {
    isApproved: ({ input }: { input: Record<string, unknown> }) => { seen.push(input); return input.validationBinding === oldBinding; },
    requestApproval: () => ({ id: "pending.owned-policy" }), snapshot: () => ({ operatorGrant: false, pending: [] })
  } } } as unknown as ApiContext;
  const request = { path: "application.cjs", request: "repair", validationPolicyId: original.id };
  const pending = await post(context, request);
  expect(pending.status).toBe(202);
  expect(seen[0]).toMatchObject({ validationPolicyId: original.id,
    validationBinding: workspacePatchValidationApprovalBinding(changed, trustedHostPatchValidationProvider) });
  expect(seen[0]?.validationBinding).not.toBe(oldBinding);
  const unknown = await post(context, { ...request, validationPolicyId: "unregistered.v1" });
  expect(unknown.status).toBe(400);
  expect(await unknown.text()).toContain("unknown workspace patch validation policy");
  for (const forbidden of ["commands", "executable", "argv", "environment", "provider", "authorization", "rootPath"]) {
    const response = await post(context, { ...request, [forbidden]: "client supplied" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unexpected");
  }
  expect(seen).toHaveLength(1);
  expect(await readFile(path.join(root, "application.cjs"), "utf8")).toBe("exports.value = 1;\n");
  expect(await readdir(root)).toEqual(["application.cjs"]);
});

async function post(context: ApiContext, body: unknown): Promise<Response> {
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    if(!address || typeof address === "string") throw Error("fixture has no port");
    return await fetch(`http://127.0.0.1:${address.port}/api/workspace/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
