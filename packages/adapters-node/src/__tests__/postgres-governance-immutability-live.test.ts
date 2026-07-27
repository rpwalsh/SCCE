import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, createClock, createEventFactory, createHasher, createIdFactory } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { createNodePostgresGovernanceProbe, fullyVerifyEventLedger } from "../governance-probe.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

function noopApprovals() {
  return { snapshot: () => ({ pending: [], approved: [], operatorGrant: false }) };
}

// Plan item 64: a real Postgres trigger, not application-level discipline
// alone, rejects UPDATE/DELETE on event rows.
describe("event ledger immutability trigger (plan item 64)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "rejects UPDATE and DELETE on an event row via the database trigger, bypassing all application code",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const id = `event.immutability.${randomUUID()}`;
      await adapter.query(
        `INSERT INTO ${adapter.table("events")}(id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [id, "episode.immutability", "ImmutabilityTest", 1, "{}", [], `hash_${id}`, `ledger_${id}`]
      );
      // Issued directly via adapter.query -- no application-layer guard
      // in between, only the database's own trigger can stop this.
      await expect(adapter.query(`UPDATE ${adapter.table("events")} SET t = 2 WHERE id = $1`, [id]))
        .rejects.toThrow(/append-only/i);
      await expect(adapter.query(`DELETE FROM ${adapter.table("events")} WHERE id = $1`, [id]))
        .rejects.toThrow(/append-only/i);
      // The row is deliberately left in place -- it cannot be deleted
      // (that's the point), and it's a synthetic, harmless fixture row
      // in a disposable local test database.
    }
  );
});

// Plan item 65: governance readiness must report not-ready when the
// connected role can still mutate the ledger by privilege, even if a
// protective trigger also exists (defense in depth: a sufficiently
// privileged role can disable or bypass a trigger, e.g. via
// ALTER TABLE ... DISABLE TRIGGER or TRUNCATE, so trigger presence alone
// is deliberately not treated as sufficient for "passed").
describe("governance immutability readiness under excess privilege (plan item 65)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "reports immutability as not passed when the connected role still holds UPDATE/DELETE privilege, despite the trigger existing",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const probe = createNodePostgresGovernanceProbe({
        storage: adapter,
        approvals: noopApprovals(),
        workspaceRoot: process.cwd(),
        environment: {}
      });
      const observation = await probe.observe({ policy: DEFAULT_POLICY, now: Date.now() });
      // This test's own DB connection (SCCE_TEST_DATABASE_URL, typically
      // an admin/superuser credential) has real UPDATE/DELETE privilege
      // on the events table -- exactly the excess-privilege case this
      // control must fail closed on, live, not simulated.
      expect(observation.immutability.available).toBe(true);
      expect(observation.immutability.updateDenied).toBe(false);
      expect(observation.immutability.deleteDenied).toBe(false);
      expect(observation.immutability.passed).toBe(false);
      expect(observation.immutability.reason).toBe("runtime_role_can_mutate_events");
      // The trigger itself is still real and detected separately --
      // this is what distinguishes "not passed due to excess privilege"
      // from "not passed because nothing protects this table at all".
      expect(observation.immutability.protectiveTriggerPresent).toBe(true);
    }
  );
});

// Plan item 67: full-audit and bounded/incremental verify agree on a
// clean ledger, and full-audit alone detects a corruption an
// incremental verify pass would miss (a tampered row before the
// checkpoint anchor, which incremental verification never re-reads).
describe("full audit vs incremental verification (plan item 67)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "full-audit and incremental verify agree on a clean ledger, and full-audit alone catches a pre-checkpoint tamper",
    async () => {
      // A dedicated, disposable schema, not the shared liveSchema: the
      // shared events table accumulates permanent fixture rows from
      // other tests in this file (item 64 deliberately leaves an
      // undeletable row behind to prove immutability), which would
      // otherwise make fullyVerifyEventLedgerAndCheckpoint's whole-table
      // scan report passed:false for reasons unrelated to this test --
      // and since the incremental checkpoint is only ever established
      // after a *passing* full scan, that pollution would silently
      // prevent the incremental code path from ever actually running,
      // defeating the point of this test.
      const disposableSchema = `governance_audit_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: disposableSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const episodeId = `episode.audit.${suffix}` as never;
      // Real event factory (not hand-crafted fake hashes): each event's
      // content hash and the ledger's running hash are computed by the
      // exact same code production uses, so this is a genuinely valid
      // chain before any tampering -- not an artifact of a fixture that
      // was never really chained correctly in the first place.
      const eventFactory = createEventFactory({ idFactory: createIdFactory({ clock: createClock(), hasher: createHasher(), deterministicReplay: true }), clock: createClock({ fixedTime: 1000, stepMs: 1 }), hasher: createHasher() });
      const built = [];
      let parent: ReturnType<typeof eventFactory.create> | undefined;
      for (let index = 0; index < 3; index++) {
        const event = eventFactory.create({ episodeId, typeId: "AuditTest", payload: { index, suffix }, parents: parent ? [parent] : [] });
        built.push(event);
        parent = event;
      }
      await adapter.events.appendBatch(built);
      const rows = built.map(event => ({ id: String(event.id) }));
      try {
        const probe = createNodePostgresGovernanceProbe({
          storage: adapter,
          approvals: noopApprovals(),
          workspaceRoot: process.cwd(),
          environment: {}
        });
        // First call does a full scan (nothing else in this disposable
        // schema) and, since it passes, checkpoints past all 3 real,
        // validly-chained events -- establishing the incremental path
        // for later calls on this same probe instance.
        const beforeTamper = await probe.observe({ policy: DEFAULT_POLICY, now: Date.now() });
        const fullBeforeTamper = await fullyVerifyEventLedger(adapter);
        expect(beforeTamper.eventLedger.passed).toBe(true);
        expect(fullBeforeTamper.passed).toBe(true);

        // Tamper a row *before* the checkpoint anchor directly at the
        // storage layer (bypassing the trigger via the raw pool, the
        // only way this kind of tamper could ever really happen -- e.g.
        // a compromised superuser or a direct storage-layer bug).
        const txClient = await (adapter as unknown as { pool: { connect(): Promise<{ query(sql: string, params: unknown[]): Promise<unknown>; release(): void }> } }).pool.connect();
        try {
          await txClient.query(`ALTER TABLE ${adapter.table("events")} DISABLE TRIGGER events_immutable`, []);
          await txClient.query(`UPDATE ${adapter.table("events")} SET hash = $1 WHERE id = $2`, ["tampered_hash", rows[0]!.id]);
        } finally {
          await txClient.query(`ALTER TABLE ${adapter.table("events")} ENABLE TRIGGER events_immutable`, []);
          txClient.release();
        }

        // Incremental verify's in-process checkpoint already advanced
        // past this row on the first call above (it's the row furthest
        // from the anchor, and no new events were appended since), so it
        // never re-reads the tampered row -- it must still report
        // passed:true. This is a real, known, deliberate limitation of
        // bounded verification, not a bug: it trades catching a
        // pre-checkpoint tamper for O(new events) instead of O(all
        // events) cost, and is exactly why the separate full-audit
        // command (item 66) must exist.
        const afterTamperIncremental = await probe.observe({ policy: DEFAULT_POLICY, now: Date.now() });
        expect(afterTamperIncremental.eventLedger.passed).toBe(true);

        // Full audit re-reads everything and must catch it.
        const fullAfterTamper = await fullyVerifyEventLedger(adapter);
        expect(fullAfterTamper.passed).toBe(false);
        const brokenHashes = (fullAfterTamper.evidence as { eventChain?: { brokenHashes?: Array<{ eventId: string }> } }).eventChain?.brokenHashes ?? [];
        expect(brokenHashes.map(row => row.eventId)).toContain(rows[0]!.id);
      } finally {
        await adapter.query(`DROP SCHEMA IF EXISTS "${disposableSchema}" CASCADE`);
      }
    }
  );
});
