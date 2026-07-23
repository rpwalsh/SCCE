import { normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken, type YoppConnectionConfig } from "./config.js";
import {
  parseProjectSummaryResponse,
  parseReadyResponse,
  parseWorkspaceAnswerResponse,
  parseWorkspaceIngestResponse,
  type ProjectSummaryResponse,
  type ReadyResponse,
  type WorkspaceAnswerResponse,
  type WorkspaceIngestResponse
} from "./protocol.js";
import {
  DEFAULT_PATCH_VALIDATION_CHECKS,
  DEFAULT_PATCH_VALIDATION_POLICY_ID,
  WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
  WORKSPACE_PATCH_REQUEST_SCHEMA,
  parseSessionApproval,
  parseWorkspaceCodingPatchPlanResult,
  parseWorkspacePatchAttempt,
  parseWorkspaceStatus,
  type ReviewedPatchPlan,
  type WorkspaceCodingPatchPlanResult,
  type WorkspaceCodingPatchPlanRequest,
  type WorkspacePatchAttempt,
  type WorkspaceStatusResponse
} from "./patch-protocol.js";
import { verifyAppliedPatchMatchesPlan } from "./patch-integrity.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpTransport = (input: string, init: RequestInit) => Promise<HttpResponseLike>;

export class YoppHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "YoppHttpError";
  }
}

export class YoppClient {
  private readonly config: YoppConnectionConfig;

  constructor(config: YoppConnectionConfig, private readonly transport: HttpTransport = fetch) {
    this.config = {
      serverUrl: normalizeLocalServerUrl(config.serverUrl),
      token: normalizeToken(config.token),
      timeoutMs: normalizeRequestTimeout(config.timeoutMs)
    };
  }

  ready(): Promise<ReadyResponse> {
    return this.request("GET", "/api/ready", undefined, parseReadyResponse);
  }

  workspaceInitialize(path: string): Promise<unknown> {
    return this.request("POST", "/api/workspace/init", { path: requireWorkspacePath(path) }, identity);
  }

  workspaceIngest(path: string): Promise<WorkspaceIngestResponse> {
    return this.request("POST", "/api/workspace/ingest", { path: requireWorkspacePath(path) }, parseWorkspaceIngestResponse);
  }

