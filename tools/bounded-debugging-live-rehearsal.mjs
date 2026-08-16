#!/usr/bin/env node
// Live rehearsal for plan item 194 (packages/kernel/src/bounded-autonomous-debugging.ts,
// plan items 191-193): runs one real bounded-debugging session against a
// deliberately introduced, isolated synthetic bug in a scratch fixture --
// never this repo's own real source. Every step is real, not fabricated:
// a real `tsc` subprocess compiles the fixture and produces the real
// compiler diagnostic proving the bug exists; the real, already-tested
// `materializeProgramRepair` (program-repair-kernel.ts) computes the fix
// from the real fixture source text; the fix is written back to real
// files on disk; `tsc` is run again for real, and the compiled output is
// actually executed with `node` to prove the patch did not change real
// runtime behavior. The bounded-debugging session's own decision loop
// (packages/kernel/src/bounded-autonomous-debugging.ts) is driven by
// these real results, and its full trace is recorded, matching this
// project's established live-rehearsal pattern
// (tools/procedural-skill-live-rehearsal.mjs) -- no live Postgres needed
// here, so this one is not Track-0-gated.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscBinary = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
import { createHasher } from "../packages/kernel/dist/primitives.js";
import { createProgramHydrationContract, hydrationSummary } from "../packages/kernel/dist/program-runtime.js";
import { materializeProgramRepair, createProgramRepairKernel } from "../packages/kernel/dist/program-repair-kernel.js";
import { createBoundedDebugSession, planDebugAttempt, recordDebugAttempt } from "../packages/kernel/dist/bounded-autonomous-debugging.js";

const checks = [];
let primaryError;
let scratchDir;

