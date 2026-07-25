import { afterEach, describe, expect, it } from "vitest";
import type { ExecutiveEvent } from "@scce/kernel";
import { createExecutiveEventJournal, createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

/**
 * A small stateful fake of the three executive_* tables, shared by
 * reference across multiple journal instances so a test can simulate a
 * process restart (new adapter/journal object, same underlying "database").
 */
function fakeExecutiveTables() {
  const episodes = new Map<string, number>();
  const commands = new Set<string>();
  const events: Array<{ episode_id: string; revision: number; command_id: string; event_json: ExecutiveEvent }> = [];
  return { episodes, commands, events };
}

function journalOverFakeTables(tables: ReturnType<typeof fakeExecutiveTables>) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (sql.includes("INSERT INTO") && sql.includes("executive_episode") && sql.includes("ON CONFLICT")) {
      const [episodeId] = params as [string];
      if (!tables.episodes.has(episodeId)) tables.episodes.set(episodeId, 0);
      return [] as T[];
    }
    if (sql.startsWith("SELECT revision FROM") && sql.includes("executive_episode")) {
      const [episodeId] = params as [string];
      return (tables.episodes.has(episodeId) ? [{ revision: String(tables.episodes.get(episodeId)) }] : []) as T[];
    }
    if (sql.includes("SELECT episode_id FROM") && sql.includes("executive_command")) {
      const [episodeId, commandId] = params as [string, string];
      return (tables.commands.has(`${episodeId}:${commandId}`) ? [{ episode_id: episodeId }] : []) as T[];
    }
    if (sql.includes("INSERT INTO") && sql.includes("executive_command")) {
      const [episodeId, commandId] = params as [string, string];
      tables.commands.add(`${episodeId}:${commandId}`);
      return [] as T[];
    }
    if (sql.includes("INSERT INTO") && sql.includes("executive_event")) {
      const [episodeId, revision, commandId, eventJson] = params as [string, number, string, string];
      tables.events.push({ episode_id: episodeId, revision, command_id: commandId, event_json: JSON.parse(eventJson) });
      return [] as T[];
    }
    if (sql.startsWith("UPDATE") && sql.includes("executive_episode")) {
      const [episodeId, revision] = params as [string, number];
      tables.episodes.set(episodeId, revision);
      return [] as T[];
    }
    if (sql.includes("SELECT event_json FROM") && sql.includes("executive_event")) {
      const [episodeId] = params as [string];
      return tables.events
        .filter(e => e.episode_id === episodeId)
        .sort((a, b) => a.revision - b.revision)
        .map(e => ({ event_json: e.event_json })) as T[];
    }
    return [] as T[];
  };
  const txClient = { async query() { return { rows: [] }; }, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<typeof txClient> }).connect = async () => txClient;
  return createExecutiveEventJournal(adapter);
}

function event(patch: Partial<ExecutiveEvent> & { type: ExecutiveEvent["type"] }): ExecutiveEvent {
  return {
    id: `event_${patch.revision}`,
    episodeId: "episode.fixture",
    commandId: "command.fixture",
    revision: 1,
    occurredAt: 1_000,
    ...patch
  } as ExecutiveEvent;
}

describe("Postgres executive journal", () => {
  it("appends the first command of a fresh episode and advances revision by the event count", async () => {
    const journal = journalOverFakeTables(fakeExecutiveTables());
    const result = await journal.append({
      episodeId: "episode.a",
      commandId: "command.1",
      expectedRevision: 0,
      events: [event({ type: "episode_opened", episodeId: "episode.a", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never)]
    });
    expect(result).toEqual({ status: "appended", revision: 1 });
  });

  it("advances revision by the full event count for a multi-event command, not by one", async () => {
    const journal = journalOverFakeTables(fakeExecutiveTables());
    const result = await journal.append({
      episodeId: "episode.b",
      commandId: "command.1",
      expectedRevision: 0,
      events: [
        event({ type: "episode_opened", episodeId: "episode.b", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never),
        event({ type: "goal_declared", episodeId: "episode.b", commandId: "command.1", revision: 2, goal: { id: "goal.1" } as never } as never)
      ]
    });
    expect(result).toEqual({ status: "appended", revision: 2 });

    const snapshot = await journal.read("episode.b");
    expect(snapshot.revision).toBe(2);
    expect(snapshot.events).toHaveLength(2);
  });

  it("reports duplicate -- not conflict -- when the same command is retried, even after the revision moved on", async () => {
    const tables = fakeExecutiveTables();
    const journal = journalOverFakeTables(tables);
    await journal.append({
      episodeId: "episode.c",
      commandId: "command.1",
      expectedRevision: 0,
      events: [event({ type: "episode_opened", episodeId: "episode.c", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never)]
    });

    const retried = await journal.append({
      episodeId: "episode.c",
      commandId: "command.1",
      expectedRevision: 0, // caller retried with its original (now stale) expectedRevision
      events: [event({ type: "episode_opened", episodeId: "episode.c", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never)]
    });
    expect(retried.status).toBe("duplicate");
    expect(retried.revision).toBe(1);

    const snapshot = await journal.read("episode.c");
    expect(snapshot.events).toHaveLength(1); // not appended twice
  });

  it("reports conflict for a genuinely stale expectedRevision from a different command", async () => {
    const journal = journalOverFakeTables(fakeExecutiveTables());
    await journal.append({
      episodeId: "episode.d",
      commandId: "command.1",
      expectedRevision: 0,
      events: [event({ type: "episode_opened", episodeId: "episode.d", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never)]
    });

    const conflicting = await journal.append({
      episodeId: "episode.d",
      commandId: "command.2",
      expectedRevision: 0, // stale -- real current revision is 1
      events: [event({ type: "goal_declared", episodeId: "episode.d", commandId: "command.2", revision: 1, goal: { id: "goal.1" } as never } as never)]
    });
    expect(conflicting).toEqual({ status: "conflict", revision: 1 });
  });

  it("survives a simulated process restart -- a fresh journal instance over the same durable tables sees the prior state", async () => {
    const tables = fakeExecutiveTables();
    const firstProcessJournal = journalOverFakeTables(tables);
    await firstProcessJournal.append({
      episodeId: "episode.e",
      commandId: "command.1",
      expectedRevision: 0,
      events: [event({ type: "episode_opened", episodeId: "episode.e", commandId: "command.1", revision: 1, ownerId: "owner", policyVersionId: "policy.v1" } as never)]
    });

    const afterRestartJournal = journalOverFakeTables(tables); // new instance, same tables -- simulates a new process
    const snapshot = await afterRestartJournal.read("episode.e");
    expect(snapshot.revision).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]!.type).toBe("episode_opened");
  });

  it("reports a fresh, never-opened episode as revision 0 with no events rather than erroring", async () => {
    const journal = journalOverFakeTables(fakeExecutiveTables());
    const snapshot = await journal.read("episode.never-opened");
    expect(snapshot).toEqual({ episodeId: "episode.never-opened", revision: 0, events: [] });
  });
});
