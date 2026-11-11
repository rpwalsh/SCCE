// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScceClient } from "../client.js";

const GENERATION = "host-generation";
const TASK_ID = "registered-local-task-id";

describe("ScceClient.streamTurn GraphQL task transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reserves and starts once, streams typed SSE updates, and preserves the complete TurnAnswer", async () => {
    const answerValue = {
      answer: "Ada Lovelace was a mathematician.",
      dialogue: { conversationId: "session-1", turnId: "turn-1" },
      evidence: [{ id: "evidence-1", sourceId: "source-1", textPreview: "Ada wrote notes.", provenance: { byteStart: 4 } }],
      guardFlags: { sourceBacked: true },
      proofCarryingAnswer: { proofId: "proof-1" },
      index: { selectedEvidenceIds: ["evidence-1"] }
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
      if (request.operationName === "VscodeReserveTurnMutation") return mutationResponse("reserveTurn", request, "accepted", 1);
      if (request.operationName === "VscodeStartTurnMutation") return mutationResponse("startTurn", request, "running", 2);
      if (request.operationName === "VscodeTurnTaskSubscription") return subscriptionResponse([
        taskUpdate(1, "accepted"),
        taskUpdate(2, "progress", { phase: "runtime.working" }),
        taskUpdate(3, "result", { result: { value: answerValue, answer: answerValue.answer, httpStatus: 200 } })
      ], true);
      throw new Error(`unexpected operation ${request.operationName}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });
    const phases: string[] = [];

    const answer = await client.streamTurn(
      { text: "Who was Ada Lovelace?", sessionId: "session-1" },
      frame => { if (frame.type === "progress") phases.push(frame.phase ?? ""); }
    );

    expect(answer).toEqual(answerValue);
    expect(phases).toEqual(["runtime.working"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(call => String(call[0]) === "http://127.0.0.1:3873/api/graphql")).toBe(true);
    const requests = fetchMock.mock.calls.map(call => requestBody(call[1]));
    expect(requests.map(request => request.operationName)).toEqual([
      "VscodeRuntimeQuery", "VscodeReserveTurnMutation", "VscodeStartTurnMutation", "VscodeTurnTaskSubscription"
    ]);
    expect(requests[2]?.variables).toMatchObject({ input: {
      operationId: TASK_ID,
      text: "Who was Ada Lovelace?",
      sessionId: "session-1",
      conversationId: "session-1"
    } });
    expect(requests[3]?.variables).toEqual({ id: TASK_ID, afterSequence: 0 });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({ accept: "text/event-stream", "content-type": "application/json" });
  });

  it("reconnects the same registered subscription after the last observed sequence without reserving or starting again", async () => {
    let subscriptions = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
      if (request.operationName === "VscodeReserveTurnMutation") return mutationResponse("reserveTurn", request, "accepted", 1);
      if (request.operationName === "VscodeStartTurnMutation") return mutationResponse("startTurn", request, "running", 2);
      if (request.operationName === "VscodeTurnTaskSubscription") {
        subscriptions++;
        return subscriptions === 1
          ? subscriptionResponse([taskUpdate(2, "progress", { phase: "runtime.graph_slice" })], false)
          : subscriptionResponse([taskUpdate(3, "result", { result: { value: { answer: "Reconnected answer." }, httpStatus: 200 } })], true);
      }
      throw new Error(`unexpected operation ${request.operationName}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const pending = client.streamTurn({ text: "hello", sessionId: "session-2" }, () => {});
    await vi.advanceTimersByTimeAsync(300);
    const answer = await pending;

    expect(answer).toEqual({ answer: "Reconnected answer." });
    const requests = fetchMock.mock.calls.map(call => requestBody(call[1]));
    expect(requests.filter(request => request.operationName === "VscodeReserveTurnMutation")).toHaveLength(1);
    expect(requests.filter(request => request.operationName === "VscodeStartTurnMutation")).toHaveLength(1);
    expect(requests.filter(request => request.operationName === "VscodeTurnTaskSubscription").map(request => request.variables))
      .toEqual([{ id: TASK_ID, afterSequence: 0 }, { id: TASK_ID, afterSequence: 2 }]);
  });

  it("rejects when the GraphQL task emits an error frame", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
      if (request.operationName === "VscodeReserveTurnMutation") return mutationResponse("reserveTurn", request, "accepted", 1);
      if (request.operationName === "VscodeStartTurnMutation") return mutationResponse("startTurn", request, "running", 2);
      return subscriptionResponse([taskUpdate(3, "error", { result: { error: "runtime failure: no candidate selected", httpStatus: 500 } })], true);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    await expect(client.streamTurn({ text: "hello", sessionId: "session-3" }, () => {}))
      .rejects.toThrow("runtime failure: no candidate selected");
  });

  it("turns an explicit AbortSignal into one registered cancellation for the reserved task", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.operationName === "VscodeRuntimeQuery") return runtimeResponse();
      if (request.operationName === "VscodeReserveTurnMutation") return mutationResponse("reserveTurn", request, "accepted", 1);
      if (request.operationName === "VscodeStartTurnMutation") return mutationResponse("startTurn", request, "running", 2);
      if (request.operationName === "VscodeCancelTurnMutation") return mutationResponse("cancelTurn", request, "cancelled", 3);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const pending = client.streamTurn({ text: "hello", sessionId: "session-4" }, () => {}, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const requests = fetchMock.mock.calls.map(call => requestBody(call[1]));
    expect(requests.filter(request => request.operationName === "VscodeCancelTurnMutation")).toHaveLength(1);
    expect(requests.at(-1)?.variables).toMatchObject({ input: { taskId: TASK_ID } });
  });
});

