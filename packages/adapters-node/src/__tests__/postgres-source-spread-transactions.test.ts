// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

type PlannerSetting = "on" | "off";
type Method = "arbitration" | "distribution" | "anchor_search";
interface Statement { sql: string; channel: "pool" | "client"; setting: PlannerSetting; active: boolean }
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

function fixture(method: Method, initial: PlannerSetting, failure?: { phase: "measure" | "restore"; error: Error }) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://offline.invalid/no_database", schema: "spread_tx_test",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const statements: Statement[] = [];
  const measurements: Array<{ active: boolean; setting: PlannerSetting }> = [];
  let active = false;
  let aborted = false;
  let local: PlannerSetting | undefined;
  let connects = 0;
  let releases = 0;
  let failureIndex: number | undefined;
  const setting = () => active ? local ?? initial : initial;
  function fail(error: Error): never {
    aborted = true;
    failureIndex = statements.length - 1;
    throw error;
  }
  async function query(channel: "pool" | "client", sql: string, params: readonly unknown[] = []) {
    statements.push({ sql, channel, setting: setting(), active });
    if (sql === "ROLLBACK") { active = false; aborted = false; local = undefined; return { rows: [] }; }
    if (aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    if (sql === "BEGIN") {
      if (active || channel !== "client") throw new Error("invalid transaction ownership");
      active = true;
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      if (!active) throw new Error("commit without transaction");
      active = false;
      local = undefined;
      return { rows: [] };
    }
    if (sql.includes("current_setting('enable_seqscan')")) return { rows: [{ enabled: setting() }] };
    if (sql === "SET LOCAL enable_seqscan = off") {
      if (!active || channel !== "client") throw new Error("SET LOCAL escaped the transaction client");
      local = "off";
      return { rows: [] };
    }
    if (sql.includes("set_config('enable_seqscan'")) {
      if (!active || channel !== "client" || !sql.includes(", true)")) throw new Error("planner setting escaped transaction-local scope");
      if (failure?.phase === "restore" && measurements.length) fail(failure.error);
      if (params[0] !== "on" && params[0] !== "off") throw new Error("invalid planner setting");
      local = params[0];
      return { rows: [] };
    }
    if (sql.includes("count(DISTINCT source_id)::int AS sources") || method === "anchor_search" && sql.includes("WITH requested_features AS")) {
      measurements.push({ active, setting: setting() });
      if (!active || channel !== "client" || setting() !== "off") throw new Error("spread measurement escaped its bounded planner scope");
      if (failure?.phase === "measure") fail(failure.error);
      return { rows: method === "arbitration" ? [{ run: "alpha beta", sources: 3 }, { run: "quiet", sources: 0 }]
        : method === "distribution" ? [{ unit: "alpha", sources: 3 }, { unit: "quiet", sources: 0 }] : [] };
    }
    if (sql.includes("source_title")) return { rows: sql.includes("ORDER BY md5(unit), unit") ? [{ unit: "alpha" }, { unit: "quiet" }] : [] };
    throw new Error("unexpected offline SQL");
  }
  const client = { query: (sql: string, params?: readonly unknown[]) => query("client", sql, params), release: () => { releases += 1; } };
  (adapter.pool as unknown as { connect: () => Promise<typeof client> }).connect = async () => { connects += 1; return client; };
  (adapter.pool as unknown as { query: typeof client.query }).query = (sql, params) => query("pool", sql, params);
  return { adapter, statements, measurements, setting,
    stats: () => ({ active, aborted, connects, releases }),
    afterFailure: () => failureIndex === undefined ? [] : statements.slice(failureIndex + 1).map(row => row.sql),
    run: async () => method === "arbitration"
      ? [...(await adapter.evidence.sourceIdentityArbitration!({ text: "alpha beta", runs: ["alpha beta", "quiet"] })).spread]
      : method === "distribution" ? adapter.evidence.sourceSpreadDistribution!(2)
        : adapter.evidence.searchEvidence({ features: ["anchor:sym:alpha"], status: "promoted", openingBlockPrior: false, limit: 96 }) };
}

describe.each<Method>(["arbitration", "distribution", "anchor_search"])("real adapter transaction ownership for indexed evidence %s", method => {
  it.each<PlannerSetting>(["on", "off"])("restores the caller's %s setting before committing and releasing", async initial => {
    const state = fixture(method, initial);
    const result = await state.run();
    expect(result).toEqual(method === "arbitration" ? [["alpha beta", 3], ["quiet", 0]] : method === "distribution" ? [3] : []);
    expect(state.measurements).toEqual([{ active: true, setting: "off" }]);
    const commit = state.statements.find(row => row.sql === "COMMIT");
    expect(commit?.setting).toBe(initial);
    expect(state.stats()).toEqual({ active: false, aborted: false, connects: 1, releases: 1 });
    expect(state.setting()).toBe(initial);
  });

  it.each<PlannerSetting>(["on", "off"])("rolls back the original SQL failure without attempting a masking reset, initial=%s", async initial => {
    const original = Object.assign(new Error("original measurement failure"), { code: "XX000" });
    const state = fixture(method, initial, { phase: "measure", error: original });
    await expect(state.run()).rejects.toBe(original);
    expect(state.afterFailure()).toEqual(["ROLLBACK"]);
    expect(state.stats()).toEqual({ active: false, aborted: false, connects: 1, releases: 1 });
    expect(state.setting()).toBe(initial);
  });

  it.each<PlannerSetting>(["on", "off"])("does not return measured rows when restoration fails, initial=%s", async initial => {
    const original = Object.assign(new Error("planner restoration failed"), { code: "XX000" });
    const state = fixture(method, initial, { phase: "restore", error: original });
    await expect(state.run()).rejects.toBe(original);
    expect(state.measurements).toEqual([{ active: true, setting: "off" }]);
    expect(state.afterFailure()).toEqual(["ROLLBACK"]);
    expect(state.stats()).toEqual({ active: false, aborted: false, connects: 1, releases: 1 });
    expect(state.setting()).toBe(initial);
  });

  it.each<PlannerSetting>(["on", "off"])("restores nested caller setting %s before the owning transaction commits", async callerSetting => {
    const sessionSetting = callerSetting === "on" ? "off" : "on";
    const state = fixture(method, sessionSetting);
    await state.adapter.transaction(async () => {
      await state.adapter.query("SELECT set_config('enable_seqscan', $1, true)", [callerSetting]);
      await state.run();
      const [probe] = await state.adapter.query<{ enabled: string }>("SELECT current_setting('enable_seqscan') AS enabled");
      expect(probe?.enabled).toBe(callerSetting);
      expect(state.stats()).toEqual({ active: true, aborted: false, connects: 1, releases: 0 });
      expect(state.statements.filter(row => row.sql === "COMMIT")).toHaveLength(0);
    });
    expect(state.statements.filter(row => row.sql === "BEGIN")).toHaveLength(1);
    expect(state.statements.filter(row => row.sql === "COMMIT")).toHaveLength(1);
    expect(state.stats()).toEqual({ active: false, aborted: false, connects: 1, releases: 1 });
    expect(state.setting()).toBe(sessionSetting);
  });
});
