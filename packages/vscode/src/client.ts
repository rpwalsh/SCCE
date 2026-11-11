// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { parseCodeEditApproval, parseCodeEditAttempt, parseCodeValidationPolicies, type CodeEditAttempt } from "./code-edit-flow.js";
import { normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken, type ScceConnectionConfig } from "./config.js";
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
  parseSessionConsentApproval,
  parseSessionConsentRejection,
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
import { parseWithheldSurface } from "./withheld-surface.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const LOCAL_GRAPHQL_PROTOCOL = "scce.graphql.v1";

export interface TurnStreamFrame {
  schema: "scce.graphql.turn_task_update.v1";
  type: "accepted" | "progress" | "result" | "error" | "cancelled";
  taskId?: string;
  phase?: string;
  elapsedMs?: number;
  sequence?: number;
  status?: number;
  error?: string;
  /** Typed runtime data behind a non-2xx terminal frame -- a withheld-surface record, never wording. */
  detail?: unknown;
  value?: unknown;
  /** Present only on the "answer.ready" progress frame -- the turn's final answer, streamed early. */
  answer?: string;
  assistantForce?: string;
}

export interface HeldSourceView {
  id: string;
  uri: string;
  title: string;
  preview: string;
  evidenceCount: number;
}

export interface CurriculumItemView {
  planId: string;
  query: string;
  rationale: string;
}

function parseCurriculum(value: unknown): { items: CurriculumItemView[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.items) ? record.items : [];
  return { items: items.map(item => { const row = item as Record<string, unknown>; return { planId: String(row.planId ?? ""), query: String(row.query ?? ""), rationale: String(row.rationale ?? "") }; }).filter(item => item.planId && item.query) };
}

