#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Offline gate for the coding lane's source emitter. No server, no database, no network: it plans a ProgramGraph
// for a concrete coding request, hands the real NodeBuildTestAdapter the real artifacts, and runs the build and
// test commands the planner emitted. Passes only when a real program came out and its own test exited 0.
//
//   node tools/program-emitter-offline-gate.mjs [--out=artifacts/program-emitter-gate.json] [--keep]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClock, createHasher, createIdFactory, createProgramGraphBuilder } from "../packages/kernel/dist/index.js";
import { NodeBuildTestAdapter } from "../packages/adapters-node/dist/process.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/program-emitter-gate.json");

// Same request the live coding-spine acceptance sends, so the offline and live gates judge one emitter.
const REQUEST = "Implement a TypeScript function uniqueStrings(values: string[]): string[] that returns the unique strings from an array in first-seen order, add tests, and validate it.";

const clock = createClock({ fixedTime: 1_000_000, stepMs: 1 });
const hasher = createHasher();
const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });

function evidenceSpan(text, mediaType, uri) {
  const sourceVersionId = idFactory.sourceVersionId(uri);
  const contentHash = idFactory.contentHash(text);
  return {
    id: idFactory.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text, "utf8"), spanHash: contentHash }),
    sourceId: idFactory.sourceId("local", uri),
    sourceVersionId,
    chunkId: idFactory.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text, "utf8"), chunkHash: contentHash }),
    contentHash,
    mediaType,
    byteStart: 0,
    byteEnd: Buffer.byteLength(text, "utf8"),
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text.slice(0, 160),
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: 1 },
    provenance: { uri },
    features: ["sym:unique", "sym:strings", "sym:values", "sym:order"],
    status: "promoted",
    alpha: 1,
    observedAt: clock.now()
  };
}

function entailmentFor(evidence) {
  const claimId = idFactory.claimId(REQUEST);
  return {
    claim: { id: claimId, text: REQUEST, normalized: REQUEST, features: ["sym:unique", "sym:strings"], polarity: 1 },
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force: "inferred",
    support: 0.68,
    contradiction: 0,
    faithfulnessLcb: 0.42,
    confidence: {},
    scores: {},
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds: evidence.map(span => span.id),
    boundaries: [],
    proof: {
      id: idFactory.proofId({ claimId, evidenceIds: evidence.map(span => span.id), transforms: ["offline-gate"], validatorVersion: "offline-gate" }),
      claimId,
      verdict: "inferred",
      confidence: {},
      proofGraph: { nodes: [], edges: [] },
      evidenceIds: evidence.map(span => span.id),
      transformIds: [],
      scores: {},
      validatorVersion: "offline-gate",
      createdAt: clock.now()
    }
  };
}

const evidence = [
  evidenceSpan(
    "export function uniqueStrings(values) {\n  const seen = new Set();\n  const out = [];\n  for (const value of values) {\n    if (seen.has(value)) continue;\n    seen.add(value);\n    out.push(value);\n  }\n  return out;\n}\n",
    "text/plain",
    "repo://offline-gate/unique-strings"
  )
];

const episodeId = idFactory.episodeId();
const construct = createProgramGraphBuilder({ idFactory, hasher }).build({
  episodeId,
  text: REQUEST,
  createdAt: clock.now(),
  evidence,
  entailment: entailmentFor(evidence)
});

const failures = [];
const require_ = (ok, message) => { if (!ok) failures.push(message); return ok; };

const program = construct.program;
require_(Boolean(program), "no ProgramGraph was planned for a coding request");

const artifacts = construct.artifacts ?? [];
const sourceArtifacts = artifacts.filter(file => file.role === "source");
const testArtifacts = artifacts.filter(file => file.role === "test");

// A program, not a contract dump: something the runtime that is about to be spawned can actually load.
const executable = sourceArtifacts.filter(file => file.path.endsWith(".mjs") || file.path.endsWith(".js"));
const executableTests = testArtifacts.filter(file => file.path.endsWith(".mjs") || file.path.endsWith(".js"));
require_(executable.length > 0, `no executable source artifact was emitted (source artifacts: ${sourceArtifacts.map(f => f.path).join(", ") || "none"})`);
require_(executableTests.length > 0, `no executable test artifact was emitted (test artifacts: ${testArtifacts.map(f => f.path).join(", ") || "none"})`);
require_(Boolean(program) && executable.some(file => file.path === program.entrypoint), `program entrypoint is not an emitted executable artifact: ${program?.entrypoint}`);
for (const file of executableTests) {
  require_(executable.some(source => file.content.includes(source.path.split("/").pop() ?? "")), `test artifact ${file.path} does not import the emitted program`);
}

