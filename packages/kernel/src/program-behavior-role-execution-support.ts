// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";
import type { WorkspaceTaskConstraintGraph } from "./workspace-task-constraint-graph.js";

export const PROGRAM_BEHAVIOR_ROLE_EXECUTION_SUPPORT_SCHEMA =
  "scce.program.behavior_role_execution_support.v1" as const;

export type ProgramBehaviorRoleExecutionSupportStatus = "execution_supported_unassigned";

export interface BehaviorRoleExecutionGraphInput {
  readonly schema: "scce.workspace.task_constraint_graph.v1";
  readonly id: string;
  readonly workspaceRevision: {
    readonly workspaceId: string;
    readonly revisionId: string;
    readonly revisionHash: string;
  };
  readonly analyzerRevision: {
    readonly analyzerId: string;
    readonly analyzerVersion: string;
    readonly semanticRevisionHash: string;
  };
  /** Semantic command identities and check roles admitted by the exact task graph. */
  readonly validationCommandBindings: readonly {
    readonly commandId: string;
    readonly checkId: "compiler" | "typecheck" | "tests";
  }[];
  readonly constructions: readonly BehaviorRoleConstructionInput[];
}

export interface BehaviorRoleConstructionInput {
  readonly id: string;
  readonly kindId: "scce.program.behavior_role_construction.v1";
  readonly memberObservationIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
}

export interface BehaviorRoleValidationCommandOutcome {
  /** The server-declared validation check, never inferred from executable text. */
  readonly checkId: "compiler" | "typecheck" | "tests";
  readonly commandIndex: number;
  readonly commandEvidenceHash: string;
  readonly executed: boolean;
  readonly passed: boolean;
}

export interface BehaviorRoleExecutionReceiptInput {
  readonly planHash: string;
  readonly transactionReceiptHash: string;
  readonly validationEvidenceHash: string;
  readonly commandOutcomes: readonly BehaviorRoleValidationCommandOutcome[];
}

export interface ProgramBehaviorRoleExecutionSupport {
  readonly schema: typeof PROGRAM_BEHAVIOR_ROLE_EXECUTION_SUPPORT_SCHEMA;
  readonly id: string;
  readonly semanticStatus: ProgramBehaviorRoleExecutionSupportStatus;
  readonly constructionId: string;
  readonly memberObservationIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly graphId: string;
  readonly workspaceRevision: BehaviorRoleExecutionGraphInput["workspaceRevision"];
  readonly analyzerRevision: BehaviorRoleExecutionGraphInput["analyzerRevision"];
  readonly planHash: string;
  readonly transactionReceiptHash: string;
  readonly validationEvidenceHash: string;
  readonly testExecution: {
    readonly commandIndex: number;
    readonly commandEvidenceHash: string;
    readonly graphCommandIds: readonly string[];
  };
}

/**
 * Projects a graph-bound, successful test execution onto structural behavior
 * roles. It records execution support only; it does not assign meaning to a
 * test assertion or claim that a role means equality, ordering, errors, etc.
 */
export function projectProgramBehaviorRoleExecutionSupport(
  input: {
    readonly graph: BehaviorRoleExecutionGraphInput;
    readonly receipt: BehaviorRoleExecutionReceiptInput;
  },
  hasher: Hasher = createHasher()
): ProgramBehaviorRoleExecutionSupport[] {
  verifyBehaviorRoleExecutionGraphInput(input.graph);
  validateReceipt(input.receipt, input.graph);

  const testOutcome = input.receipt.commandOutcomes.find(outcome => outcome.checkId === "tests")!;
  const graphTestCommandIds = input.graph.validationCommandBindings
    .filter(binding => binding.checkId === "tests")
    .map(binding => binding.commandId)
    .sort(compareCanonical);
  const testExecution = {
    commandIndex: testOutcome.commandIndex,
    commandEvidenceHash: testOutcome.commandEvidenceHash,
    graphCommandIds: graphTestCommandIds
  };

  return deepFreeze(input.graph.constructions
    .map(construction => {
      const memberObservationIds = [...construction.memberObservationIds].sort(compareCanonical);
      const identity = {
        graphId: input.graph.id,
        constructionId: construction.id,
        memberObservationIds,
        evidenceSpanIds: [...construction.evidenceSpanIds].sort(compareCanonical),
        planHash: input.receipt.planHash,
        transactionReceiptHash: input.receipt.transactionReceiptHash,
        validationEvidenceHash: input.receipt.validationEvidenceHash,
        testExecution
      };
      return {
        schema: PROGRAM_BEHAVIOR_ROLE_EXECUTION_SUPPORT_SCHEMA,
        id: `program.behavior_execution_support.${hasher.digestHex(canonicalStringify(identity)).slice(0, 40)}`,
        semanticStatus: "execution_supported_unassigned" as const,
        constructionId: construction.id,
        memberObservationIds,
        evidenceSpanIds: [...construction.evidenceSpanIds].sort(compareCanonical),
        graphId: input.graph.id,
        workspaceRevision: { ...input.graph.workspaceRevision },
        analyzerRevision: { ...input.graph.analyzerRevision },
        planHash: input.receipt.planHash,
        transactionReceiptHash: input.receipt.transactionReceiptHash,
        validationEvidenceHash: input.receipt.validationEvidenceHash,
        testExecution
      };
    })
    .sort((left, right) => compareCanonical(left.id, right.id)));
}

