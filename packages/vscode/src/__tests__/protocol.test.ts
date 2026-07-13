import { describe, expect, it } from "vitest";
import { EXTENSION_PROTOCOL_SCHEMA, parseExtensionMessage, parseReadyResponse, parseWorkspaceAnswerResponse, parseWorkspaceIngestResponse } from "../protocol.js";

describe("VS Code protocol validation", () => {
  it("accepts the versioned internal readiness message", () => {
    expect(parseExtensionMessage({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "readiness", ready: true, serverUrl: "http://127.0.0.1:8787", observedAt: 1 })).toEqual({
      schema: EXTENSION_PROTOCOL_SCHEMA,
      kind: "readiness",
      ready: true,
      serverUrl: "http://127.0.0.1:8787",
      observedAt: 1
    });
  });

  it("rejects wrong versions and unknown message kinds", () => {
    expect(() => parseExtensionMessage({ schema: "yopp.vscode.message.v2", kind: "readiness", ready: true, serverUrl: "local", observedAt: 1 })).toThrow(/schema/);
    expect(() => parseExtensionMessage({ schema: EXTENSION_PROTOCOL_SCHEMA, kind: "secret", observedAt: 1 })).toThrow(/kind/);
  });

  it("validates readiness and workspace response contracts", () => {
    expect(parseReadyResponse({ ok: true, postgres: {}, serverUrl: "http://127.0.0.1:8787", manifest: 54 }).ok).toBe(true);
    expect(parseWorkspaceAnswerResponse({ schema: "scce.workspace.answer.v1", question: "q", answer: "a", confidence: 0.8, sourceRefs: [] }).answer).toBe("a");
    expect(parseWorkspaceIngestResponse({
      schema: "scce.workspace.ingest.v1",
      importBatchId: "batch-1",
      ingested: 1,
      unchanged: 2,
      changed: 3,
      missing: 0,
      failed: 0,
      unsupported: 0,
      workspace: {},
      project: {}
    }).changed).toBe(3);
  });

  it("rejects incomplete, unversioned, and negative response data", () => {
    expect(() => parseReadyResponse({ ok: true })).toThrow();
    expect(() => parseWorkspaceAnswerResponse({ schema: "scce.workspace.answer.v2", question: "q", answer: "a", confidence: 1, sourceRefs: [] })).toThrow(/schema/);
    expect(() => parseWorkspaceIngestResponse({ schema: "scce.workspace.ingest.v1", importBatchId: "x", ingested: -1 })).toThrow();
  });
});
