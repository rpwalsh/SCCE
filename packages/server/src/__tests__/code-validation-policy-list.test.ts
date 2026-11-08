// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";
import type { StructuredPatchValidationPolicy } from "@scce/adapters-node";

const policy: StructuredPatchValidationPolicy = {
  schemaVersion: "scce.patch-validation-policy.v1", id: "selected-project-tests",
  commands: [{ executable: "private-executable", argv: ["private-argument"], checkIds: ["compiler", "tests"] }],
  timeoutMs: 1000, maxOutputBytes: 1024, maxWorkspaceFiles: 10, maxWorkspaceBytes: 1024,
  environment: { PRIVATE_TOKEN: "never-public" }
};
async function list(policies: StructuredPatchValidationPolicy[]) {
  let status = 0;
  let body = "";
  const context = { config: { server: { url: "http://127.0.0.1:3873" }, security: {}, policy: {}, runtime: { patchValidation: { provider: "trusted-host", policies } } } } as unknown as ApiContext;
  await handleRequest({ method: "GET", url: "/api/workspace/code/validation-policies", headers: { host: "127.0.0.1:3873" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
    { writeHead: (value: number) => { status = value; }, end: (value: string) => { body = value; } } as unknown as ServerResponse, context);
  return { status, body, payload: JSON.parse(body) };
}

it("lists registry policy IDs/checks/provider without commands, secrets or invented defaults", async () => {
  const result = await list([policy]);
  expect(result.status).toBe(200);
  expect(result.payload).toEqual({ policies: [{ id: policy.id, checks: ["compiler", "tests"] }], provider: "trusted-host" });
  for (const secret of ["private-executable", "private-argument", "PRIVATE_TOKEN", "never-public"]) expect(result.body).not.toContain(secret);
  expect((await list([])).payload).toEqual({ policies: [], provider: "trusted-host" });
});

it("refuses ambiguous duplicate registry IDs", async () => {
  expect((await list([policy, policy])).status).toBe(500);
});