function parsePursue(value: unknown): { answer: string; held: HeldSourceView[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { answer: String(record.answer ?? ""), held: parseLearningHeld({ held: record.held }).held };
}

function parseLearningHeld(value: unknown): { held: HeldSourceView[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const held = Array.isArray(record.held) ? record.held : [];
  return { held: held.map(item => { const row = item as Record<string, unknown>; return { id: String(row.id ?? ""), uri: String(row.uri ?? ""), title: String(row.title ?? ""), preview: String(row.preview ?? ""), evidenceCount: Number(row.evidenceCount ?? 0) }; }).filter(item => item.id) };
}

function parseLearningReview(value: unknown): { review: { id: string; decision: string; promotedEvidence: number } } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const review = record.review && typeof record.review === "object" ? record.review as Record<string, unknown> : {};
  if (!review.id) throw new Error("SCCE learning review returned no review record");
  return { review: { id: String(review.id), decision: String(review.decision ?? ""), promotedEvidence: Number(review.promotedEvidence ?? 0) } };
}

export interface TurnAnswerEvidenceSpan {
  id?: string;
  sourceId?: string;
  textPreview?: string;
  provenance?: unknown;
  [key: string]: unknown;
}

export interface TurnAnswer {
  answer?: string;
  dialogue?: { conversationId?: string; turnId?: string };
  entailment?: { proof?: unknown };
  proofCarryingAnswer?: unknown;
  events?: Array<{ typeId: string; id: string }>;
  // Real evidence used this turn, when any was found -- a citation to
  // offer the user, never a requirement the answer had to clear. Absent or
  // empty just means no source backs this particular answer, which is a
  // normal, honest outcome, not an error.
  evidence?: TurnAnswerEvidenceSpan[];
  guardFlags?: { sourceBacked?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpTransport = (input: string, init: RequestInit) => Promise<HttpResponseLike>;

export class ScceHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ScceHttpError";
  }
}

/** A turn that decided not to assert anything. Not a failure: it carries the kernel's own typed reason. */
export class ScceWithheldTurnError extends ScceHttpError {
  readonly reasonId: string;

  constructor(status: number, message: string, readonly withheld: Record<string, unknown>) {
    super(status, message);
    this.name = "ScceWithheldTurnError";
    this.reasonId = String(withheld.reasonId);
  }
}

function turnStreamFailure(frame: TurnStreamFrame): Error {
  const withheld = parseWithheldSurface(frame.detail);
  const message = frame.error ?? "SCCE turn stream failed";
  return withheld ? new ScceWithheldTurnError(frame.status ?? 422, message, withheld) : new ScceHttpError(frame.status ?? 500, message);
}

export class ScceClient {
  private readonly config: ScceConnectionConfig;
  private graphqlGeneration: string | undefined;

  constructor(config: ScceConnectionConfig, private readonly transport: HttpTransport = fetch) {
    this.config = {
      serverUrl: normalizeLocalServerUrl(config.serverUrl),
      token: normalizeToken(config.token),
      timeoutMs: normalizeRequestTimeout(config.timeoutMs)
    };
  }

  ready(): Promise<ReadyResponse> {
    return this.vscodeQuery("VscodeReadyQuery", "vscodeReady", {}, parseReadyResponse);
  }

  workspaceInitialize(path: string): Promise<WorkspaceStatusResponse["workspace"]> {
    return this.vscodeMutation("VscodeWorkspaceInitializeMutation", "vscodeWorkspaceInitialize",
      { path: requireWorkspacePath(path) }, parseWorkspaceInitialize);
  }

  workspaceIngest(path: string): Promise<WorkspaceIngestResponse> {
    return this.vscodeMutation("VscodeWorkspaceIngestMutation", "vscodeWorkspaceIngest",
      { path: requireWorkspacePath(path) }, parseWorkspaceIngestResponse);
  }

  workspaceAsk(path: string, question: string): Promise<WorkspaceAnswerResponse> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error("workspace question must not be empty");
    return this.vscodeMutation("VscodeWorkspaceAskMutation", "vscodeWorkspaceAsk",
      { path: requireWorkspacePath(path), question: normalizedQuestion }, parseWorkspaceAnswerResponse);
  }

  projectSummary(path: string): Promise<ProjectSummaryResponse> {
    return this.vscodeQuery("VscodeProjectSummaryQuery", "vscodeProjectSummary",
      { path: requireWorkspacePath(path) }, parseProjectSummaryResponse);
  }

  workspaceStatus(): Promise<WorkspaceStatusResponse> {
    return this.vscodeQuery("VscodeWorkspaceStatusQuery", "vscodeWorkspaceStatus", {}, parseWorkspaceStatus);
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
    return this.vscodeMutation("VscodeWorkspaceCodingPatchPlanMutation", "vscodeWorkspaceCodingPatchPlan",
      { value: request }, value => parseWorkspaceCodingPatchPlanResult(
        graphqlJsonPayloadValue(value, "vscodeWorkspaceCodingPatchPlan"), request));
  }

  workspacePatch(workspaceId: string, plan: ReviewedPatchPlan): Promise<WorkspacePatchAttempt> {
    return this.vscodeMutation("VscodeWorkspacePatchMutation", "vscodeWorkspacePatch", { value: {
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: requireNonEmpty(workspaceId, "workspace id"),
      plan,
      validationPolicyId: DEFAULT_PATCH_VALIDATION_POLICY_ID
    } }, value => {
      const attempt = parseWorkspacePatchAttempt(graphqlJsonPayloadValue(value, "vscodeWorkspacePatch"));
      return "pendingApproval" in attempt ? attempt : verifyAppliedPatchMatchesPlan(attempt, plan);
    });
  }

  listCurriculum(): Promise<{ items: CurriculumItemView[] }> {
    return this.vscodeQuery("VscodeLearningCurriculumQuery", "vscodeLearningCurriculum", {}, parseCurriculum);
  }

  pursueCurriculum(planId: string): Promise<{ answer: string; held: HeldSourceView[] }> {
    return this.vscodeMutation("VscodeLearningPursueMutation", "vscodeLearningPursue",
      { planId: requireNonEmpty(planId, "curriculum plan id") }, parsePursue);
  }

  listHeldSources(): Promise<{ held: HeldSourceView[] }> {
    return this.vscodeQuery("VscodeHeldSourcesQuery", "vscodeHeldSources", { first: 20 }, parseLearningHeld);
  }

  reviewHeldSource(id: string, decision: "promoted" | "rejected"): Promise<{ review: { id: string; decision: string; promotedEvidence: number } }> {
    return this.vscodeMutation("VscodeReviewHeldSourceMutation", "vscodeReviewHeldSource",
      { id: requireNonEmpty(id, "held source id"), decision }, parseLearningReview);
  }

  approveWorkspacePatch(planId: string): Promise<{ approved: { planId: string; capabilityId: string } }> {
    return this.vscodeMutation("VscodeApprovePlanMutation", "vscodeApprovePlan",
      { planId: requireNonEmpty(planId, "approval plan id") }, parseSessionApproval);
  }

  approveLearningConsent(planId: string): Promise<{ approved: { planId: string; capabilityId: "network.search" } }> {
    return this.vscodeMutation("VscodeApprovePlanMutation", "vscodeApprovePlan",
      { planId: requireNonEmpty(planId, "consent plan id") }, parseSessionConsentApproval);
  }

  rejectLearningConsent(planId: string): Promise<{ rejected: { planId: string; capabilityId: "network.search" } }> {
    return this.vscodeMutation("VscodeRejectPlanMutation", "vscodeRejectPlan",
      { planId: requireNonEmpty(planId, "consent plan id") }, parseSessionConsentRejection);
  }

  /** Starts one durable local GraphQL operation and follows its SSE task updates. */
  async streamTurn(
    input: { text: string; sessionId: string; conversationId?: string },
    onFrame: (frame: TurnStreamFrame) => void,
    signal?: AbortSignal
  ): Promise<TurnAnswer> {
    const endpoint = `${this.config.serverUrl}/api/graphql`;
    const correlationId = randomUUID();
    let generation = "";
    let operationId = "";
    let latestSequence = 0;
    const byteBudget = { received: 0 };
    try {
      const runtime = await graphqlRequest<{ runtime: GraphqlRuntime }>(endpoint, this.config.token,
        "VscodeRuntimeQuery", {}, undefined, signal);
      if (runtime.data.runtime.protocolVersion !== LOCAL_GRAPHQL_PROTOCOL
        || runtime.data.runtime.generation !== runtime.generation) {
        throw new GraphqlProtocolError("SCCE runtime returned an inconsistent GraphQL generation");
      }
      generation = runtime.generation;

      const reserveMutationId = `${correlationId}:reserve`;
      const reserved = await graphqlRequest<{ reserveTurn: GraphqlTurnPayload }>(endpoint, this.config.token,
        "VscodeReserveTurnMutation", { input: { clientMutationId: reserveMutationId } }, generation, signal);
      operationId = mutationTask(reserved.data.reserveTurn, reserveMutationId, "reserveTurn").id;

      const startMutationId = `${correlationId}:start`;
      const started = await graphqlRequest<{ startTurn: GraphqlTurnPayload }>(endpoint, this.config.token,
        "VscodeStartTurnMutation", { input: {
          operationId,
          text: input.text,
          sessionId: input.sessionId,
          conversationId: input.conversationId ?? input.sessionId,
          clientMutationId: startMutationId
        } }, generation, signal);
      if (mutationTask(started.data.startTurn, startMutationId, "startTurn").id !== operationId) {
        throw new GraphqlProtocolError("SCCE startTurn changed the reserved operation identifier");
      }

      let reconnects = 0;
      for (;;) {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: graphqlHeaders(this.config.token, "text/event-stream"),
            body: JSON.stringify({
              protocolVersion: LOCAL_GRAPHQL_PROTOCOL,
              operationName: "VscodeTurnTaskSubscription",
              variables: { id: operationId, afterSequence: latestSequence },
              generation
            }),
            signal,
            credentials: "omit",
            redirect: "error"
          });
        } catch (error) {
          if (signal?.aborted) throw abortError(error);
          if (++reconnects > 8) throw error;
          await delay(250, signal);
          continue;
        }
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
          throw await graphqlResponseFailure(response);
        }
        let complete = false;
        let sawUpdate = false;
        try {
          for await (const event of readGraphqlEvents(response, byteBudget)) {
            if (event.event === "complete") {
              complete = true;
              break;
            }
            if (event.event !== "next") throw new GraphqlProtocolError("SCCE GraphQL subscription sent an unknown event");
            const payload = decodeGraphqlEnvelope<{ turnTaskUpdated: GraphqlTurnTask }>(event.data, generation, response.status);
            const task = payload.data.turnTaskUpdated;
            if (!task || task.id !== operationId) throw new GraphqlProtocolError("SCCE GraphQL subscription changed task identity");
            const frame = task.latestFrame;
            if (!frame || frame.sequence <= latestSequence) continue;
            sawUpdate = true;
            latestSequence = frame.sequence;
            const update = taskUpdateFrame(task, frame);
            onFrame(update);
            if (update.type === "result") return turnAnswer(task.result?.value);
            if (update.type === "error" || update.type === "cancelled") throw turnStreamFailure(update);
            if (task.status === "interrupted") {
              throw new ScceHttpError(503, "SCCE turn execution was interrupted before producing a terminal result");
            }
          }
        } catch (error) {
          if (signal?.aborted) throw abortError(error);
          if (error instanceof GraphqlProtocolError || error instanceof ScceHttpError || error instanceof ScceWithheldTurnError) throw error;
          if (++reconnects > 8) throw error;
          await delay(250, signal);
          continue;
        }
        if (complete) throw new GraphqlProtocolError("SCCE GraphQL subscription completed without a terminal task frame");
        reconnects = sawUpdate ? 0 : reconnects + 1;
        if (reconnects > 8) throw new Error("SCCE GraphQL subscription repeatedly disconnected before the turn completed");
        await delay(250, signal);
      }
    } catch (error) {
      if (signal?.aborted && operationId && generation) {
        await cancelGraphqlTurn(endpoint, this.config.token, operationId, generation, `${correlationId}:cancel`);
        throw abortError(error);
      }
      throw error;
    }
  }

  // Phase 6/8 surfaces: settings and local models through the server's shared schema.
  async getSettings(): Promise<SettingsView> {
    return this.vscodeQuery("VscodeSettingsQuery", "vscodeSettings", {}, value => value as SettingsView);
  }

  async putSetting(key: string, value: string | boolean | number): Promise<{ key: string; value: unknown; restartRequired: boolean }> {
    return this.vscodeMutation("VscodeUpdateSettingMutation", "vscodeUpdateSetting",
      { key: requireNonEmpty(key, "setting key"), value }, result => result as { key: string; value: unknown; restartRequired: boolean });
  }

  async listModels(): Promise<ModelsView> {
    return this.vscodeQuery("VscodeModelsQuery", "vscodeModels", {}, value => value as ModelsView);
  }

  async downloadModel(modelId: string): Promise<unknown> {
    return this.vscodeMutation("VscodeDownloadModelMutation", "vscodeDownloadModel",
      { modelId: requireNonEmpty(modelId, "model id") }, identity);
  }

  async removeModel(modelId: string): Promise<{ removed: boolean }> {
    return this.vscodeMutation("VscodeRemoveModelMutation", "vscodeRemoveModel",
      { modelId: requireNonEmpty(modelId, "model id") }, value => value as { removed: boolean });
  }

  /** Edits through the workspace build gate and the selected server-owned policy. */
  async editCode(targetPath: string, request: string, attempts?: number, validationPolicyId?: string): Promise<CodeEditAttempt> {
    return this.vscodeMutation("VscodeEditCodeMutation", "vscodeEditCode", { path: targetPath, request,
      ...(attempts === undefined ? {} : { attempts }),
      ...(validationPolicyId === undefined ? {} : { validationPolicyId: requireNonEmpty(validationPolicyId, "validation policy id") })
    }, value => parseCodeEditAttempt(graphqlJsonPayloadValue(value, "vscodeEditCode")));
  }

  codeValidationPolicies() {
    return this.vscodeQuery("VscodeCodeValidationPoliciesQuery", "vscodeCodeValidationPolicies", {}, parseCodeValidationPolicies);
  }

  approveCodeEdit(planId: string): Promise<{ approved: { planId: string; capabilityId: string } }> {
    return this.vscodeMutation("VscodeApprovePlanMutation", "vscodeApprovePlan",
      { planId: requireNonEmpty(planId, "approval plan id") }, parseCodeEditApproval);
  }

  private async vscodeQuery<T>(operationName: string, field: string, variables: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
    const data = await this.graphqlTransport<Record<string, unknown>>(operationName, variables, false);
    if (!recordValue(data[field])) throw new GraphqlProtocolError(`SCCE ${field} returned an invalid typed query payload`);
    return parse(data[field]);
  }

  private async vscodeMutation<T>(operationName: string, field: string, value: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
    if (!this.graphqlGeneration) await this.graphqlTransport("VscodeRuntimeQuery", {}, false);
    const operationId = randomUUID();
    const clientMutationId = randomUUID();
    const data = await this.graphqlTransport<Record<string, unknown>>(operationName,
      { input: { operationId, ...value, clientMutationId } }, true);
    const payload = recordValue(data[field]);
    if (!payload || payload.clientMutationId !== clientMutationId) throw new GraphqlProtocolError(`SCCE ${field} returned an invalid Relay mutation payload`);
    const { clientMutationId: _clientMutationId, ...result } = payload;
    return parse(result);
  }

  private async graphqlTransport<T>(operationName: string, variables: Record<string, unknown>, requireGeneration: boolean): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const expectedGeneration = this.graphqlGeneration;
    if (requireGeneration && !expectedGeneration) throw new GraphqlProtocolError("SCCE GraphQL mutation requires a runtime generation");
    try {
      const response = await this.transport(`${this.config.serverUrl}/api/graphql`, {
        method: "POST",
        headers: graphqlHeaders(this.config.token, "application/graphql-response+json"),
        body: JSON.stringify({ protocolVersion: LOCAL_GRAPHQL_PROTOCOL, operationName, variables,
          ...(expectedGeneration ? { generation: expectedGeneration } : {}) }),
        signal: controller.signal
      });
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("SCCE response exceeded the extension size limit");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("SCCE response exceeded the extension size limit");
      const envelope = decodeGraphqlEnvelope<T>(text, expectedGeneration, response.status);
      this.graphqlGeneration = envelope.generation;
      return envelope.data;
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

function identity(value: unknown): unknown {
  return value;
}

function parseWorkspaceInitialize(value: unknown): WorkspaceStatusResponse["workspace"] {
  const payload = recordValue(value);
  if (!payload || !("workspace" in payload)) throw new GraphqlProtocolError("SCCE vscodeWorkspaceInitialize returned an invalid typed payload");
  return parseWorkspaceStatus({ workspace: payload.workspace, sources: [] }).workspace;
}

function graphqlJsonPayloadValue(value: unknown, field: string): unknown {
  const payload = recordValue(value);
  if (!payload || !("value" in payload)) throw new GraphqlProtocolError(`SCCE ${field} returned an invalid JSON application payload`);
  return payload.value;
}

interface GraphqlRuntime {
  protocolVersion: string;
  generation: string;
  phase: string;
  ready: boolean;
}

interface GraphqlTurnPayload {
  clientMutationId?: string | null;
  task?: GraphqlTurnTask | null;
}

interface GraphqlTurnTask {
  id: string;
  status: string;
  latestSequence: number;
  persistence: string;
  latestFrame?: GraphqlTurnFrame | null;
  result?: GraphqlTurnResult | null;
}

interface GraphqlTurnFrame {
  sequence: number;
  kind: string;
  phase?: string | null;
  answer?: string | null;
  error?: string | null;
  status?: number | null;
  elapsedMs?: number | null;
  value?: unknown;
  detail?: unknown;
  assistantForce?: string | null;
}

interface GraphqlTurnResult {
  answer?: string | null;
  error?: string | null;
  httpStatus?: number | null;
  value?: unknown;
  detail?: unknown;
}

class GraphqlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphqlProtocolError";
  }
}

