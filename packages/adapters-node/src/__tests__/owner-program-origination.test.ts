// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  COGNITIVE_OPERATOR_IDS,
  codeRequestSignal,
  createClock,
  createHasher,
  createIdFactory,
  createProgramGraphBuilder,
  evaluateProgramExpression,
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

describe("owner program origination", () => {
  it("materializes a blank-workspace program, observes failure, replans, and passes the owner test", async () => {
    const request = "Create a function double(x) such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run tests proving it.";
    const hasher = createHasher();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 91_000, stepMs: 1 }), hasher, deterministicReplay: true });
    const signal = codeRequestSignal(request);
    const initialIntent = required(programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: signal, evidence: [] }));
    const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
    const initialProgram = required(builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: 91_000,
      evidence: [],
      entailment: emptyEntailment(),
      programIntent: initialIntent
    }).program);
    const ownerRequirementIds = initialIntent.behaviorRequirements?.map(requirement => requirement.id) ?? [];
    expect(ownerRequirementIds).toHaveLength(4);
    expect(initialIntent.behaviorImplementationPhase).toBe("probe");
    expect(required(initialProgram.files.find(file => file.path === initialProgram.entrypoint)).content)
      .toContain("return args.length === 1 ? args[0] : args");

    const root = await mkdtemp(join(tmpdir(), "scce-owner-origin-"));
    roots.push(root);
    const workspace = {
      id: "workspace.owner.blank",
      rootPath: root,
      rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus.owner.blank",
      status: "active",
      createdAt: 91_000,
      updatedAt: 91_000,
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
    const failedEvidence = transactionFailure.validation?.evidence;
    const replan = replanOwnerBehaviorProgramIntent({
      intent: initialIntent,
      program: initialProgram,
      failure: {
        observationId: `owner.validation.failure.${hasher.digestHex(canonicalStringify(toJsonValue(failedEvidence))).slice(0, 40)}`,
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

    const repairedProgram = required(builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: 91_001,
      evidence: [],
      entailment: emptyEntailment(),
      programIntent: replan.intent
    }).program);
    expect(canonicalStringify(repairedProgram.nodes)).toContain(replan.selection.id);
    expect(replan.intent.behaviorImplementationPhase).toBe("selected");
    expect(replan.selection.selectedTransformationIds).toEqual(replan.intent.selectedBehaviorTransformationIds);
    const selected = required(replan.intent.behaviorTransformationCandidates?.find(candidate =>
      replan.intent.selectedBehaviorTransformationIds?.includes(candidate.id)
    ));
    expect(selected.predictedFitObligationIds).toEqual(
      initialIntent.behaviorRequirements?.filter(requirement => requirement.verificationRole === "fit").map(requirement => requirement.id).sort()
    );
    expect(selected.heldOutObligationIds).toEqual(
      initialIntent.behaviorRequirements?.filter(requirement => requirement.verificationRole === "held_out").map(requirement => requirement.id).sort()
    );
    expect(evaluateProgramExpression(selected.producedIr, 11)).toBe(22);
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
    expect(source).toContain("export function double(...args)");
    expect(source).toContain("return (args[0] + args[0])");
    expect(source).not.toContain("expectedResult");
    expect(test).toContain("owner requirement");
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
    requestId: "request.owner.double",
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
    id: "owner-node-validation.v1",
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
    claim: { id: "claim.owner.program" as never, text: "", normalized: "", features: [], polarity: 1 },
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force: "unknown",
    support: 0,
    contradiction: 0,
    faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: "proof.owner.program" as never, claimId: "claim.owner.program" as never, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "owner-program.v1", createdAt: 91_000 }
  };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try { return await promise; }
  catch (error) { return error; }
}

async function absent(path: string): Promise<boolean> {
  try { await readFile(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing required value");
  return value;
}
