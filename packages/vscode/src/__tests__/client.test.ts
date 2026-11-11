// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { type HttpResponseLike, type HttpTransport, ScceClient, ScceHttpError } from "../client.js";
import { parseReviewedPatchPlan } from "../patch-protocol.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface RecordedRequest {
  input: string;
  init: RequestInit;
}

describe("ScceClient registered GraphQL boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the normalized loopback origin, bearer token, and fixed endpoint methods", async () => {
    const requests: RecordedRequest[] = [];
    const transport = registeredTransport(request => {
      if (request.operationName === "VscodeReadyQuery") return { ok: true, postgres: { ok: true }, serverUrl: "http://127.0.0.1:3873", manifest: 11 };
      if (request.operationName === "VscodeWorkspaceInitializeMutation") return { workspace: { id: "workspace-1", rootPath: "C:\\My Repo", updatedAt: 10 } };
      if (request.operationName === "VscodeWorkspaceIngestMutation") {
        return {
          schema: "scce.workspace.ingest.v1",
          importBatchId: "batch-1",
          ingested: 1,
          unchanged: 0,
          changed: 0,
          missing: 0,
          failed: 0,
          unsupported: 0,
          workspace: {},
          project: {}
        };
      }
      if (request.operationName === "VscodeWorkspaceAskMutation") {
        return {
          schema: "scce.workspace.answer.v1",
          question: "Where is the proof?",
          answer: "In source span 1.",
          confidence: 0.8,
          sourceRefs: []
        };
      }
      if (request.operationName === "VscodeProjectSummaryQuery") return { schema: "scce.project.summary.v1", workspace: {}, summary: {} };
      if (request.operationName === "VscodeWorkspaceStatusQuery") return { workspace: { id: "workspace-1", rootPath: "C:\\My Repo", updatedAt: 10 }, sources: [] };
      throw new Error(`unexpected operation ${request.operationName}`);
    }, requests);
    const client = new ScceClient(
      { serverUrl: " http://127.42.1.9:3873/ ", token: " local-secret ", timeoutMs: 10_000 },
      transport
    );

    await client.ready();
    const initialized = await client.workspaceInitialize(" C:\\My Repo ");
    await client.workspaceIngest(" C:\\My Repo ");
    await client.workspaceAsk(" C:\\My Repo ", "  Where is the proof?  ");
    await client.projectSummary(" C:\\My Repo ");
    await client.workspaceStatus();

    expect(requests.map(request => [request.init.method, request.input])).toEqual(Array(6).fill(["POST", "http://127.42.1.9:3873/api/graphql"]));
    expect(requests.map(request => requestEnvelope(request).operationName)).toEqual([
      "VscodeReadyQuery", "VscodeWorkspaceInitializeMutation", "VscodeWorkspaceIngestMutation",
      "VscodeWorkspaceAskMutation", "VscodeProjectSummaryQuery", "VscodeWorkspaceStatusQuery"
    ]);
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({ accept: "application/graphql-response+json", authorization: "Bearer local-secret", "content-type": "application/json" });
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(requestEnvelope(requests[1]!).variables).toMatchObject({ input: { path: "C:\\My Repo" } });
    expect(requestEnvelope(requests[2]!).variables).toMatchObject({ input: { path: "C:\\My Repo" } });
    expect(requestEnvelope(requests[3]!).variables).toMatchObject({ input: { path: "C:\\My Repo", question: "Where is the proof?" } });
    expect(requestEnvelope(requests[4]!).variables).toEqual({ path: "C:\\My Repo" });
    expect(initialized).toEqual({ id: "workspace-1", rootPath: "C:\\My Repo", updatedAt: 10 });
  });

  it("omits authorization when no token is configured", async () => {
    let observedHeaders: RequestInit["headers"];
    const client = new ScceClient({ serverUrl: "http://localhost:3873", timeoutMs: 1_000 }, registeredTransport((_request, init) => {
      observedHeaders = init.headers;
      return { workspace: { id: "workspace-1", rootPath: "C:\\repo", updatedAt: 10 }, sources: [] };
    }));

    await client.workspaceStatus();

    expect(observedHeaders).toEqual({ "content-type": "application/json", accept: "application/graphql-response+json" });
  });

  it("rejects empty workspace paths and questions before making a request", () => {
    const transport = vi.fn<HttpTransport>();
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

    expect(() => client.workspaceInitialize("  ")).toThrow("a local workspace path is required");
    expect(() => client.workspaceIngest("\t")).toThrow("a local workspace path is required");
    expect(() => client.workspaceAsk("C:\\repo", "  ")).toThrow("workspace question must not be empty");
    expect(() => client.projectSummary("\n")).toThrow("a local workspace path is required");
    expect(() => client.workspaceCodingPatchPlan({
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 1,
      requestId: "request-1",
      requestText: "  ",
      requestedPaths: ["src/a.ts"],
      diagnosticCodes: [6133]
    })).toThrow("coding request text must be non-empty");
    expect(() => client.workspaceCodingPatchPlan({
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 1,
      requestId: "request-1",
      requestText: "change it",
      requestedPaths: ["../outside.ts"],
      diagnosticCodes: [6133]
    })).toThrow("unsafe segment");
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses registered two-phase patch mutations and sends no client root or command line", async () => {
    const requests: RecordedRequest[] = [];
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export {};\n"));
    let patchAttempts = 0;
    const transport = registeredTransport(request => {
      if (request.operationName === "VscodeWorkspacePatchMutation") {
        patchAttempts += 1;
        if (patchAttempts === 1) return {
          ok: false,
          pendingApproval: {
            planId: "approval-1",
            capabilityId: "workspace.patch.apply",
            fingerprint: "a".repeat(64),
            reason: "operator-approval-required",
            createdAt: 1
          },
          session: {}
        };
        return {
          schemaVersion: "scce.workspace-patch-response.v1",
          workspaceId: "workspace-1",
          validationPolicyId: "trusted-host-pnpm-validate.v1",
          receipt: fixtureReceipt(plan)
        };
      }
      if (request.operationName === "VscodeApprovePlanMutation") return { approved: { planId: "approval-1", capabilityId: "workspace.patch.apply" }, session: {} };
      throw new Error(`unexpected operation ${request.operationName}`);
    }, requests);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

    const pending = await client.workspacePatch("workspace-1", plan);
    expect("pendingApproval" in pending && pending.pendingApproval.planId).toBe("approval-1");
    await client.approveWorkspacePatch("approval-1");
    const applied = await client.workspacePatch("workspace-1", plan);
    expect("receipt" in applied && applied.receipt.planHash).toBe(plan.planHash);

    const firstBody = ((requestEnvelope(requests[1]!).variables.input as Record<string, unknown>).value) as Record<string, unknown>;
    expect(firstBody).toEqual({ schemaVersion: "scce.workspace-patch-request.v1", workspaceId: "workspace-1", plan, validationPolicyId: "trusted-host-pnpm-validate.v1" });
    expect(firstBody).not.toHaveProperty("workspaceRoot");
    expect(firstBody).not.toHaveProperty("executable");
    expect(requests.map(request => requestEnvelope(request).operationName)).toEqual([
      "VscodeRuntimeQuery", "VscodeWorkspacePatchMutation", "VscodeApprovePlanMutation", "VscodeWorkspacePatchMutation"
    ]);
  });

  it("rejects internally valid patch receipts that are partial or do not match the reviewed operation", async () => {
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export {};\n"));
    const response = (receipt: unknown) => ({
      schemaVersion: "scce.workspace-patch-response.v1",
      workspaceId: "workspace-1",
      validationPolicyId: "trusted-host-pnpm-validate.v1",
      receipt
    });

    await expect(clientWithGraphqlValue(response(fixtureReceipt(plan, { omitMutation: true }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/mutation count/u);
    await expect(clientWithGraphqlValue(response(fixtureReceipt(plan, { mutationPath: "src/other.ts" }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/path does not match/u);
    await expect(clientWithGraphqlValue(response(fixtureReceipt(plan, { omitValidation: true }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/missing.*validation receipt/u);
  });

  it("approves and rejects network search consent through the session endpoints", async () => {
    const requests: RecordedRequest[] = [];
    const transport = registeredTransport(request => {
      if (request.operationName === "VscodeApprovePlanMutation") return { approved: { planId: "search-1", capabilityId: "network.search" }, session: {} };
      if (request.operationName === "VscodeRejectPlanMutation") return { rejected: { planId: "search-1", capabilityId: "network.search" }, session: {} };
      throw new Error(`unexpected operation ${request.operationName}`);
    }, requests);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);
    await client.approveLearningConsent("search-1");
    await client.rejectLearningConsent("search-1");
    expect(requests.map(request => requestEnvelope(request).operationName)).toEqual([
      "VscodeRuntimeQuery", "VscodeApprovePlanMutation", "VscodeRejectPlanMutation"
    ]);
  });

  it("covers learning, settings, models, and validation policy surfaces with registered operations", async () => {
    const requests: RecordedRequest[] = [];
    const values: Record<string, unknown> = {
      VscodeLearningCurriculumQuery: { items: [{ planId: "learn-1", query: "typed query", rationale: "gap" }] },
      VscodeLearningPursueMutation: { answer: "learned", held: [] },
      VscodeHeldSourcesQuery: { held: [] },
      VscodeReviewHeldSourceMutation: { review: { id: "held-1", decision: "promoted", promotedEvidence: 2 } },
      VscodeSettingsQuery: { configPath: "scce.config.json", fields: [] },
      VscodeUpdateSettingMutation: { key: "runtime.mode", value: "local", restartRequired: true },
      VscodeModelsQuery: { modelDir: "models", models: [], totalBytes: 0 },
      VscodeDownloadModelMutation: { model: { id: "org/model" } },
      VscodeRemoveModelMutation: { removed: true },
      VscodeCodeValidationPoliciesQuery: { policies: [], provider: "trusted-host" }
    };
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, registeredTransport(request => {
      if (!(request.operationName in values)) throw new Error(`unexpected operation ${request.operationName}`);
      return values[request.operationName];
    }, requests));

    expect((await client.listCurriculum()).items[0]?.planId).toBe("learn-1");
    expect((await client.pursueCurriculum("learn-1")).answer).toBe("learned");
    expect(await client.listHeldSources()).toEqual({ held: [] });
    expect((await client.reviewHeldSource("held-1", "promoted")).review.promotedEvidence).toBe(2);
    expect((await client.getSettings()).configPath).toBe("scce.config.json");
    expect((await client.putSetting("runtime.mode", "local")).restartRequired).toBe(true);
    expect((await client.listModels()).totalBytes).toBe(0);
    await client.downloadModel("org/model");
    expect(await client.removeModel("org/model")).toEqual({ removed: true });
    expect((await client.codeValidationPolicies()).provider).toBe("trusted-host");

    expect(requests.every(request => request.input.endsWith("/api/graphql"))).toBe(true);
    expect(requests.map(request => requestEnvelope(request).operationName)).toEqual(Object.keys(values));
  });

  it("submits a bounded coding request and verifies the returned content-addressed plan trace", async () => {
    const requests: RecordedRequest[] = [];
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export const value = 2;\n"));
    const transport = registeredTransport(request => {
      const input = request.variables.input as Record<string, unknown>;
      return fixtureCodingGeneration(plan, input.value as Record<string, unknown>);
    }, requests);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

    const result = await client.workspaceCodingPatchPlan({
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 10,
      requestId: "request-1",
      requestText: "  Add the verified value export.  ",
      requestedPaths: ["src/new.ts", "package.json"],
      diagnosticCodes: [6133, 2552]
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error(JSON.stringify(result));
    expect(result.plan.planHash).toBe(plan.planHash);
    expect(result.authorization).toEqual({ required: true, granted: false, capabilityId: "workspace.patch.apply" });
    expect(result.execution).toEqual({ state: "not_executed", receipt: null });
    expect(requests.map(request => requestEnvelope(request).operationName)).toEqual([
      "VscodeRuntimeQuery", "VscodeWorkspaceCodingPatchPlanMutation"
    ]);
    const body = (requestEnvelope(requests[1]!).variables.input as Record<string, unknown>).value as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "scce.workspace-coding-patch-plan-request.v1",
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 10,
      requestId: "request-1",
      requestText: "Add the verified value export.",
      requestedPaths: ["package.json", "src/new.ts"],
      diagnosticCodes: [2552, 6133],
      validationPlan: {
        validatorId: "trusted-host-pnpm-validate.v1",
        checks: ["compiler", "typecheck", "tests"]
      }
    });
    expect(body).not.toHaveProperty("workspaceRoot");
    expect(body).not.toHaveProperty("proposedFiles");
    expect(body).not.toHaveProperty("command");
    expect(body).not.toHaveProperty("authorization");
    expect(body).not.toHaveProperty("execution");
  });

  it("rejects a coding plan whose request trace does not match the submitted scope", async () => {
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export const value = 2;\n"));
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, registeredTransport(request => {
      const input = request.variables.input as Record<string, unknown>;
      const generation = fixtureCodingGeneration(plan, input.value as Record<string, unknown>);
      const requestNode = generation.constraintGraph.nodes.find(node => node.kindId === "scce.task.request.v1")!;
      requestNode.metadata.requestedPaths = ["src/other.ts"];
      return generation;
    }));

    await expect(client.workspaceCodingPatchPlan({
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 10,
      requestId: "request-1",
      requestText: "Add the verified value export.",
      requestedPaths: ["src/new.ts"],
      diagnosticCodes: [6133]
    })).rejects.toThrow("coding plan requested paths do not match the submitted scope");
  });

  it("rejects a declared response length above the limit before reading the body", async () => {
    const text = vi.fn(async () => JSON.stringify({ ok: true }));
    const response: HttpResponseLike = {
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === "content-length" ? String(MAX_RESPONSE_BYTES + 1) : null) },
      text
    };
    const client = clientWithResponse(response);

    await expect(client.workspaceStatus()).rejects.toThrow("SCCE response exceeded the extension size limit");
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects an actual UTF-8 response body above the limit", async () => {
    const oversizedJson = JSON.stringify("x".repeat(MAX_RESPONSE_BYTES));
    expect(Buffer.byteLength(oversizedJson, "utf8")).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const client = clientWithResponse(textResponse(oversizedJson));

    await expect(client.workspaceStatus()).rejects.toThrow("SCCE response exceeded the extension size limit");
  });

  it("rejects invalid JSON without invoking a protocol parser", async () => {
    const client = clientWithResponse(textResponse("not-json"));

    await expect(client.workspaceStatus()).rejects.toThrow("SCCE GraphQL endpoint returned invalid JSON");
  });

  it("raises a typed HTTP error from a registered GraphQL error", async () => {
    const client = clientWithResponse(graphqlErrorResponse("FORBIDDEN", "permission denied", 200));

    const rejection = client.workspaceStatus();
    await expect(rejection).rejects.toBeInstanceOf(ScceHttpError);
    await expect(rejection).rejects.toMatchObject({
      name: "ScceHttpError",
      status: 403,
      message: "SCCE GraphQL FORBIDDEN: permission denied"
    });
  });

  it("maps an unclassified GraphQL failure to a typed server error", async () => {
    const client = clientWithResponse(graphqlErrorResponse("INTERNAL_ERROR", "local operation failed", 200));

    await expect(client.workspaceStatus()).rejects.toMatchObject({
      name: "ScceHttpError",
      status: 500,
      message: "SCCE GraphQL INTERNAL_ERROR: local operation failed"
    });
  });

  it("aborts the transport when the normalized timeout expires", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null | undefined;
    const transport: HttpTransport = async (_input, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    };
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1 }, transport);

    const assertion = expect(client.workspaceStatus()).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(999);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });
});

