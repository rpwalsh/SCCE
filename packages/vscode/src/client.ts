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
  DEFAULT_PATCH_VALIDATION_POLICY_ID,
  WORKSPACE_PATCH_REQUEST_SCHEMA,
  parseSessionApproval,
  parseWorkspacePatchAttempt,
  parseWorkspaceStatus,
  type ReviewedPatchPlan,
  type WorkspacePatchAttempt,
  type WorkspaceStatusResponse
} from "./patch-protocol.js";

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

  workspacePatch(workspaceId: string, plan: ReviewedPatchPlan): Promise<WorkspacePatchAttempt> {
    return this.request("POST", "/api/workspace/patch", {
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: requireNonEmpty(workspaceId, "workspace id"),
      plan,
      validationPolicyId: DEFAULT_PATCH_VALIDATION_POLICY_ID
    }, parseWorkspacePatchAttempt);
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