export function verifyBehaviorRoleExecutionGraphInput(graph: BehaviorRoleExecutionGraphInput): void {
  if (graph.schema !== "scce.workspace.task_constraint_graph.v1") {
    throw new Error("behavior execution support requires a workspace task constraint graph");
  }
  requiredId(graph.id, "graph.id");
  requiredId(graph.workspaceRevision.workspaceId, "graph.workspaceRevision.workspaceId");
  requiredId(graph.workspaceRevision.revisionId, "graph.workspaceRevision.revisionId");
  requiredHash(graph.workspaceRevision.revisionHash, "graph.workspaceRevision.revisionHash");
  requiredId(graph.analyzerRevision.analyzerId, "graph.analyzerRevision.analyzerId");
  requiredId(graph.analyzerRevision.analyzerVersion, "graph.analyzerRevision.analyzerVersion");
  requiredHash(graph.analyzerRevision.semanticRevisionHash, "graph.analyzerRevision.semanticRevisionHash");
  const validationBindingKeys = graph.validationCommandBindings.map(binding => `${binding.checkId}\u0000${binding.commandId}`);
  uniqueIds(validationBindingKeys, "graph.validationCommandBindings");
  for (const binding of graph.validationCommandBindings) {
    requiredId(binding.commandId, "graph validation command binding commandId");
    validateCheckId(binding.checkId);
  }
  uniqueIds(graph.constructions.map(construction => construction.id), "graph construction ids");
  for (const construction of graph.constructions) {
    requiredId(construction.id, "construction.id");
    if (construction.kindId !== "scce.program.behavior_role_construction.v1") {
      throw new Error(`unsupported behavior construction kind: ${construction.kindId}`);
    }
    if (construction.memberObservationIds.length === 0) {
      throw new Error(`behavior construction has no member observations: ${construction.id}`);
    }
    uniqueIds(construction.memberObservationIds, `construction ${construction.id} member observations`);
    if (construction.evidenceSpanIds.length === 0) throw new Error(`behavior construction has no evidence spans: ${construction.id}`);
    uniqueIds(construction.evidenceSpanIds, `construction ${construction.id} evidence spans`);
  }
}

function validateReceipt(receipt: BehaviorRoleExecutionReceiptInput, graph: BehaviorRoleExecutionGraphInput): void {
  requiredHash(receipt.planHash, "receipt.planHash");
  requiredHash(receipt.transactionReceiptHash, "receipt.transactionReceiptHash");
  requiredHash(receipt.validationEvidenceHash, "receipt.validationEvidenceHash");
  if (receipt.commandOutcomes.length === 0) throw new Error("behavior execution support requires validation command outcomes");
  uniqueIds(receipt.commandOutcomes.map(outcome => `${outcome.checkId}\u0000${outcome.commandIndex}`), "validation command outcome identities");
  for (const outcome of receipt.commandOutcomes) {
    validateCheckId(outcome.checkId);
    if (!Number.isSafeInteger(outcome.commandIndex) || outcome.commandIndex < 0) throw new Error("validation command index is invalid");
    requiredHash(outcome.commandEvidenceHash, "validation command evidence hash");
    if (!outcome.executed) throw new Error(`validation command did not execute: ${outcome.commandIndex}`);
    if (!outcome.passed) throw new Error(`validation command did not pass: ${outcome.commandIndex}`);
  }
  if (!receipt.commandOutcomes.some(outcome => outcome.checkId === "tests")) {
    throw new Error("behavior execution support requires a passing tests validation command");
  }
}

/** Extracts only content-addressed behavior and command identities from the exact task graph. */
export function behaviorRoleExecutionGraphInputFromTaskConstraintGraph(
  graph: WorkspaceTaskConstraintGraph
): BehaviorRoleExecutionGraphInput {
  const constructions = graph.nodes
    .filter(node => node.kindId === "scce.program.behavior_role_construction.v1")
    .map(node => {
      const metadata = jsonRecord(node.metadata, `behavior construction ${node.id}`);
      return {
        id: requiredIdValue(metadata.id, `behavior construction ${node.id} id`),
        kindId: "scce.program.behavior_role_construction.v1" as const,
        memberObservationIds: stringArray(metadata.memberObservationIds, `behavior construction ${node.id} observations`),
        evidenceSpanIds: [...node.evidenceSpanIds]
      };
    });
  const commandNodeIds = new Set(graph.admissibleValidationCommandNodeIds);
  const validationCommandBindings = graph.nodes
    .filter(node => commandNodeIds.has(node.id))
    .map(node => {
      const metadata = jsonRecord(node.metadata, `validation command ${node.id}`);
      return {
        commandId: requiredIdValue(metadata.commandId, `validation command ${node.id} commandId`),
        checkId: validationCheckId(metadata.checkId, `validation command ${node.id} checkId`)
      };
    });
  const input: BehaviorRoleExecutionGraphInput = {
    schema: graph.schema,
    id: graph.id,
    workspaceRevision: { ...graph.workspaceRevision },
    analyzerRevision: {
      analyzerId: graph.analyzerRevision.analyzerId,
      analyzerVersion: graph.analyzerRevision.analyzerVersion,
      semanticRevisionHash: graph.analyzerRevision.semanticRevisionHash
    },
    validationCommandBindings,
    constructions
  };
  verifyBehaviorRoleExecutionGraphInput(input);
  return deepFreeze(input);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} metadata is invalid`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} are invalid`);
  const result = value as string[];
  uniqueIds(result, label);
  return [...result].sort(compareCanonical);
}

function requiredIdValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  requiredId(value, label);
  return value;
}

function validationCheckId(value: unknown, label: string): "compiler" | "typecheck" | "tests" {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  validateCheckId(value);
  return value as "compiler" | "typecheck" | "tests";
}

function validateCheckId(value: string): void {
  if (value !== "compiler" && value !== "typecheck" && value !== "tests") throw new Error(`unsupported validation check: ${value}`);
}

function requiredId(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
}

function requiredHash(value: string | undefined, label: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 content hash`);
}

function uniqueIds(values: readonly string[], label: string): void {
  for (const value of values) requiredId(value, label);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