// A command, not a placeholder: a name the operating system can spawn, with the emitted artifacts as its arguments.
const spawnable = command => Boolean(command) && command.command.length > 0 && !command.command.includes("source-derived") && !command.command.includes("source.unresolved") && !command.command.includes("source-script");
require_(spawnable(program?.build), `build command is not spawnable: ${JSON.stringify(program?.build)}`);
require_(spawnable(program?.test), `test command is not spawnable: ${JSON.stringify(program?.test)}`);

const tempRoot = join(repoRoot, ".tmp", "scce-runs", "program-emitter-gate");
const adapter = new NodeBuildTestAdapter({ runtime: { tempRoot } });
const result = program ? await adapter.executeProgram({ episodeId, construct }) : undefined;

require_(result?.build.code === 0, `build did not exit 0: code=${result?.build.code ?? "n/a"} stderr=${(result?.build.stderr ?? "").trim().slice(0, 400)}`);
require_(result?.test.code === 0, `test did not exit 0: code=${result?.test.code ?? "n/a"} stderr=${(result?.test.stderr ?? "").trim().slice(0, 400)}`);
require_(result?.passed === true, "adapter reported the program did not pass");

// The same declared defect the live repair chain injects: the emitted artifacts must be repairable, not just runnable.
const repaired = program ? await adapter.executeProgram({ episodeId, construct, faultInjection: "unbalanced-brace" }) : undefined;
const attempts = repaired?.attempts ?? [];
require_(attempts.length >= 2, `a declared first-attempt defect produced ${attempts.length} attempt(s), so no repair ran`);
require_(attempts[0]?.build.code !== 0, "the declared defect did not fail the first build, so the build is not a real gate");
require_(repaired?.repairApplied === true, "no repair was applied to the emitted artifacts");
require_(repaired?.passed === true, `the repaired program did not pass: ${(repaired?.build.stderr ?? repaired?.test.stderr ?? "").trim().slice(0, 400)}`);

console.log(`request: ${REQUEST}`);
console.log(`artifacts: ${artifacts.map(file => file.path).join(", ")}`);
console.log(`entrypoint: ${program?.entrypoint}`);
console.log(`build: ${program?.build.command} ${program?.build.args.join(" ")} -> code=${result?.build.code ?? "n/a"} in ${result?.build.durationMs ?? 0}ms`);
console.log(`test:  ${program?.test.command} ${program?.test.args.join(" ")} -> code=${result?.test.code ?? "n/a"} in ${result?.test.durationMs ?? 0}ms`);
if ((result?.test.stdout ?? "").trim()) console.log(`test stdout: ${result.test.stdout.trim().slice(0, 400)}`);
console.log(`repair: attempts=${attempts.length} firstBuild=${attempts[0]?.build.code ?? "n/a"} applied=${repaired?.repairApplied ?? false} passed=${repaired?.passed ?? false}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length ? `program emitter gate: FAIL (${failures.length})` : "program emitter gate: PASS");

mkdirSync(dirname(join(repoRoot, outPath)), { recursive: true });
writeFileSync(join(repoRoot, outPath), `${JSON.stringify({
  schema: "scce.program_emitter_gate.v1",
  generatedAt: new Date().toISOString(),
  request: REQUEST,
  entrypoint: program?.entrypoint ?? null,
  artifacts: artifacts.map(file => ({ path: file.path, role: file.role, mediaType: file.mediaType, bytes: file.content.length })),
  build: program?.build ?? null,
  test: program?.test ?? null,
  run: result ? { build: { code: result.build.code, durationMs: result.build.durationMs, stderr: result.build.stderr.slice(0, 2000) }, test: { code: result.test.code, durationMs: result.test.durationMs, stdout: result.test.stdout.slice(0, 2000), stderr: result.test.stderr.slice(0, 2000) }, passed: result.passed, repairAttempted: result.repairAttempted, repairApplied: result.repairApplied } : null,
  repair: repaired ? { attempts: attempts.map(attempt => ({ build: attempt.build.code, test: attempt.test.code })), repairApplied: repaired.repairApplied, passed: repaired.passed } : null,
  failures
}, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
process.exit(failures.length ? 1 : 0);