function clientWithResponse(response: HttpResponseLike): ScceClient {
  return new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, async () => response);
}

function clientWithGraphqlValue(value: unknown): ScceClient {
  return new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, registeredTransport(() => value));
}

interface GraphqlRequestEnvelope {
  operationName: string;
  variables: Record<string, unknown>;
  generation?: string;
}

const GRAPHQL_FIELDS: Record<string, string> = {
  VscodeReadyQuery: "vscodeReady",
  VscodeWorkspaceInitializeMutation: "vscodeWorkspaceInitialize",
  VscodeWorkspaceIngestMutation: "vscodeWorkspaceIngest",
  VscodeWorkspaceAskMutation: "vscodeWorkspaceAsk",
  VscodeProjectSummaryQuery: "vscodeProjectSummary",
  VscodeWorkspaceStatusQuery: "vscodeWorkspaceStatus",
  VscodeWorkspaceCodingPatchPlanMutation: "vscodeWorkspaceCodingPatchPlan",
  VscodeWorkspacePatchMutation: "vscodeWorkspacePatch",
  VscodeLearningCurriculumQuery: "vscodeLearningCurriculum",
  VscodeLearningPursueMutation: "vscodeLearningPursue",
  VscodeHeldSourcesQuery: "vscodeHeldSources",
  VscodeReviewHeldSourceMutation: "vscodeReviewHeldSource",
  VscodeApprovePlanMutation: "vscodeApprovePlan",
  VscodeRejectPlanMutation: "vscodeRejectPlan",
  VscodeSettingsQuery: "vscodeSettings",
  VscodeUpdateSettingMutation: "vscodeUpdateSetting",
  VscodeModelsQuery: "vscodeModels",
  VscodeDownloadModelMutation: "vscodeDownloadModel",
  VscodeRemoveModelMutation: "vscodeRemoveModel",
  VscodeCodeValidationPoliciesQuery: "vscodeCodeValidationPolicies",
  VscodeEditCodeMutation: "vscodeEditCode"
};
const JSON_MUTATIONS = new Set([
  "VscodeWorkspaceCodingPatchPlanMutation", "VscodeWorkspacePatchMutation", "VscodeEditCodeMutation"
]);