async function graphqlRequest<T>(
  endpoint: string,
  token: string | undefined,
  operationName: string,
  variables: Record<string, unknown>,
  generation: string | undefined,
  signal?: AbortSignal
): Promise<{ data: T; generation: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: graphqlHeaders(token, "application/graphql-response+json"),
    body: JSON.stringify({ protocolVersion: LOCAL_GRAPHQL_PROTOCOL, operationName, variables,
      ...(generation === undefined ? {} : { generation }) }),
    signal,
    credentials: "omit",
    redirect: "error"
  });
  const text = await boundedResponseText(response, MAX_RESPONSE_BYTES);
  return decodeGraphqlEnvelope<T>(text, generation, response.status);
}

function graphqlHeaders(token: string | undefined, accept: string): Record<string, string> {
  return { "content-type": "application/json", accept, ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function decodeGraphqlEnvelope<T>(text: string, expectedGeneration: string | undefined, httpStatus: number): { data: T; generation: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new GraphqlProtocolError("SCCE GraphQL endpoint returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GraphqlProtocolError("SCCE GraphQL endpoint returned an invalid response envelope");
  }
  const envelope = parsed as Record<string, unknown>;
  const extensions = recordValue(envelope.extensions);
  const generation = extensions?.generation;
  if (extensions?.protocolVersion !== LOCAL_GRAPHQL_PROTOCOL || typeof generation !== "string" || !generation
    || (expectedGeneration !== undefined && generation !== expectedGeneration)) {
    throw new GraphqlProtocolError("SCCE local runtime generation changed; reconnect before continuing");
  }
  if (Array.isArray(envelope.errors) && envelope.errors.length) throw graphqlExecutionFailure(envelope.errors[0], httpStatus);
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new GraphqlProtocolError("SCCE GraphQL response did not contain operation data");
  }
  return { data: envelope.data as T, generation };
}

function graphqlExecutionFailure(value: unknown, httpStatus: number): ScceHttpError {
  const error = recordValue(value);
  const extensions = recordValue(error?.extensions);
  const code = typeof extensions?.code === "string" ? extensions.code : "GRAPHQL_ERROR";
  const status = httpStatus >= 400 ? httpStatus : graphqlStatus(code);
  const message = typeof error?.message === "string" && error.message.trim() ? error.message : "local operation failed";
  const withheld = parseWithheldSurface(extensions?.detail);
  if (withheld) return new ScceWithheldTurnError(status, message, withheld);
  return new ScceHttpError(status, `SCCE GraphQL ${code}: ${message}`);
}

function graphqlStatus(code: string): number {
  if (code === "BAD_INPUT" || code === "BAD_ENVELOPE" || code === "BAD_ID" || code === "INVALID_CURSOR") return 400;
  if (code === "NOT_FOUND" || code === "UNKNOWN_OPERATION") return 404;
  if (code === "CONFLICT" || code === "STALE_GENERATION") return 409;
  if (code === "FORBIDDEN") return 403;
  if (code === "UNPROCESSABLE") return 422;
  if (code === "RESOURCE_LIMIT") return 429;
  if (code === "PERSISTENCE_FAILED") return 503;
  return 500;
}

function mutationTask(payload: GraphqlTurnPayload | null | undefined, clientMutationId: string, field: string): GraphqlTurnTask {
  if (!payload || payload.clientMutationId !== clientMutationId || !payload.task || typeof payload.task.id !== "string" || !payload.task.id) {
    throw new GraphqlProtocolError(`SCCE ${field} returned an invalid Relay mutation payload`);
  }
  return payload.task;
}

function taskUpdateFrame(task: GraphqlTurnTask, frame: GraphqlTurnFrame): TurnStreamFrame {
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1
    || !["accepted", "progress", "result", "error", "cancelled"].includes(frame.kind)) {
    throw new GraphqlProtocolError("SCCE GraphQL subscription returned an invalid task frame");
  }
  const result = task.result;
  const valueRecord = recordValue(result?.value);
  return {
    schema: "scce.graphql.turn_task_update.v1",
    type: frame.kind as TurnStreamFrame["type"],
    taskId: task.id,
    sequence: frame.sequence,
    ...(typeof frame.phase === "string" ? { phase: frame.phase } : {}),
    ...(typeof frame.elapsedMs === "number" ? { elapsedMs: frame.elapsedMs } : {}),
    ...(typeof (frame.status ?? result?.httpStatus) === "number" ? { status: (frame.status ?? result?.httpStatus) as number } : {}),
    ...(typeof (frame.error ?? result?.error) === "string" ? { error: (frame.error ?? result?.error) as string } : {}),
    ...((frame.detail ?? result?.detail ?? valueRecord?.detail) === undefined ? {} : { detail: frame.detail ?? result?.detail ?? valueRecord?.detail }),
    ...((frame.kind === "result" ? result?.value : frame.value) === undefined ? {} : { value: frame.kind === "result" ? result?.value : frame.value }),
    ...(typeof frame.answer === "string" ? { answer: frame.answer } : {}),
    ...(typeof frame.assistantForce === "string" ? { assistantForce: frame.assistantForce } : {})
  };
}

