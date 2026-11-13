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
import { anchorFeatureSet } from "@scce/kernel";
import { corpusIdentitySurface } from "../../../kernel/src/corpus-identity.js";

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
  it.each(["Record_4d61a2", "Στοιχείο_αριθμός", "Record‿4d61a2"])("measures the indexed source units of %s and refuses an unknown compound", async subject => {
    const adapter = createPostgresStorageAdapter({ url: "postgres://fixture/fixture", schema: "fixture",
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" } });
    const source = `${subject} σημείο 42.`;
    const indexed = new Set(anchorFeatureSet(source));
    const run = corpusIdentitySurface(subject);
    const unknown = `${run} unobserved`;
    let measured = false;
    Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
    Object.defineProperty(adapter, "query", { value: async (sql: string, params?: unknown[]) => {
      if (/source_title/u.test(sql)) return [];
      if (/current_setting/u.test(sql)) return [{ enabled: "off" }];
      if (sql === "SET LOCAL enable_seqscan = off" || /set_config/u.test(sql)) return [];
      expect(sql).toContain("evidence_spans");
      expect(sql).toContain("evidence.features @> candidate.features");
      expect(sql).toContain("WITH matching_evidence AS MATERIALIZED");
      expect(sql).not.toContain("unnest(evidence.features)");
      expect(sql).toContain("cardinality(candidate.features)>0");
      expect(sql).toContain("evidence.status='promoted'");
      expect(sql).toContain("evidence.information_label");
      expect(params?.slice(1)).toEqual(adapter.informationAccessPredicate("evidence", 2).params);
      const requests = JSON.parse(String(params?.[0])) as Array<{ run: string; features: string[] }>;
      expect(requests[0]?.features).toEqual(anchorFeatureSet(subject).filter(feature => feature.startsWith("anchor:sym:")));
      expect(requests[0]?.features.length).toBeGreaterThan(0);
      expect(requests[0]?.features.every(feature => indexed.has(feature))).toBe(true);
      expect(sql).toContain("FROM matching_evidence evidence");
      expect(sql).toContain("count(DISTINCT evidence.source_id)");
      measured = true;
      return requests.map(request => ({ run: request.run, sources: request.features.every(feature => indexed.has(feature)) ? 1 : 0 }));
    }});
    const result = await adapter.evidence.sourceIdentityArbitration!({ text: subject, runs: [run, unknown] });
    expect(measured).toBe(true);
    expect([...result.spread]).toEqual([[run, 1], [unknown, 0]]);
  });

  it.each(["on", "off"])("measures request spreads through the same bounded index policy and preserves caller setting %s", async initialSetting => {
    const adapter = createPostgresStorageAdapter({
      url: "postgres://fixture/fixture",
      schema: "fixture",
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" }
    });
    let inTransaction = false;
    let seqscan = initialSetting;
    let measured = false;
    Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => {
      expect(inTransaction).toBe(false);
      inTransaction = true;
      try { return await operation(); }
      finally { inTransaction = false; }
    }});
    Object.defineProperty(adapter, "query", { value: async (sql: string, params?: unknown[]) => {
      if (/source_title/u.test(sql)) return [];
      expect(inTransaction).toBe(true);
      if (/current_setting\('enable_seqscan'\)/u.test(sql)) return [{ enabled: seqscan }];
      if (sql === "SET LOCAL enable_seqscan = off") { seqscan = "off"; return []; }
      if (/set_config\('enable_seqscan'/u.test(sql)) { seqscan = String(params?.[0]); return []; }
      expect(seqscan).toBe("off");
      expect(JSON.parse(String(params?.[0]))).toEqual([
        { run: "alpha beta", features: ["anchor:sym:alpha", "anchor:sym:beta"] },
        { run: "quiet", features: ["anchor:sym:quiet"] }
      ]);
      expect(sql).toContain("evidence_spans");
      expect(sql).toContain("evidence.features @> candidate.features");
      expect(sql).toContain("WITH matching_evidence AS MATERIALIZED");
      expect(sql).not.toContain("unnest(evidence.features)");
      expect(sql).toContain("evidence.status='promoted'");
      expect(sql).toContain("evidence.information_label");
      expect(params?.slice(1)).toEqual(adapter.informationAccessPredicate("evidence", 2).params);
      measured = true;
      return [{ run: "alpha beta", sources: 3 }, { run: "quiet", sources: 0 }];
    }});
    const result = await adapter.evidence.sourceIdentityArbitration!({ text: "alpha beta", runs: ["alpha beta", "quiet"] });
    expect(measured).toBe(true);
    expect([...result.spread]).toEqual([["alpha beta", 3], ["quiet", 0]]);
    expect(inTransaction).toBe(false);
    expect(seqscan).toBe(initialSetting);
  });

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
    expect(reads[0]?.params?.[0]).toBe(400);
    expect(reads[0]?.sql).toContain("evidence.status='promoted'");
    expect(reads[0]?.sql).toContain("evidence.information_label");
    expect(reads[1]?.sql).toMatch(/current_setting\('enable_seqscan'\)/u);
    expect(reads[2]?.sql).toBe("SET LOCAL enable_seqscan = off");
    expect(JSON.parse(String(reads[3]?.params?.[0]))).toEqual([
      { run: "alpha", features: ["anchor:sym:alpha"] },
      { run: "beta", features: ["anchor:sym:beta"] },
      { run: "quiet", features: ["anchor:sym:quiet"] }
    ]);
    expect(reads[3]?.seqscan).toBe("off");
    expect(reads[3]?.sql).toContain("evidence.features @> candidate.features");
    expect(reads[3]?.sql).toContain("WITH matching_evidence AS MATERIALIZED");
    expect(reads[3]?.sql).not.toContain("unnest(evidence.features)");
    expect(reads[3]?.sql).not.toContain("evidence_anchor_index");
    expect(reads[3]?.sql.match(/evidence.status='promoted'/gu)).toHaveLength(1);
    expect(reads[3]?.sql).toContain("evidence.information_label");
    expect(reads[3]?.sql).toContain("count(DISTINCT evidence.source_id)");
    expect(reads[3]?.sql).toContain("1500)::int AS sources");
    expect(reads[4]?.sql).toMatch(/set_config\('enable_seqscan'/u);
    expect(reads[4]?.params).toEqual(["on"]);
    expect(transactionActive).toBe(false);
    expect(enableSeqscan).toBe("on");
    expect(measured).toEqual([3, 2]);
  });

  it("uses one fixed-size canonical-feature query and deterministic vocabulary selection for repeated large samples", async () => {
    const adapter = createPostgresStorageAdapter({ url: "postgres://fixture/fixture", schema: "fixture",
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" } });
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    const vocabularies: string[] = [];
    Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
    Object.defineProperty(adapter, "query", { value: async (sql: string, params: unknown[] = []) => {
      if (/source_title/u.test(sql)) {
        expect(sql).toContain("ORDER BY md5(unit), unit");
        expect(sql).not.toContain("random()");
        vocabularies.push(sql);
        return Array.from({ length: Number(params[0]) }, (_, index) => ({ unit: `symbol${index}` }));
      }
      if (/current_setting/u.test(sql)) return [{ enabled: "off" }];
      if (sql === "SET LOCAL enable_seqscan = off" || /set_config/u.test(sql)) return [];
      reads.push({ sql, params });
      return (JSON.parse(String(params[0])) as Array<{ run: string }>).map(({ run }) => ({ run, sources: 1 }));
    }});
    expect(await adapter.evidence.sourceSpreadDistribution!(1)).toEqual([1]);
    const first = await adapter.evidence.sourceSpreadDistribution!(400);
    expect(first).toHaveLength(400);
    expect(await adapter.evidence.sourceSpreadDistribution!(400)).toEqual(first);
    expect(new Set(vocabularies).size).toBe(1);
    expect(reads[1]).toEqual(reads[2]);
    expect(reads[0]?.sql).toBe(reads[1]?.sql);
    expect(reads[1]?.sql).not.toContain("UNION ALL");
    expect(reads[1]?.sql).toContain("evidence.features @> candidate.features");
    expect(reads[1]?.sql).toContain("WITH matching_evidence AS MATERIALIZED");
    expect(reads[1]?.sql).not.toContain("unnest(evidence.features)");
    expect(reads[1]?.sql).toContain("1500)::int AS sources");
  });
});
