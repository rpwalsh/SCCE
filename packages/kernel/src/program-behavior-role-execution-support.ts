import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

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
  readonly graphId: string;
  readonly workspaceRevision: BehaviorRoleExecutionGraphInput["workspaceRevision"];
  readonly analyzerRevision: BehaviorRoleExecutionGraphInput["analyzerRevision"];
  readonly planHash: string;
  readonly transactionReceiptHash: string;
  readonly validationEvidenceHash: string;
  readonly testCommandBindings: readonly {
    readonly commandId: string;
    readonly commandIndex: number;
    readonly commandEvidenceHash: string;
  }[];
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
  validateGraph(input.graph);
  validateReceipt(input.receipt, input.graph);

  const testOutcome = input.receipt.commandOutcomes.find(outcome => outcome.checkId === "tests")!;
  const testCommandBindings = input.graph.validationCommandBindings
    .filter(binding => binding.checkId === "tests")
    .map(binding => ({
      commandId: binding.commandId,
      commandIndex: testOutcome.commandIndex,
      commandEvidenceHash: testOutcome.commandEvidenceHash
    }))
    .sort((left, right) => compareCanonical(left.commandId, right.commandId));

  return input.graph.constructions
    .map(construction => {
      const memberObservationIds = [...construction.memberObservationIds].sort(compareCanonical);
      const identity = {
        graphId: input.graph.id,
        constructionId: construction.id,
        memberObservationIds,
        planHash: input.receipt.planHash,
        transactionReceiptHash: input.receipt.transactionReceiptHash,
        validationEvidenceHash: input.receipt.validationEvidenceHash,
        testCommandBindings
      };
      return {
        schema: PROGRAM_BEHAVIOR_ROLE_EXECUTION_SUPPORT_SCHEMA,
        id: `program.behavior_execution_support.${hasher.digestHex(canonicalStringify(identity)).slice(0, 40)}`,
        semanticStatus: "execution_supported_unassigned" as const,
        constructionId: construction.id,
        memberObservationIds,
        graphId: input.graph.id,
        workspaceRevision: { ...input.graph.workspaceRevision },
        analyzerRevision: { ...input.graph.analyzerRevision },
        planHash: input.receipt.planHash,
        transactionReceiptHash: input.receipt.transactionReceiptHash,
        validationEvidenceHash: input.receipt.validationEvidenceHash,
        testCommandBindings
      };
    })
    .sort((left, right) => compareCanonical(left.id, right.id));
}

function validateGraph(graph: BehaviorRoleExecutionGraphInput): void {
  if (graph.schema !== "scce.workspace.task_constraint_graph.v1") {
    throw new Error("behavior execution support requires a workspace task constraint graph");
  }
  requiredId(graph.id, "graph.id");
  requiredIdentity(graph.workspaceRevision, "graph.workspaceRevision");
  requiredIdentity(graph.analyzerRevision, "graph.analyzerRevision");
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
  }
}

function validateReceipt(receipt: BehaviorRoleExecutionReceiptInput, graph: BehaviorRoleExecutionGraphInput): void {
  requiredId(receipt.planHash, "receipt.planHash");
  requiredId(receipt.transactionReceiptHash, "receipt.transactionReceiptHash");
  requiredId(receipt.validationEvidenceHash, "receipt.validationEvidenceHash");
  if (receipt.commandOutcomes.length === 0) throw new Error("behavior execution support requires validation command outcomes");
  uniqueIds(receipt.commandOutcomes.map(outcome => `${outcome.checkId}\u0000${outcome.commandIndex}`), "validation command outcome identities");
  for (const outcome of receipt.commandOutcomes) {
    validateCheckId(outcome.checkId);
    if (!Number.isSafeInteger(outcome.commandIndex) || outcome.commandIndex < 0) throw new Error("validation command index is invalid");
    requiredId(outcome.commandEvidenceHash, "validation command evidence hash");
    if (!outcome.executed) throw new Error(`validation command did not execute: ${outcome.commandIndex}`);
    if (!outcome.passed) throw new Error(`validation command did not pass: ${outcome.commandIndex}`);
  }
  if (!receipt.commandOutcomes.some(outcome => outcome.checkId === "tests")) {
    throw new Error("behavior execution support requires a passing tests validation command");
  }
  if (!graph.validationCommandBindings.some(binding => binding.checkId === "tests")) {
    throw new Error("behavior execution support requires a graph-bound tests validation command");
  }
}

function validateCheckId(value: string): void {
  if (value !== "compiler" && value !== "typecheck" && value !== "tests") throw new Error(`unsupported validation check: ${value}`);
}

function requiredIdentity(value: { readonly workspaceId?: string; readonly revisionId?: string; readonly revisionHash?: string; readonly analyzerId?: string; readonly analyzerVersion?: string; readonly semanticRevisionHash?: string }, label: string): void {
  for (const [key, item] of Object.entries(value)) requiredId(item, `${label}.${key}`);
}

function requiredId(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
}

function uniqueIds(values: readonly string[], label: string): void {
  for (const value of values) requiredId(value, label);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