  workspaceAsk(path: string, question: string): Promise<WorkspaceAnswerResponse> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error("workspace question must not be empty");
    return this.request("POST", "/api/workspace/ask", { path: requireWorkspacePath(path), question: normalizedQuestion }, parseWorkspaceAnswerResponse);
  }

  projectSummary(path: string): Promise<ProjectSummaryResponse> {
    return this.request("GET", `/api/project/summary?path=${encodeURIComponent(requireWorkspacePath(path))}`, undefined, parseProjectSummaryResponse);
  }

  workspaceStatus(): Promise<WorkspaceStatusResponse> {
    return this.request("GET", "/api/workspace/sources", undefined, parseWorkspaceStatus);
  }

  workspaceCodingPatchPlan(input: {
    workspaceId: string;
    expectedWorkspaceUpdatedAt: number;
    requestId: string;
    requestText: string;
    requestedPaths: readonly string[];
    diagnosticCodes: readonly number[];
  }): Promise<WorkspaceCodingPatchPlanResult> {
    const request = codingPatchPlanRequest(input);
    return this.request("POST", "/api/workspace/patch/plan/request", request, value => parseWorkspaceCodingPatchPlanResult(value, request));
  }

  workspacePatch(workspaceId: string, plan: ReviewedPatchPlan): Promise<WorkspacePatchAttempt> {
    return this.request("POST", "/api/workspace/patch", {
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: requireNonEmpty(workspaceId, "workspace id"),
      plan,
      validationPolicyId: DEFAULT_PATCH_VALIDATION_POLICY_ID
    }, value => {
      const attempt = parseWorkspacePatchAttempt(value);
      return "pendingApproval" in attempt ? attempt : verifyAppliedPatchMatchesPlan(attempt, plan);
    });
  }

  approveWorkspacePatch(planId: string): Promise<{ approved: { planId: string; capabilityId: string } }> {
    return this.request("POST", "/api/session/approve", { planId: requireNonEmpty(planId, "approval plan id") }, parseSessionApproval);
  }

  private async request<T>(method: "GET" | "POST", route: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    try {
      const response = await this.transport(`${this.config.serverUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Yopp response exceeded the extension size limit");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Yopp response exceeded the extension size limit");
      const payload = parseJson(text);
      if (!response.ok) throw new YoppHttpError(response.status, errorMessage(payload, response.status));
      return parse(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireWorkspacePath(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("a local workspace path is required");
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function codingPatchPlanRequest(input: {
  workspaceId: string;
  expectedWorkspaceUpdatedAt: number;
  requestId: string;
  requestText: string;
  requestedPaths: readonly string[];
  diagnosticCodes: readonly number[];
}): WorkspaceCodingPatchPlanRequest {
  const workspaceId = requireBoundedId(input.workspaceId, "workspace id");
  const requestId = requireBoundedId(input.requestId, "coding request id");
  if (!Number.isSafeInteger(input.expectedWorkspaceUpdatedAt) || input.expectedWorkspaceUpdatedAt < 0) {
    throw new Error("expected workspace updatedAt must be a non-negative safe integer");
  }
  const requestText = input.requestText.trim();
  if (!requestText || requestText.includes("\0")) throw new Error("coding request text must be non-empty UTF-8 text without NUL bytes");
  if (Buffer.byteLength(requestText, "utf8") > 20_000) throw new Error("coding request text exceeds 20000 UTF-8 bytes");
  if (input.requestedPaths.length < 1 || input.requestedPaths.length > 256) throw new Error("coding request scope must contain 1 through 256 paths");
  const requestedPaths = [...input.requestedPaths].map((path, index) => requireWorkspaceRelativePath(path, `coding request path ${index}`));
  if (new Set(requestedPaths).size !== requestedPaths.length) throw new Error("coding request scope contains duplicate paths");
  requestedPaths.sort(compareCanonical);
  if (input.diagnosticCodes.length < 1 || input.diagnosticCodes.length > 128) throw new Error("coding request must select 1 through 128 diagnostic codes");
  const diagnosticCodes = [...input.diagnosticCodes].map((code, index) => {
    if (!Number.isSafeInteger(code) || code <= 0) throw new Error(`coding request diagnostic code ${index} must be a positive safe integer`);
    return code;
  });
  if (new Set(diagnosticCodes).size !== diagnosticCodes.length) throw new Error("coding request diagnostic codes contain duplicates");
  diagnosticCodes.sort((left, right) => left - right);
  return {
    schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
    workspaceId,
    expectedWorkspaceUpdatedAt: input.expectedWorkspaceUpdatedAt,
    requestId,
    requestText,
    requestedPaths,
    diagnosticCodes,
    validationPlan: {
      validatorId: DEFAULT_PATCH_VALIDATION_POLICY_ID,
      checks: [...DEFAULT_PATCH_VALIDATION_CHECKS]
    }
  };
}

function requireBoundedId(value: string, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (normalized.includes("\0") || [...normalized].length > 256) throw new Error(`${label} must contain at most 256 characters without NUL bytes`);
  return normalized;
}

function requireWorkspaceRelativePath(value: string, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  if (value.split("/").some(part => !part || part === "." || part === "..") || value.normalize("NFC") !== value) throw new Error(`${label} contains an unsafe segment`);
  return value;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Yopp server returned invalid JSON");
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim()) return `Yopp request failed (${status}): ${error.slice(0, 1000)}`;
  }
  return `Yopp request failed (${status})`;
}

function identity(value: unknown): unknown {
  return value;
}