function registeredTransport(
  resolve: (request: GraphqlRequestEnvelope, init: RequestInit) => unknown | Promise<unknown>,
  requests?: RecordedRequest[]
): HttpTransport {
  return async (url, init) => {
    requests?.push({ input: url, init });
    const request = JSON.parse(String(init.body)) as GraphqlRequestEnvelope;
    if (request.operationName === "VscodeRuntimeQuery") return graphqlDataResponse({ runtime: {
      protocolVersion: "scce.graphql.v1", generation: "host-generation", phase: "ready", ready: true
    } });
    const field = GRAPHQL_FIELDS[request.operationName];
    if (!field) throw new Error(`unregistered test operation ${request.operationName}`);
    const value = await resolve(request, init);
    const input = request.variables.input as Record<string, unknown> | undefined;
    return graphqlDataResponse({ [field]: request.operationName.endsWith("Mutation")
      ? JSON_MUTATIONS.has(request.operationName)
        ? { value, clientMutationId: input?.clientMutationId }
        : { ...(value as Record<string, unknown>), clientMutationId: input?.clientMutationId }
      : value });
  };
}

function requestEnvelope(request: RecordedRequest): GraphqlRequestEnvelope {
  return JSON.parse(String(request.init.body)) as GraphqlRequestEnvelope;
}