function turnAnswer(value: unknown): TurnAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GraphqlProtocolError("SCCE terminal task result did not contain a TurnAnswer payload");
  }
  return value as TurnAnswer;
}

async function graphqlResponseFailure(response: Response): Promise<Error> {
  let text: string;
  try { text = await boundedResponseText(response, MAX_RESPONSE_BYTES); }
  catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  if (text) {
    try { decodeGraphqlEnvelope(text, undefined, response.status); }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }
  return new ScceHttpError(response.status, `SCCE GraphQL subscription failed (${response.status})`);
}

async function cancelGraphqlTurn(endpoint: string, token: string | undefined, operationId: string, generation: string, clientMutationId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const cancelled = await graphqlRequest<{ cancelTurn: GraphqlTurnPayload }>(endpoint, token,
      "VscodeCancelTurnMutation", { input: { taskId: operationId, clientMutationId } }, generation, controller.signal);
    mutationTask(cancelled.data.cancelTurn, clientMutationId, "cancelTurn");
  } catch { /* The caller is already aborting; cancellation is best-effort across a dead local host. */ }
  finally { clearTimeout(timer); }
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new GraphqlProtocolError("SCCE GraphQL response exceeded the extension size limit");
  if (!response.body) throw new GraphqlProtocolError("SCCE GraphQL response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > limit) throw new GraphqlProtocolError("SCCE GraphQL response exceeded the extension size limit");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* readGraphqlEvents(response: Response, budget: { received: number }): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new GraphqlProtocolError("SCCE GraphQL subscription had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frame = new Uint8Array(1024 * 1024);
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        if (length) throw new GraphqlProtocolError("SCCE GraphQL subscription ended with a truncated event");
        return;
      }
      budget.received += next.value.byteLength;
      if (budget.received > MAX_STREAM_BYTES) throw new GraphqlProtocolError("SCCE GraphQL subscription exceeded the extension size limit");
      for (const byte of next.value) {
        if (length === frame.length) throw new GraphqlProtocolError("SCCE GraphQL subscription event exceeded the extension size limit");
        frame[length++] = byte;
        if (length < 2 || byte !== 10 || frame[length - 2] !== 10) continue;
        let record: string;
        try { record = decoder.decode(frame.subarray(0, length - 2)); }
        catch { throw new GraphqlProtocolError("SCCE GraphQL subscription sent invalid UTF-8"); }
        length = 0;
        const lines = record.split("\n");
        const event = lines.find(line => line.startsWith("event: "))?.slice(7);
        const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!event || !data) throw new GraphqlProtocolError("SCCE GraphQL subscription sent an invalid SSE envelope");
        yield { event, data };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function abortError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  return new DOMException("aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectPromise(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export interface SettingsView {
  configPath: string;
  fields: Array<{ key: string; label: string; kind: "string" | "boolean" | "choice" | "number"; choices?: string[]; value: unknown }>;
}

export interface ModelsView {
  modelDir: string;
  models: Array<{ id: string; path: string; bytes: number; files: number; active: boolean; size: string }>;
  totalBytes: number;
}
