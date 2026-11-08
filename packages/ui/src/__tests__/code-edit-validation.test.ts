// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { renderWorkbench } from "../index.js";

function editCode(hooks: Record<string, unknown>) {
  const html = renderWorkbench("http://127.0.0.1:3873");
  const start = html.indexOf("    async function editCode() {");
  const end = html.indexOf("    async function runCommand", start);
  return new Function(...Object.keys(hooks), html.slice(start, end) + "; return editCode();")(...Object.values(hooks)) as Promise<void>;
}

it("retains the selected policy through browser fix selection and approval retries", async () => {
  const prompts = [" src/file.ts ", " repair ", "2", "1"];
  const calls: Array<{ path: string; body: unknown }> = [];
  const replies = [
    { pendingApproval: { capabilityId: "workspace.code", planId: "first", fingerprint: "binding-first" } },
    { approved: { capabilityId: "workspace.code", planId: "first" } },
    { outcome: "awaiting_selection", candidates: [{ diagnosticCode: 2551, fixName: "spelling", codeFixIdentity: "fix" }] },
    { pendingApproval: { capabilityId: "workspace.code", planId: "fix", fingerprint: "binding-fix" } },
    { approved: { capabilityId: "workspace.code", planId: "fix" } }, { outcome: "resolved" }
  ];
  let confirmed = 0;
  await editCode({ window: { prompt: () => prompts.shift(), confirm: () => { confirmed++; return true; } },
    get: async (path: string) => { expect(path).toBe("/api/workspace/code/validation-policies"); return { policies: [
      { id: "compile-only", checks: ["compiler"] }, { id: "project-tests", checks: ["compiler", "tests"] }
    ], provider: "trusted-host" }; },
    post: async (path: string, body: unknown) => { calls.push({ path, body }); return replies.shift(); },
    log: () => {}, setInspector: () => {}, toggleDevPanel: () => {}, add: () => {}
  });
  expect(confirmed).toBe(2);
  expect(calls.filter(call => call.path === "/api/workspace/code").map(call => call.body)).toEqual([
    { path: "src/file.ts", request: "repair", validationPolicyId: "project-tests" },
    { path: "src/file.ts", request: "repair", validationPolicyId: "project-tests" },
    { path: "src/file.ts", request: "repair codeFixIdentity:fix", validationPolicyId: "project-tests" },
    { path: "src/file.ts", request: "repair codeFixIdentity:fix", validationPolicyId: "project-tests" }
  ]);
});

it.each(["cancel", "decline", "foreign"])("does not silently edit on %s policy/approval", async mode => {
  const prompts = ["file.ts", "repair", mode === "cancel" ? null : "1"];
  const calls: string[] = [];
  const operation = editCode({ window: { prompt: () => prompts.shift(), confirm: () => false },
    get: async () => ({ policies: [{ id: "selected", checks: ["tests"] }], provider: "trusted-host" }),
    post: async (path: string) => { calls.push(path); return { pendingApproval: { planId: "p", fingerprint: "binding", capabilityId: mode === "foreign" ? "workspace.patch.apply" : "workspace.code" } }; },
    log: () => {}, setInspector: () => {}, toggleDevPanel: () => {}, add: () => {}
  });
  if (mode === "foreign") await expect(operation).rejects.toThrow();
  else await operation;
  expect(calls).toEqual(mode === "decline" || mode === "foreign" ? ["/api/workspace/code"] : []);
});

it("retains the explicit workspace build path with an empty policy registry", async () => {
  const prompts = ["file.ts", "repair", "1"];
  const calls: unknown[] = [];
  let shown: unknown;
  await editCode({ window: { prompt: () => prompts.shift() },
    get: async () => ({ policies: [], provider: "trusted-host" }),
    post: async (path: string, body: unknown) => { expect(path).toBe("/api/workspace/code"); calls.push(body); return { outcome: "resolved", verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } }; },
    log: () => {}, setInspector: (value: unknown) => { shown = value; }, toggleDevPanel: () => {}, add: () => {}
  });
  expect(calls).toEqual([{ path: "file.ts", request: "repair" }]);
  expect(shown).toMatchObject({ verification: { scope: "compiler_only", testsRun: false, testsSucceeded: null } });
});
