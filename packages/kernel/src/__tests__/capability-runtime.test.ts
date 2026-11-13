// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createRuntimeCapabilities, invokeRuntimeCapability, requireCapabilityResult } from "../capability-runtime.js";
import { createConnectorCapabilityOperations, restoreFetchedCapabilityResult } from "../connector-capabilities.js";
import { createCapabilityRegistry } from "../safety.js";
import type { ConnectorPort } from "../storage.js";
import type { BuildTestResult, JsonValue } from "../types.js";
import { capabilityRuntimeFixture } from "./fixtures/capability-runtime.js";

const request = { episodeId: "episode.capability.test", taskId: "task.capability.test", ownerId: "owner.test", policyVersionId: "policy.test", approved: true };

describe("shared runtime capability execution", () => {
  it("keeps compiler diagnostics in one result blob and preserves the existing compact learning observation", async () => {
    const durable = capabilityRuntimeFixture();
    let calls = 0;
    const diagnostic = "complete-provider-diagnostic-語".repeat(1000);
    const result: BuildTestResult = { build: { code: 0, stdout: diagnostic, stderr: "", durationMs: 1 },
      test: { code: 7, stdout: "", stderr: diagnostic, durationMs: 2 }, passed: false, repairAttempted: false, repairApplied: false, artifacts: [] };
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ blobs: durable.blobs, capabilities: createCapabilityRegistry({ process: true }).all(),
        buildTest: { executeProgram: async () => { calls++; return result; } } }) });
    const operation = { ...request, capabilityId: "process.build_test", payload: { episodeId: request.episodeId,
      construct: { id: "construct.observation", program: { id: "program.observation" }, artifacts: [] } },
      operatorOutcome: { conversationId: "conversation.observation", operatorIds: [], typedInputState: {}, predictedDelta: { passed: true } } };
    const failed = await invokeRuntimeCapability({ ...operation, capabilities: restart() });
    expect(failed.disposition).toBe("failed");
    expect(failed.observation?.result).toEqual(result);
    expect(failed.receipt?.evidenceRefs).toEqual(["build_test.build.code.0", "build_test.test.code.7"]);
    expect(failed.receipt?.operatorObservation?.actualDelta).toEqual({ programId: "program.observation", buildCode: 0, testCode: 7, passed: false, artifacts: [] });
    expect(JSON.stringify(failed.state)).not.toContain(diagnostic);
    expect(durable.values.size).toBe(1);
    const replay = await invokeRuntimeCapability({ ...operation, capabilities: restart() });
    expect(replay.observation).toEqual(failed.observation);
    expect(calls).toBe(1);
  });

  it("recovers complete search and OCR fetch results after restart without executing either again", async () => {
    const durable = capabilityRuntimeFixture();
    let searches = 0, fetches = 0;
    const raw = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const extracted = "韓国語の観測記録：旗はこの人物より前から存在した。";
    const rows = [{ uri: "https://source.invalid/scan.pdf", title: "Observations", snippet: "A lead is not admitted evidence", metadata: { lineage: "archive" } }];
    const connectors: ConnectorPort = {
      async search() { searches++; return rows; },
      async fetch(uri) { fetches++; return { uri, mediaType: "application/pdf", bytes: raw, metadata: { extractor: "ocr", structure: { pages: 1 } },
        evidenceDerivative: { bytes: new TextEncoder().encode(extracted), text: extracted, kind: "extracted-text", transformId: "fixture.ocr",
          originalCoordinateSpace: "source-bytes", redactionMap: [] } }; }
    };
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ network: true }).all() }) });
    const search = { ...request, capabilityId: "network.search", payload: { query: "旗", limit: 7 } };
    expect(requireCapabilityResult(await invokeRuntimeCapability({ ...search, capabilities: restart() }))).toEqual(rows);
    expect(requireCapabilityResult(await invokeRuntimeCapability({ ...search, capabilities: restart() }))).toEqual(rows);
    const fetch = { ...request, taskId: "task.fetch", capabilityId: "network.fetch", payload: { uri: rows[0]!.uri } };
    const first = requireCapabilityResult(await invokeRuntimeCapability({ ...fetch, capabilities: restart() }));
    const replay = requireCapabilityResult(await invokeRuntimeCapability({ ...fetch, capabilities: restart() }));
    expect(replay).toEqual(first);
    const restored = await restoreFetchedCapabilityResult(replay, durable.blobs);
    expect(restored.bytes).toEqual(raw);
    expect(restored.evidenceDerivative?.bytes).toEqual(new TextEncoder().encode(extracted));
    expect(restored.evidenceDerivative?.text).toBe(extracted);
    expect(restored.metadata).toEqual({ extractor: "ocr", structure: { pages: 1 } });
    expect({ searches, fetches }).toEqual({ searches: 1, fetches: 1 });
    expect([...durable.values.values()].filter(bytes => new TextDecoder().decode(bytes) === extracted)).toHaveLength(1);
  });

  it("waits for approval, sends exactly once, and recovers its result at any later clock time", async () => {
    const durable = capabilityRuntimeFixture();
    let calls = 0, now = 1;
    const connectors = { outlookSendDraft: async (messageId: string, approved?: boolean): Promise<JsonValue> => {
      expect(approved).toBe(true); calls++; return { id: messageId, sent: true, providerReceipt: "receipt.123" };
    } } as ConnectorPort;
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs, now: () => now,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ outlook: true }).all() }) });
    const send = { ...request, capabilityId: "outlook.send_mail", payload: { messageId: "draft.123" } };
    expect((await invokeRuntimeCapability({ ...send, approved: false, capabilities: restart() })).blockedStatus).toBe("awaiting_approval");
    expect(calls).toBe(0);
    const first = await invokeRuntimeCapability({ ...send, capabilities: restart() });
    expect(requireCapabilityResult(first)).toEqual({ id: "draft.123", sent: true, providerReceipt: "receipt.123" });
    now += 24 * 60 * 60 * 1000;
    expect(requireCapabilityResult(await invokeRuntimeCapability({ ...send, capabilities: restart() }))).toEqual(first.observation?.result);
    expect(calls).toBe(1);
    await expect(invokeRuntimeCapability({ ...send, capabilities: restart(), payload: { messageId: "different.draft" } })).rejects.toThrow(/identity reused/);
    await expect(invokeRuntimeCapability({ ...send, capabilities: restart(), ownerId: "other.owner" })).rejects.toThrow(/owner differs/);
    expect(calls).toBe(1);
  });

  it("keeps a call with an unknown provider outcome indeterminate across restart and never retries it directly", async () => {
    const durable = capabilityRuntimeFixture();
    let calls = 0;
    const connectors = { telephoneCall: async () => { calls++; throw new Error("provider reply was lost after connection"); } } as unknown as ConnectorPort;
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ telephone: true }).all() }) });
    const call = { ...request, capabilityId: "telephone.call", payload: { to: "+15551234567", twiml: "<Response/>" } };
    const first = await invokeRuntimeCapability({ ...call, capabilities: restart() });
    expect(first.disposition).toBe("indeterminate");
    expect(first.observation?.error).toContain("provider reply was lost");
    expect(() => requireCapabilityResult(first)).toThrow(/provider reply was lost/);
    expect((await invokeRuntimeCapability({ ...call, capabilities: restart() })).disposition).toBe("indeterminate");
    expect(calls).toBe(1);
  });

  it.each(["draft", "calendar"])("recovers a partial %s result and compensates once after a cold runtime restart", async kind => {
    const durable = capabilityRuntimeFixture();
    const deleted: string[] = [];
    let creates = 0;
    const partial = async () => { creates++; throw Object.assign(new Error("provider created the resource before its acknowledgement failed"), { messageId: "remote.created.1" }); };
    const remove = async (id: string, approved: boolean) => { expect(approved).toBe(true); deleted.push(id); return { id, deleted: true }; };
    const connectors = (kind === "draft" ? { outlookCreateDraft: partial, outlookDeleteDraft: remove }
      : { outlookCreateCalendarEvent: partial, outlookDeleteCalendarEvent: remove }) as unknown as ConnectorPort;
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ outlook: true }).all() }) });
    const payload: JsonValue = kind === "draft" ? { to: ["person@example.invalid"], subject: "記録", body: "旗" }
      : { subject: "記録", start: "2026-11-13T09:00:00Z", end: "2026-11-13T10:00:00Z" };
    const operation = { ...request, capabilityId: kind === "draft" ? "outlook.create_draft" : "outlook.create_calendar_event", payload };
    const failed = await invokeRuntimeCapability({ ...operation, capabilities: restart() });
    expect(failed.disposition).toBe("failed");
    expect(failed.observation?.result).toEqual({ id: "remote.created.1" });
    expect((await restart().rollback(request)).disposition).toBe("rolled_back");
    expect((await restart().rollback(request)).disposition).toBe("rolled_back");
    expect(deleted).toEqual(["remote.created.1"]);
    expect(creates).toBe(1);
  });

  it("rejects malformed or unavailable operations before opening an executive episode", async () => {
    const durable = capabilityRuntimeFixture();
    let calls = 0;
    const connectors = { telephoneCall: async () => { calls++; return {}; } } as unknown as ConnectorPort;
    const build = (configured: boolean) => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs, capabilities: createCapabilityRegistry({ telephone: configured }).all() }) });
    await expect(invokeRuntimeCapability({ ...request, capabilities: build(true), capabilityId: "telephone.call", payload: { to: "+15551234567", twiml: 42 } })).rejects.toThrow(/twiml requires string/);
    await expect(invokeRuntimeCapability({ ...request, capabilities: build(false), capabilityId: "telephone.call", payload: { to: "+15551234567", twiml: "<Response/>" } })).rejects.toThrow(/unavailable/);
    expect((await durable.executive().load(request.episodeId)).status).toBe("unopened");
    expect(calls).toBe(0);
  });
});
