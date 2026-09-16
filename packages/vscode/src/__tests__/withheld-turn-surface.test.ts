// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScceClient, ScceHttpError, ScceWithheldTurnError, type HttpTransport, type TurnStreamFrame } from "../client.js";
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
    const lines: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "error", taskId: "task-w", sequence: 1, status: 422, error: "runtime declined: no admissible answer surface", detail: NO_EVIDENCE }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(lines)));
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const error = await client.streamTurn({ text: "thanks", sessionId: "session-w" }, () => {}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ScceWithheldTurnError);
    expect((error as ScceWithheldTurnError).reasonId).toBe("withheld.no_admitted_evidence");
    expect((error as ScceWithheldTurnError).status).toBe(422);
  });

  it("still reports a runtime failure frame as a plain failure, never as a withhold", async () => {
    const lines: TurnStreamFrame[] = [
      { schema: "scce.turn_stream.v1", type: "error", taskId: "task-f", sequence: 1, status: 500, error: "runtime failure: no candidate selected" }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(lines)));
    const client = new ScceClient({ serverUrl: "http://127.0.0.1:3873", timeoutMs: 5_000 });

    const error = await client.streamTurn({ text: "hello", sessionId: "session-f" }, () => {}).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(ScceWithheldTurnError);
    expect(String((error as Error).message)).toContain("no candidate selected");
  });

  it("raises a withheld error, not a bare HTTP error, from a non-streaming 422 that carries the record", async () => {
    const transport: HttpTransport = async input => {
      if (input.endsWith("/api/workspace/ask")) {
        return jsonResponse({ ok: false, status: 422, error: "runtime declined: no admissible answer surface", detail: NO_EVIDENCE }, 422);
      }
      throw new Error(`unexpected request ${input}`);
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
      expect(/[\p{L}\p{N}]/u.test(view?.text ?? ""), reasonId).toBe(true);
      expect(view?.text).not.toContain("SCCE returned no answer");
    }
    expect(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "withheld.no_admitted_evidence" })?.text)
      .not.toBe(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "withheld.surface_refused" })?.text);
  });

  it("refuses to render anything for a payload that is not a withheld record", () => {
    expect(withheldSurfaceView(undefined)).toBeUndefined();
    expect(withheldSurfaceView({ schema: "scce.turn_stream.v1", reasonId: "withheld.no_admitted_evidence" })).toBeUndefined();
    expect(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "" })).toBeUndefined();
  });
});

function streamingResponse(frames: readonly TurnStreamFrame[]): Response {
  const body = frames.map(frame => `${JSON.stringify(frame)}\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function jsonResponse(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(Buffer.byteLength(body, "utf8")) : null) },
    text: async () => body
  };
}
