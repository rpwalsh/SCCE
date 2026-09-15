// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import type { BuildTestResult, EpisodeId, Hasher, JsonValue, ProgramBehaviorRequirement, ProgramGraph, ProgramConstructIntent, ProgramStatefulBehaviorRequirement } from "./types.js";
import { canonicalStringify, createHasher } from "./primitives.js";
import type { ProgramTransformationCandidate } from "./program-transformation-search.js";
import { searchProgramTransformations } from "./program-transformation-search.js";
import type { StateTransitionCandidate } from "./state-transition-search.js";
import { searchStateTransitions } from "./state-transition-search.js";

/** A durable episode is created only after the exact selected construction passed its real command. */
export interface ProgramTransformationLearningEpisode {
  readonly schema: "scce.program_transformation_learning_episode.v1";
  readonly id: string;
  readonly episodeId: string;
  readonly programId: string;
  readonly programHydrationHash: string;
  readonly validation: {
    readonly command: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
    readonly buildCode: number | null;
    readonly testCode: number | null;
    readonly passed: true;
  };
  readonly ownerRequirementIds: readonly string[];
  readonly kind: "expression" | "state_transition";
  /** Source-neutral structural identity; callable/scenario IDs are excluded. */
  readonly candidateSignature: string;
  readonly candidate: ProgramTransformationCandidate | StateTransitionCandidate;
  readonly observedAt: number;
}

export interface ProgramTransformationLearningInput {
  readonly episodeId: EpisodeId;
  readonly program: ProgramGraph;
  readonly intent: ProgramConstructIntent;
  readonly buildTest: BuildTestResult;
  readonly now: number;
  readonly hasher: Hasher;
}

/**
 * Converts a selected typed construction into a learning episode. The proof
 * boundary is deliberately strict: no selected candidate, no hydration, no
 * exact test command, or any failed final result means no episode exists.
 */
export function learningEpisodesFromVerifiedProgram(input: ProgramTransformationLearningInput): ProgramTransformationLearningEpisode[] {
  if (!input.buildTest.passed || input.buildTest.build.code !== 0 || input.buildTest.test.code !== 0) return [];
  const hydration = input.program.hydration;
  if (!hydration || !input.program.test || !input.program.id) return [];
  const testReceipt = input.buildTest.testExecutionReceipt;
  if (!testReceipt || testReceipt.status !== "executed" || !sameTestCommand(testReceipt, input.program.test)) return [];
  const scalarRequirements = input.intent.behaviorRequirements ?? [];
  const statefulRequirements = input.intent.statefulBehaviorRequirements ?? [];
  const ownerRequirementIds = [...new Set([
    ...scalarRequirements.map(requirement => requirement.id),
    ...statefulRequirements.map(requirement => requirement.id)
  ])].sort(compareStrings);
  if (!ownerRequirementIds.length) return [];
  const hydrationHash = input.hasher.digestHex(canonicalStringify(hydration));
  const command = { command: input.program.test.command, args: [...input.program.test.args], cwd: input.program.test.cwd };
  const selectedScalar = selectedCandidates(input.intent.behaviorTransformationCandidates, input.intent.selectedBehaviorTransformationIds);
  const selectedStateful = selectedCandidates(input.intent.statefulBehaviorTransformationCandidates, input.intent.selectedStatefulBehaviorTransformationIds);
  // A passing command is insufficient evidence that an arbitrary candidate was
  // emitted. Reconstruct the bounded search from the owner obligations and
  // require the selected IDs to be canonical, fit-valid hypotheses. This also
  // keeps a forged intent from turning a lookup/table candidate into training.
  if (!selectedIdsMatch(input.intent.selectedBehaviorTransformationIds, selectedScalar)
    || !selectedIdsMatch(input.intent.selectedStatefulBehaviorTransformationIds, selectedStateful)
    || !selectedCandidatesAreCanonical(selectedScalar, scalarRequirements)
    || !selectedStatefulCandidatesAreCanonical(selectedStateful, statefulRequirements)
    || !programDeclaresSelectedCandidates(input.program, selectedScalar, selectedStateful)) return [];
  const episodes: ProgramTransformationLearningEpisode[] = [];
  for (const candidate of selectedScalar) {
    episodes.push(createEpisode({ input, hydrationHash, command, ownerRequirementIds, candidate, kind: "expression" }));
  }
  for (const candidate of selectedStateful) {
    episodes.push(createEpisode({ input, hydrationHash, command, ownerRequirementIds, candidate, kind: "state_transition" }));
  }
  return episodes;
}

