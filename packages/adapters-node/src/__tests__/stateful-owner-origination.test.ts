// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  codeRequestSignal,
  createClock,
  createHasher,
  createIdFactory,
  createProgramGraphBuilder,
  programIntentForTurn,
  replanOwnerBehaviorProgramIntent,
  toJsonValue,
  type ProgramGraph,
  type SemanticEntailmentResult,
  type WorkspaceProgramPatchPlanGenerationResult
} from "@scce/kernel";
import { createWorkspaceRuntime } from "../workspace-runtime.js";
import { runStructuredPatchValidation, type StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
import { executeWorkspacePatchTransaction, WorkspacePatchTransactionError } from "../workspace-patch-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("stateful owner program origination", () => {
  it("materializes a blank-workspace state machine after probe failure and validates a held-out trace", async () => {
    const request = "put(key,value); get(key); delete(key); put(\"a\",4); get(\"a\") => 4; put(\"a\",9); get(\"a\") => 9; put(\"b\",7); delete(\"b\"); get(\"b\") => null; put(\"z\",5); put(\"z\",8); get(\"z\") => 8";
    const hasher = createHasher();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 92_000, stepMs: 1 }), hasher, deterministicReplay: true });
    const signal = codeRequestSignal(request);
    expect(signal.statefulBehaviorRequirements).toHaveLength(4);
    expect(signal.statefulBehaviorRequirements.map(requirement => requirement.verificationRole)).toEqual(["fit", "fit", "fit", "held_out"]);
    const initialIntent = required(programIntentForTurn({ requestedAuthority: "program", codeSignal: signal, evidence: [] }));
    const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
    const initialProgram = required(builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: 92_000,
      evidence: [],
      entailment: emptyEntailment(),
      programIntent: initialIntent
    }).program);
    const ownerRequirementIds = initialIntent.statefulBehaviorRequirements?.map(requirement => requirement.id) ?? [];
    expect(ownerRequirementIds).toHaveLength(4);
    expect(initialIntent.behaviorImplementationPhase).toBe("probe");

    const root = await mkdtemp(join(tmpdir(), "scce-owner-stateful-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "test"));
    const workspace = {
      id: "workspace.owner.stateful.blank",
      rootPath: root,
      rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus.owner.stateful.blank",
      status: "active",
      createdAt: 92_000,
      updatedAt: 92_000,
      metadata: {}
    };
    const failedPlan = await workspacePlan(root, workspace, initialProgram, request, ownerRequirementIds);
    const policy = validationPolicy(initialProgram);
    const failure = await capture(executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan: failedPlan.plan,
      validate: view => runStructuredPatchValidation({ workspaceRoot: root, validationView: view, policy })
    }));
    expect(failure).toBeInstanceOf(WorkspacePatchTransactionError);
    const transactionFailure = failure as WorkspacePatchTransactionError;
    expect(transactionFailure.code).toBe("VALIDATION_FAILED");
    expect(transactionFailure.validation).toMatchObject({ ok: false, validatorId: policy.id });
    expect(await absent(join(root, "src", "program.mjs"))).toBe(true);

    const replan = replanOwnerBehaviorProgramIntent({
      intent: initialIntent,
      program: initialProgram,
      failure: {
        observationId: `owner.stateful.validation.failure.${hasher.digestHex(canonicalStringify(toJsonValue(transactionFailure.validation?.evidence))).slice(0, 40)}`,
        programId: initialProgram.id,
        planHash: String(failedPlan.plan.planHash),
        validatorId: policy.id,
        checkId: "tests",
        status: "failed",
        ownerRequirementIds,
        command: initialProgram.test
      },
      hasher
    });
    expect(replan.selection.transformationId).toBe("program.transformation.state_transition_search.v1");
    expect(replan.intent.behaviorImplementationPhase).toBe("selected");
    expect(replan.selection.selectedTransformationIds).toEqual(replan.intent.selectedStatefulBehaviorTransformationIds);
    expect(replan.selection.selectedTransformationIds).toHaveLength(1);

    const repairedProgram = required(builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: 92_001,
      evidence: [],
      entailment: emptyEntailment(),
      programIntent: replan.intent
    }).program);
    const repairedPlan = await workspacePlan(root, workspace, repairedProgram, request, ownerRequirementIds);
    const receipt = await executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan: repairedPlan.plan,
      validate: view => runStructuredPatchValidation({
        workspaceRoot: root,
        validationView: view,
        policy: validationPolicy(repairedProgram)
      })
    });
    expect(receipt.validation?.executedChecks?.map(check => check.checkId)).toEqual(["compiler", "typecheck", "tests"]);
    const source = await readFile(join(root, "src", "program.mjs"), "utf8");
    const test = await readFile(join(root, "test", "program.test.mjs"), "utf8");
    expect(source).toContain("put");
    expect(source).toContain("get");
    expect(source).toContain("delete");
    expect(source).not.toContain("expectedResult");
    expect(test).toContain("expectedResult");
    expect(receipt.mutations.map(mutation => mutation.path)).toEqual(["src/program.mjs", "test/program.test.mjs"]);
  });
});

async function workspacePlan(
  root: string,
  workspace: Record<string, unknown>,
  program: ProgramGraph,
  request: string,
  ownerRequirementIds: readonly string[]
): Promise<WorkspaceProgramPatchPlanGenerationResult> {
  const runtime = createWorkspaceRuntime({
    runtime: { storage: { workspace: { latestWorkspace: async () => workspace, listSourceFiles: async () => [] } } } as never,
    config: { runtime: { workspaceRoot: root, allowedRoots: [root] } } as never
  });
  const result = await runtime.planCodingPatch({
    workspaceId: String(workspace.id),
    expectedWorkspaceUpdatedAt: Number(workspace.updatedAt),
    requestId: "request.owner.stateful",
    requestText: request,
    requestedPaths: ["src/program.mjs"],
    program,
    evidenceIds: [],
    ownerRequirementIds,
    validationPlan: { validatorId: "validator.owner.node", checks: ["compiler", "typecheck", "tests"] }
  }, root, { maxFiles: 64, maxFileBytes: 1024 * 1024 });
  if (!("programProposalTrace" in result)) throw new Error(`expected ProgramGraph workspace plan, received ${JSON.stringify(result)}`);
  return result;
}

function validationPolicy(program: ProgramGraph): StructuredPatchValidationPolicy {
  return {
    schemaVersion: "scce.patch-validation-policy.v1",
    id: "owner-node-stateful-validation.v1",
    commands: [
      { executable: process.execPath, argv: ["--check", program.entrypoint], checkIds: ["compiler", "typecheck"] },
      { executable: process.execPath, argv: program.test.args, checkIds: ["tests"] }
    ],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    maxWorkspaceFiles: 32,
    maxWorkspaceBytes: 1024 * 1024
  };
}

function emptyEntailment(): SemanticEntailmentResult {
  return {
    claim: { id: "claim.owner.stateful" as never, text: "", normalized: "", features: [], polarity: 1 },
    verdict: "underdetermined", semanticVerdict: "underdetermined", force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: "proof.owner.stateful" as never, claimId: "claim.owner.stateful" as never, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "owner-stateful.v1", createdAt: 92_000 }
  };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try { return await promise; } catch (error) { return error; }
}

async function absent(path: string): Promise<boolean> {
  try { await readFile(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing required value");
  return value;
}
