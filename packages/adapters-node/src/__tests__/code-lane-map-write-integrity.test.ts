// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPatchTransactionPlan, hashPatchContent } from "@scce/kernel";
import { createTypeScriptCodeMouthPorts, runCodeMouth } from "../code-mouth.js";
import { createWorkspaceCodeMouthPorts } from "../workspace-code-mouth-ports.js";
import { runStructuredPatchValidation, runStructuredWorkspaceValidation, type StructuredPatchValidationPolicy,
  type StructuredPatchValidationEvidence } from "../structured-patch-validation.js";
import { executeWorkspacePatchTransaction, WorkspacePatchTransactionError } from "../workspace-patch-transaction.js";

const fixtureRoot = new URL("../../../../tools/repair-acceptance/cases/map-write-loss/", import.meta.url);
const files = ["case.json", "package.json", "tsconfig.json", "src/paired-evaluation-statistics.ts", "src/cli.mjs", "test/unit.mjs", "test/e2e.mjs", "test/all.mjs"];
const target = "src/paired-evaluation-statistics.ts";
const roots: string[] = [], observations: unknown[] = [];
const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("scce-map-write-integrity-")) throw new Error("invalid acceptance workspace cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});
afterAll(async () => {
  const receipt = { schema: "scce.map_write_integrity_acceptance.v1", sourceRevision: "4bc275b", caseFrozenAt: "68b3325",
    mutationAuthorship: "manually-crafted verifier negative control; not SCCE generated", offline: true,
    usesCanonicalDatabase: false, tests: observations };
  if (process.env.SCCE_REPAIR_INTEGRITY_RECEIPT) await writeFile(process.env.SCCE_REPAIR_INTEGRITY_RECEIPT, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
});

function policy(mode: "compiler" | "unit" | "e2e" | "all"): StructuredPatchValidationPolicy {
  return { schemaVersion: "scce.patch-validation-policy.v1", id: `map-write-integrity.${mode}.v1`, commands: [
    { executable: process.execPath, argv: [compiler, "--noEmit", "-p", "tsconfig.json"], checkIds: ["compiler", "typecheck"] },
    ...(mode === "compiler" ? [] : [{ executable: process.execPath, argv: [`test/${mode}.mjs`], checkIds: ["tests" as const] }])
  ], timeoutMs: 30000, maxOutputBytes: 128 * 1024, maxWorkspaceFiles: 32, maxWorkspaceBytes: 1024 * 1024,
  environment: { NODE_OPTIONS: "--max-old-space-size=512" } };
}

async function fixture() {
  const root = await mkdtemp(join(resolve(tmpdir()), "scce-map-write-integrity-")); roots.push(root);
  for (const file of files) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), await readFile(new URL(file, fixtureRoot))); }
  const manifest = JSON.parse(await readFile(join(root, "case.json"), "utf8"));
  const original = await readFile(join(root, target), "utf8");
  expect(digest(original.replace(/\r\n/gu, "\n"))).toBe(manifest.source.canonicalLfSha256);
  expect(original.split(manifest.mutation.from)).toHaveLength(2);
  const harmful = original.replace(manifest.mutation.from, manifest.mutation.harmfulTo);
  const broken = original.replace(manifest.mutation.from, manifest.mutation.diagnosticDefectTo);
  const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(join(root, file)))])));
  return { root, manifest, original, harmful, broken, hashes, originalHash: digest(original), harmfulHash: digest(harmful) };
}

function plan(before: string, after: string) {
  return createPatchTransactionPlan({ operations: [{ kind: "replace", path: target, baseContentHash: hashPatchContent(before), content: after }] });
}

const commandSummary = (evidence: StructuredPatchValidationEvidence | { commands: StructuredPatchValidationEvidence["commands"] }) => evidence.commands.map(command => ({
  argv: command.argv.map(arg => arg === compiler ? "<installed TypeScript compiler>" : arg), checkIds: command.checkIds,
  code: command.code, timedOut: command.timedOut, outputLimitExceeded: command.outputLimitExceeded,
  stdout: command.stdout, stderr: command.stderr, durationMs: command.durationMs
}));

