// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan, Hasher, ProgramConstructIntent, ProgramGraph, ProgramStatefulBehaviorRequirement, RequestedAuthority } from "./types.js";
import type { CodeRequestSignal } from "./code-request.js";
import { COGNITIVE_OPERATOR_IDS, type CognitiveOperatorId } from "./turn-requirements.js";
import { hasEngineeringCorpusMetadata } from "./program.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { validateProgramGraphHydration } from "./program-runtime.js";
import { searchProgramTransformations } from "./program-transformation-search.js";
import { searchStateTransitions } from "./state-transition-search.js";
import { rankLearnedProgramTransformations, type ProgramTransformationLearningEpisode } from "./program-transformation-learning.js";

/**
 * The turn's structured program intent, derived once from what the turn already decided: the projected
 * active cognitive operators, the structural code observation, and the engineering evidence it admitted. The program
 * builder and planner read the same operator decision. The code observation fills artifact details; it does not privately
 * decide whether a ProgramGraph may exist.
 */
export function programIntentForTurn(input: {
  requestedAuthority: RequestedAuthority;
  activeOperatorIds: readonly CognitiveOperatorId[];
  codeSignal: CodeRequestSignal;
  evidence: readonly EvidenceSpan[];
}): ProgramConstructIntent | undefined {
  if (!input.activeOperatorIds.includes(COGNITIVE_OPERATOR_IDS.programPlanning)) return undefined;
  const engineering = input.evidence.filter(span => hasEngineeringCorpusMetadata(span));
  // A request naming paths asks for an edit plan over those files; one naming none asks for a callable artifact.
  const artifactKindIds = input.codeSignal.paths.length ? ["program.artifact.patch_plan"] : ["program.artifact.library"];
  return {
    artifactKindIds,
    capabilityIds: input.codeSignal.paths.length ? ["program.capability.source_edit_plan"] : [],
    ...(input.codeSignal.language ? { languageId: input.codeSignal.language } : {}),
    ...(input.codeSignal.paths.length ? { entrypointPath: input.codeSignal.paths[0] } : {}),
    constraints: engineering.length ? ["program.constraint.source_backed"] : [],
    provenanceEvidenceIds: engineering.map(span => String(span.id)),
    behaviorRequirements: input.codeSignal.behaviorRequirements,
    statefulBehaviorRequirements: input.codeSignal.statefulBehaviorRequirements,
    ...(input.codeSignal.behaviorRequirements.length || input.codeSignal.statefulBehaviorRequirements.length ? { behaviorImplementationPhase: "probe" as const } : {}),
    metadata: toJsonValue({
      requestedAuthority: input.requestedAuthority,
      demand: input.codeSignal.demand,
      signals: input.codeSignal.signals,
      paths: input.codeSignal.paths
    })
  };
}

export interface OwnerBehaviorValidationFailure {
  readonly observationId: string;
  readonly programId: string;
  readonly planHash: string;
  readonly validatorId: string;
  readonly checkId: "tests";
  readonly status: "failed";
  readonly ownerRequirementIds: readonly string[];
  readonly command: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
}

export interface OwnerBehaviorRepairSelection {
  readonly id: string;
  readonly transformationId: "program.transformation.expression_search.v1" | "program.transformation.state_transition_search.v1";
  readonly failureObservationId: string;
  readonly ownerRequirementIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly selectedTransformationIds: readonly string[];
}

/**
 * Converts an observed, exact test failure into a selected retry state. The
 * The bounded search receives typed fit obligations rather than request prose.
 * Held-out values are reserved for execution and cannot rank a hypothesis.
 */
