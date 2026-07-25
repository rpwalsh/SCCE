import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  type EpisodeId,
  type ScceEvent
} from "@scce/kernel";
import { createApprovalSession } from "../approval-session.js";
import { createNodePostgresGovernanceProbe, fullyVerifyEventLedger, type PostgresGovernanceEventRow } from "../governance-probe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "scce-governance-incremental-"));
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildLedger(count: number, startAt = 1_000): PostgresGovernanceEventRow[] {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: startAt, stepMs: 1 });
  const idFactory = createIdFactory({ clock, hasher, namespace: "governance-incremental-test", runSeed: "fixed", deterministicReplay: true });
  const events = createEventFactory({ clock, hasher, idFactory });
  const episodeId = "episode.governance.incremental" as EpisodeId;
  const created: ScceEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    created.push(events.create({ episodeId, typeId: "EpisodeOpened", payload: { i } }));
  }
  let ledgerHash = "";
  return created.map(event => {
    ledgerHash = sha256(`${ledgerHash}${event.hash}`);
    return {
      id: String(event.id),
      episode_id: String(event.episodeId),
      type_id: String(event.typeId),
      t: event.t,
      payload_json: event.payload,
      parents: event.parents.map(String),
      hash: event.hash,
      ledger_hash: ledgerHash
    };
  });
}

interface FakeGovernanceStorage {
  storage: { schema: string; table: (name: string) => string; query: <T>(sql: string, params?: unknown[]) => Promise<T[]> };
  fullScanCount: () => number;
  setRows: (rows: PostgresGovernanceEventRow[]) => void;
  setPrivileges: (updateAllowed: boolean, deleteAllowed: boolean) => void;
  setTriggerCount: (n: number) => void;
}

function fakeGovernanceStorage(initialRows: PostgresGovernanceEventRow[]): FakeGovernanceStorage {
  let rows = initialRows;
  let updateAllowed = false;
  let deleteAllowed = false;
  let triggerCount = 1;
  let fullScans = 0;
  const sorted = () => [...rows].sort((a, b) => Number(a.t) - Number(b.t) || a.id.localeCompare(b.id));
  return {
    storage: {
      schema: "test_schema",
      table: () => '"events"',
      query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        if (sql.includes("has_table_privilege")) {
          return [{ update_allowed: updateAllowed, delete_allowed: deleteAllowed }] as T[];
        }
        if (sql.includes("pg_trigger")) {
          return [{ count: String(triggerCount) }] as T[];
        }
        if (sql.includes("WHERE id = $1")) {
          const [id] = params as [string];
          const row = rows.find(r => r.id === id);
          return (row ? [{ id: row.id, t: row.t, hash: row.hash, ledger_hash: row.ledger_hash }] : []) as T[];
        }
        if (sql.includes("(t, id) >")) {
          const [anchorId, anchorT] = params as [string, number];
          return sorted().filter(row => Number(row.t) > anchorT || (Number(row.t) === anchorT && row.id > anchorId)) as unknown as T[];
        }
        fullScans += 1;
        return sorted() as unknown as T[];
      }
    },
    fullScanCount: () => fullScans,
    setRows: next => { rows = next; },
    setPrivileges: (u, d) => { updateAllowed = u; deleteAllowed = d; },
    setTriggerCount: n => { triggerCount = n; }
  };
}

describe("incremental governance ledger verification", () => {
  it("does a full scan only once, then verifies just the appended suffix on later calls", async () => {
    const fake = fakeGovernanceStorage(buildLedger(3));
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    const first = await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(first.eventLedger).toMatchObject({ passed: true, events: 3 });
    expect(fake.fullScanCount()).toBe(1);

    fake.setRows(buildLedger(5));
    const second = await probe.observe({ policy: DEFAULT_POLICY, now: 2_001 });
    expect(second.eventLedger).toMatchObject({ passed: true, events: 5 });
    expect(fake.fullScanCount()).toBe(1);

    const third = await probe.observe({ policy: DEFAULT_POLICY, now: 2_002 });
    expect(third.eventLedger).toMatchObject({ passed: true, events: 5 });
    expect(fake.fullScanCount()).toBe(1);
  });

  it("fails closed and forces a rescan when the checkpoint anchor is mutated", async () => {
    const ledger = buildLedger(4);
    const fake = fakeGovernanceStorage(ledger);
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(fake.fullScanCount()).toBe(1);

    const tampered = ledger.map((row, index) => index === ledger.length - 1 ? { ...row, hash: "tampered_hash" } : row);
    fake.setRows(tampered);
    const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 2_001 });
    expect(observed.eventLedger).toMatchObject({ passed: false, reason: "checkpoint_anchor_mutated_or_missing" });

    // The failed check discarded the checkpoint, so the next call rescans fully instead of trusting stale state.
    fake.setRows(ledger);
    await probe.observe({ policy: DEFAULT_POLICY, now: 2_002 });
    expect(fake.fullScanCount()).toBe(2);
  });

  it("fails closed when a broken ledger hash appears in the newly appended suffix", async () => {
    const fake = fakeGovernanceStorage(buildLedger(2));
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });

    const extended = buildLedger(4);
    const corrupted = extended.map((row, index) => index === 3 ? { ...row, ledger_hash: "corrupted" } : row);
    fake.setRows(corrupted);
    const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 2_001 });
    expect(observed.eventLedger).toMatchObject({ passed: false, reason: "postgres_ledger_hash_chain_invalid" });
  });

  it("reports immutability as failed when the connected role can still mutate the ledger", async () => {
    const fake = fakeGovernanceStorage(buildLedger(1));
    fake.setPrivileges(true, false);
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(observed.immutability).toMatchObject({ available: true, passed: false, reason: "runtime_role_can_mutate_events", updateDenied: false });
    expect(observed.ready).toBe(false);
  });

  it("reports immutability as passed once both privileges are denied, and notes trigger presence separately", async () => {
    const fake = fakeGovernanceStorage(buildLedger(1));
    fake.setPrivileges(false, false);
    fake.setTriggerCount(0);
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(observed.immutability).toMatchObject({
      available: true,
      passed: true,
      reason: "denied_by_privilege_no_protective_trigger",
      updateDenied: true,
      deleteDenied: true,
      protectiveTriggerPresent: false
    });
  });

  it("full audit ignores any in-process checkpoint and always rescans everything", async () => {
    const fake = fakeGovernanceStorage(buildLedger(2));
    const result = await fullyVerifyEventLedger(fake.storage as never);
    expect(result).toMatchObject({ passed: true, events: 2 });
    expect(fake.fullScanCount()).toBe(1);
  });
});
