// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCodeMouth } from "../../../adapters-node/src/code-mouth.js";
import { createWorkspaceCodeMouthPorts } from "../../../adapters-node/src/workspace-code-mouth-ports.js";
import { codeCommandReport } from "../code-command-report.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("scce-code-cli-receipt-")) throw Error("invalid fixture cleanup path");
  await rm(root, { recursive: true, force: true });
} });

it("serializes the actual compiler-only TS2551 receipt at the ordinary CLI report seam", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "scce-code-cli-receipt-")); roots.push(root);
  const sourceRoot = new URL("../../../../tools/repair-acceptance/cases/map-write-loss/", import.meta.url);
  const target = "src/paired-evaluation-statistics.ts";
  for (const file of ["package.json", "tsconfig.json", target]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), await readFile(new URL(file, sourceRoot)));
  }
  const original = await readFile(join(root, target), "utf8");
  await writeFile(join(root, target), original.replace("byFamily.set(record.taskFamilyId, bucket)", "byFamily.set(record.taskFamliyId, bucket)"));
  const result = await runCodeMouth({ request: "TS2551 fixName:spelling", targetPath: target, maxAttempts: 1,
    ports: createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: target }) });
  expect(result.outcome).toBe("resolved");
  expect(result.proposalSources).toEqual(["compiler_owned"]);
  expect(await readFile(join(root, target), "utf8")).toBe(original);
  const payload = JSON.parse(JSON.stringify(codeCommandReport({ result, language: "typescript", modelsAvailable: 0, composed: [] })));
  expect(payload.verification).toEqual({ schema: "scce.code_mouth_verification.v1", scope: "compiler_only", status: "passed",
    buildSucceeded: true, testsRun: false, testsSucceeded: null });
  expect(payload.decision.reason).toBe(payload.reason);
  expect(payload.reason).toContain("no test suite was run");
  expect(payload.learned).toEqual({ language: "typescript", modelsAvailable: 0, composed: [] });
});
