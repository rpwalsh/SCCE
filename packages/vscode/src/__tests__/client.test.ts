import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { type HttpResponseLike, type HttpTransport, YoppClient, YoppHttpError } from "../client.js";
import { parseReviewedPatchPlan } from "../patch-protocol.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface RecordedRequest {
  input: string;
  init: RequestInit;
}

describe("YoppClient HTTP boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the normalized loopback origin, bearer token, and fixed endpoint methods", async () => {
    const requests: RecordedRequest[] = [];
    const transport: HttpTransport = async (input, init) => {
      requests.push({ input, init });
      if (input.endsWith("/api/ready")) {
        return jsonResponse({ ok: true, postgres: { ok: true }, serverUrl: "http://127.0.0.1:3873", manifest: 11 });
      }
      if (input.endsWith("/api/workspace/init")) return jsonResponse({ initialized: true });
      if (input.endsWith("/api/workspace/ingest")) {
        return jsonResponse({
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
        });
      }
      if (input.endsWith("/api/workspace/ask")) {
        return jsonResponse({
          schema: "scce.workspace.answer.v1",
          question: "Where is the proof?",
          answer: "In source span 1.",
          confidence: 0.8,
          sourceRefs: []
        });
      }
      if (input.includes("/api/project/summary?")) {
        return jsonResponse({ schema: "scce.project.summary.v1", workspace: {}, summary: {} });
      }
      if (input.endsWith("/api/workspace/sources")) return jsonResponse({ workspace: { id: "workspace-1", rootPath: "C:\\My Repo", updatedAt: 10 }, sources: [] });
      throw new Error(`unexpected request ${input}`);
    };
    const client = new YoppClient(
      { serverUrl: " http://127.42.1.9:3873/ ", token: " local-secret ", timeoutMs: 10_000 },
      transport
    );

    await client.ready();
    await client.workspaceInitialize(" C:\\My Repo ");
    await client.workspaceIngest(" C:\\My Repo ");
    await client.workspaceAsk(" C:\\My Repo ", "  Where is the proof?  ");
    await client.projectSummary(" C:\\My Repo ");
    await client.workspaceStatus();

    expect(requests.map(request => [request.init.method, request.input])).toEqual([
      ["GET", "http://127.42.1.9:3873/api/ready"],
      ["POST", "http://127.42.1.9:3873/api/workspace/init"],
      ["POST", "http://127.42.1.9:3873/api/workspace/ingest"],
      ["POST", "http://127.42.1.9:3873/api/workspace/ask"],
      ["GET", "http://127.42.1.9:3873/api/project/summary?path=C%3A%5CMy%20Repo"],
      ["GET", "http://127.42.1.9:3873/api/workspace/sources"]
    ]);
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({ Accept: "application/json", Authorization: "Bearer local-secret" });
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(requests[0]?.init.body).toBeUndefined();
    expect(requests[0]?.init.headers).not.toHaveProperty("Content-Type");
    expect(requests[1]?.init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requests[1]?.init.body).toBe(JSON.stringify({ path: "C:\\My Repo" }));
    expect(requests[2]?.init.body).toBe(JSON.stringify({ path: "C:\\My Repo" }));
    expect(requests[3]?.init.body).toBe(JSON.stringify({ path: "C:\\My Repo", question: "Where is the proof?" }));
    expect(requests[4]?.init.body).toBeUndefined();
    expect(requests[5]?.init.body).toBeUndefined();
  });

  it("omits authorization when no token is configured", async () => {
    let observedHeaders: RequestInit["headers"];
    const client = new YoppClient({ serverUrl: "http://localhost:3873", timeoutMs: 1_000 }, async (_input, init) => {
      observedHeaders = init.headers;
      return jsonResponse({ workspace: { id: "workspace-1", rootPath: "C:\\repo", updatedAt: 10 }, sources: [] });
    });

    await client.workspaceStatus();

    expect(observedHeaders).toEqual({ Accept: "application/json" });
  });

  it("rejects empty workspace paths and questions before making a request", () => {
    const transport = vi.fn<HttpTransport>();
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

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

  it("uses the fixed two-phase patch routes and sends no client root or command line", async () => {
    const requests: RecordedRequest[] = [];
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export {};\n"));
    let patchAttempts = 0;
    const transport: HttpTransport = async (input, init) => {
      requests.push({ input, init });
      if (input.endsWith("/api/workspace/patch")) {
        patchAttempts += 1;
        if (patchAttempts === 1) return jsonResponse({
          ok: false,
          pendingApproval: {
            planId: "approval-1",
            capabilityId: "workspace.patch.apply",
            fingerprint: "a".repeat(64),
            reason: "operator-approval-required",
            createdAt: 1
          },
          session: {}
        }, { status: 202 });
        return jsonResponse({
          schemaVersion: "yopp.workspace-patch-response.v1",
          workspaceId: "workspace-1",
          validationPolicyId: "trusted-host-pnpm-validate.v1",
          receipt: fixtureReceipt(plan)
        });
      }
      if (input.endsWith("/api/session/approve")) return jsonResponse({ approved: { planId: "approval-1", capabilityId: "workspace.patch.apply" }, session: {} });
      throw new Error(`unexpected request ${input}`);
    };
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

    const pending = await client.workspacePatch("workspace-1", plan);
    expect("pendingApproval" in pending && pending.pendingApproval.planId).toBe("approval-1");
    await client.approveWorkspacePatch("approval-1");
    const applied = await client.workspacePatch("workspace-1", plan);
    expect("receipt" in applied && applied.receipt.planHash).toBe(plan.planHash);

    const firstBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(firstBody).toEqual({ schemaVersion: "yopp.workspace-patch-request.v1", workspaceId: "workspace-1", plan, validationPolicyId: "trusted-host-pnpm-validate.v1" });
    expect(firstBody).not.toHaveProperty("workspaceRoot");
    expect(firstBody).not.toHaveProperty("executable");
    expect(requests.map(request => request.input)).toEqual([
      "http://127.0.0.1:3873/api/workspace/patch",
      "http://127.0.0.1:3873/api/session/approve",
      "http://127.0.0.1:3873/api/workspace/patch"
    ]);
  });

  it("rejects internally valid patch receipts that are partial or do not match the reviewed operation", async () => {
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export {};\n"));
    const response = (receipt: unknown) => jsonResponse({
      schemaVersion: "yopp.workspace-patch-response.v1",
      workspaceId: "workspace-1",
      validationPolicyId: "trusted-host-pnpm-validate.v1",
      receipt
    });

    await expect(clientWithResponse(response(fixtureReceipt(plan, { omitMutation: true }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/mutation count/u);
    await expect(clientWithResponse(response(fixtureReceipt(plan, { mutationPath: "src/other.ts" }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/path does not match/u);
    await expect(clientWithResponse(response(fixtureReceipt(plan, { omitValidation: true }))).workspacePatch("workspace-1", plan)).rejects.toThrow(/missing.*validation receipt/u);
  });

  it("submits a bounded coding request and verifies the returned content-addressed plan trace", async () => {
    const requests: RecordedRequest[] = [];
    const plan = parseReviewedPatchPlan(fixturePlan("src/new.ts", "export const value = 2;\n"));
    const transport: HttpTransport = async (input, init) => {
      requests.push({ input, init });
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(fixtureCodingGeneration(plan, request));
    };
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, transport);

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
    expect(requests.map(request => [request.init.method, request.input])).toEqual([
      ["POST", "http://127.0.0.1:3873/api/workspace/patch/plan/request"]
    ]);
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
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
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, async (_input, init) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      const generation = fixtureCodingGeneration(plan, request);
      const requestNode = generation.constraintGraph.nodes.find(node => node.kindId === "scce.task.request.v1")!;
      requestNode.metadata.requestedPaths = ["src/other.ts"];
      return jsonResponse(generation);
    });

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

    await expect(client.workspaceStatus()).rejects.toThrow("Yopp response exceeded the extension size limit");
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects an actual UTF-8 response body above the limit", async () => {
    const oversizedJson = JSON.stringify("x".repeat(MAX_RESPONSE_BYTES));
    expect(Buffer.byteLength(oversizedJson, "utf8")).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const client = clientWithResponse(textResponse(oversizedJson));

    await expect(client.workspaceStatus()).rejects.toThrow("Yopp response exceeded the extension size limit");
  });

  it("rejects invalid JSON without invoking a protocol parser", async () => {
    const client = clientWithResponse(textResponse("not-json"));

    await expect(client.workspaceStatus()).rejects.toThrow("Yopp server returned invalid JSON");
  });

  it("raises a typed HTTP error with a bounded server message", async () => {
    const client = clientWithResponse(jsonResponse({ error: "permission denied" }, { ok: false, status: 403 }));

    const rejection = client.workspaceStatus();
    await expect(rejection).rejects.toBeInstanceOf(YoppHttpError);
    await expect(rejection).rejects.toMatchObject({
      name: "YoppHttpError",
      status: 403,
      message: "Yopp request failed (403): permission denied"
    });
  });

  it("uses a status-only HTTP error when the payload has no safe error string", async () => {
    const client = clientWithResponse(jsonResponse({ error: { detail: "private" } }, { ok: false, status: 500 }));

    await expect(client.workspaceStatus()).rejects.toMatchObject({
      name: "YoppHttpError",
      status: 500,
      message: "Yopp request failed (500)"
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
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1 }, transport);

    const assertion = expect(client.workspaceStatus()).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(999);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });
});

function clientWithResponse(response: HttpResponseLike): YoppClient {
  return new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 1_000 }, async () => response);
}

function fixturePlan(path: string, content: string): unknown {
  const afterContentHash = sha256(content);
  const operations = [{ kind: "create", path, beforeContentHash: null, afterContentHash, content }];
  return { schemaVersion: "yopp.patch-transaction-plan.v1", operations, planHash: sha256(JSON.stringify(canonical({ schemaVersion: "yopp.patch-transaction-plan.v1", operations }))) };
}

function fixtureReceipt(
  plan: ReturnType<typeof parseReviewedPatchPlan>,
  options: { mutationPath?: string; omitMutation?: boolean; omitValidation?: boolean } = {}
): unknown {
  const operation = plan.operations[0]!;
  const mutationPayload = {
    schemaVersion: "yopp.patch-mutation-receipt.v1",
    planHash: plan.planHash,
    operationIndex: 0,
    kind: operation.kind,
    path: options.mutationPath ?? operation.path,
    beforeContentHash: operation.beforeContentHash,
    afterContentHash: operation.afterContentHash
  };
  const mutations = options.omitMutation ? [] : [{ ...mutationPayload, mutationHash: sha256(JSON.stringify(canonical(mutationPayload))) }];
  const payload = {
    schemaVersion: "yopp.patch-transaction-receipt.v1",
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