describe("frozen CODE_LANE map-write loss acceptance", () => {
  it("preserves the source-owned behavior under actual compiler, unit and E2E commands", async () => {
    const f = await fixture(); const before = await f.hashes();
    const result = await runStructuredWorkspaceValidation({ workspaceRoot: f.root, policy: policy("all") });
    expect(result.ok).toBe(true);
    expect(result.evidence.commands.map(command => command.code)).toEqual([0, 0]);
    expect(result.evidence.commands[1]!.stdout).toContain("unit behavior preserved");
    expect(result.evidence.commands[1]!.stdout).toContain("end-to-end behavior preserved");
    expect(await f.hashes()).toEqual(before);
    observations.push({ case: "original-behavior", source: f.manifest.source, originalWorkspaceSha256: f.originalHash,
      originalSourceHashVerified: true, filesUnchanged: true, commands: commandSummary(result.evidence) });
  });

  it.each(["unit", "e2e"] as const)("rejects the crafted harmful mutation through the real %s transaction gate", async mode => {
    const f = await fixture(), before = await f.hashes(), selectedPolicy = policy(mode);
    let failure: unknown;
    try {
      await executeWorkspacePatchTransaction({ workspaceRoot: f.root, plan: plan(f.original, f.harmful),
        validate: validationView => runStructuredPatchValidation({ workspaceRoot: f.root, validationView, policy: selectedPolicy }) });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkspacePatchTransactionError);
    const rejected = failure as WorkspacePatchTransactionError;
    expect(rejected.code).toBe("VALIDATION_FAILED");
    expect(await f.hashes()).toEqual(before);
    expect(rejected.rollback).toEqual({ attemptedPaths: [], restoredPaths: [], failures: [] });
    const evidence = rejected.validation!.evidence as unknown as StructuredPatchValidationEvidence;
    expect(evidence.commands.map(command => command.code)).toEqual([0, 1]);
    expect(evidence.commands[1]!.stderr).toContain("AssertionError");
    observations.push({ case: `crafted-mutation-${mode}-rejected`, originalSha256: f.originalHash, harmfulSha256: f.harmfulHash,
      rejection: rejected.code, transactionRollback: rejected.rollback, originalBytesAndOtherFilesPreserved: true,
      commands: commandSummary(evidence) });
  });

  it("shows the narrower compiler-only acceptance and restores the original through tested validation", async () => {
    const f = await fixture(), compilerPolicy = policy("compiler");
    const accepted = await executeWorkspacePatchTransaction({ workspaceRoot: f.root, plan: plan(f.original, f.harmful),
      validate: validationView => runStructuredPatchValidation({ workspaceRoot: f.root, validationView, policy: compilerPolicy }) });
    expect(await readFile(join(f.root, target), "utf8")).toBe(f.harmful);
    expect(accepted.validation?.executedChecks?.map(check => check.checkId)).toEqual(["compiler", "typecheck"]);
    const compilerOnly = await createTypeScriptCodeMouthPorts({ workspaceRoot: f.root }).verify(target);
    expect(compilerOnly).toMatchObject({ buildSucceeded: true, testsRun: false, diagnostics: [] });
    const native = await createWorkspaceCodeMouthPorts({ workspaceRoot: f.root, targetPath: target, projectValidation: { policy: policy("all") } }).verify(target);
    expect(native).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: false });
    expect(native.diagnostics.some(diagnostic => diagnostic.class === "runtime")).toBe(true);
    const restored = await executeWorkspacePatchTransaction({ workspaceRoot: f.root, plan: plan(f.harmful, f.original),
      validate: validationView => runStructuredPatchValidation({ workspaceRoot: f.root, validationView, policy: policy("all") }) });
    expect(digest(await readFile(join(f.root, target)))).toBe(f.originalHash);
    expect(restored.validation?.executedChecks?.filter(check => check.checkId === "tests")).toHaveLength(1);
    observations.push({ case: "crafted-mutation-compiler-only-accepted", originalSha256: f.originalHash, harmfulSha256: f.harmfulHash,
      compilerOnly, nativeVerification: { buildSucceeded: native.buildSucceeded, testsRun: native.testsRun, testsSucceeded: native.testsSucceeded,
        diagnostics: native.diagnostics.map(diagnostic => ({ class: diagnostic.class, message: diagnostic.message })) },
      sourceRestoredThroughNativeValidation: true, receipt: accepted });
  });

  it("uses the current real compiler proposer without supplying a learned or successful fake proposer", async () => {
    const f = await fixture(); await writeFile(join(f.root, target), f.broken);
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: f.root, targetPath: target, projectValidation: { policy: policy("all") } });
    const initial = await ports.verify(target);
    expect(initial.buildSucceeded).toBe(false);
    expect(initial.testsRun).toBe(false);
    expect(initial.diagnostics.some(diagnostic => diagnostic.raw?.includes("TS2554"))).toBe(true);
    const result = await runCodeMouth({ request: "TS2554", targetPath: target, ports, maxAttempts: 1, maxWallClockMs: 30000 });
    const final = await ports.verify(target), after = await readFile(join(f.root, target), "utf8");
    if (result.outcome === "resolved") expect(final).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: true });
    else expect(after).toBe(f.broken);
    expect(after).not.toBe(f.harmful);
    observations.push({ case: "current-compiler-owned-repair-trial", scope: "no corpus-trained proposer supplied; not a learned-generation score",
      originalSha256: f.originalHash, brokenSha256: digest(f.broken), afterSha256: digest(after), exactOriginalRestored: after === f.original,
      outcome: result.outcome, reason: result.reason, attempts: result.attempts, proposalSources: result.proposalSources,
      buildSucceeded: final.buildSucceeded, testsRun: final.testsRun, testsSucceeded: final.testsSucceeded,
      finalDiagnostics: final.diagnostics.map(diagnostic => ({ class: diagnostic.class, message: diagnostic.message })) });
    expect((await readdir(f.root)).some(name => name.startsWith(".scce-"))).toBe(false);
  });
});
