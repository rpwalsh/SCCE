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
import { dispatchOutlookDraftCreateThroughExecutive, dispatchOutlookDraftRollback } from "../routes.js";

// Same in-memory journal fixture pattern already established in
// workspace-patch-executive-dispatch.test.ts / capability-dispatcher.test.ts.
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

// A fake connector standing in for the real Microsoft Graph API (no real
// credentials in this environment) -- proves the real dispatch mechanics
// (idempotency, rollback wiring), not the real HTTP call itself, which
// ConfiguredConnectorAdapter's own outlookCreateDraft/outlookDeleteDraft
// already cover for their real Graph API request shape.
function fakeConnectors(options: { createFails?: boolean | "partial" } = {}) {
  let nextId = 0;
  let createCalls = 0;
  const deleted: string[] = [];
  return {
    createCalls: () => createCalls,
    deleted,
    outlookCreateDraft: async (draft: { to: string[]; subject: string; body: string; cc?: string[]; approved?: boolean }): Promise<JsonValue> => {
      createCalls++;
      nextId++;
      const id = `message.${nextId}`;
      // "partial" simulates a request that genuinely created the draft
      // server-side but whose success response never reached the caller
      // (e.g. a dropped connection) -- the thrown error still carries the
      // real id, same as some real SDKs attach partial-result data to a
      // thrown error. Plain `true` simulates a request that never reached
      // the server at all, so no id is knowable anywhere.
      if (options.createFails === "partial") {
        const error = new Error("simulated Graph API response lost after the draft was actually created") as Error & { messageId?: string };
        error.messageId = id;
        throw error;
      }
      if (options.createFails) throw new Error("simulated Graph API failure (request never reached the server)");
      return { id, subject: draft.subject };
    },
    outlookDeleteDraft: async (messageId: string): Promise<JsonValue> => {
      deleted.push(messageId);
      return { id: messageId, deleted: true };
    }
  };
}

const draft = { to: ["a@example.com"], subject: "hello", body: "body text" };

describe("outlook draft create routed through the durable executive dispatcher (plan items 197-206)", () => {
  it("performs the real create and returns the real result", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" });
    expect(result).toMatchObject({ id: "message.1", subject: "hello" });
    expect(connectors.createCalls()).toBe(1);
  });

  it("dispatching the identical draft twice replays as a duplicate, never creating a second draft", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const first = await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" });
    const second = await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" });
    // The replayed dispatch never re-invokes the executor, so it can only
    // honestly reconstruct what the receipt actually recorded (the id) --
    // not the full original response body.
    expect(second).toEqual({ id: (first as { id: string }).id });
    expect(connectors.createCalls()).toBe(1);
  });

  it("a different draft (different content hash) is a genuinely new dispatch, not deduplicated against the first", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" });
    await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft: { ...draft, subject: "different" }, ownerId: "test.owner" });
    expect(connectors.createCalls()).toBe(2);
  });

  // executive-episode.ts's own state machine only ever reaches
  // rollback_ready after a *reported failure* (never after a reported
  // success -- see the "outcome_recorded" transition) -- rollback here
  // protects against a create call that reported failure but may have
  // partially gone through server-side, not a user-initiated "undo" of a
  // known-successful draft.
  it("real rollback genuinely invokes outlookDeleteDraft with the real created message id when create reports a partial failure, and a retry does not delete twice", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" })).rejects.toThrow();

    const first = await dispatchOutlookDraftRollback({ executive, connectors, draft });
    expect(first.disposition).toBe("rolled_back");
    expect(connectors.deleted).toEqual(["message.1"]);

    const retried = await dispatchOutlookDraftRollback({ executive, connectors, draft });
    expect(retried.disposition).toBe("rolled_back");
    expect(connectors.deleted).toEqual(["message.1"]);
  });

  it("rollback fails closed (rollback_failed, nothing deleted) when the create call never learned any message id at all", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: true });
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" })).rejects.toThrow();
    const result = await dispatchOutlookDraftRollback({ executive, connectors, draft });
    expect(result.disposition).toBe("rollback_failed");
    expect(connectors.deleted).toEqual([]);
  });

  it("rollback fails closed (no_rollback_needed) when no draft was ever created for that content", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    const result = await dispatchOutlookDraftRollback({ executive, connectors, draft });
    expect(result.disposition).not.toBe("rolled_back");
    expect(connectors.deleted).toEqual([]);
  });

  it("rollback fails closed (not_ready) while the create task is still in a genuinely successful state", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors();
    await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" });
    const result = await dispatchOutlookDraftRollback({ executive, connectors, draft });
    expect(result.disposition).toBe("not_ready");
    expect(connectors.deleted).toEqual([]);
  });

  // Real defect found and fixed while auditing this dispatch: a confirmed
  // rollback (rolled_back/rollback_failed) is a terminal task status, so a
  // pure content-hash task identity would permanently block recreating the
  // exact same draft content again -- forcing dispatchCapabilityTask's
  // "not_ready" disposition forever. Bucketing the identity by a bounded
  // time window fixes this: an immediate retry still safely dedupes
  // (stays not_ready, never double-executes), but a later, deliberate
  // retry of the identical content gets a fresh identity and genuinely
  // creates the draft.
  it("a retry within the idempotency window after a rollback stays not_ready (the window is real, not instantaneous)", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner", now: windowStart })).rejects.toThrow();
    await dispatchOutlookDraftRollback({ executive, connectors, draft, now: windowStart });

    const recovered = fakeConnectors();
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors: recovered, draft, ownerId: "test.owner", now: windowStart + 1_000 })).rejects.toThrow(/disposition: not_ready/);
    expect(recovered.createCalls()).toBe(0);
  });

  it("retrying the identical draft content in a later idempotency window after a rollback genuinely creates it", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    const windowStart = 10 * 5 * 60 * 1000;
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner", now: windowStart })).rejects.toThrow();
    await dispatchOutlookDraftRollback({ executive, connectors, draft, now: windowStart });

    const recovered = fakeConnectors();
    const result = await dispatchOutlookDraftCreateThroughExecutive({ executive, connectors: recovered, draft, ownerId: "test.owner", now: windowStart + 5 * 60 * 1000 });
    expect(result).toMatchObject({ id: "message.1" });
    expect(recovered.createCalls()).toBe(1);
  });

  it("rollback fails closed (never fabricated) when no outlookDeleteDraft executor is configured, even though a real message id is known", async () => {
    const executive = executiveFixture();
    const connectors = fakeConnectors({ createFails: "partial" });
    await expect(dispatchOutlookDraftCreateThroughExecutive({ executive, connectors, draft, ownerId: "test.owner" })).rejects.toThrow();
    const { outlookDeleteDraft: _omit, ...connectorsWithoutDelete } = connectors;
    void _omit;
    const result = await dispatchOutlookDraftRollback({ executive, connectors: connectorsWithoutDelete, draft });
    expect(result.disposition).not.toBe("rolled_back");
    expect(connectors.deleted).toEqual([]);
  });
});