function graphqlDataResponse(data: Record<string, unknown>, status = 200): HttpResponseLike {
  return jsonResponse({ data, extensions: { protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test" } }, { status });
}

function graphqlErrorResponse(code: string, message: string, status: number, detail?: unknown): HttpResponseLike {
  return jsonResponse({ errors: [{ message, extensions: { code, ...(detail === undefined ? {} : { detail }) } }],
    extensions: { protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test" } }, { ok: status >= 200 && status < 300, status });
}

function fixturePlan(path: string, content: string): unknown {
  const afterContentHash = sha256(content);
  const operations = [{ kind: "create", path, beforeContentHash: null, afterContentHash, content }];
  return { schemaVersion: "scce.patch-transaction-plan.v1", operations, planHash: sha256(JSON.stringify(canonical({ schemaVersion: "scce.patch-transaction-plan.v1", operations }))) };
}

function fixtureReceipt(
  plan: ReturnType<typeof parseReviewedPatchPlan>,
  options: { mutationPath?: string; omitMutation?: boolean; omitValidation?: boolean } = {}
): unknown {
  const operation = plan.operations[0]!;
  const mutationPayload = {
    schemaVersion: "scce.patch-mutation-receipt.v1",
    planHash: plan.planHash,
    operationIndex: 0,
    kind: operation.kind,
    path: options.mutationPath ?? operation.path,
    beforeContentHash: operation.beforeContentHash,
    afterContentHash: operation.afterContentHash
  };
  const mutations = options.omitMutation ? [] : [{ ...mutationPayload, mutationHash: sha256(JSON.stringify(canonical(mutationPayload))) }];
  const payload = {
    schemaVersion: "scce.patch-transaction-receipt.v1",
    transactionScope: "atomic-per-file-with-verified-transaction-rollback",
    planHash: plan.planHash,
    validation: options.omitValidation
      ? null
      : { validatorId: "trusted-host-pnpm-validate.v1", evidenceHash: sha256("validation-evidence") },
    mutations
  };
  return { ...payload, receiptHash: sha256(JSON.stringify(canonical(payload))) };
}

function fixtureCodingGeneration(plan: ReturnType<typeof parseReviewedPatchPlan>, request: Record<string, unknown>) {
  const revisionId = "revision-1";
  const revisionHash = sha256("revision-1");
  const requestId = String(request.requestId);
  const requestedPaths = [...(request.requestedPaths as string[])];
  const diagnosticCode = (request.diagnosticCodes as number[])[0]!;
  const diagnosticIdentity = `diagnostic-${diagnosticCode}`;
  const diagnosticNodeId = `diagnostic-node-${diagnosticCode}`;
  const graphId = "constraint-graph-1";
  return {
    schemaVersion: "scce.workspace.compiler_patch_plan.v1",
    statusId: "scce.workspace.compiler_patch.selected.v1",
    workspaceId: String(request.workspaceId),
    revisionId,
    revisionHash,
    constraintGraph: {
      schema: "scce.workspace.task_constraint_graph.v1",
      id: graphId,
      workspaceRevision: { workspaceId: String(request.workspaceId), revisionId, revisionHash },
      requestId,
      nodes: [
        { id: "request-node", kindId: "scce.task.request.v1", subjectId: requestId, metadata: { requestedPaths } },
        { id: diagnosticNodeId, kindId: "scce.program.diagnostic.v1", subjectId: diagnosticIdentity, metadata: { compilerCode: diagnosticCode, diagnosticIdentity } }
      ],
      diagnosticNodeIds: [diagnosticNodeId],
      execution: { state: "not_executed" }
    },
    selection: {
      schema: "scce.workspace.transformation_family_selection.v1",
      graphId,
      selected: {
        familyId: "repair.family.typescript.code_action.v1",
        candidateId: "candidate-1",
        diagnosticIdentity,
        codeFixIdentity: "code-fix-1",
        diagnosticNodeId,
        patchPlan: plan,
        execution: { state: "not_executed" }
      },
      execution: { state: "not_executed" }
    },
    plan,
    validationPlan: request.validationPlan,
    authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
    execution: { state: "not_executed", receipt: null }
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonResponse(
  payload: unknown,
  options: { ok?: boolean; status?: number; declaredLength?: string | null } = {}
): HttpResponseLike {
  return textResponse(JSON.stringify(payload), options);
}

function textResponse(
  body: string,
  options: { ok?: boolean; status?: number; declaredLength?: string | null } = {}
): HttpResponseLike {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: name => name.toLowerCase() === "content-length" ? options.declaredLength ?? null : null
    },
    text: async () => body
  };
}
