export const EXTENSION_PROTOCOL_SCHEMA = "yopp.vscode.message.v1" as const;
export const TASK_TIMELINE_SCHEMA = "yopp.vscode.task_timeline.v1" as const;

export type ExtensionMessage =
  | {
      schema: typeof EXTENSION_PROTOCOL_SCHEMA;
      kind: "readiness";
      ready: boolean;
      serverUrl: string;
      observedAt: number;
    }
  | {
      schema: typeof EXTENSION_PROTOCOL_SCHEMA;
      kind: "task";
      taskId: string;
      state: ExtensionTaskState;
      observedAt: number;
    }
  | {
      schema: typeof EXTENSION_PROTOCOL_SCHEMA;
      kind: "result";
      taskId: string;
      endpoint: YoppEndpoint;
      payload: unknown;
      observedAt: number;
    };

export type ExtensionTaskState = "pending_approval" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export type YoppEndpoint =
  | "ready"
  | "workspace.initialize"
  | "workspace.ingest"
  | "workspace.ask"
  | "workspace.patch"
  | "project.summary"
  | "workspace.status";

export interface ReadyResponse {
  ok: boolean;
  postgres: unknown;
  serverUrl: string;
  manifest: number;
}

export interface WorkspaceIngestResponse {
  schema: "scce.workspace.ingest.v1";
  importBatchId: string;
  ingested: number;
  unchanged: number;
  changed: number;
  missing: number;
  failed: number;
  unsupported: number;
  workspace: unknown;
  project: unknown;
}

export interface WorkspaceAnswerResponse {
  schema: "scce.workspace.answer.v1";
  question: string;
  answer: string;
  confidence: number;
  sourceRefs: unknown[];
}

export interface ProjectSummaryResponse {
  schema: "scce.project.summary.v1";
  workspace: unknown;
  summary: unknown;
}

export function parseExtensionMessage(value: unknown): ExtensionMessage {
  const input = record(value, "extension message");
  literal(input.schema, EXTENSION_PROTOCOL_SCHEMA, "extension message schema");
  const observedAt = finiteNumber(input.observedAt, "observedAt");
  if (input.kind === "readiness") {
    return {
      schema: EXTENSION_PROTOCOL_SCHEMA,
      kind: "readiness",
      ready: boolean(input.ready, "ready"),
      serverUrl: nonEmptyString(input.serverUrl, "serverUrl"),
      observedAt
    };
  }
  if (input.kind === "task") {
    return {
      schema: EXTENSION_PROTOCOL_SCHEMA,
      kind: "task",
      taskId: nonEmptyString(input.taskId, "taskId"),
      state: taskState(input.state),
      observedAt
    };
  }
  if (input.kind === "result") {
    return {
      schema: EXTENSION_PROTOCOL_SCHEMA,
      kind: "result",
      taskId: nonEmptyString(input.taskId, "taskId"),
      endpoint: endpoint(input.endpoint),
      payload: input.payload,
      observedAt
    };
  }
  throw new Error("unsupported extension message kind");
}

export function parseReadyResponse(value: unknown): ReadyResponse {
  const input = record(value, "readiness response");
  return {
    ok: boolean(input.ok, "ok"),
    postgres: input.postgres,
    serverUrl: nonEmptyString(input.serverUrl, "serverUrl"),
    manifest: finiteNumber(input.manifest, "manifest")
  };
}

export function parseWorkspaceIngestResponse(value: unknown): WorkspaceIngestResponse {
  const input = record(value, "workspace ingest response");
  literal(input.schema, "scce.workspace.ingest.v1", "workspace ingest schema");
  return {
    schema: "scce.workspace.ingest.v1",
    importBatchId: nonEmptyString(input.importBatchId, "importBatchId"),
    ingested: nonNegativeNumber(input.ingested, "ingested"),
    unchanged: nonNegativeNumber(input.unchanged, "unchanged"),
    changed: nonNegativeNumber(input.changed, "changed"),
    missing: nonNegativeNumber(input.missing, "missing"),
    failed: nonNegativeNumber(input.failed, "failed"),
    unsupported: nonNegativeNumber(input.unsupported, "unsupported"),
    workspace: input.workspace,
    project: input.project
  };
}

export function parseWorkspaceAnswerResponse(value: unknown): WorkspaceAnswerResponse {
  const input = record(value, "workspace answer response");
  literal(input.schema, "scce.workspace.answer.v1", "workspace answer schema");
  return {
    schema: "scce.workspace.answer.v1",
    question: nonEmptyString(input.question, "question"),
    answer: nonEmptyString(input.answer, "answer"),
    confidence: finiteNumber(input.confidence, "confidence"),
    sourceRefs: array(input.sourceRefs, "sourceRefs")
  };
}

export function parseProjectSummaryResponse(value: unknown): ProjectSummaryResponse {
  const input = record(value, "project summary response");
  literal(input.schema, "scce.project.summary.v1", "project summary schema");
  return { schema: "scce.project.summary.v1", workspace: input.workspace, summary: input.summary };
}

function endpoint(value: unknown): YoppEndpoint {
  if (value === "ready" || value === "workspace.initialize" || value === "workspace.ingest" || value === "workspace.ask" || value === "workspace.patch" || value === "project.summary" || value === "workspace.status") return value;
  throw new Error("unsupported Yopp endpoint");
}

function taskState(value: unknown): ExtensionTaskState {
  if (value === "pending_approval" || value === "running" || value === "succeeded" || value === "failed" || value === "interrupted" || value === "cancelled") return value;
  throw new Error("unsupported extension task state");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must not be negative`);
  return number;
}
