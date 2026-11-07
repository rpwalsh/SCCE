// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Measured live 2026-09-16 against the resident corpus: "Who narrates Moby-Dick?" resolved to no source identity
// at all and "What is the name of the ship in Moby-Dick?" resolved to the article titled "Ship", because the
// corpus stores the novel as "moby dick" while the request writes it with a binding dash. The kernel's arbiter
// already folds that mark (corpusIdentityMatchSurface); the adapter that produces its candidate titles did not,
// so the folded match could never be reached.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSourceTitleCache, createPostgresStorageAdapter } from "../postgres.js";

const CORPUS_TITLES = ["moby dick", "ship", "anglo-saxon", "star trek deep space nine"];

/** The adapter with its one database read stubbed: the title list this process would have loaded. */
function arbiterOverTitles(titles: readonly string[]): (text: string) => Promise<readonly string[]> {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture/fixture",
    schema: "fixture",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" }
  });
  Object.defineProperty(adapter, "query", {
    value: async (sql: string) => (/source_title/u.test(sql) ? titles.map(title => ({ title })) : []),
    writable: true
  });
  return async (text: string) => {
    const arbitration = await adapter.evidence.sourceIdentityArbitration!({ text, runs: [] });
    return arbitration.identities;
  };
}

beforeEach(() => clearSourceTitleCache());
afterEach(() => clearSourceTitleCache());

describe("a binding mark is orthography, not identity", () => {
  it("names the corpus's own title when the request writes it with a dash", async () => {
    const identities = await arbiterOverTitles(CORPUS_TITLES)("Who narrates Moby-Dick?");
    expect(identities).toContain("moby dick");
  });

  it("does not leave a generic title as the only thing a dashed request names", async () => {
    const identities = await arbiterOverTitles(CORPUS_TITLES)("What is the name of the ship in Moby-Dick?");
    expect(identities).toContain("moby dick");
    // The generic noun still matches on its own; it just no longer arbitrates the request alone.
    expect(identities).toContain("ship");
  });

  it("still names a title that carries the binding mark itself", async () => {
    const identities = await arbiterOverTitles(CORPUS_TITLES)("What was Anglo-Saxon England?");
    expect(identities).toContain("anglo-saxon");
  });

  it("names nothing when the corpus carries no title the request writes", async () => {
    const identities = await arbiterOverTitles(CORPUS_TITLES)("Who wrote Bleak House?");
    expect(identities).toEqual([]);
  });

  it("measures sampled spreads with bounded index queries and restores the transaction-local planner setting", async () => {
    const adapter = createPostgresStorageAdapter({
      url: "postgres://fixture/fixture",
      schema: "fixture",
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" }
    });
    const reads: Array<{ sql: string; params?: unknown[]; inTransaction: boolean; seqscan: string }> = [];
    let transactionActive = false;
    let enableSeqscan = "on";
    Object.defineProperty(adapter, "query", {
      value: async (sql: string, params?: unknown[]) => {
        reads.push({ sql, params, inTransaction: transactionActive, seqscan: enableSeqscan });
        if (/source_title/u.test(sql)) return [{ unit: "alpha" }, { unit: "beta" }, { unit: "quiet" }];
        if (/current_setting\('enable_seqscan'\)/u.test(sql)) return [{ enabled: enableSeqscan }];
        if (sql === "SET LOCAL enable_seqscan = off") { enableSeqscan = "off"; return []; }
        if (/set_config\('enable_seqscan'/u.test(sql)) { enableSeqscan = String(params?.[0]); return []; }
        return [{ sources: 3 }, { sources: 0 }, { sources: 2 }];
      },
      writable: true
    });
    Object.defineProperty(adapter, "transaction", {
      value: async <T>(operation: () => Promise<T>) => {
        expect(transactionActive).toBe(false);
        transactionActive = true;
        try { return await operation(); }
        finally { transactionActive = false; }
      },
      writable: true
    });

    const measured = await adapter.evidence.sourceSpreadDistribution!(400);

    expect(reads).toHaveLength(5);
    expect(reads.map(read => read.inTransaction)).toEqual([false, true, true, true, true]);
    expect(reads[0]?.params).toEqual([400]);
    expect(reads[1]?.sql).toMatch(/current_setting\('enable_seqscan'\)/u);
    expect(reads[2]?.sql).toBe("SET LOCAL enable_seqscan = off");
    expect(reads[3]?.params).toEqual(["alpha", "sym:alpha", "beta", "sym:beta", "quiet", "sym:quiet"]);
    expect(reads[3]?.seqscan).toBe("off");
    expect(reads[3]?.sql.match(/features @> ARRAY\[\$\d+\]::text\[\] LIMIT 1500/gu)).toHaveLength(3);
    expect(reads[3]?.sql).toContain("count(DISTINCT source_id)::int AS sources");
    expect(reads[4]?.sql).toMatch(/set_config\('enable_seqscan'/u);
    expect(reads[4]?.params).toEqual(["on"]);
    expect(transactionActive).toBe(false);
    expect(enableSeqscan).toBe("on");
    expect(measured).toEqual([3, 2]);
  });
});
