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
import { dispatchOutlookCalendarEventCreateThroughExecutive, dispatchOutlookCalendarEventRollback } from "../routes.js";

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

function fakeConnectors(options: { createFails?: boolean | "partial" } = {}) {
  let nextId = 0;
  let createCalls = 0;
  const deleted: string[] = [];
  return {
    createCalls: () => createCalls,
    deleted,
    outlookCreateCalendarEvent: async (event: { subject: string; start: string; end: string }): Promise<JsonValue> => {
      createCalls++;
      nextId++;
      const id = `event.${nextId}`;
      if (options.createFails === "partial") {
        const error = new Error("simulated Graph API response lost after the event was actually created") as Error & { messageId?: string };
        error.messageId = id;
        throw error;
      }
      if (options.createFails) throw new Error("simulated Graph API failure (request never reached the server)");
      return { id, subject: event.subject };
    },
    outlookDeleteCalendarEvent: async (eventId: string): Promise<JsonValue> => {
      deleted.push(eventId);
      return { id: eventId, deleted: true };
    }
  };
}

const event = { subject: "standup", start: "2026-08-01T09:00:00Z", end: "2026-08-01T09:15:00Z" };

describe("outlook calendar event create routed through the durable executive dispatcher (plan item 207)", () => {
  it("performs the real create and returns the real result", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" });
    expect(result).toMatchObject({ id: "event.1", subject: "standup" });
    expect(connectors.createCalls()).toBe(1);
  });

  it("dispatching the identical event twice replays as a duplicate, never creating a second event", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const first = await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" });
    const second = await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" });
    expect(second).toEqual({ id: (first as { id: string }).id });
    expect(connectors.createCalls()).toBe(1);
  });

  it("a different event (different content hash) is a genuinely new dispatch, not deduplicated against the first", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" });
    await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event: { ...event, subject: "different" }, ownerId: "test.owner" });
    expect(connectors.createCalls()).toBe(2);
  });

  it("real rollback genuinely invokes outlookDeleteCalendarEvent with the real created event id when create reports a partial failure, and a retry does not delete twice", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    await expect(dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" })).rejects.toThrow();

    const first = await dispatchOutlookCalendarEventRollback({ executive, connectors, event });
    expect(first.disposition).toBe("rolled_back");
    expect(connectors.deleted).toEqual(["event.1"]);

    const retried = await dispatchOutlookCalendarEventRollback({ executive, connectors, event });
    expect(retried.disposition).toBe("rolled_back");
    expect(connectors.deleted).toEqual(["event.1"]);
  });

  it("rollback fails closed (no_rollback_needed) when no event was ever created for that content", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchOutlookCalendarEventRollback({ executive, connectors, event });
    expect(result.disposition).not.toBe("rolled_back");
    expect(connectors.deleted).toEqual([]);
  });

  it("rollback fails closed (not_ready) while the create task is still in a genuinely successful state", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner" });
    const result = await dispatchOutlookCalendarEventRollback({ executive, connectors, event });
    expect(result.disposition).toBe("not_ready");
    expect(connectors.deleted).toEqual([]);
  });

  it("retrying the identical event content in a later idempotency window after a rollback genuinely creates it", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors, event, ownerId: "test.owner", now: windowStart })).rejects.toThrow();
    await dispatchOutlookCalendarEventRollback({ executive, connectors, event, now: windowStart });

    const recovered = fakeConnectors();
    const result = await dispatchOutlookCalendarEventCreateThroughExecutive({ executive, connectors: recovered, event, ownerId: "test.owner", now: windowStart + 5 * 60 * 1000 });
    expect(result).toMatchObject({ id: "event.1" });
    expect(recovered.createCalls()).toBe(1);
  });
});
