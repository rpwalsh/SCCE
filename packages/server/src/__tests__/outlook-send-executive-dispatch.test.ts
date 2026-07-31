import { describe, expect, it } from "vitest";
import {
  createDurableExecutiveEpisode,
  createExecutiveEpisodeMachine,
  createHasher,
  type ExecutiveEpisodeId,
  type ExecutiveEvent,
  type ExecutiveEventJournal,
  type ExecutiveJournalAppend,
  type ExecutiveJournalAppendResult,
  type ExecutiveJournalSnapshot,
  type JsonValue
} from "@scce/kernel";
import { dispatchOutlookSendDraftThroughExecutive } from "../routes.js";

// Same in-memory journal fixture pattern as outlook-draft-executive-dispatch.test.ts.
class MemoryExecutiveJournal implements ExecutiveEventJournal {
  private readonly events = new Map<ExecutiveEpisodeId, ExecutiveEvent[]>();
  private readonly commands = new Map<ExecutiveEpisodeId, Set<string>>();

  async read(episodeId: ExecutiveEpisodeId): Promise<ExecutiveJournalSnapshot> {
    const events = this.events.get(episodeId) ?? [];
    return { episodeId, revision: events.length, events: structuredClone(events) };
  }

  async append(input: ExecutiveJournalAppend): Promise<ExecutiveJournalAppendResult> {
    const events = this.events.get(input.episodeId) ?? [];
    const commands = this.commands.get(input.episodeId) ?? new Set<string>();
    if (commands.has(input.commandId)) return { status: "duplicate", revision: events.length };
    if (events.length !== input.expectedRevision) return { status: "conflict", revision: events.length };
    this.events.set(input.episodeId, [...events, ...structuredClone(input.events)]);
    commands.add(input.commandId);
    this.commands.set(input.episodeId, commands);
    return { status: "appended", revision: events.length + input.events.length };
  }
}

function executiveFixture() {
  const journal = new MemoryExecutiveJournal();
  const machine = createExecutiveEpisodeMachine(createHasher());
  return createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 1 });
}

function fakeConnectors(options: { sendFails?: boolean } = {}) {
  let sendCalls = 0;
  return {
    sendCalls: () => sendCalls,
    outlookSendDraft: async (messageId: string): Promise<JsonValue> => {
      sendCalls++;
      if (options.sendFails) throw new Error("simulated Graph API send failure");
      return { id: messageId, sent: true };
    }
  };
}

describe("outlook send-draft routed through the durable executive dispatcher (plan item 207)", () => {
  it("performs the real send and returns the real result", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.1", ownerId: "test.owner" });
    expect(result).toEqual({ id: "message.1", sent: true });
    expect(connectors.sendCalls()).toBe(1);
  });

  it("a retried dispatch for the same messageId replays as a duplicate, never sending twice", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const first = await dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.1", ownerId: "test.owner" });
    const second = await dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.1", ownerId: "test.owner" });
    expect(first).toEqual(second);
    expect(connectors.sendCalls()).toBe(1);
  });

  it("a different messageId is a genuinely new dispatch, not deduplicated against the first", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.1", ownerId: "test.owner" });
    await dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.2", ownerId: "test.owner" });
    expect(connectors.sendCalls()).toBe(2);
  });

  it("propagates a real send failure rather than fabricating success", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ sendFails: true });
    await expect(dispatchOutlookSendDraftThroughExecutive({ executive, connectors, messageId: "message.1", ownerId: "test.owner" })).rejects.toThrow(/simulated Graph API send failure/);
  });

  it("a retry within the idempotency window after a genuine failure stays failed (the window is real, not instantaneous)", async () => {
    const executive = executiveFixture();
    const failingConnectors = fakeConnectors({ sendFails: true });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchOutlookSendDraftThroughExecutive({ executive, connectors: failingConnectors, messageId: "message.1", ownerId: "test.owner", now: windowStart })).rejects.toThrow();

    const recoveredConnectors = fakeConnectors();
    await expect(dispatchOutlookSendDraftThroughExecutive({ executive, connectors: recoveredConnectors, messageId: "message.1", ownerId: "test.owner", now: windowStart + 1_000 })).rejects.toThrow(/disposition: failed/);
    expect(recoveredConnectors.sendCalls()).toBe(0);
  });

  it("retrying after a genuine failure in a later idempotency window sends for real once the connector recovers", async () => {
    const executive = executiveFixture();
    const failingConnectors = fakeConnectors({ sendFails: true });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchOutlookSendDraftThroughExecutive({ executive, connectors: failingConnectors, messageId: "message.1", ownerId: "test.owner", now: windowStart })).rejects.toThrow();

    const recoveredConnectors = fakeConnectors();
    const retried = await dispatchOutlookSendDraftThroughExecutive({ executive, connectors: recoveredConnectors, messageId: "message.1", ownerId: "test.owner", now: windowStart + 5 * 60 * 1000 });
    expect(retried).toEqual({ id: "message.1", sent: true });
    expect(recoveredConnectors.sendCalls()).toBe(1);
  });
});
