// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BuildTestResult, Hasher, ProgramGraph } from "./types.js";
import { bindExecutedProgramArtifacts } from "./program-runtime.js";
import {
  createProgramRepairKernel,
  materializeProgramRepair,
  selectObservedProgramRepair,
  type ObservedProgramRepairSelection,
  type RepairPlan
} from "./program-repair-kernel.js";

export interface ObservedProgramRepairTransition {
  readonly failureObservationId: string;
  readonly observedProgram: ProgramGraph;
  readonly repairPlan: RepairPlan;
  readonly selection: ObservedProgramRepairSelection;
  readonly repairedProgram?: ProgramGraph;
  readonly changedPaths: readonly string[];
}

/**
 * Plans one repair transition from the exact failed execution. The adapter is
 * deliberately absent: this kernel operator observes its result, creates and
 * selects candidates against active requirements, and materializes only the
 * explicitly selected patch. Execution and validation remain later steps.
 */
export function planObservedProgramRepairTransition(input: {
  program: ProgramGraph;
  build: BuildTestResult;
  requestText: string;
  activeRequirementIds: readonly string[];
  hasher: Hasher;
}): ObservedProgramRepairTransition {
  const observedProgram = bindExecutedProgramArtifacts({
    program: input.program,
    artifacts: input.build.artifacts,
    hasher: input.hasher
  });
  const failureObservationId = `owner.program.failure.${input.hasher.digestHex(JSON.stringify({
    programId: observedProgram.id,
    build: input.build.build,
    test: input.build.test,
    artifactHashes: input.build.artifacts.map(artifact => artifact.contentHash),
    activeRequirementIds: [...input.activeRequirementIds].sort()
  })).slice(0, 40)}`;
  const kernel = createProgramRepairKernel({ hasher: input.hasher, maxAttempts: 1 });
  const repairPlan = kernel.plan({
    program: observedProgram,
    build: input.build,
    requestText: input.requestText
  });
  const selection = selectObservedProgramRepair({
    repairPlan,
    program: observedProgram,
    build: input.build,
    failureObservationId,
    activeRequirementIds: input.activeRequirementIds,
    hasher: input.hasher
  });
  if (!selection.selectedPatchSetId) {
    return { failureObservationId, observedProgram, repairPlan, selection, changedPaths: [] };
  }
  const materialized = materializeProgramRepair({
    program: observedProgram,
    build: input.build,
    requestText: input.requestText,
    patchSetId: selection.selectedPatchSetId,
    hasher: input.hasher,
    maxAttempts: 1
  });
  return {
    failureObservationId,
    observedProgram,
    repairPlan,
    selection,
    repairedProgram: materialized.program,
    changedPaths: materialized.changedPaths
  };
}
