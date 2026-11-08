// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runStructuredWorkspaceValidation, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
import { handleRequest, type ApiContext } from "../routes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("scce-code-api-receipt-")) throw Error("invalid fixture cleanup path");
  await rm(root, { recursive: true, force: true });
} });

it.each([false, true])("returns and records exact TS2551 verification with configured tests=%s", async withTests => {
  const root = await mkdtemp(join(resolve(tmpdir()), "scce-code-api-receipt-")); roots.push(root);
  const sourceRoot = new URL("../../../../tools/repair-acceptance/cases/map-write-loss/", import.meta.url);
  const target = "src/paired-evaluation-statistics.ts";
  for (const file of ["case.json", "package.json", "tsconfig.json", target, "src/cli.mjs", "test/unit.mjs", "test/e2e.mjs", "test/all.mjs"]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), await readFile(new URL(file, sourceRoot)));
  }
  const original = await readFile(join(root, target), "utf8");
  await writeFile(join(root, target), original.replace("byFamily.set(record.taskFamilyId, bucket)", "byFamily.set(record.taskFamliyId, bucket)"));
  const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "frozen-map-write-tests.v1",
    commands: [
      { executable: process.execPath, argv: [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], checkIds: ["compiler", "typecheck"] },
      { executable: process.execPath, argv: ["test/all.mjs"], checkIds: ["tests"] }
    ], timeoutMs: 30000, maxOutputBytes: 128 * 1024, maxWorkspaceFiles: 32, maxWorkspaceBytes: 1024 * 1024,
    environment: { NODE_OPTIONS: "--max-old-space-size=512" } };
  const events: Array<{ typeId: string; payload: unknown }> = [];
  let corpusReads = 0;
  const context = { runtime: { storage: {
    languageMemory: { listNgramModels: async () => { corpusReads++; return []; } }, evidence: { searchEvidence: async () => [] },
    events: { append: async (event: { typeId: string; payload: unknown }) => { events.push(event); } }
  }, approvals: { isApproved: () => true } }, config: {
    server: { url: "http://127.0.0.1:0" }, runtime: { workspaceRoot: root, patchValidation: { provider: "trusted-host", policies: [policy] } },
    policy: { allowMutation: true }, security: {}
  } } as unknown as ApiContext;
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let payload;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing fixture port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/code`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target, request: "TS2551 fixName:spelling", attempts: 1, ...(withTests ? { validationPolicyId: policy.id } : {}) }) });
    expect(response.status).toBe(200);
    payload = await response.json();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  expect(payload).toMatchObject({ outcome: "resolved", proposalSources: ["compiler_owned"], verification: {
    schema: "scce.code_mouth_verification.v1", scope: withTests ? "executed_tests" : "compiler_only", status: "passed",
    buildSucceeded: true, testsRun: withTests, testsSucceeded: withTests ? true : null
  } });
  expect(await readFile(join(root, target), "utf8")).toBe(original);
  expect(corpusReads).toBe(0);
  expect(payload.corpusAvailability).toMatchObject({ status: "unqueried", modelsAvailable: null, countSemantics: "admitted_run_models", languageId: "typescript" });
  expect(events.find(event => event.typeId === "CodePatchApplied")?.payload).toMatchObject({ verification: payload.verification });
  expect(events.find(event => event.typeId === "CodePatchApplied")?.payload).toMatchObject({ corpusAvailability: payload.corpusAvailability });
  if (!withTests) expect(payload.decision.reason).toBe(payload.reason);
  const external = await runStructuredWorkspaceValidation({ workspaceRoot: root, policy });
  expect(external.ok).toBe(true);
  expect(external.evidence.commands[1]!.stdout).toContain("unit behavior preserved");
  expect(external.evidence.commands[1]!.stdout).toContain("end-to-end behavior preserved");
});