/** Parse event payloads defensively. Event ledger data is untrusted input even though the adapter is durable. */
export function learningEpisodesFromEvents(events: readonly { typeId: string; payload: JsonValue }[]): ProgramTransformationLearningEpisode[] {
  const out: ProgramTransformationLearningEpisode[] = [];
  for (const event of events) {
    if (event.typeId !== "ProgramTransformationLearned" || !isRecord(event.payload)) continue;
    const payload = event.payload;
    if (payload.schema !== "scce.program_transformation_learning_episode.v1"
      || typeof payload.id !== "string"
      || typeof payload.episodeId !== "string"
      || typeof payload.programId !== "string"
      || typeof payload.programHydrationHash !== "string"
      || typeof payload.observedAt !== "number"
      || (payload.kind !== "expression" && payload.kind !== "state_transition")
      || typeof payload.candidateSignature !== "string"
      || !isRecord(payload.validation)
      || payload.validation.passed !== true
      || !isRecord(payload.validation.command)
      || typeof payload.validation.command.command !== "string"
      || !Array.isArray(payload.validation.command.args)
      || !payload.validation.command.args.every(item => typeof item === "string")
      || typeof payload.validation.command.cwd !== "string"
      || payload.validation.buildCode !== 0
      || payload.validation.testCode !== 0
      || !Array.isArray(payload.ownerRequirementIds)
      || payload.ownerRequirementIds.length === 0
      || !payload.ownerRequirementIds.every(item => typeof item === "string")
      || !isRecord(payload.candidate)) continue;
    const parsed = payload as unknown as ProgramTransformationLearningEpisode;
    if (candidateStructuralSignature(parsed.candidate, parsed.kind) !== parsed.candidateSignature) continue;
    const expectedId = `program.learning.${createHasher().digestHex(canonicalStringify({
      programId: parsed.programId,
      hydrationHash: parsed.programHydrationHash,
      candidateSignature: parsed.candidateSignature,
      ownerRequirementIds: [...parsed.ownerRequirementIds].sort(compareStrings)
    })).slice(0, 48)}`;
    if (parsed.id !== expectedId) continue;
    // The fresh search revalidates admissibility against current obligations;
    // this record supplies ordering evidence only.
    out.push(parsed);
  }
  return out;
}

/**
 * Re-ranks fresh hypotheses using only successful, exact-command episodes.
 * A prior can improve ordering, but it cannot make a candidate admissible:
 * current fit validation remains the authority.
 */
export function rankLearnedProgramTransformations<T extends ProgramTransformationCandidate | StateTransitionCandidate>(
  candidates: readonly T[],
  episodes: readonly ProgramTransformationLearningEpisode[],
  kind: "expression" | "state_transition"
): T[] {
  const successes = new Map<string, number>();
  // Event IDs are durable identities, but they are still untrusted input. A
  // replay or forged copy can carry a fresh event ID while describing the same
  // successful observation. Count the stable episode identity once.
  const seenEpisodes = new Set<string>();
  for (const episode of episodes) {
    if (episode.kind !== kind || episode.validation.passed !== true) continue;
    const episodeIdentity = canonicalStringify({
      programId: episode.programId,
      programHydrationHash: episode.programHydrationHash,
      validation: episode.validation,
      ownerRequirementIds: episode.ownerRequirementIds,
      kind: episode.kind,
      candidateSignature: episode.candidateSignature
    });
    if (seenEpisodes.has(episodeIdentity)) continue;
    seenEpisodes.add(episodeIdentity);
    const signature = candidateStructuralSignature(episode.candidate, kind);
    if (!signature || signature !== episode.candidateSignature) continue;
    successes.set(signature, (successes.get(signature) ?? 0) + 1);
  }
  return [...candidates].sort((left, right) =>
    (successes.get(candidateStructuralSignature(right, kind) ?? "") ?? 0) - (successes.get(candidateStructuralSignature(left, kind) ?? "") ?? 0)
    || (left as { score: number }).score - (right as { score: number }).score
    || compareStrings(left.id, right.id)
  );
}

function selectedCandidates<T extends { readonly id: string }>(candidates: readonly T[] | undefined, selectedIds: readonly string[] | undefined): T[] {
  if (!candidates?.length || !selectedIds?.length) return [];
  const selected = new Set(selectedIds);
  return candidates.filter(candidate => selected.has(candidate.id));
}

function selectedIdsMatch<T extends { readonly id: string }>(selectedIds: readonly string[] | undefined, selected: readonly T[]): boolean {
  const ids = selectedIds ?? [];
  return ids.length === selected.length && new Set(ids).size === ids.length;
}

function selectedCandidatesAreCanonical(
  selected: readonly ProgramTransformationCandidate[],
  requirements: readonly ProgramBehaviorRequirement[]
): boolean {
  if (!selected.length) return true;
  const searched = searchProgramTransformations(requirements);
  const byId = new Map(searched.candidates.map(candidate => [candidate.id, candidate]));
  return selected.every(candidate => {
    const canonical = byId.get(candidate.id);
    return Boolean(canonical)
      && canonicalStringify(candidate) === canonicalStringify(canonical)
      && candidate.fitMeanSquaredError <= 1e-12;
  });
}