function check(id, passed, detail) {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function runTsc(cwd) {
  try {
    const stdout = execFileSync(process.execPath, [tscBinary, "-p", "tsconfig.json"], { cwd, encoding: "utf8" });
    return { exitCode: 0, output: stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

try {
  scratchDir = mkdtempSync(join(tmpdir(), "scce-bounded-debug-rehearsal-"));
  writeFileSync(join(scratchDir, "package.json"), JSON.stringify({ name: "bounded-debug-fixture", private: true, type: "commonjs" }, null, 2));
  writeFileSync(join(scratchDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noUnusedLocals: true, skipLibCheck: true,
      outDir: "dist", rootDir: "."
    },
    include: ["*.ts"]
  }, null, 2));
  writeFileSync(join(scratchDir, "unused-marker.ts"), "export interface Unused {\n  flag: boolean;\n}\n");
  writeFileSync(join(scratchDir, "greeter.ts"), "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n");
  // The deliberately introduced synthetic bug: a real unused type-only
  // import that a real `tsc --strict --noUnusedLocals` genuinely rejects.
  const buggySource = "import type { Unused } from \"./unused-marker.js\";\nimport { greet } from \"./greeter.js\";\n\nexport function run(): string {\n  return greet(\"world\");\n}\n";
  writeFileSync(join(scratchDir, "fixture.ts"), buggySource);

  // --- 1. INSPECT: a real compiler run proves the bug is real. ---
  const firstBuild = runTsc(scratchDir);
  check("inspect.real_bug_present", firstBuild.exitCode !== 0 && /Unused/u.test(firstBuild.output), `expected a real tsc failure mentioning 'Unused', got exit ${firstBuild.exitCode}: ${firstBuild.output.slice(0, 300)}`);

  const hasher = createHasher();
  const sourceContent = readFileSync(join(scratchDir, "fixture.ts"), "utf8");
  function artifact(path, content, role = "source") {
    const digest = hasher.digestHex(content);
    return { artifactId: `artifact_${digest.slice(0, 24)}`, path, mediaType: "text/typescript", content, contentHash: `sha256_${digest}`, role };
  }
  const source = artifact("fixture.ts", sourceContent);
  const config = artifact("tsconfig.json", readFileSync(join(scratchDir, "tsconfig.json"), "utf8"), "config");
  const graphWithoutHydration = {
    id: `program.bounded_debug_rehearsal.${hasher.digestHex(sourceContent).slice(0, 16)}`,
    language: "typescript", packageManager: "pnpm", entrypoint: source.path,
    nodes: [source, config].map(file => ({ id: `artifact:${file.path}`, kind: `artifact:${file.role}`, label: file.path, metadata: { contentHash: file.contentHash } })),
    edges: [], files: [source, config],
    build: { command: "node", args: [tscBinary, "-p", "tsconfig.json"], cwd: "." },
    test: { command: "node", args: ["-e", "require('./dist/fixture.js').run()"], cwd: "." }
  };
  const hydration = createProgramHydrationContract({ program: graphWithoutHydration, sourcePlanId: "program-plan.bounded-debug-rehearsal", evidenceIds: ["evidence.bounded-debug-rehearsal"] });
  const program = {
    ...graphWithoutHydration, hydration,
    nodes: [...graphWithoutHydration.nodes, { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }],
    edges: [{ source: "program-plan.bounded-debug-rehearsal", target: "program-hydration", relation: "hydrates_as", weight: 1 }]
  };
  const requestText = "Remove unused type import Unused from fixture.ts.";

  // --- 2. HYPOTHESIZE: the real, already-tested repair kernel computes the fix. ---
  const repairPlan = createProgramRepairKernel({ hasher }).plan({ program, requestText });
  const operations = repairPlan.selectedPatchSet?.operations ?? [];
  check("hypothesize.produced_operations", operations.length > 0, "expected at least one real repair operation");

  const diagnosticBefore = { id: "diag.rehearsal.unused_import", class: "type", message: "real tsc reports 'Unused' is declared but never used", raw: firstBuild.output.split(/\r?\n/).find(line => /Unused/u.test(line)) ?? "Unused", confidence: 1, path: "fixture.ts", line: 1 };

  let session = createBoundedDebugSession({ maxAttempts: 3, maxWallClockMs: 120_000, maxMutatedFiles: 2 }, Date.now());
  const plan = planDebugAttempt(session, [diagnosticBefore], operations, hasher);
  check("plan.permitted", plan.permitted === true, plan.reason);

  // --- 3. PATCH: materialize the fix and write it back to real files. ---
  const materialized = materializeProgramRepair({ program, requestText, hasher });
  check("patch.changed_fixture", materialized.changedPaths.includes("fixture.ts"), `expected fixture.ts among changed paths, got ${JSON.stringify(materialized.changedPaths)}`);
  const patchedContent = materialized.program.files.find(file => file.path === "fixture.ts")?.content;
  check("patch.removed_unused_import", typeof patchedContent === "string" && !/Unused/u.test(patchedContent), `expected the unused import gone, got: ${patchedContent}`);
  writeFileSync(join(scratchDir, "fixture.ts"), patchedContent);

  // --- 4. BUILD (post-patch): a real second compiler run. ---
  const secondBuild = runTsc(scratchDir);
  check("build.now_clean", secondBuild.exitCode === 0, `expected a clean real tsc run after the patch, got exit ${secondBuild.exitCode}: ${secondBuild.output.slice(0, 300)}`);

  // --- 5. TEST: actually execute the compiled output with node. ---
  mkdirSync(join(scratchDir, "dist"), { recursive: true });
  let testOutput = "";
  let testsSucceeded = false;
  try {
    testOutput = execFileSync(process.execPath, ["-e", "const m = require('./dist/fixture.js'); const result = m.run(); if (result !== 'hello world') throw new Error('unexpected result: ' + result); console.log(result);"], { cwd: scratchDir, encoding: "utf8" });
    testsSucceeded = testOutput.trim() === "hello world";
  } catch (error) {
    testOutput = String(error.message ?? error);
  }
  check("test.real_runtime_behavior_preserved", testsSucceeded, `expected the compiled fixture to actually run and return 'hello world', got: ${testOutput}`);

  // --- 6. DIAGNOSE + decide: feed the real results into the bounded-debug session. ---
  const recorded = recordDebugAttempt(session, {
    now: Date.now(), diagnosticsBefore: [diagnosticBefore], operations, mutatedPaths: ["fixture.ts"],
    buildSucceeded: secondBuild.exitCode === 0, testsSucceeded, diagnosticsAfter: [], hasher
  });
  session = recorded.session;
  check("session.resolved", recorded.decision.outcome === "resolved", `expected outcome 'resolved', got ${JSON.stringify(recorded.decision)}`);
} catch (error) {
  primaryError = error;
} finally {
  if (scratchDir) {
    try { rmSync(scratchDir, { recursive: true, force: true }); checks.push({ id: "cleanup.removed_scratch_dir", passed: true, detail: scratchDir }); }
    catch (cleanupError) { primaryError ??= cleanupError; }
  }
}

const report = {
  schema: "scce.bounded_autonomous_debugging_live_rehearsal.v1",
  completedAt: new Date().toISOString(),
  fixtureContainsSyntheticDataOnly: true,
  scopeNote: "The unused-type-import repair family hypothesizes syntactically from real fixture source text, not by parsing tsc's diagnostic text -- this rehearsal additionally runs a real tsc compile before and after as independent build verification, and actually executes the compiled output, rather than claiming the hypothesis itself was derived from the tsc diagnostic text.",
  checks,
  status: !primaryError && checks.every(entry => entry.passed) ? "passed" : "failed",
  error: primaryError ? String(primaryError.message ?? primaryError).slice(0, 1000) : null
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;
