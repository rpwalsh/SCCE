import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerFromWorkspaceCoreContext,
  proveClaim,
  workspaceCoreRecordsToGraphContext,
  workspaceCoreRecordsToLearningContext,
  workspaceCoreRecordsToProgramContext,
  workspaceCoreRecordsToProofContext,
  type ProofClaim,
  type ProofEvidenceRecord
} from "@scce/kernel";
import { analyzeWorkspaceProject, answerWorkspaceQuestion } from "../workspace-runtime.js";

const fixtureRoot = path.resolve("examples", "workspace-runtime-fixture");

describe("workspace kernel turn fusion", () => {
  it("answers from promoted workspace core records through graph/proof/learning/program/Mouth path", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);
    const question = "what is implemented, what is missing, and what should we fix first?";
    const graph = workspaceCoreRecordsToGraphContext(project.coreFusion, question);
    const proof = workspaceCoreRecordsToProofContext(project.coreFusion);
    const learning = workspaceCoreRecordsToLearningContext(project.coreFusion);
    const program = workspaceCoreRecordsToProgramContext(project.coreFusion, { requestText: question });
    const result = await answerFromWorkspaceCoreContext({
      promotion: project.coreFusion,
      question,
      options: { createdAt: 12000, maxLength: 4000 }
    });

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.field?.ppf.length).toBeGreaterThan(0);
    expect(proof.claims.length).toBeGreaterThan(0);
    expect(proof.evidence.length).toBeGreaterThan(0);
    expect(proof.certifiedClaimIds.length).toBeGreaterThan(0);
    expect(learning.needs.length).toBeGreaterThan(0);
    expect(program.plannerInputs.length).toBeGreaterThan(0);

    expect(result.schema).toBe("scce.workspace_kernel.answer.v1");
    expect(result.path).toBe("workspace_kernel_context");
    expect(result.generatedBy).toBe("workspace-kernel-context");
    expect(result.statusId).toBe("workspace.kernel.answer.ready");
    expect(result.usedWorkspaceQueryAdapter).toBe(false);
    expect(result.usedReportTemplate).toBe(false);
    expect(result.graph.field?.active.length).toBeGreaterThan(0);
    expect(result.proof.certifiedClaimIds.length).toBeGreaterThan(0);
    expect(result.learning.prioritizedGapRecordIds.length).toBeGreaterThan(0);
    expect(result.program.patchPlans.length).toBeGreaterThan(0);
    expect(result.program.programGraph?.id).toBeTruthy();
    expect(result.spoken.realizationTrace.selected.path).toBe("generated");

    expect(result.spoken.text).toContain("Implemented:");
    expect(result.spoken.text).toContain("WidgetService");
    expect(result.spoken.text).toContain("GET /api/widgets");
    expect(result.spoken.text).toContain("command build");
    expect(result.spoken.text).toContain("Contradiction:");
    expect(result.spoken.text).toContain("Missing:");
    expect(result.spoken.text).toContain("Fix first:");
    expect(result.mouthInput.answerSurface).toContain("Implemented:");
    assertNoTelemetryKeys(result.spoken.text);
    assertNoTelemetryKeys(result.mouthInput.answerSurface);

    expect(result.answerTrace.schema).toBe("scce.workspace_kernel.answer_trace.v1");
    expect(result.answerTrace.statusId).toBe("workspace.kernel.answer.ready");
    expect(result.answerTrace.certifiedClaimIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.implementedSymbolIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.implementedRouteIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.commandRecordIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.contradictionRecordIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.gapRecordIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.taskRecordIds.length).toBeGreaterThan(0);
    expect(result.answerTrace.programGraphId).toBe(result.program.programGraph?.id);
    expect(result.mouthInput.answerTrace).toEqual(result.answerTrace);
    const auditTrace = objectRecord(objectRecord(result.audit).answerTrace);
    expect(auditTrace.schema).toBe("scce.workspace_kernel.answer_trace.v1");

    const queryAdapter = answerWorkspaceQuestion(project, question);
    expect(result.spoken.text).not.toBe(queryAdapter.answer);
    expect(result.spoken.text).not.toContain("workspace.answer.intent=");
    expect(result.spoken.text).not.toBe(project.summary.body);
    for (const body of Object.values(project.reports)) {
      expect(result.spoken.text).not.toBe(body);
    }

    const proofGate = objectRecord(objectRecord(result.entailment.proof.scores).semanticProofEngine);
    expect(objectRecord(proofGate.trace).proofPath).toBe("structured_runtime");

    for (const patch of result.program.patchPlans) {
      expect(patch.workspaceTaskRecordId.startsWith("wc_")).toBe(true);
      expect(patch.evidenceSpanIds.length).toBeGreaterThan(0);
      expect(project.coreFusion.records.tasks.some(record => record.id === patch.workspaceTaskRecordId)).toBe(true);
    }
  });

  it("refuses proof certification without source spans and keeps learned code priors non-certifying", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);
    const proof = workspaceCoreRecordsToProofContext(project.coreFusion);
    const command = requiredPair(proof.claims, proof.evidence, "workspace.claim.command.");
    const route = requiredPair(proof.claims, proof.evidence, "workspace.claim.capability.");
    const symbol = requiredPair(proof.claims, proof.evidence, "workspace.claim.symbol.");

    for (const pair of [command, route, symbol]) {
      expect(proveClaim({ claim: pair.claim, candidateEvidence: [pair.evidence] }).verdict).toBe("certified");
      const missingSpan: ProofEvidenceRecord = { ...pair.evidence, evidenceSpanId: undefined };
      expect(proveClaim({ claim: pair.claim, candidateEvidence: [missingSpan] }).verdict).not.toBe("certified");
      const learnedPrior: ProofEvidenceRecord = { ...pair.evidence, forceClass: "learned_program_prior" };
      expect(proveClaim({ claim: pair.claim, candidateEvidence: [learnedPrior] }).verdict).toBe("unsupported_prior_only");
    }
  });

  it("does not fake success for an unsupported workspace question", async () => {
    const project = await analyzeWorkspaceProject(fixtureRoot);
    const result = await answerFromWorkspaceCoreContext({
      promotion: project.coreFusion,
      question: "design a waterproof bicycle drivetrain from scratch",
      options: { createdAt: 13000, maxLength: 1800 }
    });

    expect(result.statusId).toBe("workspace.kernel.answer.unsupported");
    expect(result.usedWorkspaceQueryAdapter).toBe(false);
    expect(result.usedReportTemplate).toBe(false);
    expect(result.answerTrace.statusId).toBe("workspace.kernel.answer.unsupported");
    expect(result.spoken.text).toContain("[scce:workspace.answer.unsupported]");
    assertNoTelemetryKeys(result.spoken.text);
    assertNoTelemetryKeys(result.mouthInput.answerSurface);
    expect(result.spoken.text).not.toContain("workspace.answer.intent=");
  });
});

function assertNoTelemetryKeys(text: string): void {
  for (const key of [
    "workspace.kernel.answer.schema=",
    "workspace.kernel.status=",
    "workspace.implemented.symbol=",
    "workspace.implemented.route=",
    "workspace.implemented.command=",
    "workspace.gap.rank=",
    "workspace.task.rank=",
    "workspace.program.graph="
  ]) {
    expect(text).not.toContain(key);
  }
}

function requiredPair(
  claims: readonly ProofClaim[],
  evidence: readonly ProofEvidenceRecord[],
  claimPrefix: string
): { claim: ProofClaim; evidence: ProofEvidenceRecord } {
  const claim = claims.find(item => item.id.startsWith(claimPrefix));
  const proofEvidence = claim ? evidence.find(item => item.relationId === claim.relationId && item.subject.id === claim.subject.id && item.object.id === claim.object.id) : undefined;
  if (!claim || !proofEvidence) throw new Error(`missing proof pair ${claimPrefix}`);
  return { claim, evidence: proofEvidence };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
