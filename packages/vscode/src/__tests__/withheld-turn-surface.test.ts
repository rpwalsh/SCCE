// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScceClient, ScceHttpError, ScceWithheldTurnError, type HttpTransport } from "../client.js";
import { WITHHELD_SURFACE_SCHEMA, withheldSurfaceView } from "../withheld-surface.js";

const NO_EVIDENCE = {
  schema: WITHHELD_SURFACE_SCHEMA,
  reasonId: "withheld.no_admitted_evidence",
  basisReasonIds: [],
  evidenceCount: 0,
  entailmentVerdict: "unsupported",
  epistemicForce: "insufficient_support",
  unresolvedRequirementIds: [],
  learningNeeds: [],
  components: []
};

describe("a withheld turn reaches the extension as a withhold, not as a failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects streamTurn with the typed withheld record when the terminal frame carries one", async () => {
    vi.stubGlobal("fetch", vi.fn(graphqlTurnFetch({
      status: 422, error: "runtime declined: no admissible answer surface", detail: NO_EVIDENCE
    })));
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const error = await client.streamTurn({ text: "thanks", sessionId: "session-w" }, () => {}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ScceWithheldTurnError);
    expect((error as ScceWithheldTurnError).reasonId).toBe("withheld.no_admitted_evidence");
    expect((error as ScceWithheldTurnError).status).toBe(422);
  });

  it("still reports a runtime failure frame as a plain failure, never as a withhold", async () => {
    vi.stubGlobal("fetch", vi.fn(graphqlTurnFetch({ status: 500, error: "runtime failure: no candidate selected" })));
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const error = await client.streamTurn({ text: "hello", sessionId: "session-f" }, () => {}).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(ScceWithheldTurnError);
    expect(String((error as Error).message)).toContain("no candidate selected");
  });

  it("raises a withheld error, not a bare HTTP error, from a non-streaming 422 that carries the record", async () => {
    const transport: HttpTransport = async (_input, init) => {
      const request = JSON.parse(String(init.body)) as { operationName: string };
      if (request.operationName === "VscodeRuntimeQuery") return graphqlResponse({ runtime: {
        protocolVersion: "scce.graphql.v1", generation: "host-generation", phase: "ready", ready: true
      } });
      return new Response(JSON.stringify({ errors: [{ message: "runtime declined: no admissible answer surface",
        extensions: { code: "UNPROCESSABLE", detail: NO_EVIDENCE } }], extensions: {
        protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test"
      } }), { status: 200, headers: { "content-type": "application/graphql-response+json" } });
    };
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 }, transport);

    const error = await client.workspaceAsk("C:\\Repo", "thanks").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ScceWithheldTurnError);
    expect(error).toBeInstanceOf(ScceHttpError);
    expect((error as ScceWithheldTurnError).reasonId).toBe("withheld.no_admitted_evidence");
  });

  it("renders a reason-derived surface for every reason id the kernel can emit", () => {
    for (const reasonId of ["withheld.no_admitted_evidence", "withheld.surface_refused"]) {
      const view = withheldSurfaceView({ ...NO_EVIDENCE, reasonId });
      expect(view, reasonId).toBeDefined();
      expect(view?.reasonId).toBe(reasonId);
      // Not an empty bubble, and not the generic "no answer" filler the view falls back to.
      expect(view?.reasonId, reasonId).toBe(reasonId);
    }
    expect(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "withheld.no_admitted_evidence" })?.reasonId)
      .not.toBe(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "withheld.surface_refused" })?.reasonId);
  });

  it("refuses to render anything for a payload that is not a withheld record", () => {
    expect(withheldSurfaceView(undefined)).toBeUndefined();
    expect(withheldSurfaceView({ schema: "invalid.surface.v1", reasonId: "withheld.no_admitted_evidence" })).toBeUndefined();
    expect(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "" })).toBeUndefined();
  });
});

function graphqlTurnFetch(terminal: { status: number; error: string; detail?: unknown }) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, any> };
    if (request.operationName === "VscodeRuntimeQuery") {
      return graphqlResponse({ runtime: { protocolVersion: "scce.graphql.v1", generation: "host-generation", phase: "ready", ready: true } });
    }
    if (request.operationName === "VscodeReserveTurnMutation" || request.operationName === "VscodeStartTurnMutation") {
      const field = request.operationName === "VscodeReserveTurnMutation" ? "reserveTurn" : "startTurn";
      return graphqlResponse({ [field]: { clientMutationId: request.variables.input.clientMutationId,
        task: { id: "task-node-id", status: field === "reserveTurn" ? "accepted" : "running", latestSequence: 2, persistence: "durable" } } });
    }
    const data = { turnTaskUpdated: {
      id: "task-node-id", status: "failed", latestSequence: 3, persistence: "durable",
      latestFrame: { id: "frame-3", sequence: 3, kind: "error", phase: null, answer: null,
        error: terminal.error, observedAt: 3, status: terminal.status, elapsedMs: null,
        value: null, detail: terminal.detail ?? null, assistantForce: null },
      result: { id: "result", answer: null, error: terminal.error, httpStatus: terminal.status,
        value: null, detail: terminal.detail ?? null }
    } };
    const body = `event: next\ndata: ${JSON.stringify(graphqlEnvelope(data))}\n\nevent: complete\ndata: {}\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

function graphqlResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(graphqlEnvelope(data)), { status: 200,
    headers: { "content-type": "application/graphql-response+json" } });
}

function graphqlEnvelope(data: Record<string, unknown>) {
  return { data, extensions: { protocolVersion: "scce.graphql.v1", generation: "host-generation", requestId: "request-test" } };
}
