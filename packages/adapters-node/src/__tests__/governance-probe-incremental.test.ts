// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  createAuditEngine,
  hashEvent,
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  type JsonValue,
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

function buildLedger(count: number, startAt = 1_000, options: { linked?: boolean; payload?: JsonValue } = {}): PostgresGovernanceEventRow[] {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: startAt, stepMs: 1 });
  const idFactory = createIdFactory({ clock, hasher, namespace: "governance-incremental-test", runSeed: "fixed", deterministicReplay: true });
  const events = createEventFactory({ clock, hasher, idFactory });
  const episodeId = "episode.governance.incremental" as EpisodeId;
  const created: ScceEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    created.push(events.create({ episodeId, typeId: "EpisodeOpened", payload: options.payload ?? { i },
      ...(options.linked && created.length ? { parents: [created.at(-1)!] } : {}) }));
  }
  let ledgerHash = "";
  return created.map((event, index) => {
    ledgerHash = sha256(`${ledgerHash}${event.hash}`);
    return {
      id: String(event.id),
      episode_id: String(event.episodeId),
      type_id: String(event.typeId),
      t: event.t,
      payload_json: event.payload,
      parents: event.parents.map(String),
      hash: event.hash,
      ledger_hash: ledgerHash, ledger_position: String(index + 1)
    };
  });
}

interface FakeGovernanceStorage {
  storage: { schema: string; table: (name: string) => string; query: <T>(sql: string, params?: unknown[]) => Promise<T[]> };
  fullScanCount: () => number;
  windowScanCount: () => number;
  setRows: (rows: PostgresGovernanceEventRow[]) => void;
  setPrivileges: (updateAllowed: boolean, deleteAllowed: boolean) => void;
  setTriggerCount: (n: number) => void;
  payloadPages: () => string[][];
  setAfterHeadRead: (hook: () => void) => void;
  setPayloadRead: (read: (rows: PostgresGovernanceEventRow[]) => PostgresGovernanceEventRow[]) => void;
}

function fakeGovernanceStorage(initialRows: PostgresGovernanceEventRow[]): FakeGovernanceStorage {
  let rows = initialRows;
  let updateAllowed = false;
  let deleteAllowed = false;
  let triggerCount = 1;
  let fullScans = 0;
  let windowScans = 0;
  const payloadPages: string[][] = [];
  let afterHeadRead = () => {};
  let payloadRead = (rows: PostgresGovernanceEventRow[]) => rows;
  const headers = (selected: PostgresGovernanceEventRow[]) => selected.map(({ payload_json, ...header }) => ({
    ...header, payload_stored_bytes: Buffer.byteLength(JSON.stringify(payload_json))
  }));
  const sorted = () => [...rows].sort((a, b) => BigInt(a.ledger_position!) < BigInt(b.ledger_position!) ? -1 : BigInt(a.ledger_position!) > BigInt(b.ledger_position!) ? 1 : 0);
  return {
    storage: {
      schema: "test_schema",
      table: () => '"events"',
      query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        if (sql.includes("event_ledger_position_snapshot")) {
          const last = sorted().at(-1);
          const snapshot = [{ head: last ? { eventId:last.id,eventHash:last.hash,ledgerHash:last.ledger_hash,ledgerPosition:String(last.ledger_position) } : null,
            present:rows.length>0,unpositioned:rows.some(row=>row.ledger_position==null),tail_position:last?.ledger_position??null }];
          const hook=afterHeadRead;afterHeadRead=()=>{};hook();return snapshot as T[];
        }
        if (sql.includes("has_table_privilege")) {
          return [{ update_allowed: updateAllowed, delete_allowed: deleteAllowed }] as T[];
        }
        if (sql.includes("pg_trigger")) {
          return [{ count: String(triggerCount) }] as T[];
        }
        if (sql.includes("WHERE id=ANY($1::text[])")) {
          if (!sql.includes("payload_json")) return sorted().filter(row => (params[0] as string[]).includes(row.id)).map(row=>({id:row.id,hash:row.hash,ledger_position:row.ledger_position})) as T[];
          const ids = params[0] as string[];
          payloadPages.push([...ids]);
          return payloadRead(sorted().filter(row => ids.includes(row.id))) as T[];
        }
        if (sql.includes("WHERE id = $1")) {
          const [id] = params as [string];
          const row = rows.find(r => r.id === id);
          return (row ? [{ id: row.id, t: row.t, hash: row.hash, ledger_hash: row.ledger_hash, ledger_position: row.ledger_position }] : []) as T[];
        }
        if (sql.includes("ledger_position > $1::bigint")) {
          return headers(sorted().filter(row=>BigInt(row.ledger_position!)>BigInt(params[0] as string)&&BigInt(row.ledger_position!)<=BigInt(params[1] as string))) as unknown as T[];
        }
        if (/count\(\*\)/i.test(sql)) {
          return [{ count: String(rows.length) }] as T[];
        }
        if (sql.includes("ORDER BY ledger_position DESC")) {
          windowScans += 1;
          const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? rows.length);
          return headers(sorted().filter(row=>BigInt(row.ledger_position!)<=BigInt(params[0] as string)).slice(-limit).reverse()) as unknown as T[];
        }
        fullScans += 1;
        return headers(sorted().filter(row=>!params.length||BigInt(row.ledger_position!)<=BigInt(params[0] as string))) as unknown as T[];
      }
    },
    fullScanCount: () => fullScans,
    windowScanCount: () => windowScans,
    setRows: next => { rows = next; },
    setPrivileges: (u, d) => { updateAllowed = u; deleteAllowed = d; },
    setTriggerCount: n => { triggerCount = n; },
    payloadPages: () => payloadPages,
    setAfterHeadRead: hook => { afterHeadRead=hook; },
    setPayloadRead: read => { payloadRead = read; }
  };
}

