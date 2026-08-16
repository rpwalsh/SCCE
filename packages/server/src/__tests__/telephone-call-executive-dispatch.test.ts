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
import { dispatchTelephoneCallThroughExecutive } from "../routes.js";

// Same in-memory journal fixture pattern as the Outlook executive-dispatch tests.
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

function fakeConnectors(options: { callFails?: boolean } = {}) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    telephoneCall: async (to: string, twiml: string): Promise<JsonValue> => {
      callCount++;
      if (options.callFails) throw new Error("simulated Twilio call failure");
      return { to, twiml, sid: "CA_fake", status: "queued" };
    }
  };
}

const call = { to: "+15551234567", twiml: "<Response><Say>Hello</Say></Response>" };

describe("telephone call routed through the durable executive dispatcher (Phase 3/16, telephone gap)", () => {
  it("performs the real call and returns the real result", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchTelephoneCallThroughExecutive({ executive, connectors, call, ownerId: "test.owner" });
    expect(result).toEqual({ to: call.to, twiml: call.twiml, sid: "CA_fake", status: "queued" });
    expect(connectors.callCount()).toBe(1);
  });

  it("CRITICAL fix: a retried dispatch for the identical call content replays as a duplicate, never placing the call twice, and recovers the real original provider result -- not a placeholder that loses the SID/status", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const first = await dispatchTelephoneCallThroughExecutive({ executive, connectors, call, ownerId: "test.owner" });
    expect(first).toEqual({ to: call.to, twiml: call.twiml, sid: "CA_fake", status: "queued" });
    const second = await dispatchTelephoneCallThroughExecutive({ executive, connectors, call, ownerId: "test.owner" });
    // The real fix: the replay recovers the exact original connector
    // result (byte-identical to `first`) from the durable receipt,
    // instead of the old `{ to, dispatched: true }` placeholder that lost
    // the provider's real call SID/status a client would need to recover
    // the call's identity/status after a timeout-triggered retry.
    expect(second).toEqual(first);
    expect(connectors.callCount()).toBe(1);
  });

  it("a call with different content is a genuinely new dispatch, not deduplicated against the first", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchTelephoneCallThroughExecutive({ executive, connectors, call, ownerId: "test.owner" });
    await dispatchTelephoneCallThroughExecutive({ executive, connectors, call: { ...call, to: "+15559876543" }, ownerId: "test.owner" });
    expect(connectors.callCount()).toBe(2);
  });

  it("propagates a real call failure rather than fabricating success", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ callFails: true });
    await expect(dispatchTelephoneCallThroughExecutive({ executive, connectors, call, ownerId: "test.owner" })).rejects.toThrow(/simulated Twilio call failure/);
  });

  it("a retry within the idempotency window after a genuine failure stays failed (the window is real, not instantaneous)", async () => {
    const executive = executiveFixture();
    const failingConnectors = fakeConnectors({ callFails: true });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchTelephoneCallThroughExecutive({ executive, connectors: failingConnectors, call, ownerId: "test.owner", now: windowStart })).rejects.toThrow();

    const recoveredConnectors = fakeConnectors();
    await expect(dispatchTelephoneCallThroughExecutive({ executive, connectors: recoveredConnectors, call, ownerId: "test.owner", now: windowStart + 1_000 })).rejects.toThrow(/disposition: failed/);
    expect(recoveredConnectors.callCount()).toBe(0);
  });

  it("retrying after a genuine failure in a later idempotency window places the call for real once the connector recovers", async () => {
    const executive = executiveFixture();
    const failingConnectors = fakeConnectors({ callFails: true });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchTelephoneCallThroughExecutive({ executive, connectors: failingConnectors, call, ownerId: "test.owner", now: windowStart })).rejects.toThrow();

    const recoveredConnectors = fakeConnectors();
    const retried = await dispatchTelephoneCallThroughExecutive({ executive, connectors: recoveredConnectors, call, ownerId: "test.owner", now: windowStart + 5 * 60 * 1000 });
    expect(retried).toEqual({ to: call.to, twiml: call.twiml, sid: "CA_fake", status: "queued" });
    expect(recoveredConnectors.callCount()).toBe(1);
  });
});
