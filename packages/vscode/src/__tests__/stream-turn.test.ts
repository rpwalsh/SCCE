import { afterEach, describe, expect, it, vi } from "vitest";
import { YoppClient, parseTurnStreamFrame, type TurnStreamFrame } from "../client.js";

describe("YoppClient.streamTurn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams progress frames and resolves with the result frame's value", async () => {
    const lines: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "accepted", taskId: "task-1", sequence: 1, streamUrl: "http://127.0.0.1:3873/api/turn/task/task-1/stream" },
      { schema: "scce.turn_stream.v1", type: "progress", taskId: "task-1", phase: "runtime.working", sequence: 2 },
      { schema: "scce.turn_stream.v1", type: "result", taskId: "task-1", sequence: 3, value: { answer: "Ada Lovelace was a mathematician." } }
    ];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => streamingResponse(lines));
    vi.stubGlobal("fetch", fetchMock);
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });
    const phases: string[] = [];

    const answer = await client.streamTurn(
      { text: "Who was Ada Lovelace?", sessionId: "session-1" },
      frame => { if (frame.type === "progress") phases.push(frame.phase ?? ""); }
    );

    expect(answer).toEqual({ answer: "Ada Lovelace was a mathematician." });
    expect(phases).toEqual(["runtime.working"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("http://127.0.0.1:3873/api/turn?stream=1");
    expect(init).toMatchObject({ method: "POST", headers: { accept: "application/x-ndjson", "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Who was Ada Lovelace?", sessionId: "session-1", conversationId: "session-1" });
  });

  it("reconnects to the server-issued streamUrl when the first connection ends without a terminal frame", async () => {
    const first: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "accepted", taskId: "task-2", sequence: 1, streamUrl: "http://127.0.0.1:3873/api/turn/task/task-2/stream" },
      { schema: "scce.turn_stream.v1", type: "progress", taskId: "task-2", phase: "runtime.graph_slice", sequence: 2 }
    ];
    const second: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "result", taskId: "task-2", sequence: 3, value: { answer: "Reconnected answer." } }
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingResponse(first))
      .mockResolvedValueOnce(streamingResponse(second));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const pending = client.streamTurn({ text: "hello", sessionId: "session-2" }, () => {});
    await vi.advanceTimersByTimeAsync(600);
    const answer = await pending;

    expect(answer).toEqual({ answer: "Reconnected answer." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3873/api/turn/task/task-2/stream?after=2");
    vi.useRealTimers();
  });

  it("rejects when the server emits an error frame", async () => {
    const lines: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "error", taskId: "task-3", sequence: 1, error: "runtime failure: no candidate selected" }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(lines)));
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    await expect(client.streamTurn({ text: "hello", sessionId: "session-3" }, () => {}))
      .rejects.toThrow("runtime failure: no candidate selected");
  });

  it("propagates abort signal cancellation instead of retrying", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new YoppClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    await expect(client.streamTurn({ text: "hello", sessionId: "session-4" }, () => {}, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseTurnStreamFrame", () => {
  it("parses a well-formed NDJSON line", () => {
    const frame = parseTurnStreamFrame(JSON.stringify({ schema: "scce.turn_stream.v1", type: "progress", phase: "runtime.working" }));
    expect(frame).toMatchObject({ type: "progress", phase: "runtime.working" });
  });

  it("rejects a non-JSON line", () => {
    expect(() => parseTurnStreamFrame("not json")).toThrow("non-JSON");
  });

  it("rejects a frame with an unrecognized type", () => {
    expect(() => parseTurnStreamFrame(JSON.stringify({ type: "mystery" }))).toThrow("unrecognized type");
  });
});

function streamingResponse(frames: readonly TurnStreamFrame[]): Response {
  const body = frames.map(frame => `${JSON.stringify(frame)}\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
