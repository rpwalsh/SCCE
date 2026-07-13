import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorrectionRuleRecord } from "../storage.js";
import type { WorkspaceCoreSourceFileInput, WorkspaceCoreSourceRef } from "../workspace-core-fusion.js";
import { createScceRuntime, validateScceRuntimeTurnTrace, type ScceRuntimeFixtureFile } from "../scce-runtime.js";
import { createSourceCompletionContract, validateSourceCompletionContract } from "../source-completion-contract.js";

describe("SCCE source-completion runtime", () => {
  it("runs the local source-only cognitive loop without DB, server, live import, or report-template answers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-runtime-completion-"));
    try {
      const files: ScceRuntimeFixtureFile[] = [
        {
          path: "docs/ops.md",
          mediaType: "text/markdown",
          text: [
            "# Pump Alpha",
            "Pump alpha pressure is 42 psi according to the shift measurement.",
            "Legacy note: pump alpha pressure is 41 psi.",
            "Calibration owner is not recorded in this workspace."
          ].join("\n"),
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "src/pump.ts",
          mediaType: "text/typescript",
          text: [
            "export interface PumpStatus { id: string; pressurePsi: number }",
            "export function readPumpAlpha(): PumpStatus {",
            "  return { id: 'pump-alpha', pressurePsi: 42 };",
            "}"
          ].join("\n"),
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "logs/pump.log",
          mediaType: "text/x-log",
          text: "2026-06-27T20:00:00Z pump-alpha stable pressure=42 status=ok",
          metadata: {
            sourceKind: "developer_intelligence",
            logEvents: [{ timestamp: "2026-06-27T20:00:00Z", component: "pump-alpha", status: "ok", message: "pressure 42 psi" }]
          }
        },
        {
          path: "data/measurements.csv",
          mediaType: "text/csv",
          text: "asset,pressurePsi,status\npump-alpha,42,stable\npump-beta,38,stable\n",
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "package.json",
          mediaType: "application/json",
          text: JSON.stringify({
            name: "pump-workspace",
            scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
            dependencies: {},
            devDependencies: { typescript: "^5.8.3", vitest: "^3.2.6" }
          }, null, 2),
          metadata: { sourceKind: "developer_intelligence" }
        }
      ];
      for (const file of files) {
        const absolute = path.join(root, file.path);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, file.text, "utf8");
      }

      const runtime = createScceRuntime();
      const ingested = runtime.ingest({ id: "fixture.pump-alpha", rootPath: root, files });
      expect(ingested.typedProjections.flatMap(item => item.observations).length).toBeGreaterThan(0);
      expect(ingested.graphLearning.schema).toBe("scce.runtime.graph_learning_report.v2");
      expect(ingested.graphLearning.model.weights.length).toBeGreaterThan(0);
      expect(ingested.graphLearning.linkPrediction.positiveEdgeCount).toBeGreaterThan(0);
      expect(ingested.graphLearning.evidenceConstructAlignment.typedObservationCount).toBeGreaterThan(0);
      expect(ingested.classificationCounts.code).toBeGreaterThan(0);
      expect(ingested.classificationCounts.log_event).toBeGreaterThan(0);
      expect(ingested.classificationCounts.table).toBeGreaterThan(0);

      const source = sourceRefLookup(ingested.analysis.sources);
      const opsRef = source("docs/ops.md");
      const pumpRef = source("src/pump.ts");
      const packageRef = source("package.json");
      const analysis = {
        ...ingested.analysis,
        summary: {
          body: "REPORT_TEMPLATE_BODY_SHOULD_NOT_BE_SPOKEN",
          sourceRefs: [opsRef, pumpRef, packageRef],
          counts: { files: files.length, typedObservations: ingested.typedProjections.flatMap(item => item.observations).length }
        },
        symbols: [
          {
            id: "symbol.PumpStatus",
            name: "PumpStatus",
            kind: "typescript.interface",
            path: "src/pump.ts",
            exported: true,
            sourceRef: pumpRef,
            mentionedByDocs: ["docs/ops.md:2"]
          },
          {
            id: "symbol.readPumpAlpha",
            name: "readPumpAlpha",
            kind: "typescript.function",
            path: "src/pump.ts",
            exported: true,
            sourceRef: pumpRef,
            mentionedByDocs: ["docs/ops.md:2"]
          }
        ],
        commands: [
          { id: "command.build", name: "build", command: "pnpm run build", sourcePath: "package.json", kind: "eng.command.build", sourceRef: packageRef },
          { id: "command.test", name: "test", command: "pnpm test", sourcePath: "package.json", kind: "eng.command.validation", sourceRef: packageRef }
        ],
        routes: [
          { id: "route.pump-alpha", method: "GET", path: "/api/pump-alpha", filePath: "src/pump.ts", handlerHint: "readPumpAlpha", sourceRef: pumpRef }
        ],
        contradictions: [
          {
            id: "finding.contradiction.pressure",
            kind: "workspace.finding.contradiction",
            severity: "high",
            statement: "Workspace contains both 42 psi measurement support and a 41 psi legacy note for pump alpha.",
            sourceRefs: [opsRef],
            affectedFiles: ["docs/ops.md"],
            suggestedFix: "Reconcile the legacy note against the measurement table.",
            confidence: 0.88,
            metadata: { measuredValue: 42, contradictedValue: 41 }
          }
        ],
        gaps: [
          {
            id: "finding.gap.calibration-owner",
            kind: "workspace.need.calibration_owner",
            severity: "medium",
            statement: "Calibration owner is not recorded in this workspace.",
            sourceRefs: [opsRef],
            affectedFiles: ["docs/ops.md"],
            suggestedFix: "Acquire a source-bound calibration owner record.",
            confidence: 0.76,
            metadata: { requiredEvidenceField: "calibrationOwner" }
          }
        ],
        tasks: [
          {
            id: "finding.task.pressure-parser",
            kind: "workspace.task.patch_pressure_parser",
            severity: "medium",
            statement: "Code gap: expose a typed pressure parser before changing pump behavior.",
            sourceRefs: [pumpRef, packageRef],
            affectedFiles: ["src/pump.ts"],
            suggestedFix: "Add a typed PressureReading parser and keep validation commands source-backed.",
            confidence: 0.82,
            metadata: { patchKind: "source_edit_plan" }
          }
        ],
        reports: {
          brief: "REPORT_TEMPLATE_BODY_SHOULD_NOT_BE_SPOKEN"
        }
      };

      const promotion = runtime.promote({ analysis });
      expect(promotion.safeToHydrate).toBe(true);
      expect(promotion.records.tasks).toHaveLength(1);
      expect(promotion.records.gaps).toHaveLength(1);
      expect(promotion.records.contradictions).toHaveLength(1);

      const correctionRule: CorrectionRuleRecord = {
        id: "correction.patch-first",
        episodeId: "episode_runtime_completion" as never,
        ruleKind: "terminology_preference",
        scope: "runtime.test",
        pattern: "Fix first",
        replacement: "Patch first",
        weight: 1,
        contextJson: {},
        provenanceJson: { source: "structured_owner_correction" },
        createdAt: 1,
        updatedAt: 1
      };
      const turn = await runtime.turn({
        promotionId: promotion.replayTraceId,
        text: "What does the pump alpha workspace show, and what code work is needed?",
        correctionRules: [correctionRule]
      });

      expect(turn.schema).toBe("scce.runtime.turn.v1");
      expect(turn.simulation).toBe(true);
      expect(turn.hydratedRuntime).toBe(false);
      expect(turn.serverPath).toBe(false);
      expect(turn.answer).not.toContain("REPORT_TEMPLATE_BODY_SHOULD_NOT_BE_SPOKEN");
      expect(turn.answer).not.toContain("proof=");
      expect(turn.answer).not.toContain("program.entrypoint=");
      expect(turn.answer).not.toContain("workspace.kernel");
      expect(turn.answer).not.toContain("if you want");
      expect(turn.workspace.usedReportTemplate).toBe(false);
      expect(turn.workspace.usedWorkspaceQueryAdapter).toBe(false);
      expect(turn.workspace.proof.certifiedClaimIds.length).toBeGreaterThan(0);
      expect(turn.workspace.learning.needs.length).toBeGreaterThan(0);
      expect(turn.workspace.program.programGraph?.id).toBeTruthy();
      expect(turn.workspace.answerGraph.schema).toBe("scce.workspace_kernel.answer_action_graph.v1");
      expect(turn.workspace.answerGraph.claims.length).toBeGreaterThan(0);
      expect(turn.workspace.answerGraph.supportLinks.length).toBeGreaterThan(0);
      expect(turn.workspace.answerGraph.actions.length).toBeGreaterThan(0);
      expect(turn.workspace.mouthInput.answerGraph.id).toBe(turn.workspace.answerGraph.id);
      expect(turn.workspace.dialogueState.conversationId).toBeTruthy();
      expect(turn.workspace.dialogueState.turnId).toBeTruthy();
      expect(turn.workspace.dialoguePolicyDecision.schema).toBe("scce.dialogue.policy_decision.v1");
      expect(turn.workspace.pragmatics.schema).toBe("scce.dialogue.pragmatics_result.v1");
      expect(turn.workspace.pragmatics.finalText.length).toBeGreaterThan(0);
      expect(turn.workspace.mouthInput.dialoguePolicyDecision.id).toBe(turn.workspace.dialoguePolicyDecision.id);
      expect(validateScceRuntimeTurnTrace(turn.trace).valid).toBe(true);
      expect(turn.trace.schema).toBe("scce.runtime.turn_trace.v1");
      expect(turn.trace.runtimeModeId).toBe("runtime.mode.source_only_in_memory");
      expect(turn.trace.graphAlphaPpfSummaryId).toBe(turn.trace.graphAlphaPpfSummary?.id);
      expect(runtime.inspect(turn.id).kind).toBe("turn");
      expect(turn.trace.evidenceIds.length).toBeGreaterThan(0);
      expect(turn.trace.constructId).toBe(String(turn.workspace.mouthInput.speakInput.construct.id));
      expect(turn.trace.programGraphId).toBe(turn.workspace.program.programGraph?.id);
      expect(turn.trace.walshSurfaceEnergySelectedCandidateId).toBe(turn.workspace.spoken.realizationTrace.selected.id);
      expect(turn.trace.dialogueStateId).toBe(turn.workspace.dialogueState.turnId);
      expect(turn.trace.dialoguePolicyDecisionId).toBe(turn.workspace.dialoguePolicyDecision.id);
      expect(turn.trace.pragmaticsCriticId).toBe(turn.workspace.pragmatics.selected.criticId);
      expect(runtime.inspect(turn.workspace.dialogueState.turnId).kind).toBe("dialogue_state");
      expect(turn.trace.scoreTraces.length).toBeGreaterThan(0);
      expect(turn.trace.calibrationStatus).toBe("uncalibrated");
      expect(turn.trace.calibration?.calibrationStatus).toBe(turn.trace.calibrationStatus);
      expect(turn.trace.truthState.symbolicState).toBeTruthy();
      expect(turn.trace.evidenceForce).not.toBe("unknown");
      expect(turn.trace.guardFlags.requireEvidence).toBe(true);

      const priorOnlyLearning = runtime.runLearningStep({
        turnId: turn.id,
        maxPlansToRun: 1,
        fixtures: {
          evidence: [priorOnlyMaterial()],
          corpus: [priorOnlyMaterial("source.synthetic.corpus_fixture")],
          documents: [priorOnlyMaterial("source.synthetic.in_memory_document")]
        }
      });
      expect(priorOnlyLearning.learning.updatePlans.flatMap(plan => plan.evidenceRecordsToAdd)).toHaveLength(0);
      expect(priorOnlyLearning.learning.continueDecision.safeToAssert).toBe(false);

      const directMaterial = {
        id: "fixture.calibration-owner",
        sourceKindId: "source.synthetic.fixture_evidence",
        uri: "fixture://calibration-owner",
        mediaType: "text/plain",
        text: "Calibration owner for pump alpha is shift lead A.",
        forceClass: "direct_evidence" as const,
        metadata: { source: "synthetic_tool_result" }
      };
      const learned = runtime.runLearningStep({
        turnId: turn.id,
        maxPlansToRun: 1,
        fixtures: {
          evidence: [directMaterial],
          corpus: [{ ...directMaterial, sourceKindId: "source.synthetic.corpus_fixture" }],
          documents: [{ ...directMaterial, sourceKindId: "source.synthetic.in_memory_document" }]
        }
      });
      expect(learned.toolUseResultIds.length).toBeGreaterThan(0);
      expect(learned.learning.updatePlans.flatMap(plan => plan.evidenceRecordsToAdd).length).toBeGreaterThan(0);
      expect(runtime.inspect(learned.id).kind).toBe("learning_step");

      const patch = runtime.planPatch({
        turnId: turn.id,
        stderr: "src/pump.ts(2,17): error TS2304: Cannot find name 'PressureReading'.",
        requestText: "Add typed pressure parser."
      });
      expect(patch.programGraphId).toBe(turn.workspace.program.programGraph?.id);
      expect(patch.workspaceAffectedFiles).toContain("src/pump.ts");
      expect(patch.repairPlan.selectedPatchSet?.affectedFiles.length).toBeGreaterThan(0);
      expect(patch.repairPlan.selectedPatchSet?.sourceEvidence.length).toBeGreaterThan(0);
      expect(patch.repairPlan.selectedPatchSet?.rollbackPlan.length).toBeGreaterThan(0);
      expect(patch.virtualPatch?.changed.every(file => !path.isAbsolute(file) && !file.includes(".."))).toBe(true);
      expect(patch.repairPlan.validationPlan.every(item => item.commandSource !== "program.validation.command.source_derived")).toBe(true);
      const failedPatchOutcome = runtime.recordOutcome({
        patchPlanId: patch.id,
        status: "failed",
        tests: { passed: false, total: 1, failed: 1, command: "pnpm test" },
        errorClass: "test_failure"
      });
      expect(failedPatchOutcome.patchRankSignal?.adjustedScore).toBeLessThan(failedPatchOutcome.patchRankSignal?.previousScore ?? 1);
      expect(runtime.inspect(failedPatchOutcome.id).kind).toBe("outcome");
      const passedPatchOutcome = runtime.recordOutcome({
        patchPlanId: patch.id,
        status: "succeeded",
        tests: { passed: true, total: 1, failed: 0, command: "pnpm test" }
      });
      expect(passedPatchOutcome.patchRankSignal?.adjustedScore).toBeGreaterThan(passedPatchOutcome.patchRankSignal?.previousScore ?? 0);
      expect(passedPatchOutcome.calibrationModel?.taskClass).toBe("runtime.patch_plan");

      const hydration = runtime.planHydration({ turnId: turn.id, promotionId: promotion.replayTraceId });
      expect(hydration.safeToHydrateLater).toBe(true);
      expect(hydration.contract.families.length).toBeGreaterThan(35);
      expect(hydration.contract.families.map(item => item.familyId)).toEqual(expect.arrayContaining([
        "scce2_import_runs",
        "scce2_shard_sections",
        "source_versions",
        "evidence_spans",
        "graph_learning_reports",
        "dialogue_state_records",
        "ngram_observations",
        "ngram_models",
        "typed_observations",
        "measurement_observations",
        "proof_traces",
        "mouth_traces",
        "walsh_surface_energy_traces",
        "field_alpha_ppf_traces",
        "learning_loop_records",
        "program_graph_records",
        "artifact_emission_records",
        "developer_intelligence_records",
        "workspace_core_records",
        "source_only_runtime_turn_traces",
        "runtime_outcome_records",
        "hydration_dry_run_plans"
      ]));
      const invalid = validateSourceCompletionContract({
        families: hydration.contract.families.filter(item => item.familyId !== "source_only_runtime_turn_traces"),
        dryRunHydrationPlan: hydration.contract.dryRunHydrationPlan.filter(item => item.familyId !== "source_only_runtime_turn_traces")
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.missingFamilies).toContain("source_only_runtime_turn_traces");

      const emptyContract = createSourceCompletionContract({ families: [] });
      expect(emptyContract.valid).toBe(false);
    } finally {
      if (root.startsWith(os.tmpdir())) await rm(root, { recursive: true, force: true });
    }
  });
});

function priorOnlyMaterial(sourceKindId = "source.synthetic.fixture_evidence") {
  return {
    id: "fixture.prior-only",
    sourceKindId,
    uri: "fixture://prior-only",
    mediaType: "text/plain",
    text: "Pump alpha pressure is 42 psi.",
    forceClass: "learned_concept_prior" as const,
    metadata: { source: "prior_only" }
  };
}

function sourceRefLookup(sources: readonly WorkspaceCoreSourceFileInput[]): (targetPath: string) => WorkspaceCoreSourceRef {
  return targetPath => {
    const source = sources.find(item => item.path === targetPath);
    if (!source?.evidenceIds?.[0] || !source.contentHash) throw new Error(`missing source ref for ${targetPath}`);
    return { path: source.path, lineStart: 1, evidenceSpanId: source.evidenceIds[0], contentHash: source.contentHash };
  };
}