describe("incremental governance ledger verification", () => {
  it("verifies append order20,1,21 and same-ms ties, including backdated suffixes", async () => {
    const ledger=buildLedger(4);let previous="";
    ledger.forEach((row,i)=>{row.t=[20,1,21,21][i]!;row.id=["z","a","m","b"][i]!;
      row.hash=hashEvent({id:row.id,episodeId:row.episode_id,typeId:row.type_id,t:Number(row.t),payload:row.payload_json,parents:[]} as never,[],createHasher());
      row.ledger_hash=previous=sha256(previous+"\u001f"+row.hash);});
    const fake=fakeGovernanceStorage(ledger.slice(0,1)),root=await tempRoot(),probe=createNodePostgresGovernanceProbe({storage:fake.storage as never,approvals:createApprovalSession(),workspaceRoot:root,environment:{}});
    expect((await probe.observe({policy:DEFAULT_POLICY,now:1})).eventLedger.passed).toBe(true);
    fake.setRows(ledger);expect((await probe.observe({policy:DEFAULT_POLICY,now:2})).eventLedger).toMatchObject({passed:true,events:4,reason:"verified_incremental"});
    expect((await fullyVerifyEventLedger(fake.storage as never)).passed).toBe(true);
  });
  it("captures one canonical head while concurrent append is deferred to the next suffix", async () => {
    const ledger=buildLedger(4),fake=fakeGovernanceStorage(ledger.slice(0,3)),root=await tempRoot();
    const probe=createNodePostgresGovernanceProbe({storage:fake.storage as never,approvals:createApprovalSession(),workspaceRoot:root,environment:{}});
    fake.setAfterHeadRead(()=>fake.setRows(ledger));
    expect((await probe.observe({policy:DEFAULT_POLICY,now:1})).eventLedger).toMatchObject({passed:true,events:3});
    expect((await probe.observe({policy:DEFAULT_POLICY,now:2})).eventLedger).toMatchObject({passed:true,events:4,reason:"verified_incremental"});
  });
  it("keeps tail and suffix positions exact above Number precision", async () => {
    const ledger=buildLedger(3);ledger.forEach((row,i)=>row.ledger_position=(9007199254740992n+BigInt(i)).toString());
    const fake=fakeGovernanceStorage(ledger.slice(0,2)),root=await tempRoot(),probe=createNodePostgresGovernanceProbe({storage:fake.storage as never,approvals:createApprovalSession(),workspaceRoot:root,environment:{SCCE_GOVERNANCE_LEDGER_WINDOW_EVENTS:"1"}});
    expect((await probe.observe({policy:DEFAULT_POLICY,now:1})).eventLedger).toMatchObject({passed:true,events:"9007199254740993"});
    fake.setRows(ledger);expect((await probe.observe({policy:DEFAULT_POLICY,now:2})).eventLedger).toMatchObject({passed:true,events:"9007199254740994"});
  });
  it("checks parents outside a bounded payload window through exact narrow headers", async () => {
    const ledger=buildLedger(5,1000,{linked:true}),fake=fakeGovernanceStorage(ledger),root=await tempRoot();
    const observed=await createNodePostgresGovernanceProbe({storage:fake.storage as never,approvals:createApprovalSession(),workspaceRoot:root,environment:{SCCE_GOVERNANCE_LEDGER_WINDOW_EVENTS:"2"}}).observe({policy:DEFAULT_POLICY,now:1});
    expect(observed.eventLedger.passed).toBe(true);expect(fake.payloadPages().flat()).toEqual(ledger.slice(-2).map(row=>row.id));
  });
  it("rejects a missing ordinal in an otherwise plausible appended suffix", async () => {
    const ledger=buildLedger(4),fake=fakeGovernanceStorage(ledger.slice(0,2)),root=await tempRoot();
    const probe=createNodePostgresGovernanceProbe({storage:fake.storage as never,approvals:createApprovalSession(),workspaceRoot:root,environment:{}});
    await probe.observe({policy:DEFAULT_POLICY,now:1});fake.setRows([ledger[0]!,ledger[1]!,ledger[3]!]);
    expect((await probe.observe({policy:DEFAULT_POLICY,now:2})).eventLedger).toMatchObject({passed:false,reason:"event_append_position_invalid"});
  });
  it("verifies all4096 selected events and cross-page parents while allowing the event loop to progress", async () => {
    const ledger = buildLedger(4096, 1_000, { linked: true });
    const fake = fakeGovernanceStorage(ledger), root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root, environment: {} });
    let timerTicks = 0;
    const timer = setInterval(() => { timerTicks++; }, 0);
    try {
      const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 10_000 });
      expect(observed.eventLedger).toMatchObject({ passed: true, events: 4096, reason: "verified_bounded_window" });
      const evidence = observed.eventLedger.evidence as Record<string, unknown>;
      const expectedEvents = ledger.map(row => ({ id: row.id, episodeId: row.episode_id, typeId: row.type_id, t: Number(row.t), payload: row.payload_json, parents: row.parents, hash: row.hash })) as ScceEvent[];
      expect(evidence.eventChain).toEqual(createAuditEngine().verifyEventChain(expectedEvents));
      expect(fake.payloadPages()).toHaveLength(64);
      expect(fake.payloadPages().flat()).toEqual(ledger.map(row => row.id));
      expect(timerTicks).toBeGreaterThan(0);
      expect(fake.fullScanCount()).toBe(0);
    } finally { clearInterval(timer); }
  });

  it("checks an oversized valid payload in a singleton page instead of omitting or refusing it", async () => {
    const ledger = buildLedger(3, 1_000, { linked: true, payload: { text: "x".repeat(3 * 1024 * 1024) } });
    const fake = fakeGovernanceStorage(ledger), root = await tempRoot();
    const observed = await createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root, environment: {} })
      .observe({ policy: DEFAULT_POLICY, now: 10_000 });
    expect(observed.eventLedger).toMatchObject({ passed: true, events: 3 });
    expect(fake.payloadPages().map(page => page.length)).toEqual([1, 1, 1]);
    expect(fake.payloadPages().flat()).toEqual(ledger.map(row => row.id));
  });

  it("detects payload tampering on the final page without dropping any earlier proof rows", async () => {
    const ledger = buildLedger(129, 1_000, { linked: true }), fake = fakeGovernanceStorage(ledger), root = await tempRoot();
    fake.setPayloadRead(rows => rows.map(row => row.id === ledger.at(-1)!.id ? { ...row, payload_json: { tampered: true } } : row));
    const observed = await createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root, environment: {} })
      .observe({ policy: DEFAULT_POLICY, now: 10_000 });
    expect(observed.eventLedger).toMatchObject({ passed: false, events: 129, reason: "event_hash_chain_invalid" });
    const chain = (observed.eventLedger.evidence as Record<string, unknown>).eventChain as { events: number; brokenHashes: Array<{ eventId: string }> };
    expect(chain.events).toBe(129);
    expect(chain.brokenHashes.map(row => row.eventId)).toEqual([ledger.at(-1)!.id]);
    expect(fake.payloadPages().flat()).toEqual(ledger.map(row => row.id));
  });

  it.each(["missing", "changed-header"])("fails closed when a payload page is%s after header selection", async damage => {
    const fake = fakeGovernanceStorage(buildLedger(65)), root = await tempRoot();
    fake.setPayloadRead(rows => damage === "missing" ? rows.slice(1) : rows.map((row, i) => i ? row : { ...row, type_id: "changed" }));
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root, environment: {} });
    expect((await probe.observe({ policy: DEFAULT_POLICY, now: 10_000 })).eventLedger).toMatchObject({ available: false, passed: false, reason: "event_ledger_probe_failed" });
    fake.setPayloadRead(rows => rows);
    expect((await probe.observe({ policy: DEFAULT_POLICY, now: 10_001 })).eventLedger).toMatchObject({ passed: true, events: 65 });
    expect(fake.windowScanCount()).toBe(2);
  });

  it("single-flights simultaneous cold observations through the same complete verification", async () => {
    const fake = fakeGovernanceStorage(buildLedger(130)), root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root, environment: {} });
    const observations = await Promise.all([1, 2, 3].map(now => probe.observe({ policy: DEFAULT_POLICY, now })));
    expect(observations.every(row => row.eventLedger.passed && row.eventLedger.events === 130)).toBe(true);
    expect(fake.windowScanCount()).toBe(1);
    expect(fake.payloadPages()).toHaveLength(3);
  });

  it("fails closed when an exact outside-window parent header is genuinely missing", async () => {
    const ledger = buildLedger(4, 1_000, { linked: true }), fake = fakeGovernanceStorage(ledger), root = await tempRoot();
    ledger[2]!.parents = ["event.missing.parent"];
    const observed = await createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals: createApprovalSession(), workspaceRoot: root,
      environment: { SCCE_GOVERNANCE_LEDGER_WINDOW_EVENTS: "2" } }).observe({ policy: DEFAULT_POLICY, now: 10_000 });
    expect(observed.eventLedger).toMatchObject({ passed: false, events: 4, reason: "event_hash_chain_invalid" });
    expect(((observed.eventLedger.evidence as Record<string, unknown>).eventChain as { missingParents: unknown[] }).missingParents).toHaveLength(1);
  });
  it("establishes its checkpoint from a bounded window, never a whole-ledger scan, then verifies just the appended suffix", async () => {
    // The whole-ledger scan is `scce db audit`'s job (plan items 66/68).
    // Doing it here too cost O(all events) INCLUDING payload_json on every
    // process start -- profiled at 16% of a turn -- to move a blind spot
    // from "before the anchor" to "before process start", which the audit
    // command's own comment already identifies as the thing only it can
    // close. The answer path must not read the whole ledger.
    const fake = fakeGovernanceStorage(buildLedger(3));
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    const first = await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(first.eventLedger).toMatchObject({ passed: true, events: 3 });
    expect(fake.fullScanCount()).toBe(0);
    expect(fake.windowScanCount()).toBe(1);

    fake.setRows(buildLedger(5));
    const second = await probe.observe({ policy: DEFAULT_POLICY, now: 2_001 });
    expect(second.eventLedger).toMatchObject({ passed: true, events: 5 });
    expect(fake.fullScanCount()).toBe(0);
    expect(fake.windowScanCount()).toBe(1);

    const third = await probe.observe({ policy: DEFAULT_POLICY, now: 2_002 });
    expect(third.eventLedger).toMatchObject({ passed: true, events: 5 });
    expect(fake.fullScanCount()).toBe(0);
    expect(fake.windowScanCount()).toBe(1);
  });

  it("fails closed and forces a rescan when the checkpoint anchor is mutated", async () => {
    const ledger = buildLedger(4);
    const fake = fakeGovernanceStorage(ledger);
    const approvals = createApprovalSession();
    const root = await tempRoot();
    const probe = createNodePostgresGovernanceProbe({ storage: fake.storage as never, approvals, workspaceRoot: root, environment: {} });

    await probe.observe({ policy: DEFAULT_POLICY, now: 2_000 });
    expect(fake.fullScanCount()).toBe(0);
    expect(fake.windowScanCount()).toBe(1);

    const tampered = ledger.map((row, index) => index === ledger.length - 1 ? { ...row, hash: "tampered_hash" } : row);
    fake.setRows(tampered);
    const observed = await probe.observe({ policy: DEFAULT_POLICY, now: 2_001 });
    expect(observed.eventLedger).toMatchObject({ passed: false, reason: "checkpoint_anchor_mutated_or_missing" });

    // The failed check discarded the checkpoint, so the next call re-establishes
    // one from a fresh bounded window instead of trusting stale state. It still
    // never reads the whole ledger: closing the pre-anchor blind spot is
    // `scce db audit`'s job, and a failure here does not change that.
    fake.setRows(ledger);
    await probe.observe({ policy: DEFAULT_POLICY, now: 2_002 });
    expect(fake.fullScanCount()).toBe(0);
    expect(fake.windowScanCount()).toBe(2);
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