export function replanOwnerBehaviorProgramIntent(input: {
  readonly intent: ProgramConstructIntent;
  readonly program: ProgramGraph;
  readonly failure: OwnerBehaviorValidationFailure;
  readonly hasher?: Hasher;
  /** Successful episodes from the durable event ledger. They only rerank hypotheses that still fit now. */
  readonly learnedEpisodes?: readonly ProgramTransformationLearningEpisode[];
}): { readonly selection: OwnerBehaviorRepairSelection; readonly intent: ProgramConstructIntent } {
  const hydration = input.program.hydration;
  if (!hydration || !validateProgramGraphHydration(input.program).valid) throw new Error("owner behavior replan requires a valid hydrated program");
  if (input.failure.status !== "failed" || input.failure.checkId !== "tests") throw new Error("owner behavior replan requires an observed test failure");
  if (input.failure.programId !== input.program.id) throw new Error("owner behavior failure belongs to another program");
  if (!input.failure.observationId || !input.failure.planHash || !input.failure.validatorId) throw new Error("owner behavior failure identity is incomplete");
  if (canonicalStringify(input.failure.command) !== canonicalStringify(input.program.test)) {
    throw new Error("owner behavior failure did not execute the ProgramGraph test command");
  }
  const scalarRequirements = input.intent.behaviorRequirements ?? [];
  const statefulRequirements = input.intent.statefulBehaviorRequirements ?? [];
  if (scalarRequirements.length && statefulRequirements.length) throw new Error("owner behavior replan accepts one behavior representation per intent");
  const intentRequirementIds = [...new Set([...scalarRequirements, ...statefulRequirements].map(requirement => requirement.id))].sort(compareCanonical);
  const hydratedRequirementIds = [...new Set(hydration.ownerRequirementIds ?? [])].sort(compareCanonical);
  const failedRequirementIds = [...new Set(input.failure.ownerRequirementIds)].sort(compareCanonical);
  if (!intentRequirementIds.length
    || canonicalStringify(intentRequirementIds) !== canonicalStringify(hydratedRequirementIds)
    || canonicalStringify(intentRequirementIds) !== canonicalStringify(failedRequirementIds)) {
    throw new Error("owner behavior failure requirements are not bound to the program intent and hydration");
  }
  const scalarSearch = scalarRequirements.length ? searchProgramTransformations(scalarRequirements) : undefined;
  const statefulSearch = statefulRequirements.length ? searchStateTransitions(statefulScenarios(statefulRequirements)) : undefined;
  const rankedScalarSearch = scalarSearch ? {
    ...scalarSearch,
    // Keep the bounded search's canonical candidate order in the intent so
    // planner rehydration can verify every hypothesis. Durable successes only
    // influence which admissible candidate is selected.
    candidates: scalarSearch.candidates,
    selected: selectOnePerCallable(rankLearnedProgramTransformations(
      admissibleScalarCandidates(scalarSearch.candidates, scalarRequirements),
      input.learnedEpisodes ?? [],
      "expression"
    ))
  } : undefined;
  const rankedStatefulSearch = statefulSearch ? {
    ...statefulSearch,
    candidates: statefulSearch.candidates,
    selected: statefulSearch.selected.length
      ? rankLearnedProgramTransformations(
        admissibleStatefulCandidates(statefulSearch.candidates, statefulRequirements),
        input.learnedEpisodes ?? [],
        "state_transition"
      ).slice(0, 1)
      : []
  } : undefined;
  if (rankedScalarSearch) validateScalarSearch(scalarRequirements, rankedScalarSearch);
  if (rankedStatefulSearch) validateStatefulSearch(statefulRequirements, rankedStatefulSearch);
  const candidateIds = rankedScalarSearch?.candidates.map(candidate => candidate.id) ?? rankedStatefulSearch?.candidates.map(candidate => candidate.id) ?? [];
  const selectedTransformationIds = rankedScalarSearch?.selected.map(candidate => candidate.id) ?? rankedStatefulSearch?.selected.map(candidate => candidate.id) ?? [];
  const transformationId = rankedScalarSearch ? "program.transformation.expression_search.v1" as const : "program.transformation.state_transition_search.v1" as const;
  const hasher = input.hasher ?? createHasher();
  const selection: OwnerBehaviorRepairSelection = {
    id: `owner.behavior.repair_selection.${hasher.digestHex(canonicalStringify({
      programId: input.program.id,
      failureObservationId: input.failure.observationId,
      ownerRequirementIds: intentRequirementIds,
      candidateIds,
      selectedTransformationIds
    })).slice(0, 40)}`,
    transformationId,
    failureObservationId: input.failure.observationId,
    ownerRequirementIds: intentRequirementIds,
    candidateIds,
    selectedTransformationIds
  };
  return {
    selection,
    intent: {
      ...input.intent,
      behaviorImplementationPhase: "selected",
      ...(rankedScalarSearch ? {
        behaviorTransformationCandidates: rankedScalarSearch.candidates.map(candidate => ({ ...candidate })),
        selectedBehaviorTransformationIds: selectedTransformationIds
      } : {
        statefulBehaviorTransformationCandidates: rankedStatefulSearch!.candidates.map(candidate => ({ ...candidate })),
        selectedStatefulBehaviorTransformationIds: selectedTransformationIds
      }),
      constraints: [...new Set([...(input.intent.constraints ?? []), "program.constraint.retry_after_failed_owner_validation"])],
      metadata: toJsonValue({
        prior: input.intent.metadata ?? null,
        replan: {
          selectionId: selection.id,
          transformationId: selection.transformationId,
          failureObservationId: input.failure.observationId,
          failedPlanHash: input.failure.planHash,
          validatorId: input.failure.validatorId,
          ownerRequirementIds: intentRequirementIds,
          candidateIds,
          selectedTransformationIds
        }
      })
    }
  };
}