function selectedStatefulCandidatesAreCanonical(
  selected: readonly StateTransitionCandidate[],
  requirements: readonly ProgramStatefulBehaviorRequirement[]
): boolean {
  if (!selected.length) return true;
  const searched = searchStateTransitions(requirements.map(requirement => ({
    id: requirement.id,
    invocations: requirement.invocations.map(invocation => ({ operationId: invocation.callableId, arguments: invocation.arguments })),
    expectedResult: requirement.expectedResult,
    verificationRole: requirement.verificationRole
  })));
  const byId = new Map(searched.candidates.map(candidate => [candidate.id, candidate]));
  return selected.every(candidate => {
    const canonical = byId.get(candidate.id);
    return Boolean(canonical)
      && canonicalStringify(candidate) === canonicalStringify(canonical)
      && candidate.fitError <= 0;
  });
}

function programDeclaresSelectedCandidates(
  program: ProgramGraph,
  scalar: readonly ProgramTransformationCandidate[],
  stateful: readonly StateTransitionCandidate[]
): boolean {
  const declaredScalar = selectedCandidateNodeIds(program, "program_transformation_candidate");
  const declaredStateful = selectedCandidateNodeIds(program, "program_state_transition_candidate");
  const scalarMatches = scalar.length > 0
    ? Boolean(declaredScalar && sameIds(declaredScalar, scalar.map(candidate => candidate.id)))
    : declaredScalar === undefined;
  const statefulMatches = stateful.length > 0
    ? Boolean(declaredStateful && sameIds(declaredStateful, stateful.map(candidate => candidate.id)))
    : declaredStateful === undefined;
  return scalarMatches && statefulMatches;
}

function selectedCandidateNodeIds(program: ProgramGraph, kind: string): string[] | undefined {
  const nodes = program.nodes.filter(node => node.kind === kind && isRecord(node.metadata) && node.metadata.selected === true);
  return nodes.length ? nodes.map(node => node.id).sort(compareStrings) : undefined;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return canonicalStringify([...left].sort(compareStrings)) === canonicalStringify([...right].sort(compareStrings));
}

function createEpisode(input: {
  input: ProgramTransformationLearningInput;
  hydrationHash: string;
  command: { command: string; args: string[]; cwd: string };
  ownerRequirementIds: readonly string[];
  candidate: ProgramTransformationCandidate | StateTransitionCandidate;
  kind: "expression" | "state_transition";
}): ProgramTransformationLearningEpisode {
  const { input: source, hydrationHash, command, ownerRequirementIds, candidate, kind } = input;
  const candidateSignature = candidateStructuralSignature(candidate, kind);
  if (!candidateSignature) throw new Error("selected program transformation has no structural identity");
  return {
    schema: "scce.program_transformation_learning_episode.v1",
    id: `program.learning.${source.hasher.digestHex(canonicalStringify({ programId: source.program.id, hydrationHash, candidateSignature, ownerRequirementIds })).slice(0, 48)}`,
    episodeId: String(source.episodeId),
    programId: String(source.program.id),
    programHydrationHash: hydrationHash,
    validation: { command, buildCode: source.buildTest.build.code, testCode: source.buildTest.test.code, passed: true },
    ownerRequirementIds,
    kind,
    candidateSignature,
    candidate,
    observedAt: source.now
  };
}

export function candidateStructuralSignature(
  candidate: ProgramTransformationCandidate | StateTransitionCandidate,
  kind: "expression" | "state_transition"
): string | undefined {
  if (kind === "expression") {
    if (!("producedIr" in candidate)
      || !("operator" in candidate)
      || typeof candidate.operator !== "string"
      || !candidate.producedIr
      || !Array.isArray(candidate.preconditions)) return undefined;
    return `expression:${canonicalStringify({
      operator: candidate.operator,
      producedIr: candidate.producedIr,
      preconditions: candidate.preconditions
    })}`;
  }
  if (!("transitionIr" in candidate)
    || !Array.isArray(candidate.transitionIr)
    || !Array.isArray(candidate.preconditions)) return undefined;
  // Operation IDs name the owner's current API. The learned construction is
  // the role/argument topology, so normalize those names out of the signature.
  const instructions = candidate.transitionIr.map(instruction => {
    if (instruction.kind === "associate") return { kind: instruction.kind, keyArgumentIndex: instruction.keyArgumentIndex, valueArgumentIndex: instruction.valueArgumentIndex };
    if (instruction.kind === "lookup" || instruction.kind === "dissociate") return { kind: instruction.kind, keyArgumentIndex: instruction.keyArgumentIndex };
    return { kind: instruction.kind };
  }).sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  return `state_transition:${canonicalStringify({
    instructions,
    absentValue: candidate.absentValue,
    preconditions: candidate.preconditions
  })}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameTestCommand(
  receipt: { readonly command: string; readonly args: readonly string[]; readonly cwd: string },
  expected: { readonly command: string; readonly args: readonly string[]; readonly cwd: string }
): boolean {
  return receipt.command === expected.command
    && receipt.cwd === expected.cwd
    && receipt.args.length === expected.args.length
    && receipt.args.every((arg, index) => arg === expected.args[index]);
}