interface RequestEnvelope {
  operationName: string;
  generation?: string;
  variables: Record<string, unknown>;
}

function requestBody(init?: RequestInit): RequestEnvelope {
  return JSON.parse(String(init?.body)) as RequestEnvelope;
}

function runtimeResponse(): Response {
  return graphqlResponse({ runtime: { protocolVersion: "scce.graphql.v1", generation: GENERATION, phase: "ready", ready: true } });
}

function mutationResponse(field: "reserveTurn" | "startTurn" | "cancelTurn", request: RequestEnvelope, status: string, latestSequence: number): Response {
  const input = request.variables.input as Record<string, unknown>;
  return graphqlResponse({ [field]: {
    clientMutationId: input.clientMutationId,
    task: { id: TASK_ID, status, latestSequence, persistence: "durable" }
  } });
}

function taskUpdate(sequence: number, kind: "accepted" | "progress" | "result" | "error" | "cancelled", extra: {
  phase?: string;
  result?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return { turnTaskUpdated: {
    id: TASK_ID,
    status: kind === "result" ? "succeeded" : kind === "error" ? "failed" : kind === "cancelled" ? "cancelled" : kind === "progress" ? "running" : "accepted",
    latestSequence: sequence,
    persistence: "durable",
    latestFrame: { id: `frame-${sequence}`, sequence, kind, phase: extra.phase ?? null, answer: null, error: null, observedAt: sequence,
      status: null, elapsedMs: null, value: null, detail: null, assistantForce: null },
    result: extra.result ?? null
  } };
}

function graphqlResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, extensions: {
    protocolVersion: "scce.graphql.v1", generation: GENERATION, requestId: "request-test"
  } }), { status: 200, headers: { "content-type": "application/graphql-response+json" } });
}

function subscriptionResponse(updates: readonly Record<string, unknown>[], complete: boolean): Response {
  const body = updates.map(data => `event: next\ndata: ${JSON.stringify({ data, extensions: {
    protocolVersion: "scce.graphql.v1", generation: GENERATION, requestId: "request-test"
  } })}\n\n`).join("") + (complete ? "event: complete\ndata: {}\n\n" : "");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