function selectOnePerCallable(candidates: readonly import("./program-transformation-search.js").ProgramTransformationCandidate[]): import("./program-transformation-search.js").ProgramTransformationCandidate[] {
  const selected = new Map<string, import("./program-transformation-search.js").ProgramTransformationCandidate>();
  for (const candidate of candidates) if (!selected.has(candidate.callableId)) selected.set(candidate.callableId, candidate);
  return [...selected.values()].sort((left, right) => left.callableId < right.callableId ? -1 : left.callableId > right.callableId ? 1 : 0);
}

function admissibleScalarCandidates(
  candidates: readonly import("./program-transformation-search.js").ProgramTransformationCandidate[],
  requirements: readonly NonNullable<ProgramConstructIntent["behaviorRequirements"]>[number][]
): import("./program-transformation-search.js").ProgramTransformationCandidate[] {
  return candidates.filter(candidate => {
    const fitIds = requirements
      .filter(requirement => requirement.callableId === candidate.callableId && requirement.verificationRole === "fit")
      .map(requirement => requirement.id)
      .sort(compareCanonical);
    return candidate.fitMeanSquaredError <= 1e-12
      && canonicalStringify(candidate.predictedFitObligationIds) === canonicalStringify(fitIds);
  });
}

function admissibleStatefulCandidates(
  candidates: readonly import("./state-transition-search.js").StateTransitionCandidate[],
  requirements: readonly ProgramStatefulBehaviorRequirement[]
): import("./state-transition-search.js").StateTransitionCandidate[] {
  const fitIds = requirements
    .filter(requirement => requirement.verificationRole === "fit")
    .map(requirement => requirement.id)
    .sort(compareCanonical);
  return candidates.filter(candidate => candidate.fitError <= 0
    && canonicalStringify(candidate.predictedFitIds) === canonicalStringify(fitIds));
}

function statefulScenarios(requirements: readonly ProgramStatefulBehaviorRequirement[]) {
  return requirements.map(requirement => ({
    id: requirement.id,
    invocations: requirement.invocations.map(invocation => ({ operationId: invocation.callableId, arguments: invocation.arguments })),
    expectedResult: requirement.expectedResult,
    verificationRole: requirement.verificationRole
  }));
}

function validateScalarSearch(requirements: readonly NonNullable<ProgramConstructIntent["behaviorRequirements"]>[number][], search: ReturnType<typeof searchProgramTransformations>): void {
  const requiredCallables = [...new Set(requirements.map(requirement => requirement.callableId))].sort(compareCanonical);
  const selectedCallables = search.selected.map(candidate => candidate.callableId).sort(compareCanonical);
  if (canonicalStringify(requiredCallables) !== canonicalStringify(selectedCallables)) throw new Error("owner behavior replan found no admissible transformation for every required callable");
  for (const candidate of search.selected) {
    const fitIds = requirements.filter(requirement => requirement.callableId === candidate.callableId && requirement.verificationRole === "fit").map(requirement => requirement.id).sort(compareCanonical);
    if (candidate.fitMeanSquaredError > 1e-12 || canonicalStringify(candidate.predictedFitObligationIds) !== canonicalStringify(fitIds)) throw new Error(`owner behavior replan found no exact transformation for callable: ${candidate.callableId}`);
  }
}

function validateStatefulSearch(requirements: readonly ProgramStatefulBehaviorRequirement[], search: ReturnType<typeof searchStateTransitions>): void {
  const selected = search.selected[0];
  const fitIds = requirements.filter(requirement => requirement.verificationRole === "fit").map(requirement => requirement.id).sort(compareCanonical);
  if (!selected || selected.fitError > 0 || canonicalStringify(selected.predictedFitIds) !== canonicalStringify(fitIds)) throw new Error("owner behavior replan found no exact state transition transformation");
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
