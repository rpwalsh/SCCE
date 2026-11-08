// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createScceKernel, createInMemoryDialogueMemoryStore, createHasher, codeRequestSignal, type BuildTestResult, type CapabilityPlan, type ConstructGraph, type EpisodeId,
  type UserModelClaimRecord, type TaskResumptionSnapshotRecord } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { validateOwnerProgramLocalValidation } from "../../../kernel/src/program-local-validation.js";
import { programResponseReadiness } from "../program-response-readiness.js";
import { createApprovalSession } from "../../../adapters-node/src/approval-session.js";
import { findCodeVerifierCapability } from "../../../adapters-node/src/code-verifier-discovery.js";
import { NodeBuildTestAdapter } from "../../../adapters-node/src/process.js";
import { runProcess } from "../../../adapters-node/src/document.js";
import type { ScceRuntimeConfig } from "../../../adapters-node/src/config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("cold ordinary owner program execution", () => {
  it("compiles and executes a Rust f64 owner program with an independent held-out call", async () => {
    const rust = await findCodeVerifierCapability("rust");
    expect(rust.status, rust.status === "unavailable" ? rust.reason : "").toBe("available");
    if (rust.status !== "available") throw new Error(rust.reason);
    const executionRoot = await mkdtemp(path.join(tmpdir(), "scce-cold-rust-turn-"));
    roots.push(executionRoot);
    const fixture = storageFixtureForEvaluation({ evidence: [], clockNow: Date.now });
    fixture.storage.dialogueMemory = createInMemoryDialogueMemoryStore();
    const claims = new Map<string, UserModelClaimRecord>();
    const snapshots = new Map<string, TaskResumptionSnapshotRecord>();
    fixture.storage.userModelClaims = {
      putClaim: async claim => { claims.set(claim.id, claim); },
      listClaims: async query => [...claims.values()].filter(claim => claim.conversationId === query.conversationId).slice(0, query.limit)
    };
    fixture.storage.taskResumption = {
      putSnapshot: async snapshot => { snapshots.set(snapshot.goalId, snapshot); },
      getLatestSnapshot: async goalId => snapshots.get(goalId) ?? null
    };
    const approvals = createApprovalSession();
    const native = new NodeBuildTestAdapter({ runtime: { tempRoot: executionRoot } } as ScceRuntimeConfig);
    const attempts: BuildTestResult[] = [];
    const kernel = createScceKernel({ storage: fixture.storage, files: { streamPath: async function* () {} }, approvals,
      deterministicReplay: false, functionalCognitionAuthorizeCapabilities: true,
      policy: { allowMutation: false, dryRunByDefault: true, requireTwoPhaseCommit: true },
      buildTest: { executeProgram: async input => {
        const result = await native.executeProgram(input);
        attempts.push(result);
        return result;
      } } });
    const text = "Create a Rust fn double(x: f64) -> f64 such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a native test.";
    const result = await kernel.turn({ text });
    expect(result.requestedAuthority).toBe("program");
    expect(result.buildTest?.passed).toBe(true);
    expect(attempts.some(attempt => attempt.build.code === 0 && attempt.test.code === 0)).toBe(true);
    const program = result.constructGraph.program!;
    expect(program.language).toBe("rust");
    expect(program.entrypoint).toBe("src/program.rs");
    expect(program.build).toMatchObject({ command: "rustc", args: ["--edition", "2021", "--test", "test/program_test.rs", "-o", "program_test.exe"] });
    expect(program.test).toMatchObject({ command: "./program_test.exe", args: [] });
    const proofScope = { canonicalProgram: program, requestedAuthority: "program" as const,
      requestRequirementIds: codeRequestSignal(text).behaviorRequirements.map(requirement => requirement.id), hasher: createHasher() };
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program })?.programId).toBe(program.id);
    const source = result.buildTest!.artifacts.find(artifact => artifact.path === "src/program.rs")!;
    const test = result.buildTest!.artifacts.find(artifact => artifact.path === "test/program_test.rs")!;
    expect(source.content).toContain("pub fn r#double(arg0: f64) -> f64");
    expect(source.content).not.toContain("expected");
    expect(test.content).toContain("owner_requirement_3");
    const checkRoot = await mkdtemp(path.join(tmpdir(), "scce-rust-heldout-"));
    roots.push(checkRoot);
    await mkdir(path.join(checkRoot, "src"), { recursive: true });
    await writeFile(path.join(checkRoot, source.path), source.content, "utf8");
    await writeFile(path.join(checkRoot, "independent.rs"), `#[path = "src/program.rs"] mod program;\nfn main() { assert_eq!(program::r#double(37.0), 74.0); assert_eq!(program::r#double(-0.25), -0.5); }\n`, "utf8");
    const compile = await runProcess(rust.verifier.command, ["--edition", "2021", "independent.rs", "-o", "independent.exe"], { cwd: checkRoot, timeoutMs: 30_000 });
    expect(compile.code, compile.stderr).toBe(0);
    const independent = await runProcess(path.join(checkRoot, "independent.exe"), [], { cwd: checkRoot, timeoutMs: 10_000 });
    expect(independent.code, independent.stderr).toBe(0);
    const attemptsBeforeUnsupported = attempts.length;
    const unsupported = await kernel.turn({ text: "Create a Rust fn divide(x: i64, y: i64) -> i64 such that divide(8, 2) returns 4 and divide(9, 3) returns 3." });
    expect(unsupported.requestedAuthority).toBe("program");
    expect(unsupported.realizationAvailability).toMatchObject({ status: "realization_unavailable" });
    expect(unsupported.constructGraph.program).toBeUndefined();
    expect(unsupported.constructGraph.artifacts).toEqual([]);
    expect(attempts).toHaveLength(attemptsBeforeUnsupported);
    expect(unsupported.constructGraph.nodes.find(node => node.kind === "program_emission_unavailable")?.metadata)
      .toMatchObject({ status: "unavailable", languageId: "rust", reasonIds: ["program.emission.rust.signature_unsupported"] });
  }, 90_000);
  it.each([
    { namedLanguage: false, factual: false },
    { namedLanguage: true, factual: false },
    { namedLanguage: false, factual: true },
    { namedLanguage: true, factual: true }
  ])("honors text-only behavior and explicit authority $namedLanguage / $factual", async ({ namedLanguage, factual }) => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "scce-cold-native-turn-"));
    roots.push(executionRoot);
    const fixture = storageFixtureForEvaluation({ evidence: [], clockNow: Date.now });
    const constructs = new Map<string, ConstructGraph>();
    const builds: Array<{ episodeId: EpisodeId; constructId: string; result: BuildTestResult }> = [];
    const plans: CapabilityPlan[] = [];
    const claims = new Map<string, UserModelClaimRecord>();
    const snapshots = new Map<string, TaskResumptionSnapshotRecord>();
    fixture.storage.dialogueMemory = createInMemoryDialogueMemoryStore();
    fixture.storage.userModelClaims = {
      putClaim: async claim => { claims.set(claim.id, claim); },
      listClaims: async query => [...claims.values()].filter(claim => claim.conversationId === query.conversationId
        && (!query.subject || claim.subject === query.subject) && (!query.scope || claim.scope === query.scope)).slice(0, query.limit)
    };
    fixture.storage.taskResumption = {
      putSnapshot: async snapshot => { snapshots.set(snapshot.goalId, snapshot); },
      getLatestSnapshot: async goalId => snapshots.get(goalId) ?? null
    };
    fixture.storage.constructs = {
      putConstruct: async graph => { constructs.set(String(graph.id), graph); },
      getConstruct: async id => constructs.get(id) ?? null,
      putValidation: async () => undefined,
      putEmission: async () => undefined,
      putBuildTest: async (episodeId, constructId, result) => { builds.push({ episodeId, constructId, result }); }
    };
    fixture.storage.capabilities = {
      putPlan: async plan => { plans.push(plan); },
      listByEpisode: async episodeId => plans.filter(plan => plan.episodeId === episodeId)
    };
    const approvals = createApprovalSession();
    expect(approvals.snapshot().operatorGrant).toBe(false);
    const native = new NodeBuildTestAdapter({ runtime: { tempRoot: executionRoot } } as ScceRuntimeConfig);
    const attempts: BuildTestResult[] = [];
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () {} },
      approvals,
      deterministicReplay: false,
      functionalCognitionAuthorizeCapabilities: true,
      policy: { allowMutation: false, dryRunByDefault: true, requireTwoPhaseCommit: true },
      buildTest: { executeProgram: async input => {
        const result = await native.executeProgram(input);
        attempts.push(result);
        return result;
      } }
    });
    const text = `Create a ${namedLanguage ? "TypeScript " : ""}function ${namedLanguage ? "double(x: number): number" : "double(x)"} such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a test proving it.`;
    const result = await kernel.turn({ text, ...(factual ? { requestedAuthority: "factual" as const } : {}) });
    expect(approvals.snapshot().operatorGrant).toBe(false);
    if (factual) {
      expect(result.requestedAuthority).toBe("factual");
      expect(attempts).toEqual([]);
      expect(builds).toEqual([]);
      expect(result.buildTest).toBeUndefined();
      expect(result.buildTest?.artifacts ?? []).toEqual([]);
      expect(programResponseReadiness({ program: result.constructGraph.program, buildTest: result.buildTest }).status).toBe("not_ready");
      expect(plans.filter(plan => plan.capabilityId === "program.local_validation")).toEqual([]);
      return;
    }
    expect(result.requestedAuthority).toBe("program");
    expect(result.constructGraph.program?.hydration?.ownerRequirementIds).toHaveLength(4);
    expect(attempts.length).toBeGreaterThan(0);
    expect(result.buildTest?.passed).toBe(true);
    expect(attempts.some(attempt => attempt.build.code === 0 && attempt.test.code !== 0)).toBe(true);
    expect(fixture.events.some(event => event.typeId === "ProgramRepaired")).toBe(true);
    expect(result.buildTest?.testExecutionReceipt?.status).toBe("executed");
    expect(builds).toHaveLength(1);
    expect(builds[0]!.result).toEqual(result.buildTest);
    expect(constructs.get(builds[0]!.constructId)?.program).toEqual(result.constructGraph.program);
    expect(programResponseReadiness({ program: result.constructGraph.program, buildTest: result.buildTest }))
      .toMatchObject({ status: "ready", reasonId: "program.readiness.verified" });
    const program = result.constructGraph.program!;
    expect(program.language).toBe(namedLanguage ? "typescript" : "javascript");
    expect(program.entrypoint).toBe(namedLanguage ? "src/program.ts" : "src/program.mjs");
    expect(program.files.find(file => file.path === program.entrypoint)?.mediaType).toBe(namedLanguage ? "text/typescript" : "text/javascript");
    const hasher = createHasher();
    const proofScope = { canonicalProgram: program, requestedAuthority: "program" as const,
      requestRequirementIds: codeRequestSignal(text).behaviorRequirements.map(requirement => requirement.id), hasher };
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program })?.programId).toBe(program.id);
    const changedCommand = structuredClone(program);
    changedCommand.build.args = ["-e", "process.exit(0)"];
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program: changedCommand })).toBeUndefined();
    for (const rehash of [false, true]) {
      const changedSource = structuredClone(program);
      const changedFile = changedSource.files.find(file => file.role === "source")!;
      changedFile.content += "\nimport('node:fs').then(fs => fs.writeFileSync('outside.txt','changed'));\n";
      if (rehash) changedFile.contentHash = `sha256_${hasher.digestHex(changedFile.content)}` as typeof changedFile.contentHash;
      expect(validateOwnerProgramLocalValidation({ ...proofScope, program: changedSource })).toBeUndefined();
    }
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program, requestRequirementIds: ["foreign.requirement"] })).toBeUndefined();
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program, requestedAuthority: "factual" })).toBeUndefined();
    expect(validateOwnerProgramLocalValidation({ ...proofScope, program, canonicalProgram: undefined })).toBeUndefined();
    const source = result.buildTest!.artifacts.find(artifact => artifact.role === "source")!;
    const test = result.buildTest!.artifacts.find(artifact => artifact.role === "test")!;
    expect(source.content).not.toContain("expectedResult");
    for (const id of program.hydration!.ownerRequirementIds!) expect(test.content).toContain(id);
    expect(plans.some(plan => plan.capabilityId === "program.local_validation" && (plan.permission as { allowed?: boolean; dryRun?: boolean }).allowed
      && !(plan.permission as { dryRun?: boolean }).dryRun)).toBe(true);
    expect(plans.filter(plan => plan.capabilityId === "process.build_test").every(plan => !(plan.permission as { allowed?: boolean; dryRun?: boolean }).allowed
      || (plan.permission as { dryRun?: boolean }).dryRun)).toBe(true);
    const localPlans = plans.filter(plan => plan.capabilityId === "program.local_validation");
    expect(localPlans).toHaveLength(attempts.length);
    for (const [index, plan] of localPlans.entries()) {
      const payload = plan.input as unknown as {
        files: Array<{ path: string; hash: string }>;
        ownerRequirementIds: string[];
        build: { command: string; args: string[]; cwd: string };
        test: { command: string; args: string[]; cwd: string };
      };
      expect(payload.ownerRequirementIds).toEqual([...program.hydration!.ownerRequirementIds!].sort());
      expect(payload.files).toEqual(attempts[index]!.artifacts.map(artifact => ({ path: artifact.path, hash: artifact.contentHash }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      expect(payload.build.cwd).toBe(".");
      expect(payload.test.cwd).toBe(".");
    }
    const checkRoot = await mkdtemp(path.join(tmpdir(), "scce-native-heldout-"));
    roots.push(checkRoot);
    for (const artifact of result.buildTest!.artifacts) {
      const target = path.join(checkRoot, artifact.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, artifact.content, "utf8");
    }
    expect(await readFile(path.join(checkRoot, source.path), "utf8")).toBe(source.content);
    const independent = await runProcess(process.execPath, ["--input-type=module", "-e",
      `import assert from 'node:assert/strict'; import {double} from ${JSON.stringify(pathToFileURL(path.join(checkRoot, program.entrypoint)).href)}; assert.equal(double(37),74); assert.equal(double(-0.25),-0.5);`],
      { cwd: checkRoot, timeoutMs: 10_000 });
    expect(independent.code, independent.stderr).toBe(0);
  }, 60_000);
});
