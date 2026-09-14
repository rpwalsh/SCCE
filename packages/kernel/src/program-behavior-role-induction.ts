// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export interface ProgramBehaviorRoleObservation {
  readonly id: string;
  readonly testFileId: string;
  readonly targetId: string;
  readonly subjectArgumentCount: number;
  readonly contextDepth: number;
  readonly contextArgumentCount: number;
  readonly evidenceSpanIds: readonly string[];
}

export interface ProgramBehaviorRoleConstruction {
  readonly id: string;
  readonly kindId: "scce.program.behavior_role_construction.v1";
  /** Structure is learned; the behavioral meaning stays unassigned until outcome evidence exists. */
  readonly semanticStatus: "structural_unassigned";
  readonly signature: string;
  readonly subjectRoleId: string;
  readonly subjectArgumentRoleIds: readonly string[];
  readonly contextCallRoleIds: readonly string[];
  readonly contextArgumentRoleIds: readonly string[];
  readonly memberObservationIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly support: {
    readonly observations: number;
    readonly distinctTestFiles: number;
    readonly distinctTargets: number;
  };
  readonly descriptionLength: {
    readonly uncompressedSymbols: number;
    readonly constructionSymbols: number;
    readonly savingsSymbols: number;
  };
}

export interface InduceProgramBehaviorRoleConstructionsInput {
  readonly observations: readonly ProgramBehaviorRoleObservation[];
  readonly minimumObservations?: number;
  readonly minimumTestFiles?: number;
  readonly minimumTargets?: number;
}

/**
 * Compresses recurring test-call topology into opaque roles. It deliberately
 * ignores callee names and literal values; later execution outcomes must teach
 * whether any context role means equality, error, ordering, or something else.
 */
export function induceProgramBehaviorRoleConstructions(
  input: InduceProgramBehaviorRoleConstructionsInput,
  hasher: Hasher = createHasher()
): ProgramBehaviorRoleConstruction[] {
  const minimumObservations = positiveInteger(input.minimumObservations ?? 3, "minimumObservations");
  const minimumTestFiles = positiveInteger(input.minimumTestFiles ?? 2, "minimumTestFiles");
  const minimumTargets = positiveInteger(input.minimumTargets ?? 2, "minimumTargets");
  const groups = new Map<string, ProgramBehaviorRoleObservation[]>();
  for (const observation of input.observations) {
    validateObservation(observation);
    const signature = topologySignature(observation);
    groups.set(signature, [...(groups.get(signature) ?? []), observation]);
  }
  const constructions: ProgramBehaviorRoleConstruction[] = [];
  for (const [signature, members] of groups) {
    const uniqueMembers = uniqueById(members);
    const testFiles = new Set(uniqueMembers.map(member => member.testFileId));
    const targets = new Set(uniqueMembers.map(member => member.targetId));
    if (uniqueMembers.length < minimumObservations || testFiles.size < minimumTestFiles || targets.size < minimumTargets) continue;
    const first = uniqueMembers[0]!;
    const patternSymbols = 1 + first.subjectArgumentCount + first.contextDepth + first.contextArgumentCount;
    const uncompressedSymbols = uniqueMembers.length * (patternSymbols + 1);
    const constructionSymbols = patternSymbols + uniqueMembers.length;
    const savingsSymbols = uncompressedSymbols - constructionSymbols;
    if (savingsSymbols <= 0) continue;
    const roleId = (role: string, index?: number) => `program.role.${hasher.digestHex(canonicalStringify({ signature, role, index })).slice(0, 32)}`;
    constructions.push({
      id: `program.behavior_construction.${hasher.digestHex(signature).slice(0, 32)}`,
      kindId: "scce.program.behavior_role_construction.v1",
      semanticStatus: "structural_unassigned",
      signature,
      subjectRoleId: roleId("subject"),
      subjectArgumentRoleIds: Array.from({ length: first.subjectArgumentCount }, (_, index) => roleId("subject_argument", index)),
      contextCallRoleIds: Array.from({ length: first.contextDepth }, (_, index) => roleId("context_call", index)),
      contextArgumentRoleIds: Array.from({ length: first.contextArgumentCount }, (_, index) => roleId("context_argument", index)),
      memberObservationIds: uniqueMembers.map(member => member.id).sort(compareCanonical),
      evidenceSpanIds: [...new Set(uniqueMembers.flatMap(member => member.evidenceSpanIds))].sort(compareCanonical),
      support: {
        observations: uniqueMembers.length,
        distinctTestFiles: testFiles.size,
        distinctTargets: targets.size
      },
      descriptionLength: { uncompressedSymbols, constructionSymbols, savingsSymbols }
    });
  }
  return constructions.sort((left, right) =>
    right.descriptionLength.savingsSymbols - left.descriptionLength.savingsSymbols
    || right.support.observations - left.support.observations
    || compareCanonical(left.id, right.id));
}

function topologySignature(observation: ProgramBehaviorRoleObservation): string {
  return canonicalStringify({
    subjectArgumentCount: observation.subjectArgumentCount,
    contextDepth: observation.contextDepth,
    contextArgumentCount: observation.contextArgumentCount
  });
}

function validateObservation(observation: ProgramBehaviorRoleObservation): void {
  for (const [label, value] of Object.entries({
    id: observation.id,
    testFileId: observation.testFileId,
    targetId: observation.targetId
  })) if (!value || value !== value.trim()) throw new Error(`program behavior observation ${label} is invalid`);
  for (const [label, value] of Object.entries({
    subjectArgumentCount: observation.subjectArgumentCount,
    contextDepth: observation.contextDepth,
    contextArgumentCount: observation.contextArgumentCount
  })) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`program behavior observation ${label} is invalid`);
  if (new Set(observation.evidenceSpanIds).size !== observation.evidenceSpanIds.length
    || observation.evidenceSpanIds.some(id => !id || id !== id.trim())) {
    throw new Error("program behavior observation evidence is invalid");
  }
}

function uniqueById(observations: readonly ProgramBehaviorRoleObservation[]): ProgramBehaviorRoleObservation[] {
  const byId = new Map<string, ProgramBehaviorRoleObservation>();
  for (const observation of observations) byId.set(observation.id, observation);
  return [...byId.values()].sort((left, right) => compareCanonical(left.id, right.id));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
